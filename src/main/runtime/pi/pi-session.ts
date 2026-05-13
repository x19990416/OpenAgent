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
}

export interface OpenAgentPiSessionHandle {
  session: any;
  piSessionFile: string;
  agentDir: string;
}

export async function createOpenAgentPiSession(input: OpenAgentPiSessionInput): Promise<OpenAgentPiSessionHandle> {
  const agentDir = resolveAgentDir(input.openAgentSessionFile);
  const piSessionFile = resolvePiSessionFile(input.openAgentSessionFile);
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
    // OpenAgent intentionally disables Pi built-in tools. All tool execution must
    // cross the OpenAgent ToolExecutor/Policy/Approval/Event boundary.
    tools: [],
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
