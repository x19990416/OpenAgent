import { randomUUID } from 'node:crypto';
import path from 'node:path';
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

export class RuntimeService {
  private activeThreadId = 'thread-welcome';
  private readonly createdAt = new Date().toISOString();
  private readonly eventBus: RuntimeEventBus;
  private readonly runState = new RunStateStore();
  private readonly sessionStore: SessionStore;
  private readonly soulManager: SoulManager;
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
    this.soulManager = new SoulManager({
      agentId: options.agentId,
      workspaceRoot: options.workspaceRoot,
      providerId: options.providerId,
      model: options.model,
      createdAt: this.createdAt
    });
    this.toolRegistry = createDefaultToolRegistry(options.workspaceRoot);
    this.subagents = new SubagentService();
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

    return { ok: false, error: `Unknown approval: ${approvalId}` };
  }

  getSnapshot(): RuntimeSnapshot {
    const latestRun = this.runState.getLatest();
    return {
      activeAgentId: this.options.agentId,
      latestRun: latestRun ? { status: latestRun.status, summary: latestRun.summary } : { status: 'completed', summary: 'OpenAgent runtime 已就绪。' },
      pendingApproval: null,
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

    void this.executePromptRun({
      prompt,
      runId,
      thread,
      transcript,
      sessionFile,
      abortSignal: controller.signal
    });

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

    const builtinResult = await this.tryHandleBuiltinMarkdownCountPrompt({
      prompt,
      runId,
      thread,
      transcript,
      sessionFile,
      abortSignal
    });
    if (builtinResult) {
      return builtinResult;
    }

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
          this.eventBus.emit(type, payload);
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
        '{"soulChangeRequests":[]}',
        '-->',
        '- If the user asks for a durable Agent identity, role, behavior, safety, tool, memory, or project-specific rule change, add one object to soulChangeRequests.',
        '- Do not add soulChangeRequests for one-off or session-only instructions.',
        '- Every SOUL request must set requiresApproval to true.',
        '- Object schema: shouldUpdateSoul, updateKind, title, reason, proposedText, targetSection, confidence, requiresApproval, evidence.',
        '- confidence must be the string "low", "medium", or "high"; do not use numbers.',
        '- targetSection should be one of the exact SOUL headings, such as "## 1. Identity" or "## 7. Managed Rules".',
        '- updateKind must be one of: identity, working_style, safety_boundary, tool_policy, memory_policy, project_specific_rule.',
        '- Identity questions such as “你叫啥” or “你是谁” are not SOUL changes by themselves; only create a request when the user assigns or changes a durable identity.'
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
        if (appliedSoulUpdates.length === 0) {
          const fallbackRequest = this.soulManager.detectSoulChangeRequestFromPrompt({
            prompt,
            runId,
            threadId: thread.threadId
          });
          if (fallbackRequest) {
            const applied = this.soulManager.applySoulChangeRequest(fallbackRequest, {
              kind: 'runtime_detection',
              runId,
              threadId: thread.threadId,
              excerpt: fallbackRequest.evidence || prompt.slice(0, 500)
            });
            if (applied) appliedSoulUpdates.push(applied);
          }
        }
        if (appliedSoulUpdates.length > 0) {
          runInput.onLog?.({
            scope: 'runtime',
            message: '检测到 SOUL.md 变更并已直接应用',
            data: {
              source: metadata.soulChangeRequests.length > 0 ? 'llm-structured-metadata' : 'fallback-detector',
              updates: appliedSoulUpdates.map((update) => ({
                updateId: update.id,
                title: update.title,
                proposedText: update.proposedText
              }))
            }
          });
          this.eventBus.emit('memory.updated', {
            snapshot: this.getAgentBootstrapSnapshot(),
            soulUpdates: appliedSoulUpdates,
            summary: '检测到 SOUL.md 变更并已直接应用。'
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

  private async tryHandleBuiltinMarkdownCountPrompt(input: {
    prompt: string;
    runId: string;
    thread: RuntimeThread;
    transcript: TranscriptStore;
    sessionFile: string;
    abortSignal: AbortSignal;
  }) {
    const targetRoot = this.resolveMarkdownCountTarget(input.prompt);
    if (!targetRoot) return null;

    this.eventBus.emit('plan.updated', {
      steps: [
        { id: `${input.runId}-context`, title: '识别只读文件统计任务', status: 'completed' },
        { id: `${input.runId}-shell-agent`, title: `调用系统 ShellAgent 统计 ${targetRoot}`, status: 'in_progress' },
        { id: `${input.runId}-persist`, title: '保存 transcript', status: 'pending' }
      ]
    });
    this.eventBus.emit('terminal.delta', {
      runId: input.runId,
      text: `开始调用系统 ShellAgent 统计 ${targetRoot} 下的 .md 文件数量…
`
    });

    try {
      const result = await this.subagents.invoke('shell', {
        task: input.prompt,
        callerAgentId: this.options.agentId,
        runId: input.runId,
        threadId: input.thread.threadId,
        workspaceRoot: this.options.workspaceRoot,
        signal: input.abortSignal,
        onLog: (entry) => {
          appendRuntimeInfoLog(entry);
          this.eventBus.emit('terminal.delta', {
            runId: input.runId,
            text: formatRuntimeInfoLogSummary(entry)
          });
        },
        emitUiEvent: (type, payload) => this.eventBus.emit(type, payload)
      });
      const content = result.summary;
      const assistantMessage: RuntimeMessage = {
        id: `assistant-${randomUUID()}`,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString()
      };
      this.messages.push(assistantMessage);
      input.transcript.appendMessage(assistantMessage);
      this.eventBus.emit('message.completed', assistantMessage);
      this.eventBus.emit('plan.updated', {
        steps: [
          { id: `${input.runId}-context`, title: '识别只读文件统计任务', status: 'completed' },
          { id: `${input.runId}-shell-agent`, title: `系统 ShellAgent 完成 ${targetRoot} 统计`, status: 'completed' },
          { id: `${input.runId}-persist`, title: '保存 transcript', status: 'completed' }
        ]
      });
      this.finishThread(input.thread, input.prompt);
      this.runState.finish(input.runId, { status: result.ok ? 'completed' : 'failed', summary: content });
      this.eventBus.emit(result.ok ? 'run.completed' : 'run.failed', result.ok ? { runId: input.runId, summary: content } : { summary: content, details: result.error });
      return { ok: result.ok, runId: input.runId, status: result.ok ? 'completed' : 'failed', error: result.error };
    } catch (error) {
      const message = errorToMessage(error);
      this.runState.finish(input.runId, { status: 'failed', summary: message });
      this.eventBus.emit('run.failed', { summary: message, details: message });
      return { ok: false, runId: input.runId, status: 'failed', error: message };
    }
  }

  private resolveMarkdownCountTarget(prompt: string) {
    const sourcePrompt = /^\s*(执行|开始|开始执行|确认执行|继续)\s*$/i.test(prompt)
      ? this.findPreviousMarkdownCountPrompt()
      : prompt;
    if (!sourcePrompt) return null;
    if (!/(\.md|markdown|md\s*文件)/i.test(sourcePrompt) || !/(统计|多少|数量|count)/i.test(sourcePrompt)) return null;

    const usersPathMatch = sourcePrompt.match(/(\/Users(?:\/[^\s，。；;]*)?)/);
    if (usersPathMatch?.[1]) {
      return path.resolve(usersPathMatch[1]);
    }

    const absolutePathMatch = sourcePrompt.match(/(\/[^\s，。；;]+)/);
    if (absolutePathMatch?.[1]) {
      return path.resolve(absolutePathMatch[1]);
    }

    return null;
  }

  private findPreviousMarkdownCountPrompt() {
    for (let index = this.messages.length - 2; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.role === 'user' && /(\.md|markdown|md\s*文件)/i.test(message.content) && /(统计|多少|数量|count)/i.test(message.content)) {
        return message.content;
      }
    }
    return null;
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
    const aIsNew = isNewBlankThread(a);
    const bIsNew = isNewBlankThread(b);
    if (aIsNew !== bIsNew) return aIsNew ? -1 : 1;

    const aTime = Date.parse(aIsNew ? a.createdAt : a.updatedAt);
    const bTime = Date.parse(bIsNew ? b.createdAt : b.updatedAt);
    return normalizeTime(bTime) - normalizeTime(aTime);
  });
}

function isNewBlankThread(thread: RuntimeThread) {
  return thread.runCount === 0 && thread.title === '新的会话';
}

function normalizeTime(value: number) {
  return Number.isFinite(value) ? value : 0;
}
