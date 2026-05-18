import { Bot, Check, Copy, Download, File, FileImage, FileText, FolderOpen, Package, User } from 'lucide-react';
import { isValidElement, useEffect, useId, useState } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';
import type { PromptAttachmentDescriptor } from '@shared-types/index';
import type { MessageItem } from '@shared-types/events';
import type { SettingsTab } from '@/types/workbench';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

let mermaidRenderSequence = 0;

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function MessageList({ messages, onOpenSettings }: { messages: MessageItem[]; onOpenSettings?: (tab: SettingsTab) => void }) {
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
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre: ({ children, ...props }) => {
                      const mermaidChart = getMermaidChartFromPre(children);
                      if (mermaidChart) return <MermaidDiagram chart={mermaidChart} />;
                      return <CodeBlock>{children}</CodeBlock>;
                    },
                    a: ({ href, children, ...props }) => {
                      if (href === '#/settings/models' || href?.startsWith('#/settings/')) {
                        const tab = href.replace('#/settings/', '') as SettingsTab;
                        return (
                          <a
                            href={href}
                            className="markdown-action-link"
                            onClick={(event) => {
                              event.preventDefault();
                              onOpenSettings?.(tab);
                            }}
                          >
                            {children}
                          </a>
                        );
                      }
                      return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
                    }
                  }}
                >
                  {normalizeMarkdownContent(message.content)}
                </ReactMarkdown>
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

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = reactNodeToText(children).replace(/\n$/, '');

  async function copyCode() {
    try {
      await copyTextToClipboard(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="markdown-code-block">
      <button className="markdown-code-copy" type="button" onClick={() => void copyCode()} aria-label="复制代码" title={copied ? '已复制' : '复制代码'}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function MermaidDiagram({ chart }: { chart: string }) {
  const reactId = useId();
  const [state, setState] = useState<{ status: 'loading' | 'rendered' | 'failed'; svg?: string; error?: string }>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const renderId = `openagent-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}-${++mermaidRenderSequence}`;

    async function renderMermaid() {
      try {
        setState({ status: 'loading' });
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
          flowchart: {
            htmlLabels: true,
            useMaxWidth: true
          }
        });
        const result = await mermaid.render(renderId, chart);
        if (!cancelled) setState({ status: 'rendered', svg: result.svg });
      } catch (error) {
        if (!cancelled) setState({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }

    void renderMermaid();
    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  async function copyMermaidSource() {
    try {
      await copyTextToClipboard(chart);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  async function saveMermaidImage() {
    if (state.status !== 'rendered' || !state.svg) return;
    try {
      const dataUrl = await renderSvgToPngDataUrl(state.svg);
      const result = await window.desktopApi?.saveImage?.({
        dataUrl,
        suggestedName: buildMermaidImageFileName(chart)
      });
      if (result?.ok) {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1600);
      }
    } catch (error) {
      window.desktopApi?.logDiagnostic?.('warn', 'Mermaid image save failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (state.status === 'rendered' && state.svg) {
    return (
      <div className="mermaid-diagram">
        <button className="markdown-code-copy mermaid-save-button" type="button" onClick={() => void saveMermaidImage()} aria-label="保存 Mermaid 图片" title={saved ? '已保存' : '保存为 PNG 图片'}>
          {saved ? <Check size={14} /> : <Download size={14} />}
        </button>
        <button className="markdown-code-copy mermaid-copy-button" type="button" onClick={() => void copyMermaidSource()} aria-label="复制 Mermaid 源码" title={copied ? '已复制' : '复制 Mermaid 源码'}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <div className="mermaid-diagram-svg" dangerouslySetInnerHTML={{ __html: state.svg }} />
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="mermaid-diagram-fallback">
        <div className="mermaid-diagram-error">Mermaid 渲染失败：{state.error}</div>
        <CodeBlock><code>{chart}</code></CodeBlock>
      </div>
    );
  }

  return <div className="mermaid-diagram is-loading">正在渲染 Mermaid 图表…</div>;
}

async function renderSvgToPngDataUrl(svg: string) {
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(svgBlob);
  try {
    const image = await loadImage(objectUrl);
    const size = getSvgImageSize(svg, image);
    const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 2));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(size.width * scale);
    canvas.height = Math.ceil(size.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Mermaid SVG image load failed'));
    image.src = src;
  });
}

function getSvgImageSize(svg: string, image: HTMLImageElement) {
  const fallbackWidth = image.naturalWidth || 960;
  const fallbackHeight = image.naturalHeight || 540;
  try {
    const documentSvg = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const viewBox = documentSvg.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
    if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
      return { width: viewBox[2], height: viewBox[3] };
    }
    const width = parseSvgLength(documentSvg.getAttribute('width')) || fallbackWidth;
    const height = parseSvgLength(documentSvg.getAttribute('height')) || fallbackHeight;
    return { width, height };
  } catch {
    return { width: fallbackWidth, height: fallbackHeight };
  }
}

function parseSvgLength(value: string | null) {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildMermaidImageFileName(chart: string) {
  const firstLine = chart.split('\n').map((line) => line.trim()).find(Boolean) || 'mermaid-diagram';
  return `mermaid-${firstLine.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'diagram'}.png`;
}

function getMermaidChartFromPre(children: ReactNode) {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return '';
  const element = child as ReactElement<{ className?: string; children?: ReactNode }>;
  const className = element.props.className ?? '';
  if (!/\blanguage-mermaid\b/.test(className)) return '';
  return reactNodeToText(element.props.children).replace(/\n$/, '').trim();
}

function reactNodeToText(input: ReactNode): string {
  if (typeof input === 'string' || typeof input === 'number') return String(input);
  if (Array.isArray(input)) return input.map(reactNodeToText).join('');
  if (isValidElement(input)) {
    const element = input as ReactElement<{ children?: ReactNode }>;
    return reactNodeToText(element.props.children);
  }
  return '';
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
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
