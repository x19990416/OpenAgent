import path from 'node:path';
import { ToolExecutionError } from './errors.js';
import { ToolPolicy } from './tool-policy.js';
import type { ApprovalDecision, RuntimeApprovalRequest } from './approval-service.js';
import type { PlanExecutionContext, RuntimeLogEntry, RuntimeTool, RuntimeToolExecutionResult, RuntimeUiEvent } from './runtime-types.js';

export interface ToolExecutorOptions {
  runId?: string;
  threadId?: string;
  agentId?: string;
  sessionFile?: string;
  providerId?: string;
  model?: string;
  emitUiEvent?: (type: RuntimeUiEvent['type'], payload?: unknown) => void;
  onLog?: (entry: RuntimeLogEntry) => void;
  policy?: ToolPolicy;
  workspaceRoot?: string;
  requestApproval?: (request: RuntimeApprovalRequest) => Promise<ApprovalDecision>;
  getPlanContext?: () => PlanExecutionContext | null;
}

export class ToolExecutor {
  private readonly policy: ToolPolicy;

  constructor(
    private readonly tools: RuntimeTool[],
    private readonly options: ToolExecutorOptions = {}
  ) {
    this.policy = options.policy ?? new ToolPolicy(options.workspaceRoot ?? process.cwd());
  }

  async execute(input: { toolName: string; toolCallId: string; args: unknown; signal: AbortSignal }): Promise<RuntimeToolExecutionResult> {
    const tool = this.tools.find((item) => item.name === input.toolName);
    if (!tool) {
      throw new ToolExecutionError(`Tool not found: ${input.toolName}`);
    }

    const startedAt = Date.now();
    const argsPreview = this.policy.summarizeArgs(input.args);
    const planContext = this.options.getPlanContext?.() ?? null;
    const basePayload = {
      runId: this.options.runId,
      threadId: this.options.threadId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      argsPreview,
      planContext: planContext ?? undefined
    };
    const makeUiPayload = (status: 'running' | 'completed' | 'failed', summary: string, meta: Record<string, unknown> = {}) => ({
      id: input.toolCallId,
      name: input.toolName,
      status,
      summary,
      createdAt: new Date().toISOString(),
      meta: { ...basePayload, ...meta }
    });
    const makeActivityPayload = (
      status: 'running' | 'completed' | 'failed',
      detail?: string
    ) => {
      const createdAt = new Date().toISOString();
      const target = inferActivityTarget(input.toolName, input.args, this.options.workspaceRoot);
      return {
        id: input.toolCallId,
        runId: this.options.runId,
        threadId: this.options.threadId,
        kind: inferActivityKind(input.toolName),
        status,
        title: formatActivityTitle(input.toolName, input.args, status, target),
        detail,
        toolName: input.toolName,
        target,
        planId: planContext?.planId,
        planStepId: planContext?.stepId,
        createdAt,
        completedAt: status === 'running' ? undefined : createdAt
      };
    };

    const decision = this.policy.decide(tool, input.args, planContext);
    if (decision.kind === 'deny') {
      const reason = decision.reason || `Tool blocked by OpenAgent policy: ${input.toolName}`;
      this.options.onLog?.({ scope: 'runtime', message: 'tool blocked by policy', data: { ...basePayload, reason } });
      this.options.emitUiEvent?.('tool.failed', makeUiPayload('failed', reason, { reason, durationMs: 0 }));
      throw new ToolExecutionError(reason, basePayload);
    }

    if (decision.kind === 'requires_approval') {
      if (!this.options.requestApproval) {
        const reason = `Tool requires approval but no approval handler is configured: ${input.toolName}`;
        this.options.onLog?.({ scope: 'runtime', message: 'tool approval handler missing', data: { ...basePayload, reason, approval: decision.approval } });
        this.options.emitUiEvent?.('tool.failed', makeUiPayload('failed', reason, { reason, durationMs: 0 }));
        throw new ToolExecutionError(reason, basePayload);
      }

      const approvalRequest: RuntimeApprovalRequest = {
        id: `${input.toolCallId}-approval`,
        runId: this.options.runId,
        threadId: this.options.threadId,
        ...decision.approval,
        description: planContext
          ? `${decision.approval.description}\n\nPlan context: ${planContext.planId} / ${planContext.stepId}`
          : decision.approval.description
      };
      this.options.onLog?.({ scope: 'runtime', message: 'tool waiting for approval', data: { ...basePayload, approval: approvalRequest } });
      const approvalDecision = await this.options.requestApproval(approvalRequest);
      if (approvalDecision !== 'approved') {
        const reason = `User rejected approval for ${input.toolName}: ${approvalRequest.targetPath ?? approvalRequest.description}`;
        this.options.onLog?.({ scope: 'runtime', message: 'tool approval rejected', data: { ...basePayload, reason, approval: approvalRequest } });
        this.options.emitUiEvent?.('tool.failed', makeUiPayload('failed', reason, { reason, durationMs: Date.now() - startedAt }));
        throw new ToolExecutionError(reason, basePayload);
      }
      this.options.onLog?.({ scope: 'runtime', message: 'tool approval granted', data: { ...basePayload, approval: approvalRequest } });
    }

    this.options.onLog?.({ scope: 'runtime', message: 'tool execution started', data: basePayload });
    this.options.emitUiEvent?.('runtime.activity', makeActivityPayload('running'));
    this.options.emitUiEvent?.('tool.started', makeUiPayload('running', `执行 ${input.toolName}: ${argsPreview}`));

    try {
      const result = await tool.execute({
        toolCallId: input.toolCallId,
        input: input.args,
        signal: input.signal,
        context: {
          runId: this.options.runId,
          threadId: this.options.threadId,
          agentId: this.options.agentId,
          sessionFile: this.options.sessionFile,
          workspaceRoot: this.options.workspaceRoot,
          tools: this.tools,
          providerId: this.options.providerId,
          model: this.options.model,
          onLog: this.options.onLog,
          emitUiEvent: this.options.emitUiEvent,
          requestApproval: this.options.requestApproval,
          getPlanContext: this.options.getPlanContext
        },
        onUpdate: (update) => {
          this.options.onLog?.({ scope: 'runtime', message: 'tool execution update', data: { ...basePayload, update } });
        }
      });
      const durationMs = Date.now() - startedAt;
      const payload = {
        ...basePayload,
        ok: result.ok,
        contentLength: result.content.length,
        contentPreview: result.content.slice(0, 1000),
        data: result.data,
        durationMs
      };
      this.options.onLog?.({ scope: 'runtime', message: 'tool execution completed', data: payload });
      this.options.emitUiEvent?.('runtime.activity', makeActivityPayload(result.ok ? 'completed' : 'failed', result.ok ? undefined : result.content.slice(0, 500)));
      this.options.emitUiEvent?.(
        result.ok ? 'tool.completed' : 'tool.failed',
        makeUiPayload(result.ok ? 'completed' : 'failed', result.ok ? `${input.toolName} 执行完成` : `${input.toolName} 执行失败`, payload)
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const payload = { ...basePayload, error: message, durationMs };
      this.options.onLog?.({ scope: 'runtime', message: 'tool execution failed', data: payload });
      this.options.emitUiEvent?.('runtime.activity', makeActivityPayload('failed', message));
      this.options.emitUiEvent?.('tool.failed', makeUiPayload('failed', `${input.toolName} 执行失败：${message}`, payload));
      throw error;
    }
  }
}

function inferActivityKind(toolName: string) {
  if (toolName === 'read' || toolName === 'read_file') return 'read';
  if (toolName === 'write_file') return 'write';
  if (toolName === 'pi_coding_agent') return 'tool';
  if (toolName === 'ls' || toolName === 'list_directory') return 'list';
  if (toolName === 'grep' || toolName === 'find' || toolName === 'count_files') return 'search';
  if (toolName === 'shell_agent' || toolName === 'shell_exec' || toolName.includes('shell') || toolName.includes('exec')) return 'command';
  if (toolName === 'knowledge_agent' || toolName.startsWith('knowledge_')) return 'search';
  return 'tool';
}

function formatActivityTitle(toolName: string, args: unknown, status: 'running' | 'completed' | 'failed', target?: string) {
  const record = asRecord(args);
  const suffix = target ? ` ${target}` : '';
  const failed = status === 'failed';
  const verb = failed ? 'Failed' : '';

  if (toolName === 'read' || toolName === 'read_file') return failed ? `Failed to read${suffix}` : `${status === 'running' ? 'Reading' : 'Read'}${suffix}`;
  if (toolName === 'ls' || toolName === 'list_directory') return failed ? `Failed to list files${suffix ? ` in ${target}` : ''}` : `${status === 'running' ? 'Listing files' : 'Listed files'}${suffix ? ` in ${target}` : ''}`;
  if (toolName === 'find') {
    const pattern = textArg(record, 'pattern') || target || 'files';
    return failed ? `Failed to search for ${pattern}` : `${status === 'running' ? 'Searching for' : 'Searched for'} ${pattern}`;
  }
  if (toolName === 'grep') {
    const pattern = textArg(record, 'pattern') || 'text';
    return failed ? `Failed to search for ${pattern}` : `${status === 'running' ? 'Searching for' : 'Searched for'} ${pattern}`;
  }
  if (toolName === 'count_files') {
    const pattern = textArg(record, 'pattern') || 'files';
    return failed ? `Failed to count ${pattern}` : `${status === 'running' ? 'Counting' : 'Counted'} ${pattern}`;
  }
  if (toolName === 'write_file') return failed ? `Failed to write${suffix}` : `${status === 'running' ? 'Writing' : 'Wrote'}${suffix}`;
  if (toolName === 'knowledge_agent') {
    const operation = textArg(record, 'operation') || 'query';
    const query = textArg(record, 'query') || textArg(record, 'topic') || textArg(record, 'filePath');
    return failed
      ? `Failed knowledge ${operation}`
      : `${status === 'running' ? 'Running' : 'Completed'} knowledge ${operation}${query ? `: ${shorten(query, 80)}` : ''}`;
  }
  if (toolName === 'shell_agent') {
    const operation = textArg(record, 'operation') || 'task';
    const pattern = textArg(record, 'contentPattern') || textArg(record, 'namePattern') || textArg(record, 'extension');
    return failed
      ? `Failed shell agent ${operation}`
      : `${status === 'running' ? 'Running' : 'Ran'} shell agent ${operation}${pattern ? `: ${shorten(pattern, 80)}` : ''}`;
  }
  if (toolName === 'shell_exec') {
    const command = textArg(record, 'command');
    return failed ? 'Failed command' : `${status === 'running' ? 'Running' : 'Ran'} command${command ? `: ${shorten(command, 80)}` : ''}`;
  }
  if (toolName === 'pi_coding_agent') {
    const task = textArg(record, 'task') || 'coding task';
    return failed ? `Failed pi coding agent: ${shorten(task, 80)}` : `${status === 'running' ? 'Running' : 'Completed'} pi coding agent: ${shorten(task, 80)}`;
  }
  if (toolName.includes('shell') || toolName.includes('exec')) {
    const command = textArg(record, 'command') || textArg(record, 'cmd');
    return failed ? 'Failed command' : `${status === 'running' ? 'Running' : 'Ran'} command${command ? `: ${shorten(command, 80)}` : ''}`;
  }

  const label = toolName.replace(/^tool[._-]/u, '');
  return failed ? `${verb} ${label}` : `${status === 'running' ? 'Running' : 'Completed'} ${label}`;
}

function inferActivityTarget(toolName: string, args: unknown, workspaceRoot?: string) {
  const record = asRecord(args);
  const raw =
    textArg(record, 'path') ||
    textArg(record, 'filePath') ||
    textArg(record, 'root') ||
    textArg(record, 'cwd') ||
    '';
  if (!raw) return undefined;
  return formatPathForActivity(raw, workspaceRoot);
}

function formatPathForActivity(value: string, workspaceRoot?: string) {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!path.isAbsolute(normalized)) return shorten(normalized, 80);
  if (workspaceRoot) {
    const relative = path.relative(workspaceRoot, normalized);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return shorten(relative, 80);
    }
  }
  return shorten(path.basename(normalized) || normalized, 80);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textArg(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function shorten(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
