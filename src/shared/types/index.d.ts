import type { MessageItem, UiEvent, WorkspaceMeta } from './events';
export type { WorkspaceMeta } from './events';
export type LlmAuthType = string;
export type LlmProviderKind = string;
export interface LlmModelConfig {
    id: string;
    name: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    capabilities?: Array<{
        value: string;
        label?: string;
    }>;
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
    auth?: {
        type?: string;
        headerName?: string;
        apiKey?: string;
        secret?: string;
        maskedSecret?: string;
        configured?: boolean;
        [key: string]: unknown;
    };
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
    textContent?: string;
    imageDataUrl?: string;
    dataUrl?: string;
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
export interface PluginRegistrySnapshot {
    schemaVersion?: number;
    pluginsRoot?: string;
    plugins: Array<{
        name: string;
        enabled: boolean;
        status: 'discovered' | 'loaded' | 'disabled' | 'error' | string;
        rootPath?: string;
        manifestPath?: string;
        discoveredAt?: string;
        lastLoadedAt?: string;
        lastError?: string;
        manifest: {
            version?: string;
            description?: string;
            interface?: {
                displayName?: string;
                description?: string;
                category?: string;
                brandColor?: string;
                [key: string]: unknown;
            };
            skills?: Array<{
                name: string;
                description?: string;
                [key: string]: unknown;
            }>;
            mcpServers?: Array<{
                name: string;
                command?: string;
                [key: string]: unknown;
            }>;
            [key: string]: unknown;
        };
        skills?: Array<{
            name: string;
            description?: string;
            [key: string]: unknown;
        }>;
        mcpServers?: Array<{
            name: string;
            command?: string;
            [key: string]: unknown;
        }>;
        error?: string;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
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
export interface StateSnapshot {
    activeAgentId: string;
    latestRun?: {
        status: string;
        summary?: string | null;
    } | null;
    pendingApproval?: {
        approvalId: string;
        title: string;
        actionType: string;
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
    activeThread?: {
        threadId: string;
    } | null;
}
export interface DesktopApi {
    getWorkspaceMeta: () => Promise<WorkspaceMeta>;
    getActiveAgentBootstrap: () => Promise<any>;
    listAgents: () => Promise<any>;
    getStateSnapshot: () => Promise<StateSnapshot>;
    getRuntimeTasks?: () => Promise<any[]>;
    onUiEvent: (handler: (event: UiEvent) => void) => () => void;
    sendPrompt: (payload: PromptSubmission) => Promise<PromptSubmissionResult>;
    stopRun: (payload?: {
        runId?: string;
    }) => Promise<any>;
    createAgent: (payload: any) => Promise<any>;
    setActiveAgent: (payload: any) => Promise<any>;
    createThread: () => Promise<any>;
    selectThread: (payload: any) => Promise<any>;
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
    upsertLlmProvider?: (payload: any) => Promise<any>;
    setActiveLlmProvider?: (payload: any) => Promise<any>;
    listSkills?: () => Promise<SkillCatalogItem[]>;
    getSkillCatalog?: () => Promise<SkillCatalogItem[]>;
    logDiagnostic?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void;
    discoverPlugins?: () => Promise<any>;
    discoverPluginsInDirectory?: (payload: any) => Promise<any>;
    loadPlugins?: (payload?: any) => Promise<any>;
    getPluginRegistry?: () => Promise<PluginRegistrySnapshot>;
    choosePluginDirectory?: () => Promise<any>;
    setPluginEnabled?: (payload: any) => Promise<any>;
    getPluginConfig?: (payload: any) => Promise<any>;
    savePluginConfig?: (payload: any) => Promise<any>;
}
