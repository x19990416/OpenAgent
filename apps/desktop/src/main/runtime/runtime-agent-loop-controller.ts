import type { AgentRuntimeAdapter, AgentRuntimeRunInput, AgentRuntimeRunResult, RuntimeEventBus } from '@openagent/runtime';
import { appendRuntimeInfoLog } from '@openagent/runtime';
import { buildPlanToolExecutionRetryPrompt, buildProgressContinuationPrompt, shouldContinueProgressOnlyReply, shouldRetryPlanToolExecution, type AgentPlan } from '@openagent/planning';

export const MAX_PROGRESS_CONTINUATION_ATTEMPTS = 3;

export class RuntimeAgentLoopController {
  constructor(
    private readonly adapter: AgentRuntimeAdapter,
    private readonly eventBus: RuntimeEventBus
  ) {}

  async runWithRetries(input: {
    runInput: AgentRuntimeRunInput;
    prompt: string;
    activePlan: AgentPlan | null;
    onPlanRetry?: (reason: string) => void;
  }): Promise<AgentRuntimeRunResult> {
    const { runInput, prompt, activePlan, onPlanRetry } = input;
    const { runId, threadId } = runInput;
    let result = await this.adapter.run(runInput);
    let continuationBaseMessages = runInput.messages;

    if (shouldRetryPlanToolExecution(activePlan, result)) {
      const retryReason = '计划执行需要实际工具调用，但模型上一轮只返回了说明文本；正在用更严格的工具执行指令重试一次。';
      appendRuntimeInfoLog({
        scope: 'agent-loop',
        message: 'plan tool execution retry requested',
        data: {
          runId,
          threadId,
          loopCount: result.loopCount,
          toolResultCount: result.toolResultCount,
          assistantMessageId: result.assistantMessage?.id
        }
      });
      onPlanRetry?.(retryReason);
      this.eventBus.emit('runtime.activity', {
        id: `${runId}-plan-tool-retry`,
        runId,
        threadId,
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
        threadId,
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
          threadId,
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
        threadId,
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
        threadId,
        kind: 'tool',
        status: result.status === 'completed' ? 'completed' : 'failed',
        title: 'Continued unfinished assistant progress',
        detail: `toolResultCount=${result.toolResultCount ?? 0}`,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });
    }

    return result;
  }
}
