import { ToolExecutionError } from './errors.js';
import { ToolPolicy } from './tool-policy.js';
import type { ApprovalDecision, RuntimeApprovalRequest } from './approval-service.js';
import type { PlanExecutionContext, RuntimeLogEntry, RuntimeTool, RuntimeToolExecutionResult, RuntimeUiEvent } from './runtime-types.js';

export interface ToolExecutorOptions {
  runId?: string;
  threadId?: string;
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
    this.options.emitUiEvent?.('tool.started', makeUiPayload('running', `执行 ${input.toolName}: ${argsPreview}`));

    try {
      const result = await tool.execute({
        toolCallId: input.toolCallId,
        input: input.args,
        signal: input.signal,
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
      this.options.emitUiEvent?.('tool.failed', makeUiPayload('failed', `${input.toolName} 执行失败：${message}`, payload));
      throw error;
    }
  }
}
