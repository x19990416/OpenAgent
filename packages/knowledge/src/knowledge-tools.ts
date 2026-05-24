import type { RuntimeTool } from '@openagent/runtime';
import type { KnowledgeService } from './knowledge-service.js';

export function createKnowledgeTools(service: KnowledgeService): RuntimeTool[] {
  return [
    createKnowledgeSearchTool(service),
    createKnowledgeQueryTool(service),
    createKnowledgeIngestTool(service),
    createKnowledgeIngestFileTool(service),
    createKnowledgeCompileTool(service),
    createKnowledgeCompileTopicTool(service),
    createKnowledgeHealthTool(service),
    createKnowledgeLintTool(service),
    createKnowledgeGraphTool(service),
    createKnowledgeCaptureTool(service),
    createKnowledgeProvenanceTool(service)
  ];
}

function createKnowledgeSearchTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_search',
    label: 'Search Knowledge',
    description: 'Search the OpenAgent knowledge providers. Defaults to the built-in system Knowledge Compiler.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or search query.' },
        scope: { type: 'string', enum: ['system'], description: 'Knowledge scope. Defaults to system.' },
        limit: { type: 'number', description: 'Maximum results to return. Defaults to 8.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const results = await service.search({ query: String(args.query ?? ''), scope: 'system', limit: typeof args.limit === 'number' ? args.limit : undefined });
      return { ok: true, content: formatResults(results), data: { results } };
    }
  };
}

function createKnowledgeQueryTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_query',
    label: 'Query Knowledge',
    description: 'Ask the OpenAgent knowledge base and return a citation-aware answer.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question to answer.' },
        scope: { type: 'string', enum: ['system'], description: 'Knowledge scope. Defaults to system.' },
        limit: { type: 'number', description: 'Maximum search results to use. Defaults to 5.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const answer = await service.query({ query: String(args.query ?? ''), scope: 'system', limit: typeof args.limit === 'number' ? args.limit : 5 });
      return { ok: true, content: answer.answer, data: answer };
    }
  };
}

function createKnowledgeIngestTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_ingest',
    label: 'Ingest Knowledge',
    description: 'Ingest explicitly provided content into the OpenAgent Knowledge Compiler as a source, then compile it by default.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Source title.' },
        content: { type: 'string', description: 'Markdown or plain-text content to ingest.' },
        sourceId: { type: 'string', description: 'Optional stable source slug.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        compile: { type: 'boolean', description: 'Whether to compile immediately. Defaults to true.' }
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
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        compile: typeof args.compile === 'boolean' ? args.compile : undefined
      });
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function createKnowledgeIngestFileTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_ingest_file',
    label: 'Ingest Knowledge File',
    description: 'Archive an explicitly selected local file into the OpenAgent knowledge base, extract supported text/metadata, and compile it by default.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute local file path.' },
        title: { type: 'string', description: 'Optional source title.' },
        sourceId: { type: 'string', description: 'Optional stable source slug.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        compile: { type: 'boolean', description: 'Whether to compile immediately. Defaults to true.' }
      },
      required: ['filePath'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const result = await service.ingestFile({
        scope: 'system',
        filePath: String(args.filePath ?? ''),
        title: typeof args.title === 'string' ? args.title : undefined,
        sourceId: typeof args.sourceId === 'string' ? args.sourceId : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        compile: typeof args.compile === 'boolean' ? args.compile : undefined
      });
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function createKnowledgeCompileTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_compile',
    label: 'Compile Knowledge',
    description: 'Compile pending or selected OpenAgent knowledge sources into summaries, concepts, articles, provenance, index, and graph.',
    parameters: {
      type: 'object',
      properties: {
        sourceIds: { type: 'array', items: { type: 'string' }, description: 'Optional source ids to compile.' },
        limit: { type: 'number', description: 'Maximum pending sources to compile.' },
        tier: { type: 'number', description: 'Compile tier 0-3. Defaults to item tier or 3.' }
      },
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const result = await service.compile({
        scope: 'system',
        sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds.map(String) : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        tier: isTier(args.tier) ? args.tier : undefined
      });
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function createKnowledgeCompileTopicTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_compile_topic',
    label: 'Compile Knowledge Topic',
    description: 'Compile sources related to a topic on demand.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to compile.' },
        limit: { type: 'number', description: 'Maximum matching sources.' },
        tier: { type: 'number', description: 'Compile tier 0-3. Defaults to 3.' }
      },
      required: ['topic'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const result = await service.compileTopic({ scope: 'system', topic: String(args.topic ?? ''), limit: typeof args.limit === 'number' ? args.limit : undefined, tier: isTier(args.tier) ? args.tier : undefined });
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function createKnowledgeHealthTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_health',
    label: 'Knowledge Health',
    description: 'Run a structural health check for configured knowledge providers.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ signal }) => {
      throwIfAborted(signal);
      const results = await service.health('system');
      return { ok: results.every((result) => result.ok), content: results.map((result) => result.message).join('\n'), data: { providers: service.listProviders(), results } };
    }
  };
}

function createKnowledgeLintTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_lint',
    label: 'Knowledge Lint',
    description: 'Check the knowledge compiler manifest, artifacts, provenance, and generated articles.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ signal }) => {
      throwIfAborted(signal);
      const result = await service.lint('system');
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}

function createKnowledgeGraphTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_graph',
    label: 'Knowledge Graph',
    description: 'Build or fetch the OpenAgent knowledge graph.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['get', 'build'], description: 'Graph action. Defaults to build.' } },
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const result = await service.graph({ scope: 'system', action: args.action === 'get' ? 'get' : 'build' });
      return { ok: result.ok, content: result.message, data: result };
    }
  };
}


function createKnowledgeCaptureTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_capture',
    label: 'Capture Knowledge',
    description: 'Extract durable knowledge candidates from conversation text for later approval/ingest.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Conversation or selected text to analyze.' } },
      required: ['text'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const drafts = await service.capture({ scope: 'system', text: String(args.text ?? '') });
      return { ok: true, content: drafts.length ? drafts.map((draft) => `- ${draft.kind}: ${draft.title}`).join('\n') : 'No durable knowledge candidates found.', data: { drafts } };
    }
  };
}

function createKnowledgeProvenanceTool(service: KnowledgeService): RuntimeTool {
  return {
    name: 'knowledge_provenance',
    label: 'Knowledge Provenance',
    description: 'Look up source evidence for a knowledge summary, concept, relation, article, or source id.',
    parameters: {
      type: 'object',
      properties: { targetId: { type: 'string', description: 'Knowledge target id or source id.' } },
      required: ['targetId'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const provenance = await service.provenance({ scope: 'system', targetId: String(args.targetId ?? '') });
      return { ok: true, content: provenance.length ? provenance.map((item) => `- ${item.targetType}:${item.targetId} <- ${item.sourcePath || item.sourceId}`).join('\n') : 'No provenance found.', data: { provenance } };
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

function isTier(value: unknown): value is 0 | 1 | 2 | 3 {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Knowledge tool execution aborted');
}
