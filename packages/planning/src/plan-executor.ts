import type { AgentPlan } from './plan-types.js';
import { PlanService } from './plan-service.js';

export class PlanExecutor {
  constructor(
    private plan: AgentPlan,
    private readonly service: PlanService,
    private readonly onUpdate: (plan: AgentPlan, reason: string, changedStepId?: string) => void
  ) {}

  get currentPlan() {
    return this.plan;
  }

  startStep(stepId: string, reason: string) {
    this.plan = this.service.startStep(this.plan, stepId);
    this.onUpdate(this.plan, reason, stepId);
    return this.plan;
  }

  completeStep(stepId: string, summary: string) {
    this.plan = this.service.completeStep(this.plan, stepId, summary);
    this.onUpdate(this.plan, summary, stepId);
    return this.plan;
  }

  completeAndStart(completedStepId: string, completedSummary: string, nextStepId: string, nextReason: string) {
    this.plan = this.service.completeStep(this.plan, completedStepId, completedSummary);
    this.plan = this.service.startStep(this.plan, nextStepId);
    this.onUpdate(this.plan, nextReason, nextStepId);
    return this.plan;
  }

  completeAndStartFirstKind(completedStepId: string, completedSummary: string, nextKind: NonNullable<AgentPlan['steps'][number]['kind']>, nextReason: string) {
    const nextStep = this.plan.steps.find((step) => step.kind === nextKind && step.status === 'pending');
    if (!nextStep) return this.completeStep(completedStepId, completedSummary);
    return this.completeAndStart(completedStepId, completedSummary, nextStep.id, nextReason);
  }

  completeKind(kind: NonNullable<AgentPlan['steps'][number]['kind']>, summary: string) {
    let nextPlan = this.plan;
    for (const step of nextPlan.steps.filter((item) => item.kind === kind && item.status !== 'completed')) {
      nextPlan = this.service.completeStep(nextPlan, step.id, summary);
    }
    this.plan = nextPlan;
    this.onUpdate(this.plan, summary);
    return this.plan;
  }

  completeKindAndStartFirstKind(kind: NonNullable<AgentPlan['steps'][number]['kind']>, summary: string, nextKind: NonNullable<AgentPlan['steps'][number]['kind']>, nextReason: string) {
    this.completeKind(kind, summary);
    const nextStep = this.plan.steps.find((step) => step.kind === nextKind && step.status === 'pending');
    if (!nextStep) return this.plan;
    this.plan = this.service.startStep(this.plan, nextStep.id);
    this.onUpdate(this.plan, nextReason, nextStep.id);
    return this.plan;
  }

  failCurrent(error: string) {
    this.plan = this.service.markFailed(this.plan, error);
    this.onUpdate(this.plan, error);
    return this.plan;
  }
}
