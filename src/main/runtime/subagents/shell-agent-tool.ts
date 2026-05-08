import type { RuntimeTool } from '../runtime-types.js';
import type { SubagentService } from './subagent-service.js';
import type { ShellAgentTask } from './subagent-types.js';

export function createShellAgentTool(subagents: SubagentService, workspaceRoot: string): RuntimeTool {
  return {
    name: 'shell_agent',
    label: 'System ShellAgent',
    description: 'Delegate safe read-only file-system tasks to the system ShellAgent. Provide structured arguments only; do not pass natural-language instructions. Supported operations: count_files, find_files, find_files_containing. For count_files, extension is mandatory and must be the file extension without a leading dot. For filename plus content searches, use find_files_containing with namePattern and contentPattern.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['count_files', 'find_files', 'find_files_containing'], description: 'The read-only operation to perform.' },
        root: { type: 'string', description: 'Absolute root directory. Defaults to workspace root when omitted.' },
        extension: { type: 'string', description: 'File extension without dot, such as md, ts, or java. Required for count_files and optional for find_files.' },
        namePattern: { type: 'string', description: 'Filename glob for find_files_containing, such as soul.md or *.md. Defaults to *.' },
        contentPattern: { type: 'string', description: 'Text or regexp that matching files must contain. Required for find_files_containing.' },
        ignoreCase: { type: 'boolean', description: 'Use case-insensitive content matching for find_files_containing.' },
        literal: { type: 'boolean', description: 'Treat contentPattern as literal text for find_files_containing. Defaults to true.' }
      },
      required: ['operation'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const operation = args.operation === 'count_files' || args.operation === 'find_files' || args.operation === 'find_files_containing' ? args.operation : null;
      if (!operation) return { ok: false, content: 'operation must be count_files, find_files, or find_files_containing' };
      if (operation === 'count_files' && typeof args.extension !== 'string') return { ok: false, content: 'extension is required for count_files' };
      if (operation === 'find_files_containing' && typeof args.contentPattern !== 'string') {
        return { ok: false, content: 'contentPattern is required for find_files_containing' };
      }
      const root = typeof args.root === 'string' && args.root.trim() ? args.root.trim() : undefined;
      let task: ShellAgentTask;
      if (operation === 'count_files') {
        task = { operation, root, extension: String(args.extension) };
      } else if (operation === 'find_files') {
        task = {
          operation,
          root,
          extension: typeof args.extension === 'string' && args.extension.trim() ? args.extension.trim() : undefined
        };
      } else {
        task = {
          operation,
          root,
          namePattern: typeof args.namePattern === 'string' && args.namePattern.trim() ? args.namePattern.trim() : undefined,
          contentPattern: String(args.contentPattern),
          ignoreCase: typeof args.ignoreCase === 'boolean' ? args.ignoreCase : undefined,
          literal: typeof args.literal === 'boolean' ? args.literal : undefined
        };
      }
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
