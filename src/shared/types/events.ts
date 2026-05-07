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

export interface PlanStepItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolCallItem {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'waiting_verification';
  summary: string;
  createdAt: string;
  meta?: Record<string, unknown>;
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
}

export interface ApprovalResolution {
  approvalId: string;
  decision: 'approved' | 'rejected';
  summary: string;
}

export interface RunFailurePayload {
  summary: string;
  details?: string;
}

export interface UiEvent {
  id: string;
  type:
    | 'run.started'
    | 'plan.updated'
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
    | 'memory.updated'
    | 'scheduled-task.updated';
  payload?: unknown;
  createdAt: string;
}
