import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeService } from './runtime/runtime-service.js';
import { PluginService } from './plugins/plugin-service.js';
import { ScheduledTaskService } from './runtime/scheduled-task-service.js';
import { getOpenAgentPath } from './runtime/openagent-home.js';
import { getOpenAgentAppSettings, getOpenAgentAppSettingsPath, updateOpenAgentAppSettings } from './runtime/settings/openagent-settings.js';
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
  const workspaceRoot = getOpenAgentPath('agents', agentId, 'workspace');
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


function getImageMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.svg') return 'image/svg+xml';
  return '';
}

function isPathInside(childPath: string, parentPath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePreviewImagePath(requestedPath: unknown) {
  const rawPath = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  if (!rawPath) return null;

  const candidates = path.isAbsolute(rawPath)
    ? [rawPath]
    : [path.resolve(workspace.rootPath, rawPath), path.resolve(process.cwd(), rawPath)];

  const allowedRoots = [workspace.rootPath, process.cwd(), getOpenAgentPath(), os.tmpdir()];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) continue;
    if (!allowedRoots.some((root) => isPathInside(resolved, root))) continue;
    if (!getImageMimeType(resolved)) continue;
    return resolved;
  }
  return null;
}

function readImagePreview(payload: { path?: unknown }) {
  const filePath = resolvePreviewImagePath(payload?.path);
  if (!filePath) return { ok: false, error: '未找到可预览的图片文件。' };

  const stat = statSync(filePath);
  const maxPreviewBytes = 15 * 1024 * 1024;
  if (!stat.isFile()) return { ok: false, error: '预览目标不是文件。' };
  if (stat.size > maxPreviewBytes) return { ok: false, error: '图片过大，已跳过聊天内预览。' };

  const mimeType = getImageMimeType(filePath);
  const dataUrl = `data:${mimeType};base64,${readFileSync(filePath).toString('base64')}`;
  return {
    ok: true,
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    mimeType,
    dataUrl
  };
}

async function saveImageDocument(payload: { dataUrl?: unknown; suggestedName?: unknown; format?: unknown; mimeType?: unknown }) {
  if (!mainWindow) return { ok: false, error: 'Main window is not ready' };
  const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : '';
  const requestedFormat = payload.format === 'svg' ? 'svg' : payload.format === 'png' ? 'png' : null;
  const inferredFormat = dataUrl.startsWith('data:image/svg+xml') ? 'svg' : dataUrl.startsWith('data:image/png') ? 'png' : null;
  const format = requestedFormat || inferredFormat;
  if (!format) return { ok: false, error: 'Only PNG and SVG image data URLs are supported' };

  const suggestedBaseName = sanitizeExportFileName(
    String(payload.suggestedName || 'openagent-image').replace(/\.(png|svg)$/i, '')
  );
  const isSvg = format === 'svg';
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: isSvg ? '保存 SVG 图片' : '保存 PNG 图片',
    defaultPath: `${suggestedBaseName}.${format}`,
    filters: [
      isSvg
        ? { name: 'SVG Image', extensions: ['svg'] }
        : { name: 'PNG Image', extensions: ['png'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (selected.canceled || !selected.filePath) {
    return { ok: false, cancelled: true };
  }

  try {
    writeFileSync(selected.filePath, decodeDataUrl(dataUrl));
    if (!existsSync(selected.filePath) || statSync(selected.filePath).size <= 0) {
      return { ok: false, error: '保存失败：文件没有成功写入。' };
    }
    return { ok: true, path: selected.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^,]*?),(.*)$/s);
  if (!match) return Buffer.from(dataUrl, 'utf8');
  const meta = match[1] ?? '';
  const isBase64 = /(?:^|;)base64(?:;|$)/i.test(meta);
  const payload = match[2] ?? '';
  return isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
}

function buildSnapshot() {
  return runtimeService.getSnapshot();
}

function buildAgentList() {
  return [
    {
      id: activeAgentId,
      kind: 'system',
      workspaceRoot: workspace.rootPath,
      providerId: workspace.providerId,
      model: workspace.model,
      description: 'OpenAgent 主智能体',
      updatedAt: createdAt
    }
  ];
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

interface OpenAgentLogFileInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

function listOpenAgentLogFiles(): { ok: true; root: string; files: OpenAgentLogFileInfo[] } | { ok: false; root: string; error: string; files: [] } {
  const root = getOpenAgentPath('logs');

  try {
    mkdirSync(root, { recursive: true });
    const candidates = collectOpenAgentLogFiles(root);
    return {
      ok: true,
      root,
      files: candidates.sort((left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime())
    };
  } catch (error) {
    return { ok: false, root, files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function readOpenAgentLogFile(payload: { id?: string; maxBytes?: number }): { ok: true; file: OpenAgentLogFileInfo; content: string; truncated: boolean } | { ok: false; error: string } {
  const logFile = resolveOpenAgentLogFile(String(payload?.id || ''));
  if (!logFile) return { ok: false, error: 'Log file not found' };

  const maxBytes = Math.max(16 * 1024, Math.min(Number(payload?.maxBytes || 256 * 1024), 1024 * 1024));
  const { content, truncated } = readUtf8Tail(logFile.path, maxBytes);
  return { ok: true, file: logFile, content, truncated };
}

function resolveOpenAgentLogFile(id: string) {
  if (!id) return null;
  return collectOpenAgentLogFiles(getOpenAgentPath('logs')).find((file) => file.id === id) ?? null;
}

function collectOpenAgentLogFiles(root: string): OpenAgentLogFileInfo[] {
  if (!existsSync(root)) return [];

  const files: OpenAgentLogFileInfo[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isSupportedLogFile(entry.name)) continue;

      const stats = statSync(fullPath);
      const relativePath = path.relative(root, fullPath);
      files.push({
        id: relativePath.split(path.sep).join('/'),
        name: relativePath.split(path.sep).join('/'),
        path: fullPath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
      });
    }
  };

  walk(root, 0);
  return files;
}

function isSupportedLogFile(fileName: string) {
  return /\.(log|jsonl|txt)$/i.test(fileName);
}

function readUtf8Tail(filePath: string, maxBytes: number) {
  const stats = statSync(filePath);
  const bytesToRead = Math.min(stats.size, maxBytes);
  if (bytesToRead <= 0) return { content: '', truncated: false };

  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, Math.max(0, stats.size - bytesToRead));
    return { content: buffer.toString('utf8'), truncated: stats.size > maxBytes };
  } finally {
    closeSync(fd);
  }
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
    activeAgentId,
    agents: buildAgentList()
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
  ipcMain.handle('agents:create', () => ({
    ok: false,
    error: 'Agent creation is not implemented yet. Current OpenAgent runtime is single-agent and only supports the built-in main agent.'
  }));
  ipcMain.handle('agents:set-active', (_event, payload) => {
    const requestedAgentId = String(payload?.agentId || '');
    if (requestedAgentId === activeAgentId) {
      return {
        ok: true,
        activeAgentId,
        agents: buildAgentList(),
        agentBootstrap: runtimeService.getAgentBootstrapSnapshot(),
        snapshot: buildSnapshot()
      };
    }

    return {
      ok: false,
      error: `Agent switching is not implemented yet. Current OpenAgent runtime only supports agent: ${activeAgentId}.`,
      activeAgentId,
      agents: buildAgentList(),
      agentBootstrap: runtimeService.getAgentBootstrapSnapshot(),
      snapshot: buildSnapshot()
    };
  });
  ipcMain.handle('threads:create', () => runtimeService.createThread());
  ipcMain.handle('threads:select', (_event, payload) => runtimeService.selectThread(payload.threadId));
  ipcMain.handle('threads:compact', (_event, payload) => runtimeService.compactThread(payload?.threadId));
  ipcMain.handle('threads:export', (_event, payload) => exportSessionDocument(payload ?? {}));
  ipcMain.handle('image:save', (_event, payload) => saveImageDocument(payload ?? {}));
  ipcMain.handle('image:preview', (_event, payload) => readImagePreview(payload ?? {}));
  ipcMain.handle('threads:delete', (_event, payload) => runtimeService.deleteThread(payload.threadId));
  ipcMain.handle('approval:resolve', (_event, payload) => runtimeService.resolveApproval(payload ?? {}));
  ipcMain.handle('attachment:open', async (_event, payload) => {
    const targetPath = typeof payload?.path === 'string' ? payload.path : '';
    if (!targetPath) return { ok: false, error: 'Missing attachment path' };
    if (!existsSync(targetPath)) return { ok: false, error: `文件不存在：${targetPath}` };

    if (payload.action === 'reveal') {
      shell.showItemInFolder(targetPath);
      return { ok: true };
    }
    const result = await shell.openPath(targetPath);
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
  ipcMain.handle('app-settings:get', () => ({
    ok: true,
    settings: getOpenAgentAppSettings(),
    configPath: getOpenAgentAppSettingsPath()
  }));
  ipcMain.handle('app-settings:update', (_event, payload) => {
    const settings = updateOpenAgentAppSettings(payload ?? {});
    const autoApproved = settings.runtime.autoApproveRuntimeApprovals
      ? runtimeService.autoApprovePendingApprovals('app-settings:update')
      : { ok: true, approvedCount: 0 };
    return {
      ok: true,
      settings,
      configPath: getOpenAgentAppSettingsPath(),
      autoApproved
    };
  });
  ipcMain.handle('logs:list', () => listOpenAgentLogFiles());
  ipcMain.handle('logs:read', (_event, payload) => readOpenAgentLogFile(payload ?? {}));
  ipcMain.handle('logs:open-file', async (_event, payload) => {
    const logFile = resolveOpenAgentLogFile(String(payload?.id || ''));
    if (!logFile) return { ok: false, error: 'Log file not found' };
    const error = await shell.openPath(logFile.path);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('skills:list', () => runtimeService.listSkills());
  ipcMain.handle('skills:refresh', () => runtimeService.refreshSkills());
  ipcMain.handle('skills:get', (_event, payload) => runtimeService.getSkill(String(payload?.skillName || payload?.skillId || payload || '')));
  ipcMain.handle('skills:set-enabled', (_event, payload) => runtimeService.setSkillEnabled(payload ?? {}));
  ipcMain.handle('skills:test', (_event, payload) => runtimeService.testSkill(payload ?? {}));
  ipcMain.handle('skills:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, { properties: ['openDirectory'] });
    if (result.canceled) return { ok: false, canceled: true };
    return { ok: true, directoryPath: result.filePaths[0] };
  });
  ipcMain.handle('skills:install-local', (_event, payload) => runtimeService.installLocalSkill(payload ?? {}));
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
