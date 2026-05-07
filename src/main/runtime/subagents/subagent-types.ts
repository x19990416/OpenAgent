import type { RuntimeLogEntry, RuntimeUiEvent } from '../runtime-types.js';

export type SystemSubagentId = 'shell';

export interface SubagentRunInput {
  task: string;
  callerAgentId: string;
  runId?: string;
  threadId?: string;
  workspaceRoot: string;
  signal: AbortSignal;
  onLog?: (entry: RuntimeLogEntry) => void;
  emitUiEvent?: (type: RuntimeUiEvent['type'], payload?: unknown) => void;
}

export interface SubagentRunResult {
  ok: boolean;
  agentId: SystemSubagentId;
  summary: string;
  result?: unknown;
  evidence?: string[];
  error?: string;
}
