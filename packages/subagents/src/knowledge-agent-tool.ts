import type { RuntimeTool } from '@openagent/runtime';
import type { SubagentService } from './subagent-service.js';
import type { KnowledgeAgentTask } from './subagent-types.js';

export function createKnowledgeAgentTool(subagents: SubagentService, workspaceRoot: string): RuntimeTool {
  return {
    name: 'knowledge_agent',
    label: 'Knowledge Agent',
    description: [
      'Delegate knowledge-base tasks to the dedicated KnowledgeAgent.',
      'Use this for search, query, ingest, ingest_file, compile, compile_topic, health, lint, or graph operations.',
      'The agent only calls OpenAgent KnowledgeService and never bypasses ToolPolicy, run logs, or UI events.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['search', 'query', 'ingest', 'ingest_file', 'compile', 'compile_topic', 'capture', 'provenance', 'health', 'lint', 'graph'], description: 'Knowledge operation.' },
        query: { type: 'string', description: 'Search/query text. Required for search/query.' },
        topic: { type: 'string', description: 'Topic. Required for compile_topic.' },
        text: { type: 'string', description: 'Conversation text. Required for capture.' },
        targetId: { type: 'string', description: 'Target id. Required for provenance.' },
        limit: { type: 'number', description: 'Maximum items.' },
        title: { type: 'string', description: 'Source title. Required for ingest; optional for ingest_file.' },
        content: { type: 'string', description: 'Markdown/plain-text content to ingest. Required for ingest.' },
        filePath: { type: 'string', description: 'Absolute local file path. Required for ingest_file.' },
        sourceId: { type: 'string', description: 'Optional stable source slug.' },
        sourceIds: { type: 'array', items: { type: 'string' }, description: 'Optional source ids for compile.' },
        tier: { type: 'number', description: 'Compile tier 0-3.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' }
      },
      required: ['operation'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      const task = parseKnowledgeAgentTask(input);
      if (task.ok === false) return { ok: false, content: task.error };
      const result = await subagents.invoke('knowledge', { task: task.value, callerAgentId: 'tool:knowledge_agent', workspaceRoot, signal });
      return { ok: result.ok, content: result.summary, data: result };
    }
  };
}

function parseKnowledgeAgentTask(input: unknown): { ok: true; value: KnowledgeAgentTask } | { ok: false; error: string } {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const operation = typeof args.operation === 'string' ? args.operation : '';
  const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
  const sourceId = typeof args.sourceId === 'string' && args.sourceId.trim() ? args.sourceId.trim() : undefined;
  const tier = args.tier === 0 || args.tier === 1 || args.tier === 2 || args.tier === 3 ? args.tier : undefined;

  if (operation === 'search' || operation === 'query') {
    if (typeof args.query !== 'string' || !args.query.trim()) return { ok: false, error: 'query is required for search/query' };
    return { ok: true, value: { operation, query: args.query.trim(), limit: typeof args.limit === 'number' ? args.limit : undefined } };
  }
  if (operation === 'ingest') {
    if (typeof args.title !== 'string' || !args.title.trim()) return { ok: false, error: 'title is required for ingest' };
    if (typeof args.content !== 'string' || !args.content.trim()) return { ok: false, error: 'content is required for ingest' };
    return { ok: true, value: { operation, title: args.title.trim(), content: args.content.trim(), sourceId, tags } };
  }
  if (operation === 'ingest_file') {
    if (typeof args.filePath !== 'string' || !args.filePath.trim()) return { ok: false, error: 'filePath is required for ingest_file' };
    return { ok: true, value: { operation, filePath: args.filePath.trim(), title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined, sourceId, tags } };
  }
  if (operation === 'compile') {
    return { ok: true, value: { operation, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds.map(String) : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined, tier } };
  }
  if (operation === 'compile_topic') {
    if (typeof args.topic !== 'string' || !args.topic.trim()) return { ok: false, error: 'topic is required for compile_topic' };
    return { ok: true, value: { operation, topic: args.topic.trim(), limit: typeof args.limit === 'number' ? args.limit : undefined, tier } };
  }
  if (operation === 'capture') {
    if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, error: 'text is required for capture' };
    return { ok: true, value: { operation, text: args.text.trim() } };
  }
  if (operation === 'provenance') {
    if (typeof args.targetId !== 'string' || !args.targetId.trim()) return { ok: false, error: 'targetId is required for provenance' };
    return { ok: true, value: { operation, targetId: args.targetId.trim() } };
  }
  if (operation === 'health' || operation === 'lint' || operation === 'graph') return { ok: true, value: { operation } };
  return { ok: false, error: 'operation must be search, query, ingest, ingest_file, compile, compile_topic, capture, provenance, health, lint, or graph' };
}
