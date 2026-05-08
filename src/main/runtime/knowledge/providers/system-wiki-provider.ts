import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  KnowledgeGraphResult,
  KnowledgeHealthResult,
  KnowledgeIngestInput,
  KnowledgeIngestResult,
  KnowledgeLintResult,
  KnowledgeProvider,
  KnowledgeQueryInput,
  KnowledgeResult
} from '../knowledge-types.js';

const MAX_FILE_BYTES = 80_000;

export class SystemWikiProvider implements KnowledgeProvider {
  readonly source = 'system-wiki' as const;

  constructor(private readonly root: string) {}

  search(input: KnowledgeQueryInput): Promise<KnowledgeResult[]> {
    this.ensureReady();
    const query = input.query.trim();
    if (!query) return Promise.resolve([]);

    const limit = normalizeLimit(input.limit, 5, 20);
    const terms = tokenize(query);
    const files = this.listWikiMarkdownFiles();
    const results = files
      .map((filePath) => {
        const content = safeReadText(filePath, MAX_FILE_BYTES);
        const score = scoreContent(content, terms);
        return {
          id: path.relative(this.wikiDir, filePath),
          title: extractTitle(content) || path.basename(filePath, '.md'),
          source: this.source,
          content: excerpt(content, terms),
          score,
          path: filePath,
          citations: [path.relative(this.root, filePath)]
        } satisfies KnowledgeResult;
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);

    return Promise.resolve(results);
  }

  ingest(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult> {
    this.ensureReady();
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title || !content) {
      return Promise.resolve({ ok: false, source: this.source, message: 'title and content are required' });
    }

    const slug = slugify(input.sourceId || title);
    const today = new Date().toISOString().slice(0, 10);
    const rawPath = path.join(this.rawDir, `${slug}.md`);
    const sourcePath = path.join(this.sourcesDir, `${slug}.md`);
    const sourceContent = [
      '---',
      `title: "${escapeYaml(title)}"`,
      'type: source',
      `tags: [${(input.tags ?? []).map((tag) => `"${escapeYaml(tag)}"`).join(', ')}]`,
      `date: ${today}`,
      `source_file: raw/${slug}.md`,
      '---',
      '',
      '## Summary',
      firstParagraph(content),
      '',
      '## Key Claims',
      ...content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- ') || line.startsWith('* '))
        .slice(0, 8)
        .map((line) => `- ${line.replace(/^[-*]\s*/, '')}`),
      '',
      '## Connections',
      '',
      '## Contradictions',
      ''
    ].join('\n');

    writeFileSync(rawPath, `${content}\n`, 'utf8');
    writeFileSync(sourcePath, `${sourceContent}\n`, 'utf8');
    this.upsertIndexEntry(title, slug);
    this.appendLog(`## [${today}] ingest | ${title}`);
    this.updateOverview(title, slug, content);

    return Promise.resolve({
      ok: true,
      source: this.source,
      id: slug,
      path: sourcePath,
      message: `System wiki ingested source "${title}".`
    });
  }

  health(): Promise<KnowledgeHealthResult> {
    this.ensureReady();
    const wikiFiles = this.listWikiMarkdownFiles();
    const sourceFiles = safeList(this.sourcesDir).filter((name) => name.endsWith('.md'));
    const index = safeReadText(this.indexPath);
    const log = safeReadText(this.logPath);
    return Promise.resolve({
      ok: true,
      source: this.source,
      message: `System wiki is ready with ${wikiFiles.length} markdown pages and ${sourceFiles.length} source pages.`,
      data: {
        root: this.root,
        wikiFiles: wikiFiles.length,
        sourceFiles: sourceFiles.length,
        hasIndex: index.length > 0,
        hasLog: log.length > 0
      }
    });
  }

  lint(): Promise<KnowledgeLintResult> {
    this.ensureReady();
    const pages = this.listWikiMarkdownFiles();
    const pageByName = new Map(pages.map((filePath) => [pageNameForPath(filePath), filePath]));
    const linksByPage = new Map<string, string[]>();
    const inboundCount = new Map<string, number>();
    const brokenLinks: Array<{ from: string; link: string }> = [];
    const sparsePages: string[] = [];

    for (const filePath of pages) {
      const pageName = pageNameForPath(filePath);
      const content = safeReadText(filePath);
      const links = extractWikiLinks(content);
      linksByPage.set(pageName, links);
      if (links.length < 2 && !filePath.endsWith('index.md') && !filePath.endsWith('log.md')) {
        sparsePages.push(path.relative(this.wikiDir, filePath));
      }
      for (const link of links) {
        const normalizedLink = normalizeWikiLink(link);
        if (!pageByName.has(normalizedLink)) {
          brokenLinks.push({ from: path.relative(this.wikiDir, filePath), link });
        } else {
          inboundCount.set(normalizedLink, (inboundCount.get(normalizedLink) ?? 0) + 1);
        }
      }
    }

    const orphans = pages
      .map((filePath) => ({ filePath, pageName: pageNameForPath(filePath) }))
      .filter(({ filePath, pageName }) => !filePath.endsWith('index.md') && !filePath.endsWith('overview.md') && !filePath.endsWith('log.md') && !inboundCount.has(pageName))
      .map(({ filePath }) => path.relative(this.wikiDir, filePath));

    const report = [
      '# System Wiki Lint Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      `- Pages: ${pages.length}`,
      `- Broken links: ${brokenLinks.length}`,
      `- Orphan pages: ${orphans.length}`,
      `- Sparse pages: ${sparsePages.length}`,
      '',
      '## Broken Links',
      ...(brokenLinks.length ? brokenLinks.map((item) => `- ${item.from} -> [[${item.link}]]`) : ['- None']),
      '',
      '## Orphan Pages',
      ...(orphans.length ? orphans.map((item) => `- ${item}`) : ['- None']),
      '',
      '## Sparse Pages',
      ...(sparsePages.length ? sparsePages.map((item) => `- ${item}`) : ['- None']),
      ''
    ].join('\n');
    const reportPath = path.join(this.wikiDir, 'lint-report.md');
    writeFileSync(reportPath, report, 'utf8');

    return Promise.resolve({
      ok: brokenLinks.length === 0,
      source: this.source,
      message: `System wiki lint completed: ${brokenLinks.length} broken links, ${orphans.length} orphan pages, ${sparsePages.length} sparse pages.`,
      reportPath,
      data: { pages: pages.length, brokenLinks, orphans, sparsePages }
    });
  }

  buildGraph(): Promise<KnowledgeGraphResult> {
    this.ensureReady();
    const pages = this.listWikiMarkdownFiles();
    const pageByName = new Map(pages.map((filePath) => [pageNameForPath(filePath), filePath]));
    const nodes = pages.map((filePath) => ({
      id: pageNameForPath(filePath),
      label: extractTitle(safeReadText(filePath)) || pageNameForPath(filePath),
      path: path.relative(this.wikiDir, filePath)
    }));
    const edges = pages.flatMap((filePath) => {
      const from = pageNameForPath(filePath);
      return extractWikiLinks(safeReadText(filePath))
        .map(normalizeWikiLink)
        .filter((to) => pageByName.has(to))
        .map((to) => ({ from, to, type: 'EXTRACTED' }));
    });
    const graph = { built: new Date().toISOString(), nodes, edges };
    const graphJsonPath = path.join(this.graphDir, 'graph.json');
    const graphHtmlPath = path.join(this.graphDir, 'graph.html');
    writeFileSync(graphJsonPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    writeFileSync(graphHtmlPath, buildGraphHtml(graph), 'utf8');

    return Promise.resolve({
      ok: true,
      source: this.source,
      message: `System wiki graph built with ${nodes.length} nodes and ${edges.length} edges.`,
      graphJsonPath,
      graphHtmlPath,
      data: { nodes: nodes.length, edges: edges.length }
    });
  }

  private ensureReady() {
    mkdirSync(this.rawDir, { recursive: true });
    mkdirSync(this.sourcesDir, { recursive: true });
    mkdirSync(path.join(this.wikiDir, 'entities'), { recursive: true });
    mkdirSync(path.join(this.wikiDir, 'concepts'), { recursive: true });
    mkdirSync(path.join(this.wikiDir, 'syntheses'), { recursive: true });
    mkdirSync(path.join(this.root, 'graph'), { recursive: true });

    if (!existsSync(this.indexPath)) {
      writeFileSync(
        this.indexPath,
        ['# Wiki Index', '', '## Overview', '- [Overview](overview.md) — living synthesis', '', '## Sources', '', '## Entities', '', '## Concepts', '', '## Syntheses', ''].join('\n'),
        'utf8'
      );
    }
    if (!existsSync(this.overviewPath)) {
      writeFileSync(this.overviewPath, '# Overview\n\nSystem wiki has been initialized.\n', 'utf8');
    }
    if (!existsSync(this.logPath)) {
      writeFileSync(this.logPath, '# Wiki Log\n', 'utf8');
    }
  }

  private listWikiMarkdownFiles() {
    return walkMarkdown(this.wikiDir).filter((filePath) => statSync(filePath).size <= MAX_FILE_BYTES);
  }

  private upsertIndexEntry(title: string, slug: string) {
    const entry = `- [${title}](sources/${slug}.md) — source page`;
    const current = safeReadText(this.indexPath);
    if (current.includes(`](sources/${slug}.md)`)) return;
    const marker = '## Sources';
    const next = current.includes(marker) ? current.replace(marker, `${marker}\n${entry}`) : `${current.trim()}\n\n${marker}\n${entry}\n`;
    writeFileSync(this.indexPath, `${next.trim()}\n`, 'utf8');
  }

  private appendLog(line: string) {
    const current = safeReadText(this.logPath);
    writeFileSync(this.logPath, `${current.trim()}\n\n${line}\n`, 'utf8');
  }

  private updateOverview(title: string, slug: string, content: string) {
    const current = safeReadText(this.overviewPath);
    const line = `- [[${title}]] from sources/${slug}.md — ${firstParagraph(content).slice(0, 160)}`;
    if (current.includes(`sources/${slug}.md`)) return;
    writeFileSync(this.overviewPath, `${current.trim()}\n${line}\n`, 'utf8');
  }

  private get rawDir() {
    return path.join(this.root, 'raw');
  }

  private get wikiDir() {
    return path.join(this.root, 'wiki');
  }

  private get sourcesDir() {
    return path.join(this.wikiDir, 'sources');
  }

  private get indexPath() {
    return path.join(this.wikiDir, 'index.md');
  }

  private get overviewPath() {
    return path.join(this.wikiDir, 'overview.md');
  }

  private get logPath() {
    return path.join(this.wikiDir, 'log.md');
  }

  private get graphDir() {
    return path.join(this.root, 'graph');
  }
}

function walkMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...walkMarkdown(filePath));
    if (entry.isFile() && entry.name.endsWith('.md')) results.push(filePath);
  }
  return results;
}

function safeList(dir: string) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadText(filePath: string, maxBytes = MAX_FILE_BYTES) {
  try {
    return readFileSync(filePath, 'utf8').slice(0, maxBytes);
  } catch {
    return '';
  }
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function scoreContent(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  return terms.reduce((score, term) => score + countOccurrences(lower, term), 0);
}

function countOccurrences(value: string, term: string) {
  let count = 0;
  let index = value.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function excerpt(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 240);
  return content.slice(start, start + 1200).trim();
}

function extractTitle(content: string) {
  const frontmatterTitle = content.match(/^title:\s*"?([^"\n]+)"?/m)?.[1];
  if (frontmatterTitle) return frontmatterTitle.trim();
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
}

function extractWikiLinks(content: string) {
  return [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function normalizeWikiLink(value: string) {
  return value.split('|')[0].split('#')[0].trim().replace(/\.md$/i, '');
}

function pageNameForPath(filePath: string) {
  return path.basename(filePath, '.md');
}

function buildGraphHtml(graph: { nodes: Array<{ id: string; label: string; path: string }>; edges: Array<{ from: string; to: string; type: string }> }) {
  const data = JSON.stringify(graph).replace(/</g, '\\u003c');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>OpenAgent System Wiki Graph</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
    header { padding: 16px 20px; background: #fff; border-bottom: 1px solid #e2e8f0; }
    main { padding: 20px; }
    .node { margin: 0 8px 8px 0; display: inline-flex; padding: 8px 10px; border-radius: 999px; background: #dbeafe; color: #1e3a8a; }
    .edge { color: #475569; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 4px 0; }
  </style>
</head>
<body>
  <header>
    <strong>OpenAgent System Wiki Graph</strong>
    <div id="summary"></div>
  </header>
  <main>
    <h2>Nodes</h2>
    <div id="nodes"></div>
    <h2>Edges</h2>
    <div id="edges"></div>
  </main>
  <script>
    const graph = ${data};
    document.getElementById('summary').textContent = graph.nodes.length + ' nodes · ' + graph.edges.length + ' edges';
    document.getElementById('nodes').innerHTML = graph.nodes.map((node) => '<span class="node" title="' + node.path + '">' + node.label + '</span>').join('');
    document.getElementById('edges').innerHTML = graph.edges.map((edge) => '<div class="edge">' + edge.from + ' -> ' + edge.to + '</div>').join('');
  </script>
</body>
</html>
`;
}

function firstParagraph(content: string) {
  return (
    content
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? content.slice(0, 280)
  );
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `source-${Date.now()}`;
}

function escapeYaml(value: string) {
  return value.replace(/"/g, '\\"');
}

function normalizeLimit(value: unknown, fallback: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}
