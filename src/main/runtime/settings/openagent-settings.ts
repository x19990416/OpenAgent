import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getOpenAgentPath } from '../openagent-home.js';

export interface OpenAgentAppSettings {
  schemaVersion: 'openagent.settings.v1';
  runtime: {
    allowTextToolCallRecovery: boolean;
    autoApproveRuntimeApprovals: boolean;
    maxConsecutiveSameToolCalls: number;
    maxConsecutiveSameToolResults: number;
  };
  updatedAt: string;
}

const DEFAULT_SETTINGS: OpenAgentAppSettings = {
  schemaVersion: 'openagent.settings.v1',
  runtime: {
    allowTextToolCallRecovery: true,
    autoApproveRuntimeApprovals: false,
    maxConsecutiveSameToolCalls: 5,
    maxConsecutiveSameToolResults: 3
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
  const next = normalizeOpenAgentAppSettings({
    ...current,
    runtime: {
      ...current.runtime,
      ...(input.runtime ?? {})
    },
    updatedAt: new Date().toISOString()
  });
  writeOpenAgentAppSettings(next);
  return next;
}

function normalizeOpenAgentAppSettings(input: Partial<OpenAgentAppSettings>): OpenAgentAppSettings {
  return {
    schemaVersion: 'openagent.settings.v1',
    runtime: {
      allowTextToolCallRecovery: typeof input.runtime?.allowTextToolCallRecovery === 'boolean'
        ? input.runtime.allowTextToolCallRecovery
        : DEFAULT_SETTINGS.runtime.allowTextToolCallRecovery,
      autoApproveRuntimeApprovals: typeof input.runtime?.autoApproveRuntimeApprovals === 'boolean'
        ? input.runtime.autoApproveRuntimeApprovals
        : DEFAULT_SETTINGS.runtime.autoApproveRuntimeApprovals,
      maxConsecutiveSameToolCalls: normalizePositiveInteger(
        input.runtime?.maxConsecutiveSameToolCalls,
        DEFAULT_SETTINGS.runtime.maxConsecutiveSameToolCalls,
        2,
        20
      ),
      maxConsecutiveSameToolResults: normalizePositiveInteger(
        input.runtime?.maxConsecutiveSameToolResults,
        DEFAULT_SETTINGS.runtime.maxConsecutiveSameToolResults,
        2,
        20
      )
    },
    updatedAt: normalizeUpdatedAt(input.updatedAt)
  };
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
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
  const settingsDir = getOpenAgentPath('settings');
  mkdirSync(settingsDir, { recursive: true });
  return settingsDir;
}
