import { randomUUID } from 'node:crypto';

export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalRisk = 'low' | 'medium' | 'high';
export type ApprovalAccess = 'read' | 'write' | 'execute';
export type ApprovalScope = 'once' | 'session' | 'always';

export interface RuntimeApprovalRequest {
  id: string;
  title: string;
  risk: ApprovalRisk;
  description: string;
  actionType?: string;
  targetPath?: string;
  access?: ApprovalAccess;
  recursive?: boolean;
  scope?: ApprovalScope;
  payloadPreview?: string;
  runId?: string;
  threadId?: string;
}

interface PendingApproval {
  request: RuntimeApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();
  private approveAllFutureRequests = false;

  requiresApproval(actionType: string) {
    return ['shell', 'git.push', 'git.reset', 'external-path-read', 'external-path-write', 'destructive'].includes(actionType);
  }

  requestApproval(input: Omit<RuntimeApprovalRequest, 'id'> & { id?: string }) {
    const request: RuntimeApprovalRequest = {
      ...input,
      id: input.id || `approval-${randomUUID()}`,
      scope: input.scope || 'once'
    };

    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(request.id, { request, resolve });
    });

    return { request, decision };
  }

  isAutoApproved() {
    return this.approveAllFutureRequests;
  }

  resolveApproval(input: { approvalId?: string; decision?: ApprovalDecision; scope?: ApprovalScope }) {
    const approvalId = input.approvalId || '';
    const decision = input.decision;
    if (!approvalId) {
      return { ok: false, error: 'approvalId is required' };
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return { ok: false, error: 'decision must be approved or rejected' };
    }

    const pending = this.pending.get(approvalId);
    if (!pending) {
      return { ok: false, error: `Unknown approval: ${approvalId}` };
    }

    this.pending.delete(approvalId);
    if (decision === 'approved' && input.scope === 'always') {
      this.approveAllFutureRequests = true;
    }
    pending.resolve(decision);
    return { ok: true, request: pending.request, decision, scope: input.scope || pending.request.scope || 'once' };
  }

  getPendingApproval() {
    const pending = this.pending.values().next().value as PendingApproval | undefined;
    if (!pending) return null;
    return {
      approvalId: pending.request.id,
      title: pending.request.title,
      risk: pending.request.risk,
      actionType: pending.request.actionType || 'unknown',
      description: pending.request.description,
      targetPath: pending.request.targetPath,
      access: pending.request.access,
      recursive: pending.request.recursive,
      scope: pending.request.scope,
      payloadPreview: pending.request.payloadPreview || pending.request.description
    };
  }
}
