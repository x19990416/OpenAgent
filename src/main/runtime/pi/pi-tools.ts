import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { PlanExecutionContext, RuntimeLogEntry, RuntimeTool } from '../runtime-types.js';
import { ToolExecutor } from '../tool-executor.js';
import { normalizePiToolParametersWithReport } from './pi-tool-schema.js';

export function toPiToolDefinitionsPlaceholder(tools: RuntimeTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

export function toPiToolDefinitions(tools: RuntimeTool[], executor: ToolExecutor, options: { onLog?: (entry: RuntimeLogEntry) => void; getPlanContext?: () => PlanExecutionContext | null } = {}): ToolDefinition<any, unknown>[] {
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
      const normalizedParams = normalizeSelectedSkillScriptParams(tool.name, params, options.getPlanContext?.() ?? null);
      if (normalizedParams !== params) {
        options.onLog?.({
          scope: 'runtime',
          message: 'structured tool call arguments normalized from selected skill context',
          data: { toolName: tool.name, toolCallId, receivedParams: params, normalizedParams }
        });
      }
      const jsonRetry = buildStructuredToolJsonRetry(tool.name, schema.parameters, normalizedParams, {
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
        args: normalizedParams,
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

function normalizeSelectedSkillScriptParams(toolName: string, params: unknown, planContext?: PlanExecutionContext | null) {
  if (toolName !== 'skill_script' || !isPlainRecord(params)) return params;
  const selectedSkillName = String(planContext?.selectedSkillName || '').trim();
  const singleScriptPath = String(planContext?.selectedSkillSingleScriptPath || '').trim();
  if (!selectedSkillName || !singleScriptPath) return params;

  const next: Record<string, unknown> = { ...params };
  let changed = false;
  if (isMissingRequiredValue(next.skillName)) {
    next.skillName = selectedSkillName;
    changed = true;
  }
  if (isMissingRequiredValue(next.scriptPath)) {
    next.scriptPath = singleScriptPath;
    changed = true;
  }
  return changed ? next : params;
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

  const reason = hasTemplateMarkers
    ? 'arguments contain reserved provider marker tokens'
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
      'The previous structured tool call had invalid arguments.',
      '',
      markerRepairAllowed
        ? 'Retry once using a real structured tool call.'
        : 'The one allowed argument repair prompt for this tool has already been used in this run. Stop retrying this tool call and explain the blocker to the user.',
      '',
      `Tool: ${toolName}`,
      'Required arguments:',
      ...(required.length > 0 ? required.map((field) => `- ${field}`) : ['- (none)']),
      ...(missing.length > 0
        ? ['', 'Missing or empty required arguments:', ...missing.map((field) => `- ${field}`)]
        : []),
      '',
      'Do not include explanation text before the tool call.',
      'Do not include pseudo tool-call syntax, provider markers, ChatML markers, markdown, comments, or placeholder tokens in arguments.',
      'Do not reuse the same invalid arguments.'
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
