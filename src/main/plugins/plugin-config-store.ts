import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getOpenAgentHome } from '../runtime/knowledge/knowledge-paths.js';
import type { PluginStateFile } from './plugin-types.js';

export class PluginConfigStore {
  readonly settingsDir = path.join(getOpenAgentHome(), 'settings', 'plugins');
  readonly statePath = path.join(this.settingsDir, 'registry.json');
  private state: PluginStateFile = createDefaultState();

  async load() {
    await mkdir(this.settingsDir, { recursive: true });
    try {
      this.state = { ...createDefaultState(), ...JSON.parse(await readFile(this.statePath, 'utf8')) };
    } catch {
      this.state = createDefaultState();
    }
    if (this.repairEnabledFeishuCapabilities()) await this.save();
    return this.state;
  }

  getState() {
    return this.state;
  }

  async save() {
    await mkdir(this.settingsDir, { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  async setPluginsRoot(pluginsRoot: string) {
    this.state.pluginsRoot = pluginsRoot;
    await this.save();
  }

  getPluginConfig(pluginId: string) {
    return this.state.config?.[pluginId] ?? {};
  }

  async savePluginConfig(pluginId: string, config: Record<string, unknown>) {
    this.state.config = { ...(this.state.config ?? {}), [pluginId]: config };
    await this.save();
  }

  async setEnabled(pluginId: string, enabled: boolean) {
    this.state.enabled = { ...(this.state.enabled ?? {}), [pluginId]: enabled };
    await this.save();
  }

  async setCapability(pluginId: string, capability: string, enabled: boolean) {
    this.state.capabilityOverrides = {
      ...(this.state.capabilityOverrides ?? {}),
      [pluginId]: { ...(this.state.capabilityOverrides?.[pluginId] ?? {}), [capability]: enabled }
    };
    await this.save();
  }

  async addLocalManifest(manifestPath: string) {
    this.state.installedLocalManifests = [...new Set([...(this.state.installedLocalManifests ?? []), manifestPath])];
    await this.save();
  }

  private repairEnabledFeishuCapabilities() {
    const pluginId = 'openagent-plugin-feishu-cli';
    if (!this.state.enabled?.[pluginId]) return false;
    const current = this.state.capabilityOverrides?.[pluginId];
    if (!current) return false;

    const coreCapabilities = ['tools', 'skills', 'policy', 'settings'];
    const allKnownCapabilitiesDisabled = Object.values(current).length > 0 && Object.values(current).every((value) => value === false);
    const coreCapabilitiesDisabled = coreCapabilities.every((capability) => current[capability] === false);
    if (!allKnownCapabilitiesDisabled && !coreCapabilitiesDisabled) return false;

    this.state.capabilityOverrides = {
      ...(this.state.capabilityOverrides ?? {}),
      [pluginId]: {
        ...current,
        tools: true,
        skills: true,
        policy: true,
        settings: true
      }
    };
    return true;
  }
}

function createDefaultState(): PluginStateFile {
  return { schemaVersion: 1, enabled: {}, config: {}, capabilityOverrides: {}, installedLocalManifests: [] };
}
