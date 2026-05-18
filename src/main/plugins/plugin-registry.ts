import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { PluginCapability, PluginManifest, PluginRecord, PluginStateFile, PluginToolPolicy } from './plugin-types.js';

export class PluginRegistry {
  constructor(private readonly getState: () => PluginStateFile) {}

  async discover(input: { pluginsRoot?: string; includeBuiltins?: boolean } = {}) {
    const state = this.getState();
    const root = typeof input.pluginsRoot === 'string' ? input.pluginsRoot : state.pluginsRoot || '';
    const next = new Map<string, PluginRecord>();
    const discoveredManifestPaths = [
      ...(input.includeBuiltins !== false ? await this.findFirstPartyManifestPaths() : []),
      ...await this.findLocalManifestPaths(root)
    ];
    for (const manifestPath of [...new Set(discoveredManifestPaths)]) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest;
        const record = this.createRecordFromManifest(manifest, { source: this.isFirstPartyManifestPath(manifestPath) ? 'first_party' : 'local', rootPath: path.dirname(manifestPath), manifestPath, installed: false });
        next.set(record.id, record);
      } catch (error) {
        const id = `invalid:${manifestPath}`;
        next.set(id, this.createInvalidRecord(id, manifestPath, error, this.isFirstPartyManifestPath(manifestPath) ? 'first_party' : 'local'));
      }
    }
    for (const manifestPath of [...new Set(state.installedLocalManifests ?? [])]) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest;
        const record = this.createRecordFromManifest(manifest, { source: 'local', rootPath: path.dirname(manifestPath), manifestPath, installed: true });
        next.set(record.id, record);
      } catch (error) {
        const id = `invalid:${manifestPath}`;
        next.set(id, this.createInvalidRecord(id, manifestPath, error, 'local'));
      }
    }
    return next;
  }

  async findFirstPartyManifestPaths() {
    return this.findLocalManifestPaths(path.join(process.cwd(), 'openagent-plugins'));
  }

  private isFirstPartyManifestPath(manifestPath: string) {
    const firstPartyRoot = path.resolve(process.cwd(), 'openagent-plugins');
    return path.resolve(manifestPath).startsWith(`${firstPartyRoot}${path.sep}`);
  }

  createRecordFromManifest(manifest: PluginManifest, source: { source: 'builtin' | 'first_party' | 'local'; rootPath?: string; manifestPath?: string; installed?: boolean }): PluginRecord {
    const state = this.getState();
    const validationErrors = validateManifest(manifest);
    const id = manifest.id || manifest.name || source.manifestPath || 'unknown-plugin';
    const installed = source.installed ?? source.source === 'builtin';
    const enabled = installed && Boolean(state.enabled?.[id]);
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
      source: source.source,
      installed
    };
    record.status = validationErrors.length ? 'error' : !installed ? 'discovered' : enabled ? 'installed' : 'disabled';
    return record;
  }

  createInvalidRecord(id: string, manifestPath: string, error: unknown, source: 'first_party' | 'local' = 'local'): PluginRecord {
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
      source,
      installed: false
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
