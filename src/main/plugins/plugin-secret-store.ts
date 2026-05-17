import electron from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getOpenAgentHome } from '../runtime/knowledge/knowledge-paths.js';

const { safeStorage } = electron;

export class PluginSecretStore {
  private readonly settingsDir = path.join(getOpenAgentHome(), 'settings', 'plugins');
  private readonly secretsPath = path.join(this.settingsDir, 'secrets.json');
  private secrets: Record<string, Record<string, string>> = {};

  async load() {
    await mkdir(this.settingsDir, { recursive: true });
    try {
      this.secrets = JSON.parse(await readFile(this.secretsPath, 'utf8'));
    } catch {
      this.secrets = {};
    }
  }

  get(pluginId: string, key: string) {
    const raw = this.secrets[pluginId]?.[key];
    return raw ? decryptSecret(raw) : null;
  }

  getAll(pluginId: string) {
    const raw = this.secrets[pluginId] ?? {};
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, decryptSecret(value)]));
  }

  async set(pluginId: string, key: string, value: string) {
    this.secrets = { ...this.secrets, [pluginId]: { ...(this.secrets[pluginId] ?? {}), [key]: encryptSecret(value) } };
    await this.save();
  }

  async delete(pluginId: string, key: string) {
    const next = { ...(this.secrets[pluginId] ?? {}) };
    delete next[key];
    this.secrets = { ...this.secrets, [pluginId]: next };
    await this.save();
  }

  mask(pluginId: string, keys: string[]) {
    const pluginSecrets = this.getAll(pluginId);
    return Object.fromEntries(keys.map((key) => [key, { configured: Boolean(pluginSecrets[key]), maskedValue: pluginSecrets[key] ? '••••••••' : '' }]));
  }

  private async save() {
    await mkdir(this.settingsDir, { recursive: true });
    await writeFile(this.secretsPath, JSON.stringify(this.secrets, null, 2), 'utf8');
  }
}


function encryptSecret(value: string) {
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:v1:${safeStorage.encryptString(value).toString('base64')}`;
  }
  return `plain:v1:${Buffer.from(value, 'utf8').toString('base64')}`;
}

function decryptSecret(value: string) {
  if (value.startsWith('safe:v1:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice('safe:v1:'.length), 'base64'));
    } catch {
      return '';
    }
  }
  if (value.startsWith('plain:v1:')) {
    return Buffer.from(value.slice('plain:v1:'.length), 'base64').toString('utf8');
  }
  // Backward compatibility for secrets written before encrypted storage existed.
  return value;
}
