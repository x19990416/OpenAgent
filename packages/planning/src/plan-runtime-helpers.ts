import type { RuntimeMessage } from '@openagent/runtime';
import type { AgentPlan } from './plan-types.js';

export function shouldRetryPlanToolExecution(plan: AgentPlan | null, result: { status: string; assistantMessage?: RuntimeMessage; toolResultCount?: number }) {
  return isMissingRequiredPlanToolExecution(plan, result);
}

function isMissingRequiredPlanToolExecution(plan: AgentPlan | null, result: { status: string; assistantMessage?: RuntimeMessage; toolResultCount?: number }) {
  if (!plan || result.status !== 'completed' || !result.assistantMessage) return false;
  if ((result.toolResultCount ?? 0) > 0) return false;
  return planRequiresToolExecution(plan);
}

function planRequiresToolExecution(plan: AgentPlan) {
  return plan.steps.some((step) => {
    if (step.kind !== 'execute') return false;
    const tools = step.allowedTools ?? [];
    if (step.requiresApproval) return true;
    return tools.some((tool) => isExecutionToolName(tool));
  });
}

function isExecutionToolName(toolName: string) {
  const normalized = toolName.toLowerCase().replace(/[_-]/g, '-');
  return [
    'tool-executor',
    'write-file',
    'file-write',
    'shell-exec',
    'pi-coding-agent',
    'skill-script'
  ].includes(normalized);
}

export function shouldContinueProgressOnlyReply(plan: AgentPlan | null, result: { status: string; assistantMessage?: RuntimeMessage; toolResultCount?: number }) {
  if (result.status !== 'completed' || !result.assistantMessage) return false;
  const content = stripOpenAgentMetadata(result.assistantMessage.content);
  if (!content.trim()) return false;
  if (hasUserBlockerRequest(content)) return false;
  if (hasStrongFinalCompletionSignal(content) && !hasExplicitWaitOrContinueSignal(content)) return false;

  const promisesFutureWork = /(?:我(?:将|会|现在|马上|立即)|接下来(?:我)?(?:将|会)?|下一步(?:我)?(?:将|会)?|继续(?:推进|执行|处理|完成)|开始(?:读取|编写|创建|更新|执行|处理|检查|重构)|正在(?:读取|编写|创建|更新|执行|处理|检查|重构)|I\s+(?:will|am going to)|I'll|Next,\s*I\s+will)/i.test(content);
  if (!promisesFutureWork) return false;

  if (hasExplicitWaitOrContinueSignal(content)) return true;

  return Boolean(plan && planRequiresToolExecution(plan));
}

function stripOpenAgentMetadata(content: string) {
  return content.replace(/<!--\s*openagent:metadata[\s\S]*?-->/g, '').trim();
}

function hasExplicitWaitOrContinueSignal(content: string) {
  return /(?:请稍等|稍等|我将立即|我会继续|将继续|立即开始|马上开始|下一步执行计划|下一步计划|正在进行|正在(?:读取|编写|创建|更新|执行|处理|检查|重构)|继续推进|开始(?:读取|编写|创建|更新|执行|处理|检查|重构))/.test(content);
}

function hasUserBlockerRequest(content: string) {
  return /(?:请问|是否可以|是否确认|请确认|需要您|请提供|等待您|待您|如果您(?:确认|提供|同意)|需要用户|人工确认)/.test(content);
}

function hasStrongFinalCompletionSignal(content: string) {
  return /(?:任务已(?:经)?(?:圆满)?完成|已(?:经)?全部(?:开发)?完成|准备就绪|最终交付清单|如果您(?:还有|有)其他需求|随时告诉我|done\b|completed\b)/i.test(content);
}

export function buildPlanToolExecutionRetryPrompt(originalPrompt: string, previousAssistantContent: string, plan: AgentPlan | null) {
  return [
    'OpenAgent runtime noticed that the active plan still requires actual tool execution, but the previous assistant turn returned only user-facing progress text and no OpenAgent tool result.',
    '',
    'You must continue the same user task now. Do not apologize and do not describe future work. Call the appropriate OpenAgent tool in this turn using the exact registered tool name.',
    'If the active context has a selected skill with declared scripts/resources, use skill_load, skill_resource, or skill_script before any generic coding agent. Only use pi_coding_agent when no selected skill tool fits the step.',
    '',
    'Original user request:',
    originalPrompt,
    '',
    'Active plan:',
    plan ? formatPlanForPrompt(plan) : '(no active plan)',
    '',
    'Previous assistant text that did not execute a tool:',
    previousAssistantContent.slice(0, 2000)
  ].join('\n');
}

export function buildProgressContinuationPrompt(originalPrompt: string, previousAssistantContent: string, plan: AgentPlan | null) {
  return [
    'OpenAgent runtime detected that your previous assistant message was progress-only or future-tense continuation text, not a final deliverable.',
    '',
    'Continue the same user task now.',
    'Do not apologize. Do not say “请稍等”, “我将继续”, “正在处理”, or describe future work as the final answer.',
    'If the next action requires reading, writing, running code, using a skill, or delegating to a child agent, call the appropriate structured OpenAgent tool in this turn.',
    'Only return a final user-facing answer after the promised work has actually completed or a real blocker requires user input.',
    '',
    'Original user request:',
    originalPrompt,
    '',
    'Active plan:',
    plan ? formatPlanForPrompt(plan) : '(no active plan)',
    '',
    'Previous progress-only assistant text:',
    previousAssistantContent.slice(0, 3000)
  ].join('\n');
}

export function formatPlanForPrompt(plan: AgentPlan) {
  return [
    `planId: ${plan.id}`,
    `goal: ${plan.goal}`,
    `status: ${plan.status}`,
    `riskLevel: ${plan.riskLevel}`,
    'steps:',
    ...plan.steps.map((step, index) => {
      const flags = [step.status, step.kind, step.requiresApproval ? 'requiresApproval' : ''].filter(Boolean).join(', ');
      return `${index + 1}. [${flags}] ${step.title}${step.description ? ` - ${step.description}` : ''}`;
    })
  ].join('\n');
}

export function formatPlanApprovalDescription(plan: AgentPlan) {
  const hasWriteOrExecuteStep = plan.steps.some((step) => {
    const tools = step.allowedTools ?? [];
    return step.requiresApproval || step.kind === 'execute' || tools.some((tool) => !['read', 'grep', 'list', 'read-only'].includes(tool));
  });
  const defaultReason = hasWriteOrExecuteStep
    ? '该计划后续可能修改文件、执行工具或影响当前工作区，需要你确认后继续。'
    : '该计划将从只读规划进入执行阶段，需要你确认后继续。';

  return [
    `目标：${plan.goal}`,
    `风险等级：${plan.riskLevel}`,
    `审批原因：${plan.approvalReason || defaultReason}`
  ].join('\n');
}
