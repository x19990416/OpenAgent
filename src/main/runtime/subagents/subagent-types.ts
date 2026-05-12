import type { RuntimeLogEntry, RuntimeToolExecutionContext, RuntimeUiEvent } from '../runtime-types.js';

export type SystemSubagentId = 'shell' | 'knowledge' | 'pi_coding';

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

export type KnowledgeAgentTask =
  | { operation: 'search' | 'query'; query: string; limit?: number }
  | { operation: 'ingest'; title: string; content: string; sourceId?: string; tags?: string[] }
  | { operation: 'ingest_file'; filePath: string; title?: string; sourceId?: string; tags?: string[] }
  | { operation: 'compile'; sourceIds?: string[]; limit?: number; tier?: 0 | 1 | 2 | 3 }
  | { operation: 'compile_topic'; topic: string; limit?: number; tier?: 0 | 1 | 2 | 3 }
  | { operation: 'capture'; text: string }
  | { operation: 'provenance'; targetId: string }
  | { operation: 'health' | 'lint' | 'graph' };

export interface PiCodingAgentTask {
  task: string;
  mode?: 'inspect' | 'edit' | 'execute' | 'generate';
  allowedTools?: string[];
  outputExpectation?: string;
  workingDirectory?: string;
  maxIterations?: number;
}

export type SystemSubagentTask = ShellAgentTask | KnowledgeAgentTask | PiCodingAgentTask;

export interface SubagentRunInput<TTask extends SystemSubagentTask = SystemSubagentTask> {
  task: TTask;
  callerAgentId: string;
  runId?: string;
  threadId?: string;
  workspaceRoot: string;
  signal: AbortSignal;
  toolCallId?: string;
  runtimeContext?: RuntimeToolExecutionContext;
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
