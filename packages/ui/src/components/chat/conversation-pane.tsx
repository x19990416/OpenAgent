import { Download, FileImage, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MessageItem } from '@openagent/shared-types/events';
import { MessageList } from './message-list';
import type { SettingsTab } from '../../types/workbench';

interface ConversationPaneProps {
  messages: MessageItem[];
  threadTitle?: string;
  onOpenSettings?: (tab: SettingsTab) => void;
}

type ExportFormat = 'pdf' | 'png';

export function ConversationPane({ messages, threadTitle, onOpenSettings }: ConversationPaneProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const exportContentRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastRenderKeyRef = useRef<string>('');
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const latestMessage = messages[messages.length - 1] ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderKey = latestMessage ? `${latestMessage.id}:${latestMessage.content.length}` : 'empty';
    if (renderKey === lastRenderKeyRef.current) {
      return;
    }
    lastRenderKeyRef.current = renderKey;

    const shouldForceScroll = latestMessage?.role === 'user';
    if (!shouldStickToBottomRef.current && !shouldForceScroll) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: shouldForceScroll ? 'smooth' : 'auto'
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [latestMessage]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom <= 48;
  };

  const exportSession = async (format: ExportFormat) => {
    if (!window.desktopApi?.exportSession) {
      console.warn('desktopApi.exportSession is unavailable');
      return;
    }

    const content = exportContentRef.current;
    if (!content || messages.length === 0) {
      return;
    }

    setExportingFormat(format);
    try {
      const result = await window.desktopApi.exportSession({
        format,
        title: threadTitle || 'OpenAgent 会话',
        html: buildExportHtml(content, threadTitle || 'OpenAgent 会话', messages),
        suggestedName: buildSuggestedName(threadTitle || 'openagent-session')
      });

      if (!result?.ok && !result?.cancelled) {
        console.error('exportSession failed', result?.error || 'Unknown error');
      }
    } catch (error) {
      console.error('exportSession failed', error);
    } finally {
      setExportingFormat(null);
    }
  };

  return (
    <section ref={containerRef} className="conversation-pane scroll-y" onScroll={handleScroll}>
      <div className="conversation-export-bar" aria-label="导出当前会话">
        <div className="conversation-export-dropdown">
          <button className="conversation-export-trigger" type="button" disabled={messages.length === 0 || exportingFormat !== null}>
            <Download size={14} />
            <span>{exportingFormat ? '导出中…' : '导出会话'}</span>
          </button>
          <div className="conversation-export-menu" role="menu">
            <button className="conversation-export-menu-item" type="button" role="menuitem" disabled={messages.length === 0 || exportingFormat !== null} onClick={() => void exportSession('pdf')}>
              <FileText size={15} />
              <span>导出为 PDF</span>
            </button>
            <button className="conversation-export-menu-item" type="button" role="menuitem" disabled={messages.length === 0 || exportingFormat !== null} onClick={() => void exportSession('png')}>
              <FileImage size={15} />
              <span>导出为图片</span>
            </button>
          </div>
        </div>
      </div>
      <div ref={exportContentRef} className="conversation-export-content">
        <MessageList messages={messages} onOpenSettings={onOpenSettings} />
      </div>
    </section>
  );
}

function buildExportHtml(content: HTMLElement, title: string, messages: MessageItem[]) {
  const styles = collectDocumentStyles();
  const exportedAt = new Date().toLocaleString('zh-CN');
  const exportedContentHtml = buildExportContentHtml(content, messages);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${styles}
</head>
<body class="conversation-export-document">
  <main class="conversation-export-page">
    <header class="conversation-export-document-header">
      <div class="conversation-export-document-kicker">OpenAgent Session Export</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="conversation-export-document-meta">导出时间：${escapeHtml(exportedAt)}</div>
    </header>
    ${exportedContentHtml}
  </main>
</body>
</html>`;
}

function buildExportContentHtml(content: HTMLElement, messages: MessageItem[]) {
  const clone = content.cloneNode(true) as HTMLElement;
  const messageCards = Array.from(clone.querySelectorAll<HTMLElement>('.message-card'));

  messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    const skillLabel = message.skillDisplayName || message.skillName;
    if (!skillLabel) return;

    const card = messageCards[index];
    if (!card) return;

    const existingMetaLine = card.querySelector<HTMLElement>('.message-meta-line');
    if (existingMetaLine) {
      existingMetaLine.dataset.exportRequired = 'true';
      return;
    }

    const metaLine = document.createElement('div');
    metaLine.className = 'message-meta-line';
    metaLine.dataset.exportRequired = 'true';
    metaLine.setAttribute('title', `已指定 Skill：${skillLabel}`);

    const label = document.createElement('span');
    label.textContent = '已指定 Skill：';

    const strong = document.createElement('strong');
    strong.textContent = skillLabel;

    metaLine.append(label, strong);
    card.appendChild(metaLine);
  });

  return clone.innerHTML;
}


function collectDocumentStyles() {
  const rules: string[] = [];
  Array.from(document.styleSheets).forEach((sheet) => {
    try {
      rules.push(...Array.from(sheet.cssRules).map((rule) => rule.cssText));
    } catch {
      const ownerNode = sheet.ownerNode;
      if (ownerNode instanceof HTMLStyleElement) {
        rules.push(ownerNode.textContent || '');
      }
    }
  });

  return `<style>${rules.join('\n')}</style>`;
}

function buildSuggestedName(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'openagent-session';
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
