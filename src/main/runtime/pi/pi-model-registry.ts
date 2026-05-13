import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';

export interface PiModelCatalogItem {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Array<{ value: string; label: string }>;
}

interface OpenAgentLlmModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Array<{ value: string; label?: string }>;
}

interface OpenAgentUpsertLlmProviderInput {
  id?: string;
  providerId?: string;
  name?: string;
  kind?: string;
  invocationMode?: string;
  baseUrl?: string;
  authType?: string;
  auth?: { type?: string; headerName?: string; secret?: string };
  defaultModel?: string;
  models?: OpenAgentLlmModelConfig[];
}

export interface PiProviderCatalogItem {
  id: string;
  name: string;
  kind: 'pi-provider' | 'openai-compatible';
  invocationMode: 'pi-agent-session' | 'chat-completions' | 'responses';
  baseUrl?: string;
  defaultModel: string;
  enabled: boolean;
  auth: { type: 'api_key'; configured: boolean; maskedSecret?: string; secret?: string };
  models: PiModelCatalogItem[];
}

export interface PiModelContext {
  authStorage: ReturnType<typeof AuthStorage.create>;
  modelRegistry: ReturnType<typeof ModelRegistry.create>;
  selectedModel: any;
  providerId: string;
  modelId: string;
}

export interface OpenAgentPiModelConfig {
  activeProviderId: string;
  activeModelId: string;
  updatedAt: string;
}

interface PiModelsJson {
  providers?: Record<string, PiModelsJsonProvider>;
}

interface PiModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: Array<'text' | 'image'>;
    contextWindow?: number;
    maxTokens?: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
  modelOverrides?: Record<string, Partial<{
    name: string;
    reasoning: boolean;
    input: Array<'text' | 'image'>;
    contextWindow: number;
    maxTokens: number;
  }>>;
}

const DEFAULT_CONFIG: OpenAgentPiModelConfig = {
  activeProviderId: 'openai',
  activeModelId: 'gpt-4.1-mini',
  updatedAt: new Date(0).toISOString()
};

const OPENAGENT_BUILT_IN_PROVIDER_IDS = new Set(['openai', 'openai-codex', 'anthropic', 'google', 'mistral', 'deepseek', 'openrouter']);

export function getOpenAgentPiModelConfig(): OpenAgentPiModelConfig {
  const configPath = getOpenAgentPiModelConfigPath();
  if (!existsSync(configPath)) {
    writeOpenAgentPiModelConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const config = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, 'utf8')) as Partial<OpenAgentPiModelConfig>) };
    return isOpenAgentVisibleProviderId(config.activeProviderId) ? config : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function setOpenAgentPiModelConfig(input: { providerId: string; modelId: string }) {
  const nextConfig: OpenAgentPiModelConfig = {
    activeProviderId: input.providerId,
    activeModelId: input.modelId,
    updatedAt: new Date().toISOString()
  };
  writeOpenAgentPiModelConfig(nextConfig);
  return nextConfig;
}

export function saveOpenAgentPiProviderApiKey(input: { providerId: string; apiKey: string }) {
  const authStorage = createOpenAgentAuthStorage();
  authStorage.set(input.providerId, { type: 'api_key', key: input.apiKey });
  return { ok: true, authPath: 'pi-default-auth' };
}

export function clearOpenAgentPiProviderApiKey(input: { providerId: string }) {
  const providerId = normalizeProviderId(input.providerId);

  if (!providerId) {
    throw new Error('Provider id is required.');
  }

  const authStorage = createOpenAgentAuthStorage();
  authStorage.remove(providerId);

  if (isCustomProviderId(providerId)) {
    const modelsJson = readOpenAgentPiModelsJson();
    const existingProvider = modelsJson.providers?.[providerId];

    if (existingProvider) {
      const { apiKey: _apiKey, headers: _headers, ...providerWithoutSecret } = existingProvider;
      modelsJson.providers = {
        ...(modelsJson.providers ?? {}),
        [providerId]: providerWithoutSecret
      };
      writeOpenAgentPiModelsJson(modelsJson);
    }
  }

  return {
    ok: true,
    providerId,
    modelsPath: getOpenAgentPiModelsPath()
  };
}

export function deleteOpenAgentPiProvider(input: { providerId: string }) {
  const providerId = normalizeProviderId(input.providerId);

  if (!providerId) {
    throw new Error('Provider id is required.');
  }

  if (!isCustomProviderId(providerId)) {
    throw new Error('Only custom providers can be deleted.');
  }

  const authStorage = createOpenAgentAuthStorage();
  authStorage.remove(providerId);

  const modelsJson = readOpenAgentPiModelsJson();
  if (modelsJson.providers?.[providerId]) {
    const { [providerId]: _deletedProvider, ...nextProviders } = modelsJson.providers;
    writeOpenAgentPiModelsJson({ providers: nextProviders });
  }

  return {
    ok: true,
    providerId,
    modelsPath: getOpenAgentPiModelsPath()
  };
}

export async function loginOpenAgentPiOAuthProvider(input: {
  providerId: string;
  onAuth: (info: { url: string; instructions?: string }) => void | Promise<void>;
  onProgress?: (message: string) => void;
}) {
  const authStorage = createOpenAgentAuthStorage();

  await authStorage.login(input.providerId as Parameters<typeof authStorage.login>[0], {
    onAuth: input.onAuth,
    onPrompt: async (prompt) => {
      if (prompt.allowEmpty) {
        return '';
      }

      throw new Error(`OAuth 登录需要手动输入：${prompt.message}`);
    },
    onProgress: input.onProgress
  });

  return { ok: true, authPath: 'pi-default-auth' };
}

export function upsertOpenAgentPiProvider(input: OpenAgentUpsertLlmProviderInput) {
  const providerId = normalizeProviderId(String(input.providerId || input.id || input.kind || input.name));
  const models = normalizeModelInputs(input.models ?? []);
  const defaultModel = String(input.defaultModel || models[0]?.id || '');
  const apiKey = typeof input.auth?.secret === 'string' ? input.auth.secret.trim() : '';

  if (!providerId) {
    throw new Error('Provider id is required.');
  }

  if (apiKey) {
    saveOpenAgentPiProviderApiKey({ providerId, apiKey });
  }

  if (isCustomProviderId(providerId)) {
    writeOpenAgentPiModelsJsonProvider(providerId, input, models, apiKey);
  }

  if (defaultModel) {
    setOpenAgentPiModelConfig({ providerId, modelId: defaultModel });
  }

  return {
    ok: true,
    providerId,
    modelId: defaultModel,
    authPath: 'pi-default-auth',
    modelsPath: getOpenAgentPiModelsPath(),
    configPath: getOpenAgentPiModelConfigPath()
  };
}

export function updateOpenAgentPiProviderModels(input: {
  providerId: string;
  defaultModel?: string;
  models: OpenAgentLlmModelConfig[];
}) {
  const providerId = normalizeProviderId(input.providerId);
  const models = normalizeModelInputs(input.models);
  const defaultModel = String(input.defaultModel || models[0]?.id || '');

  if (!providerId) {
    throw new Error('Provider id is required.');
  }

  const modelsJson = readOpenAgentPiModelsJson();
  const existingProvider = modelsJson.providers?.[providerId];

  if (isCustomProviderId(providerId)) {
    modelsJson.providers = {
      ...(modelsJson.providers ?? {}),
      [providerId]: {
        ...existingProvider,
        baseUrl: existingProvider?.baseUrl || 'https://api.openai.com/v1',
        api: existingProvider?.api || 'openai-completions',
        apiKey: existingProvider?.apiKey || `OPENAGENT_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
        authHeader: existingProvider?.authHeader ?? true,
        models: models.map(toPiModelDefinition)
      }
    };
    writeOpenAgentPiModelsJson(modelsJson);
  }

  if (defaultModel) {
    setOpenAgentPiModelConfig({ providerId, modelId: defaultModel });
  }

  return {
    ok: true,
    providerId,
    modelId: defaultModel,
    modelsPath: getOpenAgentPiModelsPath(),
    configPath: getOpenAgentPiModelConfigPath()
  };
}

export async function discoverOpenAgentPiModels(input: {
  providerId?: string;
  kind?: string;
  baseUrl?: string;
  auth?: { type?: string; secret?: string; headerName?: string };
}) {
  const baseUrl = String(input.baseUrl || '').trim();
  const secret = String(input.auth?.secret || '').trim();
  const providerId = normalizeProviderId(String(input.providerId || input.kind || ''));
  const providerCheckBaseUrl = resolveProviderCheckBaseUrl(providerId);

  if (baseUrl || (secret && providerCheckBaseUrl)) {
    return discoverOpenAiCompatibleModels({
      baseUrl: baseUrl || providerCheckBaseUrl,
      apiKey: secret,
      authType: String(input.auth?.type || 'bearer'),
      headerName: String(input.auth?.headerName || 'Authorization')
    });
  }

  const catalog = await buildPiProviderCatalog({ activeProviderId: providerId });
  const provider = catalog.providers.find((item) => item.id === providerId);
  return {
    ok: true,
    models: provider?.models ?? [],
    requestUrl: `pi://model-registry/${providerId}`
  };
}

export function createPiModelContext(input: { providerId: string; modelId: string }): PiModelContext {
  const authStorage = createOpenAgentAuthStorage();
  applyRuntimeApiKeys(authStorage, input.providerId);
  const modelRegistry = createOpenAgentModelRegistry(authStorage);
  const selectedModel = selectPiModel(modelRegistry, input.providerId, input.modelId);

  if (!selectedModel) {
    throw new Error(`Model registry cannot find model: ${input.providerId}/${input.modelId}`);
  }

  return {
    authStorage,
    modelRegistry,
    selectedModel,
    providerId: selectedModel.provider,
    modelId: selectedModel.id
  };
}

export async function buildPiProviderCatalog(input?: { activeProviderId?: string; activeModelId?: string }) {
  const activeConfig = getOpenAgentPiModelConfig();
  const requestedActiveProviderId = input?.activeProviderId || activeConfig.activeProviderId;
  const activeProviderId = isOpenAgentVisibleProviderId(requestedActiveProviderId) ? requestedActiveProviderId : DEFAULT_CONFIG.activeProviderId;
  const activeModelId = input?.activeModelId || activeConfig.activeModelId;
  const authStorage = createOpenAgentAuthStorage();
  applyRuntimeApiKeys(authStorage, activeProviderId);
  const modelRegistry = createOpenAgentModelRegistry(authStorage);
  const modelsJson = readOpenAgentPiModelsJson();
  const allModels = modelRegistry.getAll();
  const byProvider = new Map<string, any[]>();

  for (const model of allModels) {
    const providerModels = byProvider.get(model.provider) ?? [];
    providerModels.push(model);
    byProvider.set(model.provider, providerModels);
  }

  const providers: PiProviderCatalogItem[] = [...byProvider.entries()]
    .filter(([providerId]) => isOpenAgentVisibleProviderId(providerId))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([providerId, models]) => {
      const isBuiltInProvider = OPENAGENT_BUILT_IN_PROVIDER_IDS.has(providerId);
      const providerConfig = isBuiltInProvider ? undefined : modelsJson.providers?.[providerId];
      const sortedModels = models.sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
      const defaultModel =
        providerId === activeProviderId && sortedModels.some((model) => model.id === activeModelId)
          ? activeModelId
          : String(sortedModels[0]?.id ?? '');
      const configured = providerId === 'openai-codex'
        ? authStorage.get(providerId)?.type === 'oauth'
        : authStorage.hasAuth(providerId) || Boolean(providerConfig?.apiKey);
      const authSecret = isBuiltInProvider ? extractAuthSecret(authStorage.get(providerId)) : providerConfig?.apiKey;

      return {
        id: providerId,
        name: providerConfig?.name || formatProviderName(providerId),
        kind: isBuiltInProvider ? 'pi-provider' : 'openai-compatible',
        invocationMode: isBuiltInProvider ? 'pi-agent-session' : resolveCatalogInvocationMode(providerConfig?.api),
        baseUrl: providerConfig?.baseUrl,
        defaultModel,
        enabled: configured || providerId === activeProviderId,
        auth: {
          type: 'api_key',
          configured,
          maskedSecret: configured ? '••••••••' : undefined,
          secret: authSecret
        },
        models: sortedModels.map((model) => ({
          id: String(model.id),
          name: String(model.name ?? model.id),
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens ?? model.maxTokens,
          capabilities: [
            ...(Array.isArray(model.input) ? model.input.map((value) => ({ value: String(value), label: String(value) })) : []),
            ...(model.reasoning ? [{ value: 'reasoning', label: 'Reasoning' }] : [])
          ]
        }))
      };
    });

  return {
    activeProviderId,
    providers
  };
}

export function getOpenAgentPiModelConfigPath() {
  return path.join(getOpenAgentSettingsDir(), 'pi-model-config.json');
}

function writeOpenAgentPiModelConfig(config: OpenAgentPiModelConfig) {
  writeFileSync(getOpenAgentPiModelConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function createOpenAgentAuthStorage() {
  return AuthStorage.create();
}

function createOpenAgentModelRegistry(authStorage: ReturnType<typeof AuthStorage.create>) {
  const settingsDir = getOpenAgentSettingsDir();
  return ModelRegistry.create(authStorage, getOpenAgentPiModelsPath());
}

function selectPiModel(modelRegistry: ReturnType<typeof ModelRegistry.create>, providerId: string, modelId: string) {
  const exact = modelRegistry.find(providerId, modelId);
  if (exact) return exact;
  return modelRegistry.getAll().find((model) => model.id === modelId) ?? null;
}

function applyRuntimeApiKeys(authStorage: ReturnType<typeof AuthStorage.create>, activeProviderId: string) {
  const providerKeyEnv = process.env.OPENAGENT_API_KEY;
  if (providerKeyEnv) {
    authStorage.setRuntimeApiKey(activeProviderId, providerKeyEnv);
  }

  const mappings: Array<[string, string | undefined]> = [
    ['openai', process.env.OPENAI_API_KEY],
    ['anthropic', process.env.ANTHROPIC_API_KEY],
    ['google', process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY],
    ['mistral', process.env.MISTRAL_API_KEY],
    ['deepseek', process.env.DEEPSEEK_API_KEY],
    ['xai', process.env.XAI_API_KEY],
    ['openrouter', process.env.OPENROUTER_API_KEY]
  ];

  for (const [provider, apiKey] of mappings) {
    if (apiKey) {
      authStorage.setRuntimeApiKey(provider, apiKey);
    }
  }
}

function getOpenAgentSettingsDir() {
  const settingsDir = path.join(os.homedir(), '.openagent', 'settings');
  mkdirSync(settingsDir, { recursive: true });
  return settingsDir;
}

function getOpenAgentPiModelsPath() {
  return path.join(getOpenAgentSettingsDir(), 'pi-models.json');
}

function readOpenAgentPiModelsJson(): PiModelsJson {
  const modelsPath = getOpenAgentPiModelsPath();

  if (!existsSync(modelsPath)) {
    return { providers: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(modelsPath, 'utf8')) as PiModelsJson;
    return {
      providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {}
    };
  } catch {
    return { providers: {} };
  }
}

function writeOpenAgentPiModelsJson(config: PiModelsJson) {
  writeFileSync(getOpenAgentPiModelsPath(), `${JSON.stringify({ providers: config.providers ?? {} }, null, 2)}\n`, 'utf8');
}

function writeOpenAgentPiModelsJsonProvider(
  providerId: string,
  input: OpenAgentUpsertLlmProviderInput,
  models: OpenAgentLlmModelConfig[],
  apiKey: string
) {
  const modelsJson = readOpenAgentPiModelsJson();
  const existingProvider = modelsJson.providers?.[providerId];
  const authType = String(input.auth?.type || input.authType || 'bearer');
  const headerName = String(input.auth?.headerName || 'Authorization').trim() || 'Authorization';
  const apiKeyFallback = apiKey || existingProvider?.apiKey || `OPENAGENT_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const headers =
    authType === 'api_key_header' && headerName !== 'Authorization'
      ? { [headerName]: apiKeyFallback }
      : existingProvider?.headers;

  modelsJson.providers = {
    ...(modelsJson.providers ?? {}),
    [providerId]: {
      ...existingProvider,
      name: String(input.name || existingProvider?.name || formatProviderName(providerId)).trim(),
      baseUrl: String(input.baseUrl || existingProvider?.baseUrl || '').trim() || 'https://api.openai.com/v1',
      api: resolvePiApi(String(input.invocationMode || 'pi-agent-session'), String(input.kind || 'openai-compatible')),
      apiKey: apiKeyFallback,
      authHeader: authType !== 'none' && (authType !== 'api_key_header' || headerName === 'Authorization'),
      ...(headers ? { headers } : {}),
      models: models.length > 0 ? models.map(toPiModelDefinition) : existingProvider?.models ?? []
    }
  };

  writeOpenAgentPiModelsJson(modelsJson);
}

function normalizeModelInputs(models: OpenAgentLlmModelConfig[]) {
  const seen = new Set<string>();
  const normalized: OpenAgentLlmModelConfig[] = [];

  for (const model of models) {
    const id = String(model.id || model.name || '').trim();

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push({
      id,
      name: String(model.name || id),
      contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
      maxOutputTokens: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : undefined,
      capabilities: model.capabilities
    });
  }

  return normalized;
}

function toPiModelDefinition(model: OpenAgentLlmModelConfig) {
  const capabilities = new Set((model.capabilities ?? []).map((capability) => String(capability.value)));
  return {
    id: model.id,
    name: model.name || model.id,
    reasoning: capabilities.has('reasoning'),
    input: capabilities.has('vision') ? (['text', 'image'] as Array<'text' | 'image'>) : (['text'] as Array<'text' | 'image'>),
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxOutputTokens ?? 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function resolvePiApi(invocationMode: string, kind: string) {
  if (kind === 'anthropic') return 'anthropic-messages';
  if (kind === 'google') return 'google-generative-ai';
  if (invocationMode === 'responses') return 'openai-responses';
  return 'openai-completions';
}

function resolveCatalogInvocationMode(api?: string): PiProviderCatalogItem['invocationMode'] {
  if (api === 'openai-responses') return 'responses';
  return 'chat-completions';
}

function resolveProviderCheckBaseUrl(providerId: string) {
  if (providerId === 'openai') return 'https://api.openai.com/v1';
  return '';
}

function extractAuthSecret(auth: unknown) {
  if (!auth || typeof auth !== 'object') return undefined;
  const candidate = auth as { key?: unknown; apiKey?: unknown; secret?: unknown };
  const secret = candidate.key ?? candidate.apiKey ?? candidate.secret;
  return typeof secret === 'string' && secret ? secret : undefined;
}

function normalizeProviderId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isCustomProviderId(providerId: string) {
  return !OPENAGENT_BUILT_IN_PROVIDER_IDS.has(providerId);
}

function isOpenAgentVisibleProviderId(providerId: string) {
  if (OPENAGENT_BUILT_IN_PROVIDER_IDS.has(providerId)) {
    return true;
  }

  const modelsJson = readOpenAgentPiModelsJson();
  return Boolean(modelsJson.providers?.[providerId]);
}

async function discoverOpenAiCompatibleModels(input: { baseUrl: string; apiKey: string; authType: string; headerName: string }) {
  const requestUrl = `${input.baseUrl.replace(/\/+$/g, '')}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (input.apiKey) {
    if (input.authType === 'api_key_header' && input.headerName && input.headerName !== 'Authorization') {
      headers[input.headerName] = input.apiKey;
    } else if (input.authType !== 'none') {
      headers.Authorization = `Bearer ${input.apiKey}`;
    }
  }

  const response = await fetch(requestUrl, { headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const providerMessage = parseModelDiscoveryErrorMessage(errorText);

    return {
      ok: false,
      models: [],
      requestUrl,
      error: providerMessage ? `${response.status} ${providerMessage}` : `${response.status} ${response.statusText}`
    };
  }

  const body = (await response.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> };
  const items = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const models = items
    .map((item) => {
      const id = String(item.id || item.name || '').trim();
      return id ? { id, name: String(item.name || id) } : null;
    })
    .filter((item): item is { id: string; name: string } => Boolean(item));

  return {
    ok: true,
    models,
    requestUrl
  };
}

function parseModelDiscoveryErrorMessage(body: string) {
  if (!body) return '';

  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return body.slice(0, 200);
  }
}

function formatProviderName(providerId: string) {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
