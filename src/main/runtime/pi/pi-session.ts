import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';

export interface OpenAgentPiSessionInput {
  workspaceRoot: string;
  openAgentSessionFile: string;
  authStorage: unknown;
  modelRegistry: unknown;
  selectedModel: unknown;
  customTools: ToolDefinition<any, unknown>[];
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | string;
  systemPromptOverride?: string;
  onLog?: (entry: { scope: string; message: string; data?: unknown }) => void;
}

export interface OpenAgentPiSessionHandle {
  session: any;
  piSessionFile: string;
  agentDir: string;
}

export async function createOpenAgentPiSession(input: OpenAgentPiSessionInput): Promise<OpenAgentPiSessionHandle> {
  const agentDir = resolveAgentDir(input.openAgentSessionFile);
  const piSessionFile = resolvePiSessionFile(input.openAgentSessionFile);
  const settingsManager = SettingsManager.create(input.workspaceRoot, agentDir);
  const sessionManager = SessionManager.open(piSessionFile);
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.workspaceRoot,
    agentDir,
    settingsManager,
    extensionFactories: [createOpenAgentProviderOptionsExtension(input.onLog)],
    ...(input.systemPromptOverride
      ? {
          systemPromptOverride: () => input.systemPromptOverride ?? '',
          appendSystemPromptOverride: () => []
        }
      : {})
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
    // OpenAgent intentionally allowlists only its managed custom tools. In Pi SDK,
    // `tools: []` means "allow no tools" and filters customTools out before the
    // provider request is built, so pass the custom tool names instead of an empty
    // list to keep built-ins disabled while preserving structured tool calls.
    tools: input.customTools.map((tool) => tool.name),
    customTools: input.customTools,
    thinkingLevel: (input.thinkingLevel ?? 'off') as any
  });

  return { session, piSessionFile, agentDir };
}

function createOpenAgentProviderOptionsExtension(onLog?: OpenAgentPiSessionInput['onLog']) {
  return (pi: any) => {
    pi.on('before_provider_request', (event: { payload: unknown }, context: { model?: { api?: string; provider?: string; id?: string } }) => {
      const payload = event.payload;
      if (!shouldApplyOpenAiToolOptions(payload, context.model)) return undefined;

      const request = payload as Record<string, unknown>;
      const hadToolChoice = request.tool_choice !== undefined;
      const hadTemperature = request.temperature !== undefined;
      const nextPayload = {
        ...request,
        tool_choice: request.tool_choice ?? 'auto',
        temperature: request.temperature ?? 0
      };

      onLog?.({
        scope: 'agent-loop',
        message: 'provider request options applied',
        data: {
          provider: context.model?.provider,
          model: context.model?.id,
          api: context.model?.api,
          toolsCount: Array.isArray(request.tools) ? request.tools.length : 0,
          toolChoice: nextPayload.tool_choice,
          temperature: nextPayload.temperature,
          hadToolChoice,
          hadTemperature
        }
      });

      return nextPayload;
    });
  };
}

function shouldApplyOpenAiToolOptions(payload: unknown, model?: { api?: string }) {
  if (model?.api !== 'openai-completions') return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  const request = payload as Record<string, unknown>;
  return Array.isArray(request.messages) && Array.isArray(request.tools) && request.tools.length > 0;
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
