import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RuntimeInfoLogInput {
  scope: string;
  message: string;
  data?: unknown;
}

export function appendRuntimeInfoLog(input: RuntimeInfoLogInput) {
  const line = formatRuntimeInfoLogLine(input);
  mkdirSync(path.dirname(getRuntimeInfoLogPath()), { recursive: true });
  appendFileSync(getRuntimeInfoLogPath(), `${line}\n`, 'utf8');
}

export function appendLlmResponseLog(input: RuntimeInfoLogInput) {
  const line = formatRuntimeInfoLogLine(input);
  mkdirSync(path.dirname(getLlmResponseLogPath()), { recursive: true });
  appendFileSync(getLlmResponseLogPath(), `${line}\n`, 'utf8');
}

export function getRuntimeInfoLogPath() {
  return path.join(os.homedir(), '.openagent', 'logs', 'runtime-info.log');
}

export function getLlmResponseLogPath() {
  return path.join(os.homedir(), '.openagent', 'logs', 'llm-response.log');
}

export function formatRuntimeInfoLogLine(input: RuntimeInfoLogInput) {
  const prefix = formatRuntimeInfoLogSummary(input);
  if (input.data === undefined) {
    return prefix;
  }

  return `${prefix}\n${safeStringify(input.data)}`;
}

export function formatRuntimeInfoLogSummary(input: RuntimeInfoLogInput) {
  return `[${new Date().toISOString()}] [info] [${input.scope}] ${input.message}`;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `<<unserializable: ${error instanceof Error ? error.message : String(error)}>>`;
  }
}
