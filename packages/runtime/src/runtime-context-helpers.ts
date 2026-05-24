import type { RuntimeLogEntry, RuntimeThread } from './runtime-types.js';
import path from 'node:path';
import { existsSync } from 'node:fs';

export function selectRelevantMemoryContext(memory: string, prompt: string) {
  const queryTerms = tokenizeMemoryQuery(prompt);
  if (queryTerms.length === 0) return '';
  const sections = splitMemorySections(memory);
  return sections
    .map((section) => ({ section, score: scoreMemorySection(section, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.section.trim())
    .join('\n\n---\n\n')
    .slice(0, 6000);
}

function splitMemorySections(memory: string) {
  const normalized = memory.trim();
  if (!normalized) return [];
  const parts = normalized.split(/\n(?=##\s+)/g).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [normalized];
}

function scoreMemorySection(section: string, queryTerms: string[]) {
  const haystack = section.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? term.length : 0), 0);
}

function tokenizeMemoryQuery(prompt: string) {
  const stopwords = new Set([
    'wiki',
    '知识库',
    '保存',
    '存到',
    '分析',
    '图片',
    '文件',
    '这个',
    '一下',
    '帮我',
    '当前',
    '执行',
    'tool',
    'agent'
  ]);
  const asciiTerms = prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  const chineseTerms = prompt.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  return [...new Set([...asciiTerms, ...chineseTerms].map((term) => term.trim()).filter((term) => term && !stopwords.has(term)))];
}

export function summarizeProgressLogEntry(entry: RuntimeLogEntry) {
  if (entry.scope === 'context') return '完成运行上下文构建';

  if (entry.scope === 'agent-loop') {
    if (entry.message.includes('resolve model context')) return '解析模型与 provider 配置';
    if (entry.message.includes('prepare agent session managers')) return '准备 agent session 管理器和资源加载器';
    if (entry.message.includes('create AgentSession')) return '创建 AgentSession，并注入 OpenAgent tools';
    if (entry.message.includes('prompt session')) return '提交用户请求到 AgentSession';
    if (entry.message.includes('prompt resolved')) return '模型与工具循环已结束';
    if (entry.message.includes('raw response body saved')) return '保存模型原始响应日志';
  }

  if (entry.scope === 'runtime') {
    const data = entry.data as { toolName?: string; contentLength?: number; durationMs?: number } | undefined;
    if (entry.message === 'tool execution started') return `执行 tool：${data?.toolName ?? 'unknown'}`;
    if (entry.message === 'tool execution completed') return `tool 完成：${data?.toolName ?? 'unknown'}，返回 ${data?.contentLength ?? 0} 字符`;
    if (entry.message === 'tool execution failed') return `tool 失败：${data?.toolName ?? 'unknown'}`;
    if (entry.message.includes('SOUL.md')) return '处理长期记忆更新';
  }

  return null;
}

export function resolvePromptContextMode(input: { prompt: string; hasSelectedSkill: boolean; hasActivePlan: boolean; attachmentsCount: number }): { transcriptMode: 'recent' | 'tool_minimal'; reason: string } {
  if (isContextDependentPrompt(input.prompt)) {
    return { transcriptMode: 'recent', reason: 'current prompt explicitly depends on prior conversation context' };
  }

  if (input.hasActivePlan) {
    return { transcriptMode: 'tool_minimal', reason: 'active plan provides structured task state without replaying prior transcript' };
  }

  if (input.hasSelectedSkill) {
    return { transcriptMode: 'tool_minimal', reason: 'selected skill run should route tools from current prompt and skill context' };
  }

  if (input.attachmentsCount > 0 && looksLikeDirectToolAction(input.prompt)) {
    return { transcriptMode: 'tool_minimal', reason: 'current prompt plus current attachments are sufficient for tool routing' };
  }

  if (looksLikeDirectToolAction(input.prompt)) {
    return { transcriptMode: 'tool_minimal', reason: 'current prompt is an explicit tool/action request' };
  }

  return { transcriptMode: 'recent', reason: 'conversation answer may need recent transcript continuity' };
}

function isContextDependentPrompt(prompt: string) {
  const value = prompt.trim().toLowerCase();
  if (!value) return false;
  return /(^|[\s，。,.!?！？])(继续|接着|上面|刚才|前面|之前|那个|这个|它|它们|按你说的|就这样|照这个|照刚才|再来|重试|修正一下|改成|换成)([\s，。,.!?！？]|$)/i.test(value) ||
    /\b(continue|that|it|those|previous|above|same|retry|again)\b/i.test(value);
}

function looksLikeDirectToolAction(prompt: string) {
  const value = prompt.trim().toLowerCase();
  if (!value) return false;
  return /(读取|查看|列出|搜索|查找|统计|执行|运行|调用|安装|写入|创建|修改|修复|生成|保存|摄取|导入|导出|发送|打开|删除|提交|push|构建|编译|测试|打包|转换|分析附件|处理附件|落实到文档|进行开发|工具调用|skill|插件|知识库|wiki|命令|脚本|文件|目录|路径|日志|报错|typecheck|build|install|run|test|grep|find|read|write|shell|commit)/i.test(value);
}

export function sortThreadsForDisplay(threads: RuntimeThread[]) {
  return [...threads].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.createdAt);
    const bTime = Date.parse(b.updatedAt || b.createdAt);
    return normalizeTime(bTime) - normalizeTime(aTime);
  });
}

function normalizeTime(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function sanitizeAttachmentName(name: string) {
  const cleaned = name.replace(/[/:\\]/g, '-').replace(/\0/g, '').trim();
  return cleaned || `attachment-${Date.now()}`;
}

export function uniquePath(preferredPath: string) {
  if (!existsSync(preferredPath)) return preferredPath;
  const dir = path.dirname(preferredPath);
  const extension = path.extname(preferredPath);
  const base = path.basename(preferredPath, extension);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.join(dir, `${base}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${extension}`);
}

export function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return Buffer.from(dataUrl, 'utf8');
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  return isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
}
