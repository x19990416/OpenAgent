import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { PluginCapability, PluginManifest, PluginRecord, PluginStateFile, PluginToolPolicy } from './plugin-types.js';

export const BUILTIN_FEISHU_MANIFEST: PluginManifest = {
  schemaVersion: 'openagent.plugin.v1',
  id: 'openagent-plugin-feishu-cli',
  name: 'Feishu CLI',
  version: '0.1.0',
  description: 'Feishu channel and tools integration backed by a local Feishu CLI adapter.',
  main: 'builtin:feishu-cli',
  capabilities: ['channel', 'tools', 'skills', 'remote_ui', 'settings', 'policy'],
  interface: {
    displayName: '飞书 CLI',
    description: '通过本地飞书 CLI 适配飞书消息入口、回复和基础工具。',
    category: 'Channel / Enterprise',
    brandColor: '#3370ff'
  },
  configSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  secretSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      appSecret: { type: 'string' }
    },
    additionalProperties: false
  },
  tools: [
    { name: 'feishu_agent', description: 'Plugin-provided Feishu subagent for all Feishu/Lark CLI tasks.', risk: 'read' },
    { name: 'feishu.test_connection', description: 'Test Feishu CLI availability and plugin configuration.', risk: 'read' },
    { name: 'feishu.calendar_list', description: 'List Feishu/Lark calendars visible to the authorized user.', risk: 'read' },
    { name: 'feishu.calendar_agenda', description: 'View Feishu/Lark calendar agenda for a date range.', risk: 'read' },
    { name: 'feishu.send_text_message', description: 'Send a text message to an allowed Feishu chat or user.', risk: 'external_send' },
    { name: 'feishu.reply_to_current_chat', description: 'Reply to the current Feishu channel context.', risk: 'external_send' }
  ],
  skills: [{ name: 'feishu-workspace', description: 'Use Feishu calendar and IM tools safely through OpenAgent policy.' }],
  agents: [
    {
      id: 'feishu_agent',
      name: '飞书助手',
      description: '负责飞书 CLI 的所有任务，包括日程、消息、文档、云盘、多维表格、审批等能力；通过受控 lark-cli adapter 执行。',
      tools: ['feishu_agent', 'feishu.test_connection', 'feishu.calendar_list', 'feishu.calendar_agenda', 'feishu.send_text_message', 'feishu.reply_to_current_chat'],
      routingHints: ['飞书', 'Lark', '日程', '会议', '消息', '群聊', '文档', '云盘', '多维表格', '审批'],
      constraints: [
        '优先通过 feishu_agent 委派飞书任务。',
        '不能让主 Agent 自己查 .env 或环境变量来替代插件密钥。',
        '不能绕过 OpenAgent ToolPolicy、approval、logs 和 UI event。'
      ]
    }
  ],
  runtimeDependencies: [
    {
      id: 'lark-cli',
      type: 'npm',
      packageName: '@larksuite/cli',
      binary: 'lark-cli',
      version: 'latest',
      description: 'Official Lark/Feishu CLI used by the Feishu CLI plugin.'
    }
  ]
};

export class PluginRegistry {
  constructor(private readonly getState: () => PluginStateFile) {}

  async discover(input: { pluginsRoot?: string; includeBuiltins?: boolean } = {}) {
    const state = this.getState();
    const root = typeof input.pluginsRoot === 'string' ? input.pluginsRoot : state.pluginsRoot || '';
    const next = new Map<string, PluginRecord>();
    if (input.includeBuiltins !== false) {
      const record = this.createRecordFromManifest(BUILTIN_FEISHU_MANIFEST, { source: 'builtin', rootPath: 'builtin:feishu-cli', manifestPath: 'builtin:feishu-cli/plugin.json' });
      next.set(record.id, record);
    }
    const manifestPaths = await this.findLocalManifestPaths(root);
    for (const manifestPath of [...new Set([...(state.installedLocalManifests ?? []), ...manifestPaths])]) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest;
        const record = this.createRecordFromManifest(manifest, { source: 'local', rootPath: path.dirname(manifestPath), manifestPath });
        next.set(record.id, record);
      } catch (error) {
        const id = `invalid:${manifestPath}`;
        next.set(id, this.createInvalidRecord(id, manifestPath, error));
      }
    }
    return next;
  }

  createRecordFromManifest(manifest: PluginManifest, source: { source: 'builtin' | 'local'; rootPath?: string; manifestPath?: string }): PluginRecord {
    const state = this.getState();
    const validationErrors = validateManifest(manifest);
    const id = manifest.id || manifest.name || source.manifestPath || 'unknown-plugin';
    const enabled = Boolean(state.enabled?.[id]);
    const config = withConfigDefaults(manifest, state.config?.[id] ?? {});
    const record: PluginRecord = {
      id,
      name: manifest.name || id,
      enabled,
      status: enabled ? 'installed' : 'disabled',
      rootPath: source.rootPath,
      manifestPath: source.manifestPath,
      discoveredAt: new Date().toISOString(),
      validationErrors,
      lastError: validationErrors.length ? validationErrors.join('; ') : undefined,
      configured: isConfigured(manifest, config),
      authorized: false,
      capabilities: computeCapabilities(manifest, id, state),
      manifest,
      skills: manifest.skills ?? [],
      mcpServers: Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [],
      tools: manifest.tools ?? [],
      policy: (manifest.tools ?? []).map((tool) => ({ toolName: tool.name, risk: tool.risk ?? 'read', requiresApproval: tool.risk === 'external_send' || tool.risk === 'external_write' || tool.risk === 'destructive', description: tool.description })) as PluginToolPolicy[],
      source: source.source
    };
    record.status = validationErrors.length ? 'error' : enabled ? 'installed' : 'disabled';
    return record;
  }

  createInvalidRecord(id: string, manifestPath: string, error: unknown): PluginRecord {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      name: path.basename(path.dirname(manifestPath)),
      enabled: false,
      status: 'error',
      rootPath: path.dirname(manifestPath),
      manifestPath,
      discoveredAt: new Date().toISOString(),
      lastError: message,
      validationErrors: [message],
      configured: false,
      authorized: false,
      capabilities: {},
      manifest: { id, name: path.basename(path.dirname(manifestPath)), description: 'Invalid plugin manifest' },
      skills: [],
      mcpServers: [],
      tools: [],
      policy: [],
      source: 'local'
    };
  }

  async findLocalManifestPaths(root: string) {
    if (!root) return [];
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) return [];
    const candidates = [path.join(root, 'plugin.json'), path.join(root, '.openagent-plugin', 'plugin.json')];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(root, entry.name, 'plugin.json'));
      candidates.push(path.join(root, entry.name, '.openagent-plugin', 'plugin.json'));
    }
    const found: string[] = [];
    for (const candidate of candidates) if (await exists(candidate)) found.push(candidate);
    return found;
  }
}

export function validateManifest(manifest: PluginManifest) {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 'openagent.plugin.v1') errors.push('schemaVersion must be openagent.plugin.v1');
  if (!manifest.id) errors.push('id is required');
  if (!manifest.name) errors.push('name is required');
  if (!manifest.main) errors.push('main is required');
  if (!Array.isArray(manifest.capabilities)) errors.push('capabilities must be an array');
  return errors;
}

export function computeCapabilities(manifest: PluginManifest, pluginId: string, state: PluginStateFile) {
  const overrides = state.capabilityOverrides?.[pluginId] ?? {};
  const capabilities: Record<string, boolean> = {};
  for (const capability of manifest.capabilities ?? []) capabilities[capability] = overrides[capability] ?? true;
  return capabilities;
}

export function withConfigDefaults(manifest: PluginManifest, config: Record<string, unknown>) {
  const next: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(manifest.configSchema?.properties ?? {})) if ('default' in property) next[key] = property.default;
  return { ...next, ...config };
}

export function isConfigured(manifest: PluginManifest, config: Record<string, unknown>) {
  const schema = manifest.configSchema;
  if (!schema?.properties) return true;
  for (const key of schema.required ?? []) {
    const value = config[key];
    if (value === undefined || value === null || value === '') return false;
  }
  return true;
}

export function sanitizeConfig(manifest: PluginManifest, config: Record<string, unknown>) {
  if (!manifest.configSchema?.properties || manifest.configSchema.additionalProperties !== false) return config;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(manifest.configSchema.properties)) if (key in config) next[key] = config[key];
  return next;
}

export async function resolveManifestPath(input: string) {
  const target = input.trim();
  if (!target) return null;
  const targetStat = await stat(target).catch(() => null);
  if (targetStat?.isFile() && path.basename(target) === 'plugin.json') return target;
  if (targetStat?.isDirectory()) {
    for (const candidate of [path.join(target, 'plugin.json'), path.join(target, '.openagent-plugin', 'plugin.json')]) if (await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(filePath: string) {
  return access(filePath, constants.F_OK).then(() => true, () => false);
}
