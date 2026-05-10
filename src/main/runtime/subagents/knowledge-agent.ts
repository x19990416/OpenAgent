import type { KnowledgeService } from '../knowledge/knowledge-service.js';
import type { KnowledgeCompileResult, KnowledgeGraphResult, KnowledgeHealthResult, KnowledgeIngestResult, KnowledgeLintResult, KnowledgeResult } from '../knowledge/knowledge-types.js';
import type { KnowledgeAgentTask, SubagentRunInput, SubagentRunResult } from './subagent-types.js';

export class KnowledgeAgent {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  async run(input: SubagentRunInput<KnowledgeAgentTask>): Promise<SubagentRunResult> {
    if (input.signal.aborted) return { ok: false, agentId: 'knowledge', summary: 'KnowledgeAgent cancelled before start.', error: 'aborted' };

    input.onLog?.({ scope: 'runtime', message: 'KnowledgeAgent task started', data: { operation: input.task.operation, callerAgentId: input.callerAgentId, runId: input.runId, threadId: input.threadId } });
    try {
      const result = await this.executeTask(input.task);
      input.onLog?.({ scope: 'runtime', message: 'KnowledgeAgent task completed', data: { operation: input.task.operation, ok: result.ok, summary: result.summary, result: result.result } });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.onLog?.({ scope: 'runtime', message: 'KnowledgeAgent task failed', data: { operation: input.task.operation, error: message } });
      return { ok: false, agentId: 'knowledge', summary: `KnowledgeAgent failed: ${message}`, error: message };
    }
  }

  private async executeTask(task: KnowledgeAgentTask): Promise<SubagentRunResult> {
    if (task.operation === 'search') {
      const results = await this.knowledgeService.search({ scope: 'system', query: task.query, limit: task.limit });
      return { ok: true, agentId: 'knowledge', summary: formatKnowledgeResults(results), result: { operation: task.operation, query: task.query, results }, evidence: results.flatMap((item) => item.citations ?? []) };
    }

    if (task.operation === 'query') {
      const answer = await this.knowledgeService.query({ scope: 'system', query: task.query, limit: task.limit });
      return { ok: true, agentId: 'knowledge', summary: answer.answer, result: { operation: task.operation, query: task.query, answer }, evidence: answer.citations.map((item) => item.path || item.sourceId) };
    }

    if (task.operation === 'ingest') {
      const result = await this.knowledgeService.ingest({ scope: 'system', title: task.title, content: task.content, sourceId: task.sourceId, tags: task.tags });
      return formatMutationResult('ingest', result);
    }

    if (task.operation === 'ingest_file') {
      const result = await this.knowledgeService.ingestFile({ scope: 'system', filePath: task.filePath, title: task.title, sourceId: task.sourceId, tags: task.tags });
      return formatMutationResult('ingest_file', result);
    }

    if (task.operation === 'compile') {
      const result = await this.knowledgeService.compile({ scope: 'system', sourceIds: task.sourceIds, limit: task.limit, tier: task.tier });
      return formatCompileResult('compile', result);
    }

    if (task.operation === 'compile_topic') {
      const result = await this.knowledgeService.compileTopic({ scope: 'system', topic: task.topic, limit: task.limit, tier: task.tier });
      return formatCompileResult('compile_topic', result);
    }

    if (task.operation === 'capture') {
      const drafts = await this.knowledgeService.capture({ scope: 'system', text: task.text });
      return { ok: true, agentId: 'knowledge', summary: drafts.length ? drafts.map((draft) => `${draft.kind}: ${draft.title}`).join('\n') : 'No durable knowledge candidates found.', result: { operation: task.operation, drafts } };
    }

    if (task.operation === 'provenance') {
      const provenance = await this.knowledgeService.provenance({ scope: 'system', targetId: task.targetId });
      return { ok: true, agentId: 'knowledge', summary: provenance.length ? provenance.map((item) => `${item.targetType}:${item.targetId} <- ${item.sourcePath || item.sourceId}`).join('\n') : 'No provenance found.', result: { operation: task.operation, provenance }, evidence: provenance.map((item) => item.sourcePath || item.sourceId) };
    }

    if (task.operation === 'health') {
      const results = await this.knowledgeService.health('system');
      return { ok: results.every((item) => item.ok), agentId: 'knowledge', summary: formatHealthResults(results), result: { operation: task.operation, results } };
    }

    if (task.operation === 'lint') return formatMaintenanceResult('lint', await this.knowledgeService.lint('system'));
    if (task.operation === 'graph') return formatMaintenanceResult('graph', await this.knowledgeService.graph({ scope: 'system', action: 'build' }));

    return { ok: false, agentId: 'knowledge', summary: `Unsupported KnowledgeAgent operation: ${(task as { operation?: string }).operation}`, error: 'unsupported_operation' };
  }
}

function formatKnowledgeResults(results: KnowledgeResult[]) {
  if (results.length === 0) return 'No knowledge results found.';
  return results.map((item, index) => [`[${index + 1}] ${item.title}`, `source: ${item.path || item.citations?.[0] || item.id}`, item.content].join('\n')).join('\n\n---\n\n');
}

function formatMutationResult(operation: string, result: KnowledgeIngestResult): SubagentRunResult {
  return { ok: result.ok, agentId: 'knowledge', summary: result.message, result: { operation, result }, evidence: [...(result.path ? [result.path] : []), ...(result.articlePaths ?? [])] };
}

function formatCompileResult(operation: string, result: KnowledgeCompileResult): SubagentRunResult {
  return { ok: result.ok, agentId: 'knowledge', summary: result.message, result: { operation, result }, evidence: result.articlePaths ?? [] };
}

function formatHealthResults(results: KnowledgeHealthResult[]) {
  return results.map((item) => `${item.ok ? 'OK' : 'FAIL'} ${item.source}: ${item.message}`).join('\n');
}

function formatMaintenanceResult(operation: string, result: KnowledgeLintResult | KnowledgeGraphResult): SubagentRunResult {
  const evidence = ['reportPath' in result ? result.reportPath : undefined, 'graphJsonPath' in result ? result.graphJsonPath : undefined, 'graphHtmlPath' in result ? result.graphHtmlPath : undefined].filter((item): item is string => Boolean(item));
  return { ok: result.ok, agentId: 'knowledge', summary: result.message, result: { operation, result }, evidence };
}
