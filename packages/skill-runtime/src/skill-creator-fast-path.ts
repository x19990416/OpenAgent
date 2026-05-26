import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolExecutor, type AgentRuntimeRunInput, type RuntimeToolExecutionResult } from '@openagent/runtime';
import type { AgentPlan } from '@openagent/planning';
import type { SkillCatalogItem } from './skill-types.js';
import { getOpenAgentHome } from './openagent-home.js';

interface SkillCreatorScaffoldRequest {
  slug: string;
  displayName: string;
  description: string;
  risk: 'read' | 'write' | 'network' | 'external' | 'destructive';
  tags: string[];
  allowedTools: string[];
  outputDir: string;
}

export async function maybeRunSkillCreatorScaffoldFastPath(input: {
  runInput: AgentRuntimeRunInput;
  selectedSkill?: SkillCatalogItem | null;
  activePlan?: AgentPlan | null;
  prompt: string;
}) {
  const { runInput, selectedSkill, activePlan, prompt } = input;
  if (selectedSkill?.name !== 'skill-creator') return null;
  const scaffold = inferSkillCreatorScaffoldRequest(prompt, runInput.agentId);
  if (!scaffold) return null;
  const skillScriptTool = runInput.tools.find((tool) => tool.name === 'skill_script');
  if (!skillScriptTool) return null;
  const initScript = selectedSkill.scripts.find((script) => script.path === 'scripts/init_skill.mjs');
  if (!initScript) return null;
  if (existsSync(scaffold.outputDir)) {
    runInput.onLog?.({
      scope: 'runtime',
      message: 'skill-creator scaffold fast path skipped because target exists',
      data: {
        runId: runInput.runId,
        threadId: runInput.threadId,
        selectedSkillName: selectedSkill.name,
        scriptPath: initScript.path,
        scaffold
      }
    });
    return [
      'skill-creator scaffold fast path was skipped because the target skill directory already exists.',
      `skillName: ${selectedSkill.name}`,
      `scriptPath: ${initScript.path}`,
      `targetSkillName: ${scaffold.slug}`,
      `targetPath: ${scaffold.outputDir}`,
      'Do not call init_skill.mjs again unless the user asks to overwrite or repair this existing skill.'
    ].join('\n');
  }

  const args = [
    '--name', scaffold.slug,
    '--displayName', scaffold.displayName,
    '--description', scaffold.description,
    '--risk', scaffold.risk,
    '--tags', scaffold.tags.join(','),
    '--allowedTools', scaffold.allowedTools.join(',')
  ];
  if (scaffold.outputDir) args.push('--output', scaffold.outputDir);

  const toolArgs = {
    skillName: selectedSkill.name,
    scriptPath: initScript.path,
    args,
    cwd: '.'
  };
  const toolCallId = `tool-${randomUUID()}`;
  runInput.onLog?.({
    scope: 'runtime',
    message: 'skill-creator scaffold fast path selected',
    data: {
      runId: runInput.runId,
      threadId: runInput.threadId,
      planId: activePlan?.id,
      toolCallId,
      selectedSkillName: selectedSkill.name,
      scriptPath: initScript.path,
      scaffold
    }
  });

  const executor = new ToolExecutor(runInput.tools, {
    runId: runInput.runId,
    threadId: runInput.threadId,
    agentId: runInput.agentId,
    sessionFile: runInput.sessionFile,
    providerId: runInput.providerId,
    model: runInput.model,
    onLog: runInput.onLog,
    emitUiEvent: runInput.emitUiEvent,
    workspaceRoot: runInput.workspaceRoot,
    requestApproval: runInput.requestApproval,
    getPlanContext: runInput.getPlanContext
  });
  const result = await executor.execute({
    toolName: 'skill_script',
    toolCallId,
    args: toolArgs,
    signal: runInput.abortSignal
  });

  return formatFastPathResult({ result, toolCallId, selectedSkill, initScriptPath: initScript.path, scaffold });
}

function formatFastPathResult(input: {
  result: RuntimeToolExecutionResult;
  toolCallId: string;
  selectedSkill: SkillCatalogItem;
  initScriptPath: string;
  scaffold: SkillCreatorScaffoldRequest;
}) {
  const summary = input.result.ok
    ? 'skill-creator scaffold already executed through OpenAgent ToolPolicy. Do not call skill_script for scripts/init_skill.mjs again unless the user asks to overwrite or repair the scaffold.'
    : 'skill-creator scaffold fast path attempted but did not complete. Inspect the result before retrying or modifying files.';
  return [
    summary,
    `toolCallId: ${input.toolCallId}`,
    `skillName: ${input.selectedSkill.name}`,
    `scriptPath: ${input.initScriptPath}`,
    `targetSkillName: ${input.scaffold.slug}`,
    `displayName: ${input.scaffold.displayName}`,
    'If the user requested a complete executable skill, continue now with write_file to add scripts/templates/references and update SKILL.md plus skill.json. The scaffold only creates the minimal package.',
    `ok: ${input.result.ok}`,
    'result:',
    input.result.content.slice(0, 2000)
  ].join('\n');
}

function inferSkillCreatorScaffoldRequest(prompt: string, agentId: string): SkillCreatorScaffoldRequest | null {
  if (!/(skill|技能)/i.test(prompt)) return null;
  if (!/(创建|新建|生成|封装|做一个|加一个|create|scaffold|generate)/i.test(prompt)) return null;

  const explicitSlug = extractExplicitSkillSlug(prompt);
  const displayName = extractSkillDisplayName(prompt) || explicitSlug || 'new-skill';
  const slug = safeSkillSlug(explicitSlug || displayName);
  if (!slug) return null;

  const isPdfMerge = /pdf/i.test(prompt) && /(合并|merge|merg)/i.test(prompt);
  const description = isPdfMerge
    ? '合并目录下的 PDF 文件。'
    : `Provide ${displayName} skill guidance and reusable automation.`;
  const tags = isPdfMerge ? ['pdf', 'merge', 'skill'] : ['skill'];
  const risk: SkillCreatorScaffoldRequest['risk'] = isPdfMerge ? 'write' : 'read';
  return {
    slug,
    displayName,
    description,
    risk,
    tags,
    allowedTools: ['skill_load', 'skill_resource', 'skill_script'],
    outputDir: path.join(getOpenAgentHome(), 'agents', agentId, 'skills', slug)
  };
}

function extractExplicitSkillSlug(prompt: string) {
  const candidates: string[] = prompt.match(/[A-Za-z][A-Za-z0-9._-]*-[A-Za-z0-9._-]*/g) ?? [];
  const filtered = candidates.filter((item) => !['skill-creator', 'skill-installer'].includes(item.toLowerCase()));
  return filtered.at(-1) ?? '';
}

function extractSkillDisplayName(prompt: string) {
  const match = /(?:名字叫做|名叫|叫做|名为|名称(?:是|为)?)([^,，\s]+)/.exec(prompt);
  return match?.[1]?.trim() ?? '';
}

function safeSkillSlug(value: string) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
