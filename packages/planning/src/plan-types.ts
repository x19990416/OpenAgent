export type PlanMode = 'planning' | 'executing';

export type PlanStatus =
  | 'draft'
  | 'exploring'
  | 'awaiting_approval'
  | 'executing'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked';

export type PlanRiskLevel = 'low' | 'medium' | 'high';

export interface AgentPlanStep {
  id: string;
  title: string;
  description?: string;
  status: PlanStepStatus;
  allowedTools?: string[];
  requiresApproval?: boolean;
  approvalReason?: string;
  riskLevel?: PlanRiskLevel;
  startedAt?: string;
  completedAt?: string;
  resultSummary?: string;
  error?: string;
  kind?: 'inspect' | 'design' | 'execute' | 'verify' | 'finalize';
  evidence?: Array<{
    kind: 'file' | 'log' | 'tool' | 'message';
    ref: string;
    summary?: string;
  }>;
}

export interface AgentPlan {
  id: string;
  runId: string;
  threadId: string;
  agentId: string;
  goal: string;
  mode: PlanMode;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  completedAt?: string;
  approvalRequired: boolean;
  approvalReason?: string;
  steps: AgentPlanStep[];
  revision: number;
  source: 'llm' | 'runtime' | 'user';
  riskLevel: PlanRiskLevel;
  summary?: string;
}

export interface PlanUpdatedPayload {
  plan: AgentPlan;
  changedStepId?: string;
  reason?: string;
  steps: Array<{ id: string; title: string; status: PlanStepStatus }>;
}
