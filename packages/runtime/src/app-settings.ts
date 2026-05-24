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

export type OpenAgentAppSettingsUpdate = Partial<{
  runtime: Partial<OpenAgentAppSettings['runtime']>;
}>;

export function createDefaultOpenAgentAppSettings(): OpenAgentAppSettings {
  return {
    schemaVersion: 'openagent.settings.v1',
    runtime: {
      allowTextToolCallRecovery: true,
      autoApproveRuntimeApprovals: false,
      maxConsecutiveSameToolCalls: 5,
      maxConsecutiveSameToolResults: 3
    },
    updatedAt: new Date().toISOString()
  };
}

export function normalizeOpenAgentAppSettings(input: Partial<OpenAgentAppSettings>): OpenAgentAppSettings {
  const defaults = createDefaultOpenAgentAppSettings();
  return {
    schemaVersion: 'openagent.settings.v1',
    runtime: {
      allowTextToolCallRecovery: typeof input.runtime?.allowTextToolCallRecovery === 'boolean'
        ? input.runtime.allowTextToolCallRecovery
        : defaults.runtime.allowTextToolCallRecovery,
      autoApproveRuntimeApprovals: typeof input.runtime?.autoApproveRuntimeApprovals === 'boolean'
        ? input.runtime.autoApproveRuntimeApprovals
        : defaults.runtime.autoApproveRuntimeApprovals,
      maxConsecutiveSameToolCalls: normalizePositiveInteger(
        input.runtime?.maxConsecutiveSameToolCalls,
        defaults.runtime.maxConsecutiveSameToolCalls,
        2,
        20
      ),
      maxConsecutiveSameToolResults: normalizePositiveInteger(
        input.runtime?.maxConsecutiveSameToolResults,
        defaults.runtime.maxConsecutiveSameToolResults,
        2,
        20
      )
    },
    updatedAt: normalizeUpdatedAt(input.updatedAt)
  };
}

export function mergeOpenAgentAppSettingsUpdate(
  current: OpenAgentAppSettings,
  input: OpenAgentAppSettingsUpdate,
  updatedAt = new Date().toISOString()
) {
  return normalizeOpenAgentAppSettings({
    ...current,
    runtime: {
      ...current.runtime,
      ...(input.runtime ?? {})
    },
    updatedAt
  });
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
