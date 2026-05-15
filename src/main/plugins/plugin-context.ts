import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getOpenAgentHome } from '../runtime/knowledge/knowledge-paths.js';
import type { PluginConfigStore } from './plugin-config-store.js';
import type { PluginSecretStore } from './plugin-secret-store.js';
import type { OpenAgentPluginContext, PluginLogger, PluginRegistrationResult } from './plugin-types.js';

export class PluginRegistrationCollector {
  readonly result: PluginRegistrationResult = {
    channels: [],
    tools: [],
    skills: [],
    knowledgeProviders: [],
    remoteUiRenderers: [],
    policies: []
  };
}

export function createPluginContext(input: {
  pluginId: string;
  configStore: PluginConfigStore;
  secretStore: PluginSecretStore;
  runtimeSubmit?: (input: unknown) => Promise<unknown>;
  eventSubscribe?: (listener: (event: import('../runtime/runtime-types.js').RuntimeUiEvent) => void) => () => void;
}): OpenAgentPluginContext & { collector: PluginRegistrationCollector } {
  const collector = new PluginRegistrationCollector();
  const logger = createPluginLogger(input.pluginId);
  const ctx: OpenAgentPluginContext & { collector: PluginRegistrationCollector } = {
    pluginId: input.pluginId,
    collector,
    registerChannel: (channel) => collector.result.channels.push(channel),
    registerTool: (tool) => collector.result.tools.push({ ...tool, pluginId: tool.pluginId ?? input.pluginId }),
    registerSkill: (skill) => collector.result.skills.push(skill),
    registerKnowledgeProvider: (provider) => collector.result.knowledgeProviders.push(provider),
    registerRemoteUi: (renderer) => collector.result.remoteUiRenderers.push(renderer),
    registerPolicy: (policy) => collector.result.policies.push(policy),
    runtime: {
      submitPrompt: async (payload) => {
        if (!input.runtimeSubmit) throw new Error('Plugin runtime.submitPrompt is not available before RuntimeService is ready.');
        return input.runtimeSubmit(payload);
      }
    },
    events: {
      subscribe: (listener) => input.eventSubscribe?.(listener) ?? (() => undefined)
    },
    config: {
      get: async <T = unknown>(key: string) => (input.configStore.getPluginConfig(input.pluginId)[key] as T | undefined) ?? null,
      set: async <T = unknown>(key: string, value: T) => {
        await input.configStore.savePluginConfig(input.pluginId, { ...input.configStore.getPluginConfig(input.pluginId), [key]: value });
      }
    },
    secrets: {
      get: async (key: string) => input.secretStore.get(input.pluginId, key),
      set: async (key: string, value: string) => input.secretStore.set(input.pluginId, key, value),
      delete: async (key: string) => input.secretStore.delete(input.pluginId, key)
    },
    logger
  };
  return ctx;
}

function createPluginLogger(pluginId: string): PluginLogger {
  const logDir = path.join(getOpenAgentHome(), 'logs', 'plugins');
  const write = async (level: string, message: string, meta?: unknown) => {
    await mkdir(logDir, { recursive: true });
    const line = `${new Date().toISOString()} ${level} ${redact(message)}${meta === undefined ? '' : ` ${redact(JSON.stringify(meta))}`}\n`;
    await writeFile(path.join(logDir, `${safeFileName(pluginId)}.log`), line, { flag: 'a' }).catch(() => undefined);
  };
  return {
    info: (message, meta) => void write('info', message, meta),
    warn: (message, meta) => void write('warn', message, meta),
    error: (message, meta) => void write('error', message, meta)
  };
}

function safeFileName(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function redact(text: string) {
  return text.replace(/(appSecret|accessToken|refreshToken|verificationToken|encryptKey|authorization)[=:]\s*[^\s,}]+/gi, '$1=***');
}
