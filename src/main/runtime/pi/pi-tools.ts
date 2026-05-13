import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
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
