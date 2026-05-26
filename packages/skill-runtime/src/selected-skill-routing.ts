import type { PlanExecutionContext, RuntimeTool } from '@openagent/runtime';
import type { AgentPlan } from '@openagent/planning';
import type { SkillCatalogItem } from './skill-types.js';

export function toPlanExecutionContext(plan: AgentPlan | null, selectedSkill?: SkillCatalogItem | null): PlanExecutionContext | null {
  if (!plan) return null;
  const currentStep = plan.steps.find((step) => step.status === 'in_progress') ?? plan.steps.find((step) => step.status === 'pending');
  if (!currentStep) return null;
  return {
    planId: plan.id,
    stepId: currentStep.id,
    mode: plan.mode,
    allowedTools: currentStep.allowedTools,
    riskLevel: currentStep.riskLevel,
    selectedSkillName: selectedSkill?.name,
    selectedSkillHasScripts: Boolean(selectedSkill?.scripts.length),
    selectedSkillSingleScriptPath: selectedSkill?.scripts.length === 1 ? selectedSkill.scripts[0].path : undefined
  };
}

export function toSelectedSkillExecutionContext(selectedSkill?: SkillCatalogItem | null): PlanExecutionContext | null {
  if (!selectedSkill) return null;
  return {
    planId: `selected-skill:${selectedSkill.name}`,
    stepId: 'selected-skill-routing',
    mode: 'executing',
    riskLevel: selectedSkill.risk === 'destructive' ? 'high' : selectedSkill.risk === 'read' ? 'low' : 'medium',
    selectedSkillName: selectedSkill.name,
    selectedSkillHasScripts: selectedSkill.scripts.length > 0,
    selectedSkillSingleScriptPath: selectedSkill.scripts.length === 1 ? selectedSkill.scripts[0].path : undefined
  };
}

export function filterToolsForSelectedSkill(tools: RuntimeTool[], selectedSkill?: SkillCatalogItem | null) {
  if (!selectedSkill || selectedSkill.allowedTools.length === 0) return tools;
  const allowed = new Set(selectedSkill.allowedTools);
  if (selectedSkill.scripts.length > 0) {
    allowed.add('skill_script');
  }
  if (selectedSkill.name !== 'skill-creator') {
    allowed.add('pi_coding_agent');
    allowed.add('write_file');
    allowed.add('shell_exec');
  }
  const alwaysAllowedReadOnlyTools = new Set([
    'ls',
    'list_directory',
    'read',
    'read_file',
    'find',
    'grep',
    'count_files',
    'current_time'
  ]);
  return tools.filter((tool) => allowed.has(tool.name) || alwaysAllowedReadOnlyTools.has(tool.name));
}

export function formatSelectedSkillPlanRule(skill: SkillCatalogItem) {
  const allowedSkillTools = getAllowedSelectedSkillTools(skill);
  if (allowedSkillTools.length > 0) {
    return `- Selected skill ${skill.name} is the primary execution path for this run. Start with these available structured skill tools: ${allowedSkillTools.join(', ')}.`;
  }
  return `- Selected skill ${skill.name} is the primary execution path for this run. Start with available structured skill tools before considering other execution tools.`;
}

export function formatSelectedSkillRoutingRule(skill: SkillCatalogItem) {
  const scripts = skill.scripts.length > 0
    ? skill.scripts.map((script) => `- ${script.path} runtime=${script.runtime || 'unknown'} risk=${script.risk || 'read'} network=${script.network === true} writes=${script.writes === true}${formatScriptDependencies(script)}${script.description ? ` :: ${script.description}` : ''}`).join('\n')
    : '- (no declared scripts)';
  const resources = skill.resources.filter((resource) => resource.kind !== 'script').slice(0, 12).map((resource) => `- ${resource.kind}: ${resource.path}${resource.description ? ` :: ${resource.description}` : ''}`).join('\n') || '- (no declared resources)';
  const allowedSkillTools = getAllowedSelectedSkillTools(skill);
  const shouldMentionLoad = isSelectedSkillToolAllowed(skill, 'skill_load');
  const shouldMentionResource = isSelectedSkillToolAllowed(skill, 'skill_resource');
  const shouldMentionScript = isSelectedSkillToolAllowed(skill, 'skill_script');
  const creatorRules = skill.name === 'skill-creator'
    ? [
        'Skill creation destination rules:',
        '- Create new skills only under ~/.openagent/agents/<agentId>/skills/<skill-name>/ by default.',
        '- Never create a skill package under the workspace root, such as <workspace>/<skill-name>/ or <workspace>/skills/<skill-name>.',
        '- If writing files directly, all write_file paths must stay inside the current agent skill root.'
      ]
    : [];
  return [
    `The user explicitly selected skill ${skill.name} (${skill.id}). Treat this as the primary execution path for this run.`,
    skill.name === 'skill-creator'
      ? 'Use the selected skill-creator tools directly. Do not delegate to pi_coding_agent to create, inspect, scaffold, run, or bypass skill-creator; skill authoring must stay on the governed skill-creator path.'
      : 'Use the selected skill tools directly first. Do not delegate to pi_coding_agent merely to reimplement or bypass a declared skill script/resource that can satisfy the task; pi_coding_agent is allowed for real blockers such as dependency/runtime diagnosis, script failures, or requested skill/package fixes.',
    allowedSkillTools.length > 0
      ? `For this selected-skill run, the only exposed structured skill tool(s) are: ${allowedSkillTools.join(', ')}. Do not call or mention unavailable skill tools.`
      : 'Use only structured tool calls that are actually exposed in this run. Do not call or mention unavailable skill tools.',
    shouldMentionLoad
      ? 'If detailed instructions are needed, call skill_load with this exact skillName first.'
      : 'Do not call skill_load for this selected skill; it is not available in this run.',
    shouldMentionResource
      ? 'If a template/reference/example is needed, call skill_resource with this exact skillName and resource path.'
      : 'Do not call skill_resource for this selected skill; it is not available in this run.',
    shouldMentionScript
      ? 'If deterministic computation or scaffolding is needed and a declared script fits, call skill_script with this exact skillName and declared scriptPath. Required arguments are skillName and scriptPath; optional arguments are args, cwd, and timeoutMs. Do not invent additional argument keys. Do not run the skill script indirectly through pi_coding_agent or shell_exec.'
      : 'Do not call skill_script unless it is exposed as an available structured tool in this run.',
    'Never include pseudo tool-call syntax or provider protocol markers in normal text; use a real structured tool call with the exact exposed tool name.',
    skill.name === 'skill-creator'
      ? 'Only avoid skill_script when no declared skill-creator script is relevant; explain why and use governed skill tools/write_file rather than pi_coding_agent.'
      : 'Only avoid skill_script when no declared script is relevant, the script hits a real dependency/runtime blocker, the script fails and needs diagnosis/fix, or the user explicitly asks for code changes outside the selected skill; explain why before choosing another tool.',
    'Declared scripts:',
    scripts,
    'Declared resources:',
    resources,
    ...creatorRules
  ].join('\n');
}

function formatScriptDependencies(script: SkillCatalogItem['scripts'][number]) {
  const parts = [
    script.dependencies?.pip?.length ? `pip=[${script.dependencies.pip.join(',')}]` : '',
    script.dependencies?.npm?.length ? `npm=[${script.dependencies.npm.join(',')}]` : '',
    script.dependencies?.system?.length ? `system=[${script.dependencies.system.join(',')}]` : ''
  ].filter(Boolean);
  return parts.length > 0 ? ` deps=${parts.join(' ')}` : '';
}

function getAllowedSelectedSkillTools(skill: SkillCatalogItem) {
  const skillTools = ['skill_list', 'skill_load', 'skill_resource', 'skill_script'];
  if (skill.allowedTools.length === 0) return skillTools;
  return skillTools.filter((tool) => skill.allowedTools.includes(tool) || isImplicitSelectedSkillToolAllowed(skill, tool));
}

function isSelectedSkillToolAllowed(skill: SkillCatalogItem, toolName: string) {
  return skill.allowedTools.length === 0 || skill.allowedTools.includes(toolName) || isImplicitSelectedSkillToolAllowed(skill, toolName);
}

function isImplicitSelectedSkillToolAllowed(skill: SkillCatalogItem, toolName: string) {
  return toolName === 'skill_script' && skill.scripts.length > 0;
}
