import { randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter, PromptSubmissionInput, RuntimeLogEntry, RuntimeMessage, RuntimeServiceOptions, RuntimeSnapshot, RuntimeThread } from './runtime-types.js';
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
import { ApprovalService, type RuntimeApprovalRequest } from './approval-service.js';
import { KnowledgeService } from './knowledge/knowledge-service.js';
import { createKnowledgeTools } from './knowledge/knowledge-tools.js';

export class RuntimeService {
  private activeThreadId = 'thread-welcome';
  private readonly createdAt = new Date().toISOString();
  private readonly eventBus: RuntimeEventBus;
  private readonly approvalService = new ApprovalService();
  private readonly runState = new RunStateStore();
  private readonly sessionStore: SessionStore;
  private readonly soulManager: SoulManager;
  private readonly knowledgeService: KnowledgeService;
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
    this.soulManager = new SoulManager({
      agentId: options.agentId,
      workspaceRoot: options.workspaceRoot,
      providerId: options.providerId,
      model: options.model,
      createdAt: this.createdAt
    });
    this.toolRegistry = createDefaultToolRegistry(options.workspaceRoot);
    this.subagents = new SubagentService();
    for (const tool of createKnowledgeTools(this.knowledgeService)) {
      this.toolRegistry.register(tool);
    }
    this.toolRegistry.register(createShellAgentTool(this.subagents, options.workspaceRoot));

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
      if (result.request.runId) {
        this.runState.update(result.request.runId, {
          status: result.decision === 'approved' ? 'running' : 'failed',
          summary: result.decision === 'approved' ? '审批已通过，继续执行。' : '用户拒绝了外部路径访问。'
        });
      }
      this.eventBus.emit('approval.resolved', {
        approvalId,
        decision: result.decision,
        summary: result.decision === 'approved' ? '外部路径访问已批准，agent 将继续执行。' : '外部路径访问已拒绝。'
      });
    }
    return result;
  }

  private async requestToolApproval(request: RuntimeApprovalRequest) {
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

  querySystemWiki(input: { query?: string; limit?: number }) {
    return this.knowledgeService.search({
      scope: 'system',
      query: String(input.query || ''),
      limit: input.limit
    });
  }

  ingestSystemWiki(input: { title?: string; content?: string; sourceId?: string; tags?: string[] }) {
    return this.knowledgeService.ingest({
      scope: 'system',
      title: String(input.title || ''),
      content: String(input.content || ''),
      sourceId: input.sourceId,
      tags: Array.isArray(input.tags) ? input.tags : undefined
    });
  }

  lintSystemWiki() {
    return this.knowledgeService.lintSystemWiki();
  }

  buildSystemWikiGraph() {
    return this.knowledgeService.buildSystemWikiGraph();
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
    const prompt = payload.prompt?.trim();
    if (!prompt) {
      throw new PromptValidationError('Prompt cannot be empty');
    }

    const runId = `run-${randomUUID()}`;
    const now = new Date().toISOString();
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
      attachments: payload.attachments ?? []
    };
    this.messages.push(userMessage);
    this.touchThreadForPrompt(thread, prompt, now);

    const sessionFile = this.sessionStore.getSessionFile(thread.threadId);
    const transcript = new TranscriptStore(sessionFile);
    transcript.appendMessage(userMessage);

    this.eventBus.emit('run.started', { runId, threadId: thread.threadId });
    this.eventBus.emit('plan.updated', {
      steps: [
        { id: `${runId}-context`, title: '构建运行上下文', status: 'completed' },
        { id: `${runId}-loop`, title: '执行 agent loop', status: 'in_progress' },
        { id: `${runId}-persist`, title: '保存 transcript', status: 'pending' }
      ]
    });

    const runPromise = this.executePromptRun({
      prompt,
      runId,
      thread,
      transcript,
      sessionFile,
      abortSignal: controller.signal
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
  }) {
    const { prompt, runId, thread, transcript, sessionFile, abortSignal } = input;
    const loopSteps: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }> = [
      { id: `${runId}-context`, title: '构建运行上下文', status: 'completed' },
      { id: `${runId}-loop-start`, title: '启动 agent loop', status: 'in_progress' },
      { id: `${runId}-persist`, title: '保存 transcript', status: 'pending' }
    ];
    const emitPlan = () => this.eventBus.emit('plan.updated', { steps: loopSteps });
    const appendProgressStep = (title: string, status: 'in_progress' | 'completed' = 'in_progress') => {
      for (const step of loopSteps) {
        if (step.status === 'in_progress') step.status = 'completed';
      }
      const persistStep = loopSteps.at(-1);
      if (persistStep?.id === `${runId}-persist`) loopSteps.pop();
      loopSteps.push({ id: `${runId}-step-${loopSteps.length}`, title, status });
      loopSteps.push({ id: `${runId}-persist`, title: '保存 transcript', status: 'pending' });
      emitPlan();
    };

    try {
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
      runInput.systemPrompt = [
        runInput.systemPrompt,
        '',
        'Agent long-term identity from SOUL.md:',
        bootstrap.soul,
        '',
        'User long-term preferences from USER.md:',
        bootstrap.user,
        '',
        'Relevant long-term memory from MEMORY.md:',
        bootstrap.memory,
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
        '{"soulChangeRequests":[],"userUpdates":[],"memoryUpdates":[]}',
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
        '- memoryUpdates object schema: shouldUpdateMemory, scope, topic, summary, reuse, confidence, evidence. confidence must be medium or high.'
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
        for (const step of loopSteps) step.status = 'completed';
        emitPlan();
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
        const appliedAutoMemoryUpdates = [...appliedUserUpdates, ...appliedMemoryUpdates];
        if (appliedSoulUpdates.length > 0 || appliedAutoMemoryUpdates.length > 0) {
          const memorySummaryParts = [
            appliedSoulUpdates.length > 0 ? `SOUL.md ${appliedSoulUpdates.length} 条` : '',
            appliedUserUpdates.length > 0 ? `USER.md ${appliedUserUpdates.length} 条` : '',
            appliedMemoryUpdates.length > 0 ? `MEMORY.md ${appliedMemoryUpdates.length} 条` : ''
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
              }))
            }
          });
          this.eventBus.emit('memory.updated', {
            snapshot: this.getAgentBootstrapSnapshot(),
            soulUpdates: appliedSoulUpdates,
            userUpdates: appliedUserUpdates,
            memoryUpdates: appliedMemoryUpdates,
            summary: memorySummary
          });
        }
        this.eventBus.emit('run.completed', { runId, summary });
        return { ok: true, runId, status: 'completed' };
      }

      if (result.status === 'cancelled') {
        this.runState.finish(runId, { status: 'cancelled', summary });
        this.eventBus.emit('run.cancelled', { runId, summary });
        return { ok: false, runId, status: 'cancelled', error: summary };
      }

      this.runState.finish(runId, { status: 'failed', summary });
      this.eventBus.emit('run.failed', { summary, details: result.error });
      return { ok: false, runId, status: 'failed', error: summary };
    } catch (error) {
      const message = errorToMessage(error);
      this.runState.finish(runId, { status: 'failed', summary: message });
      this.eventBus.emit('run.failed', { summary: message, details: message });
      return { ok: false, runId, status: 'failed', error: message };
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
