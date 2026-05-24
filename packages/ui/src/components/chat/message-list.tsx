import { Bot, Check, Copy, Download, File, FileImage, FileText, FolderOpen, ImageIcon, Package, User } from 'lucide-react';
import { isValidElement, useEffect, useId, useState } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';
import type { PromptAttachmentDescriptor } from '@openagent/shared-types/index';
import type { MessageItem } from '@openagent/shared-types/events';
import type { SettingsTab } from '../../types/workbench';
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
        const markdownContent = normalizeMarkdownContent(message.content);

        return (
          <article key={message.id} className={`message-card ${message.role}`}>
            <div className="message-head">
              <Icon size={14} />
              <span>{isUser ? '你' : 'Agent'}</span>
              <span>·</span>
              <span>{formatTime(message.createdAt)}</span>
            </div>
            <div className="message-body markdown-content">
              {markdownContent ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre: ({ children, ...props }) => {
                      const mermaidChart = getMermaidChartFromPre(children);
                      if (mermaidChart) return <MermaidDiagram chart={mermaidChart} />;
                      return <CodeBlock>{children}</CodeBlock>;
                    },
                    code: ({ children, className, ...props }) => {
                      const text = reactNodeToText(children).trim();
                      const localPath = cleanLocalPathCandidate(text);
                      if (!className && localPath) {
                        return <LocalPathCode path={localPath} label={text} />;
                      }
                      return <code className={className} {...props}>{children}</code>;
                    },
                    img: ({ src, alt, ...props }) => {
                      if (typeof src === 'string' && cleanImageCandidate(src)) return null;
                      return <img src={src} alt={alt ?? ''} {...props} />;
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
                  {markdownContent}
                </ReactMarkdown>
              ) : null}
              <LocalImagePreviewGallery content={markdownContent} />
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

function LocalPathCode({ path, label }: { path: string; label: string }) {
  async function revealLocalPath(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const result = await window.desktopApi?.openPromptAttachment?.({ path, action: 'reveal' });
    if (result && !result.ok) {
      window.desktopApi?.logDiagnostic?.('warn', 'reveal local path failed', { path, error: result.error });
    }
  }

  return (
    <button
      className="markdown-local-path"
      type="button"
      title={`在 Finder 中显示：${path}`}
      onClick={(event) => void revealLocalPath(event)}
    >
      <code>{label}</code>
      <FolderOpen size={13} aria-hidden="true" />
    </button>
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

  async function saveMermaidSvg() {
    if (state.status !== 'rendered' || !state.svg) return;
    try {
      const exportSvg = prepareSvgForExport(state.svg);
      const dataUrl = svgToDataUrl(exportSvg);
      const result = await window.desktopApi?.saveImage?.({
        dataUrl,
        format: 'svg',
        mimeType: 'image/svg+xml',
        suggestedName: buildMermaidImageFileName(chart)
      });
      if (result?.ok) {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1600);
      } else if (result && !result.cancelled) {
        window.desktopApi?.logDiagnostic?.('warn', 'Mermaid image save returned failure', result);
      }
    } catch (error) {
      window.desktopApi?.logDiagnostic?.('warn', 'Mermaid image save failed', {
        format: 'svg',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (state.status === 'rendered' && state.svg) {
    return (
      <div className="mermaid-diagram">
        <button
          className="markdown-code-copy mermaid-save-button"
          type="button"
          onClick={() => void saveMermaidSvg()}
          aria-label="保存 Mermaid SVG 图片"
          title={saved ? 'SVG 已保存' : '保存为 SVG 图片'}
        >
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

function prepareSvgForExport(svg: string) {
  const trimmed = svg.trim();
  const svgStart = trimmed.indexOf('<svg');
  const svgEnd = trimmed.lastIndexOf('</svg>');
  const rawSvg = svgStart >= 0 && svgEnd >= 0 ? trimmed.slice(svgStart, svgEnd + '</svg>'.length) : trimmed;
  const xmlSafeSvg = rawSvg
    .replace(/<br\s*\/?>\s*<\/br>/gi, '<br/>')
    .replace(/<br(\s[^>/]*)?>/gi, (_match, attrs = '') => `<br${attrs}/>`);
  const withXmlns = xmlSafeSvg.replace(
    /^<svg\b([^>]*)>/i,
    (match, attrs: string) => {
      let nextAttrs = attrs;
      if (!/\sxmlns=/.test(nextAttrs)) nextAttrs += ' xmlns="http://www.w3.org/2000/svg"';
      if (!/\sxmlns:xlink=/.test(nextAttrs)) nextAttrs += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
      return `<svg${nextAttrs}>`;
    }
  );
  return withXmlns.startsWith('<?xml') ? withXmlns : `<?xml version="1.0" encoding="UTF-8"?>\n${withXmlns}`;
}

function svgToDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildMermaidImageFileName(chart: string) {
  const firstLine = chart.split('\n').map((line) => line.trim()).find(Boolean) || 'mermaid-diagram';
  return `mermaid-${firstLine.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'diagram'}.svg`;
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


interface LocalImagePreviewItem {
  source: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  dataUrl: string;
}

function LocalImagePreviewGallery({ content }: { content: string }) {
  const candidates = extractLocalImageCandidates(content);
  const [items, setItems] = useState<LocalImagePreviewItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreviews() {
      if (!window.desktopApi?.previewImage || candidates.length === 0) {
        setItems([]);
        return;
      }

      const results = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            const result = await window.desktopApi?.previewImage?.({ path: candidate });
            if (!result?.ok || !result.dataUrl || !result.path) return null;
            return {
              source: candidate,
              path: result.path,
              name: result.name || candidate.split(/[\\/]/).pop() || candidate,
              size: result.size || 0,
              mimeType: result.mimeType || 'image/*',
              dataUrl: result.dataUrl
            } satisfies LocalImagePreviewItem;
          } catch {
            return null;
          }
        })
      );

      if (!cancelled) {
        setItems(results.filter((item): item is LocalImagePreviewItem => Boolean(item)));
      }
    }

    void loadPreviews();
    return () => {
      cancelled = true;
    };
  }, [candidates.join('\n')]);

  if (items.length === 0) return null;

  return (
    <div className="message-local-image-previews" aria-label="图片预览">
      {items.map((item) => (
        <LocalImagePreviewCard key={item.path} item={item} />
      ))}
    </div>
  );
}

function LocalImagePreviewCard({ item }: { item: LocalImagePreviewItem }) {
  async function handleOpen() {
    await window.desktopApi?.openPromptAttachment?.({ path: item.path, action: 'open' });
  }

  async function handleReveal(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    await window.desktopApi?.openPromptAttachment?.({ path: item.path, action: 'reveal' });
  }

  return (
    <div
      className="message-local-image-card"
      role="button"
      tabIndex={0}
      title={item.path}
      onClick={() => void handleOpen()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void handleOpen();
        }
      }}
    >
      <div className="message-local-image-frame">
        <img src={item.dataUrl} alt={item.name} />
      </div>
      <div className="message-local-image-footer">
        <span className="message-local-image-name"><ImageIcon size={14} />{item.name}</span>
        <span className="message-local-image-meta">{formatFileSize(item.size) || item.mimeType}</span>
        <button className="message-attachment-action" type="button" onClick={(event) => void handleReveal(event)} title="在 Finder 中显示">
          <FolderOpen size={16} />
        </button>
      </div>
    </div>
  );
}

function extractLocalImageCandidates(content: string) {
  if (!content) return [];
  const candidates = new Set<string>();
  const imageExtPattern = String.raw`(?:png|jpe?g|gif|webp|avif|svg)`;
  const quotedPattern = new RegExp(String.raw`[` + '`' + String.raw`"']([^` + '`' + String.raw`"'\n]+\.(?:${imageExtPattern}))(?:#[^` + '`' + String.raw`"'\n]*)?[` + '`' + String.raw`"']`, 'gi');
  const markdownImagePattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  const absolutePattern = new RegExp(String.raw`((?:~|\/|[A-Za-z]:[\\/])[^\s)\]}>]+\.(?:${imageExtPattern}))`, 'gi');

  for (const pattern of [markdownImagePattern, quotedPattern, absolutePattern]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      const value = cleanImageCandidate(match[1]);
      if (value) candidates.add(value);
    }
  }

  return Array.from(candidates).slice(0, 6);
}

function cleanImageCandidate(value: string) {
  const cleaned = value.trim().replace(/^file:\/\//i, '').replace(/[.,;:，。；：]+$/u, '');
  if (/^https?:\/\//i.test(cleaned) || /^data:/i.test(cleaned)) return '';
  if (!/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(cleaned)) return '';
  return cleaned;
}

function cleanLocalPathCandidate(value: string) {
  const cleaned = value.trim().replace(/^file:\/\//i, '').replace(/[.,;:，。；：]+$/u, '');
  if (/^https?:\/\//i.test(cleaned) || /^data:/i.test(cleaned)) return '';
  if (!/^(?:~\/|\/|[A-Za-z]:[\\/])/.test(cleaned)) return '';
  if (/\n/.test(cleaned) || cleaned.length > 500) return '';
  return cleaned;
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
