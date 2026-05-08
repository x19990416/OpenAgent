import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ShellAgentTask, SubagentRunInput, SubagentRunResult } from './subagent-types.js';

const MAX_FIND_RESULTS = 1000;

export class ShellAgent {
  readonly id = 'shell' as const;

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    input.onLog?.({
      scope: 'runtime',
      message: 'system shell agent started',
      data: { subagentId: this.id, callerAgentId: input.callerAgentId, runId: input.runId, task: input.task }
    });

    const task = this.normalizeTask(input.task, input.workspaceRoot);
    if (!task) {
      return {
        ok: false,
        agentId: this.id,
        summary: 'ShellAgent 当前只支持结构化的只读文件计数、文件查找、文件名加内容查找任务。',
        error: 'unsupported_shell_task'
      };
    }

    if (task.operation === 'count_files') {
      return this.runCountTask(input, task);
    }

    if (task.operation === 'find_files_containing') {
      return this.runFindContainingTask(input, task);
    }

    return this.runFindTask(input, task);
  }

  private async runCountTask(input: SubagentRunInput, task: { operation: 'count_files'; root: string; extension: string }) {
    const command = `find ${shellQuote(task.root)} -type f -name ${shellQuote(`*.${task.extension}`)} | wc -l`;
    const startedAt = Date.now();
    const shellResult = await this.runReadOnlyCommand(input, command);
    const count = Number.parseInt(shellResult.stdout.trim(), 10) || 0;
    const durationMs = Date.now() - startedAt;
    const summary = `统计完成：\`${task.root}\` 下共有 **${count}** 个 .${task.extension} 文件。`;
    return {
      ok: shellResult.ok,
      agentId: this.id,
      summary: [summary, '', `执行命令：\`${command}\``, `耗时：${durationMs}ms`].join('\n'),
      result: { root: task.root, extension: task.extension, count, command, stdout: shellResult.stdout, stderr: shellResult.stderr, durationMs },
      evidence: [`command: ${command}`],
      error: shellResult.ok ? undefined : shellResult.stderr || shellResult.stdout
    };
  }

  private async runFindTask(input: SubagentRunInput, task: { operation: 'find_files'; root: string; extension: string | null }) {
    const namePredicate = task.extension ? ` -name ${shellQuote(`*.${task.extension}`)}` : '';
    const command = `find ${shellQuote(task.root)} -type f${namePredicate} | head -n ${MAX_FIND_RESULTS}`;
    const shellResult = await this.runReadOnlyCommand(input, command);
    const files = shellResult.stdout.split('\n').map((item) => item.trim()).filter(Boolean);
    const content = files.length > 0 ? files.join('\n') : 'No files found';
    return {
      ok: shellResult.ok,
      agentId: this.id,
      summary: shellResult.ok ? [`查找完成：\`${task.root}\` 下匹配条件的文件结果如下。`, '', content].join('\n') : shellResult.stderr || shellResult.stdout,
      result: { root: task.root, extension: task.extension, command, count: files.length, content, stderr: shellResult.stderr },
      evidence: [`command: ${command}`],
      error: shellResult.ok ? undefined : shellResult.stderr || shellResult.stdout
    };
  }

  private async runFindContainingTask(
    input: SubagentRunInput,
    task: { operation: 'find_files_containing'; root: string; namePattern: string; contentPattern: string; ignoreCase: boolean; literal: boolean }
  ) {
    const grepFlags = ['-I', '-l'];
    if (task.ignoreCase) grepFlags.push('-i');
    if (task.literal) grepFlags.push('-F');
    const command = `find ${shellQuote(task.root)} -type f -iname ${shellQuote(task.namePattern)} -exec grep ${grepFlags.join(' ')} -- ${shellQuote(task.contentPattern)} {} + | head -n ${MAX_FIND_RESULTS}`;
    const shellResult = await this.runReadOnlyCommand(input, command);
    const files = shellResult.stdout.split('\n').map((item) => item.trim()).filter(Boolean);
    const content = files.length > 0 ? files.join('\n') : 'No files found';
    return {
      ok: shellResult.ok,
      agentId: this.id,
      summary: shellResult.ok ? [`查找完成：\`${task.root}\` 下文件名匹配 \`${task.namePattern}\` 且内容匹配指定文本的文件如下。`, '', content].join('\n') : shellResult.stderr || shellResult.stdout,
      result: {
        root: task.root,
        namePattern: task.namePattern,
        contentPattern: task.contentPattern,
        ignoreCase: task.ignoreCase,
        literal: task.literal,
        command,
        count: files.length,
        content,
        stderr: shellResult.stderr
      },
      evidence: [`command: ${command}`],
      error: shellResult.ok ? undefined : shellResult.stderr || shellResult.stdout
    };
  }

  private async runReadOnlyCommand(input: SubagentRunInput, command: string) {
    input.onLog?.({
      scope: 'runtime',
      message: 'system shell agent command started',
      data: { subagentId: this.id, runId: input.runId, command }
    });
    const result = await runBash(command, input.workspaceRoot, input.signal);
    input.onLog?.({
      scope: 'runtime',
      message: 'system shell agent command completed',
      data: { subagentId: this.id, runId: input.runId, command, exitCode: result.exitCode, stdoutLength: result.stdout.length, stderrLength: result.stderr.length }
    });
    return { ...result, ok: result.exitCode === 0 };
  }

  private normalizeTask(task: ShellAgentTask, workspaceRoot: string) {
    const root = task.root ? path.resolve(task.root) : workspaceRoot;

    if (task.operation === 'count_files') {
      const extension = normalizeExtension(task.extension);
      if (!extension) return null;
      return { operation: 'count_files' as const, root, extension };
    }

    if (task.operation === 'find_files') {
      return { operation: 'find_files' as const, root, extension: normalizeExtension(task.extension) };
    }

    if (task.operation === 'find_files_containing') {
      const contentPattern = typeof task.contentPattern === 'string' ? task.contentPattern : '';
      if (!contentPattern) return null;
      return {
        operation: 'find_files_containing' as const,
        root,
        namePattern: normalizeNamePattern(task.namePattern),
        contentPattern,
        ignoreCase: task.ignoreCase === true,
        literal: task.literal !== false
      };
    }

    return null;
  }
}

function runBash(command: string, cwd: string, signal: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], { cwd });
    let stdout = '';
    let stderr = '';
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('ShellAgent command aborted'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (exitCode) => {
      signal.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function normalizeExtension(extension: unknown) {
  if (typeof extension !== 'string') return null;
  const normalized = extension.trim().replace(/^\.+/, '').toLowerCase();
  return /^[a-z0-9_-]+$/.test(normalized) ? normalized : null;
}

function normalizeNamePattern(namePattern: unknown) {
  if (typeof namePattern !== 'string') return '*';
  return namePattern.trim() || '*';
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
