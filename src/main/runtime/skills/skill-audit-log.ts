import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getOpenAgentHome } from '../openagent-home.js';

export interface SkillExecutionAuditEntry {
  ts?: string;
  runId?: string;
  threadId?: string;
  toolCallId?: string;
  event: 'skill.script.started' | 'skill.script.completed' | 'skill.script.failed';
  skillName: string;
  skillSource?: string;
  scriptPath: string;
  resolvedScriptPath?: string;
  cwd: string;
  args?: string[];
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  scriptRuntime?: string;
  scriptRisk?: string;
  network?: boolean;
  writes?: boolean;
  stdoutPreview?: string;
  stderrPreview?: string;
  pipDependencies?: string[];
  installedDependencies?: string[];
  availableDependencies?: string[];
  error?: string;
}

export function getSkillExecutionLogPath() {
  return path.join(getOpenAgentHome(), 'logs', 'skill-execution.jsonl');
}

export function appendSkillExecutionAuditLog(entry: SkillExecutionAuditEntry) {
  const nextEntry = {
    ts: new Date().toISOString(),
    ...entry
  };
  const file = getSkillExecutionLogPath();
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${safeStringify(nextEntry)}\n`, 'utf8');
  return file;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ ts: new Date().toISOString(), event: 'skill.audit.stringify_failed', error: error instanceof Error ? error.message : String(error) });
  }
}
