import { getSystemKnowledgeRoot } from './knowledge-paths.js';
import type {
  KnowledgeCompileInput,
  KnowledgeCompileResult,
  KnowledgeCompileTopicInput,
  KnowledgeGraphInput,
  KnowledgeCaptureInput,
  KnowledgeCaptureDraft,
  KnowledgeProvenanceInput,
  KnowledgeProvenance,
  KnowledgeGraphResult,
  KnowledgeHealthResult,
  KnowledgeIngestFileInput,
  KnowledgeIngestInput,
  KnowledgeIngestResult,
  KnowledgeLintResult,
  KnowledgeProvider,
  KnowledgeBrowseSnapshot,
  KnowledgeArticleReadResult,
  KnowledgeQueryInput,
  KnowledgeResult,
  KnowledgeSearchInput
} from './knowledge-types.js';
import { OpenAgentKnowledgeLlm } from './knowledge-llm.js';
import { SystemKnowledgeProvider } from './providers/system-knowledge-provider.js';

export class KnowledgeService {
  private readonly providers = new Map<string, KnowledgeProvider>();
  private readonly systemProvider: SystemKnowledgeProvider;

  constructor(_agentId: string) {
    this.systemProvider = new SystemKnowledgeProvider(getSystemKnowledgeRoot(), new OpenAgentKnowledgeLlm());
    this.registerProvider(this.systemProvider);
  }

  registerProvider(provider: KnowledgeProvider) {
    const descriptor = provider.descriptor();
    this.providers.set(descriptor.id, provider);
  }

  listProviders() {
    return [...this.providers.values()].map((provider) => provider.descriptor());
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeResult[]> {
    const results = await Promise.all(this.resolveProviders(input).map((provider) => provider.search(input)));
    return results
      .flat()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, normalizeLimit(input.limit, 8, 30));
  }

  async query(input: KnowledgeQueryInput) {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (provider.query) return provider.query(input);
    const results = await provider.search(input);
    return {
      answer: results.map((result) => result.content).join('\n\n'),
      citations: results.map((result) => ({ sourceId: result.id, path: result.path || result.citations?.[0] })),
      usedSourceIds: results.map((result) => result.id),
      usedArticleIds: [],
      confidence: results.length > 0 ? 'medium' : 'low'
    } as const;
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult> {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (!provider.ingest) return { ok: false, source: provider.source, message: `${provider.descriptor().displayName} does not support ingest.` };
    return provider.ingest(input);
  }

  async ingestFile(input: KnowledgeIngestFileInput): Promise<KnowledgeIngestResult> {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (!provider.ingestFile) return { ok: false, source: provider.source, message: `${provider.descriptor().displayName} does not support ingest_file.` };
    return provider.ingestFile(input);
  }

  async compile(input: KnowledgeCompileInput): Promise<KnowledgeCompileResult> {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (!provider.compile) return { ok: false, source: provider.source, message: `${provider.descriptor().displayName} does not support compile.`, compiled: 0, skipped: 0, failed: 1 };
    return provider.compile(input);
  }

  async compileTopic(input: KnowledgeCompileTopicInput): Promise<KnowledgeCompileResult> {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (!provider.compileTopic) return { ok: false, source: provider.source, message: `${provider.descriptor().displayName} does not support compile_topic.`, compiled: 0, skipped: 0, failed: 1 };
    return provider.compileTopic(input);
  }

  async health(scope: 'system' = 'system'): Promise<KnowledgeHealthResult[]> {
    const results = await Promise.all(
      this.resolveProviders({ scope }).map((provider) =>
        provider.health
          ? provider.health()
          : Promise.resolve({ ok: true, source: provider.source, message: `${provider.descriptor().displayName} has no health check.` })
      )
    );
    return results;
  }


  async capture(input: KnowledgeCaptureInput): Promise<KnowledgeCaptureDraft[]> {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (!provider.capture) return [];
    return provider.capture(input);
  }

  async provenance(input: KnowledgeProvenanceInput): Promise<KnowledgeProvenance[]> {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (!provider.provenance) return [];
    return provider.provenance(input);
  }

  async graph(input: KnowledgeGraphInput): Promise<KnowledgeGraphResult> {
    const provider = this.resolveProvider(input.providerId, input.scope);
    if (!provider.graph) return { ok: false, source: provider.source, message: `${provider.descriptor().displayName} does not support graph.` };
    return provider.graph(input);
  }

  async lint(scope: 'system' = 'system'): Promise<KnowledgeLintResult> {
    const provider = this.resolveProvider(undefined, scope);
    if (!provider.lint) return { ok: true, source: provider.source, message: `${provider.descriptor().displayName} has no lint check.` };
    return provider.lint();
  }

  async browse(scope: 'system' = 'system'): Promise<KnowledgeBrowseSnapshot> {
    const provider = this.resolveProvider(undefined, scope);
    if (!provider.browse) {
      return { provider: provider.descriptor(), root: provider.descriptor().rootPath ?? '', sources: [], articles: [], pending: [], quality: [] };
    }
    return provider.browse();
  }

  async readArticle(articleId: string, scope: 'system' = 'system'): Promise<KnowledgeArticleReadResult> {
    const provider = this.resolveProvider(undefined, scope);
    if (!provider.readArticle) return { ok: false, source: provider.source, articleId, message: `${provider.descriptor().displayName} does not support article reading.` };
    return provider.readArticle(articleId);
  }

  private resolveProviders(input: Pick<KnowledgeSearchInput, 'providerId' | 'scope'>): KnowledgeProvider[] {
    if (input.providerId) return [this.resolveProvider(input.providerId, input.scope)];
    return [...this.providers.values()].filter((provider) => provider.descriptor().scope === input.scope);
  }

  private resolveProvider(providerId: string | undefined, scope: KnowledgeSearchInput['scope']): KnowledgeProvider {
    if (providerId) {
      const provider = this.providers.get(providerId);
      if (!provider) throw new Error(`Knowledge provider not found: ${providerId}`);
      return provider;
    }
    const provider = [...this.providers.values()].find((item) => item.descriptor().scope === scope);
    if (!provider) throw new Error(`Knowledge provider not found for scope: ${scope}`);
    return provider;
  }
}

function normalizeLimit(value: unknown, fallback: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}
