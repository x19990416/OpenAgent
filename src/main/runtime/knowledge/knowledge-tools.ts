import type { RuntimeTool } from '../runtime-types.js';
import type { KnowledgeService } from './knowledge-service.js';

export function createKnowledgeTools(service: KnowledgeService): RuntimeTool[] {
  return [
    createKnowledgeSearchTool(service),
    createSystemWikiQueryTool(service),
    createSystemWikiIngestTool(service),
    createSystemWikiHealthTool(service),
    createSystemWikiLintTool(service),
    createSystemWikiBuildGraphTool(service)
  ];
}

function createKnowledgeSearchTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_search',
    label: 'Search Knowledge',
    description: 'Search OpenAgent system wiki knowledge.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or search query.' },
        limit: { type: 'number', description: 'Maximum results to return. Defaults to 8.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const results = await service.search({
        query: String(args.query ?? ''),
        scope: 'system',
        limit: typeof args.limit === 'number' ? args.limit : undefined
      });
      return { ok: true, content: formatResults(results), data: { results } };
    }
  };
}

function createSystemWikiQueryTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'system_wiki_query',
    label: 'Query System Wiki',
    description: 'Query the OpenAgent system wiki for architecture, product, runtime, plugin, skill, and shared project knowledge.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or search query.' },
        limit: { type: 'number', description: 'Maximum results to return. Defaults to 5.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const results = await service.search({ query: String(args.query ?? ''), scope: 'system', limit: typeof args.limit === 'number' ? args.limit : 5 });
      return { ok: true, content: formatResults(results), data: { results } };
    }
  };
}

function createSystemWikiIngestTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'system_wiki_ingest',
    label: 'Ingest System Wiki',
    description: 'Save explicitly provided content into the OpenAgent system wiki. Use only when the user asks to save or ingest system/project knowledge.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Source title.' },
        content: { type: 'string', description: 'Markdown or plain-text content to ingest.' },
        sourceId: { type: 'string', description: 'Optional stable source slug.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' }
      },
      required: ['title', 'content'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const result = await service.ingest({
        scope: 'system',
        title: String(args.title ?? ''),
        content: String(args.content ?? ''),
        sourceId: typeof args.sourceId === 'string' ? args.sourceId : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined
      });
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function createSystemWikiHealthTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'system_wiki_health',
    label: 'System Wiki Health',
    description: 'Run a deterministic structural health check for the OpenAgent system wiki.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: async ({ signal }) => {
      throwIfAborted(signal);
      const results = await service.health('system');
      return { ok: results.every((result) => result.ok), content: results.map((result) => result.message).join('\n'), data: { results } };
    }
  };
}

function createSystemWikiLintTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'system_wiki_lint',
    label: 'System Wiki Lint',
    description: 'Run deterministic lint checks for broken wikilinks, orphan pages, and sparse pages in the OpenAgent system wiki.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: async ({ signal }) => {
      throwIfAborted(signal);
      const result = await service.lintSystemWiki();
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function createSystemWikiBuildGraphTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'system_wiki_build_graph',
    label: 'Build System Wiki Graph',
    description: 'Build graph.json and graph.html from system wiki wikilinks.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: async ({ signal }) => {
      throwIfAborted(signal);
      const result = await service.buildSystemWikiGraph();
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function formatResults(results: Array<{ title: string; source: string; content: string; path?: string; score?: number }>) {
  if (results.length === 0) return 'No knowledge results found.';
  return results
    .map((result, index) => {
      const score = typeof result.score === 'number' ? ` score=${result.score}` : '';
      const path = result.path ? `\nPath: ${result.path}` : '';
      return `${index + 1}. [${result.source}] ${result.title}${score}${path}\n${result.content}`;
    })
    .join('\n\n');
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error('Knowledge tool execution aborted');
  }
}
