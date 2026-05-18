import { randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter, AgentRuntimeCompactInput, AgentRuntimeCompactResult, AgentRuntimeRunInput, AgentRuntimeRunResult, RuntimeMessage } from '../runtime-types.js';
import { errorToMessage, isCancelledError } from '../errors.js';
import { createPiModelContext, resolvePiThinkingLevel } from './pi-model-registry.js';
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
      const thinkingLevel = resolvePiThinkingLevel(selectedModel);
      const { session, piSessionFile, agentDir } = await createOpenAgentPiSession({
        workspaceRoot: input.workspaceRoot,
        openAgentSessionFile: input.sessionFile,
        authStorage,
        modelRegistry,
        selectedModel,
        customTools: [],
        thinkingLevel
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
      const thinkingLevel = resolvePiThinkingLevel(selectedModel);
      input.onLog?.({
        scope: 'agent-loop',
        message: 'agent loop iteration 2: prepare agent session inputs',
        data: {
          selectedModel: {
            id: selectedModel.id,
            name: selectedModel.name,
            provider: selectedModel.provider,
            api: selectedModel.api,
            baseUrl: selectedModel.baseUrl,
            reasoning: selectedModel.reasoning,
            compat: selectedModel.compat,
            thinkingEnabled: selectedModel.thinkingEnabled,
            thinkingLevel,
            contextWindow: selectedModel.contextWindow,
            maxTokens: selectedModel.maxTokens
          }
        }
      });

      const toolExecutor = new ToolExecutor(input.tools, {
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
      });
      const customTools = toPiToolDefinitions(
        input.tools,
        toolExecutor,
        { onLog: input.onLog }
      );

      const { session, piSessionFile, agentDir } = await createOpenAgentPiSession({
        workspaceRoot: input.workspaceRoot,
        openAgentSessionFile: input.sessionFile,
        authStorage,
        modelRegistry,
        selectedModel,
        customTools,
        thinkingLevel
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
          thinkingLevel,
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
          runtimeModel: {
            provider: selectedModel.provider,
            id: selectedModel.id,
            api: selectedModel.api,
            baseUrl: selectedModel.baseUrl,
            reasoning: selectedModel.reasoning,
            thinkingEnabled: selectedModel.thinkingEnabled,
            thinkingLevel,
            compat: selectedModel.compat
          },
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
        const recovery = parseUnparsedToolCallText(assistantText, input.tools.map((tool) => tool.name));
        const recoveryEnabled = allowTextToolCallRecovery();
        input.onLog?.({
          scope: 'agent-loop',
          message: recovery && recoveryEnabled ? 'unparsed_tool_call_recovery_attempt' : 'unparsed_tool_call',
          data: {
            runId: input.runId,
            threadId: input.threadId,
            providerId: input.providerId,
            model: input.model,
            toolName: unparsedToolCall.toolName,
            parsedArgs: recovery?.args,
            textToolCallRecoveryEnabled: recoveryEnabled,
            assistantText,
            toolResultCount: promptResult.toolResultCount,
            hadPriorToolResults: promptResult.toolResultCount > 0,
            loopCount: promptResult.loopCount
          }
        });

        if (recoveryEnabled && recovery && promptResult.toolResultCount === 0) {
          const toolCallId = `text-tool-${randomUUID()}`;
          const result = await toolExecutor.execute({
            toolName: recovery.toolName,
            toolCallId,
            args: recovery.args,
            signal: input.abortSignal
          });
          const content = [
            `已兼容执行模型文本工具调用：${recovery.toolName}`,
            '',
            result.content
          ].join('\n');
          const message: RuntimeMessage = {
            id: `assistant-${randomUUID()}`,
            role: 'assistant',
            content,
            createdAt: new Date().toISOString()
          };
          input.onLog?.({
            scope: 'agent-loop',
            message: 'unparsed_tool_call_recovered',
            data: { runId: input.runId, threadId: input.threadId, toolName: recovery.toolName, toolCallId, ok: result.ok }
          });
          return {
            status: result.ok ? 'completed' : 'failed',
            assistantMessage: result.ok ? message : undefined,
            error: result.ok ? undefined : result.content,
            summary: content
          };
        }

        const message = `模型最终返回了未解析的工具调用文本，工具未执行：${unparsedToolCall.toolName}`;
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


function parseUnparsedToolCallText(text: string, toolNames: string[]) {
  const normalized = text.trim().replaceAll('<|"|>', '"').replace(/<tool_call\|>\s*$/g, '').trim();
  for (const toolName of toolNames) {
    const escaped = escapeRegExp(toolName);
    const match = new RegExp(`^(?:<\\|tool_call>)?\\s*(?:(?:thought)?call:|:?\\s*)?${escaped}\\s*\\{([\\s\\S]*)\\}\\s*$`, 's').exec(normalized);
    if (!match) continue;
    const args = parseLooseToolArgs(match[1]);
    if (args) return { toolName, args };
  }
  return null;
}

function parseLooseToolArgs(body: string): Record<string, unknown> | null {
  const jsonLike = `{${body}}`
    .replace(/([,{]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  try {
    const parsed = JSON.parse(jsonLike);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function allowTextToolCallRecovery() {
  return process.env.OPENAGENT_ALLOW_TEXT_TOOL_RECOVERY === '1';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
