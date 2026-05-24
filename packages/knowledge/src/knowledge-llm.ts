import { readFileSync } from 'node:fs';
import { buildPiProviderCatalog } from '@openagent/pi-adapter';
import type { KnowledgeConcept, KnowledgeRelation, KnowledgeSourceRecord, KnowledgeSourceSummary } from './knowledge-types.js';

export interface KnowledgeLlm {
  expandQuery?(input: { query: string }): Promise<{ queries: string[]; hypotheticalAnswer?: string } | null>;
  answerWithCitations?(input: { question: string; contexts: Array<{ id: string; title: string; content: string; path?: string }> }): Promise<{ answer: string; citedIds: string[]; confidence: 'low' | 'medium' | 'high' } | null>;
  rerank?(input: { query: string; candidates: Array<{ id: string; title: string; content: string }> }): Promise<Array<{ id: string; score: number; reason?: string }> | null>;
  embedTexts?(input: { texts: string[] }): Promise<number[][] | null>;
  describeImage?(input: { filePath: string; mimeType?: string; prompt?: string }): Promise<string | null>;
  summarizeSource(input: { source: KnowledgeSourceRecord; raw: string }): Promise<KnowledgeSourceSummary | null>;
  extractConceptGraph(input: { source: KnowledgeSourceRecord; summary: KnowledgeSourceSummary; raw: string }): Promise<{ concepts: KnowledgeConcept[]; relations: KnowledgeRelation[] } | null>;
  writeArticle(input: { concept: KnowledgeConcept; summary: KnowledgeSourceSummary; relations: KnowledgeRelation[] }): Promise<string | null>;
}

export class OpenAgentKnowledgeLlm implements KnowledgeLlm {



  async embedTexts(input: { texts: string[] }): Promise<number[][] | null> {
    const endpoint = await resolveChatEndpoint();
    if (!endpoint) return null;
    const embeddingModel = resolveEmbeddingModel(endpoint.model);
    const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
        ...(endpoint.extraHeaders ?? {})
      },
      body: JSON.stringify({ model: embeddingModel, input: input.texts.map((text) => text.slice(0, 8000)) })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    if (!Array.isArray(data.data)) return null;
    const vectors = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item));
    return vectors.length === input.texts.length ? vectors : null;
  }

  async describeImage(input: { filePath: string; mimeType?: string; prompt?: string }): Promise<string | null> {
    const endpoint = await resolveChatEndpoint();
    if (!endpoint) return null;
    const mimeType = input.mimeType || 'image/png';
    if (!mimeType.startsWith('image/')) return null;
    const bytes = readFileSync(input.filePath);
    if (bytes.length > 8_000_000) return null;
    const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
        ...(endpoint.extraHeaders ?? {})
      },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: input.prompt || 'Describe this image for a knowledge base. Extract visible text, entities, key facts, chart/table meaning, and reusable concepts. Return concise Markdown.'
              },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}` } }
            ]
          }
        ]
      })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  async expandQuery(input: { query: string }): Promise<{ queries: string[]; hypotheticalAnswer?: string } | null> {
    const json = await this.generateJson<{ queries?: unknown; hypotheticalAnswer?: unknown }>([
      'You expand search queries for the OpenAgent Knowledge Compiler.',
      'Return only JSON: {"queries":["keyword rewrite","semantic rewrite","related terms"],"hypotheticalAnswer":"short likely answer for embedding-style retrieval"}',
      `Query: ${input.query}`
    ].join('\n'));
    if (!json) return null;
    const queries = asStringArray(json.queries, 6);
    return { queries: unique([input.query, ...queries]), hypotheticalAnswer: asString(json.hypotheticalAnswer).slice(0, 1000) };
  }

  async answerWithCitations(input: { question: string; contexts: Array<{ id: string; title: string; content: string; path?: string }> }): Promise<{ answer: string; citedIds: string[]; confidence: 'low' | 'medium' | 'high' } | null> {
    const json = await this.generateJson<{ answer?: unknown; citedIds?: unknown; confidence?: unknown }>([
      'You answer questions using only supplied OpenAgent knowledge contexts.',
      'Return only JSON: {"answer":"concise answer with inline [id] citations","citedIds":["context id"],"confidence":"low|medium|high"}.',
      'If context is insufficient, say what is missing. Do not invent facts.',
      `Question: ${input.question}`,
      '<contexts>',
      JSON.stringify(input.contexts.map((ctx) => ({ ...ctx, content: ctx.content.slice(0, 3000) }))),
      '</contexts>'
    ].join('\n'));
    if (!json) return null;
    const answer = asString(json.answer).trim();
    if (!answer) return null;
    return { answer, citedIds: asStringArray(json.citedIds, 20), confidence: asConfidence(json.confidence) };
  }

  async rerank(input: { query: string; candidates: Array<{ id: string; title: string; content: string }> }): Promise<Array<{ id: string; score: number; reason?: string }> | null> {
    const json = await this.generateJson<{ rankings?: unknown }>([
      'You rerank OpenAgent knowledge search candidates for relevance.',
      'Return only JSON: {"rankings":[{"id":"candidate id","score":0-100,"reason":"short reason"}]}',
      `Query: ${input.query}`,
      '<candidates>',
      JSON.stringify(input.candidates.map((item) => ({ ...item, content: item.content.slice(0, 1200) }))),
      '</candidates>'
    ].join('\n'));
    if (!json || !Array.isArray(json.rankings)) return null;
    return json.rankings.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      const id = asString(value.id);
      const score = Number(value.score);
      if (!id || !Number.isFinite(score)) return [];
      return [{ id, score: Math.max(0, Math.min(100, score)), reason: asString(value.reason) }];
    });
  }

  async summarizeSource(input: { source: KnowledgeSourceRecord; raw: string }): Promise<KnowledgeSourceSummary | null> {
    const schema = `Return only JSON: {"abstract":"string","keyPoints":["string"],"claims":["string"],"decisions":["string"],"openQuestions":["string"],"terms":["string"],"entities":["string"],"confidence":"low|medium|high","language":"zh|en|other"}`;
    const json = await this.generateJson<Record<string, unknown>>([
      'You are the source summarizer for the OpenAgent Knowledge Compiler.',
      'Extract durable, reusable knowledge. Preserve precise claims and decisions. Do not invent facts.',
      schema,
      `Source title: ${input.source.title}`,
      `Source kind: ${input.source.kind}`,
      '<source>',
      input.raw.slice(0, 24_000),
      '</source>'
    ].join('\n'));
    if (!json) return null;
    return {
      id: `summary-${input.source.id}`,
      sourceId: input.source.id,
      title: input.source.title,
      language: asString(json.language),
      abstract: asString(json.abstract).slice(0, 2000),
      keyPoints: asStringArray(json.keyPoints, 12),
      claims: asStringArray(json.claims, 12),
      decisions: asStringArray(json.decisions, 8),
      openQuestions: asStringArray(json.openQuestions, 8),
      terms: asStringArray(json.terms, 24),
      entities: asStringArray(json.entities, 24),
      citations: [{ sourceId: input.source.id, path: input.source.rawTextPath, quote: asString(json.abstract).slice(0, 220) }],
      confidence: asConfidence(json.confidence),
      createdAt: new Date().toISOString()
    };
  }

  async extractConceptGraph(input: { source: KnowledgeSourceRecord; summary: KnowledgeSourceSummary; raw: string }): Promise<{ concepts: KnowledgeConcept[]; relations: KnowledgeRelation[] } | null> {
    const json = await this.generateJson<{ concepts?: unknown; relations?: unknown }>([
      'You are the concept and ontology extractor for the OpenAgent Knowledge Compiler.',
      'Extract important concepts/entities/decisions/rules/workflows/modules/apis/tools/preferences/open_questions and typed relations.',
      'Return only JSON: {"concepts":[{"name":"string","aliases":["string"],"type":"concept|entity|decision|rule|workflow|module|api|tool|preference|open_question","description":"string","confidence":"low|medium|high"}],"relations":[{"source":"concept name","target":"concept name","type":"implements|extends|depends_on|contradicts|derived_from|related_to|trades_off|prerequisite_of|mentions|supports","evidence":"string","confidence":"low|medium|high"}]}',
      `Source title: ${input.source.title}`,
      '<summary>',
      JSON.stringify(input.summary),
      '</summary>',
      '<source_excerpt>',
      input.raw.slice(0, 16_000),
      '</source_excerpt>'
    ].join('\n'));
    if (!json || !Array.isArray(json.concepts)) return null;
    const concepts = json.concepts.slice(0, 20).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      const name = asString(value.name).trim();
      if (!name) return [];
      return [{
        id: `concept-${slugify(name)}-${input.source.id}`,
        name,
        aliases: asStringArray(value.aliases, 8),
        type: asConceptType(value.type),
        description: asString(value.description).slice(0, 1200),
        sourceIds: [input.source.id],
        confidence: asConfidence(value.confidence)
      } satisfies KnowledgeConcept];
    });
    const byName = new Map(concepts.map((concept) => [concept.name.toLowerCase(), concept]));
    const relations = Array.isArray(json.relations)
      ? json.relations.slice(0, 40).flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const value = item as Record<string, unknown>;
          const source = byName.get(asString(value.source).toLowerCase());
          const target = byName.get(asString(value.target).toLowerCase());
          if (!source || !target || source.id === target.id) return [];
          return [{
            id: `relation-${source.id}-${target.id}-${slugify(asString(value.type) || 'related')}`,
            sourceConceptId: source.id,
            targetConceptId: target.id,
            type: asRelationType(value.type),
            evidence: asString(value.evidence).slice(0, 800),
            sourceIds: [input.source.id],
            confidence: asConfidence(value.confidence)
          } satisfies KnowledgeRelation];
        })
      : [];
    return concepts.length ? { concepts, relations } : null;
  }

  async writeArticle(input: { concept: KnowledgeConcept; summary: KnowledgeSourceSummary; relations: KnowledgeRelation[] }): Promise<string | null> {
    return this.generateText([
      'You are the article writer for the OpenAgent Knowledge Compiler.',
      'Write a concise Markdown wiki article in the same language as the source summary when possible.',
      'Requirements: include Summary, Key Points, Related Concepts, Evidence. Use [[wikilinks]] for related concepts. Do not include YAML frontmatter.',
      '<concept>', JSON.stringify(input.concept), '</concept>',
      '<summary>', JSON.stringify(input.summary), '</summary>',
      '<relations>', JSON.stringify(input.relations), '</relations>'
    ].join('\n'));
  }

  private async generateJson<T>(prompt: string): Promise<T | null> {
    const text = await this.generateText(prompt);
    if (!text) return null;
    const jsonText = extractJson(text);
    if (!jsonText) return null;
    try {
      return JSON.parse(jsonText) as T;
    } catch {
      return null;
    }
  }

  private async generateText(prompt: string): Promise<string | null> {
    const endpoint = await resolveChatEndpoint();
    if (!endpoint) return null;
    const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
        ...(endpoint.extraHeaders ?? {})
      },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You compile personal and project knowledge into structured, cited wiki artifacts.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || null;
  }
}

async function resolveChatEndpoint(): Promise<{ baseUrl: string; model: string; apiKey: string; extraHeaders?: Record<string, string> } | null> {
  const catalog = await buildPiProviderCatalog();
  const provider = catalog.providers.find((item) => item.id === catalog.activeProviderId) ?? catalog.providers.find((item) => item.enabled);
  if (!provider || !provider.auth.secret) return null;
  const baseUrl = provider.baseUrl || defaultBaseUrl(provider.id);
  if (!baseUrl) return null;
  return {
    baseUrl,
    model: provider.defaultModel,
    apiKey: provider.auth.secret,
    extraHeaders: provider.id === 'openrouter' ? { 'HTTP-Referer': 'https://openagent.local', 'X-Title': 'OpenAgent' } : undefined
  };
}

function resolveEmbeddingModel(chatModel: string) {
  if (/embedding/i.test(chatModel)) return chatModel;
  return 'text-embedding-3-small';
}

function defaultBaseUrl(providerId: string) {
  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com/v1'
  };
  return defaults[providerId] ?? '';
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}

function asString(value: unknown) { return typeof value === 'string' ? value : ''; }
function unique(values: string[]) { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function asStringArray(value: unknown, limit: number) { return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, limit) : []; }
function asConfidence(value: unknown) { return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium'; }
function asConceptType(value: unknown): KnowledgeConcept['type'] {
  const allowed = new Set(['concept', 'entity', 'decision', 'rule', 'workflow', 'module', 'api', 'tool', 'preference', 'open_question']);
  const text = asString(value);
  return allowed.has(text) ? (text as KnowledgeConcept['type']) : 'concept';
}
function asRelationType(value: unknown): KnowledgeRelation['type'] {
  const allowed = new Set(['implements', 'extends', 'depends_on', 'contradicts', 'derived_from', 'related_to', 'trades_off', 'prerequisite_of', 'mentions', 'supports']);
  const text = asString(value);
  return allowed.has(text) ? (text as KnowledgeRelation['type']) : 'related_to';
}
function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '') || `item-${Date.now()}`;
}
