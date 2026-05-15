import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeService } from './runtime/runtime-service.js';
import { PluginService } from './plugins/plugin-service.js';
import { ScheduledTaskService } from './runtime/scheduled-task-service.js';
import {
  buildPiProviderCatalog,
  clearOpenAgentPiProviderApiKey,
  deleteOpenAgentPiProvider,
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
const activeAgentId = 'main';
const defaultWorkspaceRoot = resolveDefaultAgentWorkspaceRoot(activeAgentId);

const pluginService = new PluginService();

const workspace = {
  name: 'OpenAgent',
  rootPath: process.env.OPENAGENT_WORKSPACE_ROOT ?? defaultWorkspaceRoot,
  branch: 'main',
  providerId: process.env.OPENAGENT_PROVIDER_ID ?? activePiModelConfig.activeProviderId,
  providerLabel: process.env.OPENAGENT_PROVIDER_LABEL ?? formatProviderName(process.env.OPENAGENT_PROVIDER_ID ?? activePiModelConfig.activeProviderId),
  model: process.env.OPENAGENT_MODEL ?? activePiModelConfig.activeModelId,
  runStatus: 'idle'
};

const runtimeService = new RuntimeService({
  agentId: activeAgentId,
  workspaceName: workspace.name,
  workspaceRoot: workspace.rootPath,
  branch: workspace.branch,
  providerId: workspace.providerId,
  providerLabel: workspace.providerLabel,
  model: workspace.model,
  emitUiEvent: (event) => {
    pluginService.dispatchUiEvent(event);
    mainWindow?.webContents.send('ui:event', event);
    if (event.type === 'approval.required') {
      activateWindowForApproval();
    }
  },
  pluginContextResolver: pluginService
});

pluginService.setRuntimeSubmitHandler(async (input) => {
  const payload = input && typeof input === 'object' ? input as { prompt?: unknown; awaitCompletion?: unknown } : {};
  const prompt = String(payload.prompt || '');
  if (!prompt.trim()) return { ok: false, error: 'Plugin prompt is empty' };
  return runtimeService.submitPrompt({ prompt, awaitCompletion: payload.awaitCompletion !== false });
});

const SCHEDULED_THREAD_TITLE_PREFIX = '⏰ ';

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
      const created = runtimeService.createThread({ agentId: task.agentId, title: formatScheduledThreadTitle(task.title) });
      threadId = created.threadId;
    } else {
      runtimeService.markThreadTitlePrefix(threadId, SCHEDULED_THREAD_TITLE_PREFIX);
    }

    const result = await runtimeService.submitPrompt({
      prompt: [`[定时任务] ${task.title}`, '', task.prompt].join('\n'),
      awaitCompletion: true
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
    markScheduledTaskThreads(tasks);
    mainWindow?.webContents.send('ui:event', {
      id: `event-schedules-${Date.now()}`,
      type: 'scheduled-task.updated',
      payload: { tasks },
      createdAt: new Date().toISOString()
    });
  }
});

markScheduledTaskThreads(scheduledTaskService.list());


function formatScheduledThreadTitle(title: string) {
  const normalized = title.trim() || '未命名定时任务';
  return normalized.startsWith(SCHEDULED_THREAD_TITLE_PREFIX) ? normalized : `${SCHEDULED_THREAD_TITLE_PREFIX}${normalized}`;
}

function markScheduledTaskThreads(tasks: Array<{ threadId?: string | null; lastRunThreadId?: string | null }>) {
  for (const task of tasks) {
    const threadId = task.threadId || task.lastRunThreadId;
    if (threadId) {
      runtimeService.markThreadTitlePrefix(threadId, SCHEDULED_THREAD_TITLE_PREFIX);
    }
  }
}

function resolveDefaultAgentWorkspaceRoot(agentId: string) {
  // OpenAgent 的默认 workspace 属于具体 agent，而不是开发时启动 app 的 repo cwd。
  // 保留环境变量 OPENAGENT_WORKSPACE_ROOT 作为调试/测试覆盖入口；正式默认落在 ~/.openagent/agents/<agentId>/workspace。
  const workspaceRoot = path.join(os.homedir(), '.openagent', 'agents', agentId, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

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


async function exportSessionDocument(payload: { format?: unknown; title?: unknown; html?: unknown; suggestedName?: unknown }) {
  if (!mainWindow) return { ok: false, error: 'Main window is not ready' };

  const format = payload.format === 'png' ? 'png' : payload.format === 'pdf' ? 'pdf' : null;
  if (!format) return { ok: false, error: 'Unsupported export format' };

  const html = typeof payload.html === 'string' ? payload.html : '';
  if (!html.trim()) return { ok: false, error: 'Export content is empty' };

  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'OpenAgent 会话';
  const suggestedName = sanitizeExportFileName(
    typeof payload.suggestedName === 'string' && payload.suggestedName.trim() ? payload.suggestedName.trim() : title
  );
  const extension = format === 'pdf' ? 'pdf' : 'png';
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: format === 'pdf' ? '导出会话为 PDF' : '导出会话为图片',
    defaultPath: `${suggestedName}.${extension}`,
    filters: [
      format === 'pdf'
        ? { name: 'PDF Document', extensions: ['pdf'] }
        : { name: 'PNG Image', extensions: ['png'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (selected.canceled || !selected.filePath) {
    return { ok: false, cancelled: true };
  }

  const tempHtmlPath = path.join(app.getPath('temp'), `openagent-session-export-${randomUUID()}.html`);
  const exportWindow = new BrowserWindow({
    width: 960,
    height: 1200,
    show: false,
    backgroundColor: '#f5f5f7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    writeFileSync(tempHtmlPath, html, 'utf8');
    await exportWindow.loadFile(tempHtmlPath);
    await exportWindow.webContents.executeJavaScript('document.fonts?.ready ? document.fonts.ready.then(() => true) : true');
    await exportWindow.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

    if (format === 'pdf') {
      const pdf = await exportWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      });
      writeFileSync(selected.filePath, pdf);
    } else {
      const png = await captureSessionPng(exportWindow);
      writeFileSync(selected.filePath, png);
    }

    if (!existsSync(selected.filePath) || statSync(selected.filePath).size <= 0) {
      return { ok: false, error: '导出失败：文件没有成功写入。' };
    }

    return { ok: true, path: selected.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    exportWindow.destroy();
    try {
      rmSync(tempHtmlPath, { force: true });
    } catch {
      // ignore temp cleanup failures
    }
  }
}


async function captureSessionPng(exportWindow: BrowserWindow) {
  const metrics = await exportWindow.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.conversation-export-page') || document.body;
    const rect = page.getBoundingClientRect();
    const width = Math.ceil(Math.max(rect.width, document.documentElement.scrollWidth, document.body.scrollWidth, 960));
    const height = Math.ceil(Math.max(rect.height, document.documentElement.scrollHeight, document.body.scrollHeight, 1));
    return { width: Math.min(width, 1400), height: Math.min(height, 32000) };
  })()`);
  const width = normalizeExportDimension(metrics?.width, 960, 1400);
  const height = normalizeExportDimension(metrics?.height, 1200, 32000);

  exportWindow.setContentSize(width, Math.min(height, 1200));
  await exportWindow.webContents.executeJavaScript('window.scrollTo(0, 0)');
  await exportWindow.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

  const debuggerClient = exportWindow.webContents.debugger;
  let attached = false;
  try {
    if (!debuggerClient.isAttached()) {
      debuggerClient.attach('1.3');
      attached = true;
    }
    await debuggerClient.sendCommand('Page.enable');
    const screenshot = await debuggerClient.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: 0,
        y: 0,
        width,
        height,
        scale: 1
      }
    }) as { data?: string };

    if (!screenshot.data) {
      throw new Error('Page.captureScreenshot returned empty data');
    }

    return Buffer.from(screenshot.data, 'base64');
  } finally {
    if (attached && debuggerClient.isAttached()) {
      debuggerClient.detach();
    }
  }
}

function normalizeExportDimension(value: unknown, fallback: number, max: number) {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? Math.ceil(value) : fallback;
  return Math.max(1, Math.min(numberValue, max));
}

function sanitizeExportFileName(value: string) {
  return value.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'openagent-session';
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
  await pluginService.initialize();
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
  ipcMain.handle('knowledge:health', () => runtimeService.getKnowledgeHealth('system'));
  ipcMain.handle('knowledge:query', (_event, payload) => runtimeService.queryKnowledge(payload ?? {}));
  ipcMain.handle('knowledge:ingest', (_event, payload) => runtimeService.ingestKnowledge(payload ?? {}));
  ipcMain.handle('knowledge:choose-and-ingest-files', async () => {
    if (!mainWindow) return { ok: false, error: 'Main window is not ready', results: [] };
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入 Knowledge Base 的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Knowledge Supported Files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'yml', 'yaml', 'csv', 'tsv', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'mp4', 'mov', 'mp3', 'wav', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (selected.canceled || selected.filePaths.length === 0) {
      return { ok: false, cancelled: true, results: [] };
    }
    const results = await runtimeService.ingestKnowledgeFiles(selected.filePaths.map((filePath) => ({ filePath, tags: ['file-import'] })));
    return { ok: results.every((result) => result.ok), results };
  });
  ipcMain.handle('knowledge:lint', () => runtimeService.lintKnowledge());
  ipcMain.handle('knowledge:graph', () => runtimeService.buildKnowledgeGraph());
  ipcMain.handle('knowledge:browse', () => runtimeService.browseKnowledge());
  ipcMain.handle('knowledge:read-article', (_event, payload) => runtimeService.readKnowledgeArticle(payload ?? {}));
  ipcMain.handle('knowledge:compile', (_event, payload) => runtimeService.compileKnowledge(payload ?? {}));
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
  ipcMain.handle('threads:compact', (_event, payload) => runtimeService.compactThread(payload?.threadId));
  ipcMain.handle('threads:export', (_event, payload) => exportSessionDocument(payload ?? {}));
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
    { kind: 'openai-compatible', label: '自定义兼容接口', description: '公司网关 / 本地模型服务 / OpenAI-compatible', supportedAuthTypes: ['bearer', 'api_key_header', 'none'], defaultInvocationMode: 'chat-completions', invocationMode: 'chat-completions', defaultBaseUrl: 'https://your-gateway.example.com/v1' }
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
    const baseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim() : '';
    const apiKey = typeof payload?.auth?.secret === 'string' ? payload.auth.secret.trim() : '';
    if (apiKey || baseUrl) {
      const discovered = await discoverOpenAgentPiModels({
        providerId,
        baseUrl,
        auth: {
          type: String(payload?.auth?.type || 'bearer'),
          secret: apiKey,
          headerName: String(payload?.auth?.headerName || 'Authorization')
        }
      });

      if (!discovered.ok) {
        return { ok: false, providerId, workspace, models: [], requestUrl: discovered.requestUrl, error: discovered.error };
      }

      const catalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
      return { ok: true, providerId, workspace, catalog, models: discovered.models, requestUrl: discovered.requestUrl };
    }

    const catalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
    const activeProvider = catalog.providers.find((provider) => provider.id === providerId);
    return { ok: true, providerId, workspace, catalog, models: activeProvider?.models ?? [] };
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
  ipcMain.handle('llm:clear-provider-api-key', async (_event, payload) => {
    const providerId = String(payload?.providerId || workspace.providerId);
    const clearResult = clearOpenAgentPiProviderApiKey({ providerId });
    const catalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
    return { ok: true, providerId, workspace, catalog, modelsPath: clearResult.modelsPath };
  });
  ipcMain.handle('llm:delete-provider', async (_event, payload) => {
    const providerId = String(payload?.providerId || '');
    const deleteResult = deleteOpenAgentPiProvider({ providerId });
    const catalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
    const nextProvider =
      catalog.providers.find((provider) => provider.id !== providerId && (provider.enabled || provider.auth?.configured) && provider.models.length > 0) ??
      catalog.providers.find((provider) => provider.id !== providerId) ??
      catalog.providers[0];

    if (workspace.providerId === providerId && nextProvider) {
      updateActiveModel(nextProvider.id, nextProvider.defaultModel || nextProvider.models[0]?.id || workspace.model);
    }

    const nextCatalog = await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model });
    return { ok: true, providerId: deleteResult.providerId, workspace, catalog: nextCatalog, modelsPath: deleteResult.modelsPath };
  });
  ipcMain.handle('llm:set-active', async (_event, payload) => {
    const providerId = String(payload?.providerId || workspace.providerId);
    const requestedModelId = typeof payload?.modelId === 'string' ? payload.modelId : '';
    const catalog = await buildPiProviderCatalog({ activeProviderId: providerId, activeModelId: requestedModelId || workspace.model });
    const provider = catalog.providers.find((item) => item.id === providerId) ?? catalog.providers[0];
    const modelId =
      provider?.models.find((model) => model.id === requestedModelId)?.id ||
      provider?.defaultModel ||
      provider?.models[0]?.id ||
      workspace.model;
    updateActiveModel(provider?.id || providerId, modelId);
    return {
      ok: true,
      providerId: workspace.providerId,
      modelId: workspace.model,
      workspace,
      catalog: await buildPiProviderCatalog({ activeProviderId: workspace.providerId, activeModelId: workspace.model })
    };
  });
  ipcMain.handle('skills:list', () => []);
  ipcMain.handle('plugins:get-registry', () => pluginService.getRegistry());
  ipcMain.handle('plugins:discover', async (_event, payload) => pluginService.discover({ pluginsRoot: typeof payload?.pluginsRoot === 'string' ? payload.pluginsRoot : undefined }));
  ipcMain.handle('plugins:install-local', async (_event, payload) => pluginService.installLocal(String(payload?.path || '')));
  ipcMain.handle('plugins:load', async (_event, payload) => pluginService.load({ pluginIds: Array.isArray(payload?.pluginIds) ? payload.pluginIds : undefined, pluginNames: Array.isArray(payload?.pluginNames) ? payload.pluginNames : undefined }));
  ipcMain.handle('plugins:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, { properties: ['openDirectory'] });
    if (result.canceled) return { ok: false, canceled: true };
    return { ok: true, directoryPath: result.filePaths[0] };
  });
  ipcMain.handle('plugins:set-enabled', async (_event, payload) => pluginService.setEnabled(payload ?? {}));
  ipcMain.handle('plugins:set-capability', async (_event, payload) => pluginService.setCapability(payload ?? {}));
  ipcMain.handle('plugins:test', async (_event, payload) => pluginService.testPlugin(payload ?? {}));
  ipcMain.handle('plugins:install-dependency', async (_event, payload) => pluginService.installDependency(payload ?? {}));
  ipcMain.handle('plugins:authorize', async (event, payload) => pluginService.authorize(payload ?? {}, {
    onAuthorizationUrl: (progress) => event.sender.send('plugins:authorization-event', progress)
  }));
  ipcMain.handle('plugins:get-config', async (_event, payload) => pluginService.getConfig(payload ?? {}));
  ipcMain.handle('plugins:save-config', async (_event, payload) => pluginService.saveConfig(payload ?? {}));
  ipcMain.handle('plugins:set-secret', async (_event, payload) => pluginService.setSecret(payload ?? {}));
}
