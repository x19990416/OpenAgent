import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRuntimeAdapter, PlanExecutionContext, PromptSubmissionInput, RuntimeAttachment, RuntimeLogEntry, RuntimeMessage, RuntimeServiceOptions, RuntimeSnapshot, RuntimeThread, RuntimeTool } from './runtime-types.js';
import { RuntimeEventBus } from './event-bus.js';
import { RunStateStore } from './run-state.js';
import { SessionStore } from './session-store.js';
import { TranscriptStore } from './transcript-store.js';
import { ToolExecutor } from './tool-executor.js';
import { buildRunContextLogSnapshot, buildRunInput } from './context-builder.js';
import { createDefaultToolRegistry } from './tool-registry.js';
import { LocalDemoAgentLoop } from './agent-loop.js'; // legacy explicit fallback only
import { PiRuntimeAdapter } from './pi/pi-runtime-adapter.js';
import { PromptValidationError, errorToMessage } from './errors.js';
import { summarizeRunResult } from './agent-loop-result.js';
import { appendLlmResponseLog, appendRuntimeInfoLog, formatRuntimeInfoLogSummary } from './runtime-info-logger.js';
import { SoulManager, extractOpenAgentMetadata } from './memory/soul-manager.js';
import { SubagentService } from './subagents/subagent-service.js';
import { createShellAgentTool } from './subagents/shell-agent-tool.js';
import { createKnowledgeAgentTool } from './subagents/knowledge-agent-tool.js';
import { createPiCodingAgentTool } from './subagents/pi-coding-agent-tool.js';
import { ApprovalService, type RuntimeApprovalRequest } from './approval-service.js';
import { KnowledgeService } from './knowledge/knowledge-service.js';
import { createKnowledgeTools } from './knowledge/knowledge-tools.js';
import { KnowledgeContextRouter } from './knowledge/knowledge-context-router.js';
import { getOpenAgentHome } from './knowledge/knowledge-paths.js';
import { getOpenAgentAppSettings } from './settings/openagent-settings.js';
import { PlanService } from './planning/plan-service.js';
import { PlanExecutor } from './planning/plan-executor.js';
import type { AgentPlan, PlanUpdatedPayload } from './planning/plan-types.js';
import { resolvePluginContext } from './plugin-resolver.js';
import { SkillService, type SkillCatalogItem } from './skills/skill-service.js';

const MAX_RUN_CONTEXT_MESSAGES = 32;
const AUTO_COMPACT_TRANSCRIPT_MESSAGES = 96;
const AUTO_COMPACT_MIN_INTERVAL_MS = 30 * 60 * 1000;
const MAX_PROGRESS_CONTINUATION_ATTEMPTS = 3;

export class RuntimeService {
  private activeThreadId = 'thread-welcome';
  private readonly createdAt = new Date().toISOString();
  private readonly eventBus: RuntimeEventBus;
  private readonly approvalService = new ApprovalService();
  private readonly runState = new RunStateStore();
  private readonly sessionStore: SessionStore;
  private readonly soulManager: SoulManager;
  private readonly knowledgeService: KnowledgeService;
  private readonly knowledgeContextRouter: KnowledgeContextRouter;
  private readonly planService: PlanService;
  private readonly skillService: SkillService;
  private readonly toolRegistry: ReturnType<typeof createDefaultToolRegistry>;
  private readonly subagents: SubagentService;
  private readonly messages: RuntimeMessage[] = [];
  private readonly threads = new Map<string, RuntimeThread>();
  private readonly lastCompactionByThread = new Map<string, number>();

  constructor(
    private options: RuntimeServiceOptions,
    private readonly adapter: AgentRuntimeAdapter = createDefaultAdapter()
  ) {
    this.eventBus = new RuntimeEventBus(options.emitUiEvent);
    this.sessionStore = new SessionStore(options.agentId);
    this.knowledgeService = new KnowledgeService(options.agentId);
    this.knowledgeContextRouter = new KnowledgeContextRouter();
    this.planService = new PlanService(options.agentId);
    this.skillService = new SkillService({ agentId: options.agentId, workspaceRoot: options.workspaceRoot });
    this.soulManager = new SoulManager({
      agentId: options.agentId,
      workspaceRoot: options.workspaceRoot,
      providerId: options.providerId,
      model: options.model,
      createdAt: this.createdAt
    });
    this.toolRegistry = createDefaultToolRegistry(options.workspaceRoot);
    this.subagents = new SubagentService(this.knowledgeService);
    for (const tool of createKnowledgeTools(this.knowledgeService)) {
      this.toolRegistry.register(tool);
    }
    for (const tool of this.skillService.createTools()) {
      this.toolRegistry.register(tool);
    }
    this.toolRegistry.register(createShellAgentTool(this.subagents, options.workspaceRoot));
    this.toolRegistry.register(createKnowledgeAgentTool(this.subagents, options.workspaceRoot));
    this.toolRegistry.register(createPiCodingAgentTool(this.subagents));

    const restoredThreads = this.sessionStore.listThreads({
      workspaceRoot: options.workspaceRoot,
      workspaceName: options.workspaceName,
      branch: options.branch
    });

    if (restoredThreads.length > 0) {
      for (const thread of restoredThreads) {
        this.threads.set(thread.threadId, thread);
      }
      this.activeThreadId = restoredThreads[0].threadId;
      this.loadActiveThreadMessages();
    } else {
      const welcomeThread = this.createThreadRecord({
        threadId: this.activeThreadId,
        title: '欢迎使用 OpenAgent',
        createdAt: this.createdAt
      });
      this.threads.set(welcomeThread.threadId, welcomeThread);
      this.sessionStore.upsertThread(welcomeThread);
      this.messages.push({
        id: 'assistant-welcome',
        role: 'assistant',
        content: '你好，我是 OpenAgent。你可以在这里和桌面 Agent 对话，让我读取项目上下文、调用受控工具、管理插件与技能，并把运行过程记录到会话里。首次使用请先到 **[设置 → 模型](#/settings/models)** 里配置模型和认证信息，配置完成后直接输入你的任务即可开始。',
        createdAt: this.createdAt
      });
    }
  }

  private syncPluginSkills() {
    this.skillService.setPluginSkills(this.options.pluginContextResolver?.getSkillPackages?.() ?? []);
  }

  getAgentBootstrapSnapshot() {
    return this.soulManager.getBootstrapSnapshot();
  }

  listSkills() {
    this.syncPluginSkills();
    return this.skillService.listSkills();
  }

  refreshSkills() {
    this.syncPluginSkills();
    return this.skillService.refreshSkills();
  }

  getSkill(nameOrId: string) {
    this.syncPluginSkills();
    return this.skillService.getSkill(nameOrId);
  }

  setSkillEnabled(input: { skillName?: string; skillId?: string; enabled?: boolean }) {
    this.syncPluginSkills();
    return this.skillService.setEnabled(input.skillName || input.skillId || '', Boolean(input.enabled));
  }

  testSkill(input: { skillName?: string; skillId?: string }) {
    this.syncPluginSkills();
    return this.skillService.testSkill(input.skillName || input.skillId || '');
  }

  installLocalSkill(input: { sourceDir?: string; target?: 'user' | 'agent' | 'workspace'; overwrite?: boolean }) {
    this.syncPluginSkills();
    return this.skillService.installLocal({
      sourceDir: String(input.sourceDir || ''),
      target: input.target,
      overwrite: Boolean(input.overwrite)
    });
  }

  private resolveSelectedSkill(selectedSkillId?: string | null) {
    const value = String(selectedSkillId || '').trim();
    if (!value) return null;
    return this.skillService.getSkill(value);
  }

  listSoulProposals(status?: 'pending_approval' | 'approved' | 'rejected' | 'applied') {
    return this.soulManager.listProposals(status);
  }

  createSoulProposal(input: { title?: string; reason?: string; targetSection?: string; proposedText?: string; riskLevel?: 'low' | 'medium' | 'high' }) {
    if (!input.proposedText?.trim()) {
      return { ok: false, error: 'proposedText is required' };
    }

    const proposal = this.soulManager.createProposal({
      title: input.title || '手动创建 SOUL.md 变更提案',
      reason: input.reason || '用户手动创建了 SOUL.md 变更提案。',
      targetSection: input.targetSection,
      proposedText: input.proposedText,
      riskLevel: input.riskLevel || 'high',
      source: { kind: 'manual' }
    });
    this.eventBus.emit('memory.updated', { snapshot: this.getAgentBootstrapSnapshot(), soulProposal: proposal });
    return { ok: true, proposal };
  }

  approveSoulProposal(proposalId: string) {
    const result = this.soulManager.approveProposal(proposalId);
    if (result.ok) {
      this.eventBus.emit('memory.updated', { snapshot: result.snapshot, soulProposal: result.proposal });
    }
    return result;
  }

  rejectSoulProposal(proposalId: string) {
    const result = this.soulManager.rejectProposal(proposalId);
    if (result.ok) {
      this.eventBus.emit('memory.updated', { snapshot: this.getAgentBootstrapSnapshot(), soulProposal: result.proposal });
    }
    return result;
  }

  resolveApproval(input: { approvalId?: string; decision?: 'approved' | 'rejected'; scope?: 'once' | 'session' | 'always' }) {
    const approvalId = input.approvalId || '';
    const decision = input.decision;
    const scope = input.scope;
    if (!approvalId) {
      return { ok: false, error: 'approvalId is required' };
    }

    if (approvalId.startsWith('soul-proposal-')) {
      const result = decision === 'approved' ? this.approveSoulProposal(approvalId) : this.rejectSoulProposal(approvalId);
      if (result.ok) {
        this.eventBus.emit('approval.resolved', {
          approvalId,
          decision: decision === 'approved' ? 'approved' : 'rejected',
          summary: decision === 'approved' ? 'SOUL.md 变更已批准并应用。' : 'SOUL.md 变更已拒绝。'
        });
      }
      return result;
    }

    const result = this.approvalService.resolveApproval({ approvalId, decision, scope });
    if (result.ok) {
      const isPlanApproval = result.request.actionType === 'agent-plan.execute';
      if (result.request.runId) {
        this.runState.update(result.request.runId, {
          status: result.decision === 'approved' ? 'running' : 'failed',
          summary: result.decision === 'approved'
            ? '审批已通过，继续执行。'
            : isPlanApproval
              ? '用户拒绝了 Agent Plan。'
              : '用户拒绝了外部路径访问。'
        });
      }
      this.eventBus.emit('approval.resolved', {
        approvalId,
        decision: result.decision,
        scope: result.scope,
        summary: isPlanApproval
          ? result.decision === 'approved'
            ? 'Agent Plan 已批准，agent 将开始执行。'
            : 'Agent Plan 已拒绝。'
          : result.decision === 'approved'
            ? result.scope === 'always'
              ? '已设为始终允许，同类操作后续将自动通过。'
              : result.scope === 'session'
                ? '已设为本会话允许，同类操作本会话内将自动通过。'
                : result.request.actionType?.startsWith('skill.script')
                  ? 'Skill 脚本执行已批准，本次调用将继续执行。'
                  : '外部路径访问已批准，agent 将继续执行。'
            : '外部路径访问已拒绝。'
      });
    }
    return result;
  }

  private async requestToolApproval(request: Omit<RuntimeApprovalRequest, 'id'> & { id?: string }) {
    const approvalRequest = this.approvalService.createRequest(request);
    if (this.approvalService.isRequestApproved(approvalRequest)) {
      return 'approved' as const;
    }
    if (shouldAutoApproveRuntimeApprovals()) {
      appendRuntimeInfoLog({
        scope: 'approval',
        message: 'runtime approval auto-approved by settings',
        data: {
          approvalId: approvalRequest.id,
          actionType: approvalRequest.actionType,
          risk: approvalRequest.risk,
          targetPath: approvalRequest.targetPath,
          runId: approvalRequest.runId,
          threadId: approvalRequest.threadId
        }
      });
      if (approvalRequest.runId) {
        this.runState.update(approvalRequest.runId, {
          status: 'running',
          summary: `已按设置自动通过审批：${approvalRequest.title}`
        });
      }
      this.eventBus.emit('approval.resolved', {
        approvalId: approvalRequest.id,
        decision: 'approved',
        scope: 'once',
        summary: `已按设置自动通过审批：${approvalRequest.title}`
      });
      return 'approved' as const;
    }
    const { decision } = this.approvalService.requestApproval(approvalRequest);
    this.eventBus.emit('approval.required', approvalRequest);
    return decision;
  }

  autoApprovePendingApprovals(reason = 'settings') {
    const approved = this.approvalService.approveAllPending();
    for (const request of approved) {
      if (request.runId) {
        this.runState.update(request.runId, {
          status: 'running',
          summary: `已按设置自动通过审批：${request.title}`
        });
      }
      appendRuntimeInfoLog({
        scope: 'approval',
        message: 'pending approval auto-approved by settings',
        data: {
          reason,
          approvalId: request.id,
          actionType: request.actionType,
          risk: request.risk,
          targetPath: request.targetPath,
          runId: request.runId,
          threadId: request.threadId
        }
      });
      this.eventBus.emit('approval.resolved', {
        approvalId: request.id,
        decision: 'approved',
        scope: 'once',
        summary: `已按设置自动通过审批：${request.title}`
      });
    }
    return { ok: true, approvedCount: approved.length };
  }

  getSnapshot(): RuntimeSnapshot {
    const latestRun = this.runState.getLatest();
    return {
      activeAgentId: this.options.agentId,
      latestRun: latestRun ? { status: latestRun.status, summary: latestRun.summary } : { status: 'completed', summary: 'OpenAgent runtime 已就绪。' },
      pendingApproval: this.approvalService.getPendingApproval(),
      threads: sortThreadsForDisplay([...this.threads.values()]),
      recentRuns: this.runState.list(),
      messages: this.messages,
      activeThread: { threadId: this.activeThreadId }
    };
  }


  updateModelConfig(input: { providerId: string; providerLabel: string; model: string }) {
    this.options = {
      ...this.options,
      providerId: input.providerId,
      providerLabel: input.providerLabel,
      model: input.model
    };
  }

  getKnowledgeHealth(scope: 'system' = 'system') {
    return this.knowledgeService.health(scope);
  }

  queryKnowledge(input: { query?: string; limit?: number }) {
    return this.knowledgeService.search({
      scope: 'system',
      query: String(input.query || ''),
      limit: input.limit
    });
  }

  ingestKnowledge(input: { title?: string; content?: string; sourceId?: string; tags?: string[] }) {
    return this.knowledgeService.ingest({
      scope: 'system',
      title: String(input.title || ''),
      content: String(input.content || ''),
      sourceId: input.sourceId,
      tags: Array.isArray(input.tags) ? input.tags : undefined
    });
  }

  ingestKnowledgeFiles(files: Array<{ filePath?: string; title?: string; sourceId?: string; tags?: string[] }>) {
    return Promise.all(
      files
        .filter((file) => file.filePath)
        .map((file) =>
          this.knowledgeService.ingestFile({
            scope: 'system',
            filePath: String(file.filePath),
            title: file.title,
            sourceId: file.sourceId,
            tags: Array.isArray(file.tags) ? file.tags : undefined
          })
        )
    );
  }

  lintKnowledge() {
    return this.knowledgeService.lint('system');
  }

  buildKnowledgeGraph() {
    return this.knowledgeService.graph({ scope: 'system', action: 'build' });
  }

  browseKnowledge() {
    return this.knowledgeService.browse('system');
  }

  readKnowledgeArticle(input: { articleId?: string }) {
    return this.knowledgeService.readArticle(String(input.articleId || ''), 'system');
  }

  compileKnowledge(input: { sourceIds?: string[]; limit?: number; tier?: 0 | 1 | 2 | 3 }) {
    return this.knowledgeService.compile({
      scope: 'system',
      sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds : undefined,
      limit: input.limit,
      tier: input.tier
    });
  }

  listRuntimeTasks() {
    return this.runState
      .list()
      .filter((run) => run.status === 'running')
      .map((run) => ({
        runId: run.runId,
        command: `agent-loop ${run.threadId}`,
        cwd: this.options.workspaceRoot,
        startedAt: run.startedAt,
        status: 'running' as const
      }));
  }

  async submitPrompt(payload: PromptSubmissionInput) {
    const prompt = payload.prompt?.trim() || (payload.attachments?.length ? '请分析我发送的附件。' : '');
    if (!prompt) {
      throw new PromptValidationError('Prompt cannot be empty');
    }

    const runId = `run-${randomUUID()}`;
    const now = new Date().toISOString();
    const attachments = this.materializePromptAttachments(payload.attachments ?? [], runId);
    this.syncPluginSkills();
    const selectedSkill = this.resolveSelectedSkill(payload.skillId ?? null);
    const thread = this.getActiveThread();
    const controller = this.runState.start({
      runId,
      threadId: thread.threadId,
      prompt,
      currentAgent: this.options.agentId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      summary: null
    });

    const userMessage: RuntimeMessage = {
      id: `user-${randomUUID()}`,
      role: 'user',
      content: prompt,
      createdAt: now,
      attachments,
      skillId: selectedSkill?.id ?? payload.skillId ?? null,
      skillName: selectedSkill?.name ?? payload.skillName ?? null,
      skillDisplayName: selectedSkill?.displayName ?? payload.skillDisplayName ?? payload.skillName ?? null
    };
    this.messages.push(userMessage);
    this.touchThreadForPrompt(thread, prompt, now);

    const sessionFile = this.sessionStore.getSessionFile(thread.threadId);
    const transcript = new TranscriptStore(sessionFile);
    transcript.appendMessage(userMessage);

    const planningIntent = await this.planService.classifyPlanningIntent(prompt);
    const draftPlan = planningIntent.shouldPlan
      ? await this.planService.createDraftPlan({
          runId,
          threadId: thread.threadId,
          agentId: this.options.agentId,
          prompt,
          intent: planningIntent,
          now
        })
      : null;

    this.eventBus.emit('run.started', { runId, threadId: thread.threadId });
    if (draftPlan) {
      this.emitPlan('plan.created', draftPlan, draftPlan.approvalRequired ? 'Agent Plan Mode 已生成待确认计划。' : 'Agent Plan Mode 已生成自动执行计划。');
      this.emitPlan('plan.updated', draftPlan, draftPlan.approvalRequired ? '等待用户确认计划。' : 'LLM classifier 判定无需人工确认，将自动执行计划。');
    } else {
      this.eventBus.emit('plan.updated', {
        steps: [
          { id: `${runId}-context`, title: '构建运行上下文', status: 'completed' },
          { id: `${runId}-loop`, title: '执行 agent loop', status: 'in_progress' },
          { id: `${runId}-persist`, title: '保存 transcript', status: 'pending' }
        ]
      });
    }

    const runPromise = this.executePromptRun({
      prompt,
      runId,
      thread,
      transcript,
      sessionFile,
      abortSignal: controller.signal,
      attachments,
      selectedSkillId: payload.skillId ?? null,
      plan: draftPlan
    });

    if (payload.awaitCompletion) {
      return runPromise;
    }

    void runPromise;
    return { ok: true, runId, status: 'running' };
  }

  private materializePromptAttachments(attachments: RuntimeAttachment[], runId: string): RuntimeAttachment[] {
    if (attachments.length === 0) return [];
    const attachmentDir = path.join(getOpenAgentHome(), 'agents', this.options.agentId, 'attachments', runId);
    mkdirSync(attachmentDir, { recursive: true });

    return attachments.map((attachment) => {
      const existingPath = typeof attachment.path === 'string' ? attachment.path : '';
      if (path.isAbsolute(existingPath) && existsSync(existingPath)) {
        return attachment;
      }

      const fileName = sanitizeAttachmentName(attachment.name || attachment.path || attachment.id || 'attachment');
      const targetPath = uniquePath(path.join(attachmentDir, fileName));
      const originalDataUrl = typeof attachment.originalDataUrl === 'string' ? attachment.originalDataUrl : undefined;
      const dataUrl = originalDataUrl || (typeof attachment.dataUrl === 'string' ? attachment.dataUrl : undefined) || (typeof attachment.imageDataUrl === 'string' ? attachment.imageDataUrl : undefined);

      try {
        if (dataUrl) {
          writeFileSync(targetPath, decodeDataUrl(dataUrl));
        } else if (typeof attachment.textContent === 'string') {
          writeFileSync(targetPath, attachment.textContent, 'utf8');
        } else {
          return attachment;
        }
        return {
          ...attachment,
          path: targetPath,
          archivedAttachmentPath: targetPath
        };
      } catch (error) {
        appendRuntimeInfoLog({
          scope: 'runtime',
          message: 'Failed to materialize prompt attachment',
          data: { runId, threadId: this.activeThreadId, attachmentName: attachment.name, attachmentPath: attachment.path, error: errorToMessage(error) }
        });
        return attachment;
      }
    });
  }

  private async executePromptRun(input: {
    prompt: string;
    runId: string;
    thread: RuntimeThread;
    transcript: TranscriptStore;
    sessionFile: string;
    abortSignal: AbortSignal;
    attachments: RuntimeAttachment[];
    selectedSkillId?: string | null;
    plan?: AgentPlan | null;
  }) {
    const { prompt, runId, thread, transcript, sessionFile, abortSignal, attachments } = input;
    let activePlan = input.plan ?? null;
    let planExecutor: PlanExecutor | null = null;
    const startedAt = Date.now();
    const loopSteps: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }> = [
      { id: `${runId}-context`, title: '构建运行上下文', status: 'completed' },
      { id: `${runId}-loop-start`, title: '启动 agent loop', status: 'in_progress' },
      { id: `${runId}-persist`, title: '保存 transcript', status: 'pending' }
    ];
    const emitRuntimeProgress = () => this.eventBus.emit('plan.updated', { steps: loopSteps });
    const appendProgressStep = (title: string, status: 'in_progress' | 'completed' = 'in_progress') => {
      if (activePlan) {
        return;
      }
      for (const step of loopSteps) {
        if (step.status === 'in_progress') step.status = 'completed';
      }
      const persistStep = loopSteps.at(-1);
      if (persistStep?.id === `${runId}-persist`) loopSteps.pop();
      loopSteps.push({ id: `${runId}-step-${loopSteps.length}`, title, status });
      loopSteps.push({ id: `${runId}-persist`, title: '保存 transcript', status: 'pending' });
      emitRuntimeProgress();
    };

    try {
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'executePromptRun entered',
        data: { runId, threadId: thread.threadId, elapsedMs: Date.now() - startedAt, hasPlan: Boolean(activePlan) }
      });
      if (activePlan) {
        if (activePlan.approvalRequired) {
          this.runState.update(runId, { status: 'waiting_approval', summary: '等待用户确认 Agent Plan。' });
          this.eventBus.emit('plan.approval.required', this.toPlanPayload(activePlan, '请确认是否按该计划执行。'));
          const decision = await this.requestToolApproval({
            title: '执行 Agent Plan',
            risk: activePlan.riskLevel,
            description: formatPlanApprovalDescription(activePlan),
            actionType: 'agent-plan.execute',
            access: 'execute',
            scope: 'once',
            payloadPreview: formatPlanApprovalDescription(activePlan),
            runId,
            threadId: thread.threadId
          });
          if (decision !== 'approved') {
            activePlan = this.planService.reject(activePlan);
            this.emitPlan('plan.failed', activePlan, '用户取消了 Agent Plan。');
            this.runState.finish(runId, { status: 'cancelled', summary: '用户取消了 Agent Plan。' });
            this.eventBus.emit('run.cancelled', { runId, summary: '用户取消了 Agent Plan。' });
            return { ok: false, runId, status: 'cancelled', error: '用户取消了 Agent Plan。' };
          }
        }
        activePlan = this.planService.approve(activePlan);
        planExecutor = new PlanExecutor(activePlan, this.planService, (nextPlan, reason, changedStepId) => {
          activePlan = nextPlan;
          this.emitPlan('plan.updated', nextPlan, reason, changedStepId);
        });
        this.runState.update(runId, { status: 'running', summary: activePlan.approvalRequired ? 'Agent Plan 已确认，开始执行。' : 'Agent Plan 自动进入执行。' });
        if (activePlan.approvalRequired) {
          this.eventBus.emit('plan.approval.resolved', this.toPlanPayload(activePlan, '用户已确认 Agent Plan。'));
        }
        this.emitPlan('plan.updated', activePlan, activePlan.approvalRequired ? '用户已确认计划，开始执行。' : 'LLM classifier 判定无需人工确认，自动执行计划。');
      }

      appendRuntimeInfoLog({
        scope: 'context',
        message: 'resolvePluginContext start',
        data: { runId, threadId: thread.threadId, elapsedMs: Date.now() - startedAt, promptLength: prompt.length }
      });
      const pluginContext = await resolvePluginContext({
        prompt,
        resolver: this.options.pluginContextResolver
      });
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'resolvePluginContext completed',
        data: {
          runId,
          threadId: thread.threadId,
          elapsedMs: Date.now() - startedAt,
          toolCount: pluginContext.tools.length,
          skillSummaryCount: pluginContext.skills ? pluginContext.skills.split('\n').filter(Boolean).length : 0
        }
      });
      this.syncPluginSkills();
      const explicitSelectedSkill = this.resolveSelectedSkill(input.selectedSkillId ?? null);
      const inferredSelectedSkill = explicitSelectedSkill ? null : this.skillService.inferSelectedSkill({ prompt, attachments });
      const selectedSkill = explicitSelectedSkill ?? inferredSelectedSkill;
      if (inferredSelectedSkill) {
        appendRuntimeInfoLog({
          scope: 'context',
          message: 'implicit selected skill inferred',
          data: {
            runId,
            threadId: thread.threadId,
            skillName: inferredSelectedSkill.name,
            skillId: inferredSelectedSkill.id,
            reason: 'skill authoring intent'
          }
        });
      }
      const skillContext = this.skillService.resolveForPrompt({
        prompt,
        attachments,
        selectedSkillId: selectedSkill?.id ?? input.selectedSkillId ?? null
      });
      this.eventBus.emit('skill.resolved', {
        runId,
        threadId: thread.threadId,
        skills: skillContext.summaries.map((skill) => ({ name: skill.name, source: skill.source, risk: skill.risk, description: skill.description }))
      });

      const runMessages = transcript.readMessages({ limit: MAX_RUN_CONTEXT_MESSAGES });
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'prepare runInput start',
        data: {
          runId,
          threadId: thread.threadId,
          elapsedMs: Date.now() - startedAt,
          toolCount: [...this.toolRegistry.list(), ...pluginContext.tools].length,
          transcriptMessageCount: runMessages.length
        }
      });
      const availableTools = [...this.toolRegistry.list(), ...pluginContext.tools];
      const runTools = filterToolsForSelectedSkill(availableTools, selectedSkill);
      const promptContext = resolvePromptContextMode({
        prompt,
        hasSelectedSkill: Boolean(selectedSkill),
        hasActivePlan: Boolean(activePlan),
        attachmentsCount: attachments.length
      });
      const runInput = buildRunInput({
        runId,
        threadId: thread.threadId,
        agentId: thread.agentId || this.options.agentId,
        workspaceRoot: this.options.workspaceRoot,
        sessionFile,
        prompt,
        providerId: this.options.providerId,
        model: this.options.model,
        messages: runMessages,
        attachments,
        tools: runTools,
        abortSignal,
        promptContext,
        onLog: (entry) => {
          appendRuntimeInfoLog(entry);
          this.eventBus.emit('terminal.delta', {
            runId,
            text: formatRuntimeInfoLogSummary(entry)
          });
          const progressTitle = summarizeProgressLogEntry(entry);
          if (progressTitle) appendProgressStep(progressTitle);
        },
        emitUiEvent: (type, payload) => {
          if (type === 'approval.required') {
            this.runState.update(runId, { status: 'waiting_approval', summary: '等待用户审批。' });
          }
          if (type === 'approval.resolved') {
            const decision = (payload as { decision?: string } | undefined)?.decision;
            this.runState.update(runId, {
              status: decision === 'rejected' ? 'failed' : 'running',
              summary: decision === 'rejected' ? '用户拒绝了审批。' : '审批已通过，继续执行。'
            });
          }
          this.eventBus.emit(type, payload);
        },
        requestApproval: (request) => {
          this.runState.update(runId, { status: 'waiting_approval', summary: '等待用户审批外部路径访问。' });
          return this.requestToolApproval({
            ...request,
            runId,
            threadId: thread.threadId
          });
        },
        getPlanContext: () => toPlanExecutionContext(activePlan, selectedSkill) ?? toSelectedSkillExecutionContext(selectedSkill)
      });
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'prepare runInput completed',
        data: {
          runId,
          threadId: thread.threadId,
          elapsedMs: Date.now() - startedAt,
          messageCount: runMessages.length,
          toolCount: runInput.tools.length,
          promptContext,
          selectedSkill: selectedSkill ? {
            name: selectedSkill.name,
            allowedTools: selectedSkill.allowedTools,
            originalToolCount: availableTools.length,
            exposedToolNames: runInput.tools.map((tool) => tool.name)
          } : undefined
        }
      });
      const preExecutedToolContext = await this.maybeRunSkillCreatorScaffoldFastPath({
        runInput,
        selectedSkill,
        activePlan,
        prompt
      });
      const bootstrap = this.soulManager.getBootstrapSnapshot();
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context lookup start',
        data: { runId, threadId: thread.threadId, elapsedMs: Date.now() - startedAt, promptLength: prompt.length }
      });
      const knowledgeContext = await this.buildKnowledgeContext(prompt, abortSignal);
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context lookup completed',
        data: {
          runId,
          threadId: thread.threadId,
          elapsedMs: Date.now() - startedAt,
          knowledgeContextLength: knowledgeContext.length
        }
      });
      planExecutor?.completeAndStart(
        'plan-step-inspect',
        '已完成运行上下文、长期记忆和知识库上下文检查。',
        'plan-step-design',
        '正在固化本轮执行约束与计划步骤。'
      );
      const memoryContext = selectRelevantMemoryContext(bootstrap.memory, prompt);
      const transcriptStats = transcript.getStats();
      runInput.onLog?.({
        scope: 'context',
        message: 'transcript context pruned for run',
        data: {
          sessionFile,
          totalMessages: transcriptStats.messageCount,
          injectedMessages: runInput.messages.length,
          maxInjectedMessages: MAX_RUN_CONTEXT_MESSAGES,
          promptContext,
          firstMessageAt: transcriptStats.firstMessageAt,
          lastMessageAt: transcriptStats.lastMessageAt
        }
      });

      runInput.systemPrompt = [
        runInput.systemPrompt,
        '',
        'Agent long-term identity from SOUL.md:',
        bootstrap.soul,
        '',
        'User long-term preferences from USER.md:',
        bootstrap.user,
        '',
        'Relevant long-term memory from MEMORY.md (task-filtered, not full file):',
        memoryContext || '(no relevant long-term memory found)',
        '',
        'Relevant Knowledge Base context:',
        knowledgeContext || '(no relevant knowledge context found)',
        '',
        'Relevant skill context:',
        skillContext.promptBlock,
        '',
        ...(preExecutedToolContext
          ? [
              'Pre-executed Tool Invocation:',
              preExecutedToolContext,
              ''
            ]
          : []),
        ...(selectedSkill
          ? [
              'Selected skill routing rule:',
              formatSelectedSkillRoutingRule(selectedSkill),
              ''
            ]
          : []),
        'Relevant plugin context:',
        pluginContext.skills || '(no relevant plugin context found)',
        '',
        ...(activePlan
          ? [
              'Active OpenAgent Plan Mode:',
              formatPlanForPrompt(activePlan),
              '',
              'Plan execution rule:',
              '- Follow the active plan goal and steps unless new evidence makes it unsafe or incorrect.',
              '- Use OpenAgent tools normally when needed; OpenAgent runtime owns approvals, logs, and plan status.',
              ...(selectedSkill
                ? [
                    formatSelectedSkillPlanRule(selectedSkill),
                    ...(selectedSkill.name === 'skill-creator'
                      ? [
                          '- Do not call pi_coding_agent for skill-creator runs; use skill_load, skill_resource, skill_script, and necessary write_file calls so skill authoring stays on the governed scaffold path.'
                        ]
                      : [
                          '- Do not call pi_coding_agent merely to reimplement a declared skill script that can satisfy the step.',
                          '- For normal selected-skill runs, prefer skill_script first; pi_coding_agent may be used for real blockers such as missing dependencies, runtime/environment diagnosis, script failures, or requested skill/package fixes.'
                        ]),
                    '- All shell execution, dependency installation, and file writes still must go through OpenAgent policy and approval.'
                  ]
                : [
                    '- For execute steps that require coding, running scripts, generating files, or complex artifacts, you must call the appropriate OpenAgent tool such as pi_coding_agent instead of merely saying you will do it.'
                  ]),
              '- Do not end the run with future-tense progress text like “请稍等/我将/正在为你” when the next action requires a tool call; call the tool in the same turn.',
              '- If the plan is insufficient, explain the needed revision in the final answer rather than silently ignoring it.',
              ''
            ]
          : []),
        'Identity rule:',
        '- The `- Name:` field under `## 1. Identity` in SOUL.md is the source of truth for who you are.',
        '- When asked “你是谁”, “你叫啥”, or “who are you”, answer with the Name and Role from SOUL.md if present.',
        '- Do not replace the SOUL.md name with the model name or project name unless SOUL.md explicitly says so.',
        '',
        'OpenAgent structured metadata rule:',
        '- After your normal user-facing answer, append exactly one hidden HTML comment metadata block.',
        '- The block must be valid JSON and must not be explained to the user.',
        '- Format:',
        '<!-- openagent:metadata',
        '{"soulChangeRequests":[],"userUpdates":[],"memoryUpdates":[],"knowledgeUpdates":[]}',
        '-->',
        '- If the user asks for a durable Agent identity, role, behavior, safety, tool, memory, or project-specific rule change, add one object to soulChangeRequests.',
        '- Do not add soulChangeRequests for one-off or session-only instructions.',
        '- Every SOUL request must set requiresApproval to true.',
        '- Object schema: shouldUpdateSoul, updateKind, title, reason, proposedText, targetSection, confidence, requiresApproval, evidence, ruleId, identityName, identityRole.',
        '- confidence must be the string "low", "medium", or "high"; do not use numbers.',
        '- targetSection should be one of the exact SOUL headings, such as "## 1. Identity" or "## 7. Managed Rules".',
        '- updateKind must be one of: identity, working_style, safety_boundary, tool_policy, memory_policy, project_specific_rule.',
        '- ruleId is required for non-identity durable rules; use a stable snake_case id such as "communication_style", "git_safety", or "tool_policy" so OpenAgent can upsert instead of append duplicates.',
        '- For identity updates, do not expect OpenAgent to parse names from prose; set identityName and/or identityRole explicitly.',
        '- proposedText must be the final durable rule text, not a restatement of the user command.',
        '- If the user only says “更新 SOUL.md” or otherwise does not specify the actual durable change, return soulChangeRequests: [] and ask a clarification question in the visible reply.',
        '- Identity questions such as “你叫啥” or “你是谁” are not SOUL changes by themselves; only create a request when the user assigns or changes a durable identity.',
        '- Decide whether USER.md or MEMORY.md should be updated after each run. This does not require user approval, so be conservative.',
        '- Add userUpdates only for stable user preferences or collaboration habits that are likely to apply across future sessions; do not add one-off task instructions.',
        '- userUpdates object schema: shouldUpdateUser, category, statement, reason, confidence, evidence. category must be one of communication, git, development, documentation, project_management, tooling, other. confidence must be medium or high.',
        '- Add memoryUpdates only for reusable project/task knowledge, verified root causes, paths, commands, or design decisions that will help a future similar task; do not store raw chat logs or temporary details.',
        '- memoryUpdates object schema: shouldUpdateMemory, scope, topic, summary, reuse, confidence, evidence. confidence must be medium or high.',
        '- Add knowledgeUpdates only for reusable OpenAgent/system/project knowledge that belongs in the shared Knowledge Base; do not store private user preferences or one-off chat details. OpenAgent will ask the user for approval before applying these updates.',
        '- If the user explicitly asks to save/write/ingest content to wiki or knowledge base, put the full Markdown content in knowledgeUpdates unless you have already called knowledge_ingest successfully.',
        '- For explicit wiki-save requests, do not use memoryUpdates as a substitute for knowledgeUpdates; memoryUpdates are only short reusable reminders, not the knowledge base source of truth.',
        '- Never say “已保存到 wiki/知识库/工作区” unless a write tool succeeded or a knowledgeUpdates request was accepted and applied.',
        '- knowledgeUpdates object schema: shouldUpdateKnowledge, title, content, reason, confidence, tags, evidence. confidence must be medium or high.'
      ].join('\n');

      runInput.onLog?.({
        scope: 'context',
        message: '构建运行上下文完成',
        data: buildRunContextLogSnapshot(runInput)
      });

      planExecutor?.completeAndStartFirstKind(
        'plan-step-design',
        '已将 active plan 注入本轮系统提示词并确认执行约束。',
        'execute',
        '正在进入 agent loop 执行计划主体。'
      );
      appendProgressStep('调用模型并等待 agent loop 返回');
      let result = await this.adapter.run(runInput);
      let continuationBaseMessages = runInput.messages;
      if (shouldRetryPlanToolExecution(activePlan, result)) {
        const retryReason = '计划执行需要实际工具调用，但模型上一轮只返回了说明文本；正在用更严格的工具执行指令重试一次。';
        appendRuntimeInfoLog({
          scope: 'agent-loop',
          message: 'plan tool execution retry requested',
          data: {
            runId,
            threadId: thread.threadId,
            loopCount: result.loopCount,
            toolResultCount: result.toolResultCount,
            assistantMessageId: result.assistantMessage?.id
          }
        });
        if (activePlan) this.emitPlan('plan.updated', activePlan, retryReason);
        this.eventBus.emit('runtime.activity', {
          id: `${runId}-plan-tool-retry`,
          runId,
          threadId: thread.threadId,
          kind: 'tool',
          status: 'running',
          title: 'Retrying planned tool execution',
          detail: retryReason,
          createdAt: new Date().toISOString()
        });
        const planRetryMessages = result.assistantMessage ? [...runInput.messages, result.assistantMessage] : runInput.messages;
        result = await this.adapter.run({
          ...runInput,
          prompt: buildPlanToolExecutionRetryPrompt(prompt, result.assistantMessage?.content || '', activePlan),
          messages: planRetryMessages
        });
        continuationBaseMessages = planRetryMessages;
        this.eventBus.emit('runtime.activity', {
          id: `${runId}-plan-tool-retry`,
          runId,
          threadId: thread.threadId,
          kind: 'tool',
          status: result.status === 'completed' ? 'completed' : 'failed',
          title: 'Retried planned tool execution',
          detail: `toolResultCount=${result.toolResultCount ?? 0}`,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        });
      }
      for (let continuationAttempt = 1; shouldContinueProgressOnlyReply(activePlan, result) && continuationAttempt <= MAX_PROGRESS_CONTINUATION_ATTEMPTS; continuationAttempt += 1) {
        const previousAssistantContent = result.assistantMessage?.content || '';
        const progressReason = '模型返回了“将继续/请稍等”等进度型文本但没有完成承诺的后续动作；OpenAgent 正在自动续跑同一任务。';
        appendRuntimeInfoLog({
          scope: 'agent-loop',
          message: 'progress-only assistant continuation requested',
          data: {
            runId,
            threadId: thread.threadId,
            continuationAttempt,
            maxAttempts: MAX_PROGRESS_CONTINUATION_ATTEMPTS,
            loopCount: result.loopCount,
            toolResultCount: result.toolResultCount,
            assistantMessageId: result.assistantMessage?.id,
            assistantTextPreview: previousAssistantContent.slice(0, 500)
          }
        });
        this.eventBus.emit('runtime.activity', {
          id: `${runId}-progress-continuation-${continuationAttempt}`,
          runId,
          threadId: thread.threadId,
          kind: 'tool',
          status: 'running',
          title: 'Continuing unfinished assistant progress',
          detail: progressReason,
          createdAt: new Date().toISOString()
        });
        const nextMessages = result.assistantMessage ? [...continuationBaseMessages, result.assistantMessage] : continuationBaseMessages;
        result = await this.adapter.run({
          ...runInput,
          prompt: buildProgressContinuationPrompt(prompt, previousAssistantContent, activePlan),
          messages: nextMessages
        });
        continuationBaseMessages = nextMessages;
        this.eventBus.emit('runtime.activity', {
          id: `${runId}-progress-continuation-${continuationAttempt}`,
          runId,
          threadId: thread.threadId,
          kind: 'tool',
          status: result.status === 'completed' ? 'completed' : 'failed',
          title: 'Continued unfinished assistant progress',
          detail: `toolResultCount=${result.toolResultCount ?? 0}`,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        });
      }
      if (abortSignal.aborted) {
        const summary = '运行已停止。';
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planService.markFailed(activePlan, summary);
          this.emitPlan('plan.failed', activePlan, summary);
        }
        this.runState.finish(runId, { status: 'cancelled', summary });
        this.eventBus.emit('run.cancelled', { runId, summary });
        return { ok: false, runId, status: 'cancelled', error: summary };
      }
      let summary = summarizeRunResult(result);

      if (shouldContinueProgressOnlyReply(activePlan, result)) {
        summary = '运行未完成：模型连续返回“请稍等/我将继续”等进度型文本，但没有真正执行后续工具调用。请重试，或切换/配置更稳定支持工具调用的模型。';
        appendRuntimeInfoLog({
          scope: 'agent-loop',
          message: 'progress-only assistant continuation exhausted',
          data: {
            runId,
            threadId: thread.threadId,
            maxAttempts: MAX_PROGRESS_CONTINUATION_ATTEMPTS,
            assistantMessageId: result.assistantMessage?.id,
            assistantTextPreview: result.assistantMessage?.content.slice(0, 500)
          }
        });
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planService.markFailed(activePlan, summary);
          this.emitPlan('plan.failed', activePlan, summary);
        }
        this.emitFailureAssistantMessage(thread, transcript, summary);
        this.runState.finish(runId, { status: 'failed', summary });
        this.eventBus.emit('run.failed', { summary, details: summary });
        return { ok: false, runId, status: 'failed', error: summary };
      }

      if (isMissingRequiredPlanToolExecution(activePlan, result)) {
        summary = '计划执行未完成：模型没有发起计划要求的 OpenAgent 工具调用。请重试，或让模型改用明确的工具调用完成任务。';
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planService.markFailed(activePlan, summary);
          this.emitPlan('plan.failed', activePlan, summary);
        }
        this.emitFailureAssistantMessage(thread, transcript, summary);
        this.runState.finish(runId, { status: 'failed', summary });
        this.eventBus.emit('run.failed', { summary, details: summary });
        return { ok: false, runId, status: 'failed', error: summary };
      }

      if (result.status === 'completed' && result.assistantMessage) {
        const llmRawResponseLog = {
          scope: 'agent-loop',
          message: 'LLM raw response body',
          data: {
            runId,
            threadId: thread.threadId,
            assistantMessageId: result.assistantMessage.id,
            content: result.assistantMessage.content,
            contentLength: result.assistantMessage.content.length
          }
        } as const;
        appendLlmResponseLog(llmRawResponseLog);
        runInput.onLog?.({
          scope: 'agent-loop',
          message: 'LLM raw response body saved to log file',
          data: {
            runId,
            threadId: thread.threadId,
            assistantMessageId: result.assistantMessage.id,
            contentLength: result.assistantMessage.content.length
          }
        });
        const metadata = extractOpenAgentMetadata(result.assistantMessage.content);
        const assistantMessage = {
          ...result.assistantMessage,
          content: metadata.cleanContent || result.assistantMessage.content
        };
        summary = assistantMessage.content || summary;
        this.messages.push(assistantMessage);
        transcript.appendMessage(assistantMessage);
        const finalTranscriptStats = transcript.getStats();
        this.maybeAutoCompactThread({ threadId: thread.threadId, sessionFile, transcriptMessageCount: finalTranscriptStats.messageCount, runId });
        this.eventBus.emit('message.completed', assistantMessage);
        if (activePlan) {
          planExecutor?.completeKindAndStartFirstKind(
            'execute',
            'agent loop 已返回最终助手消息。',
            'finalize',
            '正在保存 transcript、处理结构化元数据并收尾。'
          );
        } else {
          for (const step of loopSteps) step.status = 'completed';
          emitRuntimeProgress();
        }
        this.finishThread(thread, prompt);
        this.runState.finish(runId, { status: 'completed', summary });
        const appliedSoulUpdates = metadata.soulChangeRequests
          .map((request) =>
            this.soulManager.applySoulChangeRequest(request, {
              kind: 'runtime_detection',
              runId,
              threadId: thread.threadId,
              excerpt: request.evidence || prompt.slice(0, 500)
            })
          )
          .filter((update): update is NonNullable<typeof update> => Boolean(update));
        const appliedUserUpdates = metadata.userUpdates
          .map((request) =>
            this.soulManager.applyUserUpdateRequest(request, {
              kind: 'runtime_detection',
              runId,
              threadId: thread.threadId,
              excerpt: request.evidence || prompt.slice(0, 500)
            })
          )
          .filter((update): update is NonNullable<typeof update> => Boolean(update));
        const appliedMemoryUpdates = metadata.memoryUpdates
          .map((request) =>
            this.soulManager.applyProjectMemoryUpdateRequest(request, {
              kind: 'runtime_detection',
              runId,
              threadId: thread.threadId,
              excerpt: request.evidence || prompt.slice(0, 500)
            })
          )
          .filter((update): update is NonNullable<typeof update> => Boolean(update));
        const appliedKnowledgeUpdates = [];
        for (const request of metadata.knowledgeUpdates) {
          this.runState.update(runId, {
            status: 'waiting_approval',
            summary: `等待用户审批 Knowledge Base 候选：${request.title}`
          });
          const decision = await this.requestToolApproval({
            title: `写入 Knowledge Base：${request.title}`,
            risk: request.confidence === 'high' ? 'medium' : 'low',
            description: [
              request.reason,
              '',
              '候选内容：',
              request.content.slice(0, 1200)
            ].join('\n'),
            actionType: 'knowledge.ingest',
            access: 'write',
            scope: 'once',
            payloadPreview: request.content.slice(0, 500),
            runId,
            threadId: thread.threadId
          });
          if (decision !== 'approved') {
            runInput.onLog?.({
              scope: 'runtime',
              message: 'Knowledge Base update rejected by user',
              data: {
                title: request.title,
                reason: request.reason
              }
            });
            continue;
          }
          this.runState.update(runId, { status: 'running', summary: `正在写入 Knowledge Base：${request.title}` });
          const applied = await this.knowledgeService.ingest({
            scope: 'system',
            title: request.title,
            content: request.content,
            tags: ['runtime-detection', ...(request.tags ?? [])]
          });
          if (applied.ok) appliedKnowledgeUpdates.push(applied);
        }
        const appliedAutoMemoryUpdates = [...appliedUserUpdates, ...appliedMemoryUpdates];
        if (appliedSoulUpdates.length > 0 || appliedAutoMemoryUpdates.length > 0 || appliedKnowledgeUpdates.length > 0) {
          const memorySummaryParts = [
            appliedSoulUpdates.length > 0 ? `SOUL.md ${appliedSoulUpdates.length} 条` : '',
            appliedUserUpdates.length > 0 ? `USER.md ${appliedUserUpdates.length} 条` : '',
            appliedMemoryUpdates.length > 0 ? `MEMORY.md ${appliedMemoryUpdates.length} 条` : '',
            appliedKnowledgeUpdates.length > 0 ? `Knowledge Base ${appliedKnowledgeUpdates.length} 条` : ''
          ].filter(Boolean);
          const memorySummary = `已自动更新长期上下文：${memorySummaryParts.join('，')}。`;
          runInput.onLog?.({
            scope: 'runtime',
            message: memorySummary,
            data: {
              source: 'llm-structured-metadata',
              soulUpdates: appliedSoulUpdates.map((update) => ({
                updateId: update.id,
                title: update.title,
                proposedText: update.proposedText
              })),
              userUpdates: appliedUserUpdates.map((update) => ({
                updateId: update.id,
                title: update.title,
                proposedText: update.proposedText
              })),
              memoryUpdates: appliedMemoryUpdates.map((update) => ({
                updateId: update.id,
                title: update.title,
                proposedText: update.proposedText
              })),
              knowledgeUpdates: appliedKnowledgeUpdates.map((update) => ({
                id: update.id,
                path: update.path,
                message: update.message
              }))
            }
          });
          this.eventBus.emit('memory.updated', {
            snapshot: this.getAgentBootstrapSnapshot(),
            soulUpdates: appliedSoulUpdates,
            userUpdates: appliedUserUpdates,
            memoryUpdates: appliedMemoryUpdates,
            knowledgeUpdates: appliedKnowledgeUpdates,
            summary: memorySummary
          });
        }
        if (activePlan) {
          planExecutor?.completeKind('finalize', 'transcript、长期上下文候选和最终状态处理完成。');
          activePlan = this.planService.markCompleted(planExecutor?.currentPlan ?? activePlan, summary);
          this.emitPlan('plan.completed', activePlan, 'Agent Plan 执行完成。');
          this.emitPlan('plan.updated', activePlan, 'Agent Plan 执行完成。');
        }
        this.eventBus.emit('run.completed', { runId, summary });
        return { ok: true, runId, status: 'completed' };
      }

      if (result.status === 'cancelled') {
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planService.markFailed(activePlan, summary);
          this.emitPlan('plan.failed', activePlan, summary);
        }
        this.runState.finish(runId, { status: 'cancelled', summary });
        this.eventBus.emit('run.cancelled', { runId, summary });
        return { ok: false, runId, status: 'cancelled', error: summary };
      }

      if (activePlan) {
        activePlan = planExecutor?.failCurrent(summary) ?? this.planService.markFailed(activePlan, summary);
        this.emitPlan('plan.failed', activePlan, summary);
      }
      this.emitFailureAssistantMessage(thread, transcript, summary);
      this.runState.finish(runId, { status: 'failed', summary });
      this.eventBus.emit('run.failed', { summary, details: result.error });
      return { ok: false, runId, status: 'failed', error: summary };
    } catch (error) {
      const message = errorToMessage(error);
      if (abortSignal.aborted) {
        const summary = '运行已停止。';
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planService.markFailed(activePlan, summary);
          this.emitPlan('plan.failed', activePlan, summary);
        }
        this.runState.finish(runId, { status: 'cancelled', summary });
        this.eventBus.emit('run.cancelled', { runId, summary });
        return { ok: false, runId, status: 'cancelled', error: summary };
      }
      if (activePlan) {
        activePlan = planExecutor?.failCurrent(message) ?? this.planService.markFailed(activePlan, message);
        this.emitPlan('plan.failed', activePlan, message);
      }
      this.emitFailureAssistantMessage(thread, transcript, message);
      this.runState.finish(runId, { status: 'failed', summary: message });
      this.eventBus.emit('run.failed', { summary: message, details: message });
      return { ok: false, runId, status: 'failed', error: message };
    }
  }

  private emitFailureAssistantMessage(thread: RuntimeThread, transcript: TranscriptStore, summary: string) {
    const content = summary.trim();
    if (!content) return;
    const assistantMessage: RuntimeMessage = {
      id: `assistant-${randomUUID()}`,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString()
    };
    this.messages.push(assistantMessage);
    transcript.appendMessage(assistantMessage);
    this.finishThread(thread, content);
    this.eventBus.emit('message.completed', assistantMessage);
  }

  private async maybeRunSkillCreatorScaffoldFastPath(input: {
    runInput: import('./runtime-types.js').AgentRuntimeRunInput;
    selectedSkill?: SkillCatalogItem | null;
    activePlan?: AgentPlan | null;
    prompt: string;
  }) {
    const { runInput, selectedSkill, activePlan, prompt } = input;
    if (selectedSkill?.name !== 'skill-creator') return null;
    const scaffold = inferSkillCreatorScaffoldRequest(prompt, runInput.agentId);
    if (!scaffold) return null;
    const skillScriptTool = runInput.tools.find((tool) => tool.name === 'skill_script');
    if (!skillScriptTool) return null;
    const initScript = selectedSkill.scripts.find((script) => script.path === 'scripts/init_skill.mjs');
    if (!initScript) return null;
    if (existsSync(scaffold.outputDir)) {
      runInput.onLog?.({
        scope: 'runtime',
        message: 'skill-creator scaffold fast path skipped because target exists',
        data: {
          runId: runInput.runId,
          threadId: runInput.threadId,
          selectedSkillName: selectedSkill.name,
          scriptPath: initScript.path,
          scaffold
        }
      });
      return [
        'skill-creator scaffold fast path was skipped because the target skill directory already exists.',
        `skillName: ${selectedSkill.name}`,
        `scriptPath: ${initScript.path}`,
        `targetSkillName: ${scaffold.slug}`,
        `targetPath: ${scaffold.outputDir}`,
        'Do not call init_skill.mjs again unless the user asks to overwrite or repair this existing skill.'
      ].join('\n');
    }

    const args = [
      '--name', scaffold.slug,
      '--displayName', scaffold.displayName,
      '--description', scaffold.description,
      '--risk', scaffold.risk,
      '--tags', scaffold.tags.join(','),
      '--allowedTools', scaffold.allowedTools.join(',')
    ];
    if (scaffold.outputDir) args.push('--output', scaffold.outputDir);

    const toolArgs = {
      skillName: selectedSkill.name,
      scriptPath: initScript.path,
      args,
      cwd: '.'
    };
    const toolCallId = `tool-${randomUUID()}`;
    runInput.onLog?.({
      scope: 'runtime',
      message: 'skill-creator scaffold fast path selected',
      data: {
        runId: runInput.runId,
        threadId: runInput.threadId,
        planId: activePlan?.id,
        toolCallId,
        selectedSkillName: selectedSkill.name,
        scriptPath: initScript.path,
        scaffold
      }
    });

    const executor = new ToolExecutor(runInput.tools, {
      runId: runInput.runId,
      threadId: runInput.threadId,
      agentId: runInput.agentId,
      sessionFile: runInput.sessionFile,
      providerId: runInput.providerId,
      model: runInput.model,
      onLog: runInput.onLog,
      emitUiEvent: runInput.emitUiEvent,
      workspaceRoot: runInput.workspaceRoot,
      requestApproval: runInput.requestApproval,
      getPlanContext: runInput.getPlanContext
    });
    const result = await executor.execute({
      toolName: 'skill_script',
      toolCallId,
      args: toolArgs,
      signal: runInput.abortSignal
    });

    const summary = result.ok
      ? `skill-creator scaffold already executed through OpenAgent ToolPolicy. Do not call skill_script for scripts/init_skill.mjs again unless the user asks to overwrite or repair the scaffold.`
      : `skill-creator scaffold fast path attempted but did not complete. Inspect the result before retrying or modifying files.`;
    return [
      summary,
      `toolCallId: ${toolCallId}`,
      `skillName: ${selectedSkill.name}`,
      `scriptPath: ${initScript.path}`,
      `targetSkillName: ${scaffold.slug}`,
      `displayName: ${scaffold.displayName}`,
      `ok: ${result.ok}`,
      'result:',
      result.content.slice(0, 2000)
    ].join('\n');
  }

  private emitPlan(type: 'plan.created' | 'plan.updated' | 'plan.completed' | 'plan.failed', plan: AgentPlan, reason?: string, changedStepId?: string) {
    this.eventBus.emit(type, this.toPlanPayload(plan, reason, changedStepId));
  }

  private toPlanPayload(plan: AgentPlan, reason?: string, changedStepId?: string): PlanUpdatedPayload {
    return {
      plan,
      changedStepId,
      reason,
      steps: plan.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        description: step.description,
        allowedTools: step.allowedTools,
        requiresApproval: step.requiresApproval,
        approvalReason: step.approvalReason,
        riskLevel: step.riskLevel,
        resultSummary: step.resultSummary,
        error: step.error,
        kind: step.kind
      }))
    };
  }

  private async buildKnowledgeContext(prompt: string, abortSignal?: AbortSignal) {
    try {
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context router start',
        data: { promptLength: prompt.length }
      });
      const decision = await this.knowledgeContextRouter.classify({ prompt, abortSignal }).catch((error) => {
        appendRuntimeInfoLog({
          scope: 'context',
          message: 'knowledge context router failed',
          data: { promptLength: prompt.length, error: errorToMessage(error) }
        });
        return null;
      });
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context router completed',
        data: {
          promptLength: prompt.length,
          needsKnowledge: Boolean(decision?.needsKnowledge),
          reason: decision?.reason || '(no router decision)',
          queryLength: decision?.query?.length ?? 0,
          limit: decision?.limit ?? 0
        }
      });
      if (!decision?.needsKnowledge) return '';
      const query = decision.query?.trim() || prompt;
      const limit = decision.limit ?? 3;
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledgeService.search start',
        data: { promptLength: prompt.length, queryLength: query.length, limit, routerReason: decision.reason }
      });
      const results = await this.knowledgeService.search({ scope: 'system', query, limit });
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledgeService.search completed',
        data: { promptLength: prompt.length, queryLength: query.length, resultCount: results.length }
      });
      if (results.length === 0) return '';
      return results
        .map((result, index) => {
          const citation = result.citations?.[0] || result.path || result.id;
          return [`[${index + 1}] ${result.title}`, `source: ${citation}`, result.content].join('\n');
        })
        .join('\n\n---\n\n');
    } catch (error) {
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context lookup failed',
        data: { error: errorToMessage(error) }
      });
      return '';
    }
  }




  private maybeAutoCompactThread(input: { threadId: string; sessionFile: string; transcriptMessageCount: number; runId: string }) {
    if (!this.adapter.compact) return;
    if (input.transcriptMessageCount < AUTO_COMPACT_TRANSCRIPT_MESSAGES) return;

    const lastCompactionAt = this.lastCompactionByThread.get(input.threadId) ?? 0;
    const now = Date.now();
    if (now - lastCompactionAt < AUTO_COMPACT_MIN_INTERVAL_MS) return;
    this.lastCompactionByThread.set(input.threadId, now);

    appendRuntimeInfoLog({
      scope: 'context',
      message: 'auto pi session compaction scheduled',
      data: {
        threadId: input.threadId,
        runId: input.runId,
        transcriptMessageCount: input.transcriptMessageCount,
        threshold: AUTO_COMPACT_TRANSCRIPT_MESSAGES
      }
    });
    this.eventBus.emit('terminal.delta', {
      runId: input.runId,
      text: `Auto AgentSession compaction scheduled for ${input.threadId}.`
    });
    void this.compactThread(input.threadId);
  }

  async compactThread(threadId = this.activeThreadId) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return { ok: false, error: `Thread not found: ${threadId}` };
    }
    if (!this.adapter.compact) {
      return { ok: false, error: 'Current runtime adapter does not support compaction.' };
    }

    const sessionFile = this.sessionStore.getSessionFile(threadId);
    const controller = new AbortController();
    const result = await this.adapter.compact({
      threadId,
      agentId: thread.agentId || this.options.agentId,
      workspaceRoot: this.options.workspaceRoot,
      sessionFile,
      providerId: this.options.providerId,
      model: this.options.model,
      abortSignal: controller.signal,
      onLog: (entry) => {
        appendRuntimeInfoLog(entry);
        this.eventBus.emit('terminal.delta', {
          runId: `compact-${threadId}`,
          text: formatRuntimeInfoLogSummary(entry)
        });
      },
      emitUiEvent: (type, payload) => this.eventBus.emit(type, payload)
    });

    if (result.ok) {
      this.eventBus.emit('terminal.delta', {
        runId: `compact-${threadId}`,
        text: 'AgentSession compaction completed.'
      });
    } else {
      this.eventBus.emit('terminal.delta', {
        runId: `compact-${threadId}`,
        text: `AgentSession compaction failed: ${result.error}`
      });
    }

    return result;
  }

  stopRun(runId?: string) {
    const stoppedRunIds = this.runState.stop(runId);
    const rejectedApprovals = this.approvalService.rejectPendingForRun(runId);
    for (const request of rejectedApprovals) {
      this.eventBus.emit('approval.resolved', {
        approvalId: request.id,
        decision: 'rejected',
        scope: request.scope,
        summary: '任务已停止，待审批操作已取消。'
      });
    }
    const targetRunIds = stoppedRunIds.length > 0
      ? stoppedRunIds
      : rejectedApprovals.map((request) => request.runId).filter((id): id is string => Boolean(id));
    for (const stoppedRunId of new Set(targetRunIds)) {
      const summary = '运行已停止。';
      this.runState.finish(stoppedRunId, { status: 'cancelled', summary });
      this.eventBus.emit('run.cancelled', { runId: stoppedRunId, summary });
    }
    return { ok: stoppedRunIds.length > 0 || rejectedApprovals.length > 0 };
  }

  createThread(input?: { agentId?: string; title?: string }) {
    const threadId = `thread-${randomUUID()}`;
    const thread = this.createThreadRecord({ threadId, title: input?.title || '新的会话', createdAt: new Date().toISOString(), agentId: input?.agentId });
    this.threads.set(threadId, thread);
    this.sessionStore.upsertThread(thread);
    this.activeThreadId = threadId;
    this.messages.length = 0;
    return { ok: true, threadId, snapshot: this.getSnapshot() };
  }

  selectThread(threadId: string) {
    if (!this.threads.has(threadId)) {
      return { ok: false, error: `Thread not found: ${threadId}`, snapshot: this.getSnapshot() };
    }
    this.activeThreadId = threadId;
    this.loadActiveThreadMessages();
    return { ok: true, snapshot: this.getSnapshot() };
  }

  markThreadTitlePrefix(threadId: string, prefix: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return { ok: false, error: `Thread not found: ${threadId}`, snapshot: this.getSnapshot() };
    }
    if (!thread.title.startsWith(prefix)) {
      thread.title = `${prefix}${thread.title}`;
      thread.updatedAt = new Date().toISOString();
      this.sessionStore.upsertThread(thread);
    }
    return { ok: true, snapshot: this.getSnapshot() };
  }

  deleteThread(threadId: string) {
    this.threads.delete(threadId);
    this.sessionStore.removeThread(threadId);
    if (this.activeThreadId === threadId) {
      this.activeThreadId = this.threads.keys().next().value ?? 'thread-welcome';
      this.loadActiveThreadMessages();
    }
    return { ok: true, snapshot: this.getSnapshot() };
  }

  private loadActiveThreadMessages() {
    const sessionFile = this.sessionStore.getSessionFile(this.activeThreadId);
    const transcript = new TranscriptStore(sessionFile);
    this.messages.length = 0;
    this.messages.push(...transcript.readMessages());
  }

  private getActiveThread() {
    const thread = this.threads.get(this.activeThreadId);
    if (!thread) {
      const fallback = this.createThreadRecord({ threadId: this.activeThreadId, title: '新的会话', createdAt: new Date().toISOString() });
      this.threads.set(fallback.threadId, fallback);
      return fallback;
    }
    return thread;
  }

  private touchThreadForPrompt(thread: RuntimeThread, prompt: string, timestamp: string) {
    thread.updatedAt = timestamp;
    if (thread.title === '新的会话' || thread.title === '欢迎使用 OpenAgent') {
      thread.title = prompt.slice(0, 28) || thread.title;
    }
    this.sessionStore.upsertThread(thread);
  }

  private finishThread(thread: RuntimeThread, prompt: string) {
    thread.updatedAt = new Date().toISOString();
    thread.runCount += 1;
    if (thread.title === '新的会话' || thread.title === '欢迎使用 OpenAgent') {
      thread.title = prompt.slice(0, 28) || thread.title;
    }
    this.sessionStore.upsertThread(thread);
  }

  private createThreadRecord(input: { threadId: string; title: string; createdAt: string; agentId?: string }): RuntimeThread {
    return {
      threadId: input.threadId,
      agentId: input.agentId || this.options.agentId,
      workspaceRoot: this.options.workspaceRoot,
      workspaceName: this.options.workspaceName,
      branch: this.options.branch,
      title: input.title,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      archived: false,
      runCount: 0
    };
  }


}

function selectRelevantMemoryContext(memory: string, prompt: string) {
  const queryTerms = tokenizeMemoryQuery(prompt);
  if (queryTerms.length === 0) return '';
  const sections = splitMemorySections(memory);
  return sections
    .map((section) => ({ section, score: scoreMemorySection(section, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.section.trim())
    .join('\n\n---\n\n')
    .slice(0, 6000);
}

function splitMemorySections(memory: string) {
  const normalized = memory.trim();
  if (!normalized) return [];
  const parts = normalized.split(/\n(?=##\s+)/g).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [normalized];
}

function scoreMemorySection(section: string, queryTerms: string[]) {
  const haystack = section.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? term.length : 0), 0);
}

function tokenizeMemoryQuery(prompt: string) {
  const stopwords = new Set([
    'wiki',
    '知识库',
    '保存',
    '存到',
    '分析',
    '图片',
    '文件',
    '这个',
    '一下',
    '帮我',
    '当前',
    '执行',
    'tool',
    'agent'
  ]);
  const asciiTerms = prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  const chineseTerms = prompt.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  return [...new Set([...asciiTerms, ...chineseTerms].map((term) => term.trim()).filter((term) => term && !stopwords.has(term)))];
}

function summarizeProgressLogEntry(entry: RuntimeLogEntry) {
  if (entry.scope === 'context') return '完成运行上下文构建';

  if (entry.scope === 'agent-loop') {
    if (entry.message.includes('resolve model context')) return '解析模型与 provider 配置';
    if (entry.message.includes('prepare agent session managers')) return '准备 agent session 管理器和资源加载器';
    if (entry.message.includes('create AgentSession')) return '创建 AgentSession，并注入 OpenAgent tools';
    if (entry.message.includes('prompt session')) return '提交用户请求到 AgentSession';
    if (entry.message.includes('prompt resolved')) return '模型与工具循环已结束';
    if (entry.message.includes('raw response body saved')) return '保存模型原始响应日志';
  }

  if (entry.scope === 'runtime') {
    const data = entry.data as { toolName?: string; contentLength?: number; durationMs?: number } | undefined;
    if (entry.message === 'tool execution started') return `执行 tool：${data?.toolName ?? 'unknown'}`;
    if (entry.message === 'tool execution completed') return `tool 完成：${data?.toolName ?? 'unknown'}，返回 ${data?.contentLength ?? 0} 字符`;
    if (entry.message === 'tool execution failed') return `tool 失败：${data?.toolName ?? 'unknown'}`;
    if (entry.message.includes('SOUL.md')) return '处理长期记忆更新';
  }

  return null;
}


function shouldRetryPlanToolExecution(plan: AgentPlan | null, result: { status: string; assistantMessage?: RuntimeMessage; toolResultCount?: number }) {
  return isMissingRequiredPlanToolExecution(plan, result);
}

function isMissingRequiredPlanToolExecution(plan: AgentPlan | null, result: { status: string; assistantMessage?: RuntimeMessage; toolResultCount?: number }) {
  if (!plan || result.status !== 'completed' || !result.assistantMessage) return false;
  if ((result.toolResultCount ?? 0) > 0) return false;
  return planRequiresToolExecution(plan);
}

function planRequiresToolExecution(plan: AgentPlan) {
  return plan.steps.some((step) => {
    if (step.kind !== 'execute') return false;
    const tools = step.allowedTools ?? [];
    if (step.requiresApproval) return true;
    return tools.some((tool) => isExecutionToolName(tool));
  });
}

function isExecutionToolName(toolName: string) {
  const normalized = toolName.toLowerCase().replace(/[_-]/g, '-');
  return [
    'tool-executor',
    'write-file',
    'file-write',
    'shell-exec',
    'pi-coding-agent',
    'skill-script'
  ].includes(normalized);
}

function shouldContinueProgressOnlyReply(plan: AgentPlan | null, result: { status: string; assistantMessage?: RuntimeMessage; toolResultCount?: number }) {
  if (result.status !== 'completed' || !result.assistantMessage) return false;
  const content = stripOpenAgentMetadata(result.assistantMessage.content);
  if (!content.trim()) return false;
  if (hasUserBlockerRequest(content)) return false;
  if (hasStrongFinalCompletionSignal(content) && !hasExplicitWaitOrContinueSignal(content)) return false;

  const promisesFutureWork = /(?:我(?:将|会|现在|马上|立即)|接下来(?:我)?(?:将|会)?|下一步(?:我)?(?:将|会)?|继续(?:推进|执行|处理|完成)|开始(?:读取|编写|创建|更新|执行|处理|检查|重构)|正在(?:读取|编写|创建|更新|执行|处理|检查|重构)|I\s+(?:will|am going to)|I'll|Next,\s*I\s+will)/i.test(content);
  if (!promisesFutureWork) return false;

  if (hasExplicitWaitOrContinueSignal(content)) return true;

  // Plan-mode execute steps already state that tool-backed work is expected; a future-tense
  // assistant reply in that context should not be treated as final completion.
  return Boolean(plan && planRequiresToolExecution(plan));
}

function stripOpenAgentMetadata(content: string) {
  return content.replace(/<!--\s*openagent:metadata[\s\S]*?-->/g, '').trim();
}

function hasExplicitWaitOrContinueSignal(content: string) {
  return /(?:请稍等|稍等|我将立即|我会继续|将继续|立即开始|马上开始|下一步执行计划|下一步计划|正在进行|正在(?:读取|编写|创建|更新|执行|处理|检查|重构)|继续推进|开始(?:读取|编写|创建|更新|执行|处理|检查|重构))/.test(content);
}

function hasUserBlockerRequest(content: string) {
  return /(?:请问|是否可以|是否确认|请确认|需要您|请提供|等待您|待您|如果您(?:确认|提供|同意)|需要用户|人工确认)/.test(content);
}

function hasStrongFinalCompletionSignal(content: string) {
  return /(?:任务已(?:经)?(?:圆满)?完成|已(?:经)?全部(?:开发)?完成|准备就绪|最终交付清单|如果您(?:还有|有)其他需求|随时告诉我|done\b|completed\b)/i.test(content);
}

function buildPlanToolExecutionRetryPrompt(originalPrompt: string, previousAssistantContent: string, plan: AgentPlan | null) {
  return [
    'OpenAgent runtime noticed that the active plan still requires actual tool execution, but the previous assistant turn returned only user-facing progress text and no OpenAgent tool result.',
    '',
    'You must continue the same user task now. Do not apologize and do not describe future work. Call the appropriate OpenAgent tool in this turn using the exact registered tool name.',
    'If the active context has a selected skill with declared scripts/resources, use skill_load, skill_resource, or skill_script before any generic coding agent. Only use pi_coding_agent when no selected skill tool fits the step.',
    '',
    'Original user request:',
    originalPrompt,
    '',
    'Active plan:',
    plan ? formatPlanForPrompt(plan) : '(no active plan)',
    '',
    'Previous assistant text that did not execute a tool:',
    previousAssistantContent.slice(0, 2000)
  ].join('\n');
}

function buildProgressContinuationPrompt(originalPrompt: string, previousAssistantContent: string, plan: AgentPlan | null) {
  return [
    'OpenAgent runtime detected that your previous assistant message was progress-only or future-tense continuation text, not a final deliverable.',
    '',
    'Continue the same user task now.',
    'Do not apologize. Do not say “请稍等”, “我将继续”, “正在处理”, or describe future work as the final answer.',
    'If the next action requires reading, writing, running code, using a skill, or delegating to a child agent, call the appropriate structured OpenAgent tool in this turn.',
    'Only return a final user-facing answer after the promised work has actually completed or a real blocker requires user input.',
    '',
    'Original user request:',
    originalPrompt,
    '',
    'Active plan:',
    plan ? formatPlanForPrompt(plan) : '(no active plan)',
    '',
    'Previous progress-only assistant text:',
    previousAssistantContent.slice(0, 3000)
  ].join('\n');
}

function toPlanExecutionContext(plan: AgentPlan | null, selectedSkill?: SkillCatalogItem | null): PlanExecutionContext | null {
  if (!plan) return null;
  const currentStep = plan.steps.find((step) => step.status === 'in_progress') ?? plan.steps.find((step) => step.status === 'pending');
  if (!currentStep) return null;
  return {
    planId: plan.id,
    stepId: currentStep.id,
    mode: plan.mode,
    allowedTools: currentStep.allowedTools,
    riskLevel: currentStep.riskLevel,
    selectedSkillName: selectedSkill?.name,
    selectedSkillHasScripts: Boolean(selectedSkill?.scripts.length)
  };
}

function toSelectedSkillExecutionContext(selectedSkill?: SkillCatalogItem | null): PlanExecutionContext | null {
  if (!selectedSkill) return null;
  return {
    planId: `selected-skill:${selectedSkill.name}`,
    stepId: 'selected-skill-routing',
    mode: 'executing',
    riskLevel: selectedSkill.risk === 'destructive' ? 'high' : selectedSkill.risk === 'read' ? 'low' : 'medium',
    selectedSkillName: selectedSkill.name,
    selectedSkillHasScripts: selectedSkill.scripts.length > 0
  };
}

function resolvePromptContextMode(input: { prompt: string; hasSelectedSkill: boolean; hasActivePlan: boolean; attachmentsCount: number }): { transcriptMode: 'recent' | 'tool_minimal'; reason: string } {
  if (isContextDependentPrompt(input.prompt)) {
    return { transcriptMode: 'recent', reason: 'current prompt explicitly depends on prior conversation context' };
  }

  if (input.hasActivePlan) {
    return { transcriptMode: 'tool_minimal', reason: 'active plan provides structured task state without replaying prior transcript' };
  }

  if (input.hasSelectedSkill) {
    return { transcriptMode: 'tool_minimal', reason: 'selected skill run should route tools from current prompt and skill context' };
  }

  if (input.attachmentsCount > 0 && looksLikeDirectToolAction(input.prompt)) {
    return { transcriptMode: 'tool_minimal', reason: 'current prompt plus current attachments are sufficient for tool routing' };
  }

  if (looksLikeDirectToolAction(input.prompt)) {
    return { transcriptMode: 'tool_minimal', reason: 'current prompt is an explicit tool/action request' };
  }

  return { transcriptMode: 'recent', reason: 'conversation answer may need recent transcript continuity' };
}

function isContextDependentPrompt(prompt: string) {
  const value = prompt.trim().toLowerCase();
  if (!value) return false;
  return /(^|[\s，。,.!?！？])(继续|接着|上面|刚才|前面|之前|那个|这个|它|它们|按你说的|就这样|照这个|照刚才|再来|重试|修正一下|改成|换成)([\s，。,.!?！？]|$)/i.test(value) ||
    /\b(continue|that|it|those|previous|above|same|retry|again)\b/i.test(value);
}

function looksLikeDirectToolAction(prompt: string) {
  const value = prompt.trim().toLowerCase();
  if (!value) return false;
  return /(读取|查看|列出|搜索|查找|统计|执行|运行|调用|安装|写入|创建|修改|修复|生成|保存|摄取|导入|导出|发送|打开|删除|提交|push|构建|编译|测试|打包|转换|分析附件|处理附件|落实到文档|进行开发|工具调用|skill|插件|知识库|wiki|命令|脚本|文件|目录|路径|日志|报错|typecheck|build|install|run|test|grep|find|read|write|shell|commit)/i.test(value);
}

function filterToolsForSelectedSkill(tools: RuntimeTool[], selectedSkill?: SkillCatalogItem | null) {
  if (!selectedSkill || selectedSkill.allowedTools.length === 0) return tools;
  const allowed = new Set(selectedSkill.allowedTools);
  if (selectedSkill.scripts.length > 0) {
    allowed.add('skill_script');
  }
  if (selectedSkill.name !== 'skill-creator') {
    allowed.add('pi_coding_agent');
  }
  const alwaysAllowedReadOnlyTools = new Set([
    'ls',
    'list_directory',
    'read',
    'read_file',
    'find',
    'grep',
    'count_files',
    'current_time'
  ]);
  return tools.filter((tool) => allowed.has(tool.name) || alwaysAllowedReadOnlyTools.has(tool.name));
}

function formatSelectedSkillPlanRule(skill: SkillCatalogItem) {
  const allowedSkillTools = getAllowedSelectedSkillTools(skill);
  if (allowedSkillTools.length > 0) {
    return `- Selected skill ${skill.name} is the primary execution path for this run. Start with these available structured skill tools: ${allowedSkillTools.join(', ')}.`;
  }
  return `- Selected skill ${skill.name} is the primary execution path for this run. Start with available structured skill tools before considering other execution tools.`;
}

function formatSelectedSkillRoutingRule(skill: SkillCatalogItem) {
  const scripts = skill.scripts.length > 0
    ? skill.scripts.map((script) => `- ${script.path} runtime=${script.runtime || 'unknown'} risk=${script.risk || 'read'} network=${script.network === true} writes=${script.writes === true}${formatScriptDependencies(script)}${script.description ? ` :: ${script.description}` : ''}`).join('\n')
    : '- (no declared scripts)';
  const resources = skill.resources.filter((resource) => resource.kind !== 'script').slice(0, 12).map((resource) => `- ${resource.kind}: ${resource.path}${resource.description ? ` :: ${resource.description}` : ''}`).join('\n') || '- (no declared resources)';
  const allowedSkillTools = getAllowedSelectedSkillTools(skill);
  const shouldMentionLoad = isSelectedSkillToolAllowed(skill, 'skill_load');
  const shouldMentionResource = isSelectedSkillToolAllowed(skill, 'skill_resource');
  const shouldMentionScript = isSelectedSkillToolAllowed(skill, 'skill_script');
  const creatorRules = skill.name === 'skill-creator'
    ? [
        'Skill creation destination rules:',
        '- Create new skills only under ~/.openagent/agents/<agentId>/skills/<skill-name>/ by default.',
        '- Never create a skill package under the workspace root, such as <workspace>/<skill-name>/ or <workspace>/skills/<skill-name>/.',
        '- If writing files directly, all write_file paths must stay inside the current agent skill root.'
      ]
    : [];
  return [
    `The user explicitly selected skill ${skill.name} (${skill.id}). Treat this as the primary execution path for this run.`,
    skill.name === 'skill-creator'
      ? 'Use the selected skill-creator tools directly. Do not delegate to pi_coding_agent to create, inspect, scaffold, run, or bypass skill-creator; skill authoring must stay on the governed skill-creator path.'
      : 'Use the selected skill tools directly first. Do not delegate to pi_coding_agent merely to reimplement or bypass a declared skill script/resource that can satisfy the task; pi_coding_agent is allowed for real blockers such as dependency/runtime diagnosis, script failures, or requested skill/package fixes.',
    allowedSkillTools.length > 0
      ? `For this selected-skill run, the only exposed structured skill tool(s) are: ${allowedSkillTools.join(', ')}. Do not call or mention unavailable skill tools.`
      : 'Use only structured tool calls that are actually exposed in this run. Do not call or mention unavailable skill tools.',
    shouldMentionLoad
      ? 'If detailed instructions are needed, call skill_load with this exact skillName first.'
      : 'Do not call skill_load for this selected skill; it is not available in this run.',
    shouldMentionResource
      ? 'If a template/reference/example is needed, call skill_resource with this exact skillName and resource path.'
      : 'Do not call skill_resource for this selected skill; it is not available in this run.',
    shouldMentionScript
      ? 'If deterministic computation or scaffolding is needed and a declared script fits, call skill_script with this exact skillName and declared scriptPath. Required arguments are skillName and scriptPath; optional arguments are args, cwd, and timeoutMs. Do not invent additional argument keys. Do not run the skill script indirectly through pi_coding_agent or shell_exec.'
      : 'Do not call skill_script unless it is exposed as an available structured tool in this run.',
    'Never include pseudo tool-call syntax or provider protocol markers in normal text; use a real structured tool call with the exact exposed tool name.',
    skill.name === 'skill-creator'
      ? 'Only avoid skill_script when no declared skill-creator script is relevant; explain why and use governed skill tools/write_file rather than pi_coding_agent.'
      : 'Only avoid skill_script when no declared script is relevant, the script hits a real dependency/runtime blocker, the script fails and needs diagnosis/fix, or the user explicitly asks for code changes outside the selected skill; explain why before choosing another tool.',
    'Declared scripts:',
    scripts,
    'Declared resources:',
    resources,
    ...creatorRules
  ].join('\n');
}

function formatScriptDependencies(script: SkillCatalogItem['scripts'][number]) {
  const parts = [
    script.dependencies?.pip?.length ? `pip=[${script.dependencies.pip.join(',')}]` : '',
    script.dependencies?.npm?.length ? `npm=[${script.dependencies.npm.join(',')}]` : '',
    script.dependencies?.system?.length ? `system=[${script.dependencies.system.join(',')}]` : ''
  ].filter(Boolean);
  return parts.length > 0 ? ` deps=${parts.join(' ')}` : '';
}

function getAllowedSelectedSkillTools(skill: SkillCatalogItem) {
  const skillTools = ['skill_list', 'skill_load', 'skill_resource', 'skill_script'];
  if (skill.allowedTools.length === 0) return skillTools;
  return skillTools.filter((tool) => skill.allowedTools.includes(tool) || isImplicitSelectedSkillToolAllowed(skill, tool));
}

function isSelectedSkillToolAllowed(skill: SkillCatalogItem, toolName: string) {
  return skill.allowedTools.length === 0 || skill.allowedTools.includes(toolName) || isImplicitSelectedSkillToolAllowed(skill, toolName);
}

function isImplicitSelectedSkillToolAllowed(skill: SkillCatalogItem, toolName: string) {
  return toolName === 'skill_script' && skill.scripts.length > 0;
}

function formatPlanForPrompt(plan: AgentPlan) {
  return [
    `planId: ${plan.id}`,
    `goal: ${plan.goal}`,
    `status: ${plan.status}`,
    `riskLevel: ${plan.riskLevel}`,
    'steps:',
    ...plan.steps.map((step, index) => {
      const flags = [step.status, step.kind, step.requiresApproval ? 'requiresApproval' : ''].filter(Boolean).join(', ');
      return `${index + 1}. [${flags}] ${step.title}${step.description ? ` - ${step.description}` : ''}`;
    })
  ].join('\n');
}

function formatPlanApprovalDescription(plan: AgentPlan) {
  const hasWriteOrExecuteStep = plan.steps.some((step) => {
    const tools = step.allowedTools ?? [];
    return step.requiresApproval || step.kind === 'execute' || tools.some((tool) => !['read', 'grep', 'list', 'read-only'].includes(tool));
  });
  const defaultReason = hasWriteOrExecuteStep
    ? '该计划后续可能修改文件、执行工具或影响当前工作区，需要你确认后继续。'
    : '该计划将从只读规划进入执行阶段，需要你确认后继续。';

  return [
    `目标：${plan.goal}`,
    `风险等级：${plan.riskLevel}`,
    `审批原因：${plan.approvalReason || defaultReason}`
  ].join('\n');
}

interface SkillCreatorScaffoldRequest {
  slug: string;
  displayName: string;
  description: string;
  risk: 'read' | 'write' | 'network' | 'external' | 'destructive';
  tags: string[];
  allowedTools: string[];
  outputDir: string;
}

function inferSkillCreatorScaffoldRequest(prompt: string, agentId: string): SkillCreatorScaffoldRequest | null {
  if (!/(skill|技能)/i.test(prompt)) return null;
  if (!/(创建|新建|生成|封装|做一个|加一个|create|scaffold|generate)/i.test(prompt)) return null;

  const explicitSlug = extractExplicitSkillSlug(prompt);
  const displayName = extractSkillDisplayName(prompt) || explicitSlug || 'new-skill';
  const slug = safeSkillSlug(explicitSlug || displayName);
  if (!slug) return null;

  const isPdfMerge = /pdf/i.test(prompt) && /(合并|merge|merg)/i.test(prompt);
  const description = isPdfMerge
    ? '合并目录下的 PDF 文件。'
    : `Provide ${displayName} skill guidance and reusable automation.`;
  const tags = isPdfMerge ? ['pdf', 'merge', 'skill'] : ['skill'];
  const risk: SkillCreatorScaffoldRequest['risk'] = isPdfMerge ? 'write' : 'read';
  return {
    slug,
    displayName,
    description,
    risk,
    tags,
    allowedTools: ['skill_load', 'skill_resource', 'skill_script'],
    outputDir: path.join(getOpenAgentHome(), 'agents', agentId, 'skills', slug)
  };
}

function extractExplicitSkillSlug(prompt: string) {
  const candidates: string[] = prompt.match(/[A-Za-z][A-Za-z0-9._-]*-[A-Za-z0-9._-]*/g) ?? [];
  const filtered = candidates.filter((item) => !['skill-creator', 'skill-installer'].includes(item.toLowerCase()));
  return filtered.at(-1) ?? '';
}

function extractSkillDisplayName(prompt: string) {
  const match = /(?:名字叫做|名叫|叫做|名为|名称(?:是|为)?)([^,，\s]+)/.exec(prompt);
  return match?.[1]?.trim() ?? '';
}

function safeSkillSlug(value: string) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createDefaultAdapter() {
  // Embedded Pi is the default and production runtime path. The local demo loop
  // is kept only for explicit UI/runtime smoke tests.
  if (process.env.OPENAGENT_RUNTIME_ENGINE === 'local-demo') {
    return new LocalDemoAgentLoop();
  }
  if (process.env.OPENAGENT_RUNTIME_ENGINE === 'pi') {
    return new PiRuntimeAdapter();
  }
  return new PiRuntimeAdapter();
}

function shouldAutoApproveRuntimeApprovals() {
  try {
    return getOpenAgentAppSettings().runtime.autoApproveRuntimeApprovals;
  } catch {
    return false;
  }
}

function sortThreadsForDisplay(threads: RuntimeThread[]) {
  return [...threads].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.createdAt);
    const bTime = Date.parse(b.updatedAt || b.createdAt);
    return normalizeTime(bTime) - normalizeTime(aTime);
  });
}

function normalizeTime(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function sanitizeAttachmentName(name: string) {
  const cleaned = name.replace(/[/:\\]/g, '-').replace(/\0/g, '').trim();
  return cleaned || `attachment-${Date.now()}`;
}

function uniquePath(preferredPath: string) {
  if (!existsSync(preferredPath)) return preferredPath;
  const dir = path.dirname(preferredPath);
  const extension = path.extname(preferredPath);
  const base = path.basename(preferredPath, extension);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.join(dir, `${base}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${extension}`);
}

function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return Buffer.from(dataUrl, 'utf8');
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  return isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
}
