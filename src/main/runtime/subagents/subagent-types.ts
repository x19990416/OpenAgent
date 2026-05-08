import type { RuntimeLogEntry, RuntimeUiEvent } from '../runtime-types.js';

export type SystemSubagentId = 'shell';

export type ShellAgentTask =
  | { operation: 'count_files'; root?: string; extension: string }
  | { operation: 'find_files'; root?: string; extension?: string | null }
  | {
      operation: 'find_files_containing';
      root?: string;
      namePattern?: string | null;
      contentPattern: string;
      ignoreCase?: boolean;
      literal?: boolean;
    };

export interface SubagentRunInput {
  task: ShellAgentTask;
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
