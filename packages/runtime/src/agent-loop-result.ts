import type { AgentRuntimeRunResult } from './runtime-types.js';

export function summarizeRunResult(result: AgentRuntimeRunResult) {
  if (result.status === 'completed') {
    return result.summary ?? result.assistantMessage?.content ?? 'Run completed';
  }
  if (result.status === 'cancelled') {
    return result.summary ?? 'Run cancelled';
  }
  return result.error ?? result.summary ?? 'Run failed';
}
