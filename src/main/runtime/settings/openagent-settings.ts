import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OpenAgentAppSettings {
  schemaVersion: 'openagent.settings.v1';
  runtime: {
    allowTextToolCallRecovery: boolean;
  };
  updatedAt: string;
}

const DEFAULT_SETTINGS: OpenAgentAppSettings = {
  schemaVersion: 'openagent.settings.v1',
  runtime: {
    allowTextToolCallRecovery: true
  },
  updatedAt: new Date().toISOString()
};

export function getOpenAgentAppSettingsPath() {
  return path.join(getOpenAgentSettingsDir(), 'openagent-settings.json');
}

export function getOpenAgentAppSettings(): OpenAgentAppSettings {
  const settingsPath = getOpenAgentAppSettingsPath();
  if (!existsSync(settingsPath)) {
    writeOpenAgentAppSettings(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<OpenAgentAppSettings>;
    const normalized = normalizeOpenAgentAppSettings(parsed);
    if (parsed.updatedAt !== normalized.updatedAt || parsed.schemaVersion !== normalized.schemaVersion) {
      writeOpenAgentAppSettings(normalized);
    }
    return normalized;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function updateOpenAgentAppSettings(input: Partial<{ runtime: Partial<OpenAgentAppSettings['runtime']> }>) {
  const current = getOpenAgentAppSettings();
  const next: OpenAgentAppSettings = {
    ...current,
    runtime: {
      ...current.runtime,
      ...(input.runtime ?? {})
    },
    updatedAt: new Date().toISOString()
  };
  writeOpenAgentAppSettings(next);
  return next;
}

function normalizeOpenAgentAppSettings(input: Partial<OpenAgentAppSettings>): OpenAgentAppSettings {
  return {
    schemaVersion: 'openagent.settings.v1',
    runtime: {
      allowTextToolCallRecovery: typeof input.runtime?.allowTextToolCallRecovery === 'boolean'
        ? input.runtime.allowTextToolCallRecovery
        : DEFAULT_SETTINGS.runtime.allowTextToolCallRecovery
    },
    updatedAt: normalizeUpdatedAt(input.updatedAt)
  };
}

function normalizeUpdatedAt(value: unknown) {
  if (typeof value !== 'string' || !value || value === new Date(0).toISOString()) {
    return new Date().toISOString();
  }
  return value;
}

function writeOpenAgentAppSettings(settings: OpenAgentAppSettings) {
  writeFileSync(getOpenAgentAppSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function getOpenAgentSettingsDir() {
  const openAgentHome = process.env.OPENAGENT_HOME || path.join(os.homedir(), '.openagent');
  const settingsDir = path.join(openAgentHome, 'settings');
  mkdirSync(settingsDir, { recursive: true });
  return settingsDir;
}
