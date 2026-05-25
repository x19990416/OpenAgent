import { appendRuntimeInfoLog, ApprovalService, type RuntimeApprovalRequest, type RuntimeEventBus, type RunStateStore } from '@openagent/runtime';
import type { DesktopRuntimeHost } from './runtime-host.js';

export class RuntimeApprovalController {
  private readonly approvalService = new ApprovalService();

  constructor(
    private readonly runState: RunStateStore,
    private readonly eventBus: RuntimeEventBus,
    private readonly host: DesktopRuntimeHost
  ) {}

  getPendingApproval() {
    return this.approvalService.getPendingApproval();
  }

  resolveRuntimeApproval(input: { approvalId?: string; decision?: 'approved' | 'rejected'; scope?: 'once' | 'session' | 'always' }) {
    const result = this.approvalService.resolveApproval(input);
    if (result.ok) {
      const isPlanApproval = result.request.actionType === 'agent-plan.execute';
      if (result.request.runId) {
        this.runState.update(result.request.runId, {
          status: result.decision === 'approved' ? 'running' : 'failed',
          summary: result.decision === 'approved'
            ? '审批已通过，继续执行。'
            : isPlanApproval
              ? '用户拒绝了 Agent Plan。'
              : '用户拒绝了外部路径访问。'
        });
      }
      this.eventBus.emit('approval.resolved', {
        approvalId: input.approvalId || '',
        decision: result.decision,
        scope: result.scope,
        summary: isPlanApproval
          ? result.decision === 'approved'
            ? 'Agent Plan 已批准，agent 将开始执行。'
            : 'Agent Plan 已拒绝。'
          : result.decision === 'approved'
            ? result.scope === 'always'
              ? '已设为始终允许，同类操作后续将自动通过。'
              : result.scope === 'session'
                ? '已设为本会话允许，同类操作本会话内将自动通过。'
                : result.request.actionType?.startsWith('skill.script')
                  ? 'Skill 脚本执行已批准，本次调用将继续执行。'
                  : '外部路径访问已批准，agent 将继续执行。'
            : '外部路径访问已拒绝。'
      });
    }
    return result;
  }

  async requestToolApproval(request: Omit<RuntimeApprovalRequest, 'id'> & { id?: string }) {
    const approvalRequest = this.approvalService.createRequest(request);
    if (this.approvalService.isRequestApproved(approvalRequest)) {
      return 'approved' as const;
    }
    if (this.host.shouldAutoApproveRuntimeApprovals()) {
      appendRuntimeInfoLog({
        scope: 'approval',
        message: 'runtime approval auto-approved by settings',
        data: {
          approvalId: approvalRequest.id,
          actionType: approvalRequest.actionType,
          risk: approvalRequest.risk,
          targetPath: approvalRequest.targetPath,
          runId: approvalRequest.runId,
          threadId: approvalRequest.threadId
        }
      });
      if (approvalRequest.runId) {
        this.runState.update(approvalRequest.runId, {
          status: 'running',
          summary: `已按设置自动通过审批：${approvalRequest.title}`
        });
      }
      this.eventBus.emit('approval.resolved', {
        approvalId: approvalRequest.id,
        decision: 'approved',
        scope: 'once',
        summary: `已按设置自动通过审批：${approvalRequest.title}`
      });
      return 'approved' as const;
    }
    const { decision } = this.approvalService.requestApproval(approvalRequest);
    this.eventBus.emit('approval.required', approvalRequest);
    return decision;
  }

  autoApprovePendingApprovals(reason = 'settings') {
    const approved = this.approvalService.approveAllPending();
    for (const request of approved) {
      if (request.runId) {
        this.runState.update(request.runId, {
          status: 'running',
          summary: `已按设置自动通过审批：${request.title}`
        });
      }
      appendRuntimeInfoLog({
        scope: 'approval',
        message: 'pending approval auto-approved by settings',
        data: {
          reason,
          approvalId: request.id,
          actionType: request.actionType,
          risk: request.risk,
          targetPath: request.targetPath,
          runId: request.runId,
          threadId: request.threadId
        }
      });
      this.eventBus.emit('approval.resolved', {
        approvalId: request.id,
        decision: 'approved',
        scope: 'once',
        summary: `已按设置自动通过审批：${request.title}`
      });
    }
    return { ok: true, approvedCount: approved.length };
  }

  rejectPendingForRun(runId?: string) {
    return this.approvalService.rejectPendingForRun(runId);
  }
}
