import { stat } from 'node:fs/promises';
import type { PlanExecutionContext, RuntimeTool, RuntimeToolPolicyDecision } from '../runtime-types.js';
import type { SkillCatalogItem } from './skill-types.js';
import { appendSkillExecutionAuditLog } from './skill-audit-log.js';
import { summarizeSkillMarkdown } from './skill-parser.js';
import { ensurePipDependencies, runSkillScript } from './skill-script-executor.js';
import { asRecord, normalizePositiveInt, readLimitedFile, resolveSkillChild, resolveWorkspaceCwd, throwIfAborted } from './skill-utils.js';

const DEFAULT_MAX_RESOURCE_BYTES = 120_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
const MAX_SCRIPT_TIMEOUT_MS = 600_000;

export function createSkillTools(input: { listSkills: () => SkillCatalogItem[]; requireSkill: (nameOrId: string) => SkillCatalogItem; workspaceRoot: string }): RuntimeTool[] {
  return [createSkillListTool(input), createSkillLoadTool(input), createSkillResourceTool(input), createSkillScriptTool(input)];
}

function createSkillListTool(input: { listSkills: () => SkillCatalogItem[] }): RuntimeTool {
  return {
    name: 'skill_list',
    label: 'List Skills',
    description: 'List OpenAgent skills available to this agent. Use this when you need to discover task-specific skills before loading them.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search text.' },
        source: { type: 'string', enum: ['system', 'user', 'agent', 'workspace', 'plugin'], description: 'Optional skill source filter.' }
      },
      additionalProperties: false
    },
    execute: async ({ input: toolInput, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(toolInput);
      const query = String(args.query || '').toLowerCase();
      const source = String(args.source || '');
      const skills = input.listSkills().filter((skill) => {
        if (source && skill.source !== source) return false;
        if (!query) return true;
        return [skill.name, skill.displayName, skill.description, skill.tags.join(' ')].join(' ').toLowerCase().includes(query);
      });
      return { ok: true, content: formatSkillList(skills), data: { skills } };
    }
  };
}

function createSkillLoadTool(input: { requireSkill: (nameOrId: string) => SkillCatalogItem }): RuntimeTool {
  return {
    name: 'skill_load',
    label: 'Load Skill',
    description: 'Load a skill SKILL.md file. Use mode=summary first; use mode=full only when the complete instructions are needed.',
    parameters: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Skill name or id.' },
        mode: { type: 'string', enum: ['summary', 'full'], description: 'summary or full. Defaults to summary.' }
      },
      required: ['skillName'],
      additionalProperties: false
    },
    execute: async ({ input: toolInput, signal, context }) => {
      throwIfAborted(signal);
      const args = asRecord(toolInput);
      const skill = input.requireSkill(String(args.skillName || ''));
      const denied = enforceSkillAllowedTool(skill, 'skill_load');
      if (denied) return denied;
      const mode = args.mode === 'full' ? 'full' : 'summary';
      const content = await readLimitedFile(skill.skillFile, mode === 'full' ? DEFAULT_MAX_RESOURCE_BYTES : 24_000, signal);
      context?.emitUiEvent?.('skill.loaded', {
        runId: context.runId,
        threadId: context.threadId,
        skillName: skill.name,
        mode,
        path: skill.skillFile
      });
      return {
        ok: true,
        content: mode === 'full' ? content : summarizeSkillMarkdown(content),
        data: { skillName: skill.name, mode, path: skill.skillFile }
      };
    }
  };
}

function createSkillResourceTool(input: { requireSkill: (nameOrId: string) => SkillCatalogItem }): RuntimeTool {
  return {
    name: 'skill_resource',
    label: 'Read Skill Resource',
    description: 'Read a text resource under a skill templates/, references/, examples/, or assets/ directory. Use this for progressive disclosure instead of injecting all skill files.',
    parameters: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Skill name or id.' },
        path: { type: 'string', description: 'Resource path relative to the skill root.' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read. Defaults to 120000.' }
      },
      required: ['skillName', 'path'],
      additionalProperties: false
    },
    execute: async ({ input: toolInput, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(toolInput);
      const skill = input.requireSkill(String(args.skillName || ''));
      const denied = enforceSkillAllowedTool(skill, 'skill_resource');
      if (denied) return denied;
      const requestedPath = String(args.path || '');
      const target = await resolveSkillChild(skill.rootDir, requestedPath, ['templates', 'references', 'examples', 'assets']);
      const targetStat = await stat(target);
      if (!targetStat.isFile()) return { ok: false, content: `Skill resource is not a file: ${requestedPath}` };
      const maxBytes = normalizePositiveInt(args.maxBytes, DEFAULT_MAX_RESOURCE_BYTES, 500_000);
      const content = await readLimitedFile(target, maxBytes, signal);
      return { ok: true, content, data: { skillName: skill.name, path: requestedPath, resolvedPath: target, bytes: Buffer.byteLength(content, 'utf8') } };
    }
  };
}

function createSkillScriptTool(input: { requireSkill: (nameOrId: string) => SkillCatalogItem; workspaceRoot: string }): RuntimeTool {
  return {
    name: 'skill_script',
    label: 'Run Skill Script',
    description: 'Execute a script under a skill scripts/ directory through OpenAgent policy, approval, timeout, abort handling, logs, and UI events. Never use for scripts outside the selected skill.',
    parameters: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Skill name or id.' },
        scriptPath: { type: 'string', description: 'Script path relative to the skill root, under scripts/.' },
        args: { type: 'array', items: { type: 'string' }, description: 'String arguments passed to the script.' },
        cwd: { type: 'string', description: 'Working directory. Relative paths are resolved from the OpenAgent workspace. Defaults to workspace root.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 120000, max 600000.' }
      },
      required: ['skillName', 'scriptPath'],
      additionalProperties: false
    },
    policy: (toolInput, planContext) => decideSkillScriptPolicy(input, toolInput, planContext),
    execute: async ({ input: toolInput, signal, context }) => {
      throwIfAborted(signal);
      const planContext = context?.getPlanContext?.() ?? null;
      const args = normalizeSelectedSkillScriptArgs(asRecord(toolInput), planContext);
      if (args.__openagentAutoFilledSkillScript) {
        context?.onLog?.({
          scope: 'runtime',
          message: 'skill_script selected-skill arguments auto-filled',
          data: {
            originalArgs: toolInput,
            normalizedArgs: omitAutoFillMarker(args),
            planContext
          }
        });
      }
      const skill = input.requireSkill(String(args.skillName || ''));
      if (!skill.enabled) return { ok: false, content: `Skill is disabled: ${skill.name}` };
      const denied = enforceSkillAllowedTool(skill, 'skill_script');
      if (denied) return denied;
      const scriptPath = String(args.scriptPath || '');
      const scriptDescriptor = findDeclaredScript(skill, scriptPath);
      if (skill.scripts.length > 0 && !scriptDescriptor) {
        return {
          ok: false,
          content: `Skill ${skill.name} does not declare script ${scriptPath}. Declared scripts: ${skill.scripts.map((script) => script.path).join(', ')}`,
          data: {
            skillName: skill.name,
            scriptPath,
            declaredScripts: skill.scripts.map((script) => script.path),
            deniedBy: 'skill.json.scripts'
          }
        };
      }
      const script = await resolveSkillChild(skill.rootDir, scriptPath, ['scripts']);
      const scriptStat = await stat(script);
      if (!scriptStat.isFile()) return { ok: false, content: `Skill script is not a file: ${scriptPath}` };
      const cwd = resolveWorkspaceCwd(input.workspaceRoot, String(args.cwd || '.'));
      const cwdStat = await stat(cwd).catch(() => null);
      if (!cwdStat?.isDirectory()) return { ok: false, content: `cwd is not a directory: ${cwd}` };
      const scriptArgs = Array.isArray(args.args) ? args.args.map((item) => normalizeSkillScriptArg(String(item))) : [];
      const timeoutMs = normalizePositiveInt(args.timeoutMs ?? scriptDescriptor?.timeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS, MAX_SCRIPT_TIMEOUT_MS);
      const pipDependencies = scriptDescriptor?.dependencies?.pip ?? [];
      const effectiveNetwork = Boolean(scriptDescriptor?.network || pipDependencies.length > 0);
      const startedAuditLogPath = appendSkillExecutionAuditLog({
        runId: context?.runId,
        threadId: context?.threadId,
        event: 'skill.script.started',
        skillName: skill.name,
        skillSource: skill.source,
        scriptPath,
        resolvedScriptPath: script,
        cwd,
        args: scriptArgs,
        scriptRuntime: scriptDescriptor?.runtime,
        scriptRisk: scriptDescriptor?.risk,
        network: effectiveNetwork,
        writes: scriptDescriptor?.writes,
        pipDependencies
      });
      context?.emitUiEvent?.('skill.script.started', {
        runId: context.runId,
        threadId: context.threadId,
        skillName: skill.name,
        skillSource: skill.source,
        scriptPath,
        cwd,
        auditLogPath: startedAuditLogPath,
        scriptRuntime: scriptDescriptor?.runtime,
        scriptRisk: scriptDescriptor?.risk,
        network: effectiveNetwork,
        writes: scriptDescriptor?.writes,
        pipDependencies,
        createdAt: new Date().toISOString()
      });
      context?.onLog?.({
        scope: 'runtime',
        message: 'skill script started',
        data: {
          skillName: skill.name,
          skillSource: skill.source,
          scriptPath,
          cwd,
          args: scriptArgs,
          auditLogPath: startedAuditLogPath,
          scriptRuntime: scriptDescriptor?.runtime,
          scriptRisk: scriptDescriptor?.risk,
          network: effectiveNetwork,
          writes: scriptDescriptor?.writes,
          pipDependencies
        }
      });
      let dependencySummary: Awaited<ReturnType<typeof ensurePipDependencies>> | null = null;
      if (pipDependencies.length > 0 && isPythonScriptRuntime(scriptDescriptor?.runtime, scriptPath)) {
        context?.onLog?.({ scope: 'runtime', message: 'skill script dependency preflight', data: { skillName: skill.name, scriptPath, pipDependencies } });
        dependencySummary = await ensurePipDependencies({ packages: pipDependencies, cwd, signal });
        context?.onLog?.({
          scope: 'runtime',
          message: 'skill script dependency preflight completed',
          data: {
            skillName: skill.name,
            scriptPath,
            pipDependencies,
            installed: dependencySummary.installed,
            alreadyAvailable: dependencySummary.alreadyAvailable
          }
        });
      }
      const result = await runSkillScript(script, scriptArgs, cwd, timeoutMs, signal);
      const completedEvent = result.exitCode === 0 ? 'skill.script.completed' : 'skill.script.failed';
      const auditLogPath = appendSkillExecutionAuditLog({
        runId: context?.runId,
        threadId: context?.threadId,
        event: completedEvent,
        skillName: skill.name,
        skillSource: skill.source,
        scriptPath,
        resolvedScriptPath: script,
        cwd,
        args: scriptArgs,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        scriptRuntime: scriptDescriptor?.runtime,
        scriptRisk: scriptDescriptor?.risk,
        network: effectiveNetwork,
        writes: scriptDescriptor?.writes,
        stdoutPreview: result.stdout.slice(0, 2000),
        stderrPreview: result.stderr.slice(0, 2000),
        pipDependencies,
        installedDependencies: dependencySummary?.installed ?? [],
        availableDependencies: dependencySummary?.alreadyAvailable ?? []
      });
      const eventPayload = {
        runId: context?.runId,
        threadId: context?.threadId,
        skillName: skill.name,
        skillSource: skill.source,
        scriptPath,
        cwd,
        auditLogPath,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        scriptRuntime: scriptDescriptor?.runtime,
        scriptRisk: scriptDescriptor?.risk,
        network: effectiveNetwork,
        writes: scriptDescriptor?.writes,
        stdoutPreview: result.stdout.slice(0, 2000),
        stderrPreview: result.stderr.slice(0, 2000),
        pipDependencies,
        installedDependencies: dependencySummary?.installed ?? [],
        availableDependencies: dependencySummary?.alreadyAvailable ?? [],
        completedAt: new Date().toISOString()
      };
      context?.onLog?.({ scope: 'runtime', message: 'skill script completed', data: eventPayload });
      context?.emitUiEvent?.(completedEvent, eventPayload);
      const content = [
        `exitCode: ${result.exitCode}`,
        `durationMs: ${result.durationMs}`,
        scriptDescriptor?.runtime ? `runtime: ${scriptDescriptor.runtime}` : '',
        scriptDescriptor?.risk ? `risk: ${scriptDescriptor.risk}` : '',
        result.stdout ? `stdout:\n${result.stdout}` : '',
        dependencySummary ? `dependencies: pip installed=[${dependencySummary.installed.join(', ')}] available=[${dependencySummary.alreadyAvailable.join(', ')}]` : '',
        result.stderr ? `stderr:\n${result.stderr}` : ''
      ].filter(Boolean).join('\n\n');
      return { ok: result.exitCode === 0, content, data: { ...eventPayload, stdout: result.stdout, stderr: result.stderr } };
    }
  };
}


function decideSkillScriptPolicy(
  input: { requireSkill: (nameOrId: string) => SkillCatalogItem; workspaceRoot: string },
  toolInput: unknown,
  planContext?: PlanExecutionContext | null
): RuntimeToolPolicyDecision {
  const args = normalizeSelectedSkillScriptArgs(asRecord(toolInput), planContext ?? null);
  const skillName = String(args.skillName || '').trim();
  const scriptPath = String(args.scriptPath || '').trim();
  if (!skillName || !scriptPath) {
    return { kind: 'deny', reason: 'skill_script requires skillName and scriptPath' };
  }
  if (isUnsafeSkillScriptPath(scriptPath)) {
    return { kind: 'deny', reason: `Refusing unsafe skill script path: ${scriptPath}` };
  }

  let skill: SkillCatalogItem;
  try {
    skill = input.requireSkill(skillName);
  } catch (error) {
    return { kind: 'deny', reason: error instanceof Error ? error.message : `Skill not found: ${skillName}` };
  }

  if (!skill.enabled) return { kind: 'deny', reason: `Skill is disabled: ${skill.name}` };
  const denied = enforceSkillAllowedTool(skill, 'skill_script');
  if (denied) return { kind: 'deny', reason: denied.content };

  const scriptDescriptor = findDeclaredScript(skill, scriptPath);
  if (skill.scripts.length > 0 && !scriptDescriptor) {
    return {
      kind: 'deny',
      reason: `Skill ${skill.name} does not declare script ${scriptPath}. Declared scripts: ${skill.scripts.map((script) => script.path).join(', ')}`
    };
  }

  const descriptorRisk = scriptDescriptor?.risk ?? skill.risk;
  const hasDependencies = hasScriptDependencies(scriptDescriptor);
  const network = Boolean(scriptDescriptor?.network || hasDependencies || descriptorRisk === 'network' || descriptorRisk === 'external');
  const writes = Boolean(scriptDescriptor?.writes || descriptorRisk === 'write' || descriptorRisk === 'destructive');
  const destructive = descriptorRisk === 'destructive';
  const approvalRisk: 'low' | 'medium' | 'high' = destructive ? 'high' : network || writes || descriptorRisk === 'external' ? 'medium' : 'low';
  const actionType = destructive ? 'skill.script.destructive' : network ? 'skill.script.network' : writes ? 'skill.script.write' : 'skill.script';
  const cwdInput = String(args.cwd || '.');
  const cwd = safeResolveWorkspaceCwd(input.workspaceRoot, cwdInput);
  const timeoutMs = normalizePositiveInt(args.timeoutMs ?? scriptDescriptor?.timeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS, MAX_SCRIPT_TIMEOUT_MS);
  const description = [
    `OpenAgent 需要执行 Skill 脚本：${skill.name}/${scriptPath}`,
    `Skill 来源：${skill.source}`,
    scriptDescriptor?.description ? `脚本说明：${scriptDescriptor.description}` : '',
    scriptDescriptor?.runtime ? `runtime：${scriptDescriptor.runtime}` : '',
    formatScriptDependencyLine(scriptDescriptor),
    `声明风险：${descriptorRisk}`,
    `network：${network ? 'yes' : 'no'}`,
    `writes：${writes ? 'yes' : 'no'}`,
    `timeoutMs：${timeoutMs}`,
    `cwd：${cwd}`,
    'Skill 脚本由 OpenAgent 通过受控 tool 执行，会记录审计日志并受 timeout/abort 控制。',
    '批准后仅用于本次 tool 调用。'
  ].filter(Boolean).join('\n');

  return {
    kind: 'requires_approval',
    approval: {
      title: destructive ? '请求执行高风险 Skill 脚本' : network ? '请求执行联网 Skill 脚本' : writes ? '请求执行写入型 Skill 脚本' : '请求执行 Skill 脚本',
      risk: approvalRisk,
      description,
      actionType,
      targetPath: cwd,
      access: writes || destructive ? 'write' : 'execute',
      recursive: false,
      scope: 'once'
    }
  };
}





function hasScriptDependencies(script: SkillCatalogItem['scripts'][number] | null | undefined) {
  return Boolean(script?.dependencies?.pip?.length || script?.dependencies?.npm?.length || script?.dependencies?.system?.length);
}

function normalizeSelectedSkillScriptArgs(args: Record<string, unknown>, planContext?: PlanExecutionContext | null) {
  const selectedSkillName = String(planContext?.selectedSkillName || '').trim();
  const singleScriptPath = String(planContext?.selectedSkillSingleScriptPath || '').trim();
  if (!selectedSkillName || !singleScriptPath) return args;

  const next: Record<string, unknown> = { ...args };
  let autoFilled = false;

  if (isMissingSkillScriptValue(next.skillName)) {
    next.skillName = selectedSkillName;
    autoFilled = true;
  }
  if (isMissingSkillScriptValue(next.scriptPath)) {
    next.scriptPath = singleScriptPath;
    autoFilled = true;
  }

  return autoFilled ? { ...next, __openagentAutoFilledSkillScript: true } : next;
}

function isMissingSkillScriptValue(value: unknown) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function omitAutoFillMarker(args: Record<string, unknown>) {
  const { __openagentAutoFilledSkillScript: _marker, ...rest } = args;
  return rest;
}

function formatScriptDependencyLine(script: SkillCatalogItem['scripts'][number] | null | undefined) {
  const parts = [
    script?.dependencies?.pip?.length ? `pip=[${script.dependencies.pip.join(',')}]` : '',
    script?.dependencies?.npm?.length ? `npm=[${script.dependencies.npm.join(',')}]` : '',
    script?.dependencies?.system?.length ? `system=[${script.dependencies.system.join(',')}]` : ''
  ].filter(Boolean);
  return parts.length > 0 ? `依赖：${parts.join(' ')}` : '';
}

function isPythonScriptRuntime(runtime: string | undefined, scriptPath: string) {
  const value = (runtime || '').toLowerCase();
  return scriptPath.endsWith('.py') || value === 'python' || value === 'python3' || value.startsWith('python');
}

function findDeclaredScript(skill: SkillCatalogItem, scriptPath: string) {
  const normalized = scriptPath.replace(/^\/+/, '').split('\\').join('/');
  return skill.scripts.find((script) => script.path.replace(/^\/+/, '').split('\\').join('/') === normalized) ?? null;
}

function isUnsafeSkillScriptPath(scriptPath: string) {
  return scriptPath.includes('..') || scriptPath.startsWith('/') || scriptPath.includes('\\');
}

function safeResolveWorkspaceCwd(workspaceRoot: string, cwdInput: string) {
  try {
    return resolveWorkspaceCwd(workspaceRoot, cwdInput);
  } catch {
    return cwdInput || workspaceRoot;
  }
}

function normalizeSkillScriptArg(value: string) {
  let normalized = value.trim();
  const quoteMarkers = ['<|"|', "<|'|"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of quoteMarkers) {
      if (normalized.startsWith(marker)) {
        normalized = normalized.slice(marker.length);
        changed = true;
      }
      if (normalized.endsWith(marker)) {
        normalized = normalized.slice(0, -marker.length);
        changed = true;
      }
    }
  }
  return normalized;
}

function enforceSkillAllowedTool(skill: SkillCatalogItem, toolName: string) {
  if (skill.allowedTools.length === 0) return null;
  if (skill.allowedTools.includes(toolName)) return null;
  if (toolName === 'skill_script' && skill.scripts.length > 0) return null;
  return {
    ok: false,
    content: `Skill ${skill.name} does not allow tool ${toolName}. allowedTools=${skill.allowedTools.join(', ')}`,
    data: {
      skillName: skill.name,
      toolName,
      allowedTools: skill.allowedTools,
      deniedBy: 'skill.allowedTools'
    }
  };
}

function formatSkillList(skills: SkillCatalogItem[]) {
  if (skills.length === 0) return 'No skills found';
  return skills.map((skill) => {
    const version = skill.version ? `, v${skill.version}` : '';
    return `- ${skill.name} [${skill.source}, ${skill.risk}${version}, ${skill.enabled ? 'enabled' : 'disabled'}]: ${skill.description}`;
  }).join('\n');
}
