import type { PromptAttachmentDescriptor } from './index';

export type RunStatus = 'idle' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkspaceMeta {
  name: string;
  rootPath: string;
  branch: string;
  providerId: string;
  providerLabel: string;
  model: string;
  runStatus: RunStatus;
}

export interface MessageItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  attachments?: PromptAttachmentDescriptor[];
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked';

export interface PlanStepItem {
  id: string;
  title: string;
  status: PlanStepStatus;
  description?: string;
  allowedTools?: string[];
  requiresApproval?: boolean;
  approvalReason?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  resultSummary?: string;
  error?: string;
  kind?: 'inspect' | 'design' | 'execute' | 'verify' | 'finalize';
}

export interface AgentPlanItem {
  id: string;
  runId: string;
  threadId: string;
  goal: string;
  mode: 'planning' | 'executing';
  status: 'draft' | 'exploring' | 'awaiting_approval' | 'executing' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  approvalRequired: boolean;
  approvalReason?: string;
  riskLevel: 'low' | 'medium' | 'high';
  summary?: string;
  steps: PlanStepItem[];
}

export interface PlanUpdatedPayload {
  plan?: AgentPlanItem;
  changedStepId?: string;
  reason?: string;
  steps?: PlanStepItem[];
}

export interface ToolCallItem {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'waiting_verification';
  summary: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export type RuntimeActivityKind =
  | 'thinking'
  | 'search'
  | 'read'
  | 'list'
  | 'tool'
  | 'approval'
  | 'message'
  | 'command';

export type RuntimeActivityStatus = 'running' | 'completed' | 'failed';

export interface RuntimeActivityItem {
  id: string;
  runId?: string;
  threadId?: string;
  kind: RuntimeActivityKind;
  status: RuntimeActivityStatus;
  title: string;
  detail?: string;
  toolName?: string;
  target?: string;
  planId?: string;
  planStepId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface PatchArtifact {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  risk: 'low' | 'medium' | 'high';
  description: string;
  actionType?: 'external-path-read' | 'external-path-write' | 'shell' | 'git' | string;
  targetPath?: string;
  access?: 'read' | 'write' | 'execute';
  recursive?: boolean;
  scope?: 'once' | 'session' | 'always';
  payloadPreview?: string;
}

export interface ApprovalResolution {
  approvalId: string;
  decision: 'approved' | 'rejected';
  summary: string;
  scope?: 'once' | 'session' | 'always';
}

export interface RunFailurePayload {
  summary: string;
  details?: string;
}

export interface UiEvent {
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
    | 'message.completed'
    | 'patch.ready'
    | 'approval.required'
    | 'approval.resolved'
    | 'terminal.delta'
    | 'run.completed'
    | 'run.cancelled'
    | 'run.failed'
    | 'memory.updated'
    | 'scheduled-task.updated';
  payload?: unknown;
  createdAt: string;
}
