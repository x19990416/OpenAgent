import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from '@mariozechner/pi-coding-agent';

export interface OpenAgentPiSessionInput {
  workspaceRoot: string;
  openAgentSessionFile: string;
  authStorage: unknown;
  modelRegistry: unknown;
  selectedModel: unknown;
  customTools: ToolDefinition<any, unknown>[];
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | string;
  sessionReplayMode?: 'thread' | 'tool_minimal';
  runId?: string;
}

export interface OpenAgentPiSessionHandle {
  session: any;
  piSessionFile: string;
  agentDir: string;
}

export async function createOpenAgentPiSession(input: OpenAgentPiSessionInput): Promise<OpenAgentPiSessionHandle> {
  const agentDir = resolveAgentDir(input.openAgentSessionFile);
  const piSessionFile = input.sessionReplayMode === 'tool_minimal'
    ? resolvePiToolMinimalSessionFile(input.openAgentSessionFile, input.runId || 'run')
    : resolvePiSessionFile(input.openAgentSessionFile);
  const settingsManager = SettingsManager.create();
  const sessionManager = SessionManager.open(piSessionFile);
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.workspaceRoot,
    agentDir,
    settingsManager
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: input.workspaceRoot,
    agentDir,
    authStorage: input.authStorage as any,
    modelRegistry: input.modelRegistry as any,
    model: input.selectedModel as any,
    sessionManager,
    settingsManager,
    resourceLoader,
    // OpenAgent intentionally allows only its managed custom tools here.
    // In Pi SDK, `tools` is the allow-list for all tools, including customTools;
    // passing [] filters customTools out as well.
    tools: input.customTools.map((tool) => tool.name) as any,
    customTools: input.customTools,
    thinkingLevel: (input.thinkingLevel ?? 'off') as any
  });

  return { session, piSessionFile, agentDir };
}

export function resolveAgentDir(openAgentSessionFile: string) {
  return path.dirname(path.dirname(openAgentSessionFile));
}

export function resolvePiSessionFile(openAgentSessionFile: string) {
  const sessionsDir = path.dirname(openAgentSessionFile);
  const piSessionsDir = path.join(sessionsDir, 'pi');
  mkdirSync(piSessionsDir, { recursive: true });
  return path.join(piSessionsDir, path.basename(openAgentSessionFile));
}

export function resolvePiToolMinimalSessionFile(openAgentSessionFile: string, runId: string) {
  const sessionsDir = path.dirname(openAgentSessionFile);
  const piSessionsDir = path.join(sessionsDir, 'pi-tool-minimal');
  mkdirSync(piSessionsDir, { recursive: true });
  const safeRunId = runId.replace(/[^A-Za-z0-9_.-]/g, '-');
  return path.join(piSessionsDir, `${path.basename(openAgentSessionFile)}.${safeRunId}.jsonl`);
}
