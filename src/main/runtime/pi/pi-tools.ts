import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { RuntimeLogEntry, RuntimeTool } from '../runtime-types.js';
import { ToolExecutor } from '../tool-executor.js';
import { normalizePiToolParametersWithReport } from './pi-tool-schema.js';

export function toPiToolDefinitionsPlaceholder(tools: RuntimeTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

export function toPiToolDefinitions(tools: RuntimeTool[], executor: ToolExecutor, options: { onLog?: (entry: RuntimeLogEntry) => void } = {}): ToolDefinition<any, unknown>[] {
  const markerRepairIssued = new Set<string>();
  return tools.map((tool) => {
    const schema = normalizePiToolParametersWithReport(tool.parameters);
    if (schema.changed) {
      options.onLog?.({
        scope: 'runtime',
        message: 'tool schema normalized for AgentSession',
        data: { toolName: tool.name, beforeLength: schema.beforeLength, afterLength: schema.afterLength }
      });
    }
    return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    promptSnippet: tool.description,
    parameters: schema.parameters as any,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (partialResult: { content: Array<{ type: 'text'; text: string }>; details: unknown }) => void) {
      const jsonRetry = buildStructuredToolJsonRetry(tool.name, schema.parameters, params, {
        allowMarkerRepair: !markerRepairIssued.has(tool.name)
      });
      if (jsonRetry) {
        if (jsonRetry.details.recoveryKind === 'structured_tool_arguments_repair_prompt') {
          markerRepairIssued.add(tool.name);
        }
        options.onLog?.({
          scope: 'runtime',
          message: 'structured tool call arguments need JSON retry',
          data: { toolName: tool.name, toolCallId, ...jsonRetry.details }
        });
        const retryResult = {
          content: [{ type: 'text' as const, text: jsonRetry.content }],
          details: jsonRetry.details
        };
        onUpdate?.(retryResult);
        return retryResult;
      }
      const result = await executor.execute({
        toolName: tool.name,
        toolCallId,
        args: params,
        signal: signal ?? new AbortController().signal
      });
      const toolResult = {
        content: [{ type: 'text' as const, text: result.content }],
        details: result.data
      };
      onUpdate?.(toolResult);
      return toolResult;
    }
  };
  });
}

function buildStructuredToolJsonRetry(toolName: string, parameters: unknown, params: unknown, options: { allowMarkerRepair?: boolean } = {}) {
  const required = extractRequiredFields(parameters);
  if (required.length === 0) return null;
  const hasTemplateMarkers = containsToolTemplateMarkers(params);

  const received = isPlainRecord(params) ? params : null;
  const missing = received
    ? required.filter((field) => isMissingRequiredValue(received[field]))
    : required;
  if (received && missing.length === 0 && !hasTemplateMarkers) return null;

  const example = buildToolArgumentsExample(toolName, params);
  const reason = hasTemplateMarkers
    ? 'arguments contain provider/tool-template marker tokens such as <|, |>, or <|"|>'
    : 'arguments are missing required fields';
  const markerRepairAllowed = !hasTemplateMarkers || options.allowMarkerRepair !== false;

  const details = {
    recoverable: markerRepairAllowed,
    recoveryKind: hasTemplateMarkers
      ? (markerRepairAllowed ? 'structured_tool_arguments_repair_prompt' : 'structured_tool_arguments_repair_failed')
      : 'structured_tool_arguments_json_retry',
    toolName,
    reason,
    hasTemplateMarkers,
    required,
    missing,
    receivedParams: params,
    expectedParameters: parameters
  };
  return {
    content: [
      `OpenAgent received your structured tool call for ${toolName}, but its arguments were not safe to execute.`,
      '',
      `Reason: ${reason}.`,
      `Missing or empty required JSON fields: ${missing.join(', ') || '(none)'}.`,
      '',
      markerRepairAllowed
        ? 'Repair exactly once now by issuing a real structured tool call again.'
        : 'The one allowed marker-token repair prompt for this tool has already been used in this run. Stop retrying this tool call and surface the failure to the user.',
      `Use tool name: ${toolName}`,
      'Use arguments as one strict JSON object matching the tool schema.',
      'Do not include <|, |>, <|"|>, ChatML markers, markdown, comments, or escaped template tokens anywhere in arguments.',
      'Do not write a text-form call such as call:tool_name{...}. Do not explain first.',
      ...(example
        ? [
            '',
            'Use this exact JSON shape as the only valid example for your next tool call arguments:',
            example
          ]
        : []),
      '',
      'Tool JSON schema:',
      safeStringify(parameters).slice(0, 4000),
      '',
      'Received arguments:',
      safeStringify(params).slice(0, 2000)
    ].join('\n'),
    details
  };
}

function containsToolTemplateMarkers(value: unknown): boolean {
  if (typeof value === 'string') return /<\||\|>|<\|"?\|>/.test(value);
  if (Array.isArray(value)) return value.some((item) => containsToolTemplateMarkers(item));
  if (isPlainRecord(value)) return Object.values(value).some((item) => containsToolTemplateMarkers(item));
  return false;
}

function buildToolArgumentsExample(toolName: string, params: unknown) {
  if (toolName === 'skill_script') {
    const inferred = inferSkillScriptExample(params);
    return safeStringify({
      skillName: inferred.skillName,
      scriptPath: inferred.scriptPath,
      args: inferred.args
    });
  }
  return null;
}

function inferSkillScriptExample(params: unknown) {
  const rawArgs = isPlainRecord(params) && Array.isArray(params.args)
    ? params.args.map((item) => stripToolTemplateMarkers(String(item))).filter(Boolean)
    : [];
  const nameIndex = rawArgs.indexOf('--name');
  const pathIndex = rawArgs.indexOf('--path');
  const skillNameArg = nameIndex >= 0 ? rawArgs[nameIndex + 1] : undefined;
  const pathArg = pathIndex >= 0 ? rawArgs[pathIndex + 1] : undefined;
  const skillName = typeof (isPlainRecord(params) ? params.skillName : undefined) === 'string'
    ? stripToolTemplateMarkers(String((params as Record<string, unknown>).skillName))
    : 'skill-creator';
  const scriptPath = typeof (isPlainRecord(params) ? params.scriptPath : undefined) === 'string'
    ? stripToolTemplateMarkers(String((params as Record<string, unknown>).scriptPath))
    : 'scripts/init_skill.mjs';
  const targetSkillName = skillNameArg || 'pdf-merger';
  const targetPath = pathArg && pathArg.startsWith('/')
    ? pathArg
    : `/Users/guolimin/.openagent/agents/main/skills/${targetSkillName}`;
  return {
    skillName: skillName || 'skill-creator',
    scriptPath: scriptPath || 'scripts/init_skill.mjs',
    args: ['--name', targetSkillName, '--path', targetPath]
  };
}

function stripToolTemplateMarkers(value: string) {
  return value
    .replace(/<\|"?\|>/g, '')
    .replace(/<\|/g, '')
    .replace(/\|>/g, '')
    .replace(/^"+|"+$/g, '')
    .trim();
}

function extractRequiredFields(parameters: unknown) {
  if (!isPlainRecord(parameters)) return [];
  const required = parameters.required;
  return Array.isArray(required)
    ? required.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function isMissingRequiredValue(value: unknown) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
