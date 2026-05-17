import { Bot, File, FileImage, FileText, FolderOpen, Package, User } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { PromptAttachmentDescriptor } from '@shared-types/index';
import type { MessageItem } from '@shared-types/events';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function MessageList({ messages }: { messages: MessageItem[] }) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="message-list">
      {messages.map((message) => {
        const isUser = message.role === 'user';
        const Icon = isUser ? User : Bot;
        const selectedSkillLabel = message.skillDisplayName || message.skillName || null;

        return (
          <article key={message.id} className={`message-card ${message.role}`}>
            <div className="message-head">
              <Icon size={14} />
              <span>{isUser ? '你' : 'Agent'}</span>
              <span>·</span>
              <span>{formatTime(message.createdAt)}</span>
            </div>
            <div className="message-body markdown-content">
              {normalizeMarkdownContent(message.content) ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdownContent(message.content)}</ReactMarkdown>
              ) : null}
              {message.attachments && message.attachments.length > 0 ? (
                <div className="message-attachments">
                  {message.attachments.map((attachment) => (
                    <PromptAttachmentCard key={attachment.id} attachment={attachment} />
                  ))}
                </div>
              ) : null}
            </div>
            {isUser && selectedSkillLabel ? (
              <div className="message-meta-line" title={`已指定 Skill：${selectedSkillLabel}`}>
                <Package size={13} />
                <span>已指定 Skill：</span>
                <strong>{selectedSkillLabel}</strong>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function PromptAttachmentCard({ attachment }: { attachment: PromptAttachmentDescriptor }) {
  const Icon = attachment.kind === 'image' ? FileImage : attachment.kind === 'text' ? FileText : File;
  const meta = [attachment.kind === 'image' ? '图片' : attachment.kind === 'text' ? '文本' : '文件', formatFileSize(attachment.size)]
    .filter(Boolean)
    .join(' · ');

  async function handleOpen() {
    if (!window.desktopApi?.openPromptAttachment) {
      return;
    }
    await window.desktopApi.openPromptAttachment({ path: attachment.path, action: 'open' });
  }

  async function handleReveal(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!window.desktopApi?.openPromptAttachment) {
      return;
    }
    await window.desktopApi.openPromptAttachment({ path: attachment.path, action: 'reveal' });
  }

  return (
    <div
      className="message-attachment-card"
      role="button"
      tabIndex={0}
      onClick={() => void handleOpen()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void handleOpen();
        }
      }}
      title={attachment.path}
    >
      {attachment.kind === 'image' && attachment.imageDataUrl ? (
        <div className="message-attachment-preview">
          <img src={attachment.imageDataUrl} alt={attachment.name} />
        </div>
      ) : (
        <div className="message-attachment-icon">
          <Icon size={18} />
        </div>
      )}
      <div className="message-attachment-copy">
        <div className="message-attachment-name">{attachment.name}</div>
        <div className="message-attachment-meta">{meta}</div>
      </div>
      <button className="message-attachment-action" type="button" onClick={(event) => void handleReveal(event)} title="在 Finder 中显示">
        <FolderOpen size={16} />
      </button>
    </div>
  );
}

function normalizeMarkdownContent(content: unknown) {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text;
  }

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
