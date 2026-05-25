import { randomUUID } from 'node:crypto';
import type { RuntimeMessage, RuntimeServiceOptions, RuntimeThread } from '@openagent/runtime';
import { SessionStore, TranscriptStore } from '@openagent/runtime';

export class RuntimeThreadController {
  activeThreadId = 'thread-welcome';
  readonly messages: RuntimeMessage[] = [];
  private readonly threads = new Map<string, RuntimeThread>();

  constructor(
    private readonly options: RuntimeServiceOptions,
    private readonly sessionStore: SessionStore,
    private readonly createdAt: string
  ) {
    this.restoreOrCreateWelcomeThread();
  }

  listThreads() {
    return [...this.threads.values()];
  }

  getThread(threadId: string) {
    return this.threads.get(threadId);
  }

  getActiveThread() {
    const thread = this.threads.get(this.activeThreadId);
    if (!thread) {
      const fallback = this.createThreadRecord({
        threadId: this.activeThreadId,
        title: '新的会话',
        createdAt: new Date().toISOString()
      });
      this.threads.set(fallback.threadId, fallback);
      return fallback;
    }
    return thread;
  }

  createThread(input?: { agentId?: string; title?: string }) {
    const threadId = `thread-${randomUUID()}`;
    const thread = this.createThreadRecord({
      threadId,
      title: input?.title || '新的会话',
      createdAt: new Date().toISOString(),
      agentId: input?.agentId
    });
    this.threads.set(threadId, thread);
    this.sessionStore.upsertThread(thread);
    this.activeThreadId = threadId;
    this.messages.length = 0;
    return { ok: true as const, threadId };
  }

  selectThread(threadId: string) {
    if (!this.threads.has(threadId)) {
      return { ok: false as const, error: `Thread not found: ${threadId}` };
    }
    this.activeThreadId = threadId;
    this.loadActiveThreadMessages();
    return { ok: true as const };
  }

  markThreadTitlePrefix(threadId: string, prefix: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return { ok: false as const, error: `Thread not found: ${threadId}` };
    }
    if (!thread.title.startsWith(prefix)) {
      thread.title = `${prefix}${thread.title}`;
      thread.updatedAt = new Date().toISOString();
      this.sessionStore.upsertThread(thread);
    }
    return { ok: true as const };
  }

  deleteThread(threadId: string) {
    this.threads.delete(threadId);
    this.sessionStore.removeThread(threadId);
    if (this.activeThreadId === threadId) {
      this.activeThreadId = this.threads.keys().next().value ?? 'thread-welcome';
      this.loadActiveThreadMessages();
    }
    return { ok: true as const };
  }

  touchThreadForPrompt(thread: RuntimeThread, prompt: string, timestamp: string) {
    thread.updatedAt = timestamp;
    if (thread.title === '新的会话' || thread.title === '欢迎使用 OpenAgent') {
      thread.title = prompt.slice(0, 28) || thread.title;
    }
    this.sessionStore.upsertThread(thread);
  }

  finishThread(thread: RuntimeThread, prompt: string) {
    thread.updatedAt = new Date().toISOString();
    thread.runCount += 1;
    if (thread.title === '新的会话' || thread.title === '欢迎使用 OpenAgent') {
      thread.title = prompt.slice(0, 28) || thread.title;
    }
    this.sessionStore.upsertThread(thread);
  }

  private restoreOrCreateWelcomeThread() {
    const restoredThreads = this.sessionStore.listThreads({
      workspaceRoot: this.options.workspaceRoot,
      workspaceName: this.options.workspaceName,
      branch: this.options.branch
    });

    if (restoredThreads.length > 0) {
      for (const thread of restoredThreads) {
        this.threads.set(thread.threadId, thread);
      }
      this.activeThreadId = restoredThreads[0].threadId;
      this.loadActiveThreadMessages();
      return;
    }

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

  private loadActiveThreadMessages() {
    const sessionFile = this.sessionStore.getSessionFile(this.activeThreadId);
    const transcript = new TranscriptStore(sessionFile);
    this.messages.length = 0;
    this.messages.push(...transcript.readMessages());
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
