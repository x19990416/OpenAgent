import type { ApprovalDecision, RuntimeApprovalRequest } from './approval-service.js';

export type RuntimeRunStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface RuntimeMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
  attachments?: RuntimeAttachment[];
  skillId?: string | null;
  skillName?: string | null;
  skillDisplayName?: string | null;
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
    risk?: 'low' | 'medium' | 'high';
    actionType: string;
    description?: string;
    targetPath?: string;
    access?: 'read' | 'write' | 'execute';
    recursive?: boolean;
    scope?: 'once' | 'session' | 'always';
    payloadPreview: string;
  };
  threads: RuntimeThread[];
  recentRuns: RuntimeRecentRun[];
  messages: RuntimeMessage[];
  activeThread: { threadId: string } | null;
}

export type RuntimeToolPolicyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | {
      kind: 'requires_approval';
      approval: {
        title: string;
        risk: 'low' | 'medium' | 'high';
        description: string;
        actionType: string;
        targetPath?: string;
        access?: 'read' | 'write' | 'execute';
        recursive?: boolean;
        scope?: 'once' | 'session' | 'always';
        payloadPreview?: string;
      };
    };

export interface RuntimeTool {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  risk?: 'read' | 'external_send' | 'external_write' | 'destructive' | 'secret_access';
  pluginId?: string;
  policy?: (args: unknown, planContext?: PlanExecutionContext | null) => RuntimeToolPolicyDecision | null;
  execute(args: RuntimeToolExecutionInput): Promise<RuntimeToolExecutionResult>;
}

export interface RuntimeToolExecutionInput {
  toolCallId: string;
  input: unknown;
  signal: AbortSignal;
  onUpdate?: (update: unknown) => void;
  context?: RuntimeToolExecutionContext;
}

export interface RuntimeToolExecutionResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export interface RuntimeToolExecutionContext {
  runId?: string;
  threadId?: string;
  agentId?: string;
  sessionFile?: string;
  workspaceRoot?: string;
  tools?: RuntimeTool[];
  providerId?: string;
  model?: string;
  onLog?: (entry: RuntimeLogEntry) => void;
  emitUiEvent?: (type: RuntimeUiEvent['type'], payload?: unknown) => void;
  requestApproval?: (request: RuntimeApprovalRequest) => Promise<ApprovalDecision>;
  getPlanContext?: () => PlanExecutionContext | null;
}


export interface PlanExecutionContext {
  planId: string;
  stepId: string;
  mode: 'planning' | 'executing';
  allowedTools?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  selectedSkillName?: string;
  selectedSkillHasScripts?: boolean;
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
  getPlanContext?: () => PlanExecutionContext | null;
  maxIterations?: number;
  promptContext?: RuntimePromptContext;
}

export interface RuntimePromptContext {
  transcriptMode: 'recent' | 'tool_minimal';
  reason: string;
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
  loopCount?: number;
  toolResultCount?: number;
}

export interface AgentRuntimeCompactInput {
  threadId: string;
  agentId: string;
  workspaceRoot: string;
  sessionFile: string;
  providerId: string;
  model: string;
  abortSignal?: AbortSignal;
  onLog?: (entry: RuntimeLogEntry) => void;
  emitUiEvent?: (type: RuntimeUiEvent['type'], payload?: unknown) => void;
}

export interface AgentRuntimeCompactResult {
  ok: boolean;
  summary?: string;
  error?: string;
  data?: unknown;
}

export interface AgentRuntimeAdapter {
  run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult>;
  compact?(input: AgentRuntimeCompactInput): Promise<AgentRuntimeCompactResult>;
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
  pluginContextResolver?: {
    getRuntimeTools(): RuntimeTool[];
    getRelevantSkillSummaries(prompt: string): string[];
    getSkillPackages?(): Array<{ pluginId: string; pluginName: string; name: string; description?: string; content?: string; rootDir?: string; skillFile?: string }>;
  };
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
    | 'runtime.activity'
    | 'skill.resolved'
    | 'skill.loaded'
    | 'skill.script.started'
    | 'skill.script.updated'
    | 'skill.script.completed'
    | 'skill.script.failed'
    | 'message.delta'
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
  skillName?: string | null;
  skillDisplayName?: string | null;
  awaitCompletion?: boolean;
}
