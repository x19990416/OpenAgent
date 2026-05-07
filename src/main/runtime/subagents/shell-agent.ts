import { spawn } from 'node:child_process';
import path from 'node:path';
import type { SubagentRunInput, SubagentRunResult } from './subagent-types.js';

const MAX_FIND_RESULTS = 1000;

export class ShellAgent {
  readonly id = 'shell' as const;

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    input.onLog?.({
      scope: 'runtime',
      message: 'system shell agent started',
      data: { subagentId: this.id, callerAgentId: input.callerAgentId, runId: input.runId, task: input.task }
    });

    const countTask = this.resolveCountTask(input.task, input.workspaceRoot);
    if (countTask) {
      return this.runCountTask(input, countTask);
    }

    const findTask = this.resolveFindTask(input.task, input.workspaceRoot);
    if (findTask) {
      return this.runFindTask(input, findTask);
    }

    return {
      ok: false,
      agentId: this.id,
      summary: 'ShellAgent 当前只支持只读的文件计数和文件查找类命令任务。',
      error: 'unsupported_shell_task'
    };
  }

  private async runCountTask(input: SubagentRunInput, task: { root: string; extension: string; label: string }) {
    const command = `find ${shellQuote(task.root)} -type f -name ${shellQuote(`*.${task.extension}`)} | wc -l`;
    const startedAt = Date.now();
    const shellResult = await this.runReadOnlyCommand(input, command);
    const count = Number.parseInt(shellResult.stdout.trim(), 10) || 0;
    const durationMs = Date.now() - startedAt;
    const summary = `统计完成：\`${task.root}\` 下共有 **${count}** 个 ${task.label}。`;
    return {
      ok: shellResult.ok,
      agentId: this.id,
      summary: [summary, '', `执行命令：\`${command}\``, `耗时：${durationMs}ms`].join('\n'),
      result: { root: task.root, extension: task.extension, count, command, stdout: shellResult.stdout, stderr: shellResult.stderr, durationMs },
      evidence: [`command: ${command}`],
      error: shellResult.ok ? undefined : shellResult.stderr || shellResult.stdout
    };
  }

  private async runFindTask(input: SubagentRunInput, task: { root: string; extension: string | null }) {
    const namePredicate = task.extension ? ` -name ${shellQuote(`*.${task.extension}`)}` : '';
    const command = `find ${shellQuote(task.root)} -type f${namePredicate} | head -n ${MAX_FIND_RESULTS}`;
    const shellResult = await this.runReadOnlyCommand(input, command);
    const files = shellResult.stdout.split('\n').map((item) => item.trim()).filter(Boolean);
    const content = files.length > 0 ? files.join('\n') : 'No files found';
    return {
      ok: shellResult.ok,
      agentId: this.id,
      summary: shellResult.ok ? `查找完成：\`${task.root}\` 下匹配条件的文件结果已返回。` : shellResult.stderr || shellResult.stdout,
      result: { root: task.root, extension: task.extension, command, count: files.length, content, stderr: shellResult.stderr },
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

  private resolveCountTask(task: string, workspaceRoot: string) {
    if (!/(统计|多少|数量|count)/i.test(task)) return null;
    const extension = this.resolveExtension(task);
    if (!extension) return null;
    const root = this.resolveTargetRoot(task, workspaceRoot);
    return {
      root,
      extension,
      label: `.${extension} 文件`
    };
  }

  private resolveFindTask(task: string, workspaceRoot: string) {
    if (!/(查找|搜索|找出|find|列出)/i.test(task)) return null;
    const root = this.resolveTargetRoot(task, workspaceRoot);
    return {
      root,
      extension: this.resolveExtension(task)
    };
  }

  private resolveExtension(task: string) {
    const dotted = task.match(/\.([A-Za-z0-9_-]+)\b/);
    if (dotted?.[1]) return dotted[1].toLowerCase();
    const md = task.match(/\b(md|markdown)\s*文件?/i);
    if (md) return md[1].toLowerCase() === 'markdown' ? 'md' : md[1].toLowerCase();
    return null;
  }

  private resolveTargetRoot(task: string, workspaceRoot: string) {
    const usersPathMatch = task.match(/(\/Users(?:\/[^\s，。；;]*)?)/);
    if (usersPathMatch?.[1]) return path.resolve(usersPathMatch[1]);
    const absolutePathMatch = task.match(/(\/[^\s，。；;]+)/);
    if (absolutePathMatch?.[1]) return path.resolve(absolutePathMatch[1]);
    return workspaceRoot;
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
