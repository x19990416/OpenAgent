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
  'knowledge_provenance',
  'skill_list',
  'skill_load',
  'skill_resource'
]);

const KNOWLEDGE_WRITE_TOOLS = new Set(['knowledge_ingest', 'knowledge_ingest_file', 'knowledge_compile', 'knowledge_compile_topic', 'knowledge_capture']);
const FILE_WRITE_TOOLS = new Set(['write_file']);
const SHELL_EXEC_TOOLS = new Set(['shell_exec']);
const SKILL_SCRIPT_TOOLS = new Set(['skill_script']);
const SKILL_TOOLS = new Set(['skill_list', 'skill_load', 'skill_resource', 'skill_script']);
const PI_CODING_TOOLS = new Set(['pi_coding_agent']);

export class ToolPolicy {
  constructor(private readonly workspaceRoot: string) {}

  decide(tool: RuntimeTool, args: unknown, planContext?: PlanExecutionContext | null): ToolPolicyDecision {
    const planDecision = this.decidePlanContext(tool, planContext);
    if (planDecision) return planDecision;

    if (tool.name === 'knowledge_agent') {
      return decideKnowledgeAgent(args, this.summarizeArgs(args));
    }

    if (PI_CODING_TOOLS.has(tool.name)) {
      return decidePiCodingAgent(args, planContext);
    }

    if (tool.name === 'feishu_agent') {
      return decideFeishuAgent(args, this.summarizeArgs(args));
    }

    const toolDecision = tool.policy?.(args, planContext);
    if (toolDecision) {
      if (toolDecision.kind === 'requires_approval' && !toolDecision.approval.payloadPreview) {
        return {
          ...toolDecision,
          approval: {
            ...toolDecision.approval,
            payloadPreview: this.summarizeArgs(args)
          }
        };
      }
      return toolDecision;
    }

    if (tool.risk) {
      return this.decidePluginTool(tool, args);
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

    if (FILE_WRITE_TOOLS.has(tool.name)) {
      return this.decideFileWrite(tool, args);
    }

    if (SHELL_EXEC_TOOLS.has(tool.name)) {
      return this.decideShellExec(tool, args);
    }

    if (SKILL_SCRIPT_TOOLS.has(tool.name)) {
      return this.decideSkillScript(tool, args);
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

  private decidePluginTool(tool: RuntimeTool, args: unknown): ToolPolicyDecision {
    if (tool.risk === 'read') return { kind: 'allow' };

    const risk = tool.risk === 'destructive' ? 'high' : 'medium';
    const actionType = tool.risk === 'external_send'
      ? 'plugin.external_send'
      : tool.risk === 'external_write'
        ? 'plugin.external_write'
        : tool.risk === 'destructive'
          ? 'plugin.destructive'
          : 'plugin.secret_access';
    return {
      kind: 'requires_approval',
      approval: {
        title: `请求执行插件工具：${tool.label ?? tool.name}`,
        risk,
        description: [
          `OpenAgent 需要执行插件工具：${tool.name}`,
          `风险级别：${tool.risk}`,
          tool.description,
          '批准后仅用于本次 tool 调用。'
        ].filter(Boolean).join('\n'),
        actionType,
        access: tool.risk === 'external_send' || tool.risk === 'external_write' || tool.risk === 'destructive' ? 'write' : 'read',
        scope: 'once',
        payloadPreview: this.summarizeArgs(args)
      }
    };
  }

  private decideShellExec(tool: RuntimeTool, args: unknown): ToolPolicyDecision {
    const pathAccess = classifyToolPathAccess({ toolName: tool.name, args, workspaceRoot: this.workspaceRoot });
    if (!pathAccess) {
      return { kind: 'deny', reason: `Cannot classify cwd for shell execution tool: ${tool.name}` };
    }

    const command = String(asRecord(args).command ?? '').trim();
    if (!command) return { kind: 'deny', reason: 'shell_exec command is required' };
    const dependencyInstall = classifyDependencyInstall(command);

    return {
      kind: 'requires_approval',
      approval: {
        title: dependencyInstall ? '请求安装依赖' : '请求执行 shell 命令',
        risk: isLikelyDestructiveCommand(command) ? 'high' : dependencyInstall ? 'high' : 'medium',
        description: [
          `OpenAgent 需要执行命令：${command}`,
          `执行目录：${pathAccess.targetPath}`,
          `当前 workspace：${this.workspaceRoot}`,
          pathAccess.isExternal ? '执行目录位于 workspace 外部。' : '执行目录位于 workspace 内。',
          dependencyInstall
            ? [
                '',
                '依赖安装风险提示：',
                `包管理器：${dependencyInstall.manager}`,
                dependencyInstall.packages.length > 0 ? `候选包：${dependencyInstall.packages.join(', ')}` : '候选包：无法从命令中可靠解析',
                '该操作可能访问网络、修改本地运行环境，并带来供应链风险。优先建议使用 workspace-local 虚拟环境或项目级依赖。'
              ].join('\n')
            : '',
          '批准后仅用于本次 tool 调用。'
        ].filter(Boolean).join('\n'),
        actionType: 'shell.exec',
        targetPath: pathAccess.targetPath,
        access: 'execute',
        recursive: false,
        scope: 'once',
        payloadPreview: this.summarizeArgs(args)
      }
    };
  }

  private decideFileWrite(tool: RuntimeTool, args: unknown): ToolPolicyDecision {
    const pathAccess = classifyToolPathAccess({ toolName: tool.name, args, workspaceRoot: this.workspaceRoot });
    if (!pathAccess) {
      return { kind: 'deny', reason: `Cannot classify target path for file write tool: ${tool.name}` };
    }

    if (isDangerousWritePath(pathAccess.targetPath)) {
      return {
        kind: 'deny',
        reason: `Refusing to write to protected system or credential path: ${pathAccess.targetPath}`
      };
    }

    const payloadPreview = this.summarizeArgs(args);
    const overwrite = Boolean(asRecord(args).overwrite);
    if (pathAccess.isExternal || overwrite) {
      return {
        kind: 'requires_approval',
        approval: {
          title: pathAccess.isExternal ? '请求写入 workspace 外部路径' : '请求覆盖文件',
          risk: pathAccess.isExternal || overwrite ? 'medium' : 'low',
          description: [
            `OpenAgent 需要写入文件：${pathAccess.targetPath}`,
            `当前 workspace：${this.workspaceRoot}`,
            pathAccess.isExternal ? '目标位于 workspace 外部，必须经用户批准。' : '目标位于 workspace 内。',
            overwrite ? '本次调用声明允许覆盖已有文件。' : '本次调用不允许覆盖已有文件。',
            '批准后仅用于本次 tool 调用。'
          ].join('\n'),
          actionType: 'file.write',
          targetPath: pathAccess.targetPath,
          access: 'write',
          recursive: false,
          scope: 'once',
          payloadPreview
        }
      };
    }

    return { kind: 'allow' };
  }

  private decideSkillScript(tool: RuntimeTool, args: unknown): ToolPolicyDecision {
    const record = asRecord(args);
    const skillName = String(record.skillName ?? '').trim();
    const scriptPath = String(record.scriptPath ?? '').trim();
    if (!skillName || !scriptPath) {
      return { kind: 'deny', reason: 'skill_script requires skillName and scriptPath' };
    }
    if (scriptPath.includes('..') || scriptPath.startsWith('/') || scriptPath.includes('\\')) {
      return { kind: 'deny', reason: `Refusing unsafe skill script path: ${scriptPath}` };
    }
    return {
      kind: 'requires_approval',
      approval: {
        title: '请求执行 Skill 脚本',
        risk: 'medium',
        description: [
          `OpenAgent 需要执行 Skill 脚本：${skillName}/${scriptPath}`,
          'Skill 脚本由 OpenAgent 通过受控 tool 执行，会记录日志并受 timeout/abort 控制。',
          '批准后仅用于本次 tool 调用。'
        ].join('\n'),
        actionType: 'skill.script',
        access: 'execute',
        scope: 'once',
        payloadPreview: this.summarizeArgs(args)
      }
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

    if (planContext.selectedSkillName && SKILL_TOOLS.has(tool.name)) {
      return null;
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

function decideKnowledgeAgent(args: unknown, payloadPreview: string): ToolPolicyDecision {
  const payload = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const operation = String(payload.operation ?? '');
  if (['search', 'query', 'capture', 'provenance', 'health'].includes(operation)) {
    return { kind: 'allow' };
  }

  if (operation === 'ingest' || operation === 'ingest_file') {
    return {
      kind: 'requires_approval',
      approval: {
        title: '请求通过 KnowledgeAgent 写入 Knowledge Base',
        risk: 'medium',
        description: [
          'OpenAgent 需要通过 knowledge_agent 写入内置知识库。',
          `operation: ${operation}`,
          '批准后仅用于本次 tool 调用。'
        ].join('\n'),
        actionType: 'knowledge.ingest',
        access: 'write',
        scope: 'once',
        payloadPreview
      }
    };
  }

  if (operation === 'compile' || operation === 'compile_topic') {
    return {
      kind: 'requires_approval',
      approval: {
        title: '请求通过 KnowledgeAgent 编译 Knowledge Base',
        risk: 'medium',
        description: [
          'OpenAgent 需要通过 knowledge_agent 触发知识库编译。',
          `operation: ${operation}`,
          '该操作会生成或更新 summary / article / provenance / index 等知识库产物。',
          '批准后仅用于本次 tool 调用。'
        ].join('\n'),
        actionType: 'knowledge.compile',
        access: 'write',
        scope: 'once',
        payloadPreview
      }
    };
  }

  if (operation === 'lint' || operation === 'graph') {
    return {
      kind: 'requires_approval',
      approval: {
        title: '请求通过 KnowledgeAgent 维护 Knowledge Base',
        risk: 'medium',
        description: [
          'OpenAgent 需要通过 knowledge_agent 执行知识库维护操作。',
          `operation: ${operation}`,
          '该操作可能写入 report、graph 或其他派生产物。',
          '批准后仅用于本次 tool 调用。'
        ].join('\n'),
        actionType: 'knowledge.maintenance',
        access: 'write',
        scope: 'once',
        payloadPreview
      }
    };
  }

  return { kind: 'deny', reason: `Unsupported KnowledgeAgent operation: ${operation || '(missing)'}` };
}

function decideFeishuAgent(args: unknown, payloadPreview: string): ToolPolicyDecision {
  const payload = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const operation = String(payload.operation ?? '');
  const expectedRisk = String(payload.expectedRisk ?? inferFeishuRisk(payload));
  if (!operation) return { kind: 'deny', reason: 'feishu_agent operation is required' };
  if (expectedRisk === 'read') return { kind: 'allow' };

  const risk = expectedRisk === 'destructive' ? 'high' : 'medium';
  const access = expectedRisk === 'external_send' || expectedRisk === 'external_write' || expectedRisk === 'destructive' ? 'write' : 'read';
  return {
    kind: 'requires_approval',
    approval: {
      title: '请求执行飞书助手任务',
      risk,
      description: [
        'OpenAgent 需要通过飞书插件子 Agent 执行任务。',
        `operation: ${operation}`,
        `expectedRisk: ${expectedRisk}`,
        '批准后仅用于本次 tool 调用。'
      ].join('\n'),
      actionType: expectedRisk === 'external_send' ? 'plugin.external_send' : expectedRisk === 'destructive' ? 'plugin.destructive' : 'plugin.external_write',
      access,
      scope: 'once',
      payloadPreview
    }
  };
}

function inferFeishuRisk(payload: Record<string, unknown>) {
  const operation = String(payload.operation ?? '');
  if (operation === 'send_text_message' || operation === 'reply_to_current_chat') return 'external_send';
  if (operation !== 'cli') return 'read';
  const cliArgs = Array.isArray(payload.cliArgs) ? payload.cliArgs.map(String) : [];
  const text = cliArgs.join(' ');
  if (/(send|reply|message)/i.test(text)) return 'external_send';
  if (/(create|update|delete|remove|cancel|upload|overwrite|publish|approve|reject|transfer)/i.test(text)) return 'external_write';
  return 'read';
}

function matchesAllowedTool(toolName: string, allowedTools: string[]) {
  if (allowedTools.includes('*') || allowedTools.includes(toolName)) return true;
  if (allowedTools.includes('list') && (toolName === 'ls' || toolName === 'list_directory')) return true;
  if (allowedTools.includes('read') && (toolName === 'read' || toolName === 'read_file')) return true;
  if (allowedTools.includes('search') && ['find', 'grep', 'count_files'].includes(toolName)) return true;
  if (allowedTools.includes('read-only') && READ_ONLY_TOOLS.has(toolName)) return true;
  if (allowedTools.includes('knowledge-write') && KNOWLEDGE_WRITE_TOOLS.has(toolName)) return true;
  if (allowedTools.includes('knowledge') && (toolName === 'knowledge_agent' || toolName.startsWith('knowledge_'))) return true;
  if (allowedTools.includes('file-write') && FILE_WRITE_TOOLS.has(toolName)) return true;
  if (allowedTools.includes('shell-exec') && SHELL_EXEC_TOOLS.has(toolName)) return true;
  if ((allowedTools.includes('pi-coding') || allowedTools.includes('coding')) && PI_CODING_TOOLS.has(toolName)) return true;
  if ((allowedTools.includes('skill') || allowedTools.includes('skill-tools')) && SKILL_TOOLS.has(toolName)) return true;
  if (allowedTools.includes('tool-executor')) return true;
  return false;
}

function decidePiCodingAgent(args: unknown, planContext?: PlanExecutionContext | null): ToolPolicyDecision {
  if (planContext?.selectedSkillName && planContext.selectedSkillHasScripts) {
    return {
      kind: 'deny',
      reason: `Selected skill ${planContext.selectedSkillName} declares scripts; use skill_load/skill_resource/skill_script instead of delegating to pi_coding_agent.`
    };
  }

  const payload = asRecord(args);
  const task = String(payload.task ?? '').trim();
  if (!task) return { kind: 'deny', reason: 'coding agent task is required' };
  return { kind: 'allow' };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function isDangerousWritePath(targetPath: string) {
  const normalized = targetPath.replace(/\/+$/, '') || '/';
  return [
    '/bin',
    '/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/System',
    '/Library',
    '/etc',
    '/private/etc',
    `${process.env.HOME ?? ''}/.ssh`,
    `${process.env.HOME ?? ''}/.gnupg`
  ].filter(Boolean).some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isLikelyDestructiveCommand(command: string) {
  return /\b(rm\s+-|mv\s+|chmod\s+|chown\s+|dd\s+|mkfs|git\s+reset|git\s+clean|sudo\s+|launchctl\s+|kill\s+)/i.test(command);
}

function classifyDependencyInstall(command: string) {
  const normalized = command.trim();
  const match = /\b(?:(python3?|py)\s+-m\s+pip|pip3?)\s+install\s+([^;&|]+)/i.exec(normalized);
  if (match) {
    return { manager: 'pip', packages: extractPackageNames(match[2]) };
  }
  const npmMatch = /\b(npm|pnpm|yarn)\s+(?:add|install|i)\s+([^;&|]+)/i.exec(normalized);
  if (npmMatch) {
    return { manager: npmMatch[1].toLowerCase(), packages: extractPackageNames(npmMatch[2]) };
  }
  return null;
}

function extractPackageNames(value: string) {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith('-'))
    .slice(0, 12);
}
