import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  KnowledgeArticle,
  KnowledgeArticleReadResult,
  KnowledgeBrowseSnapshot,
  KnowledgeCaptureDraft,
  KnowledgeCompileInput,
  KnowledgeCompileItem,
  KnowledgeCompileResult,
  KnowledgeCompileTier,
  KnowledgeConcept,
  KnowledgeGraphInput,
  KnowledgeGraphResult,
  KnowledgeHealthResult,
  KnowledgeIngestFileInput,
  KnowledgeIngestInput,
  KnowledgeIngestResult,
  KnowledgeLintResult,
  KnowledgeManifest,
  KnowledgeOriginalFile,
  KnowledgeProvider,
  KnowledgeProviderDescriptor,
  KnowledgeProvenance,
  KnowledgeQueryInput,
  KnowledgeRelation,
  KnowledgeResult,
  KnowledgeSearchInput,
  KnowledgeSourceKind,
  KnowledgeSourceRecord,
  KnowledgeSourceSummary
} from '../knowledge-types.js';
import { extractOfficeText, extractPdfText } from '../archive-text-extractor.js';
import type { KnowledgeLlm } from '../knowledge-llm.js';

const PROVIDER_ID = 'system';
const PROVIDER_SOURCE = 'openagent-system-compiler';
const MANIFEST_VERSION = 1 as const;
const MAX_TEXT_BYTES = 1_000_000;
const MAX_SEARCH_FILE_BYTES = 120_000;
const DEFAULT_COMPILE_BATCH_SIZE = 4;

export class SystemKnowledgeProvider implements KnowledgeProvider {
  readonly source = PROVIDER_SOURCE;

  constructor(private readonly root: string, private readonly llm?: KnowledgeLlm) {}

  descriptor(): KnowledgeProviderDescriptor {
    return {
      id: PROVIDER_ID,
      kind: 'openagent-system-compiler',
      scope: 'system',
      displayName: 'OpenAgent System Knowledge Compiler',
      rootPath: this.root,
      capabilities: ['ingest', 'ingest_file', 'compile', 'compile_topic', 'search', 'query', 'capture', 'provenance', 'graph', 'health', 'lint']
    };
  }


  browse(): KnowledgeBrowseSnapshot {
    this.ensureReady();
    const manifest = this.readManifest();
    const quality = Object.values(manifest.sources)
      .map((source) => readJsonFile(path.join(this.qualityDir, `${source.id}.json`), null as KnowledgeBrowseSnapshot['quality'][number] | null))
      .filter((item): item is KnowledgeBrowseSnapshot['quality'][number] => Boolean(item));
    const qualityBySource = new Map(quality.map((item) => [item.sourceId, item]));
    const sources = Object.values(manifest.sources)
      .map((source) => {
        const item = manifest.compileItems[source.id];
        return {
          id: source.id,
          title: source.title,
          kind: source.kind,
          status: item?.status,
          tier: item?.tier,
          rawTextPath: source.rawTextPath,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          articleIds: item?.articleIds ?? [],
          quality: qualityBySource.get(source.id)
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const articles = Object.values(manifest.articles)
      .map((article) => ({ id: article.id, conceptId: article.conceptId, title: article.title, path: article.path, sourceIds: article.sourceIds, updatedAt: article.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      provider: this.descriptor(),
      root: this.root,
      sources,
      articles,
      pending: sources.filter((source) => source.status === 'pending' || source.status === 'failed'),
      quality
    };
  }

  readArticle(articleId: string): KnowledgeArticleReadResult {
    this.ensureReady();
    const manifest = this.readManifest();
    const article = manifest.articles[articleId] ?? Object.values(manifest.articles).find((item) => item.path === articleId || item.title === articleId);
    if (!article) return { ok: false, source: this.source, articleId, message: `Article not found: ${articleId}` };
    return { ok: true, source: this.source, articleId: article.id, title: article.title, path: article.path, content: safeReadText(article.path, MAX_TEXT_BYTES) };
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeResult[]> {
    this.ensureReady();
    const query = input.query.trim();
    if (!query) return [];
    const limit = normalizeLimit(input.limit, 8, 30);
    const expanded = await this.tryExpandQuery(query);
    const searchTexts = [query, ...(expanded?.queries ?? []), expanded?.hypotheticalAnswer ?? ''].filter(Boolean);
    const terms = unique(searchTexts.flatMap(tokenize));
    const records = this.collectSearchRecords();
    const ranked = rankRecords(records, terms, searchTexts, await this.tryEmbedText(searchTexts.join(' ')));
    const expandedRecords = this.expandWithGraph(ranked.slice(0, Math.max(limit, 12)), records, terms);
    const rerankedRecords = await this.tryRerank(query, expandedRecords.slice(0, Math.max(limit, 15)));
    return rerankedRecords.slice(0, limit).map((record) => ({
      id: record.id,
      title: record.title,
      source: this.source,
      content: excerpt(record.content, terms),
      score: record.score,
      path: record.path,
      citations: record.citations,
      metadata: record.metadata
    }));
  }

  async query(input: KnowledgeQueryInput) {
    const results = await this.search({ ...input, limit: input.limit ?? 8 });
    const contexts = results.map((result) => ({ id: result.id, title: result.title, content: result.content, path: result.path }));
    const llmAnswer = await this.tryAnswerWithCitations(input.query, contexts);
    if (llmAnswer) {
      return {
        answer: llmAnswer.answer,
        citations: results
          .filter((result) => llmAnswer.citedIds.includes(result.id) || llmAnswer.citedIds.includes(result.path ?? ''))
          .map((result) => ({ sourceId: result.id, path: result.path || result.citations?.[0], quote: result.content.slice(0, 220) })),
        usedSourceIds: results.map((result) => String(result.metadata?.sourceId || result.id)),
        usedArticleIds: results.map((result) => result.id).filter((id) => id.startsWith('article:')),
        confidence: llmAnswer.confidence
      } as const;
    }
    return {
      answer: results.length ? results.map((result, index) => `[${index + 1}] ${result.title}\n${result.content}`).join('\n\n') : 'No matching knowledge found.',
      citations: results.map((result) => ({ sourceId: result.id, path: result.path || result.citations?.[0], quote: result.content.slice(0, 220) })),
      usedSourceIds: results.map((result) => String(result.metadata?.sourceId || result.id)),
      usedArticleIds: results.map((result) => result.id).filter((id) => id.startsWith('article:')),
      confidence: results.length > 0 ? 'medium' : 'low'
    } as const;
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult> {
    this.ensureReady();
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title || !content) return { ok: false, source: this.source, message: 'title and content are required' };

    const hash = sha256(content);
    const manifest = this.readManifest();
    const duplicate = Object.values(manifest.sources).find((source) => source.hash === hash);
    if (duplicate) {
      return { ok: true, source: this.source, id: duplicate.id, rawPath: duplicate.rawTextPath, message: `Knowledge source already exists as "${duplicate.title}" (${duplicate.id}).` };
    }

    const id = uniqueSourceId(slugify(input.sourceId || title), manifest);
    const now = new Date().toISOString();
    const rawPath = path.join(this.rawDir, `${id}.md`);
    writeFileSync(rawPath, `${content}\n`, 'utf8');

    const sourceRecord: KnowledgeSourceRecord = {
      id,
      kind: input.originalFiles?.[0]?.mimeHint ? kindFromMimeOrPath(input.originalFiles[0].mimeHint, input.originalFiles[0].originalPath || input.originalFiles[0].path) : 'text',
      title,
      originalPath: input.originalFiles?.[0]?.originalPath,
      archivedPath: input.originalFiles?.[0]?.path,
      rawTextPath: rawPath,
      hash,
      createdAt: now,
      updatedAt: now,
      metadata: { tags: input.tags ?? [], originalFiles: input.originalFiles ?? [] }
    };

    manifest.sources[id] = sourceRecord;
    manifest.compileItems[id] = {
      sourceId: id,
      tier: input.tier ?? 3,
      status: 'pending'
    };
    this.writeManifest(manifest);
    this.appendCompileLog({ event: 'ingest', sourceId: id, title, createdAt: now });

    if (input.compile !== false) {
      const compiled = await this.compile({ scope: input.scope, sourceIds: [id], tier: input.tier ?? 3 });
      const refreshed = this.readManifest();
      const item = refreshed.compileItems[id];
      return {
        ok: compiled.ok,
        source: this.source,
        id,
        path: item?.articleIds?.[0] ? refreshed.articles[item.articleIds[0]]?.path : undefined,
        rawPath,
        summaryPath: item?.summaryId ? path.join(this.summariesDir, `${item.summaryId}.json`) : undefined,
        articlePaths: item?.articleIds?.map((articleId) => refreshed.articles[articleId]?.path).filter((value): value is string => Boolean(value)),
        originalFiles: input.originalFiles,
        message: compiled.ok ? `Knowledge source "${title}" ingested and compiled.` : `Knowledge source "${title}" ingested, but compile failed.`
      };
    }

    return { ok: true, source: this.source, id, rawPath, originalFiles: input.originalFiles, message: `Knowledge source "${title}" ingested as pending compile item.` };
  }

  async ingestFile(input: KnowledgeIngestFileInput): Promise<KnowledgeIngestResult> {
    this.ensureReady();
    const sourcePath = path.resolve(input.filePath);
    if (!existsSync(sourcePath)) return { ok: false, source: this.source, message: `File not found: ${sourcePath}` };
    const stats = statSync(sourcePath);
    if (!stats.isFile()) return { ok: false, source: this.source, message: `Not a file: ${sourcePath}` };

    const title = input.title?.trim() || path.basename(sourcePath, path.extname(sourcePath));
    const slug = slugify(input.sourceId || title);
    const archivedFile = this.archiveOriginalFile(sourcePath, slug, stats.size);
    const content = await this.buildFileIngestContent(sourcePath, archivedFile, stats.size);
    return this.ingest({
      scope: input.scope,
      title,
      content,
      sourceId: input.sourceId || slug,
      tags: input.tags,
      originalFiles: [archivedFile],
      compile: input.compile,
      tier: input.tier
    });
  }

  async compile(input: KnowledgeCompileInput): Promise<KnowledgeCompileResult> {
    this.ensureReady();
    const manifest = this.readManifest();
    const candidateIds = input.sourceIds?.length
      ? input.sourceIds
      : Object.values(manifest.compileItems)
          .filter((item) => item.status === 'pending' || item.status === 'failed')
          .map((item) => item.sourceId);
    const ids = candidateIds.slice(0, normalizeLimit(input.limit, candidateIds.length || 100, 500));
    const articlePaths: string[] = [];
    let compiled = 0;
    let skipped = 0;
    let failed = 0;

    for (const batch of chunkArray(ids, DEFAULT_COMPILE_BATCH_SIZE)) {
      this.appendCompileLog({ event: 'compile_batch_start', sourceIds: batch, createdAt: new Date().toISOString() });
      for (const sourceId of batch) {
        const source = manifest.sources[sourceId];
        if (!source) { skipped += 1; continue; }
        try {
          const item = await this.compileSource(manifest, source, input.tier ?? manifest.compileItems[sourceId]?.tier ?? 3);
          articlePaths.push(...(item.articleIds ?? []).map((articleId) => manifest.articles[articleId]?.path).filter((value): value is string => Boolean(value)));
          compiled += 1;
        } catch (error) {
          failed += 1;
          manifest.compileItems[sourceId] = { ...(manifest.compileItems[sourceId] ?? { sourceId, tier: input.tier ?? 3 }), status: 'failed', error: errorToMessage(error), lastCompiledAt: new Date().toISOString() };
        }
      }
      this.appendCompileLog({ event: 'compile_batch_end', sourceIds: batch, createdAt: new Date().toISOString() });
      this.writeManifest(manifest);
    }

    manifest.updatedAt = new Date().toISOString();
    this.writeManifest(manifest);
    await this.rebuildSearchIndex(manifest);
    const graph = this.buildGraphFromManifest(manifest);
    this.appendCompileLog({ event: 'compile', compiled, skipped, failed, sourceIds: ids, createdAt: new Date().toISOString() });
    return {
      ok: failed === 0,
      source: this.source,
      message: `Knowledge compile completed: ${compiled} compiled, ${skipped} skipped, ${failed} failed.`,
      compiled,
      skipped,
      failed,
      articlePaths,
      data: { graph: graph.data }
    };
  }

  async compileTopic(input: { scope: 'system'; topic: string; limit?: number; tier?: KnowledgeCompileTier }): Promise<KnowledgeCompileResult> {
    const manifest = this.readManifest();
    const terms = tokenize(input.topic);
    const matches = Object.values(manifest.sources)
      .map((source) => ({ source, content: safeReadText(source.rawTextPath || '', MAX_SEARCH_FILE_BYTES) }))
      .map((item) => ({ sourceId: item.source.id, score: scoreContent(`${item.source.title}\n${item.content}`, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, normalizeLimit(input.limit, 12, 50))
      .map((item) => item.sourceId);
    return this.compile({ scope: input.scope, sourceIds: matches, tier: input.tier ?? 3 });
  }

  async capture(input: { text: string }): Promise<KnowledgeCaptureDraft[]> {
    const text = input.text.trim();
    if (!text) return [];
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines
      .filter((line) => /决定|确认|规则|偏好|不要|需要|应该|结论|decision|prefer|rule/i.test(line))
      .slice(0, 8)
      .map((line, index) => ({
        id: `capture-${Date.now()}-${index + 1}`,
        kind: /偏好|prefer/i.test(line) ? 'preference' : /问题|question/i.test(line) ? 'open_question' : /规则|rule|应该|不要|需要/i.test(line) ? 'project_rule' : 'decision',
        title: line.slice(0, 48),
        content: line,
        reason: 'Conversation line looks durable enough to review for knowledge capture.',
        confidence: 'medium',
        evidence: line
      }));
  }

  async provenance(input: { targetId: string }): Promise<KnowledgeProvenance[]> {
    const files = safeList(this.provenanceDir).filter((name) => name.endsWith('.json'));
    return files
      .flatMap((name) => readJsonFile<KnowledgeProvenance[]>(path.join(this.provenanceDir, name), []))
      .filter((item) => item.targetId === input.targetId || item.sourceId === input.targetId);
  }

  async graph(_input?: KnowledgeGraphInput): Promise<KnowledgeGraphResult> {
    this.ensureReady();
    return this.buildGraphFromManifest(this.readManifest());
  }

  async health(): Promise<KnowledgeHealthResult> {
    this.ensureReady();
    const manifest = this.readManifest();
    const pending = Object.values(manifest.compileItems).filter((item) => item.status === 'pending').length;
    const failed = Object.values(manifest.compileItems).filter((item) => item.status === 'failed').length;
    return {
      ok: failed === 0,
      source: this.source,
      message: `Knowledge compiler is ready with ${Object.keys(manifest.sources).length} sources, ${Object.keys(manifest.articles).length} articles, ${pending} pending compile items.`,
      data: {
        root: this.root,
        provider: this.descriptor(),
        sources: Object.keys(manifest.sources).length,
        articles: Object.keys(manifest.articles).length,
        pending,
        failed,
        manifestPath: this.manifestPath,
        graphPath: path.join(this.graphDir, 'graph.json'),
        indexPath: path.join(this.indexDir, 'chunks.jsonl'),
        embeddingPath: path.join(this.indexDir, 'embeddings.jsonl')
      }
    };
  }

  async lint(): Promise<KnowledgeLintResult> {
    this.ensureReady();
    const manifest = this.readManifest();
    const issues: string[] = [];
    for (const source of Object.values(manifest.sources)) {
      if (source.rawTextPath && !existsSync(source.rawTextPath)) issues.push(`source ${source.id} missing raw text: ${source.rawTextPath}`);
      const item = manifest.compileItems[source.id];
      if (!item) issues.push(`source ${source.id} missing compile item`);
      if (item?.status === 'compiled' && !item.summaryId) issues.push(`compiled source ${source.id} missing summaryId`);
      const quality = readJsonFile<{ score?: number; issues?: string[] } | null>(path.join(this.qualityDir, `${source.id}.json`), null);
      if (quality && typeof quality.score === 'number' && quality.score < 60) issues.push(`source ${source.id} low quality score: ${quality.score}`);
      for (const articleId of item?.articleIds ?? []) {
        const article = manifest.articles[articleId];
        if (!article) issues.push(`source ${source.id} references missing article ${articleId}`);
        if (article && !existsSync(article.path)) issues.push(`article ${articleId} missing file: ${article.path}`);
      }
    }
    const reportPath = path.join(this.root, 'lint-report.md');
    writeFileSync(reportPath, ['# Knowledge Compiler Lint Report', '', `Generated: ${new Date().toISOString()}`, '', ...(issues.length ? issues.map((issue) => `- ${issue}`) : ['- None'])].join('\n'), 'utf8');
    return {
      ok: issues.length === 0,
      source: this.source,
      message: `Knowledge compiler lint completed: ${issues.length} issue(s).`,
      reportPath,
      data: { issues }
    };
  }

  private async compileSource(manifest: KnowledgeManifest, source: KnowledgeSourceRecord, tier: KnowledgeCompileTier): Promise<KnowledgeCompileItem> {
    const now = new Date().toISOString();
    const raw = safeReadText(source.rawTextPath || '', MAX_TEXT_BYTES);
    const summary = (await this.tryLlmSummary(source, raw)) ?? buildSummary(source, raw);
    const summaryPath = path.join(this.summariesDir, `${summary.id}.json`);
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    const graph = tier >= 3 ? await this.tryLlmConceptGraph(source, summary, raw) : null;
    const extractedConcepts = tier >= 3 ? graph?.concepts ?? buildConcepts(source, summary) : [];
    const concepts = this.mergeConcepts(extractedConcepts, source.id);
    const relations = tier >= 3 ? normalizeRelations(graph?.relations ?? buildRelations(concepts, source.id), concepts, source.id) : [];
    const articleIds: string[] = [];
    for (const concept of concepts) {
      const article = buildArticle(concept, source, summary, relations.filter((relation) => relation.sourceConceptId === concept.id || relation.targetConceptId === concept.id), this.wikiConceptsDir);
      concept.articleId = article.id;
      manifest.articles[article.id] = article;
      const body = (await this.tryLlmArticle(concept, summary, relations.filter((relation) => relation.sourceConceptId === concept.id || relation.targetConceptId === concept.id))) ?? renderArticleBody(concept, summary);
      writeFileSync(article.path, renderArticle(article, concept, summary, body), 'utf8');
      articleIds.push(article.id);
    }

    writeFileSync(path.join(this.conceptsDir, `${source.id}.json`), `${JSON.stringify({ sourceId: source.id, concepts, relations }, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(this.provenanceDir, `${source.id}.json`), `${JSON.stringify(buildProvenance(source, summary, concepts, relations), null, 2)}\n`, 'utf8');
    this.writeQualityReport(source, summary, concepts, relations, articleIds);

    const item: KnowledgeCompileItem = {
      sourceId: source.id,
      tier,
      status: tier === 0 ? 'indexed' : tier < 3 ? 'summarized' : 'compiled',
      summaryId: summary.id,
      conceptIds: concepts.map((concept) => concept.id),
      articleIds,
      lastCompiledAt: now
    };
    manifest.compileItems[source.id] = item;
    return item;
  }





  private mergeConcepts(concepts: KnowledgeConcept[], sourceId: string): KnowledgeConcept[] {
    const existing = this.loadExistingConcepts();
    const byKey = new Map<string, KnowledgeConcept>();
    for (const concept of existing) {
      byKey.set(normalizeConceptKey(concept.name), concept);
      for (const alias of concept.aliases) byKey.set(normalizeConceptKey(alias), concept);
    }
    return concepts.map((concept) => {
      const match = [concept.name, ...concept.aliases].map(normalizeConceptKey).map((key) => byKey.get(key)).find(Boolean);
      if (!match) return concept;
      return {
        ...concept,
        id: match.id,
        name: match.name,
        aliases: unique([...match.aliases, ...concept.aliases, concept.name].filter((alias) => alias !== match.name)),
        sourceIds: unique([...match.sourceIds, ...concept.sourceIds, sourceId]),
        articleId: match.articleId,
        confidence: confidenceRank(match.confidence) >= confidenceRank(concept.confidence) ? match.confidence : concept.confidence
      };
    });
  }

  private loadExistingConcepts(): KnowledgeConcept[] {
    return safeList(this.conceptsDir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => readJsonFile<{ concepts?: KnowledgeConcept[] }>(path.join(this.conceptsDir, name), {}).concepts ?? []);
  }

  private async tryRerank(query: string, records: Array<SearchRecord & { score: number }>): Promise<Array<SearchRecord & { score: number }>> {
    if (!this.llm?.rerank || records.length <= 1) return records;
    try {
      const rankings = await this.llm.rerank({ query, candidates: records.map((record) => ({ id: record.id, title: record.title, content: record.content })) });
      if (!rankings?.length) return records;
      const byId = new Map(records.map((record) => [record.id, record]));
      const rerankScore = new Map(rankings.map((item) => [item.id, item.score]));
      return records
        .map((record, index) => ({ ...record, score: record.score * 0.35 + (rerankScore.get(record.id) ?? Math.max(0, 50 - index)) * 0.65 }))
        .sort((a, b) => b.score - a.score);
    } catch {
      return records;
    }
  }

  private async tryExpandQuery(query: string): Promise<{ queries: string[]; hypotheticalAnswer?: string } | null> {
    if (!this.llm?.expandQuery) return null;
    try {
      return await this.llm.expandQuery({ query });
    } catch {
      return null;
    }
  }

  private async tryAnswerWithCitations(question: string, contexts: Array<{ id: string; title: string; content: string; path?: string }>): Promise<{ answer: string; citedIds: string[]; confidence: 'low' | 'medium' | 'high' } | null> {
    if (!this.llm?.answerWithCitations || contexts.length === 0) return null;
    try {
      return await this.llm.answerWithCitations({ question, contexts });
    } catch {
      return null;
    }
  }

  private expandWithGraph(ranked: Array<SearchRecord & { score: number }>, allRecords: SearchRecord[], terms: string[]): Array<SearchRecord & { score: number }> {
    const manifest = this.readManifest();
    const articleRecordsByPath = new Map(allRecords.filter((record) => record.id.startsWith('article:') && record.path).map((record) => [record.path as string, record]));
    const conceptBundles = safeList(this.conceptsDir).filter((name) => name.endsWith('.json')).map((name) => readJsonFile<{ concepts?: KnowledgeConcept[]; relations?: KnowledgeRelation[] }>(path.join(this.conceptsDir, name), {}));
    const conceptByArticlePath = new Map<string, KnowledgeConcept>();
    for (const concept of conceptBundles.flatMap((bundle) => bundle.concepts ?? [])) {
      const articlePath = concept.articleId ? manifest.articles[concept.articleId]?.path : undefined;
      if (articlePath) conceptByArticlePath.set(articlePath, concept);
    }
    const relatedConceptIds = new Set<string>();
    for (const record of ranked) {
      if (record.path) {
        const concept = conceptByArticlePath.get(record.path);
        if (concept) relatedConceptIds.add(concept.id);
      }
    }
    const relations = conceptBundles.flatMap((bundle) => bundle.relations ?? []);
    for (const relation of relations) {
      if (relatedConceptIds.has(relation.sourceConceptId)) relatedConceptIds.add(relation.targetConceptId);
      if (relatedConceptIds.has(relation.targetConceptId)) relatedConceptIds.add(relation.sourceConceptId);
    }
    const existing = new Set(ranked.map((record) => record.id));
    const graphAdds: Array<SearchRecord & { score: number }> = [];
    for (const [articlePath, concept] of conceptByArticlePath) {
      if (!relatedConceptIds.has(concept.id)) continue;
      const record = articleRecordsByPath.get(articlePath);
      if (!record || existing.has(record.id)) continue;
      graphAdds.push({ ...record, score: Math.max(1, scoreContent(`${record.title}\n${record.content}`, terms)) + 1.5 });
    }
    return [...ranked, ...graphAdds].sort((a, b) => b.score - a.score);
  }

  private async tryLlmSummary(source: KnowledgeSourceRecord, raw: string): Promise<KnowledgeSourceSummary | null> {
    if (!this.llm || raw.length < 80) return null;
    try {
      return await this.llm.summarizeSource({ source, raw });
    } catch {
      return null;
    }
  }

  private async tryLlmConceptGraph(source: KnowledgeSourceRecord, summary: KnowledgeSourceSummary, raw: string): Promise<{ concepts: KnowledgeConcept[]; relations: KnowledgeRelation[] } | null> {
    if (!this.llm) return null;
    try {
      return await this.llm.extractConceptGraph({ source, summary, raw });
    } catch {
      return null;
    }
  }

  private async tryLlmArticle(concept: KnowledgeConcept, summary: KnowledgeSourceSummary, relations: KnowledgeRelation[]): Promise<string | null> {
    if (!this.llm) return null;
    try {
      return await this.llm.writeArticle({ concept, summary, relations });
    } catch {
      return null;
    }
  }


  private async tryEmbedText(text: string): Promise<number[] | null> {
    if (!this.llm?.embedTexts || !text.trim()) return null;
    try {
      const vectors = await this.llm.embedTexts({ texts: [text] });
      return vectors?.[0] ?? null;
    } catch {
      return null;
    }
  }

  private writeQualityReport(source: KnowledgeSourceRecord, summary: KnowledgeSourceSummary, concepts: KnowledgeConcept[], relations: KnowledgeRelation[], articleIds: string[]) {
    mkdirSync(this.qualityDir, { recursive: true });
    const report = scoreKnowledgeQuality(source, summary, concepts, relations, articleIds);
    writeFileSync(path.join(this.qualityDir, `${source.id}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  private collectSearchRecords(): SearchRecord[] {
    const manifest = this.readManifest();
    const summaryRecords = Object.values(manifest.compileItems).flatMap((item) => {
      if (!item.summaryId) return [];
      const filePath = path.join(this.summariesDir, `${item.summaryId}.json`);
      const summary = readJsonFile<KnowledgeSourceSummary | null>(filePath, null);
      if (!summary) return [];
      return [
        {
          id: `summary:${summary.id}`,
          title: summary.title,
          content: [summary.abstract, ...summary.keyPoints, ...summary.claims, ...summary.terms].join('\n'),
          path: filePath,
          citations: summary.citations.map((citation) => citation.path || citation.sourceId),
          metadata: { sourceId: summary.sourceId, type: 'summary' }
        }
      ];
    });
    const articleRecords = Object.values(manifest.articles).map((article) => ({
      id: `article:${article.id}`,
      title: article.title,
      content: safeReadText(article.path, MAX_SEARCH_FILE_BYTES),
      path: article.path,
      citations: [article.path, ...article.sourceIds],
      metadata: { sourceIds: article.sourceIds, type: 'article' }
    }));
    const chunkRecords = readJsonl<SearchRecord>(path.join(this.indexDir, 'chunks.jsonl'));
    return [...summaryRecords, ...articleRecords, ...chunkRecords];
  }

  private async rebuildSearchIndex(manifest: KnowledgeManifest) {
    const chunks: SearchRecord[] = [];
    for (const source of Object.values(manifest.sources)) {
      const raw = safeReadText(source.rawTextPath || '', MAX_TEXT_BYTES);
      for (const [index, chunk] of chunkText(raw).entries()) {
        chunks.push({
          id: `source:${source.id}:chunk:${index + 1}`,
          title: `${source.title} #${index + 1}`,
          content: chunk,
          path: source.rawTextPath,
          citations: [source.rawTextPath || source.id],
          metadata: { sourceId: source.id, type: 'source-chunk' }
        });
      }
    }
    writeFileSync(path.join(this.indexDir, 'chunks.jsonl'), chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + (chunks.length ? '\n' : ''), 'utf8');
    await this.rebuildEmbeddingIndex(chunks);
  }


  private async rebuildEmbeddingIndex(chunks: SearchRecord[]) {
    const embeddingPath = path.join(this.indexDir, 'embeddings.jsonl');
    if (!this.llm?.embedTexts || chunks.length === 0) {
      writeFileSync(embeddingPath, chunks.map((chunk) => JSON.stringify({ id: chunk.id, vector: hashedVector(`${chunk.title} ${chunk.content}`), provider: 'local-hash' })).join('\n') + (chunks.length ? '\n' : ''), 'utf8');
      return;
    }
    const rows: Array<{ id: string; vector: number[]; provider: string }> = [];
    for (const batch of chunkArray(chunks, 20)) {
      try {
        const vectors = await this.llm.embedTexts({ texts: batch.map((chunk) => `${chunk.title}\n${chunk.content}`) });
        if (!vectors) throw new Error('embedding provider returned no vectors');
        vectors.forEach((vector, index) => rows.push({ id: batch[index].id, vector, provider: 'llm-embedding' }));
      } catch {
        batch.forEach((chunk) => rows.push({ id: chunk.id, vector: hashedVector(`${chunk.title} ${chunk.content}`), provider: 'local-hash' }));
      }
    }
    writeFileSync(embeddingPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  }

  private buildGraphFromManifest(manifest: KnowledgeManifest): KnowledgeGraphResult {
    const conceptFiles = safeList(this.conceptsDir).filter((name) => name.endsWith('.json'));
    const conceptBundles = conceptFiles.map((name) => readJsonFile<{ concepts?: KnowledgeConcept[]; relations?: KnowledgeRelation[] }>(path.join(this.conceptsDir, name), {}));
    const concepts = conceptBundles.flatMap((bundle) => bundle.concepts ?? []);
    const relations = conceptBundles.flatMap((bundle) => bundle.relations ?? []);
    const nodes = concepts.map((concept) => ({ id: concept.id, label: concept.name, type: concept.type, articleId: concept.articleId, path: concept.articleId ? manifest.articles[concept.articleId]?.path : undefined }));
    const edges = relations.map((relation) => ({ from: relation.sourceConceptId, to: relation.targetConceptId, type: relation.type, evidence: relation.evidence }));
    const graph = { built: new Date().toISOString(), nodes, edges };
    const graphJsonPath = path.join(this.graphDir, 'graph.json');
    const graphHtmlPath = path.join(this.graphDir, 'graph.html');
    writeFileSync(graphJsonPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    writeFileSync(graphHtmlPath, buildGraphHtml(graph), 'utf8');
    return { ok: true, source: this.source, message: `Knowledge graph built with ${nodes.length} nodes and ${edges.length} edges.`, graphJsonPath, graphHtmlPath, data: graph };
  }

  private ensureReady() {
    for (const dir of [this.rawDir, this.filesDir, this.mediaDir, this.summariesDir, this.conceptsDir, this.provenanceDir, this.qualityDir, this.wikiDir, this.wikiConceptsDir, this.wikiEntitiesDir, this.wikiDecisionsDir, this.wikiRulesDir, this.graphDir, this.indexDir]) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.manifestPath)) this.writeManifest(emptyManifest());
    const indexPath = path.join(this.wikiDir, 'index.md');
    if (!existsSync(indexPath)) writeFileSync(indexPath, '# OpenAgent Knowledge Base\n\nThis directory contains compiler-generated knowledge articles.\n', 'utf8');
  }

  private readManifest(): KnowledgeManifest {
    this.ensureManifestDir();
    return readJsonFile<KnowledgeManifest>(this.manifestPath, emptyManifest());
  }

  private writeManifest(manifest: KnowledgeManifest) {
    manifest.updatedAt = new Date().toISOString();
    writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  private appendCompileLog(entry: Record<string, unknown>) {
    writeFileSync(this.compileLogPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  private archiveOriginalFile(sourcePath: string, slug: string, sizeBytes: number): KnowledgeOriginalFile {
    const kind = isMediaFile(sourcePath) ? 'media' : 'file';
    const targetDir = kind === 'media' ? this.mediaDir : this.filesDir;
    mkdirSync(targetDir, { recursive: true });
    const extension = path.extname(sourcePath);
    const archivePath = uniqueArchivePath(path.join(targetDir, `${slug}${extension}`));
    copyFileSync(sourcePath, archivePath);
    return { kind, path: archivePath, originalPath: sourcePath, sizeBytes, mimeHint: mimeHintFromExtension(sourcePath) };
  }


  private async buildFileIngestContent(sourcePath: string, archivedFile: KnowledgeOriginalFile, sizeBytes: number) {
    const baseContent = buildFileIngestContent(sourcePath, archivedFile, sizeBytes);
    const extracted = extractExtractedText(baseContent);
    const shouldEnrich = shouldRunMultimodalEnrichment(sourcePath, extracted);
    if (!shouldEnrich || !this.llm?.describeImage) return baseContent;
    const visualSummary = await this.tryMultimodalEnrichment(archivedFile.path, archivedFile.mimeHint);
    if (!visualSummary) return baseContent;
    return [
      baseContent.trim(),
      '',
      '## Multimodal Enrichment',
      '',
      visualSummary.trim(),
      '',
      '## Extraction Strategy',
      '',
      '- Deterministic extraction ran first.',
      '- Multimodal enrichment was added because the file is visual or deterministic text extraction looked sparse.',
      ''
    ].join('\n');
  }

  private async tryMultimodalEnrichment(filePath: string, mimeType?: string): Promise<string | null> {
    if (!this.llm?.describeImage || !mimeType?.startsWith('image/')) return null;
    try {
      return await this.llm.describeImage({
        filePath,
        mimeType,
        prompt: [
          'You are enriching an OpenAgent Knowledge Compiler source after deterministic extraction.',
          'Extract visible text, objects, entities, chart/table meaning, spatial/layout clues, and reusable knowledge.',
          'Return concise Markdown with sections: Visual Summary, Extracted Text, Key Facts, Concepts.'
        ].join(' ')
      });
    } catch {
      return null;
    }
  }

  private ensureManifestDir() {
    mkdirSync(this.root, { recursive: true });
  }

  private get rawDir() { return path.join(this.root, 'raw'); }
  private get filesDir() { return path.join(this.root, 'files'); }
  private get mediaDir() { return path.join(this.root, 'media'); }
  private get summariesDir() { return path.join(this.root, 'summaries'); }
  private get conceptsDir() { return path.join(this.root, 'concepts'); }
  private get provenanceDir() { return path.join(this.root, 'provenance'); }
  private get qualityDir() { return path.join(this.root, 'quality'); }
  private get wikiDir() { return path.join(this.root, 'wiki'); }
  private get wikiConceptsDir() { return path.join(this.wikiDir, 'concepts'); }
  private get wikiEntitiesDir() { return path.join(this.wikiDir, 'entities'); }
  private get wikiDecisionsDir() { return path.join(this.wikiDir, 'decisions'); }
  private get wikiRulesDir() { return path.join(this.wikiDir, 'rules'); }
  private get graphDir() { return path.join(this.root, 'graph'); }
  private get indexDir() { return path.join(this.root, 'index'); }
  private get manifestPath() { return path.join(this.root, 'manifest.json'); }
  private get compileLogPath() { return path.join(this.root, 'compile-log.jsonl'); }
}

type SearchRecord = { id: string; title: string; content: string; path?: string; citations: string[]; metadata?: Record<string, unknown> };

function emptyManifest(): KnowledgeManifest {
  return { version: MANIFEST_VERSION, providerId: PROVIDER_ID, updatedAt: new Date().toISOString(), sources: {}, compileItems: {}, articles: {} };
}

function buildSummary(source: KnowledgeSourceRecord, raw: string): KnowledgeSourceSummary {
  const paragraphs = raw.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const bullets = raw.split('\n').map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, '')).slice(0, 12);
  const headings = [...raw.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
  const terms = unique([...headings, ...extractCapitalizedTerms(raw), ...extractChineseTerms(raw)]).slice(0, 20);
  const abstract = (paragraphs.find((item) => !item.startsWith('#')) || raw.slice(0, 500)).slice(0, 1000);
  return {
    id: `summary-${source.id}`,
    sourceId: source.id,
    title: source.title,
    language: /[\u4e00-\u9fa5]/.test(raw) ? 'zh' : 'en',
    abstract,
    keyPoints: bullets.length ? bullets : paragraphs.slice(0, 5).map((item) => item.slice(0, 220)),
    claims: paragraphs.filter((item) => /必须|应该|不要|需要|must|should|required|decision/i.test(item)).slice(0, 8),
    decisions: paragraphs.filter((item) => /决定|确认|结论|decision/i.test(item)).slice(0, 8),
    openQuestions: paragraphs.filter((item) => /\?|？|待确认|open question/i.test(item)).slice(0, 8),
    terms,
    entities: terms.slice(0, 12),
    citations: [{ sourceId: source.id, path: source.rawTextPath, quote: abstract.slice(0, 220) }],
    confidence: raw.length > 100 ? 'medium' : 'low',
    createdAt: new Date().toISOString()
  };
}

function buildConcepts(source: KnowledgeSourceRecord, summary: KnowledgeSourceSummary): KnowledgeConcept[] {
  const names = unique([source.title, ...summary.terms.slice(0, 8), ...summary.entities.slice(0, 6)]).filter((name) => name.length >= 2).slice(0, 10);
  return names.map((name, index) => ({
    id: `concept-${slugify(name)}-${source.id}`,
    name,
    aliases: index === 0 ? [source.title] : [],
    type: conceptTypeForName(name),
    description: index === 0 ? summary.abstract.slice(0, 360) : `Concept extracted from ${source.title}: ${name}`,
    sourceIds: [source.id],
    confidence: index === 0 ? 'high' : 'medium'
  }));
}

function normalizeRelations(relations: KnowledgeRelation[], concepts: KnowledgeConcept[], sourceId: string): KnowledgeRelation[] {
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  return relations
    .filter((relation) => conceptIds.has(relation.sourceConceptId) && conceptIds.has(relation.targetConceptId) && relation.sourceConceptId !== relation.targetConceptId)
    .map((relation) => ({ ...relation, sourceIds: unique([...relation.sourceIds, sourceId]) }));
}

function normalizeConceptKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function confidenceRank(value: 'low' | 'medium' | 'high') {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function buildRelations(concepts: KnowledgeConcept[], sourceId: string): KnowledgeRelation[] {
  const [primary, ...rest] = concepts;
  if (!primary) return [];
  return rest.slice(0, 12).map((concept) => ({
    id: `relation-${primary.id}-${concept.id}`,
    sourceConceptId: primary.id,
    targetConceptId: concept.id,
    type: 'mentions',
    evidence: `${primary.name} and ${concept.name} were extracted from the same source.`,
    sourceIds: [sourceId],
    confidence: 'medium'
  }));
}

function buildArticle(concept: KnowledgeConcept, source: KnowledgeSourceRecord, summary: KnowledgeSourceSummary, relations: KnowledgeRelation[], dir: string): KnowledgeArticle {
  const articleId = `article-${concept.id}`;
  return {
    id: articleId,
    conceptId: concept.id,
    title: concept.name,
    path: path.join(dir, `${slugify(concept.name)}.md`),
    aliases: concept.aliases,
    sourceIds: [source.id],
    relationIds: relations.map((relation) => relation.id),
    frontmatter: { id: articleId, concept: concept.name, type: concept.type, sources: [source.id], confidence: concept.confidence, updated_at: new Date().toISOString() },
    updatedAt: new Date().toISOString()
  };
}

function renderArticle(article: KnowledgeArticle, concept: KnowledgeConcept, summary: KnowledgeSourceSummary, body = renderArticleBody(concept, summary)) {
  return [
    '---',
    `id: ${article.id}`,
    `concept: "${escapeYaml(concept.name)}"`,
    `type: ${concept.type}`,
    `aliases: [${concept.aliases.map((alias) => `"${escapeYaml(alias)}"`).join(', ')}]`,
    `sources: [${article.sourceIds.join(', ')}]`,
    `confidence: ${concept.confidence}`,
    `updated_at: ${article.updatedAt}`,
    '---',
    '',
    body.trim(),
    ''
  ].join('\n');
}

function renderArticleBody(concept: KnowledgeConcept, summary: KnowledgeSourceSummary) {
  return [
    `# ${concept.name}`,
    '',
    '## Summary',
    '',
    concept.description || summary.abstract,
    '',
    '## Key Points',
    '',
    ...(summary.keyPoints.length ? summary.keyPoints.map((point) => `- ${point}`) : ['- No key points extracted.']),
    '',
    '## Related Concepts',
    '',
    ...summary.terms.filter((term) => term !== concept.name).slice(0, 8).map((term) => `- [[${term}]]`),
    '',
    '## Evidence',
    '',
    ...summary.citations.map((citation) => `- ${citation.path || citation.sourceId}${citation.quote ? ` — ${citation.quote}` : ''}`),
    ''
  ].join('\n');
}

function buildProvenance(source: KnowledgeSourceRecord, summary: KnowledgeSourceSummary, concepts: KnowledgeConcept[], relations: KnowledgeRelation[]): KnowledgeProvenance[] {
  const now = new Date().toISOString();
  return [
    { id: `prov-${summary.id}`, targetId: summary.id, targetType: 'summary', sourceId: source.id, sourcePath: source.rawTextPath, quote: summary.abstract.slice(0, 220), createdAt: now, confidence: summary.confidence },
    ...concepts.map((concept) => ({ id: `prov-${concept.id}`, targetId: concept.id, targetType: 'concept' as const, sourceId: source.id, sourcePath: source.rawTextPath, quote: concept.description.slice(0, 220), createdAt: now, confidence: concept.confidence })),
    ...relations.map((relation) => ({ id: `prov-${relation.id}`, targetId: relation.id, targetType: 'relation' as const, sourceId: source.id, sourcePath: source.rawTextPath, quote: relation.evidence, createdAt: now, confidence: relation.confidence }))
  ];
}

function buildFileIngestContent(sourcePath: string, archivedFile: KnowledgeOriginalFile, sizeBytes: number) {
  const metadata = [`# ${path.basename(sourcePath)}`, '', '## Original File', `- Archived ${archivedFile.kind}: ${archivedFile.path}`, `- Original path: ${sourcePath}`, `- Size: ${sizeBytes} bytes`, archivedFile.mimeHint ? `- Type: ${archivedFile.mimeHint}` : `- Extension: ${path.extname(sourcePath) || '(none)'}`, ''];
  const extracted = extractFileText(sourcePath, sizeBytes);
  if (extracted) return [...metadata, '## Extracted Text', extracted, ''].join('\n');
  return [...metadata, '## Extraction', '原始文件已归档到 OpenAgent Knowledge Base；当前只记录文件元数据，后续可由专门 extractor 生成正文、caption 或结构化摘要。', ''].join('\n');
}


function extractExtractedText(content: string) {
  const marker = '## Extracted Text';
  const index = content.indexOf(marker);
  if (index < 0) return '';
  const rest = content.slice(index + marker.length);
  const nextHeading = rest.search(/\n##\s+/);
  return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
}

function shouldRunMultimodalEnrichment(sourcePath: string, extractedText: string) {
  if (isImageFile(sourcePath)) return true;
  if (isMediaFile(sourcePath)) return false;
  const extension = path.extname(sourcePath).toLowerCase();
  if (['.pdf', '.pptx'].includes(extension) && extractedText.length < 300) return true;
  return false;
}

function isImageFile(filePath: string) {
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff'].includes(path.extname(filePath).toLowerCase());
}

function extractFileText(sourcePath: string, sizeBytes: number) {
  const extension = path.extname(sourcePath).toLowerCase();
  try {
    if (isTextLikeFile(sourcePath) && sizeBytes <= MAX_TEXT_BYTES) return safeReadText(sourcePath, MAX_TEXT_BYTES).trim() || '(empty file)';
    if (['.docx', '.xlsx', '.pptx'].includes(extension)) return extractOfficeText(sourcePath).slice(0, MAX_TEXT_BYTES);
    if (extension === '.pdf') return extractPdfText(sourcePath).slice(0, MAX_TEXT_BYTES);
  } catch {
    return '';
  }
  return '';
}

function chunkText(value: string) {
  const paragraphs = value.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length > 1800 && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 200);
}

function uniqueSourceId(preferred: string, manifest: KnowledgeManifest) {
  if (!manifest.sources[preferred]) return preferred;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (!manifest.sources[candidate]) return candidate;
  }
  return `${preferred}-${Date.now()}`;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) as T; } catch { return fallback; }
}

function readJsonl<T>(filePath: string): T[] {
  return safeReadText(filePath, MAX_TEXT_BYTES).split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
}

function safeReadText(filePath: string, maxBytes = MAX_SEARCH_FILE_BYTES) {
  try { return readFileSync(filePath, 'utf8').slice(0, maxBytes); } catch { return ''; }
}

function safeList(dir: string) {
  try { return readdirSync(dir); } catch { return []; }
}

function tokenize(value: string) {
  return value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((term) => term.trim()).filter((term) => term.length >= 2);
}


function getIndexDirFromRecords(records: SearchRecord[]) {
  const chunkPath = records.find((record) => record.metadata?.type === 'source-chunk')?.path;
  if (!chunkPath) return '';
  return path.join(path.dirname(path.dirname(chunkPath)), 'index');
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function scoreKnowledgeQuality(source: KnowledgeSourceRecord, summary: KnowledgeSourceSummary, concepts: KnowledgeConcept[], relations: KnowledgeRelation[], articleIds: string[]) {
  const issues: string[] = [];
  let score = 100;
  if (summary.abstract.length < 80) { issues.push('summary abstract is too short'); score -= 20; }
  if (summary.keyPoints.length < 2) { issues.push('not enough key points'); score -= 15; }
  if (concepts.length === 0) { issues.push('no concepts extracted'); score -= 25; }
  if (concepts.length > 0 && relations.length === 0) { issues.push('no relations extracted'); score -= 10; }
  if (articleIds.length === 0 && concepts.length > 0) { issues.push('concepts have no generated articles'); score -= 15; }
  if (summary.citations.length === 0) { issues.push('no citations/provenance'); score -= 20; }
  return {
    sourceId: source.id,
    title: source.title,
    score: Math.max(0, score),
    grade: score >= 85 ? 'good' : score >= 60 ? 'needs_review' : 'poor',
    issues,
    metrics: { keyPoints: summary.keyPoints.length, claims: summary.claims.length, concepts: concepts.length, relations: relations.length, articles: articleIds.length, citations: summary.citations.length },
    generatedAt: new Date().toISOString()
  };
}

function rankRecords(records: SearchRecord[], terms: string[], searchTexts: string[], queryEmbedding?: number[] | null): Array<SearchRecord & { score: number }> {
  const bm25 = rankByBm25(records, terms);
  const semantic = rankBySemantic(records, searchTexts, queryEmbedding);
  const scores = new Map<string, number>();
  for (const [rank, item] of bm25.entries()) scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + rank + 1));
  for (const [rank, item] of semantic.entries()) scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + rank + 1));
  return records
    .map((record) => ({ ...record, score: (scores.get(record.id) ?? 0) * 1000 + scoreRecord(record, terms, searchTexts) }))
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score);
}

function rankByBm25(records: SearchRecord[], terms: string[]) {
  const avgLength = records.reduce((sum, record) => sum + tokenize(record.content).length, 0) / Math.max(records.length, 1);
  const docFreq = new Map<string, number>();
  for (const term of terms) docFreq.set(term, records.filter((record) => tokenize(`${record.title} ${record.content}`).includes(term)).length);
  return records
    .map((record) => ({ record, score: bm25Score(`${record.title} ${record.content}`, terms, docFreq, records.length, avgLength) + titleBoost(record.title, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.record);
}

function rankBySemantic(records: SearchRecord[], searchTexts: string[], queryEmbedding?: number[] | null) {
  const queryVector = queryEmbedding ?? hashedVector(searchTexts.join(' '));
  const embeddingById = new Map(readJsonl<{ id: string; vector: number[] }>(path.join(getIndexDirFromRecords(records), 'embeddings.jsonl')).map((row) => [row.id, row.vector]));
  return records
    .map((record) => ({ record, score: cosine(queryVector, embeddingById.get(record.id) ?? hashedVector(`${record.title} ${record.content}`)) }))
    .filter((item) => item.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.record);
}

function scoreRecord(record: SearchRecord, terms: string[], searchTexts: string[]) {
  const lexical = scoreContent(`${record.title}\n${record.content}`, terms) + titleBoost(record.title, terms);
  const phraseBoost = searchTexts.reduce((score, text) => {
    const normalized = text.trim().toLowerCase();
    return normalized && `${record.title}\n${record.content}`.toLowerCase().includes(normalized) ? score + 8 : score;
  }, 0);
  const typeBoost = record.metadata?.type === 'article' ? 2 : record.metadata?.type === 'summary' ? 1 : 0;
  return lexical + phraseBoost + typeBoost;
}

function bm25Score(content: string, terms: string[], docFreq: Map<string, number>, docCount: number, avgLength: number) {
  const tokens = tokenize(content);
  const length = Math.max(tokens.length, 1);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  return terms.reduce((score, term) => {
    const f = tf.get(term) ?? 0;
    if (!f) return score;
    const df = docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    return score + idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (length / Math.max(avgLength, 1)))));
  }, 0);
}

function hashedVector(value: string) {
  const vector = new Array<number>(128).fill(0);
  for (const token of tokenize(value)) {
    let hash = 0;
    for (let index = 0; index < token.length; index += 1) hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
    vector[hash % vector.length] += 1;
  }
  return vector;
}

function cosine(a: number[], b: number[]) {
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; an += a[i] * a[i]; bn += b[i] * b[i]; }
  return an && bn ? dot / Math.sqrt(an * bn) : 0;
}

function scoreContent(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  return terms.reduce((score, term) => score + countOccurrences(lower, term), 0);
}

function titleBoost(title: string, terms: string[]) {
  const lower = title.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 5 : 0), 0);
}

function countOccurrences(value: string, term: string) {
  let count = 0;
  let index = value.indexOf(term);
  while (index >= 0) { count += 1; index = value.indexOf(term, index + term.length); }
  return count;
}

function excerpt(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 240);
  return content.slice(start, start + 1200).trim();
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }

function unique(values: string[]) { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }

function extractCapitalizedTerms(raw: string) { return [...raw.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)?\b/g)].map((match) => match[0]).filter((value) => value.length > 2); }
function extractChineseTerms(raw: string) { return [...raw.matchAll(/[\u4e00-\u9fa5A-Za-z0-9_-]{3,24}/g)].map((match) => match[0]).filter((value) => /[\u4e00-\u9fa5]/.test(value)); }

function conceptTypeForName(name: string) {
  if (/api|接口/i.test(name)) return 'api';
  if (/规则|policy|rule/i.test(name)) return 'rule';
  if (/流程|workflow|pipeline/i.test(name)) return 'workflow';
  if (/决定|decision/i.test(name)) return 'decision';
  return 'concept';
}

function kindFromMimeOrPath(mimeHint: string | undefined, filePath: string | undefined): KnowledgeSourceKind {
  const extension = path.extname(filePath || '').toLowerCase();
  if (mimeHint?.startsWith('image/')) return 'image';
  if (mimeHint?.startsWith('audio/')) return 'audio';
  if (mimeHint?.startsWith('video/')) return 'video';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx' || extension === '.doc') return 'docx';
  if (extension === '.xlsx' || extension === '.xls') return 'xlsx';
  if (extension === '.pptx' || extension === '.ppt') return 'pptx';
  if (isCodeFile(extension)) return 'code';
  if (isTextLikeExtension(extension)) return 'text';
  return 'unknown';
}

function isCodeFile(extension: string) { return new Set(['.ts', '.tsx', '.js', '.jsx', '.go', '.py', '.java', '.rs', '.c', '.cpp', '.rb', '.php']).has(extension); }
function isTextLikeExtension(extension: string) { return new Set(['.txt', '.json', '.jsonl', '.yml', '.yaml', '.csv', '.tsv', '.log', '.html', '.xml', '.sql']).has(extension); }
function isTextLikeFile(filePath: string) { const extension = path.extname(filePath).toLowerCase(); return extension === '.md' || extension === '.markdown' || isTextLikeExtension(extension) || isCodeFile(extension); }
function isMediaFile(filePath: string) { return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp', '.tif', '.tiff', '.mp4', '.mov', '.m4v', '.webm', '.mp3', '.m4a', '.wav', '.flac', '.aac'].includes(path.extname(filePath).toLowerCase()); }

function mimeHintFromExtension(filePath: string) {
  const hints: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  return hints[path.extname(filePath).toLowerCase()];
}

function uniqueArchivePath(preferredPath: string) {
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

function slugify(value: string) {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '');
  return slug || `source-${Date.now()}`;
}

function escapeYaml(value: string) { return value.replace(/"/g, '\\"'); }
function normalizeLimit(value: unknown, fallback: number, max: number) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback; }
function errorToMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

function buildGraphHtml(graph: { nodes: Array<{ id: string; label: string; type?: string; path?: string }>; edges: Array<{ from: string; to: string; type: string; evidence?: string }> }) {
  const data = JSON.stringify(graph).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"/><title>OpenAgent Knowledge Graph</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f8fafc;color:#0f172a}header{padding:16px 20px;background:#fff;border-bottom:1px solid #e2e8f0}main{padding:20px}.node{margin:0 8px 8px 0;display:inline-flex;padding:8px 10px;border-radius:999px;background:#dbeafe;color:#1e3a8a}.edge{color:#475569;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:4px 0}</style></head><body><header><strong>OpenAgent Knowledge Graph</strong><div id="summary"></div></header><main><h2>Nodes</h2><div id="nodes"></div><h2>Edges</h2><div id="edges"></div></main><script>const graph=${data};document.getElementById('summary').textContent=graph.nodes.length+' nodes · '+graph.edges.length+' edges';document.getElementById('nodes').innerHTML=graph.nodes.map((node)=>'<span class="node" title="'+(node.path||'')+'">'+node.label+'</span>').join('');document.getElementById('edges').innerHTML=graph.edges.map((edge)=>'<div class="edge">'+edge.from+' -> '+edge.to+' ('+edge.type+')</div>').join('');</script></body></html>`;
}
