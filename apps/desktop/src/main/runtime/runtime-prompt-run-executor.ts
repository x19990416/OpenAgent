import type { RuntimeAttachment, RuntimeEventBus, RuntimeThread } from '@openagent/runtime';
import { TranscriptStore } from '@openagent/runtime';
import { errorToMessage, summarizeRunResult } from '@openagent/runtime';
import { appendLlmResponseLog, appendRuntimeInfoLog } from '@openagent/runtime';
import { formatPlanApprovalDescription, shouldContinueProgressOnlyReply, shouldRetryPlanToolExecution, type AgentPlan } from '@openagent/planning';
import { RuntimeProgressController } from './runtime-progress-controller.js';
import { MAX_PROGRESS_CONTINUATION_ATTEMPTS, RuntimeAgentLoopController } from './runtime-agent-loop-controller.js';
import { RuntimeRunInputBuilder } from './runtime-run-input-builder.js';
import { RuntimeContextUpdateController } from './runtime-context-update-controller.js';
import { RuntimeRunFinalizer } from './runtime-run-finalizer.js';
import { RuntimeApprovalController } from './runtime-approval-controller.js';
import { RuntimePlanController } from './runtime-plan-controller.js';
import { RuntimeCompactionController } from './runtime-compaction-controller.js';
import { RuntimeThreadController } from './runtime-thread-controller.js';
import type { RunStateStore } from '@openagent/runtime';

export class RuntimePromptRunExecutor {
  constructor(
    private readonly runState: RunStateStore,
    private readonly eventBus: RuntimeEventBus,
    private readonly planController: RuntimePlanController,
    private readonly approvalController: RuntimeApprovalController,
    private readonly runInputBuilder: RuntimeRunInputBuilder,
    private readonly agentLoopController: RuntimeAgentLoopController,
    private readonly contextUpdateController: RuntimeContextUpdateController,
    private readonly compactionController: RuntimeCompactionController,
    private readonly threadController: RuntimeThreadController,
    private readonly runFinalizer: RuntimeRunFinalizer
  ) {}

  async executePromptRun(input: {
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
          const decision = await this.approvalController.requestToolApproval({
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
            return this.runFinalizer.finishCancelled({ runId, summary: '用户取消了 Agent Plan。' });
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
        return this.runFinalizer.finishCancelled({ runId, summary });
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
        return this.runFinalizer.finishFailedWithAssistant({ runId, thread, transcript, summary, details: summary });
      }

      if (shouldRetryPlanToolExecution(activePlan, result)) {
        summary = '计划执行未完成：模型没有发起计划要求的 OpenAgent 工具调用。请重试，或让模型改用明确的工具调用完成任务。';
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
        }
        return this.runFinalizer.finishFailedWithAssistant({ runId, thread, transcript, summary, details: summary });
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
        return this.runFinalizer.finishCompleted({ runId, summary });
      }

      if (result.status === 'cancelled') {
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
        }
        return this.runFinalizer.finishCancelled({ runId, summary });
      }

      if (activePlan) {
        activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
        this.planController.emit('plan.failed', activePlan, summary);
      }
      return this.runFinalizer.finishFailedWithAssistant({ runId, thread, transcript, summary, details: result.error });
    } catch (error) {
      const message = errorToMessage(error);
      if (abortSignal.aborted) {
        const summary = '运行已停止。';
        if (activePlan) {
          activePlan = planExecutor?.failCurrent(summary) ?? this.planController.markFailed(activePlan, summary);
          this.planController.emit('plan.failed', activePlan, summary);
        }
        return this.runFinalizer.finishCancelled({ runId, summary });
      }
      if (activePlan) {
        activePlan = planExecutor?.failCurrent(message) ?? this.planController.markFailed(activePlan, message);
        this.planController.emit('plan.failed', activePlan, message);
      }
      return this.runFinalizer.finishFailedWithAssistant({ runId, thread, transcript, summary: message, details: message });
    }
  }

}
