import path from 'node:path';
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

interface ApprovalGrant {
  scope: Exclude<ApprovalScope, 'once'>;
  actionType: string;
  access?: ApprovalAccess;
  targetPath?: string;
  recursive?: boolean;
  threadId?: string;
  createdAt: string;
}

export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly grants: ApprovalGrant[] = [];

  requiresApproval(actionType: string) {
    return ['shell', 'git.push', 'git.reset', 'external-path-read', 'external-path-write', 'destructive'].includes(actionType);
  }

  requestApproval(input: Omit<RuntimeApprovalRequest, 'id'> & { id?: string }) {
    const request: RuntimeApprovalRequest = {
      ...input,
      id: input.id || `approval-${randomUUID()}`,
      scope: input.scope || 'once'
    };

    if (this.isRequestApproved(request)) {
      return { request, decision: Promise.resolve('approved' as const) };
    }

    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(request.id, { request, resolve });
    });

    return { request, decision };
  }

  isRequestApproved(request: RuntimeApprovalRequest) {
    return this.grants.some((grant) => matchesGrant(grant, request));
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
    const scope = input.scope || pending.request.scope || 'once';
    if (decision === 'approved' && scope !== 'once') {
      this.addGrant(pending.request, scope);
    }
    pending.resolve(decision);
    return { ok: true, request: pending.request, decision, scope };
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

  rejectPendingForRun(runId?: string) {
    const rejected: RuntimeApprovalRequest[] = [];
    for (const [approvalId, pending] of this.pending.entries()) {
      if (runId && pending.request.runId !== runId) continue;
      this.pending.delete(approvalId);
      pending.resolve('rejected');
      rejected.push(pending.request);
    }
    return rejected;
  }

  private addGrant(request: RuntimeApprovalRequest, scope: Exclude<ApprovalScope, 'once'>) {
    const grant: ApprovalGrant = {
      scope,
      actionType: request.actionType || 'unknown',
      access: request.access,
      targetPath: normalizePath(request.targetPath),
      recursive: Boolean(request.recursive),
      threadId: scope === 'session' ? request.threadId : undefined,
      createdAt: new Date().toISOString()
    };

    if (!this.grants.some((existing) => sameGrant(existing, grant))) {
      this.grants.push(grant);
    }
  }
}

function matchesGrant(grant: ApprovalGrant, request: RuntimeApprovalRequest) {
  if (grant.actionType !== (request.actionType || 'unknown')) return false;
  if (grant.access && grant.access !== request.access) return false;
  if (grant.scope === 'session' && grant.threadId !== request.threadId) return false;

  const requestPath = normalizePath(request.targetPath);
  if (!grant.targetPath) return !requestPath;
  if (!requestPath) return false;
  if (grant.recursive) {
    return requestPath === grant.targetPath || requestPath.startsWith(`${grant.targetPath}${path.sep}`);
  }
  return requestPath === grant.targetPath;
}

function sameGrant(left: ApprovalGrant, right: ApprovalGrant) {
  return left.scope === right.scope &&
    left.actionType === right.actionType &&
    left.access === right.access &&
    left.targetPath === right.targetPath &&
    left.recursive === right.recursive &&
    left.threadId === right.threadId;
}

function normalizePath(value?: string) {
  if (!value) return undefined;
  return path.normalize(value);
}
