import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createDefaultOpenAgentAppSettings,
  getOpenAgentPath,
  mergeOpenAgentAppSettingsUpdate,
  normalizeOpenAgentAppSettings,
  type OpenAgentAppSettings,
  type OpenAgentAppSettingsUpdate
} from '@openagent/runtime';

export type { OpenAgentAppSettings, OpenAgentAppSettingsUpdate } from '@openagent/runtime';

export function getOpenAgentAppSettingsPath() {
  return path.join(getOpenAgentSettingsDir(), 'openagent-settings.json');
}

export function getOpenAgentAppSettings(): OpenAgentAppSettings {
  const settingsPath = getOpenAgentAppSettingsPath();
  if (!existsSync(settingsPath)) {
    const settings = createDefaultOpenAgentAppSettings();
    writeOpenAgentAppSettings(settings);
    return settings;
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<OpenAgentAppSettings>;
    const normalized = normalizeOpenAgentAppSettings(parsed);
    if (parsed.updatedAt !== normalized.updatedAt || parsed.schemaVersion !== normalized.schemaVersion) {
      writeOpenAgentAppSettings(normalized);
    }
    return normalized;
  } catch {
    return createDefaultOpenAgentAppSettings();
  }
}

export function updateOpenAgentAppSettings(input: OpenAgentAppSettingsUpdate) {
  const current = getOpenAgentAppSettings();
  const next = mergeOpenAgentAppSettingsUpdate(current, input);
  writeOpenAgentAppSettings(next);
  return next;
}

function writeOpenAgentAppSettings(settings: OpenAgentAppSettings) {
  writeFileSync(getOpenAgentAppSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function getOpenAgentSettingsDir() {
  const settingsDir = getOpenAgentPath('settings');
  mkdirSync(settingsDir, { recursive: true });
  return settingsDir;
}
