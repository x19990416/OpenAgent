import { randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter, PromptSubmissionInput, RuntimeApprovalRequest, RuntimeAttachment, RuntimeMessage, RuntimeServiceOptions, RuntimeSnapshot, RuntimeThread } from '@openagent/runtime';
import { RuntimeEventBus } from '@openagent/runtime';
import { RunStateStore } from '@openagent/runtime';
import { SessionStore } from '@openagent/runtime';
import { TranscriptStore } from '@openagent/runtime';
import { createDefaultToolRegistry } from '@openagent/runtime';
import { PromptValidationError, errorToMessage } from '@openagent/runtime';
import { summarizeRunResult } from '@openagent/runtime';
import { appendLlmResponseLog, appendRuntimeInfoLog } from '@openagent/runtime';
import { sortThreadsForDisplay } from '@openagent/runtime';
import { SoulManager } from './memory/soul-manager.js';
import { SubagentService, createShellAgentTool, createKnowledgeAgentTool, createPiCodingAgentTool } from '@openagent/subagents';
import { KnowledgeContextRouter, KnowledgeService, configureKnowledgeLoggerHooks, createKnowledgeTools } from '@openagent/knowledge';
import { formatPlanApprovalDescription, shouldContinueProgressOnlyReply, shouldRetryPlanToolExecution, type AgentPlan } from '@openagent/planning';
import { SkillService } from '@openagent/skill-runtime';
import { createDesktopRuntimeHost, type DesktopRuntimeHost } from './runtime-host.js';
import { RuntimeThreadController } from './runtime-thread-controller.js';
import { RuntimeKnowledgeController } from './runtime-knowledge-controller.js';
import { RuntimeAttachmentController } from './runtime-attachment-controller.js';
import { RuntimeCompactionController } from './runtime-compaction-controller.js';
import { RuntimeApprovalController } from './runtime-approval-controller.js';
import { RuntimePlanController } from './runtime-plan-controller.js';
import { RuntimeProgressController } from './runtime-progress-controller.js';
import { MAX_PROGRESS_CONTINUATION_ATTEMPTS, RuntimeAgentLoopController } from './runtime-agent-loop-controller.js';
import { RuntimeRunInputBuilder } from './runtime-run-input-builder.js';
import { RuntimeContextUpdateController } from './runtime-context-update-controller.js';

configureKnowledgeLoggerHooks({ appendLlmResponseLog });

export class RuntimeService {
  private readonly createdAt = new Date().toISOString();
  private readonly eventBus: RuntimeEventBus;
  private readonly runState = new RunStateStore();
  private readonly sessionStore: SessionStore;
  private readonly soulManager: SoulManager;
  private readonly knowledgeService: KnowledgeService;
  private readonly knowledgeContextRouter: KnowledgeContextRouter;
  private readonly knowledgeController: RuntimeKnowledgeController;
  private readonly planController: RuntimePlanController;
  private readonly skillService: SkillService;
  private readonly toolRegistry: ReturnType<typeof createDefaultToolRegistry>;
  private readonly subagents: SubagentService;
  private readonly adapter: AgentRuntimeAdapter;
  private readonly threadController: RuntimeThreadController;
  private readonly attachmentController: RuntimeAttachmentController;
  private readonly compactionController: RuntimeCompactionController;
  private readonly approvalController: RuntimeApprovalController;
  private readonly agentLoopController: RuntimeAgentLoopController;
  private readonly runInputBuilder: RuntimeRunInputBuilder;
  private readonly contextUpdateController: RuntimeContextUpdateController;

  constructor(
    private options: RuntimeServiceOptions,
    adapter?: AgentRuntimeAdapter,
    private readonly host: DesktopRuntimeHost = createDesktopRuntimeHost()
  ) {
    this.adapter = adapter ?? this.host.createDefaultAdapter();
    this.eventBus = new RuntimeEventBus(options.emitUiEvent);
    this.sessionStore = new SessionStore(options.agentId);
    this.knowledgeService = new KnowledgeService(options.agentId);
    this.knowledgeContextRouter = new KnowledgeContextRouter();
    this.knowledgeController = new RuntimeKnowledgeController(this.knowledgeService, this.knowledgeContextRouter);
    this.planController = new RuntimePlanController(options.agentId, this.eventBus);
    this.skillService = new SkillService({ agentId: options.agentId, workspaceRoot: options.workspaceRoot, appRoot: options.appRoot });
    this.soulManager = new SoulManager({
      agentId: options.agentId,
      workspaceRoot: options.workspaceRoot,
      providerId: options.providerId,
      model: options.model,
      createdAt: this.createdAt
    });
    this.toolRegistry = createDefaultToolRegistry(options.workspaceRoot);
    this.subagents = new SubagentService(this.knowledgeService, { piCodingAgent: { createRuntimeAdapter: () => this.host.createPiRuntimeAdapter() } });
    for (const tool of createKnowledgeTools(this.knowledgeService)) {
      this.toolRegistry.register(tool);
    }
    for (const tool of this.skillService.createTools()) {
      this.toolRegistry.register(tool);
    }
    this.toolRegistry.register(createShellAgentTool(this.subagents, options.workspaceRoot));
    this.toolRegistry.register(createKnowledgeAgentTool(this.subagents, options.workspaceRoot));
    this.toolRegistry.register(createPiCodingAgentTool(this.subagents));

    this.threadController = new RuntimeThreadController(options, this.sessionStore, this.createdAt);
    this.attachmentController = new RuntimeAttachmentController(options.agentId);
    this.compactionController = new RuntimeCompactionController(
      this.options,
      this.adapter,
      this.sessionStore,
      this.eventBus,
      (threadId) => this.threadController.getThread(threadId)
    );
    this.approvalController = new RuntimeApprovalController(this.runState, this.eventBus, this.host);
    this.agentLoopController = new RuntimeAgentLoopController(this.adapter, this.eventBus);
    this.runInputBuilder = new RuntimeRunInputBuilder(
      () => this.options,
      this.eventBus,
      this.runState,
      this.toolRegistry,
      this.skillService,
      this.soulManager,
      this.knowledgeController,
      this.approvalController,
      () => this.syncPluginSkills()
    );
    this.contextUpdateController = new RuntimeContextUpdateController(
      this.soulManager,
      this.knowledgeService,
      this.runState,
      this.eventBus,
      this.approvalController,
      () => this.getAgentBootstrapSnapshot()
    );
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

    return this.approvalController.resolveRuntimeApproval({ approvalId, decision, scope });
  }

  private async requestToolApproval(request: Omit<RuntimeApprovalRequest, 'id'> & { id?: string }) {
    return this.approvalController.requestToolApproval(request);
  }

  autoApprovePendingApprovals(reason = 'settings') {
    return this.approvalController.autoApprovePendingApprovals(reason);
  }

  getSnapshot(): RuntimeSnapshot {
    const latestRun = this.runState.getLatest();
    return {
      activeAgentId: this.options.agentId,
      latestRun: latestRun ? { status: latestRun.status, summary: latestRun.summary } : { status: 'completed', summary: 'OpenAgent runtime 已就绪。' },
      pendingApproval: this.approvalController.getPendingApproval(),
      threads: sortThreadsForDisplay(this.threadController.listThreads()),
      recentRuns: this.runState.list(),
      messages: this.threadController.messages,
      activeThread: { threadId: this.threadController.activeThreadId }
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
    return this.knowledgeController.getHealth(scope);
  }

  queryKnowledge(input: { query?: string; limit?: number }) {
    return this.knowledgeController.query(input);
  }

  ingestKnowledge(input: { title?: string; content?: string; sourceId?: string; tags?: string[] }) {
    return this.knowledgeController.ingest(input);
  }

  ingestKnowledgeFiles(files: Array<{ filePath?: string; title?: string; sourceId?: string; tags?: string[] }>) {
    return this.knowledgeController.ingestFiles(files);
  }

  lintKnowledge() {
    return this.knowledgeController.lint();
  }

  buildKnowledgeGraph() {
    return this.knowledgeController.buildGraph();
  }

  browseKnowledge() {
    return this.knowledgeController.browse();
  }

  readKnowledgeArticle(input: { articleId?: string }) {
    return this.knowledgeController.readArticle(input);
  }

  compileKnowledge(input: { sourceIds?: string[]; limit?: number; tier?: 0 | 1 | 2 | 3 }) {
    return this.knowledgeController.compile(input);
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
    const attachments = this.attachmentController.materializePromptAttachments({
      attachments: payload.attachments ?? [],
      runId,
      threadId: this.threadController.activeThreadId
    });
    this.syncPluginSkills();
    const selectedSkill = this.resolveSelectedSkill(payload.skillId ?? null);
    const thread = this.threadController.getActiveThread();
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
    this.threadController.messages.push(userMessage);
    this.threadController.touchThreadForPrompt(thread, prompt, now);

    const sessionFile = this.sessionStore.getSessionFile(thread.threadId);
    const transcript = new TranscriptStore(sessionFile);
    transcript.appendMessage(userMessage);

    const draftPlan = await this.planController.createDraftPlan({
      runId,
      threadId: thread.threadId,
      agentId: this.options.agentId,
      prompt,
      now
    });

    this.eventBus.emit('run.started', { runId, threadId: thread.threadId });
    if (draftPlan) {
      this.planController.emit('plan.created', draftPlan, draftPlan.approvalRequired ? 'Agent Plan Mode 已生成待确认计划。' : 'Agent Plan Mode 已生成自动执行计划。');
      this.planController.emit('plan.updated', draftPlan, draftPlan.approvalRequired ? '等待用户确认计划。' : 'LLM classifier 判定无需人工确认，将自动执行计划。');
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
    let planExecutor: ReturnType<RuntimePlanController['createExecutor']> | null = null;
    const startedAt = Date.now();
    const progressController = new RuntimeProgressController(runId, this.eventBus, () => Boolean(activePlan));

    try {
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'executePromptRun entered',
        data: { runId, threadId: thread.threadId, elapsedMs: Date.now() - startedAt, hasPlan: Boolean(activePlan) }
      });
      if (activePlan) {
        if (activePlan.approvalRequired) {
          this.runState.update(runId, { status: 'waiting_approval', summary: '等待用户确认 Agent Plan。' });
          this.planController.emitApprovalRequired(activePlan, '请确认是否按该计划执行。');
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
            activePlan = this.planController.reject(activePlan);
            this.planController.emit('plan.failed', activePlan, '用户取消了 Agent Plan。');
            this.runState.finish(runId, { status: 'cancelled', summary: '用户取消了 Agent Plan。' });
            this.eventBus.emit('run.cancelled', { runId, summary: '用户取消了 Agent Plan。' });
            return { ok: false, runId, status: 'cancelled', error: '用户取消了 Agent Plan。' };
          }
        }
        activePlan = this.planController.approve(activePlan);
        planExecutor = this.planController.createExecutor(activePlan, (nextPlan, reason, changedStepId) => {
          activePlan = nextPlan;
          this.planController.emit('plan.updated', nextPlan, reason, changedStepId);
        });
        this.runState.update(runId, { status: 'running', summary: activePlan.approvalRequired ? 'Agent Plan 已确认，开始执行。' : 'Agent Plan 自动进入执行。' });
        if (activePlan.approvalRequired) {
          this.planController.emitApprovalResolved(activePlan, '用户已确认 Agent Plan。');
        }
        this.planController.emit('plan.updated', activePlan, activePlan.approvalRequired ? '用户已确认计划，开始执行。' : 'LLM classifier 判定无需人工确认，自动执行计划。');
      }

      const runInput = await this.runInputBuilder.build({
        prompt,
        runId,
        thread,
        transcript,
        sessionFile,
        abortSignal,
        attachments,
        selectedSkillId: input.selectedSkillId ?? null,
        getActivePlan: () => activePlan,
        progressController,
        startedAt
      });
      planExecutor?.completeAndStart(
        'plan-step-inspect',
        '已完成运行上下文、长期记忆和知识库上下文检查。',
        'plan-step-design',
        '正在固化本轮执行约束与计划步骤。'
      );

      planExecutor?.completeAndStartFirstKind(
        'plan-step-design',
        '已将 active plan 注入本轮系统提示词并确认执行约束。',
        'execute',
        '正在进入 agent loop 执行计划主体。'
      );
      progressController.append('调用模型并等待 agent loop 返回');
      const result = await this.agentLoopController.runWithRetries({
        runInput,
        prompt,
        activePlan,
        onPlanRetry: (reason) => {
          if (activePlan) this.planController.emit('plan.updated', activePlan, reason);
        }
      });
      if (abortSignal.aborted) {
        const summary = '运行已停止。';
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
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
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
        }
        this.emitFailureAssistantMessage(thread, transcript, summary);
        this.runState.finish(runId, { status: 'failed', summary });
        this.eventBus.emit('run.failed', { summary, details: summary });
        return { ok: false, runId, status: 'failed', error: summary };
      }

      if (shouldRetryPlanToolExecution(activePlan, result)) {
        summary = '计划执行未完成：模型没有发起计划要求的 OpenAgent 工具调用。请重试，或让模型改用明确的工具调用完成任务。';
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
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
        const { metadata, cleanContent } = this.contextUpdateController.extractAssistantMessage({ content: result.assistantMessage.content });
        const assistantMessage = {
          ...result.assistantMessage,
          content: cleanContent
        };
        summary = assistantMessage.content || summary;
        this.threadController.messages.push(assistantMessage);
        transcript.appendMessage(assistantMessage);
        const finalTranscriptStats = transcript.getStats();
        this.compactionController.maybeAutoCompactThread({ threadId: thread.threadId, transcriptMessageCount: finalTranscriptStats.messageCount, runId });
        this.eventBus.emit('message.completed', assistantMessage);
        if (activePlan) {
          planExecutor?.completeKindAndStartFirstKind(
            'execute',
            'agent loop 已返回最终助手消息。',
            'finalize',
            '正在保存 transcript、处理结构化元数据并收尾。'
          );
        } else {
          progressController.completeAll();
        }
        this.threadController.finishThread(thread, prompt);
        this.runState.finish(runId, { status: 'completed', summary });
        await this.contextUpdateController.applyMetadata({
          metadata,
          prompt,
          runId,
          threadId: thread.threadId,
          runInput
        });
        if (activePlan) {
          planExecutor?.completeKind('finalize', 'transcript、长期上下文候选和最终状态处理完成。');
          activePlan = this.planController.markCompleted(planExecutor?.currentPlan ?? activePlan, summary);
          this.planController.emit('plan.completed', activePlan, 'Agent Plan 执行完成。');
          this.planController.emit('plan.updated', activePlan, 'Agent Plan 执行完成。');
        }
        this.eventBus.emit('run.completed', { runId, summary });
        return { ok: true, runId, status: 'completed' };
      }

      if (result.status === 'cancelled') {
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
        }
        this.runState.finish(runId, { status: 'cancelled', summary });
        this.eventBus.emit('run.cancelled', { runId, summary });
        return { ok: false, runId, status: 'cancelled', error: summary };
      }

      if (activePlan) {
        activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
        this.planController.emit('plan.failed', activePlan, summary);
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
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
        }
        this.runState.finish(runId, { status: 'cancelled', summary });
        this.eventBus.emit('run.cancelled', { runId, summary });
        return { ok: false, runId, status: 'cancelled', error: summary };
      }
      if (activePlan) {
        activePlan = planExecutor?.failCurrent(message) ?? this.planController.markFailed(activePlan, message);
        this.planController.emit('plan.failed', activePlan, message);
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
    this.threadController.messages.push(assistantMessage);
    transcript.appendMessage(assistantMessage);
    this.threadController.finishThread(thread, content);
    this.eventBus.emit('message.completed', assistantMessage);
  }


  async compactThread(threadId = this.threadController.activeThreadId) {
    return this.compactionController.compactThread(threadId);
  }

  stopRun(runId?: string) {
    const stoppedRunIds = this.runState.stop(runId);
    const rejectedApprovals = this.approvalController.rejectPendingForRun(runId);
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
    const result = this.threadController.createThread(input);
    return { ...result, snapshot: this.getSnapshot() };
  }

  selectThread(threadId: string) {
    const result = this.threadController.selectThread(threadId);
    return { ...result, snapshot: this.getSnapshot() };
  }

  markThreadTitlePrefix(threadId: string, prefix: string) {
    const result = this.threadController.markThreadTitlePrefix(threadId, prefix);
    return { ...result, snapshot: this.getSnapshot() };
  }

  deleteThread(threadId: string) {
    const result = this.threadController.deleteThread(threadId);
    return { ...result, snapshot: this.getSnapshot() };
  }

}
