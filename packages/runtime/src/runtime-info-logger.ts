import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getOpenAgentPath } from './openagent-home.js';

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
  return getOpenAgentPath('logs', 'runtime-info.log');
}

export function getLlmResponseLogPath() {
  return getOpenAgentPath('logs', 'llm-response.log');
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
