import type { RuntimeTool } from '../runtime-types.js';
import type { SubagentService } from './subagent-service.js';
import type { PiCodingAgentTask } from './subagent-types.js';

export function createPiCodingAgentTool(subagents: SubagentService): RuntimeTool {
  return {
    name: 'pi_coding_agent',
    label: 'Coding Agent',
    description: 'Delegate coding, scripting, API fetching, complex artifact generation, command execution workflows, and iterative fix-and-run tasks to a child coding AgentSession. Use shell_agent only for deterministic read-only file search/count tasks.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Self-contained coding/execution task for the child agent.' },
        mode: { type: 'string', enum: ['inspect', 'edit', 'execute', 'generate'], description: 'Task mode. Use execute for write-and-run workflows, generate for complex artifacts.' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional child tool allowlist. Defaults to read/search/write_file/shell_exec/current_time.' },
        outputExpectation: { type: 'string', description: 'Expected final output format or deliverables.' },
        workingDirectory: { type: 'string', description: 'Optional working directory. Defaults to OpenAgent workspace.' },
        maxIterations: { type: 'number', description: 'Optional max fix/run iterations, 1-10.' }
      },
      required: ['task'],
      additionalProperties: false
    },
    execute: async ({ input, signal, context, toolCallId }) => {
      if (!context) return { ok: false, content: 'coding agent requires runtime execution context' };
      const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      const task = normalizeTask(args);
      if (!task.task) return { ok: false, content: 'task is required' };
      const result = await subagents.invoke('pi_coding', {
        task,
        callerAgentId: 'tool:pi_coding_agent',
        workspaceRoot: context.workspaceRoot ?? process.cwd(),
        signal,
        toolCallId,
        runtimeContext: context
      });
      return { ok: result.ok, content: result.summary, data: result };
    }
  };
}

function normalizeTask(args: Record<string, unknown>): PiCodingAgentTask {
  const mode = args.mode === 'inspect' || args.mode === 'edit' || args.mode === 'execute' || args.mode === 'generate' ? args.mode : undefined;
  return {
    task: typeof args.task === 'string' ? args.task.trim() : '',
    mode,
    allowedTools: Array.isArray(args.allowedTools) ? args.allowedTools.map(String).map((item) => item.trim()).filter(Boolean) : undefined,
    outputExpectation: typeof args.outputExpectation === 'string' ? args.outputExpectation.trim() : undefined,
    workingDirectory: typeof args.workingDirectory === 'string' ? args.workingDirectory.trim() : undefined,
    maxIterations: typeof args.maxIterations === 'number' ? args.maxIterations : undefined
  };
}
