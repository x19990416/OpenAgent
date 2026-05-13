import { randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter, AgentRuntimeCompactInput, AgentRuntimeCompactResult, AgentRuntimeRunInput, AgentRuntimeRunResult, RuntimeMessage } from '../runtime-types.js';
import { errorToMessage, isCancelledError } from '../errors.js';
import { createPiModelContext } from './pi-model-registry.js';
import { appendLlmResponseLog } from '../runtime-info-logger.js';
import { ToolExecutor } from '../tool-executor.js';
import { toPiToolDefinitions } from './pi-tools.js';
import { createOpenAgentPiSession } from './pi-session.js';
import { MAX_RECENT_TRANSCRIPT_MESSAGES, buildPiPrompt } from './pi-system-prompt.js';
import { promptOpenAgentPiSession } from './pi-events.js';

export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  async compact(input: AgentRuntimeCompactInput): Promise<AgentRuntimeCompactResult> {
    const activityId = `pi-compaction-${input.threadId}`;
    try {
      input.emitUiEvent?.('runtime.activity', {
        id: activityId,
        runId: `compact-${input.threadId}`,
        threadId: input.threadId,
        kind: 'thinking',
        status: 'running',
        title: 'Compacting AgentSession',
        detail: 'Manual agent session compaction started.',
        createdAt: new Date().toISOString()
      });
      input.onLog?.({
        scope: 'pi-session',
        message: 'pi compaction: resolving model context',
        data: { threadId: input.threadId, providerId: input.providerId, model: input.model, sessionFile: input.sessionFile }
      });
      const { authStorage, modelRegistry, selectedModel } = createPiModelContext({
        providerId: input.providerId,
        modelId: input.model
      });
      const { session, piSessionFile, agentDir } = await createOpenAgentPiSession({
        workspaceRoot: input.workspaceRoot,
        openAgentSessionFile: input.sessionFile,
        authStorage,
        modelRegistry,
        selectedModel,
        customTools: [],
        thinkingLevel: 'off'
      });
      const unsubscribe = session.subscribe((event: any) => {
        if (event.type === 'compaction_start') {
          input.onLog?.({ scope: 'pi-session', message: 'pi compaction started', data: { threadId: input.threadId, reason: event.reason, piSessionFile } });
        }
        if (event.type === 'compaction_end') {
          input.onLog?.({ scope: 'pi-session', message: 'pi compaction ended', data: { threadId: input.threadId, reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, errorMessage: event.errorMessage, result: event.result } });
        }
      });
      try {
        const result = await session.compact('Summarize the prior OpenAgent desktop session context for future continuation. Preserve user goals, decisions, file/tool actions, and unresolved tasks.');
        input.emitUiEvent?.('runtime.activity', {
          id: activityId,
          runId: `compact-${input.threadId}`,
          threadId: input.threadId,
          kind: 'thinking',
          status: 'completed',
          title: 'AgentSession compacted',
          detail: `tokensBefore=${result?.tokensBefore ?? 'unknown'}`,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        });
        return { ok: true, summary: result?.summary, data: { result, piSessionFile, agentDir } };
      } finally {
        unsubscribe?.();
        session.dispose?.();
      }
    } catch (error) {
      const message = errorToMessage(error);
      input.emitUiEvent?.('runtime.activity', {
        id: activityId,
        runId: `compact-${input.threadId}`,
        threadId: input.threadId,
        kind: 'thinking',
        status: 'failed',
        title: 'AgentSession compaction failed',
        detail: message,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });
      input.onLog?.({ scope: 'pi-session', message: 'pi compaction failed', data: { threadId: input.threadId, error: message } });
      return { ok: false, error: message };
    }
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    try {
      input.onLog?.({
        scope: 'agent-loop',
        message: 'agent loop iteration 1: resolve model context',
        data: {
          runId: input.runId,
          threadId: input.threadId,
          providerId: input.providerId,
          model: input.model
        }
      });
      const { authStorage, modelRegistry, selectedModel } = createPiModelContext({
        providerId: input.providerId,
        modelId: input.model
      });
      input.onLog?.({
        scope: 'agent-loop',
        message: 'agent loop iteration 2: prepare agent session inputs',
        data: {
          selectedModel: {
            id: selectedModel.id,
            name: selectedModel.name,
            provider: selectedModel.provider,
            contextWindow: selectedModel.contextWindow,
            maxTokens: selectedModel.maxTokens
          }
        }
      });

      const customTools = toPiToolDefinitions(
        input.tools,
        new ToolExecutor(input.tools, {
          runId: input.runId,
          threadId: input.threadId,
          agentId: input.agentId,
          sessionFile: input.sessionFile,
          providerId: input.providerId,
          model: input.model,
          onLog: input.onLog,
          emitUiEvent: input.emitUiEvent,
          workspaceRoot: input.workspaceRoot,
          requestApproval: input.requestApproval,
          getPlanContext: input.getPlanContext
        }),
        { onLog: input.onLog }
      );

      const { session, piSessionFile, agentDir } = await createOpenAgentPiSession({
        workspaceRoot: input.workspaceRoot,
        openAgentSessionFile: input.sessionFile,
        authStorage,
        modelRegistry,
        selectedModel,
        customTools,
        thinkingLevel: 'off'
      });
      session.setActiveToolsByName?.(input.tools.map((tool) => tool.name));

      input.onLog?.({
        scope: 'agent-loop',
        message: 'agent loop iteration 3: AgentSession ready',
        data: {
          cwd: input.workspaceRoot,
          agentDir,
          openAgentTranscriptFile: input.sessionFile,
          piSessionFile,
          toolMode: 'openAgentToolExecutor',
          thinkingLevel: 'off',
          tools: input.tools.map((tool) => tool.name)
        }
      });

      input.onLog?.({
        scope: 'agent-loop',
        message: 'agent loop iteration 4: prompt session',
        data: {
          promptLength: input.prompt.length,
          transcriptMessageCount: input.messages.length,
          attachmentCount: input.attachments?.length ?? 0,
          piPromptRecentTranscriptLimit: MAX_RECENT_TRANSCRIPT_MESSAGES,
          imageAttachmentCount: input.attachments?.filter((attachment) => attachment.kind === 'image' && attachment.imageDataUrl).length ?? 0
        }
      });
      const requestBody = buildPiPrompt(input.systemPrompt, input.prompt, input.messages, input.attachments ?? []);
      appendLlmResponseLog({
        scope: 'agent-loop',
        message: 'LLM request body',
        data: {
          runId: input.runId,
          threadId: input.threadId,
          providerId: input.providerId,
          model: input.model,
          prompt: requestBody,
          promptLength: requestBody.length,
          transcriptMessageCount: input.messages.length,
          attachmentCount: input.attachments?.length ?? 0,
          piPromptRecentTranscriptLimit: MAX_RECENT_TRANSCRIPT_MESSAGES,
          imageAttachmentCount: input.attachments?.filter((attachment) => attachment.kind === 'image' && attachment.imageDataUrl).length ?? 0
        }
      });
      const promptResult = await promptOpenAgentPiSession({
        session,
        prompt: requestBody,
        attachments: input.attachments ?? [],
        abortSignal: input.abortSignal,
        onLog: input.onLog,
        emitUiEvent: input.emitUiEvent,
        runId: input.runId,
        threadId: input.threadId,
        maxIterations: input.maxIterations
      });
      const assistantText = promptResult.assistantText;
      const unparsedToolCall = detectUnparsedToolCallText(assistantText, input.tools.map((tool) => tool.name));
      if (unparsedToolCall) {
        const message = `模型最终返回了未解析的工具调用文本，工具未执行：${unparsedToolCall.toolName}`;
        input.onLog?.({
          scope: 'agent-loop',
          message: 'unparsed_tool_call',
          data: {
            runId: input.runId,
            threadId: input.threadId,
            providerId: input.providerId,
            model: input.model,
            toolName: unparsedToolCall.toolName,
            assistantText,
            toolResultCount: promptResult.toolResultCount,
            hadPriorToolResults: promptResult.toolResultCount > 0,
            loopCount: promptResult.loopCount
          }
        });
        return {
          status: 'failed',
          error: message,
          summary: message
        };
      }
      const message: RuntimeMessage = {
        id: `assistant-${randomUUID()}`,
        role: 'assistant',
        content: assistantText,
        createdAt: new Date().toISOString()
      };

      input.onLog?.({
        scope: 'agent-loop',
        message: 'agent loop iteration 5: completed',
        data: {
          assistantMessageId: message.id,
          assistantTextLength: message.content.length
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

      return {
        status: 'failed',
        error: errorToMessage(error)
      };
    }
  }
}

function detectUnparsedToolCallText(text: string, toolNames: string[]) {
  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes('<tool_call|>')) return null;

  const toolName = toolNames.find((name) => {
    const escaped = escapeRegExp(name);
    return new RegExp(`^(?:<\\|tool_call>)?\\s*(?:(?:thought)?call:|:?\\s*)?${escaped}\\s*\\{`, 's').test(trimmed);
  });

  return toolName ? { toolName } : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
