import type { RuntimeAttachment, RuntimeMessage } from '../runtime-types.js';

export const MAX_RECENT_TRANSCRIPT_MESSAGES = 16;
export const MAX_TOOL_MINIMAL_TRANSCRIPT_MESSAGES = 0;
export const MAX_TRANSCRIPT_MESSAGE_CHARS = 12_000;
export const MAX_TEXT_ATTACHMENT_PREVIEW_CHARS = 2_000;
const INVALID_TEXT_TOOL_CALL_SUMMARY = '[OpenAgent note: a previous assistant message contained an invalid text-form tool invocation. The text was removed from replay context; no tool executed from that text.]';
const TOOL_ARGUMENT_REPAIR_SUMMARY = '[OpenAgent note: a previous structured tool call had unsafe or invalid arguments. The verbose repair prompt was removed from replay context.]';

export interface PiPromptBuildOptions {
  transcriptMode?: 'recent' | 'tool_minimal';
  transcriptReason?: string;
}

export function buildPiPrompt(systemPrompt: string, userPrompt: string, messages: RuntimeMessage[], attachments: RuntimeAttachment[], options: PiPromptBuildOptions = {}) {
  const transcriptMode = options.transcriptMode ?? 'recent';
  const recentTranscript = transcriptMode === 'tool_minimal' ? '' : formatRecentTranscript(messages, userPrompt, MAX_RECENT_TRANSCRIPT_MESSAGES);
  const sessionContext = transcriptMode === 'tool_minimal'
    ? formatToolMinimalSessionContext(options.transcriptReason)
    : ['下面是当前 OpenAgent thread 的最近对话上下文。回答时必须延续这些上下文；如果用户说“好的”“继续”“就这样”等省略表达，应结合最近对话理解。', recentTranscript || '(当前 thread 还没有可用历史消息。)'].join('\n');
  return [
    '<openagent-system-instructions>',
    systemPrompt,
    '</openagent-system-instructions>',
    '',
    '<openagent-session-context>',
    sessionContext,
    '</openagent-session-context>',
    '',
    '<openagent-current-attachments>',
    formatCurrentAttachments(attachments) || '(本轮没有附件。)',
    '</openagent-current-attachments>',
    '',
    '<user-prompt>',
    userPrompt,
    '</user-prompt>'
  ].join('\n');
}


function formatToolMinimalSessionContext(reason?: string) {
  return [
    'Tool routing mode: minimal current-run context.',
    `Reason: ${reason || 'current prompt can be routed without replaying prior transcript'}.`,
    'The older chat transcript is intentionally not injected into this prompt for tool-call selection.',
    'Use the current user prompt, current attachments, system prompt, selected skill, active plan, allowed tool schemas, and runtime policy as the source of truth for tool intent and arguments.',
    'Do not infer high-risk tool arguments such as paths, commands, recipients, accounts, credentials, or destructive actions from older chat history unless the current prompt explicitly refers to prior context.',
    'If required arguments are missing, ask a concise clarification question or use a safe read-only tool to inspect current workspace facts.'
  ].join('\n');
}

function formatCurrentAttachments(attachments: RuntimeAttachment[]) {
  return attachments
    .map((attachment, index) => {
      const parts = [
        `${index + 1}. name=${attachment.name}`,
        `kind=${attachment.kind}`,
        attachment.mimeType ? `mimeType=${attachment.mimeType}` : '',
        Number.isFinite(attachment.size) ? `size=${attachment.size} bytes` : '',
        attachment.path ? `path=${attachment.path}` : '',
        attachment.kind === 'image' && (attachment.imageDataUrl || attachment.dataUrl) ? 'imagePayload=attached-to-current-message' : '',
        attachment.kind === 'text' && attachment.textContent ? `textPreview=${truncateText(attachment.textContent, MAX_TEXT_ATTACHMENT_PREVIEW_CHARS)}` : ''
      ].filter(Boolean);
      return parts.join('; ');
    })
    .join('\n');
}

function formatRecentTranscript(messages: RuntimeMessage[], currentPrompt: string, limit: number) {
  const historyMessages =
    messages.at(-1)?.role === 'user' && messages.at(-1)?.content.trim() === currentPrompt.trim()
      ? messages.slice(0, -1)
      : messages;
  const recentMessages = historyMessages.slice(-limit);
  return recentMessages
    .map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
      const content = truncateText(sanitizeModelReplayText(message.content).trim(), MAX_TRANSCRIPT_MESSAGE_CHARS);
      const attachments = formatTranscriptAttachments(message.attachments ?? []);
      if (!content && !attachments) return '';
      return `<message role="${role}">\n${content}${attachments ? `\n${attachments}` : ''}\n</message>`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function formatTranscriptAttachments(attachments: RuntimeAttachment[]) {
  if (attachments.length === 0) return '';
  return [
    '<attachments>',
    ...attachments.map((attachment, index) => {
      const parts = [
        `${index + 1}. name=${attachment.name}`,
        `kind=${attachment.kind}`,
        attachment.mimeType ? `mimeType=${attachment.mimeType}` : '',
        Number.isFinite(attachment.size) ? `size=${attachment.size} bytes` : '',
        attachment.path ? `path=${attachment.path}` : ''
      ].filter(Boolean);
      return parts.join('; ');
    }),
    '</attachments>'
  ].join('\n');
}

function truncateText(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

export function sanitizeModelReplayText(value: string) {
  let text = String(value || '');

  if (containsTextFormToolInvocation(text)) {
    return summarizeInvalidToolText(text);
  }

  if (isToolArgumentRepairPrompt(text)) {
    return TOOL_ARGUMENT_REPAIR_SUMMARY;
  }

  text = stripOpenAgentWrappedPrompt(text);
  text = stripOpenAgentMetadata(text);
  text = stripInlineThinkTags(text);
  text = redactProviderMarkerTokens(text);
  return text;
}

export function sanitizePiSessionMessages(messages: unknown[]) {
  return messages.map((message) => sanitizePiSessionMessage(message));
}

function sanitizePiSessionMessage(message: unknown) {
  if (!message || typeof message !== 'object') return message;
  const record = { ...(message as Record<string, unknown>) };
  record.content = sanitizePiMessageContent(record.content);
  return record;
}

function sanitizePiMessageContent(content: unknown): unknown {
  if (typeof content === 'string') return sanitizeModelReplayText(content);
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const record = { ...(item as Record<string, unknown>) };
      if (typeof record.text === 'string') record.text = sanitizeModelReplayText(record.text);
      if (typeof record.content === 'string') record.content = sanitizeModelReplayText(record.content);
      return record;
    });
  }
  return content;
}

function containsTextFormToolInvocation(text: string) {
  if (!text) return false;
  if (/<\|?tool_call\|?>|<tool_call\|>/.test(text)) return true;
  return /\bcall:[A-Za-z_$][A-Za-z0-9_$-]*\s*\{/.test(text);
}

function isToolArgumentRepairPrompt(text: string) {
  return text.includes('OpenAgent received your structured tool call') &&
    (text.includes('arguments were not safe to execute') || text.includes('Missing or empty required JSON fields'));
}

function summarizeInvalidToolText(text: string) {
  const toolName = /(?:call:)?([A-Za-z_$][A-Za-z0-9_$-]*)\s*\{/s.exec(text)?.[1];
  return toolName
    ? `${INVALID_TEXT_TOOL_CALL_SUMMARY} Intended tool name: ${toolName}.`
    : INVALID_TEXT_TOOL_CALL_SUMMARY;
}

function stripOpenAgentWrappedPrompt(text: string) {
  if (!text.includes('<openagent-system-instructions>') && !text.includes('<user-prompt>')) {
    return text;
  }

  const userPrompt = extractXmlLikeBlock(text, 'user-prompt');
  if (userPrompt) return `Previous user prompt: ${userPrompt.trim()}`;

  return text
    .replace(/<openagent-system-instructions>[\s\S]*?<\/openagent-system-instructions>/g, '[OpenAgent system instructions omitted from replay]')
    .replace(/<openagent-session-context>[\s\S]*?<\/openagent-session-context>/g, '[OpenAgent prior session context omitted from replay]')
    .replace(/<openagent-current-attachments>[\s\S]*?<\/openagent-current-attachments>/g, '[OpenAgent attachment context omitted from replay]');
}

function stripOpenAgentMetadata(text: string) {
  return text.replace(/<!--\s*openagent:metadata[\s\S]*?-->/g, '').trim();
}

function stripInlineThinkTags(text: string) {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/^[\s\S]*?<\/think>/gi, '')
    .trim();
}

function redactProviderMarkerTokens(text: string) {
  return text
    .replace(/<\|"?\|>/g, '[provider-marker]')
    .replace(/<\|/g, '[provider-marker-start]')
    .replace(/\|>/g, '[provider-marker-end]');
}

function extractXmlLikeBlock(text: string, tag: string) {
  const match = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?<\\/${tag}>`).exec(text);
  return match?.[1] ?? '';
}
