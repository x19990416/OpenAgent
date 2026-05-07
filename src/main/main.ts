import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RuntimeService } from './runtime/runtime-service.js';
import { ScheduledTaskService } from './runtime/scheduled-task-service.js';
import {
  buildPiProviderCatalog,
  discoverOpenAgentPiModels,
  getOpenAgentPiModelConfig,
  loginOpenAgentPiOAuthProvider,
  saveOpenAgentPiProviderApiKey,
  setOpenAgentPiModelConfig,
  updateOpenAgentPiProviderModels,
  upsertOpenAgentPiProvider
} from './runtime/pi/pi-model-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';

let mainWindow: BrowserWindow | null = null;
const createdAt = new Date().toISOString();

const activePiModelConfig = getOpenAgentPiModelConfig();

const workspace = {
  name: 'OpenAgent',
  rootPath: process.cwd(),
  branch: 'main',
  providerId: process.env.OPENAGENT_PROVIDER_ID ?? activePiModelConfig.activeProviderId,
  providerLabel: process.env.OPENAGENT_PROVIDER_LABEL ?? formatProviderName(process.env.OPENAGENT_PROVIDER_ID ?? activePiModelConfig.activeProviderId),
  model: process.env.OPENAGENT_MODEL ?? activePiModelConfig.activeModelId,
  runStatus: 'idle'
};

const runtimeService = new RuntimeService({
  agentId: 'main',
  workspaceName: workspace.name,
  workspaceRoot: workspace.rootPath,
  branch: workspace.branch,
  providerId: workspace.providerId,
  providerLabel: workspace.providerLabel,
  model: workspace.model,
  emitUiEvent: (event) => {
    mainWindow?.webContents.send('ui:event', event);
    if (event.type === 'approval.required') {
      activateWindowForApproval();
    }
  }
});

const scheduledTaskService = new ScheduledTaskService({
  onDue: async (task) => {
    let threadId = task.sessionPolicy === 'reuse_existing' ? task.threadId || null : null;
    if (threadId) {
      const selected = runtimeService.selectThread(threadId);
      if (!selected.ok) {
        threadId = null;
      }
    }
    if (!threadId) {
      const created = runtimeService.createThread({ agentId: task.agentId, title: task.title });
      threadId = created.threadId;
    }

    const result = await runtimeService.submitPrompt({
      prompt: [`[定时任务] ${task.title}`, '', task.prompt].join('\n')
    });
    const error = 'error' in result ? String(result.error || '') : '';
    return {
      ok: Boolean(result.ok),
      summary: result.ok ? `已提交运行：${result.runId || task.title}` : error,
      error,
      threadId
    };
  },
  onChange: (tasks) => {
    mainWindow?.webContents.send('ui:event', {
      id: `event-schedules-${Date.now()}`,
      type: 'scheduled-task.updated',
      payload: { tasks },
      createdAt: new Date().toISOString()
    });
  }
});

function activateWindowForApproval() {
  if (!mainWindow) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
  mainWindow.flashFrame(true);

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
    app.dock?.bounce('critical');
  }
}

function buildSnapshot() {
  return runtimeService.getSnapshot();
}

function updateActiveModel(providerId: string, modelId: string) {
  setOpenAgentPiModelConfig({ providerId, modelId });
  workspace.providerId = providerId;
  workspace.providerLabel = formatProviderName(providerId);
  workspace.model = modelId;
  runtimeService.updateModelConfig({ providerId, providerLabel: workspace.providerLabel, model: modelId });
}

function formatProviderName(providerId: string) {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: 'OpenAgent Desktop',
    backgroundColor: '#f5f5f7',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerIpc() {
  ipcMain.handle('workspace:get-meta', () => workspace);
  ipcMain.handle('agent:get-bootstrap', () => runtimeService.getAgentBootstrapSnapshot());
  ipcMain.handle('soul:list-proposals', (_event, payload) => runtimeService.listSoulProposals(payload?.status));
  ipcMain.handle('soul:create-proposal', (_event, payload) => runtimeService.createSoulProposal(payload ?? {}));
  ipcMain.handle('soul:approve-proposal', (_event, payload) => runtimeService.approveSoulProposal(String(payload?.proposalId || '')));
  ipcMain.handle('soul:reject-proposal', (_event, payload) => runtimeService.rejectSoulProposal(String(payload?.proposalId || '')));
  ipcMain.handle('agents:list', () => ({
    activeAgentId: 'main',
    agents: [
      {
        id: 'main',
        kind: 'system',
        workspaceRoot: workspace.rootPath,
        providerId: workspace.providerId,
        model: workspace.model,
        description: 'OpenAgent 主智能体',
        updatedAt: createdAt
      }
    ]
  }));
  ipcMain.handle('state:get-snapshot', () => buildSnapshot());
  ipcMain.handle('runtime:get-tasks', () => runtimeService.listRuntimeTasks());
  ipcMain.handle('scheduled-tasks:list', () => scheduledTaskService.list());
  ipcMain.handle('scheduled-tasks:create', (_event, payload) => scheduledTaskService.create(payload ?? {}));
  ipcMain.handle('scheduled-tasks:delete', (_event, payload) => scheduledTaskService.delete(String(payload?.taskId || '')));
  ipcMain.handle('scheduled-tasks:set-enabled', (_event, payload) => scheduledTaskService.setEnabled(String(payload?.taskId || ''), Boolean(payload?.enabled)));
  ipcMain.handle('scheduled-tasks:run-now', (_event, payload) => scheduledTaskService.runNow(String(payload?.taskId || '')));
  ipcMain.handle('prompt:send', (_event, payload) => runtimeService.submitPrompt(payload));
  ipcMain.handle('run:stop', (_event, payload) => runtimeService.stopRun(payload?.runId));
  ipcMain.handle('agents:create', () => ({ ok: true }));
  ipcMain.handle('agents:set-active', () => ({ ok: true }));
  ipcMain.handle('threads:create', () => runtimeService.createThread());
  ipcMain.handle('threads:select', (_event, payload) => runtimeService.selectThread(payload.threadId));
  ipcMain.handle('threads:delete', (_event, payload) => runtimeService.deleteThread(payload.threadId));
  ipcMain.handle('approval:resolve', (_event, payload) => runtimeService.resolveApproval(payload ?? {}));
  ipcMain.handle('attachment:open', async (_event, payload) => {
    if (payload.action === 'reveal') {
      shell.showItemInFolder(payload.path);
      return { ok: true };
    }
    const result = await shell.openPath(payload.path);
    return result ? { ok: false, error: result } : { ok: true };
  });

  ipcMain.handle('llm:get-catalog', () =>
    buildPiProviderCatalog({
      activeProviderId: workspace.providerId,
      activeModelId: workspace.model
    })
  );
  ipcMain.handle('llm:list-kinds', () => [
    { kind: 'openai', label: 'OpenAI', description: 'Pi ModelRegistry provider', supportedAuthTypes: ['bearer'], defaultInvocationMode: 'pi-agent-session', invocationMode: 'pi-agent-session' },
    { kind: 'openai-codex', label: 'ChatGPT / Codex 订阅', description: 'Reuse Pi default auth. Run /login openai-codex in Pi CLI first.', supportedAuthTypes: ['none'], defaultInvocationMode: 'pi-agent-session', invocationMode: 'pi-agent-session' },
    { kind: 'anthropic', label: 'Anthropic', description: 'Pi ModelRegistry provider', supportedAuthTypes: ['bearer'], defaultInvocationMode: 'pi-agent-session', invocationMode: 'pi-agent-session' },
    { kind: 'google', label: 'Google / Gemini', description: 'Pi ModelRegistry provider', supportedAuthTypes: ['bearer'], defaultInvocationMode: 'pi-agent-session', invocationMode: 'pi-agent-session' },
    { kind: 'mistral', label: 'Mistral', description: 'Pi ModelRegistry provider', supportedAuthTypes: ['bearer'], defaultInvocationMode: 'pi-agent-session', invocationMode: 'pi-agent-session' },
    { kind: 'deepseek', label: 'DeepSeek', description: 'Pi ModelRegistry provider', supportedAuthTypes: ['bearer'], defaultInvocationMode: 'pi-agent-session', invocationMode: 'pi-agent-session' },
    { kind: 'openrouter', label: 'OpenRouter', description: 'Pi ModelRegistry provider', supportedAuthTypes: ['bearer'], defaultInvocationMode: 'pi-agent-session', invocationMode: 'pi-agent-session' },
    { kind: 'openai-compatible', label: '自定义兼容接口', description: 'OpenAI-compatible / 公司网关 / 本地模型服务', supportedAuthTypes: ['bearer', 'api_key_header', 'none'], defaultInvocationMode: 'chat-completions', invocationMode: 'chat-completions', defaultBaseUrl: 'https://your-gateway.example.com/v1' }
  ]);
  ipcMain.handle('llm:update-models', async (_event, payload) => {
    const updateResult = updateOpenAgentPiProviderModels({
      providerId: String(payload?.providerId || workspace.providerId),
      defaultModel: String(payload?.defaultModel || workspace.model),
      models: Array.isArray(payload?.models) ? payload.models : []
    });
    const providerId = updateResult.providerId;
    const modelId = updateResult.modelId || workspace.model;
    updateActiveModel(providerId, modelId);
    const catalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
    return { ok: true, providerId: workspace.providerId, workspace, catalog, configPath: updateResult.configPath };
  });
  ipcMain.handle('llm:discover-models', async (_event, payload) => {
    return discoverOpenAgentPiModels(payload ?? {});
  });
  ipcMain.handle('llm:refresh-models', async (_event, payload) => {
    const providerId = String(payload?.providerId || workspace.providerId);
    const catalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
    const activeProvider = catalog.providers.find((provider) => provider.id === providerId);
    return { ok: true, providerId, workspace, catalog, models: activeProvider?.models ?? [], requestUrl: `pi://model-registry/${providerId}` };
  });
  ipcMain.handle('llm:open-pi-codex-login', async () => {
    const providerId = 'openai-codex';
    const progress: string[] = [];

    try {
      await loginOpenAgentPiOAuthProvider({
        providerId,
        onAuth: (info) => {
          progress.push(info.instructions ? `${info.url}\n${info.instructions}` : info.url);
          void shell.openExternal(info.url);
        },
        onProgress: (message) => {
          progress.push(message);
        }
      });

      const catalogAfterLogin = await buildPiProviderCatalog({
        activeProviderId: providerId,
        activeModelId: workspace.model
      });
      const provider = catalogAfterLogin.providers.find((item) => item.id === providerId);
      const modelId =
        provider?.models.find((model) => model.id === workspace.model)?.id ||
        provider?.defaultModel ||
        provider?.models[0]?.id ||
        workspace.model;

      updateActiveModel(providerId, modelId);

      return {
        ok: true,
        providerId: workspace.providerId,
        workspace,
        catalog: await buildPiProviderCatalog({
          activeProviderId: workspace.providerId,
          activeModelId: workspace.model
        }),
        authPath: 'pi-default-auth',
        progress
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('llm:upsert-provider', async (_event, payload) => {
    const saveResult = upsertOpenAgentPiProvider(payload ?? {});
    const providerId = saveResult.providerId;
    const apiKey = typeof payload?.auth?.secret === 'string' ? payload.auth.secret.trim() : '';
    if (apiKey) {
      saveOpenAgentPiProviderApiKey({ providerId, apiKey });
    }
    const modelId = saveResult.modelId || String(payload?.defaultModel || workspace.model);
    updateActiveModel(providerId, modelId);
    const catalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
    return { ok: true, providerId: workspace.providerId, workspace, catalog, configPath: saveResult.configPath };
  });
  ipcMain.handle('llm:set-active', async (_event, payload) => {
    const providerId = String(payload?.providerId || workspace.providerId);
    const catalog = await buildPiProviderCatalog({ activeProviderId: providerId, activeModelId: workspace.model });
    const provider = catalog.providers.find((item) => item.id === providerId) ?? catalog.providers[0];
    const modelId = provider?.defaultModel || provider?.models[0]?.id || workspace.model;
    updateActiveModel(providerId, modelId);
    return { ok: true, providerId: workspace.providerId, workspace, catalog: await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model }) };
  });
  ipcMain.handle('skills:list', () => []);
  ipcMain.handle('plugins:get-registry', () => ({ plugins: [] }));
  ipcMain.handle('plugins:discover', () => ({ ok: true, registry: { plugins: [] } }));
  ipcMain.handle('plugins:load', () => ({ ok: true, registry: { plugins: [] }, loadedCount: 0 }));
  ipcMain.handle('plugins:choose-directory', () => ({ ok: false, error: 'Not implemented in UI prototype' }));
  ipcMain.handle('plugins:set-enabled', () => ({ ok: true, registry: { plugins: [] } }));
  ipcMain.handle('plugins:get-config', () => ({ ok: true, config: { appId: '', appSecret: '', updatedAt: new Date().toISOString() } }));
  ipcMain.handle('plugins:save-config', (_event, payload) => ({ ok: true, config: { ...payload.config, updatedAt: new Date().toISOString() } }));
}
