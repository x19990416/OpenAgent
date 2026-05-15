import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { feishuCliPlugin } from './builtins/feishu-cli-plugin.js';
import { createPluginContext } from './plugin-context.js';
import type { PluginConfigStore } from './plugin-config-store.js';
import type { PluginSecretStore } from './plugin-secret-store.js';
import type { OpenAgentPlugin, PluginEventSubscribe, PluginRecord, PluginRegistrationResult, PluginRuntimeSubmit } from './plugin-types.js';

const BUILTIN_PLUGINS: Record<string, OpenAgentPlugin> = {
  'builtin:feishu-cli': feishuCliPlugin
};

export class PluginLoader {
  constructor(
    private readonly configStore: PluginConfigStore,
    private readonly secretStore: PluginSecretStore,
    private readonly runtimeSubmit?: PluginRuntimeSubmit,
    private readonly eventSubscribe?: PluginEventSubscribe
  ) {}

  async load(record: PluginRecord): Promise<PluginRegistrationResult> {
    const plugin = await this.resolvePlugin(record);
    const ctx = createPluginContext({
      pluginId: record.id,
      configStore: this.configStore,
      secretStore: this.secretStore,
      runtimeSubmit: this.runtimeSubmit,
      eventSubscribe: this.eventSubscribe
    });
    await plugin.register(ctx);
    return ctx.collector.result;
  }

  private async resolvePlugin(record: PluginRecord): Promise<OpenAgentPlugin> {
    const main = String(record.manifest.main || '');
    if (BUILTIN_PLUGINS[main]) return BUILTIN_PLUGINS[main];
    if (!record.rootPath) throw new Error(`Cannot load plugin without rootPath: ${record.id}`);
    const entryPath = path.isAbsolute(main) ? main : path.join(record.rootPath, main);
    await verifyEntryIntegrity(record, entryPath);
    const moduleUrl = `${pathToFileURL(entryPath).href}?t=${Date.now()}`;
    const mod = await import(moduleUrl);
    const plugin = (mod.default ?? mod.plugin ?? mod) as Partial<OpenAgentPlugin>;
    if (!plugin || typeof plugin.register !== 'function') {
      throw new Error(`Plugin entry must export default OpenAgentPlugin with register(ctx): ${entryPath}`);
    }
    return {
      id: String(plugin.id || record.id),
      name: String(plugin.name || record.name),
      register: plugin.register.bind(plugin)
    };
  }
}


async function verifyEntryIntegrity(record: PluginRecord, entryPath: string) {
  const expected = String(record.manifest.entrySha256 || record.manifest.trustedSha256 || '').trim().toLowerCase();
  if (!expected) return;
  const actual = createHash('sha256').update(await readFile(entryPath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Plugin entry sha256 mismatch for ${record.id}. expected=${expected} actual=${actual}`);
  }
}
