import type { RuntimeTool } from './runtime-types.js';
import { classifyToolPathAccess } from './path-policy.js';

export type ToolPolicyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | {
      kind: 'requires_approval';
      approval: {
        title: string;
        risk: 'low' | 'medium' | 'high';
        description: string;
        actionType: string;
        targetPath?: string;
        access?: 'read' | 'write' | 'execute';
        recursive?: boolean;
        scope?: 'once' | 'session' | 'always';
        payloadPreview?: string;
      };
    };

const READ_ONLY_TOOLS = new Set(['ls', 'read', 'find', 'grep', 'count_files', 'shell_agent', 'list_directory', 'read_file', 'current_time']);

export class ToolPolicy {
  constructor(private readonly workspaceRoot: string) {}

  decide(tool: RuntimeTool, args: unknown): ToolPolicyDecision {
    if (READ_ONLY_TOOLS.has(tool.name)) {
      const pathAccess = classifyToolPathAccess({ toolName: tool.name, args, workspaceRoot: this.workspaceRoot });
      if (pathAccess?.isExternal) {
        return {
          kind: 'requires_approval',
          approval: {
            title: '请求读取外部路径',
            risk: 'medium',
            description: [
              `OpenAgent 需要读取 workspace 外部路径：${pathAccess.targetPath}`,
              `当前 workspace：${this.workspaceRoot}`,
              '批准后仅用于本次 tool 调用。'
            ].join('\n'),
            actionType: 'external-path-read',
            targetPath: pathAccess.targetPath,
            access: pathAccess.access,
            recursive: tool.name !== 'read' && tool.name !== 'read_file',
            scope: 'once',
            payloadPreview: this.summarizeArgs(args)
          }
        };
      }
      return { kind: 'allow' };
    }

    return {
      kind: 'deny',
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
