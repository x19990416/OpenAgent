import type { ApprovalDecision, RuntimeApprovalRequest } from './approval-service.js';

export type RuntimeRunStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface RuntimeMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
  attachments?: RuntimeAttachment[];
  toolCallId?: string;
}

export interface RuntimeAttachment {
  id: string;
  path: string;
  name: string;
  kind: 'image' | 'text' | 'file' | 'binary';
  size: number;
  mimeType?: string;
  originalMimeType?: string;
  textContent?: string;
  imageDataUrl?: string;
  dataUrl?: string;
  originalDataUrl?: string;
  [key: string]: unknown;
}

export interface RuntimeThread {
  threadId: string;
  agentId: string;
  workspaceRoot: string;
  workspaceName: string;
  branch: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  runCount: number;
}

export interface RuntimeRecentRun {
  runId: string;
  threadId: string;
  prompt: string;
  currentAgent: string;
  status: RuntimeRunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  summary: string | null;
}

export interface RuntimeSnapshot {
  activeAgentId: string;
  latestRun: { status: RuntimeRunStatus; summary?: string | null } | null;
  pendingApproval: null | {
    approvalId: string;
    title: string;
    actionType: string;
    payloadPreview: string;
  };
  threads: RuntimeThread[];
  recentRuns: RuntimeRecentRun[];
  messages: RuntimeMessage[];
  activeThread: { threadId: string } | null;
}

export interface RuntimeTool {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(args: RuntimeToolExecutionInput): Promise<RuntimeToolExecutionResult>;
}

export interface RuntimeToolExecutionInput {
  toolCallId: string;
  input: unknown;
  signal: AbortSignal;
  onUpdate?: (update: unknown) => void;
}

export interface RuntimeToolExecutionResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export interface AgentRuntimeRunInput {
  runId: string;
  threadId: string;
  agentId: string;
  workspaceRoot: string;
  sessionFile: string;
  prompt: string;
  attachments?: RuntimeAttachment[];
  providerId: string;
  model: string;
  systemPrompt: string;
  messages: RuntimeMessage[];
  tools: RuntimeTool[];
  abortSignal: AbortSignal;
  onLog?: (entry: RuntimeLogEntry) => void;
  emitUiEvent?: (type: RuntimeUiEvent['type'], payload?: unknown) => void;
  requestApproval?: (request: RuntimeApprovalRequest) => Promise<ApprovalDecision>;
}

export interface RuntimeLogEntry {
  scope: 'context' | 'agent-loop' | 'pi-session' | 'runtime';
  message: string;
  data?: unknown;
}

export interface AgentRuntimeRunResult {
  status: 'completed' | 'cancelled' | 'failed';
  assistantMessage?: RuntimeMessage;
  summary?: string;
  error?: string;
}

export interface AgentRuntimeAdapter {
  run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult>;
  compact?(input: { threadId: string; sessionFile: string }): Promise<void>;
}

export interface RuntimeServiceOptions {
  agentId: string;
  workspaceName: string;
  workspaceRoot: string;
  branch: string;
  providerId: string;
  providerLabel: string;
  model: string;
  emitUiEvent: (event: RuntimeUiEvent) => void;
}

export interface RuntimeUiEvent {
  id: string;
  type:
    | 'run.started'
    | 'plan.created'
    | 'plan.updated'
    | 'plan.approval.required'
    | 'plan.approval.resolved'
    | 'plan.completed'
    | 'plan.failed'
    | 'tool.started'
    | 'tool.completed'
    | 'tool.failed'
    | 'message.completed'
    | 'patch.ready'
    | 'approval.required'
    | 'approval.resolved'
    | 'terminal.delta'
    | 'run.completed'
    | 'run.cancelled'
    | 'run.failed'
    | 'memory.updated';
  payload?: unknown;
  createdAt: string;
}

export interface PromptSubmissionInput {
  prompt: string;
  attachments?: RuntimeAttachment[];
  skillId?: string | null;
  awaitCompletion?: boolean;
}
