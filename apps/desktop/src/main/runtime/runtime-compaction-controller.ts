import type { AgentRuntimeAdapter, RuntimeServiceOptions, RuntimeThread } from '@openagent/runtime';
import { appendRuntimeInfoLog, formatRuntimeInfoLogSummary, type RuntimeEventBus, type SessionStore } from '@openagent/runtime';

const AUTO_COMPACT_TRANSCRIPT_MESSAGES = 96;
const AUTO_COMPACT_MIN_INTERVAL_MS = 30 * 60 * 1000;

export class RuntimeCompactionController {
  private readonly lastCompactionByThread = new Map<string, number>();

  constructor(
    private readonly options: RuntimeServiceOptions,
    private readonly adapter: AgentRuntimeAdapter,
    private readonly sessionStore: SessionStore,
    private readonly eventBus: RuntimeEventBus,
    private readonly getThread: (threadId: string) => RuntimeThread | undefined
  ) {}

  maybeAutoCompactThread(input: { threadId: string; transcriptMessageCount: number; runId: string }) {
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

  async compactThread(threadId: string) {
    const thread = this.getThread(threadId);
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
}
