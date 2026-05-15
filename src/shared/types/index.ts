import type { MessageItem, UiEvent, WorkspaceMeta } from './events';
export type { WorkspaceMeta } from './events';

export type LlmAuthType = string;
export type LlmProviderKind = string;

export interface LlmModelConfig {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Array<{ value: string; label?: string }>;
  [key: string]: unknown;
}

export interface LlmProviderConfig {
  id: string;
  name: string;
  kind: LlmProviderKind;
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  authType?: LlmAuthType;
  auth?: { type?: string; headerName?: string; apiKey?: string; secret?: string; maskedSecret?: string; configured?: boolean; [key: string]: unknown };
  invocationMode?: 'responses' | 'chat-completions' | string;
  defaultModel: string;
  models: LlmModelConfig[];
  [key: string]: unknown;
}

export interface LlmProviderCatalog {
  activeProviderId: string;
  providers: LlmProviderConfig[];
  [key: string]: unknown;
}

export interface LlmProviderKindDefinition {
  kind: LlmProviderKind;
  label: string;
  description?: string;
  defaultBaseUrl?: string;
  supportedAuthTypes?: LlmAuthType[];
  authTypes?: LlmAuthType[];
  invocationMode?: 'responses' | 'chat-completions' | string;
  defaultInvocationMode?: 'responses' | 'chat-completions' | string;
  [key: string]: unknown;
}

export interface UpsertLlmProviderInput extends Partial<LlmProviderConfig> {
  id?: string;
  name: string;
}

export interface PromptAttachmentDescriptor {
  id: string;
  path: string;
  name: string;
  kind: 'image' | 'text' | 'file' | 'binary';
  size: number;
  mimeType?: string;
  originalMimeType?: string;
  textContent?: string;
  imageDataUrl?: string;
  dataUrl?: string;
  originalDataUrl?: string;
  [key: string]: unknown;
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  displayName: string;
  description: string;
  sourceLabel?: string;
  [key: string]: unknown;
}

export interface PromptSubmission {
  prompt: string;
  attachments?: PromptAttachmentDescriptor[];
  skillId?: string | null;
}

export interface PromptSubmissionResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface KnowledgeResult {
  id: string;
  title: string;
  source: 'openagent-system-compiler' | string;
  content: string;
  score?: number;
  path?: string;
  citations?: string[];
}

export interface KnowledgeHealthResult {
  ok: boolean;
  source: 'openagent-system-compiler' | string;
  message: string;
  data?: unknown;
}

export interface KnowledgeIngestResult {
  ok: boolean;
  source: 'openagent-system-compiler' | string;
  id?: string;
  path?: string;
  message: string;
}

export interface KnowledgeLintResult {
  ok: boolean;
  source: 'openagent-system-compiler' | string;
  message: string;
  reportPath?: string;
  data?: unknown;
}

export interface KnowledgeGraphResult {
  ok: boolean;
  source: 'openagent-system-compiler' | string;
  message: string;
  graphJsonPath?: string;
  graphHtmlPath?: string;
  data?: {
    built?: string;
    nodes?: Array<{ id: string; label: string; path: string }>;
    edges?: Array<{ from: string; to: string; type: string }>;
    [key: string]: unknown;
  };
}

export interface KnowledgeCompileResult {
  ok: boolean;
  source: 'openagent-system-compiler' | string;
  message: string;
  compiled: number;
  skipped: number;
  failed: number;
  articlePaths?: string[];
  data?: unknown;
}

export interface KnowledgeQualityReport {
  sourceId: string;
  title: string;
  score: number;
  grade: string;
  issues: string[];
  metrics: Record<string, number>;
  generatedAt: string;
}

export interface KnowledgeSourceListItem {
  id: string;
  title: string;
  kind: string;
  status?: string;
  tier?: number;
  rawTextPath?: string;
  createdAt: string;
  updatedAt: string;
  articleIds?: string[];
  quality?: KnowledgeQualityReport;
}

export interface KnowledgeArticleListItem {
  id: string;
  conceptId: string;
  title: string;
  path: string;
  sourceIds: string[];
  updatedAt: string;
}

export interface KnowledgeBrowseSnapshot {
  provider: { id: string; displayName: string; rootPath?: string; [key: string]: unknown };
  root: string;
  sources: KnowledgeSourceListItem[];
  articles: KnowledgeArticleListItem[];
  pending: KnowledgeSourceListItem[];
  quality: KnowledgeQualityReport[];
}

export interface KnowledgeArticleReadResult {
  ok: boolean;
  source: 'openagent-system-compiler' | string;
  articleId: string;
  title?: string;
  path?: string;
  content?: string;
  message?: string;
}

export interface PluginRegistrySnapshot {
  schemaVersion?: number;
  pluginsRoot?: string;
  plugins: Array<{
    name: string;
    enabled: boolean;
    status: 'discovered' | 'installed' | 'needs_config' | 'needs_auth' | 'ready' | 'enabled' | 'loaded' | 'disabled' | 'error' | string;
    rootPath?: string;
    manifestPath?: string;
    discoveredAt?: string;
    lastLoadedAt?: string;
    lastError?: string;
    configured?: boolean;
    authorized?: boolean;
    capabilities?: Record<string, boolean>;
    tools?: Array<{ name: string; description?: string; risk?: string; [key: string]: unknown }>;
    policy?: Array<{ toolName: string; risk: string; requiresApproval: boolean; description?: string; [key: string]: unknown }>;
    source?: 'builtin' | 'local' | string;
    manifest: {
      id?: string;
      name?: string;
      version?: string;
      description?: string;
      interface?: { displayName?: string; description?: string; category?: string; brandColor?: string; [key: string]: unknown };
      skills?: Array<{ name: string; description?: string; [key: string]: unknown }>;
      mcpServers?: Array<{ name: string; command?: string; [key: string]: unknown }>;
      capabilities?: string[];
      configSchema?: { properties?: Record<string, { type?: string; default?: unknown; enum?: unknown[]; [key: string]: unknown }>; required?: string[]; [key: string]: unknown };
      secretSchema?: { properties?: Record<string, { type?: string; [key: string]: unknown }>; [key: string]: unknown };
      runtimeDependencies?: Array<{ id: string; type: string; packageName: string; binary?: string; version?: string; description?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    skills?: Array<{ name: string; description?: string; [key: string]: unknown }>;
    mcpServers?: Array<{ name: string; command?: string; [key: string]: unknown }>;
    error?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface SoulChangeProposal {
  id: string;
  agentId: string;
  title: string;
  reason: string;
  targetSection: string;
  currentText?: string;
  proposedText: string;
  ruleId?: string;
  diff: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'pending_approval' | 'approved' | 'rejected' | 'applied';
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  rejectedAt?: string;
  source?: {
    kind: 'explicit_user_request' | 'manual' | 'runtime_detection';
    runId?: string;
    threadId?: string;
    excerpt?: string;
  };
}


export type ScheduledTaskFrequency = 'once' | 'interval' | 'daily';
export type ScheduledTaskStatus = 'active' | 'paused';
export type ScheduledTaskRunStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export type ScheduledTaskSessionPolicy = 'new_each_run' | 'reuse_existing';

export interface ScheduledTaskItem {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
  sessionPolicy: ScheduledTaskSessionPolicy;
  threadId?: string | null;
  frequency: ScheduledTaskFrequency;
  status: ScheduledTaskStatus;
  runAt?: string;
  intervalMinutes?: number;
  timeOfDay?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduledTaskRunStatus;
  lastRunSummary?: string | null;
  lastRunThreadId?: string | null;
}

export interface CreateScheduledTaskInput {
  title?: string;
  prompt: string;
  agentId?: string;
  sessionPolicy?: ScheduledTaskSessionPolicy;
  threadId?: string | null;
  frequency: ScheduledTaskFrequency;
  runAt?: string;
  intervalMinutes?: number;
  timeOfDay?: string;
  enabled?: boolean;
}

export interface WechatOfficialAccountPluginConfig {
  appId?: string;
  appSecret?: string;
  apiBase?: string;
  author?: string;
  digest?: string | null;
  updatedAt?: string;
  wechat?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionExportInput {
  format: 'pdf' | 'png';
  title?: string;
  html: string;
  suggestedName?: string;
}

export interface SessionExportResult {
  ok: boolean;
  cancelled?: boolean;
  path?: string;
  error?: string;
}

export interface StateSnapshot {
  activeAgentId: string;
  latestRun?: { status: string; summary?: string | null } | null;
  pendingApproval?: {
    approvalId: string;
    title: string;
    risk?: 'low' | 'medium' | 'high';
    actionType: string;
    description?: string;
    targetPath?: string;
    access?: 'read' | 'write' | 'execute';
    recursive?: boolean;
    scope?: 'once' | 'session' | 'always';
    payloadPreview: string;
  } | null;
  threads: Array<{
    threadId: string;
    agentId: string;
    workspaceRoot: string;
    workspaceName: string;
    branch: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
    runCount: number;
  }>;
  recentRuns: Array<{
    runId: string;
    threadId: string;
    prompt: string;
    currentAgent: string;
    status: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
    startedAt: string;
    updatedAt: string;
    endedAt: string | null;
    summary: string | null;
  }>;
  messages: MessageItem[];
  activeThread?: { threadId: string } | null;
}

export interface DesktopApi {
  getWorkspaceMeta: () => Promise<WorkspaceMeta>;
  getActiveAgentBootstrap: () => Promise<any>;
  listSoulProposals?: (payload?: { status?: SoulChangeProposal['status'] }) => Promise<SoulChangeProposal[]>;
  createSoulProposal?: (payload: { title?: string; reason?: string; targetSection?: string; proposedText: string; riskLevel?: SoulChangeProposal['riskLevel'] }) => Promise<any>;
  approveSoulProposal?: (payload: { proposalId: string }) => Promise<any>;
  rejectSoulProposal?: (payload: { proposalId: string }) => Promise<any>;
  listAgents: () => Promise<any>;
  getStateSnapshot: () => Promise<StateSnapshot>;
  getRuntimeTasks?: () => Promise<any[]>;
  getKnowledgeHealth?: (payload?: { scope?: 'system' }) => Promise<KnowledgeHealthResult[]>;
  queryKnowledge?: (payload: { query: string; limit?: number }) => Promise<KnowledgeResult[]>;
  ingestKnowledge?: (payload: { title: string; content: string; sourceId?: string; tags?: string[] }) => Promise<KnowledgeIngestResult>;
  chooseAndIngestKnowledgeFiles?: () => Promise<{ ok: boolean; cancelled?: boolean; error?: string; results: KnowledgeIngestResult[] }>;
  lintKnowledge?: () => Promise<KnowledgeLintResult>;
  buildKnowledgeGraph?: () => Promise<KnowledgeGraphResult>;
  browseKnowledge?: () => Promise<KnowledgeBrowseSnapshot>;
  readKnowledgeArticle?: (payload: { articleId: string }) => Promise<KnowledgeArticleReadResult>;
  compileKnowledge?: (payload?: { sourceIds?: string[]; limit?: number; tier?: 0 | 1 | 2 | 3 }) => Promise<KnowledgeCompileResult>;
  listScheduledTasks?: () => Promise<ScheduledTaskItem[]>;
  createScheduledTask?: (payload: CreateScheduledTaskInput) => Promise<ScheduledTaskItem>;
  deleteScheduledTask?: (payload: { taskId: string }) => Promise<{ ok: boolean; error?: string }>;
  setScheduledTaskEnabled?: (payload: { taskId: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string; task?: ScheduledTaskItem }>;
  runScheduledTaskNow?: (payload: { taskId: string }) => Promise<{ ok: boolean; error?: string; task?: ScheduledTaskItem }>;
  onUiEvent: (handler: (event: UiEvent) => void) => () => void;
  sendPrompt: (payload: PromptSubmission) => Promise<PromptSubmissionResult>;
  stopRun: (payload?: { runId?: string }) => Promise<any>;
  createAgent: (payload: any) => Promise<any>;
  setActiveAgent: (payload: any) => Promise<any>;
  createThread: () => Promise<any>;
  selectThread: (payload: any) => Promise<any>;
  compactThread?: (payload?: { threadId?: string }) => Promise<any>;
  exportSession?: (payload: SessionExportInput) => Promise<SessionExportResult>;
  deleteThread: (payload: any) => Promise<any>;
  resolveApproval: (payload: any) => Promise<any>;
  openPromptAttachment: (payload: any) => Promise<any>;
  getLlmProviderCatalog?: () => Promise<LlmProviderCatalog>;
  listLlmProviders?: () => Promise<LlmProviderCatalog>;
  listLlmProviderKinds?: () => Promise<LlmProviderKindDefinition[]>;
  getLlmProviderDefinitions?: () => Promise<LlmProviderKindDefinition[]>;
  updateLlmProviderModels?: (payload: any) => Promise<any>;
  refreshLlmProviderModels?: (payload: any) => Promise<any>;
  discoverLlmModels?: (payload: any) => Promise<any>;
  openPiCodexLogin?: () => Promise<any>;
  upsertLlmProvider?: (payload: any) => Promise<any>;
  clearLlmProviderApiKey?: (payload: any) => Promise<any>;
  deleteLlmProvider?: (payload: any) => Promise<any>;
  setActiveLlmProvider?: (payload: any) => Promise<any>;
  listSkills?: () => Promise<SkillCatalogItem[]>;
  getSkillCatalog?: () => Promise<SkillCatalogItem[]>;
  logDiagnostic?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void;
  discoverPlugins?: () => Promise<any>;
  discoverPluginsInDirectory?: (payload: any) => Promise<any>;
  loadPlugins?: (payload?: any) => Promise<any>;
  installLocalPlugin?: (payload: any) => Promise<any>;
  getPluginRegistry?: () => Promise<PluginRegistrySnapshot>;
  choosePluginDirectory?: () => Promise<any>;
  setPluginEnabled?: (payload: any) => Promise<any>;
  setPluginCapability?: (payload: any) => Promise<any>;
  testPlugin?: (payload: any) => Promise<any>;
  installPluginDependency?: (payload: any) => Promise<any>;
  authorizePlugin?: (payload: any) => Promise<any>;
  onPluginAuthorizationEvent?: (handler: (event: { pluginId?: string; authUrl?: string; message?: string }) => void) => () => void;
  getPluginConfig?: (payload: any) => Promise<any>;
  savePluginConfig?: (payload: any) => Promise<any>;
  setPluginSecret?: (payload: any) => Promise<any>;
}
