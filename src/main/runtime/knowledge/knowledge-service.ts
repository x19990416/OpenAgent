import { getSystemWikiRoot } from './knowledge-paths.js';
import type {
  KnowledgeGraphResult,
  KnowledgeHealthResult,
  KnowledgeIngestInput,
  KnowledgeIngestResult,
  KnowledgeLintResult,
  KnowledgeProvider,
  KnowledgeQueryInput,
  KnowledgeResult
} from './knowledge-types.js';
import { SystemWikiProvider } from './providers/system-wiki-provider.js';

export class KnowledgeService {
  private readonly systemWiki: SystemWikiProvider;

  constructor(_agentId: string) {
    this.systemWiki = new SystemWikiProvider(getSystemWikiRoot());
  }

  async search(input: KnowledgeQueryInput): Promise<KnowledgeResult[]> {
    const results = await Promise.all(this.resolveProviders(input.scope).map((provider) => provider.search(input)));
    return results
      .flat()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, normalizeLimit(input.limit, 8, 30));
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult> {
    return this.systemWiki.ingest(input);
  }

  async health(_scope: 'system' = 'system'): Promise<KnowledgeHealthResult[]> {
    const providers = this.resolveProviders('system');
    const results = await Promise.all(
      providers.map((provider) =>
        provider.health
          ? provider.health()
          : Promise.resolve({ ok: true, source: provider.source, message: `${provider.source} has no health check.` })
      )
    );
    return results;
  }

  lintSystemWiki(): Promise<KnowledgeLintResult> {
    return this.systemWiki.lint();
  }

  buildSystemWikiGraph(): Promise<KnowledgeGraphResult> {
    return this.systemWiki.buildGraph();
  }

  private resolveProviders(_scope: KnowledgeQueryInput['scope']): KnowledgeProvider[] {
    return [this.systemWiki];
  }
}

function normalizeLimit(value: unknown, fallback: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}
