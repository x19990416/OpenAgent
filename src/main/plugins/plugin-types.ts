import type { RuntimeTool, RuntimeUiEvent } from '../runtime/runtime-types.js';

export type PluginInstallState = 'discovered' | 'installed' | 'needs_config' | 'needs_auth' | 'ready' | 'enabled' | 'disabled' | 'error' | 'loaded';
export type PluginCapability = 'channel' | 'tools' | 'skills' | 'knowledge' | 'remote_ui' | 'settings' | 'policy';
export type PluginRiskLevel = 'read' | 'external_send' | 'external_write' | 'destructive' | 'secret_access';

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  [key: string]: unknown;
}

export interface PluginManifest {
  schemaVersion?: string;
  entrySha256?: string;
  trustedSha256?: string;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  capabilities?: PluginCapability[];
  configSchema?: JsonSchemaObject;
  secretSchema?: JsonSchemaObject;
  tools?: Array<{ name: string; description?: string; risk?: PluginRiskLevel }>;
  skills?: Array<{ name: string; description?: string; path?: string; content?: string }>;
  agents?: PluginProvidedAgent[];
  mcpServers?: Array<{ name: string; command?: string }>;
  runtimeDependencies?: Array<{ id: string; type: 'npm' | 'cli'; packageName: string; binary?: string; version?: string; description?: string }>;
  interface?: { displayName?: string; description?: string; category?: string; brandColor?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PluginRegistrySnapshot {
  schemaVersion: number;
  pluginsRoot: string;
  lastDiscoveredAt: string | null;
  lastLoadedAt: string | null;
  plugins: PluginRecord[];
}

export interface PluginRecord {
  id: string;
  name: string;
  enabled: boolean;
  status: PluginInstallState | string;
  rootPath?: string;
  manifestPath?: string;
  discoveredAt?: string;
  lastLoadedAt?: string;
  lastTestedAt?: string;
  lastError?: string;
  validationErrors?: string[];
  configured?: boolean;
  authorized?: boolean;
  capabilities: Record<string, boolean>;
  manifest: PluginManifest;
  skills: Array<{ name: string; description?: string; path?: string; content?: string; rootDir?: string }>;
  mcpServers: Array<{ name: string; command?: string }>;
  tools: Array<{ name: string; description?: string; risk?: PluginRiskLevel }>;
  policy: PluginToolPolicy[];
  source: 'builtin' | 'first_party' | 'local';
  installed?: boolean;
}

export interface PluginToolPolicy {
  toolName: string;
  risk: PluginRiskLevel;
  requiresApproval: boolean;
  description?: string;
}

export interface PluginProvidedAgent {
  id: string;
  name: string;
  description?: string;
  tools?: string[];
  routingHints?: string[];
  constraints?: string[];
}

export interface PluginStateFile {
  schemaVersion: number;
  pluginsRoot?: string;
  enabled?: Record<string, boolean>;
  capabilityOverrides?: Record<string, Record<string, boolean>>;
  installedLocalManifests?: string[];
  config?: Record<string, Record<string, unknown>>;
}

export interface OpenAgentPlugin {
  id: string;
  name: string;
  register(ctx: OpenAgentPluginContext): Promise<void> | void;
}

export interface PluginSkill {
  id?: string;
  name: string;
  description?: string;
  content?: string;
  path?: string;
  rootDir?: string;
}

export interface OpenAgentChannel {
  id: string;
  type: string;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface PluginKnowledgeProvider {
  id: string;
  displayName: string;
  [key: string]: unknown;
}

export interface RemoteUiRenderer {
  id: string;
  channelType?: string;
  render?(event: RuntimeUiEvent, context?: unknown): Promise<void> | void;
}

export interface PluginPolicy {
  tools?: PluginToolPolicy[];
  [key: string]: unknown;
}

export interface PluginLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export type PluginRuntimeSubmit = (input: unknown) => Promise<unknown>;
export type PluginEventSubscribe = (listener: (event: RuntimeUiEvent) => void) => () => void;

export interface OpenAgentPluginContext {
  pluginId: string;
  registerChannel(channel: OpenAgentChannel): void;
  registerTool(tool: RuntimeTool): void;
  registerSkill(skill: PluginSkill): void;
  registerKnowledgeProvider(provider: PluginKnowledgeProvider): void;
  registerRemoteUi(renderer: RemoteUiRenderer): void;
  registerPolicy(policy: PluginPolicy): void;
  runtime: {
    submitPrompt(input: unknown): Promise<unknown>;
  };
  events: {
    subscribe(listener: (event: RuntimeUiEvent) => void): () => void;
  };
  config: {
    get<T = unknown>(key: string): Promise<T | null>;
    set<T = unknown>(key: string, value: T): Promise<void>;
  };
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  logger: PluginLogger;
}

export interface PluginRegistrationResult {
  channels: OpenAgentChannel[];
  tools: RuntimeTool[];
  skills: PluginSkill[];
  knowledgeProviders: PluginKnowledgeProvider[];
  remoteUiRenderers: RemoteUiRenderer[];
  policies: PluginPolicy[];
}
