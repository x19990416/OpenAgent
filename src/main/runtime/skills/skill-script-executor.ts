import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_SCRIPT_OUTPUT_BYTES = 80_000;

export function runSkillScript(script: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const command = commandForScript(script, args);
    const child = spawn(command.cmd, command.args, { cwd, env: { ...process.env, OPENAGENT_SKILL_SCRIPT: script, OPENAGENT_SKILL_DIR: path.dirname(path.dirname(script)) } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    };
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('skill_script aborted'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = truncate(String(stdout) + String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = truncate(String(stderr) + String(chunk)); });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (exitCode) => finish(exitCode));
  });
}

function commandForScript(script: string, args: string[]) {
  if (script.endsWith('.py')) return { cmd: 'python3', args: [script, ...args] };
  if (script.endsWith('.js') || script.endsWith('.mjs') || script.endsWith('.cjs')) return { cmd: 'node', args: [script, ...args] };
  if (script.endsWith('.sh') || script.endsWith('.bash')) return { cmd: '/bin/bash', args: [script, ...args] };
  return { cmd: script, args };
}

function truncate(value: string) {
  return Buffer.byteLength(value, 'utf8') > MAX_SCRIPT_OUTPUT_BYTES ? `${value.slice(0, MAX_SCRIPT_OUTPUT_BYTES)}\n...[truncated]` : value;
}
