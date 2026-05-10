import type { PlanExecutionContext, RuntimeTool } from './runtime-types.js';
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

const READ_ONLY_TOOLS = new Set([
  'ls',
  'read',
  'find',
  'grep',
  'count_files',
  'shell_agent',
  'list_directory',
  'read_file',
  'current_time',
  'knowledge_search',
  'knowledge_query',
  'knowledge_health',
  'knowledge_lint',
  'knowledge_graph',
  'knowledge_provenance'
]);

const KNOWLEDGE_WRITE_TOOLS = new Set(['knowledge_ingest', 'knowledge_ingest_file', 'knowledge_compile', 'knowledge_compile_topic', 'knowledge_capture']);

export class ToolPolicy {
  constructor(private readonly workspaceRoot: string) {}

  decide(tool: RuntimeTool, args: unknown, planContext?: PlanExecutionContext | null): ToolPolicyDecision {
    const planDecision = this.decidePlanContext(tool, planContext);
    if (planDecision) return planDecision;

    if (tool.name === 'knowledge_agent') {
      return decideKnowledgeAgent(args);
    }

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


    if (KNOWLEDGE_WRITE_TOOLS.has(tool.name)) {
      return {
        kind: 'requires_approval',
        approval: {
          title: '请求写入 Knowledge Base',
          risk: 'medium',
          description: 'OpenAgent 需要将本次内容写入内置知识库或触发知识编译。批准后仅用于本次 tool 调用。',
          actionType: 'knowledge.ingest',
          access: 'write',
          scope: 'once',
          payloadPreview: this.summarizeArgs(args)
        }
      };
    }

    return {
      kind: 'deny',
      reason: `Tool requires an explicit OpenAgent policy before execution: ${tool.name}`
    };
  }


  private decidePlanContext(tool: RuntimeTool, planContext?: PlanExecutionContext | null): ToolPolicyDecision | null {
    if (!planContext) return null;

    if (planContext.mode === 'planning' && !READ_ONLY_TOOLS.has(tool.name)) {
      return {
        kind: 'deny',
        reason: `Tool ${tool.name} is blocked while Agent Plan is in planning mode.`
      };
    }

    const allowedTools = planContext.allowedTools ?? [];
    if (allowedTools.length > 0 && !matchesAllowedTool(tool.name, allowedTools)) {
      return {
        kind: 'deny',
        reason: `Tool ${tool.name} is not allowed in current plan step ${planContext.stepId}. Allowed: ${allowedTools.join(', ')}`
      };
    }

    return null;
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

function decideKnowledgeAgent(args: unknown): ToolPolicyDecision {
  const payload = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const operation = String(payload.operation ?? '');
  if (['search', 'query', 'ingest', 'ingest_file', 'compile', 'compile_topic', 'capture', 'provenance', 'health', 'lint', 'graph'].includes(operation)) {
    return { kind: 'allow' };
  }

  return { kind: 'deny', reason: `Unsupported KnowledgeAgent operation: ${operation || '(missing)'}` };
}

function matchesAllowedTool(toolName: string, allowedTools: string[]) {
  if (allowedTools.includes('*') || allowedTools.includes(toolName)) return true;
  if (allowedTools.includes('read-only') && READ_ONLY_TOOLS.has(toolName)) return true;
  if (allowedTools.includes('knowledge-write') && KNOWLEDGE_WRITE_TOOLS.has(toolName)) return true;
  if (allowedTools.includes('knowledge') && (toolName === 'knowledge_agent' || toolName.startsWith('knowledge_'))) return true;
  if (allowedTools.includes('tool-executor')) return true;
  return false;
}
