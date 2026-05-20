import type { AgentRuntimeRunInput, RuntimeAttachment } from '../runtime-types.js';
import { CancelledError } from '../errors.js';

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
  maxIterations?: number;
}): Promise<PiPromptSessionResult> {
  const { session, prompt, attachments, abortSignal, onLog, emitUiEvent, runId, threadId } = input;
  let assistantText = '';
  let loopCount = 0;
  let activeLoop = 0;
  let toolResultCount = 0;
  let maxIterationsExceeded = false;
  let thinkingTextLength = 0;
  let lastThinkingActivityLength = 0;
  const maxLoopCount = normalizeMaxIterations(input.maxIterations);
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
      const displayText = cleanProviderChannelMarkers(assistantText);
      const displayDelta = cleanProviderChannelMarkers(delta);
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
    const promptPromise = imageContents.length > 0 && typeof session.sendUserMessage === 'function'
      ? session.sendUserMessage([{ type: 'text', text: prompt }, ...imageContents])
      : session.prompt(prompt);
    await raceWithAbort(promptPromise, abortSignal, session);
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

  if (!assistantText.trim()) {
    const lastAssistant = session.state?.messages?.filter((message: any) => message.role === 'assistant').at(-1);
    assistantText = coerceAssistantText(lastAssistant?.content);
  }

  if (!assistantText.trim()) {
    throw new CancelledError('agent session completed without assistant output');
  }

  return {
    assistantText: cleanProviderChannelMarkers(assistantText).trim(),
    loopCount,
    toolResultCount
  };
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
