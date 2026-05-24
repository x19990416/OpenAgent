import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAX_SCRIPT_OUTPUT_BYTES = 80_000;
const DEFAULT_DEPENDENCY_TIMEOUT_MS = 120_000;

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function runSkillScript(script: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const command = commandForScript(script, args);
    const skillDir = path.dirname(path.dirname(script));
    runProcess(command.cmd, command.args, {
      cwd,
      env: {
        ...process.env,
        ...loadSkillDotEnv(skillDir),
        OPENAGENT_SKILL_SCRIPT: script,
        OPENAGENT_SKILL_DIR: skillDir
      },
      timeoutMs,
      signal,
      abortMessage: 'skill_script aborted'
    }).then(resolve, reject);
  });
}

function commandForScript(script: string, args: string[]) {
  if (script.endsWith('.py')) return { cmd: 'python3', args: [script, ...args] };
  if (script.endsWith('.js') || script.endsWith('.mjs') || script.endsWith('.cjs')) return { cmd: 'node', args: [script, ...args] };
  if (script.endsWith('.sh') || script.endsWith('.bash')) return { cmd: '/bin/bash', args: [script, ...args] };
  return { cmd: script, args };
}

function loadSkillDotEnv(skillDir: string): Record<string, string> {
  const envPath = path.join(skillDir, '.env');
  if (!existsSync(envPath)) return {};
  return parseDotEnv(readFileSync(envPath, 'utf8'));
}

function parseDotEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = unquoteDotEnvValue(normalized.slice(separator + 1).trim());
  }
  return env;
}

function unquoteDotEnvValue(value: string) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

function truncate(value: string) {
  return Buffer.byteLength(value, 'utf8') > MAX_SCRIPT_OUTPUT_BYTES ? `${value.slice(0, MAX_SCRIPT_OUTPUT_BYTES)}\n...[truncated]` : value;
}


export async function ensurePipDependencies(input: { packages: string[]; cwd: string; signal: AbortSignal; timeoutMs?: number }): Promise<{ installed: string[]; alreadyAvailable: string[]; checks: ProcessRunResult[]; installs: ProcessRunResult[] }> {
  const packages = Array.from(new Set(input.packages.map((pkg) => pkg.trim()).filter(Boolean)));
  const installed: string[] = [];
  const alreadyAvailable: string[] = [];
  const checks: ProcessRunResult[] = [];
  const installs: ProcessRunResult[] = [];
  for (const pkg of packages) {
    const moduleName = inferPythonModuleName(pkg);
    const check = await runProcess('python3', ['-c', `import ${moduleName}`], {
      cwd: input.cwd,
      env: process.env,
      timeoutMs: 20_000,
      signal: input.signal,
      abortMessage: 'skill dependency check aborted'
    });
    checks.push(check);
    if (check.exitCode === 0) {
      alreadyAvailable.push(pkg);
      continue;
    }
    const install = await runProcess('python3', ['-m', 'pip', 'install', '--user', pkg], {
      cwd: input.cwd,
      env: process.env,
      timeoutMs: input.timeoutMs ?? DEFAULT_DEPENDENCY_TIMEOUT_MS,
      signal: input.signal,
      abortMessage: 'skill dependency install aborted'
    });
    installs.push(install);
    if (install.exitCode !== 0) {
      throw new Error(`Failed to install pip dependency ${pkg}: ${install.stderr || install.stdout || `exitCode=${install.exitCode}`}`);
    }
    installed.push(pkg);
  }
  return { installed, alreadyAvailable, checks, installs };
}

function runProcess(cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal; abortMessage: string }): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    };
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error(options.abortMessage));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    if (options.signal.aborted) {
      abort();
      return;
    }
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = truncate(String(stdout) + String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = truncate(String(stderr) + String(chunk)); });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (exitCode) => finish(exitCode));
  });
}

function inferPythonModuleName(pkg: string) {
  const base = pkg.split(/[<>=!~;\[]/, 1)[0]?.trim() || pkg;
  return base.replace(/[-.]/g, '_');
}
