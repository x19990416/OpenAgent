import { randomUUID } from 'node:crypto';
import type { AgentPlan, AgentPlanStep, PlanRiskLevel } from './plan-types.js';
import { PlanStore } from './plan-store.js';
import { PlanLlmGenerator, type LlmPlanDraft } from './plan-llm.js';

export interface CreateDraftPlanInput {
  runId: string;
  threadId: string;
  agentId: string;
  prompt: string;
  now?: string;
}

export class PlanService {
  private readonly store: PlanStore;
  private readonly llm = new PlanLlmGenerator();

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

  async createDraftPlan(input: CreateDraftPlanInput) {
    const now = input.now || new Date().toISOString();
    const riskLevel = inferRiskLevel(input.prompt);
    const llmDraft = await this.llm.generate({ prompt: input.prompt, riskLevel }).catch(() => null);
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
      approvalReason: llmDraft?.approvalReason || 'Plan Mode 已为该任务生成执行计划；需要用户确认后再进入执行阶段。',
      steps: buildDraftSteps(input.prompt, riskLevel, llmDraft),
      revision: 0,
      source: llmDraft ? 'llm' : 'runtime',
      riskLevel,
      summary: llmDraft?.summary || '等待用户确认执行计划。'
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

  startStep(plan: AgentPlan, stepId: string) {
    const now = new Date().toISOString();
    return this.store.save({
      ...plan,
      mode: 'executing',
      status: 'executing',
      steps: plan.steps.map((step) => {
        if (step.id === stepId) {
          return { ...step, status: 'in_progress', startedAt: step.startedAt || now };
        }
        if (step.status === 'in_progress') {
          return { ...step, status: 'completed', completedAt: step.completedAt || now };
        }
        return step;
      })
    });
  }

  completeStep(plan: AgentPlan, stepId: string, summary: string) {
    const now = new Date().toISOString();
    return this.store.save({
      ...plan,
      steps: plan.steps.map((step) =>
        step.id === stepId
          ? { ...step, status: 'completed', completedAt: step.completedAt || now, resultSummary: summary }
          : step
      )
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

function buildDraftSteps(prompt: string, riskLevel: PlanRiskLevel, llmDraft?: LlmPlanDraft | null): AgentPlanStep[] {
  const isCodeChange = /实现|开发|修改|改一下|重构|写入|新增|接入|落实|代码/i.test(prompt);
  const steps: AgentPlanStep[] = [
    {
      id: 'plan-step-inspect',
      title: '只读检查相关文档、类型和 runtime 入口',
      description: '确认任务边界、现有事件流、持久化和审批入口。',
      status: 'pending',
      allowedTools: ['read', 'grep', 'list'],
      riskLevel: 'low',
      kind: 'inspect'
    },
    {
      id: 'plan-step-design',
      title: '细化最小实现方案并确认风险点',
      description: '把计划约束到最小可交付范围，避免无关重构。',
      status: 'pending',
      allowedTools: ['read'],
      riskLevel: 'low',
      kind: 'design'
    }
  ];

  const executeSteps = llmDraft?.steps?.length
    ? llmDraft.steps.map((step, index): AgentPlanStep => ({
        id: `plan-step-execute-${index + 1}`,
        title: step.title,
        description: step.description,
        status: 'pending',
        allowedTools: step.allowedTools?.length ? step.allowedTools : isCodeChange ? ['tool-executor'] : ['message'],
        requiresApproval: Boolean(step.requiresApproval),
        approvalReason: step.requiresApproval ? 'LLM 计划标记该步骤需要审批。' : undefined,
        riskLevel: step.riskLevel || riskLevel,
        kind: 'execute'
      }))
    : [{
        id: 'plan-step-execute-1',
        title: isCodeChange ? '按计划进入 agent loop，并通过 OpenAgent tools 执行任务' : '按计划进入 agent loop，生成最终回复',
        description: isCodeChange
          ? 'Pi 负责推理循环；工具调用仍由 OpenAgent ToolExecutor、审批、日志和 UI 事件统一管理。'
          : 'Pi 负责推理循环；OpenAgent runtime 持续跟踪 plan 状态。',
        status: 'pending',
        allowedTools: isCodeChange ? ['tool-executor'] : ['message'],
        requiresApproval: isCodeChange && riskLevel !== 'low',
        approvalReason: isCodeChange ? '该步骤可能修改项目文件或调用工具。' : undefined,
        riskLevel,
        kind: 'execute'
      } satisfies AgentPlanStep];

  steps.push(
    ...executeSteps,
    {
      id: 'plan-step-verify',
      title: '汇总执行结果、保存 transcript，并标记计划完成',
      description: '把模型输出、工具日志和最终状态写回会话与 plan store。',
      status: 'pending',
      allowedTools: ['runtime'],
      riskLevel: 'low',
      kind: 'finalize'
    }
  );

  return steps;
}
