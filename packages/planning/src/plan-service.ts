import { randomUUID } from 'node:crypto';
import type { AgentPlan, AgentPlanStep, PlanRiskLevel } from './plan-types.js';
import { PlanStore } from './plan-store.js';



export interface LlmPlanStepDraft {
  title: string;
  description?: string;
  allowedTools?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  requiresApproval?: boolean;
}

export interface LlmPlanDraft {
  steps: LlmPlanStepDraft[];
  summary?: string;
  approvalReason?: string;
}

export interface LlmPlanningIntentDecision {
  shouldPlan: boolean;
  approvalRequired?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  reason?: string;
}

export interface PlanLlmProvider {
  classifyIntent(input: { prompt: string; fallbackRiskLevel: 'low' | 'medium' | 'high' }): Promise<LlmPlanningIntentDecision | null>;
  generate(input: { prompt: string; riskLevel: 'low' | 'medium' | 'high' }): Promise<LlmPlanDraft | null>;
}

export interface CreateDraftPlanInput {
  runId: string;
  threadId: string;
  agentId: string;
  prompt: string;
  intent: PlanningIntentDecision;
  now?: string;
}

export interface PlanningIntentDecision {
  shouldPlan: boolean;
  approvalRequired: boolean;
  riskLevel: PlanRiskLevel;
  reason?: string;
  source: 'llm' | 'fallback';
}

export class PlanService {
  private readonly store: PlanStore;

  constructor(private readonly agentId: string, private readonly llm?: PlanLlmProvider) {
    this.store = new PlanStore(agentId);
  }

  async classifyPlanningIntent(prompt: string): Promise<PlanningIntentDecision> {
    const llmDecision = await this.llm?.classifyIntent({ prompt, fallbackRiskLevel: 'medium' }).catch(() => null);
    if (llmDecision) {
      return normalizeIntentDecision(llmDecision);
    }

    return {
      shouldPlan: false,
      approvalRequired: false,
      riskLevel: 'medium',
      reason: 'LLM planning classifier unavailable; skip Agent Plan Mode and continue with normal runtime execution.',
      source: 'fallback'
    };
  }

  async createDraftPlan(input: CreateDraftPlanInput) {
    const now = input.now || new Date().toISOString();
    const riskLevel = input.intent.riskLevel;
    const llmDraft = await this.llm?.generate({ prompt: input.prompt, riskLevel }).catch(() => null);
    const plan: AgentPlan = {
      id: `plan-${randomUUID()}`,
      runId: input.runId,
      threadId: input.threadId,
      agentId: input.agentId,
      goal: input.prompt,
      mode: 'planning',
      status: input.intent.approvalRequired ? 'awaiting_approval' : 'draft',
      createdAt: now,
      updatedAt: now,
      approvalRequired: input.intent.approvalRequired,
      approvalReason: input.intent.approvalRequired
        ? (llmDraft?.approvalReason || input.intent.reason || 'Plan Mode 已为该任务生成执行计划；需要用户确认后再进入执行阶段。')
        : (input.intent.reason || llmDraft?.approvalReason),
      steps: buildDraftSteps(riskLevel, llmDraft),
      revision: 0,
      source: llmDraft ? 'llm' : 'runtime',
      riskLevel,
      summary: llmDraft?.summary || (input.intent.approvalRequired ? '等待用户确认执行计划。' : '已生成执行计划，将自动进入执行。')
    };
    return this.store.save(plan);
  }

  approve(plan: AgentPlan) {
    return this.store.save({
      ...plan,
      mode: 'executing',
      status: 'executing',
      approvedAt: new Date().toISOString(),
      summary: plan.approvalRequired ? '用户已确认计划，开始执行。' : '计划已自动进入执行。',
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

function buildDraftSteps(riskLevel: PlanRiskLevel, llmDraft?: LlmPlanDraft | null): AgentPlanStep[] {
  const steps: AgentPlanStep[] = [
    {
      id: 'plan-step-inspect',
      title: '只读检查相关上下文和任务边界',
      description: '确认输入、目标、输出位置、已有文件和需要遵守的运行约束。',
      status: 'pending',
      allowedTools: ['read', 'grep', 'list'],
      riskLevel: 'low',
      kind: 'inspect'
    },
    {
      id: 'plan-step-design',
      title: '细化最小执行路径并确认风险点',
      description: '把计划约束到最小可交付范围，避免无关操作。',
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
        allowedTools: normalizeExecuteAllowedTools(step.allowedTools),
        requiresApproval: Boolean(step.requiresApproval),
        approvalReason: step.requiresApproval ? 'LLM 计划标记该步骤需要审批。' : undefined,
        riskLevel: step.riskLevel || riskLevel,
        kind: 'execute'
      }))
    : [{
        id: 'plan-step-execute-1',
        title: '按计划进入 agent loop，并通过 OpenAgent tools 执行任务',
        description: 'AgentSession 负责推理循环；工具调用仍由 OpenAgent ToolExecutor、审批、日志和 UI 事件统一管理。',
        status: 'pending',
        allowedTools: ['tool-executor'],
        requiresApproval: riskLevel !== 'low',
        approvalReason: riskLevel !== 'low' ? '该步骤可能调用工具或影响当前工作区。' : undefined,
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

function normalizeExecuteAllowedTools(allowedTools?: string[]) {
  const tools = allowedTools?.length ? Array.from(new Set(allowedTools)) : ['tool-executor'];
  const canExecuteOrWrite = tools.some((tool) => ['tool-executor', 'write_file', 'file-write', 'shell_exec', 'shell-exec', 'pi_coding_agent'].includes(tool));
  if (canExecuteOrWrite) return tools;

  return [...tools, 'tool-executor'];
}

function normalizeIntentDecision(decision: LlmPlanningIntentDecision): PlanningIntentDecision {
  const riskLevel = decision.riskLevel || 'medium';
  return {
    shouldPlan: decision.shouldPlan,
    approvalRequired: riskLevel === 'high' || Boolean(decision.approvalRequired),
    riskLevel,
    reason: decision.reason,
    source: 'llm'
  };
}
