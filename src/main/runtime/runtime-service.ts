import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRuntimeAdapter, PromptSubmissionInput, RuntimeAttachment, RuntimeLogEntry, RuntimeMessage, RuntimeServiceOptions, RuntimeSnapshot, RuntimeThread } from './runtime-types.js';
import { RuntimeEventBus } from './event-bus.js';
import { RunStateStore } from './run-state.js';
import { SessionStore } from './session-store.js';
import { TranscriptStore } from './transcript-store.js';
import { buildRunContextLogSnapshot, buildRunInput } from './context-builder.js';
import { createDefaultToolRegistry } from './tool-registry.js';
import { LocalDemoAgentLoop } from './agent-loop.js';
import { PiRuntimeAdapter } from './pi/pi-runtime-adapter.js';
import { PromptValidationError, errorToMessage } from './errors.js';
import { summarizeRunResult } from './agent-loop-result.js';
import { appendLlmResponseLog, appendRuntimeInfoLog, formatRuntimeInfoLogSummary } from './runtime-info-logger.js';
import { SoulManager, extractOpenAgentMetadata } from './memory/soul-manager.js';
import { SubagentService } from './subagents/subagent-service.js';
import { createShellAgentTool } from './subagents/shell-agent-tool.js';
import { createKnowledgeAgentTool } from './subagents/knowledge-agent-tool.js';
import { ApprovalService, type RuntimeApprovalRequest } from './approval-service.js';
import { KnowledgeService } from './knowledge/knowledge-service.js';
import { createKnowledgeTools } from './knowledge/knowledge-tools.js';
import { getOpenAgentHome } from './knowledge/knowledge-paths.js';
import { PlanService } from './planning/plan-service.js';
import type { AgentPlan, PlanUpdatedPayload } from './planning/plan-types.js';

export class RuntimeService {
  private activeThreadId = 'thread-welcome';
  private readonly createdAt = new Date().toISOString();
  private readonly eventBus: RuntimeEventBus;
  private readonly approvalService = new ApprovalService();
  private readonly runState = new RunStateStore();
  private readonly sessionStore: SessionStore;
  private readonly soulManager: SoulManager;
  private readonly knowledgeService: KnowledgeService;
  private readonly planService: PlanService;
  private readonly toolRegistry: ReturnType<typeof createDefaultToolRegistry>;
  private readonly subagents: SubagentService;
  private readonly messages: RuntimeMessage[] = [];
  private readonly threads = new Map<string, RuntimeThread>();

  constructor(
    private options: RuntimeServiceOptions,
    private readonly adapter: AgentRuntimeAdapter = createDefaultAdapter()
  ) {
    this.eventBus = new RuntimeEventBus(options.emitUiEvent);
    this.sessionStore = new SessionStore(options.agentId);
    this.knowledgeService = new KnowledgeService(options.agentId);
    this.planService = new PlanService(options.agentId);
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
    this.toolRegistry.register(createShellAgentTool(this.subagents, options.workspaceRoot));
    this.toolRegistry.register(createKnowledgeAgentTool(this.subagents, options.workspaceRoot));

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
        content: '你好，我是 OpenAgent Desktop UI 原型。当前已接入第一版 runtime loop 骨架，后续可以切换到 Pi AgentSession。',
        createdAt: this.createdAt
      });
    }
  }

  getAgentBootstrapSnapshot() {
    return this.soulManager.getBootstrapSnapshot();
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

  resolveApproval(input: { approvalId?: string; decision?: 'approved' | 'rejected' }) {
    const approvalId = input.approvalId || '';
    const decision = input.decision;
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

    const result = this.approvalService.resolveApproval({ approvalId, decision });
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
        summary: isPlanApproval
          ? result.decision === 'approved'
            ? 'Agent Plan 已批准，agent 将开始执行。'
            : 'Agent Plan 已拒绝。'
          : result.decision === 'approved'
            ? '外部路径访问已批准，agent 将继续执行。'
            : '外部路径访问已拒绝。'
      });
    }
    return result;
  }

  private async requestToolApproval(request: Omit<RuntimeApprovalRequest, 'id'> & { id?: string }) {
    const { request: approvalRequest, decision } = this.approvalService.requestApproval(request);
    this.eventBus.emit('approval.required', approvalRequest);
    return decision;
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
      attachments
    };
    this.messages.push(userMessage);
    this.touchThreadForPrompt(thread, prompt, now);

    const sessionFile = this.sessionStore.getSessionFile(thread.threadId);
    const transcript = new TranscriptStore(sessionFile);
    transcript.appendMessage(userMessage);

    const draftPlan = this.planService.shouldPlan(prompt)
      ? this.planService.createDraftPlan({
          runId,
          threadId: thread.threadId,
          agentId: this.options.agentId,
          prompt,
          now
        })
      : null;

    this.eventBus.emit('run.started', { runId, threadId: thread.threadId });
    if (draftPlan) {
      this.emitPlan('plan.created', draftPlan, 'Agent Plan Mode 已生成待确认计划。');
      this.emitPlan('plan.updated', draftPlan, '等待用户确认计划。');
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
    plan?: AgentPlan | null;
  }) {
    const { prompt, runId, thread, transcript, sessionFile, abortSignal, attachments } = input;
    let activePlan = input.plan ?? null;
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
      if (activePlan) {
        this.runState.update(runId, { status: 'waiting_approval', summary: '等待用户确认 Agent Plan。' });
        this.eventBus.emit('plan.approval.required', this.toPlanPayload(activePlan, '请确认是否按该计划执行。'));
        const decision = await this.requestToolApproval({
          title: '执行 Agent Plan',
          risk: activePlan.riskLevel,
          description: formatPlanApprovalDescription(activePlan),
          actionType: 'agent-plan.execute',
          access: 'execute',
          scope: 'once',
          payloadPreview: activePlan.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n'),
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
        activePlan = this.planService.approve(activePlan);
        this.runState.update(runId, { status: 'running', summary: 'Agent Plan 已确认，开始执行。' });
        this.eventBus.emit('plan.approval.resolved', this.toPlanPayload(activePlan, '用户已确认 Agent Plan。'));
        this.emitPlan('plan.updated', activePlan, '用户已确认计划，开始执行。');
      }

      const runInput = buildRunInput({
        runId,
        threadId: thread.threadId,
        agentId: thread.agentId || this.options.agentId,
        workspaceRoot: this.options.workspaceRoot,
        sessionFile,
        prompt,
        providerId: this.options.providerId,
        model: this.options.model,
        messages: transcript.readMessages(),
        attachments,
        tools: this.toolRegistry.list(),
        abortSignal,
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
          return this.requestToolApproval(request);
        }
      });
      const bootstrap = this.soulManager.getBootstrapSnapshot();
      const knowledgeContext = await this.buildKnowledgeContext(prompt);
      const memoryContext = selectRelevantMemoryContext(bootstrap.memory, prompt);
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

      appendProgressStep('调用模型并等待 agent loop 返回');
      const result = await this.adapter.run(runInput);
      let summary = summarizeRunResult(result);

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
        this.eventBus.emit('message.completed', assistantMessage);
        if (activePlan) {
          activePlan = this.planService.markCompleted(activePlan, summary);
          this.emitPlan('plan.completed', activePlan, 'Agent Plan 执行完成。');
          this.emitPlan('plan.updated', activePlan, 'Agent Plan 执行完成。');
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
        this.eventBus.emit('run.completed', { runId, summary });
        return { ok: true, runId, status: 'completed' };
      }

      if (result.status === 'cancelled') {
        if (activePlan) {
          activePlan = this.planService.markFailed(activePlan, summary);
          this.emitPlan('plan.failed', activePlan, summary);
        }
        this.runState.finish(runId, { status: 'cancelled', summary });
        this.eventBus.emit('run.cancelled', { runId, summary });
        return { ok: false, runId, status: 'cancelled', error: summary };
      }

      if (activePlan) {
        activePlan = this.planService.markFailed(activePlan, summary);
        this.emitPlan('plan.failed', activePlan, summary);
      }
      this.runState.finish(runId, { status: 'failed', summary });
      this.eventBus.emit('run.failed', { summary, details: result.error });
      return { ok: false, runId, status: 'failed', error: summary };
    } catch (error) {
      const message = errorToMessage(error);
      if (activePlan) {
        activePlan = this.planService.markFailed(activePlan, message);
        this.emitPlan('plan.failed', activePlan, message);
      }
      this.runState.finish(runId, { status: 'failed', summary: message });
      this.eventBus.emit('run.failed', { summary: message, details: message });
      return { ok: false, runId, status: 'failed', error: message };
    }
  }

  private emitPlan(type: 'plan.created' | 'plan.updated' | 'plan.completed' | 'plan.failed', plan: AgentPlan, reason?: string) {
    this.eventBus.emit(type, this.toPlanPayload(plan, reason));
  }

  private toPlanPayload(plan: AgentPlan, reason?: string): PlanUpdatedPayload {
    return {
      plan,
      reason,
      steps: plan.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status
      }))
    };
  }

  private async buildKnowledgeContext(prompt: string) {
    try {
      const results = await this.knowledgeService.search({ scope: 'system', query: prompt, limit: 3 });
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


  stopRun(runId?: string) {
    return { ok: this.runState.stop(runId) };
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
    if (entry.message.includes('prepare Pi managers')) return '准备 Pi session 管理器和资源加载器';
    if (entry.message.includes('create AgentSession')) return '创建 Pi AgentSession，并注入 OpenAgent tools';
    if (entry.message.includes('prompt session')) return '提交用户请求到 AgentSession';
    const requestMatch = entry.message.match(/LLM loop #(\d+) request started/);
    if (requestMatch) return `第 ${requestMatch[1]} 轮 agent loop：发送模型请求`;
    const replyMatch = entry.message.match(/LLM loop #(\d+) reply completed/);
    if (replyMatch) return `第 ${replyMatch[1]} 轮 agent loop：处理模型回复`;
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

function formatPlanApprovalDescription(plan: AgentPlan) {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.title}${step.requiresApproval ? '（需要审批）' : ''}`).join('\n');
  return [
    `目标：${plan.goal}`,
    `风险等级：${plan.riskLevel}`,
    plan.approvalReason || '请确认是否执行该 Agent Plan。',
    '',
    '计划步骤：',
    steps
  ].join('\n');
}

function createDefaultAdapter() {
  if (process.env.OPENAGENT_RUNTIME_ENGINE === 'local-demo') {
    return new LocalDemoAgentLoop();
  }
  if (process.env.OPENAGENT_RUNTIME_ENGINE === 'pi') {
    return new PiRuntimeAdapter();
  }
  return new PiRuntimeAdapter();
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
