import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getOpenAgentAppSettings } from '../settings/openagent-settings.js';
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
        thinkingLevel,
        onLog: input.onLog
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
      let promptResult = await promptOpenAgentPiSession({
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
      let assistantText = promptResult.assistantText;
      let totalLoopCount = promptResult.loopCount;
      let totalToolResultCount = promptResult.toolResultCount;
      for (let recoveryAttempt = 0; recoveryAttempt < 5; recoveryAttempt += 1) {
        const unparsedToolCall = detectUnparsedToolCallText(assistantText, input.tools.map((tool) => tool.name));
        if (!unparsedToolCall) break;
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
            toolResultCount: totalToolResultCount,
            hadPriorToolResults: totalToolResultCount > 0,
            loopCount: totalLoopCount,
            recoveryAttempt: recoveryAttempt + 1
          }
        });

        const repairSessionFile = buildRepairSessionFile(input.sessionFile, input.runId);
        const { session: repairSession, piSessionFile: repairPiSessionFile } = await createOpenAgentPiSession({
          workspaceRoot: input.workspaceRoot,
          openAgentSessionFile: repairSessionFile,
          authStorage,
          modelRegistry,
          selectedModel,
          customTools,
          thinkingLevel,
          systemPromptOverride: buildStructuredToolRepairSystemPrompt(),
          onLog: input.onLog
        });
        repairSession.setActiveToolsByName?.(input.tools.map((tool) => tool.name));
        let structuredRetry;
        try {
          structuredRetry = await promptOpenAgentPiSession({
            session: repairSession,
            prompt: buildStructuredToolRetryPrompt(unparsedToolCall.toolName, recovery?.args),
            attachments: [],
            abortSignal: input.abortSignal,
            onLog: input.onLog,
            emitUiEvent: input.emitUiEvent,
            runId: input.runId,
            threadId: input.threadId,
            maxIterations: 2
          });
        } finally {
          repairSession.dispose?.();
        }
        input.onLog?.({
          scope: 'agent-loop',
          message: 'unparsed_tool_call_structured_retry_completed',
          data: {
            runId: input.runId,
            threadId: input.threadId,
            toolName: unparsedToolCall.toolName,
            repairSessionFile,
            repairPiSessionFile,
            retryToolResultCount: structuredRetry.toolResultCount,
            retryLoopCount: structuredRetry.loopCount,
            recoveryAttempt: recoveryAttempt + 1
          }
        });
        totalLoopCount += structuredRetry.loopCount;
        totalToolResultCount += structuredRetry.toolResultCount;
        if (structuredRetry.toolResultCount > 0) {
          promptResult = await promptOpenAgentPiSession({
            session,
            prompt: buildStructuredRepairContinuationPrompt(unparsedToolCall.toolName, structuredRetry.toolResults),
            attachments: [],
            abortSignal: input.abortSignal,
            onLog: input.onLog,
            emitUiEvent: input.emitUiEvent,
            runId: input.runId,
            threadId: input.threadId,
            maxIterations: input.maxIterations
          });
          assistantText = promptResult.assistantText;
          totalLoopCount += promptResult.loopCount;
          totalToolResultCount += promptResult.toolResultCount;
          continue;
        }

        if (recoveryEnabled && recovery) {
          const toolCallId = `text-tool-${randomUUID()}`;
          const result = await toolExecutor.execute({
            toolName: recovery.toolName,
            toolCallId,
            args: recovery.args,
            signal: input.abortSignal
          });
          totalToolResultCount += 1;
          input.onLog?.({
            scope: 'agent-loop',
            message: 'unparsed_tool_call_recovered',
            data: { runId: input.runId, threadId: input.threadId, toolName: recovery.toolName, toolCallId, ok: result.ok, recoveryAttempt: recoveryAttempt + 1 }
          });
          if (!result.ok) {
            if (isRecoverableToolPolicyCorrection(result.data)) {
              input.onLog?.({
                scope: 'agent-loop',
                message: 'unparsed_tool_call_recovery_policy_correction',
                data: {
                  runId: input.runId,
                  threadId: input.threadId,
                  toolName: recovery.toolName,
                  toolCallId,
                  recoveryAttempt: recoveryAttempt + 1,
                  data: result.data
                }
              });
              promptResult = await promptOpenAgentPiSession({
                session,
                prompt: buildRecoveredToolContinuationPrompt(recovery.toolName, recovery.args, result.content),
                attachments: [],
                abortSignal: input.abortSignal,
                onLog: input.onLog,
                emitUiEvent: input.emitUiEvent,
                runId: input.runId,
                threadId: input.threadId,
                maxIterations: input.maxIterations
              });
              assistantText = promptResult.assistantText;
              totalLoopCount += promptResult.loopCount;
              totalToolResultCount += promptResult.toolResultCount;
              continue;
            }
            const content = [
              `已兼容执行模型文本工具调用：${recovery.toolName}`,
              '',
              result.content
            ].join('\n');
            return {
              status: 'failed',
              error: content,
              summary: content,
              loopCount: totalLoopCount,
              toolResultCount: totalToolResultCount
            };
          }
          promptResult = await promptOpenAgentPiSession({
            session,
            prompt: buildRecoveredToolContinuationPrompt(recovery.toolName, recovery.args, result.content),
            attachments: [],
            abortSignal: input.abortSignal,
            onLog: input.onLog,
            emitUiEvent: input.emitUiEvent,
            runId: input.runId,
            threadId: input.threadId,
            maxIterations: input.maxIterations
          });
          assistantText = promptResult.assistantText;
          totalLoopCount += promptResult.loopCount;
          totalToolResultCount += promptResult.toolResultCount;
          continue;
        }

        const message = `模型返回了未解析的工具调用文本，工具未执行。请重试，或切换/配置支持结构化工具调用的模型。工具：${unparsedToolCall.toolName}`;
        return {
          status: 'failed',
          error: message,
          summary: message
        };
      }
      if (detectUnparsedToolCallText(assistantText, input.tools.map((tool) => tool.name))) {
        const message = '模型连续返回文本形式工具调用，已达到兼容恢复上限。';
        return {
          status: 'failed',
          error: message,
          summary: message,
          loopCount: totalLoopCount,
          toolResultCount: totalToolResultCount
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
        summary: message.content,
        loopCount: totalLoopCount,
        toolResultCount: totalToolResultCount
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
  if (!trimmed) return null;

  const toolName = toolNames.find((name) => {
    const escaped = escapeRegExp(name);
    return new RegExp(`^${TEXT_TOOL_CALL_MARKER_PATTERN}\\s*(?:(?:thought)?call:|:?\\s*)?${escaped}\\s*\\{`, 's').test(trimmed);
  });

  if (toolName) return { toolName };

  const unknownToolName = new RegExp(`^${TEXT_TOOL_CALL_MARKER_PATTERN}\\s*(?:(?:thought)?call:|:?\\s*)?([A-Za-z_$][A-Za-z0-9_$-]*)\\s*\\{`, 's').exec(trimmed)?.[1];
  return unknownToolName ? { toolName: unknownToolName } : null;
}


function parseUnparsedToolCallText(text: string, toolNames: string[]) {
  const normalized = stripTextToolCallMarkers(text);
  for (const toolName of toolNames) {
    const escaped = escapeRegExp(toolName);
    const match = new RegExp(`^(?:(?:thought)?call:|:?\\s*)?${escaped}\\s*\\{([\\s\\S]*)\\}\\s*$`, 's').exec(normalized);
    if (!match) continue;
    const args = parseLooseToolArgs(match[1]);
    if (args) return { toolName, args };
  }
  return null;
}

const TEXT_TOOL_CALL_MARKER_PATTERN = String.raw`(?:(?:<\|tool_call>)|(?:<tool_call\|>))?`;

function stripTextToolCallMarkers(text: string) {
  return text
    .trim()
    .replace(/^(?:<\|tool_call>|<tool_call\|>)\s*/g, '')
    .replace(/\s*(?:<\|tool_call>|<tool_call\|>)$/g, '')
    .trim();
}

function parseLooseToolArgs(body: string): Record<string, unknown> | null {
  const markerArgs = parseMarkerDelimitedToolArgs(body);
  if (markerArgs) return markerArgs;

  const jsonLike = `{${body.replaceAll('<|"|>', '"')}}`
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

function parseMarkerDelimitedToolArgs(body: string): Record<string, unknown> | null {
  if (!body.includes('<|"|>')) return null;
  const result: Record<string, unknown> = {};
  let index = 0;

  while (index < body.length) {
    index = skipToolArgDelimiters(body, index);
    if (index >= body.length) break;

    const keyMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(index));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    index += key.length;
    index = skipWhitespace(body, index);
    if (body[index] !== ':') return null;
    index += 1;
    index = skipWhitespace(body, index);

    if (body.startsWith('<|"|>', index)) {
      index += '<|"|>'.length;
      const end = body.indexOf('<|"|>', index);
      if (end < 0) return null;
      result[key] = body.slice(index, end);
      index = end + '<|"|>'.length;
    } else {
      const end = findNextTopLevelComma(body, index);
      const rawValue = body.slice(index, end < 0 ? body.length : end).trim();
      result[key] = coerceLooseToolValue(rawValue);
      index = end < 0 ? body.length : end;
    }

    index = skipToolArgDelimiters(body, index);
  }

  return Object.keys(result).length > 0 ? result : null;
}

function skipToolArgDelimiters(value: string, index: number) {
  let cursor = index;
  while (cursor < value.length && /[\s,]/.test(value[cursor] ?? '')) cursor += 1;
  return cursor;
}

function skipWhitespace(value: string, index: number) {
  let cursor = index;
  while (cursor < value.length && /\s/.test(value[cursor] ?? '')) cursor += 1;
  return cursor;
}

function findNextTopLevelComma(value: string, index: number) {
  const comma = value.indexOf(',', index);
  return comma < 0 ? -1 : comma;
}

function coerceLooseToolValue(value: string) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  try {
    return JSON.parse(value.replaceAll('<|"|>', '"'));
  } catch {
    return value;
  }
}

function buildStructuredToolRepairSystemPrompt() {
  return [
    'You are OpenAgent tool-call protocol repair.',
    'Your only job is to emit exactly one real structured tool call using the available tool-calling interface.',
    'Do not solve the user task. Do not answer in natural language. Do not output text-form calls such as call:tool{...}.'
  ].join('\n');
}

function buildStructuredToolRetryPrompt(toolName: string, parsedArgs?: Record<string, unknown>) {
  const target = { toolName, args: parsedArgs ?? {} };
  return safeJsonStringify(target).slice(0, 4000);
}

function buildStructuredRepairContinuationPrompt(toolName: string, toolResults: unknown[]) {
  return [
    `A short isolated repair session re-issued the previous text-form pseudo tool call as a structured tool call: ${toolName}.`,
    'Continue the original user task using these tool results. Do not repeat the same tool call unless more information is required.',
    'If more tools are needed, use structured tool calls only.',
    '',
    'Tool results:',
    safeJsonStringify(toolResults).slice(0, 8000)
  ].join('\n');
}

function buildRepairSessionFile(openAgentSessionFile: string, runId?: string) {
  const sessionDir = path.dirname(openAgentSessionFile);
  const safeRunId = (runId || 'run').replace(/[^A-Za-z0-9_.-]/g, '-');
  return path.join(sessionDir, `.repair-${safeRunId}-${randomUUID()}.jsonl`);
}

function buildRecoveredToolContinuationPrompt(toolName: string, args: Record<string, unknown>, resultContent: string) {
  return [
    `OpenAgent host recovered and executed your previous text-form tool call: ${toolName}.`,
    'Do not repeat that exact tool call. Continue the same user task from the returned result.',
    'If more tools are needed, use structured tool calls. If you still emit text-form tool calls, OpenAgent may recover them but this is only a compatibility fallback.',
    '',
    'Recovered tool arguments:',
    safeJsonStringify(args).slice(0, 4000),
    '',
    'Recovered tool result:',
    resultContent.slice(0, 4000)
  ].join('\n');
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecoverableToolPolicyCorrection(value: unknown) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { recoverable?: unknown }).recoverable === true &&
      (value as { recoveryKind?: unknown }).recoveryKind === 'selected_skill_routing'
  );
}

function allowTextToolCallRecovery() {
  if (process.env.OPENAGENT_ALLOW_TEXT_TOOL_RECOVERY === '0') return false;
  if (process.env.OPENAGENT_ALLOW_TEXT_TOOL_RECOVERY === '1') return true;
  return getOpenAgentAppSettings().runtime.allowTextToolCallRecovery;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
