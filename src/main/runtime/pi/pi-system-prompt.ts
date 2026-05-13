import type { RuntimeAttachment, RuntimeMessage } from '../runtime-types.js';

export const MAX_RECENT_TRANSCRIPT_MESSAGES = 16;
export const MAX_TRANSCRIPT_MESSAGE_CHARS = 12_000;
export const MAX_TEXT_ATTACHMENT_PREVIEW_CHARS = 2_000;

export function buildPiPrompt(systemPrompt: string, userPrompt: string, messages: RuntimeMessage[], attachments: RuntimeAttachment[]) {
  const recentTranscript = formatRecentTranscript(messages, userPrompt);
  return [
    '<openagent-system-instructions>',
    systemPrompt,
    '</openagent-system-instructions>',
    '',
    '<openagent-session-context>',
    '下面是当前 OpenAgent thread 的最近对话上下文。回答时必须延续这些上下文；如果用户说“好的”“继续”“就这样”等省略表达，应结合最近对话理解。',
    recentTranscript || '(当前 thread 还没有可用历史消息。)',
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

function formatRecentTranscript(messages: RuntimeMessage[], currentPrompt: string) {
  const historyMessages =
    messages.at(-1)?.role === 'user' && messages.at(-1)?.content.trim() === currentPrompt.trim()
      ? messages.slice(0, -1)
      : messages;
  const recentMessages = historyMessages.slice(-MAX_RECENT_TRANSCRIPT_MESSAGES);
  return recentMessages
    .map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
      const content = truncateText(message.content.trim(), MAX_TRANSCRIPT_MESSAGE_CHARS);
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
