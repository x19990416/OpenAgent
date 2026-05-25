import { appendRuntimeInfoLog, errorToMessage } from '@openagent/runtime';
import type { KnowledgeContextRouter, KnowledgeService } from '@openagent/knowledge';

export class RuntimeKnowledgeController {
  constructor(
    private readonly knowledgeService: KnowledgeService,
    private readonly knowledgeContextRouter: KnowledgeContextRouter
  ) {}

  getHealth(scope: 'system' = 'system') {
    return this.knowledgeService.health(scope);
  }

  query(input: { query?: string; limit?: number }) {
    return this.knowledgeService.search({
      scope: 'system',
      query: String(input.query || ''),
      limit: input.limit
    });
  }

  ingest(input: { title?: string; content?: string; sourceId?: string; tags?: string[] }) {
    return this.knowledgeService.ingest({
      scope: 'system',
      title: String(input.title || ''),
      content: String(input.content || ''),
      sourceId: input.sourceId,
      tags: Array.isArray(input.tags) ? input.tags : undefined
    });
  }

  ingestFiles(files: Array<{ filePath?: string; title?: string; sourceId?: string; tags?: string[] }>) {
    return Promise.all(
      files
        .filter((file) => file.filePath)
        .map((file) =>
          this.knowledgeService.ingestFile({
            scope: 'system',
            filePath: String(file.filePath),
            title: file.title,
            sourceId: file.sourceId,
            tags: Array.isArray(file.tags) ? file.tags : undefined
          })
        )
    );
  }

  lint() {
    return this.knowledgeService.lint('system');
  }

  buildGraph() {
    return this.knowledgeService.graph({ scope: 'system', action: 'build' });
  }

  browse() {
    return this.knowledgeService.browse('system');
  }

  readArticle(input: { articleId?: string }) {
    return this.knowledgeService.readArticle(String(input.articleId || ''), 'system');
  }

  compile(input: { sourceIds?: string[]; limit?: number; tier?: 0 | 1 | 2 | 3 }) {
    return this.knowledgeService.compile({
      scope: 'system',
      sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds : undefined,
      limit: input.limit,
      tier: input.tier
    });
  }

  async buildContext(prompt: string, abortSignal?: AbortSignal) {
    try {
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context router start',
        data: { promptLength: prompt.length }
      });
      const decision = await this.knowledgeContextRouter.classify({ prompt, abortSignal }).catch((error) => {
        appendRuntimeInfoLog({
          scope: 'context',
          message: 'knowledge context router failed',
          data: { promptLength: prompt.length, error: errorToMessage(error) }
        });
        return null;
      });
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context router completed',
        data: {
          promptLength: prompt.length,
          needsKnowledge: Boolean(decision?.needsKnowledge),
          reason: decision?.reason || '(no router decision)',
          queryLength: decision?.query?.length ?? 0,
          limit: decision?.limit ?? 0
        }
      });
      if (!decision?.needsKnowledge) return '';
      const query = decision.query?.trim() || prompt;
      const limit = decision.limit ?? 3;
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledgeService.search start',
        data: { promptLength: prompt.length, queryLength: query.length, limit, routerReason: decision.reason }
      });
      const results = await this.knowledgeService.search({ scope: 'system', query, limit });
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledgeService.search completed',
        data: { promptLength: prompt.length, queryLength: query.length, resultCount: results.length }
      });
      if (results.length === 0) return '';
      return results
        .map((result, index) => {
          const citation = result.citations?.[0] || result.path || result.id;
          return [`[${index + 1}] ${result.title}`, `source: ${citation}`, result.content].join('\n');
        })
        .join('\n\n---\n\n');
    } catch (error) {
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'knowledge context lookup failed',
        data: { error: errorToMessage(error) }
      });
      return '';
    }
  }
}
