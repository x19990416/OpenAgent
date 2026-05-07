import type { RuntimeTool } from './runtime-types.js';

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

const READ_ONLY_TOOLS = new Set(['ls', 'read', 'find', 'grep', 'count_files', 'shell_agent', 'list_directory', 'read_file']);

export class ToolPolicy {
  decide(tool: RuntimeTool, args: unknown): ToolPolicyDecision {
    if (READ_ONLY_TOOLS.has(tool.name)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Tool requires an explicit OpenAgent policy before execution: ${tool.name}`
    };
  }

  summarizeArgs(args: unknown) {
    try {
      const text = JSON.stringify(args);
      return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
    } catch {
      return String(args);
    }
  }
}
