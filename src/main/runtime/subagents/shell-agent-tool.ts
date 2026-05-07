import type { RuntimeTool } from '../runtime-types.js';
import type { SubagentService } from './subagent-service.js';

export function createShellAgentTool(subagents: SubagentService, workspaceRoot: string): RuntimeTool {
  return {
    name: 'shell_agent',
    label: 'System ShellAgent',
    description: 'Delegate safe command-style workspace tasks to the system ShellAgent. Use for read-only counting and file search tasks that are naturally expressed as shell commands.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The file-system task to perform.' }
      },
      required: ['task'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const task = String(args.task ?? '').trim();
      if (!task) return { ok: false, content: 'task is required' };
      const result = await subagents.invoke('shell', {
        task,
        callerAgentId: 'tool:shell_agent',
        workspaceRoot,
        signal
      });
      return { ok: result.ok, content: result.summary, data: result };
    }
  };
}
