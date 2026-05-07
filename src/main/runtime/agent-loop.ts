import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildModelPrompt } from './prompt-builder.js';
import { CancelledError, errorToMessage, isCancelledError } from './errors.js';
import type { AgentRuntimeAdapter, AgentRuntimeRunInput, AgentRuntimeRunResult, RuntimeMessage } from './runtime-types.js';

export class LocalDemoAgentLoop implements AgentRuntimeAdapter {
  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    try {
      input.onLog?.({
        scope: 'agent-loop',
        message: 'local demo loop iteration 1: start',
        data: buildLoopLogSnapshot(input)
      });
      throwIfAborted(input.abortSignal);

      // Keep the first implementation intentionally tiny: this is the place where
      // the future Pi adapter will call createAgentSession(). For now it proves the
      // runtime lifecycle, event path, cancellation, and transcript persistence.
      await delay(80, undefined, { signal: input.abortSignal });
      input.onLog?.({
        scope: 'agent-loop',
        message: 'local demo loop iteration 2: build model prompt',
        data: {
          messageCount: input.messages.length,
          toolCount: input.tools.length
        }
      });
      const _modelPrompt = buildModelPrompt({
        workspaceRoot: input.workspaceRoot,
        agentId: input.agentId,
        messages: input.messages,
        prompt: input.prompt
      });

      const message: RuntimeMessage = {
        id: `assistant-${randomUUID()}`,
        role: 'assistant',
        content: buildLocalDemoReply(input),
        createdAt: new Date().toISOString()
      };

      input.onLog?.({
        scope: 'agent-loop',
        message: 'local demo loop iteration 3: assistant message ready',
        data: {
          assistantMessageId: message.id,
          contentLength: message.content.length
        }
      });

      return {
        status: 'completed',
        assistantMessage: message,
        summary: message.content
      };
    } catch (error) {
      if (isCancelledError(error)) {
        return { status: 'cancelled', summary: '运行已停止。' };
      }

      return { status: 'failed', error: errorToMessage(error) };
    }
  }
}

function buildLoopLogSnapshot(input: AgentRuntimeRunInput) {
  return {
    runId: input.runId,
    threadId: input.threadId,
    providerId: input.providerId,
    model: input.model,
    promptLength: input.prompt.length,
    messageCount: input.messages.length,
    toolNames: input.tools.map((tool) => tool.name)
  };
}

function buildLocalDemoReply(input: AgentRuntimeRunInput) {
  const toolSummary = input.tools.length > 0 ? input.tools.map((tool) => tool.name).join(', ') : '暂无工具';
  return [
    `已进入 OpenAgent 第一版 runtime loop。`,
    '',
    `收到你的输入：${input.prompt}`,
    '',
    `当前 provider/model：${input.providerId} / ${input.model}`,
    `当前可用工具：${toolSummary}`,
    '',
    '说明：这一步先跑通 runtime-service → agent-loop → event-bus → transcript-store。后续可以在相同 Adapter 契约下替换为 Pi AgentSession。'
  ].join('\n');
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new CancelledError();
  }
}
