import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PiRuntimeAdapter } from '../pi/pi-runtime-adapter.js';
import { resolvePiSessionFile } from '../pi/pi-session.js';
import type { AgentRuntimeRunInput, PlanExecutionContext, RuntimeTool, RuntimeToolExecutionContext, RuntimeToolExecutionInput } from '../runtime-types.js';
import type { PiCodingAgentTask, SubagentRunResult } from './subagent-types.js';
import { getOpenAgentPath } from '../openagent-home.js';
import { sanitizeModelReplayText } from '../pi/pi-system-prompt.js';

const DEFAULT_CHILD_TOOL_NAMES = new Set(['ls', 'read', 'find', 'grep', 'count_files', 'write_file', 'shell_exec', 'current_time', 'list_directory', 'read_file']);
const MAX_TASK_LENGTH = 8000;

export class PiCodingAgent {
  readonly id = 'pi_coding' as const;
  private readonly adapter = new PiRuntimeAdapter();

  async run(input: { task: PiCodingAgentTask; toolCallId: string; context: RuntimeToolExecutionContext; signal: AbortSignal }): Promise<SubagentRunResult> {
    const taskText = input.task.task.trim();
    if (!taskText) {
      return { ok: false, agentId: this.id, summary: 'coding agent task is required.', error: 'missing_task' };
    }

    const context = input.context;
    const workspaceRoot = context.workspaceRoot ?? process.cwd();
    const runId = `${context.runId ?? 'run'}:pi-coding:${input.toolCallId}`;
    const threadId = context.threadId ?? 'thread-unknown';
    const agentId = context.agentId ?? 'main';
    const providerId = context.providerId ?? 'openai';
    const model = context.model ?? '';
    const workingDirectory = await resolveWorkingDirectory(input.task.workingDirectory, workspaceRoot);
    const maxIterations = normalizeMaxIterations(input.task.maxIterations);
    const sessionFile = await resolveChildSessionFile(context.sessionFile, agentId, context.runId, input.toolCallId, workspaceRoot);
    const childTranscriptFile = resolvePiSessionFile(sessionFile);
    const childMeta = {
      subagentId: 'pi_coding_agent',
      parentRunId: context.runId,
      parentThreadId: context.threadId,
      parentToolCallId: input.toolCallId,
      childRunId: runId,
      childSessionFile: childTranscriptFile,
      openAgentSessionFile: sessionFile,
      workingDirectory
    };
    const childTools = selectChildTools(context.tools ?? [], input.task.allowedTools, workingDirectory, workspaceRoot);

    context.onLog?.({
      scope: 'runtime',
      message: 'coding agent child session started',
      data: {
        ...childMeta,
        subagentId: this.id,
        runId,
        threadId,
        sessionFile,
        workspaceRoot,
        workingDirectory,
        mode: input.task.mode ?? 'execute',
        maxIterations,
        tools: childTools.map((tool) => tool.name)
      }
    });

    context.emitUiEvent?.('runtime.activity', {
      id: `${runId}-child-session`,
      runId: context.runId,
      threadId,
      kind: 'tool',
      status: 'running',
      title: 'coding agent child session started',
      detail: `childRunId=${runId}; tools=${childTools.map((tool) => tool.name).join(', ')}`,
      toolName: 'pi_coding_agent',
      createdAt: new Date().toISOString(),
      meta: childMeta
    });

    const childInput: AgentRuntimeRunInput = {
      runId,
      threadId,
      agentId,
      workspaceRoot,
      sessionFile,
      prompt: buildChildPrompt(input.task),
      providerId,
      model,
      systemPrompt: buildChildSystemPrompt({ workspaceRoot, workingDirectory, mode: input.task.mode ?? 'execute', outputExpectation: input.task.outputExpectation }),
      messages: [],
      attachments: [],
      tools: childTools,
      abortSignal: input.signal,
      onLog: (entry) => {
        context.onLog?.({
          ...entry,
          data: {
            ...(entry.data && typeof entry.data === 'object' ? entry.data as Record<string, unknown> : { value: entry.data }),
            ...childMeta,
            subagentId: this.id
          }
        });
      },
      emitUiEvent: (type, payload) => {
        context.emitUiEvent?.(type, decoratePayload(payload, childMeta));
      },
      requestApproval: context.requestApproval,
      getPlanContext: () => buildChildPlanContext(context.getPlanContext?.()),
      maxIterations
    };

    const result = await this.adapter.run(childInput);
    const ok = result.status === 'completed';
    const summary = formatChildSummary({
      ok,
      status: result.status,
      rawSummary: result.summary || result.assistantMessage?.content || result.error || '',
      childRunId: runId,
      sessionFile: childTranscriptFile,
      workingDirectory,
      tools: childTools.map((tool) => tool.name)
    });

    context.onLog?.({
      scope: 'runtime',
      message: 'coding agent child session completed',
      data: {
        ...childMeta,
        subagentId: this.id,
        status: result.status,
        summary: summary.slice(0, 1000)
      }
    });

    context.emitUiEvent?.('runtime.activity', {
      id: `${runId}-child-session`,
      runId: context.runId,
      threadId,
      kind: 'tool',
      status: ok ? 'completed' : 'failed',
      title: ok ? 'coding agent child session completed' : 'coding agent child session failed',
      detail: summary.slice(0, 500),
      toolName: 'pi_coding_agent',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      meta: childMeta
    });

    return {
      ok,
      agentId: this.id,
      summary,
      result: { status: result.status, sessionFile: childTranscriptFile, childRunId: runId, assistantMessage: result.assistantMessage },
      evidence: [`childRunId: ${runId}`, `sessionFile: ${childTranscriptFile}`],
      error: ok ? undefined : result.error || summary
    };
  }
}


function formatChildSummary(input: { ok: boolean; status: string; rawSummary: string; childRunId: string; sessionFile: string; workingDirectory: string; tools: string[] }) {
  const raw = sanitizeModelReplayText(input.rawSummary).trim() || (input.ok ? 'coding agent completed.' : 'coding agent failed.');
  return [
    input.ok ? 'coding agent completed.' : 'coding agent failed.',
    '',
    `status: ${input.status}`,
    `childRunId: ${input.childRunId}`,
    `sessionFile: ${input.sessionFile}`,
    `workingDirectory: ${input.workingDirectory}`,
    `tools: ${input.tools.join(', ') || '(none)'}`,
    '',
    'child summary:',
    raw
  ].join('\n');
}

function buildChildPrompt(task: PiCodingAgentTask) {
  return [
    `Task: ${task.task.slice(0, MAX_TASK_LENGTH)}`,
    task.workingDirectory ? `Working directory: ${task.workingDirectory}` : '',
    task.outputExpectation ? `Output expectation: ${task.outputExpectation}` : '',
    typeof task.maxIterations === 'number' ? `Max iterations: ${Math.max(1, Math.min(10, Math.floor(task.maxIterations)))}` : ''
  ].filter(Boolean).join('\n');
}

function buildChildSystemPrompt(input: { workspaceRoot: string; workingDirectory: string; mode: string; outputExpectation?: string }) {
  return [
    'You are OpenAgent coding agent, a child coding agent running inside OpenAgent Runtime.',
    `workspaceRoot: ${input.workspaceRoot}`,
    `workingDirectory: ${input.workingDirectory}`,
    `mode: ${input.mode}`,
    '',
    'Responsibilities:',
    '- Write scripts or source files when needed using write_file.',
    '- Execute scripts or local programs using shell_exec when needed; shell_exec will trigger OpenAgent approval.',
    '- Read, search, and inspect files with read/grep/find/ls/count_files.',
    '- If a command fails, inspect the error, fix the script or command, and retry within the task limits.',
    '- Return a concise final summary with produced files, executed commands, and verified results.',
    '',
    'Safety and tool rules:',
    '- Never claim a file was written or command was executed unless the tool call succeeded.',
    '- Do not output fake tool call text such as call:shell_exec{...}<tool_call|>; use structured tool calls only.',
    '- Do not call recursive child-agent tools.',
    '- Do not bypass OpenAgent ToolPolicy, approval, logs, or UI events.',
    '- Prefer standard library or existing dependencies. If dependency installation is necessary, use shell_exec and explain the package, install location, and network risk.',
    input.outputExpectation ? `Final output expectation: ${input.outputExpectation}` : ''
  ].filter(Boolean).join('\n');
}

function selectChildTools(tools: readonly RuntimeTool[], allowedTools: string[] | undefined, workingDirectory: string, workspaceRoot: string) {
  const allowed = new Set((allowedTools?.length ? allowedTools : [...DEFAULT_CHILD_TOOL_NAMES]).filter((name) => name !== 'pi_coding_agent'));
  return tools
    .filter((tool) => allowed.has(tool.name) && tool.name !== 'pi_coding_agent')
    .map((tool) => withWorkingDirectoryDefaults(tool, workingDirectory, workspaceRoot));
}

function buildChildPlanContext(parentContext?: PlanExecutionContext | null): PlanExecutionContext | null {
  if (!parentContext) return null;
  return {
    ...parentContext,
    allowedTools: ['tool-executor']
  };
}

async function resolveChildSessionFile(parentSessionFile: string | undefined, agentId: string, parentRunId: string | undefined, toolCallId: string, workspaceRoot: string) {
  const baseDir = parentSessionFile
    ? path.join(path.dirname(parentSessionFile), 'subagents', 'pi-coding')
    : getOpenAgentPath('agents', agentId, 'sessions', 'subagents', 'pi-coding');
  await mkdir(baseDir, { recursive: true });
  const prefix = parentRunId ? `${sanitizeFilePart(parentRunId)}-` : '';
  return path.join(baseDir, `${prefix}${sanitizeFilePart(toolCallId)}.jsonl`);
}

async function resolveWorkingDirectory(value: string | undefined, workspaceRoot: string) {
  if (!value?.trim()) return workspaceRoot;
  const target = path.isAbsolute(value.trim()) ? path.normalize(value.trim()) : path.resolve(workspaceRoot, value.trim());
  const stats = await stat(target).catch(() => null);
  if (!stats?.isDirectory()) return workspaceRoot;
  return target;
}

function normalizeMaxIterations(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function withWorkingDirectoryDefaults(tool: RuntimeTool, workingDirectory: string, workspaceRoot: string): RuntimeTool {
  if (workingDirectory === workspaceRoot) return tool;
  return {
    ...tool,
    execute: (input) => tool.execute({
      ...input,
      input: applyWorkingDirectoryDefaults(tool.name, input.input, workingDirectory)
    } satisfies RuntimeToolExecutionInput)
  };
}

function applyWorkingDirectoryDefaults(toolName: string, input: unknown, workingDirectory: string) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  if (toolName === 'shell_exec') {
    args.cwd = resolveRelativeArgument(args.cwd, workingDirectory, '.');
    return args;
  }
  if (['write_file', 'read', 'read_file', 'ls', 'list_directory', 'find', 'grep', 'count_files'].includes(toolName)) {
    args.path = resolveRelativeArgument(args.path, workingDirectory, '.');
    return args;
  }
  return input;
}

function resolveRelativeArgument(value: unknown, workingDirectory: string, fallback: string) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(workingDirectory, raw);
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'tool-call';
}

function decoratePayload(payload: unknown, meta: Record<string, unknown>) {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    return {
      ...record,
      meta: {
        ...(record.meta && typeof record.meta === 'object' ? record.meta as Record<string, unknown> : {}),
        ...meta
      }
    };
  }
  return { value: payload, meta };
}
