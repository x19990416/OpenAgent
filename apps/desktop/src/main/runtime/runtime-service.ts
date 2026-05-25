import { randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter, PromptSubmissionInput, RuntimeMessage, RuntimeServiceOptions, RuntimeSnapshot } from '@openagent/runtime';
import { RuntimeEventBus } from '@openagent/runtime';
import { RunStateStore } from '@openagent/runtime';
import { SessionStore } from '@openagent/runtime';
import { TranscriptStore } from '@openagent/runtime';
import { createDefaultToolRegistry } from '@openagent/runtime';
import { PromptValidationError } from '@openagent/runtime';
import { appendLlmResponseLog } from '@openagent/runtime';
import { sortThreadsForDisplay } from '@openagent/runtime';
import { SoulManager } from './memory/soul-manager.js';
import { SubagentService, createShellAgentTool, createKnowledgeAgentTool, createPiCodingAgentTool } from '@openagent/subagents';
import { KnowledgeContextRouter, KnowledgeService, configureKnowledgeLoggerHooks, createKnowledgeTools } from '@openagent/knowledge';
import { SkillService } from '@openagent/skill-runtime';
import { createDesktopRuntimeHost, type DesktopRuntimeHost } from './runtime-host.js';
import { RuntimeThreadController } from './runtime-thread-controller.js';
import { RuntimeKnowledgeController } from './runtime-knowledge-controller.js';
import { RuntimeAttachmentController } from './runtime-attachment-controller.js';
import { RuntimeCompactionController } from './runtime-compaction-controller.js';
import { RuntimeApprovalController } from './runtime-approval-controller.js';
import { RuntimePlanController } from './runtime-plan-controller.js';
import { RuntimeAgentLoopController } from './runtime-agent-loop-controller.js';
import { RuntimeRunInputBuilder } from './runtime-run-input-builder.js';
import { RuntimeContextUpdateController } from './runtime-context-update-controller.js';
import { RuntimeRunFinalizer } from './runtime-run-finalizer.js';
import { RuntimePromptRunExecutor } from './runtime-prompt-run-executor.js';

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
  private readonly runFinalizer: RuntimeRunFinalizer;
  private readonly promptRunExecutor: RuntimePromptRunExecutor;

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
    this.runFinalizer = new RuntimeRunFinalizer(this.runState, this.eventBus, this.threadController, this.approvalController);
    this.promptRunExecutor = new RuntimePromptRunExecutor(
      this.runState,
      this.eventBus,
      this.planController,
      this.approvalController,
      this.runInputBuilder,
      this.agentLoopController,
      this.contextUpdateController,
      this.compactionController,
      this.threadController,
      this.runFinalizer
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

    const runPromise = this.promptRunExecutor.executePromptRun({
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



  async compactThread(threadId = this.threadController.activeThreadId) {
    return this.compactionController.compactThread(threadId);
  }

  stopRun(runId?: string) {
    return this.runFinalizer.stopRun(runId);
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
