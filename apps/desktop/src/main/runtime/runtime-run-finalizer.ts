import { randomUUID } from 'node:crypto';
import type { RuntimeEventBus, RuntimeMessage, RuntimeThread } from '@openagent/runtime';
import type { RunStateStore, TranscriptStore } from '@openagent/runtime';
import type { RuntimeThreadController } from './runtime-thread-controller.js';
import type { RuntimeApprovalController } from './runtime-approval-controller.js';

export class RuntimeRunFinalizer {
  constructor(
    private readonly runState: RunStateStore,
    private readonly eventBus: RuntimeEventBus,
    private readonly threadController: RuntimeThreadController,
    private readonly approvalController: RuntimeApprovalController
  ) {}

  emitFailureAssistantMessage(thread: RuntimeThread, transcript: TranscriptStore, summary: string) {
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

  finishCompleted(input: { runId: string; summary: string }) {
    this.runState.finish(input.runId, { status: 'completed', summary: input.summary });
    this.eventBus.emit('run.completed', { runId: input.runId, summary: input.summary });
    return { ok: true as const, runId: input.runId, status: 'completed' as const };
  }

  finishCancelled(input: { runId: string; summary: string }) {
    this.runState.finish(input.runId, { status: 'cancelled', summary: input.summary });
    this.eventBus.emit('run.cancelled', { runId: input.runId, summary: input.summary });
    return { ok: false as const, runId: input.runId, status: 'cancelled' as const, error: input.summary };
  }

  finishFailed(input: { runId: string; summary: string; details?: string }) {
    this.runState.finish(input.runId, { status: 'failed', summary: input.summary });
    this.eventBus.emit('run.failed', { summary: input.summary, details: input.details ?? input.summary });
    return { ok: false as const, runId: input.runId, status: 'failed' as const, error: input.summary };
  }

  finishFailedWithAssistant(input: { runId: string; thread: RuntimeThread; transcript: TranscriptStore; summary: string; details?: string }) {
    this.emitFailureAssistantMessage(input.thread, input.transcript, input.summary);
    return this.finishFailed(input);
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

}
