import type { RuntimeEventBus } from '@openagent/runtime';
import { PlanExecutor, PlanService, type AgentPlan, type PlanUpdatedPayload } from '@openagent/planning';
import { PlanLlmGenerator } from './planning/plan-llm.js';

export class RuntimePlanController {
  private readonly planService: PlanService;

  constructor(agentId: string, private readonly eventBus: RuntimeEventBus) {
    this.planService = new PlanService(agentId, new PlanLlmGenerator());
  }

  async createDraftPlan(input: { runId: string; threadId: string; agentId: string; prompt: string; now: string }) {
    const intent = await this.planService.classifyPlanningIntent(input.prompt);
    return intent.shouldPlan
      ? this.planService.createDraftPlan({
          runId: input.runId,
          threadId: input.threadId,
          agentId: input.agentId,
          prompt: input.prompt,
          intent,
          now: input.now
        })
      : null;
  }

  createExecutor(plan: AgentPlan, onUpdate: (nextPlan: AgentPlan, reason?: string, changedStepId?: string) => void) {
    return new PlanExecutor(plan, this.planService, onUpdate);
  }

  approve(plan: AgentPlan) {
    return this.planService.approve(plan);
  }

  reject(plan: AgentPlan) {
    return this.planService.reject(plan);
  }

  markFailed(plan: AgentPlan, summary: string) {
    return this.planService.markFailed(plan, summary);
  }

  markCompleted(plan: AgentPlan, summary: string) {
    return this.planService.markCompleted(plan, summary);
  }

  emit(type: 'plan.created' | 'plan.updated' | 'plan.completed' | 'plan.failed', plan: AgentPlan, reason?: string, changedStepId?: string) {
    this.eventBus.emit(type, this.toPayload(plan, reason, changedStepId));
  }

  emitApprovalRequired(plan: AgentPlan, reason?: string) {
    this.eventBus.emit('plan.approval.required', this.toPayload(plan, reason));
  }

  emitApprovalResolved(plan: AgentPlan, reason?: string) {
    this.eventBus.emit('plan.approval.resolved', this.toPayload(plan, reason));
  }

  toPayload(plan: AgentPlan, reason?: string, changedStepId?: string): PlanUpdatedPayload {
    return {
      plan,
      changedStepId,
      reason,
      steps: plan.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        description: step.description,
        allowedTools: step.allowedTools,
        requiresApproval: step.requiresApproval,
        approvalReason: step.approvalReason,
        riskLevel: step.riskLevel,
        resultSummary: step.resultSummary,
        error: step.error,
        kind: step.kind
      }))
    };
  }
}
