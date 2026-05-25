import type { AgentRuntimeRunInput, RuntimeAttachment } from '@openagent/runtime';
import { CancelledError, recordModelUsage } from '@openagent/runtime';
import { installPiHttpLogger } from './pi-http-logger.js';

export interface PiPromptSessionResult {
  assistantText: string;
  loopCount: number;
  toolResultCount: number;
}

export async function promptOpenAgentPiSession(input: {
  session: any;
  prompt: string;
  attachments: RuntimeAttachment[];
  abortSignal: AbortSignal;
  onLog?: AgentRuntimeRunInput['onLog'];
  emitUiEvent?: AgentRuntimeRunInput['emitUiEvent'];
  runId?: string;
  threadId?: string;
  providerId?: string;
  model?: string;
  maxIterations?: number;
  toolLoopGuard?: {
    maxConsecutiveSameToolCalls?: number;
    maxConsecutiveSameToolResults?: number;
  };
}): Promise<PiPromptSessionResult> {
  const { session, prompt, attachments, abortSignal, onLog, emitUiEvent, runId, threadId, providerId, model } = input;
  let assistantText = '';
  let loopCount = 0;
  let activeLoop = 0;
  let toolResultCount = 0;
  let maxIterationsExceeded = false;
  let forcedStopError = '';
  let thinkingTextLength = 0;
  let lastThinkingActivityLength = 0;
  let visibleAssistantText = '';
  const inlineThinkFilter = createInlineThinkStreamFilter();
  const maxLoopCount = normalizeMaxIterations(input.maxIterations);
  const toolLoopGuard = createToolLoopGuard({
    maxConsecutiveSameToolCalls: input.toolLoopGuard?.maxConsecutiveSameToolCalls,
    maxConsecutiveSameToolResults: input.toolLoopGuard?.maxConsecutiveSameToolResults
  });
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === 'turn_start') {
      activeLoop = typeof event.turnIndex === 'number' ? event.turnIndex + 1 : loopCount + 1;
      loopCount = Math.max(loopCount, activeLoop);
      if (maxLoopCount && activeLoop > maxLoopCount) {
        maxIterationsExceeded = true;
        stopPiSession(session);
        return;
      }
      emitPiRuntimeActivity(emitUiEvent, {
        id: `pi-turn-${activeLoop}`,
        runId,
        threadId,
        kind: 'thinking',
        status: 'running',
        title: `LLM loop #${activeLoop} request started`,
        detail: 'AgentSession is preparing a model turn.'
      });
      onLog?.({
        scope: 'agent-loop',
        message: `LLM loop #${activeLoop} request started`,
        data: buildTurnRequestSnapshot(session, prompt, activeLoop)
      });
      return;
    }

    if (event.type === 'turn_end') {
      const resolvedLoop = typeof event.turnIndex === 'number' ? event.turnIndex + 1 : activeLoop || loopCount || 1;
      loopCount = Math.max(loopCount, resolvedLoop);
      if (maxLoopCount && resolvedLoop > maxLoopCount) {
        maxIterationsExceeded = true;
        stopPiSession(session);
        return;
      }
      if (Array.isArray(event.toolResults)) {
        toolResultCount += event.toolResults.length;
      }
      const repeatedToolCall = toolLoopGuard.recordTurn(event?.message, event?.toolResults);
      if (repeatedToolCall) {
        forcedStopError = [
          `检测到模型连续重复执行相同工具调用，已停止当前 run 以避免 Agent loop。`,
          `工具：${repeatedToolCall.toolName}`,
          `连续次数：${repeatedToolCall.count}`,
          repeatedToolCall.sameResultCount > 1 ? `相同结果连续次数：${repeatedToolCall.sameResultCount}` : '',
          `参数：${repeatedToolCall.argumentsJson}`
        ].filter(Boolean).join('\n');
        emitPiRuntimeActivity(emitUiEvent, {
          id: `pi-turn-${resolvedLoop}-repeated-tool-loop`,
          runId,
          threadId,
          kind: 'thinking',
          status: 'failed',
          title: 'Stopped repeated tool-call loop',
          detail: forcedStopError
        });
        onLog?.({
          scope: 'agent-loop',
          message: 'pi prompt loop: stopped repeated tool-call loop',
          data: {
            loopNumber: resolvedLoop,
            toolName: repeatedToolCall.toolName,
            count: repeatedToolCall.count,
            sameResultCount: repeatedToolCall.sameResultCount,
            arguments: repeatedToolCall.arguments,
            argumentsJson: repeatedToolCall.argumentsJson,
            resultPreview: repeatedToolCall.resultPreview
          }
        });
        stopPiSession(session);
      }
      emitPiRuntimeActivity(emitUiEvent, {
        id: `pi-turn-${resolvedLoop}`,
        runId,
        threadId,
        kind: 'thinking',
        status: 'completed',
        title: `LLM loop #${resolvedLoop} reply completed`,
        detail: Array.isArray(event.toolResults) && event.toolResults.length > 0
          ? `${event.toolResults.length} tool result(s) returned.`
          : undefined
      });
      onLog?.({
        scope: 'agent-loop',
        message: `LLM loop #${resolvedLoop} reply completed`,
        data: buildTurnReplySnapshot(event, assistantText, resolvedLoop)
      });
      const usageRecord = recordPiMessageUsage({
        message: event?.message,
        runId,
        threadId,
        providerId,
        model
      });
      if (usageRecord) {
        onLog?.({
          scope: 'agent-loop',
          message: 'Pi message token usage recorded',
          data: {
            loopNumber: resolvedLoop,
            createdAt: usageRecord.createdAt,
            providerId: usageRecord.providerId,
            model: usageRecord.model,
            inputTokens: usageRecord.inputTokens,
            outputTokens: usageRecord.outputTokens,
            totalTokens: usageRecord.totalTokens
          }
        });
      }
      activeLoop = resolvedLoop;
      return;
    }

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_start') {
      thinkingTextLength = 0;
      lastThinkingActivityLength = 0;
      emitPiRuntimeActivity(emitUiEvent, {
        id: `pi-turn-${activeLoop || loopCount || 1}-thinking`,
        runId,
        threadId,
        kind: 'thinking',
        status: 'running',
        title: 'Model reasoning stream started',
        detail: 'Provider is streaming reasoning_content / thinking tokens.'
      });
      return;
    }

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') {
      const delta = String(event.assistantMessageEvent.delta ?? '');
      thinkingTextLength += delta.length;
      if (thinkingTextLength - lastThinkingActivityLength >= 256) {
        lastThinkingActivityLength = thinkingTextLength;
        emitPiRuntimeActivity(emitUiEvent, {
          id: `pi-turn-${activeLoop || loopCount || 1}-thinking`,
          runId,
          threadId,
          kind: 'thinking',
          status: 'running',
          title: 'Model reasoning stream in progress',
          detail: `${thinkingTextLength} reasoning characters received.`
        });
      }
      return;
    }

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_end') {
      emitPiRuntimeActivity(emitUiEvent, {
        id: `pi-turn-${activeLoop || loopCount || 1}-thinking`,
        runId,
        threadId,
        kind: 'thinking',
        status: 'completed',
        title: 'Model reasoning stream completed',
        detail: `${thinkingTextLength} reasoning characters received.`
      });
      return;
    }

    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const delta = String(event.assistantMessageEvent.delta ?? '');
      assistantText += delta;
      const inlineThink = inlineThinkFilter.push(delta);
      if (inlineThink.thinkingStarted) {
        emitPiRuntimeActivity(emitUiEvent, {
          id: `pi-turn-${activeLoop || loopCount || 1}-inline-thinking`,
          runId,
          threadId,
          kind: 'thinking',
          status: 'running',
          title: 'Model inline thinking stream started',
          detail: 'Provider is streaming <think> content inside assistant text.'
        });
      }
      if (inlineThink.thinkingChars > 0) {
        thinkingTextLength += inlineThink.thinkingChars;
        if (thinkingTextLength - lastThinkingActivityLength >= 256) {
          lastThinkingActivityLength = thinkingTextLength;
          emitPiRuntimeActivity(emitUiEvent, {
            id: `pi-turn-${activeLoop || loopCount || 1}-inline-thinking`,
            runId,
            threadId,
            kind: 'thinking',
            status: 'running',
            title: 'Model inline thinking stream in progress',
            detail: `${thinkingTextLength} inline thinking characters hidden.`
          });
        }
      }
      if (inlineThink.thinkingEnded) {
        emitPiRuntimeActivity(emitUiEvent, {
          id: `pi-turn-${activeLoop || loopCount || 1}-inline-thinking`,
          runId,
          threadId,
          kind: 'thinking',
          status: 'completed',
          title: 'Model inline thinking stream completed',
          detail: `${thinkingTextLength} inline thinking characters hidden.`
        });
      }
      const displayDelta = cleanProviderChannelMarkers(inlineThink.visibleDelta);
      visibleAssistantText += displayDelta;
      const displayText = cleanProviderChannelMarkers(visibleAssistantText);
      if (displayDelta) {
        emitUiEvent?.('message.delta', {
          id: `assistant-stream-${runId ?? 'run'}`,
          runId,
          threadId,
          role: 'assistant',
          delta: displayDelta,
          content: displayText,
          createdAt: new Date().toISOString()
        });
      }
    }
  });

  try {
    throwIfAborted(abortSignal);
    emitPiRuntimeActivity(emitUiEvent, {
      id: 'pi-prompt',
      runId,
      threadId,
      kind: 'message',
      status: 'running',
      title: 'Prompting AgentSession',
      detail: `attachments=${attachments.length}`
    });
    onLog?.({
      scope: 'agent-loop',
      message: 'pi prompt loop: prompt started',
      data: {
        promptLength: prompt.length,
        initialRequest: buildPromptRequestSnapshot(session, prompt),
        attachmentCount: attachments.length,
        imageAttachmentCount: getImageContents(attachments).length
      }
    });
    const imageContents = getImageContents(attachments);
    const uninstallHttpLogger = installPiHttpLogger({ runId, threadId, providerId, model });
    try {
      const promptPromise = imageContents.length > 0 && typeof session.sendUserMessage === 'function'
        ? session.sendUserMessage([{ type: 'text', text: prompt }, ...imageContents])
        : session.prompt(prompt);
      await raceWithAbort(promptPromise, abortSignal, session);
    } finally {
      uninstallHttpLogger();
    }
    emitPiRuntimeActivity(emitUiEvent, {
      id: 'pi-prompt',
      runId,
      threadId,
      kind: 'message',
      status: 'completed',
      title: 'AgentSession prompt resolved',
      detail: `loopCount=${loopCount}`
    });
    onLog?.({
      scope: 'agent-loop',
      message: 'pi prompt loop: prompt resolved',
      data: {
        loopCount,
        assistantTextLength: assistantText.length
      }
    });
  } finally {
    unsubscribe?.();
  }

  if (maxIterationsExceeded) {
    throw new Error(`agent session exceeded maxIterations=${maxLoopCount}`);
  }

  if (forcedStopError) {
    throw new Error(forcedStopError);
  }

  if (!assistantText.trim()) {
    const lastAssistant = session.state?.messages?.filter((message: any) => message.role === 'assistant').at(-1);
    assistantText = coerceAssistantText(lastAssistant?.content);
  }

  if (!assistantText.trim()) {
    throw new CancelledError('agent session completed without assistant output');
  }

  return {
    assistantText: cleanProviderVisibleText(assistantText).trim(),
    loopCount,
    toolResultCount
  };
}

function cleanProviderVisibleText(value: string) {
  return cleanThinkTags(cleanProviderChannelMarkers(value));
}

function cleanProviderChannelMarkers(value: string) {
  return value
    .replace(/<\|channel>[^\n<]*(?:\n)?<channel\|>/g, '')
    .replace(/<\|channel>[^\n<]*(?:\n)?<\|channel>/g, '')
    .replace(/<\|channel>[^<]*$/g, '')
    .replace(/<channel\|>/g, '')
    .replace(/<\|channel>/g, '')
    .trimStart();
}

function cleanThinkTags(value: string) {
  return value
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/^[\s\S]*?<\/think>/gi, '')
    .trimStart();
}

function createInlineThinkStreamFilter() {
  let inThink = false;
  let pending = '';

  return {
    push(delta: string) {
      const input = pending + delta;
      pending = '';
      let index = 0;
      let visibleDelta = '';
      let thinkingChars = 0;
      let thinkingStarted = false;
      let thinkingEnded = false;

      while (index < input.length) {
        if (inThink) {
          const closeIndex = indexOfIgnoreCase(input, '</think>', index);
          if (closeIndex < 0) {
            thinkingChars += input.length - index;
            index = input.length;
            break;
          }
          thinkingChars += closeIndex - index;
          inThink = false;
          thinkingEnded = true;
          index = closeIndex + '</think>'.length;
          continue;
        }

        const nextLt = input.indexOf('<', index);
        if (nextLt < 0) {
          visibleDelta += input.slice(index);
          break;
        }

        visibleDelta += input.slice(index, nextLt);
        const remaining = input.slice(nextLt);
        if (startsWithIgnoreCase(remaining, '<think>')) {
          inThink = true;
          thinkingStarted = true;
          index = nextLt + '<think>'.length;
          continue;
        }
        if (startsWithIgnoreCase(remaining, '</think>')) {
          thinkingEnded = true;
          index = nextLt + '</think>'.length;
          continue;
        }
        if (isPotentialThinkTagPrefix(remaining)) {
          pending = remaining;
          break;
        }

        visibleDelta += input[nextLt];
        index = nextLt + 1;
      }

      return { visibleDelta, thinkingChars, thinkingStarted, thinkingEnded };
    }
  };
}

function startsWithIgnoreCase(value: string, prefix: string) {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function indexOfIgnoreCase(value: string, search: string, fromIndex: number) {
  return value.toLowerCase().indexOf(search.toLowerCase(), fromIndex);
}

function isPotentialThinkTagPrefix(value: string) {
  const lower = value.toLowerCase();
  return '<think>'.startsWith(lower) || '</think>'.startsWith(lower);
}

type ToolLoopGuardHit = {
  toolName: string;
  arguments: unknown;
  argumentsJson: string;
  count: number;
  sameResultCount: number;
  resultPreview: string;
};

const DEFAULT_MAX_CONSECUTIVE_SAME_TOOL_CALLS = 5;
const DEFAULT_MAX_CONSECUTIVE_SAME_TOOL_RESULTS = 3;

function createToolLoopGuard(options?: {
  maxConsecutiveSameToolCalls?: number;
  maxConsecutiveSameToolResults?: number;
}) {
  const maxConsecutiveSameToolCalls = normalizeLoopGuardLimit(
    options?.maxConsecutiveSameToolCalls,
    DEFAULT_MAX_CONSECUTIVE_SAME_TOOL_CALLS
  );
  const maxConsecutiveSameToolResults = normalizeLoopGuardLimit(
    options?.maxConsecutiveSameToolResults,
    DEFAULT_MAX_CONSECUTIVE_SAME_TOOL_RESULTS
  );
  let lastKey = '';
  let lastResultKey = '';
  let count = 0;
  let sameResultCount = 0;

  return {
    recordTurn(message: unknown, toolResults: unknown): ToolLoopGuardHit | null {
      const calls = extractToolCalls(message);
      if (calls.length === 0) return null;
      const resultsByCallId = indexToolResultsByCallId(toolResults);

      for (const call of calls) {
        if (shouldIgnoreToolLoopGuard(call.toolName)) {
          reset();
          continue;
        }

        const argumentsJson = stableJsonStringify(call.arguments);
        const key = `${call.toolName}:${argumentsJson}`;
        const resultText = stringifyToolResultContent(resultsByCallId.get(call.id));
        const resultKey = `${key}:${resultText}`;

        if (key === lastKey) {
          count += 1;
        } else {
          lastKey = key;
          count = 1;
        }

        if (resultKey === lastResultKey) {
          sameResultCount += 1;
        } else {
          lastResultKey = resultKey;
          sameResultCount = resultText ? 1 : 0;
        }

        if (count >= maxConsecutiveSameToolCalls || (resultText && sameResultCount >= maxConsecutiveSameToolResults)) {
          return {
            toolName: call.toolName,
            arguments: call.arguments,
            argumentsJson,
            count,
            sameResultCount,
            resultPreview: resultText.slice(0, 1000)
          };
        }
      }

      return null;
    }
  };

  function reset() {
    lastKey = '';
    lastResultKey = '';
    count = 0;
    sameResultCount = 0;
  }
}

function normalizeLoopGuardLimit(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(20, Math.floor(value)));
}

function extractToolCalls(message: unknown) {
  const calls: Array<{ id: string; toolName: string; arguments: unknown }> = [];
  if (!message || typeof message !== 'object') return calls;
  const record = message as Record<string, unknown>;

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== 'object') continue;
      const content = item as Record<string, unknown>;
      if (content.type !== 'toolCall') continue;
      const toolName = typeof content.name === 'string' ? content.name : '';
      if (!toolName) continue;
      calls.push({
        id: typeof content.id === 'string' ? content.id : '',
        toolName,
        arguments: content.arguments
      });
    }
  }

  if (Array.isArray(record.tool_calls)) {
    for (const item of record.tool_calls) {
      if (!item || typeof item !== 'object') continue;
      const call = item as Record<string, unknown>;
      const fn = call.function;
      const fnRecord = fn && typeof fn === 'object' ? fn as Record<string, unknown> : {};
      const toolName = typeof fnRecord.name === 'string' ? fnRecord.name : '';
      if (!toolName) continue;
      calls.push({
        id: typeof call.id === 'string' ? call.id : '',
        toolName,
        arguments: parseToolArguments(fnRecord.arguments)
      });
    }
  }

  return calls;
}

function indexToolResultsByCallId(toolResults: unknown) {
  const map = new Map<string, unknown>();
  if (!Array.isArray(toolResults)) return map;
  for (const result of toolResults) {
    if (!result || typeof result !== 'object') continue;
    const record = result as Record<string, unknown>;
    const id = typeof record.toolCallId === 'string'
      ? record.toolCallId
      : typeof record.tool_call_id === 'string'
        ? record.tool_call_id
        : '';
    if (id) map.set(id, record.content);
  }
  return map;
}

function stringifyToolResultContent(content: unknown) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') return String((item as { text: string }).text);
        if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') return String((item as { content: string }).content);
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return content == null ? '' : stableJsonStringify(content);
}

function parseToolArguments(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stableJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return String(value);
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortJsonValue(record[key]);
      return acc;
    }, {});
  }
  return value;
}

function shouldIgnoreToolLoopGuard(toolName: string) {
  return toolName === 'current_time';
}


function emitPiRuntimeActivity(
  emitUiEvent: AgentRuntimeRunInput['emitUiEvent'] | undefined,
  input: {
    id: string;
    runId?: string;
    threadId?: string;
    kind: 'thinking' | 'message';
    status: 'running' | 'completed' | 'failed';
    title: string;
    detail?: string;
  }
) {
  emitUiEvent?.('runtime.activity', {
    id: `${input.runId ?? 'run'}-${input.id}`,
    runId: input.runId,
    threadId: input.threadId,
    kind: input.kind,
    status: input.status,
    title: input.title,
    detail: input.detail,
    createdAt: new Date().toISOString(),
    completedAt: input.status === 'running' ? undefined : new Date().toISOString()
  });
}

function normalizeMaxIterations(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new CancelledError();
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, session: any) {
  if (signal.aborted) {
    stopPiSession(session);
    return Promise.reject(new CancelledError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      stopPiSession(session);
      reject(new CancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function stopPiSession(session: any) {
  for (const method of ['abort', 'cancel', 'stop'] as const) {
    if (typeof session?.[method] === 'function') {
      try {
        session[method]();
      } catch {
        // Best-effort only: OpenAgent already flips run state to cancelled.
      }
      return;
    }
  }
}

type PiPromptContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type PiImageContent = Extract<PiPromptContent, { type: 'image' }>;

function getImageContents(attachments: RuntimeAttachment[]): PiImageContent[] {
  return attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => {
      const source = typeof attachment.imageDataUrl === 'string' ? attachment.imageDataUrl : typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '';
      const parsed = parseDataUrlImage(source, attachment.mimeType);
      return parsed ? { type: 'image' as const, data: parsed.data, mimeType: parsed.mimeType } : null;
    })
    .filter((item): item is PiImageContent => Boolean(item));
}

function parseDataUrlImage(source: string, fallbackMimeType?: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(source);
  if (match) {
    return { mimeType: match[1] || fallbackMimeType || 'image/png', data: match[2] };
  }

  if (source && fallbackMimeType?.startsWith('image/')) {
    return { mimeType: fallbackMimeType, data: source };
  }

  return null;
}

function coerceAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text.trim();
  }

  return '';
}

function buildPromptRequestSnapshot(session: any, prompt: string) {
  return {
    prompt,
    promptLength: prompt.length,
    sessionMessages: summarizeSessionMessages(session?.state?.messages ?? session?.agent?.state?.messages ?? []),
    currentModel: summarizeCurrentModel(session),
    turnCount: session?.state?.turnCount ?? session?.agent?.state?.turnCount
  };
}

function buildTurnRequestSnapshot(session: any, prompt: string, loopNumber: number) {
  return {
    loopNumber,
    prompt,
    promptLength: prompt.length,
    requestMessages: summarizeSessionMessages(session?.state?.messages ?? session?.agent?.state?.messages ?? []),
    currentModel: summarizeCurrentModel(session),
    turnCount: session?.state?.turnCount ?? session?.agent?.state?.turnCount
  };
}

function buildTurnReplySnapshot(event: any, assistantText: string, loopNumber: number) {
  return {
    loopNumber,
    assistantText,
    assistantTextLength: assistantText.length,
    turnIndex: event?.turnIndex,
    message: summarizeSessionMessage(event?.message),
    toolResults: Array.isArray(event?.toolResults) ? event.toolResults.map((item: any) => summarizeToolResult(item)) : []
  };
}

function recordPiMessageUsage(input: {
  message: any;
  runId?: string;
  threadId?: string;
  providerId?: string;
  model?: string;
}) {
  const message = input.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const messageProvider = typeof message?.provider === 'string' ? message.provider : input.providerId;
  const messageApi = typeof message?.api === 'string' ? message.api : '';
  const shouldRecordFromMessage = messageProvider === 'openai-codex' || messageApi === 'openai-codex-responses';
  if (!shouldRecordFromMessage) {
    return null;
  }

  return recordModelUsage({
    source: 'pi-session-message',
    providerId: messageProvider,
    model: typeof message?.model === 'string' ? message.model : input.model,
    runId: input.runId,
    threadId: input.threadId,
    requestId: typeof message?.responseId === 'string'
      ? message.responseId
      : typeof message?.id === 'string'
        ? message.id
        : undefined,
    usage: {
      input: readUsageNumber(usage, 'input'),
      output: readUsageNumber(usage, 'output'),
      cacheRead: readUsageNumber(usage, 'cacheRead'),
      cacheWrite: readUsageNumber(usage, 'cacheWrite'),
      totalTokens: readUsageNumber(usage, 'totalTokens')
    }
  });
}

function readUsageNumber(usage: Record<string, unknown>, key: string) {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeSessionMessages(messages: any[]) {
  return messages.map((message) => summarizeSessionMessage(message));
}

function summarizeSessionMessage(message: any) {
  return {
    role: message?.role,
    type: message?.type,
    id: message?.id,
    toolCallId: message?.toolCallId,
    toolName: message?.toolName,
    content:
      typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
          : message?.content,
    isError: message?.isError,
    createdAt: message?.createdAt,
    contentLength:
      typeof message?.content === 'string'
        ? message.content.length
        : Array.isArray(message?.content)
          ? JSON.stringify(message.content).length
          : undefined
  };
}

function summarizeToolResult(toolResult: any) {
  return {
    toolCallId: toolResult?.toolCallId,
    name: toolResult?.name ?? toolResult?.toolName,
    isError: toolResult?.isError,
    content:
      typeof toolResult?.content === 'string'
        ? toolResult.content
        : Array.isArray(toolResult?.content)
          ? toolResult.content
          : toolResult?.content,
    contentLength:
      typeof toolResult?.content === 'string'
        ? toolResult.content.length
        : Array.isArray(toolResult?.content)
          ? JSON.stringify(toolResult.content).length
          : undefined
  };
}

function summarizeCurrentModel(session: any) {
  const model = session?.state?.model ?? session?.agent?.state?.model;
  if (!model) return null;

  return {
    provider: model.provider,
    model: model.model || model.id,
    id: model.id,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens
  };
}
