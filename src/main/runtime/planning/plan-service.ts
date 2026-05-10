import { randomUUID } from 'node:crypto';
import type { AgentPlan, AgentPlanStep, PlanRiskLevel } from './plan-types.js';
import { PlanStore } from './plan-store.js';

export interface CreateDraftPlanInput {
  runId: string;
  threadId: string;
  agentId: string;
  prompt: string;
  now?: string;
}

export class PlanService {
  private readonly store: PlanStore;

  constructor(private readonly agentId: string) {
    this.store = new PlanStore(agentId);
  }

  shouldPlan(prompt: string) {
    const normalized = prompt.toLowerCase();
    return (
      /\bplan\b|plan mode|计划|规划|先说怎么做|先不要改|设计方案|实现掉|帮我实现|开发|重构|改一下|落实/.test(normalized) &&
      !/不要.*plan|不用.*计划|直接回答|只回答|不要修改代码/.test(normalized)
    );
  }

  createDraftPlan(input: CreateDraftPlanInput) {
    const now = input.now || new Date().toISOString();
    const riskLevel = inferRiskLevel(input.prompt);
    const plan: AgentPlan = {
      id: `plan-${randomUUID()}`,
      runId: input.runId,
      threadId: input.threadId,
      agentId: input.agentId,
      goal: input.prompt,
      mode: 'planning',
      status: 'awaiting_approval',
      createdAt: now,
      updatedAt: now,
      approvalRequired: true,
      approvalReason: 'Plan Mode 已为该任务生成执行计划；需要用户确认后再进入执行阶段。',
      steps: buildDraftSteps(input.prompt, riskLevel),
      revision: 0,
      source: 'runtime',
      riskLevel,
      summary: '等待用户确认执行计划。'
    };
    return this.store.save(plan);
  }

  approve(plan: AgentPlan) {
    return this.store.save({
      ...plan,
      mode: 'executing',
      status: 'executing',
      approvedAt: new Date().toISOString(),
      summary: '用户已确认计划，开始执行。',
      steps: plan.steps.map((step, index) => ({
        ...step,
        status: index === 0 ? 'in_progress' : 'pending',
        startedAt: index === 0 ? new Date().toISOString() : step.startedAt
      }))
    });
  }

  reject(plan: AgentPlan) {
    return this.store.save({
      ...plan,
      status: 'cancelled',
      summary: '用户取消了计划执行。',
      steps: plan.steps.map((step) => (step.status === 'completed' ? step : { ...step, status: 'skipped' }))
    });
  }

  markCompleted(plan: AgentPlan, summary?: string) {
    const now = new Date().toISOString();
    return this.store.save({
      ...plan,
      status: 'completed',
      mode: 'executing',
      completedAt: now,
      summary: summary || '计划执行完成。',
      steps: plan.steps.map((step) => ({
        ...step,
        status: 'completed',
        completedAt: step.completedAt || now
      }))
    });
  }

  markFailed(plan: AgentPlan, error: string) {
    return this.store.save({
      ...plan,
      status: 'failed',
      summary: error,
      steps: plan.steps.map((step) => (step.status === 'in_progress' ? { ...step, status: 'failed', error } : step))
    });
  }

  getActive(threadId: string) {
    return this.store.getActive(threadId);
  }
}

function inferRiskLevel(prompt: string): PlanRiskLevel {
  if (/删除|重置|reset|push|发布|数据库|清理|destructive|rm\s+-rf/i.test(prompt)) return 'high';
  if (/实现|开发|修改|改一下|重构|写入|新增|接入|落实/i.test(prompt)) return 'medium';
  return 'low';
}

function buildDraftSteps(prompt: string, riskLevel: PlanRiskLevel): AgentPlanStep[] {
  const isCodeChange = /实现|开发|修改|改一下|重构|写入|新增|接入|落实|代码/i.test(prompt);
  const steps: AgentPlanStep[] = [
    {
      id: 'plan-step-inspect',
      title: '只读检查相关文档、类型和 runtime 入口',
      description: '确认任务边界、现有事件流、持久化和审批入口。',
      status: 'pending',
      allowedTools: ['read', 'grep', 'list'],
      riskLevel: 'low'
    },
    {
      id: 'plan-step-design',
      title: '细化最小实现方案并确认风险点',
      description: '把计划约束到最小可交付范围，避免无关重构。',
      status: 'pending',
      allowedTools: ['read'],
      riskLevel: 'low'
    }
  ];

  if (isCodeChange) {
    steps.push(
      {
        id: 'plan-step-implement',
        title: '按计划修改 runtime / shared types / UI 事件消费代码',
        description: '所有改动继续走 OpenAgent runtime 边界，不让 renderer 直接拥有业务状态。',
        status: 'pending',
        allowedTools: ['edit', 'write'],
        requiresApproval: riskLevel !== 'low',
        approvalReason: '该步骤可能修改项目文件。',
        riskLevel
      },
      {
        id: 'plan-step-verify',
        title: '运行类型检查或构建验证改动',
        description: '优先运行 pnpm typecheck，必要时补充 pnpm build。',
        status: 'pending',
        allowedTools: ['shell'],
        riskLevel: 'low'
      }
    );
  } else {
    steps.push({
      id: 'plan-step-answer',
      title: '输出计划结论并等待用户下一步',
      status: 'pending',
      allowedTools: ['message'],
      riskLevel: 'low'
    });
  }

  return steps;
}
