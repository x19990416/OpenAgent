import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import electron from 'electron';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeTool } from '../runtime/runtime-types.js';
import { getOpenAgentHome } from '../runtime/knowledge/knowledge-paths.js';
import { PluginConfigStore } from './plugin-config-store.js';
import { PluginSecretStore } from './plugin-secret-store.js';
import { PluginLoader } from './plugin-loader.js';
import { PluginRuntimeBridge } from './plugin-runtime-bridge.js';
import {
  PluginRegistry,
  computeCapabilities,
  isConfigured,
  resolveManifestPath,
  sanitizeConfig,
  validateManifest,
  withConfigDefaults
} from './plugin-registry.js';
import type { PluginInstallState, PluginRecord, PluginRegistrationResult, PluginRegistrySnapshot } from './plugin-types.js';

const { shell } = electron;

export class PluginService {
  private readonly configStore = new PluginConfigStore();
  private readonly secretStore = new PluginSecretStore();
  private readonly registry = new PluginRegistry(() => this.configStore.getState());
  private readonly runtimeBridge = new PluginRuntimeBridge();
  private readonly loader = new PluginLoader(
    this.configStore,
    this.secretStore,
    (input) => this.runtimeBridge.submitPrompt(input),
    (listener) => this.runtimeBridge.subscribe(listener)
  );
  private readonly logDir = path.join(getOpenAgentHome(), 'logs', 'plugins');
  private readonly registrations = new Map<string, PluginRegistrationResult>();
  private records = new Map<string, PluginRecord>();
  private lastDiscoveredAt: string | null = null;
  private lastLoadedAt: string | null = null;

  setRuntimeSubmitHandler(handler: (input: unknown) => Promise<unknown>) {
    this.runtimeBridge.setSubmitHandler(handler);
  }

  dispatchUiEvent(event: import('../runtime/runtime-types.js').RuntimeUiEvent) {
    this.runtimeBridge.dispatch(event);
    for (const registration of this.registrations.values()) {
      for (const renderer of registration.remoteUiRenderers) {
        void Promise.resolve(renderer.render?.(event)).catch(() => undefined);
      }
    }
  }

  async initialize() {
    await this.ensureDirs();
    await this.configStore.load();
    await this.secretStore.load();
    await this.discover({ pluginsRoot: this.configStore.getState().pluginsRoot, includeBuiltins: true });
    await this.load({ onlyEnabled: true });
    return this.getRegistry();
  }

  getRegistry(): PluginRegistrySnapshot {
    return {
      schemaVersion: 1,
      pluginsRoot: this.configStore.getState().pluginsRoot || '',
      lastDiscoveredAt: this.lastDiscoveredAt,
      lastLoadedAt: this.lastLoadedAt,
      plugins: [...this.records.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
    };
  }

  async discover(input: { pluginsRoot?: string; includeBuiltins?: boolean } = {}) {
    await this.ensureDirs();
    await this.configStore.load();
    await this.secretStore.load();
    if (typeof input.pluginsRoot === 'string') await this.configStore.setPluginsRoot(input.pluginsRoot);
    this.records = await this.registry.discover({ pluginsRoot: this.configStore.getState().pluginsRoot, includeBuiltins: input.includeBuiltins });
    for (const record of this.records.values()) this.refreshRecordDerivedState(record);
    this.lastDiscoveredAt = new Date().toISOString();
    return { ok: true, registry: this.getRegistry(), discoveredCount: this.records.size };
  }

  async installLocal(manifestPathOrRoot: string) {
    const manifestPath = await resolveManifestPath(manifestPathOrRoot);
    if (!manifestPath) return { ok: false, error: '未找到 plugin.json 或 .openagent-plugin/plugin.json', registry: this.getRegistry() };
    const installedManifestPath = await this.installPluginPackage(manifestPath);
    await this.configStore.addLocalManifest(installedManifestPath);
    await this.discover({ pluginsRoot: this.configStore.getState().pluginsRoot, includeBuiltins: true });
    const installedRecord = [...this.records.values()].find((record) => record.manifestPath === installedManifestPath);
    if (!installedRecord) return { ok: false, error: '插件已复制，但未能重新发现安装后的 manifest。', registry: this.getRegistry() };
    for (const dependency of installedRecord.manifest.runtimeDependencies ?? []) {
      const result = await this.installDependency({ pluginId: installedRecord.id, dependencyId: dependency.id });
      if (!result.ok) return { ...result, registry: this.getRegistry() };
    }
    this.refreshRecordDerivedState(installedRecord);
    return { ok: true, plugin: installedRecord, registry: this.getRegistry() };
  }

  async load(input: { pluginIds?: string[]; pluginNames?: string[]; onlyEnabled?: boolean } = {}) {
    await this.configStore.load();
    await this.secretStore.load();
    if (this.records.size === 0) await this.discover({ pluginsRoot: this.configStore.getState().pluginsRoot, includeBuiltins: true });
    const wanted = new Set([...(input.pluginIds ?? []), ...(input.pluginNames ?? [])]);
    let loadedCount = 0;
    for (const record of this.records.values()) {
      if (wanted.size > 0 && !wanted.has(record.id) && !wanted.has(record.name)) continue;
      if (input.onlyEnabled && !record.enabled) continue;
      this.refreshRecordDerivedState(record);
      const validationErrors = validateManifest(record.manifest);
      if (validationErrors.length > 0) {
        record.status = 'error';
        record.validationErrors = validationErrors;
        record.lastError = validationErrors.join('; ');
        this.registrations.delete(record.id);
        continue;
      }
      if (!record.enabled) {
        record.status = 'disabled';
        this.registrations.delete(record.id);
        continue;
      }
      const configState = this.computeConfigState(record);
      if (configState !== 'ready') {
        record.status = configState;
        record.lastError = configState === 'needs_config'
          ? '插件普通配置尚未完成。'
          : configState === 'needs_auth'
            ? '插件授权或密钥尚未完成。'
            : record.lastError;
        this.registrations.delete(record.id);
        continue;
      }
      try {
        const registration = await this.loader.load(record);
        this.registrations.set(record.id, registration);
        this.applyRegistrationToRecord(record, registration);
        record.status = 'loaded';
        record.lastLoadedAt = new Date().toISOString();
        record.lastError = undefined;
        loadedCount += 1;
      } catch (error) {
        record.status = 'error';
        record.lastError = error instanceof Error ? error.message : String(error);
        this.registrations.delete(record.id);
        await this.appendLog(record.id, `load failed ${record.lastError}`);
      }
    }
    this.lastLoadedAt = new Date().toISOString();
    return { ok: true, registry: this.getRegistry(), loadedCount };
  }

  async setEnabled(input: { pluginId?: string; pluginName?: string; enabled?: boolean }) {
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    if (!record) return { ok: false, error: 'Plugin not found', registry: this.getRegistry() };
    if (!record.installed) return { ok: false, error: '请先安装插件，再启用。', registry: this.getRegistry() };
    await this.configStore.setEnabled(record.id, Boolean(input.enabled));
    record.enabled = Boolean(input.enabled);
    this.refreshRecordDerivedState(record);
    if (!record.enabled) this.registrations.delete(record.id);
    return { ok: true, registry: this.getRegistry(), plugin: record };
  }

  async getConfig(input: { pluginId?: string; pluginName?: string }) {
    await this.configStore.load();
    await this.secretStore.load();
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    if (!record) return { ok: false, error: 'Plugin not found' };
    return {
      ok: true,
      pluginId: record.id,
      config: withConfigDefaults(record.manifest, this.configStore.getPluginConfig(record.id)),
      secrets: this.maskSecrets(record),
      updatedAt: new Date().toISOString()
    };
  }

  async saveConfig(input: { pluginId?: string; pluginName?: string; config?: Record<string, unknown> }) {
    await this.configStore.load();
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    if (!record) return { ok: false, error: 'Plugin not found', registry: this.getRegistry() };
    const config = sanitizeConfig(record.manifest, input.config ?? {});
    await this.configStore.savePluginConfig(record.id, config);
    this.refreshRecordDerivedState(record);
    return { ok: true, pluginId: record.id, config: withConfigDefaults(record.manifest, config), registry: this.getRegistry() };
  }

  async setSecret(input: { pluginId?: string; pluginName?: string; key?: string; value?: string }) {
    await this.secretStore.load();
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    const key = String(input.key || '');
    if (!record) return { ok: false, error: 'Plugin not found', registry: this.getRegistry() };
    if (!key || !record.manifest.secretSchema?.properties?.[key]) return { ok: false, error: 'Secret key is not declared by plugin', registry: this.getRegistry() };
    if (input.value) await this.secretStore.set(record.id, key, String(input.value));
    else await this.secretStore.delete(record.id, key);
    this.refreshRecordDerivedState(record);
    return { ok: true, pluginId: record.id, secrets: this.maskSecrets(record), registry: this.getRegistry() };
  }

  async setCapability(input: { pluginId?: string; pluginName?: string; capability?: string; enabled?: boolean }) {
    await this.configStore.load();
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    const capability = String(input.capability || '');
    if (!record) return { ok: false, error: 'Plugin not found', registry: this.getRegistry() };
    if (!record.manifest.capabilities?.includes(capability as never)) return { ok: false, error: 'Capability is not declared by plugin', registry: this.getRegistry() };
    await this.configStore.setCapability(record.id, capability, Boolean(input.enabled));
    this.refreshRecordDerivedState(record);
    return { ok: true, plugin: record, registry: this.getRegistry() };
  }


  async installDependency(input: { pluginId?: string; pluginName?: string; dependencyId?: string }) {
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    if (!record) return { ok: false, error: 'Plugin not found', registry: this.getRegistry() };
    const dependency = (record.manifest.runtimeDependencies ?? []).find((item) => item.id === input.dependencyId) ?? record.manifest.runtimeDependencies?.[0];
    if (!dependency) return { ok: false, error: 'Plugin has no declared runtime dependency', registry: this.getRegistry() };
    if (dependency.type !== 'npm') return { ok: false, error: `Unsupported dependency type: ${dependency.type}`, registry: this.getRegistry() };

    const installRoot = path.join(getOpenAgentHome(), 'plugins', record.id, 'deps');
    await mkdir(installRoot, { recursive: true });
    await this.appendLog(record.id, `install dependency ${dependency.packageName}@${dependency.version || 'latest'} prefix=${installRoot}`);
    const result = await runCommand('npm', ['install', `${dependency.packageName}@${dependency.version || 'latest'}`, '--prefix', installRoot], 180_000);
    if (result.exitCode !== 0) {
      const error = result.stderr || result.stdout || `npm install exited with ${result.exitCode}`;
      await this.appendLog(record.id, `install dependency failed ${error}`);
      return { ok: false, error, stdout: result.stdout, stderr: result.stderr, registry: this.getRegistry() };
    }

    const binaryPath = path.join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${dependency.binary || dependency.id}.cmd` : dependency.binary || dependency.id);
    const installedVersion = await this.readInstalledNpmVersion(installRoot, dependency.packageName);
    await this.configStore.savePluginConfig(record.id, {
      ...this.configStore.getPluginConfig(record.id),
      cliPath: binaryPath,
      runtimeDependencyVersions: {
        ...((this.configStore.getPluginConfig(record.id).runtimeDependencyVersions as Record<string, string> | undefined) ?? {}),
        [dependency.id]: installedVersion || dependency.version || 'latest'
      }
    });
    this.refreshRecordDerivedState(record);
    await this.appendLog(record.id, `install dependency ok binary=${binaryPath} version=${installedVersion || 'unknown'}`);
    return { ok: true, dependency, binaryPath, installedVersion, stdout: result.stdout, stderr: result.stderr, registry: this.getRegistry() };
  }

  async authorize(
    input: { pluginId?: string; pluginName?: string; domains?: string[] | string },
    events?: { onAuthorizationUrl?: (payload: { pluginId: string; authUrl: string; message: string }) => void }
  ) {
    await this.configStore.load();
    await this.secretStore.load();
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    if (!record) return { ok: false, error: 'Plugin not found', registry: this.getRegistry() };
    if (record.id !== 'openagent-plugin-feishu-cli') {
      return { ok: false, error: '当前只支持飞书 CLI 插件授权。', registry: this.getRegistry() };
    }

    const secrets = this.secretStore.getAll(record.id);
    const appId = secrets.appId;
    const appSecret = secrets.appSecret;
    if (!appId || !appSecret) {
      return { ok: false, error: '请先在“密钥 / 授权”中保存 App ID 和 App Secret。', registry: this.getRegistry() };
    }

    const cliPath = String(this.configStore.getPluginConfig(record.id).cliPath || getPrivateLarkCliPath(record.id));
    const domains = Array.isArray(input.domains) ? input.domains.join(',') : String(input.domains || 'all');
    await this.appendLog(record.id, `authorize domains=${domains}`);

    const initResult = await runCommand(
      cliPath,
      ['config', 'init', '--name', 'openagent', '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'],
      30_000,
      `${appSecret}\n`
    );
    if (initResult.exitCode !== 0) {
      const error = initResult.stderr || initResult.stdout || `config init exited with ${initResult.exitCode}`;
      await this.appendLog(record.id, `authorize config init failed ${error}`);
      return { ok: false, error, stdout: initResult.stdout, stderr: initResult.stderr, registry: this.getRegistry() };
    }

    const authResult = await runCommand(
      cliPath,
      ['--profile', 'openagent', 'auth', 'login', '--domain', domains, '--no-wait', '--json'],
      30_000
    );
    const parsed = parseJson(authResult.stdout);
    const authUrl = findAuthUrl(parsed) || findAuthUrl(authResult.stdout);
    const deviceCode = findDeviceCode(parsed) || findDeviceCode(authResult.stdout);
    if (authUrl) {
      const message = '已打开默认浏览器，请在 5 分钟内完成飞书授权。';
      events?.onAuthorizationUrl?.({ pluginId: record.id, authUrl, message });
      void shell.openExternal(authUrl).catch(async (error) => {
        await this.appendLog(record.id, `authorize open url failed ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (authResult.exitCode !== 0) {
      const error = authResult.stderr || authResult.stdout || `auth login exited with ${authResult.exitCode}`;
      await this.appendLog(record.id, `authorize failed ${error}`);
      return { ok: false, error, stdout: authResult.stdout, stderr: authResult.stderr, data: parsed, authUrl, deviceCode, registry: this.getRegistry() };
    }

    await this.configStore.setEnabled(record.id, true);
    for (const capability of record.manifest.capabilities ?? []) {
      await this.configStore.setCapability(record.id, capability, true);
    }
    record.enabled = true;
    this.refreshRecordDerivedState(record);
    if (!deviceCode) {
      await this.appendLog(record.id, `authorize started without device code domains=${domains}`);
      return {
        ok: true,
        domains,
        authUrl,
        stdout: authResult.stdout,
        stderr: authResult.stderr,
        data: parsed,
        message: authUrl ? `已发起飞书授权，请打开授权链接完成授权：${authUrl}` : '已发起飞书授权，请按 CLI 返回信息完成授权。',
        registry: this.getRegistry()
      };
    }

    await this.appendLog(record.id, `authorize polling started domains=${domains} authUrl=${authUrl ? '[present]' : '[missing]'} deviceCode=[present]`);
    const completion = await runCommand(
      cliPath,
      ['--profile', 'openagent', 'auth', 'login', '--device-code', deviceCode, '--json'],
      300_000
    );
    const completionData = parseJson(completion.stdout);
    if (completion.exitCode !== 0) {
      const status = await getLarkAuthStatus(cliPath);
      if (status.ok) {
        await this.appendLog(record.id, `authorize polling completed after non-zero cli exit ${completion.exitCode}; auth status ok`);
      } else {
        const error = normalizeLarkAuthError(completion, status);
        await this.appendLog(record.id, `authorize polling failed ${error}`);
        return {
          ok: false,
          error,
          domains,
          authUrl,
          stdout: completion.stdout,
          stderr: completion.stderr,
          data: completionData,
          status,
          registry: this.getRegistry()
        };
      }
    }

    await this.appendLog(record.id, 'authorize polling completed');
    await this.load({ pluginIds: [record.id] });
    return {
      ok: true,
      domains,
      authUrl,
      stdout: completion.stdout,
      stderr: completion.stderr,
      data: completionData,
      message: '飞书授权已完成，用户 token 已保存到 lark-cli profile。',
      registry: this.getRegistry()
    };
  }

  async testPlugin(input: { pluginId?: string; pluginName?: string }) {
    const record = this.findRecord(input.pluginId || input.pluginName || '');
    if (!record) return { ok: false, error: 'Plugin not found', registry: this.getRegistry() };
    this.refreshRecordDerivedState(record);
    const checks: Array<{ name: string; ok: boolean; message: string }> = [];
    const validationErrors = validateManifest(record.manifest);
    checks.push({ name: 'manifest', ok: validationErrors.length === 0, message: validationErrors.length ? validationErrors.join('; ') : 'manifest 校验通过' });
    checks.push({ name: 'config', ok: Boolean(record.configured), message: record.configured ? '普通配置完整' : '普通配置缺失或不完整' });
    checks.push({ name: 'secret', ok: Boolean(record.authorized), message: record.authorized ? '必要密钥已配置' : '必要密钥尚未配置' });

    const existingRegistration = this.registrations.get(record.id);
    const testTool = existingRegistration?.tools.find((tool) => tool.name.endsWith('.test_connection'));
    if (testTool) {
      const controller = new AbortController();
      const result = await testTool.execute({ toolCallId: `${record.id}-test`, input: {}, signal: controller.signal });
      checks.push({ name: 'tool', ok: result.ok, message: result.content });
    }

    const ok = checks.every((check) => check.ok);
    record.lastTestedAt = new Date().toISOString();
    record.status = ok ? (record.enabled && existingRegistration ? 'loaded' : 'ready') : 'error';
    record.lastError = ok ? undefined : checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`).join('; ');
    await this.appendLog(record.id, `test ${ok ? 'ok' : 'failed'} ${JSON.stringify(checks)}`);
    return { ok, checks, registry: this.getRegistry(), error: ok ? undefined : record.lastError };
  }

  getRuntimeTools(): RuntimeTool[] {
    const tools: RuntimeTool[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.status !== 'loaded' || !record.capabilities.tools) continue;
      tools.push(...(this.registrations.get(record.id)?.tools ?? []));
    }
    return tools;
  }

  getSkillPackages() {
    const packages: Array<{ pluginId: string; pluginName: string; name: string; description?: string; content?: string; rootDir?: string; skillFile?: string }> = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.status !== 'loaded' || !record.capabilities.skills) continue;
      const skills = record.skills;
      const pluginName = record.manifest.interface?.displayName ?? record.name;
      for (const skill of skills) {
        const rootDir = typeof skill.rootDir === 'string'
          ? skill.rootDir
          : typeof skill.path === 'string' && record.rootPath && !record.rootPath.startsWith('builtin:')
            ? path.resolve(record.rootPath, skill.path.endsWith('SKILL.md') ? path.dirname(skill.path) : skill.path)
            : undefined;
        const skillFile = typeof skill.path === 'string' && record.rootPath && !record.rootPath.startsWith('builtin:')
          ? path.resolve(record.rootPath, skill.path)
          : undefined;
        packages.push({
          pluginId: record.id,
          pluginName,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          rootDir,
          skillFile
        });
      }
    }
    return packages;
  }

  getRelevantSkillSummaries(prompt: string): string[] {
    const summaries: string[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || !record.capabilities.skills) continue;
      const displayName = record.manifest.interface?.displayName ?? record.name;
      const tools = this.registrations.get(record.id)?.tools ?? record.tools ?? [];
      const agents = record.manifest.agents ?? [];
      if (agents.length > 0 || tools.length > 0) {
        const toolNames = tools.map((tool) => tool.name).filter(Boolean);
        summaries.push([
          `- ${displayName} 插件声明的可用 agent/tool（由 LLM 根据用户意图决定是否调用）:`,
          ...agents.map((agent) => `  - agent ${agent.id}: ${agent.description ?? agent.name}`),
          ...toolNames.map((name) => `  - tool ${name}`)
        ].join('\n'));
      }
    }
    return summaries;
  }

  private refreshRecordDerivedState(record: PluginRecord) {
    const state = this.configStore.getState();
    record.enabled = Boolean(record.installed && state.enabled?.[record.id]);
    record.capabilities = computeCapabilities(record.manifest, record.id, state);
    const config = withConfigDefaults(record.manifest, state.config?.[record.id] ?? {});
    record.configured = isConfigured(record.manifest, config);
    record.authorized = this.isAuthorized(record);
    if (record.status !== 'loaded' && record.status !== 'error') record.status = !record.installed ? 'discovered' : record.enabled ? this.computeConfigState(record) : 'disabled';
  }

  private applyRegistrationToRecord(record: PluginRecord, registration: PluginRegistrationResult) {
    const skillsByName = new Map<string, { name: string; description?: string; path?: string; content?: string; rootDir?: string }>(
      (record.manifest.skills ?? []).map((skill) => [skill.name, { name: skill.name, description: skill.description, path: skill.path, content: skill.content }])
    );
    for (const skill of registration.skills) {
      skillsByName.set(skill.name, { name: skill.name, description: skill.description, path: skill.path, content: skill.content, rootDir: skill.rootDir });
    }
    record.skills = [...skillsByName.values()];
    record.tools = registration.tools.map((tool) => ({ name: tool.name, description: tool.description, risk: tool.risk }));
    record.policy = registration.policies.flatMap((policy) => policy.tools ?? record.tools.map((tool) => ({ toolName: tool.name, risk: tool.risk ?? 'read', requiresApproval: tool.risk !== 'read', description: tool.description })));
  }

  private computeConfigState(record: PluginRecord): PluginInstallState {
    if (record.validationErrors?.length) return 'error';
    if (!record.installed) return 'discovered';
    if (!record.configured) return 'needs_config';
    if (!record.authorized) return 'needs_auth';
    return 'ready';
  }

  private isAuthorized(record: PluginRecord) {
    const keys = Object.keys(record.manifest.secretSchema?.properties ?? {});
    if (keys.length === 0) return true;
    const secrets = this.secretStore.getAll(record.id);
    if (record.id === 'openagent-plugin-feishu-cli') return Boolean((secrets.appId && secrets.appSecret) || secrets.accessToken);
    return keys.some((key) => Boolean(secrets[key]));
  }

  private maskSecrets(record: PluginRecord) {
    return this.secretStore.mask(record.id, Object.keys(record.manifest.secretSchema?.properties ?? {}));
  }

  private findRecord(idOrName: string) {
    return this.records.get(idOrName) ?? [...this.records.values()].find((record) => record.name === idOrName) ?? null;
  }

  private async ensureDirs() {
    await mkdir(this.logDir, { recursive: true });
  }

  private async installPluginPackage(manifestPath: string) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { id?: string; name?: string };
    const pluginId = safeFileName(String(manifest.id || manifest.name || path.basename(path.dirname(manifestPath))));
    const sourceRoot = path.dirname(manifestPath);
    const pluginsRoot = path.join(getOpenAgentHome(), 'plugins');
    const destinationRoot = path.join(pluginsRoot, pluginId);
    await mkdir(pluginsRoot, { recursive: true });
    await cp(sourceRoot, destinationRoot, {
      recursive: true,
      force: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}node_modules`)
    });
    return path.join(destinationRoot, path.basename(manifestPath));
  }

  private async readInstalledNpmVersion(installRoot: string, packageName: string) {
    const packageJsonPath = path.join(installRoot, 'node_modules', ...packageName.split('/'), 'package.json');
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
      return typeof pkg.version === 'string' ? pkg.version : '';
    } catch {
      return '';
    }
  }

  private async appendLog(pluginId: string, text: string) {
    const line = `${new Date().toISOString()} ${redact(text)}\n`;
    await writeFile(path.join(this.logDir, `${safeFileName(pluginId)}.log`), line, { flag: 'a' }).catch(() => undefined);
  }
}

function safeFileName(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function redact(text: string) {
  return text.replace(/(appSecret|accessToken|refreshToken|verificationToken|encryptKey|authorization)[=:]\s*[^\s,}]+/gi, '$1=***');
}



type CommandResult = { exitCode: number; stdout: string; stderr: string };
type LarkAuthStatus = CommandResult & { ok: boolean; data: unknown };

async function getLarkAuthStatus(cliPath: string): Promise<LarkAuthStatus> {
  try {
    const result = await runCommand(cliPath, ['--profile', 'openagent', 'auth', 'status'], 15_000);
    const data = parseJson(result.stdout || result.stderr);
    const status = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const ok = status.ok === true || (status.identity === 'user' && status.tokenStatus === 'valid');
    return { ...result, ok, data };
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), ok: false, data: null };
  }
}

function normalizeLarkAuthError(result: CommandResult, status: LarkAuthStatus) {
  const raw = (result.stderr || result.stdout || `auth polling exited with ${result.exitCode}`).trim();
  const statusText = (status.stderr || status.stdout || '').trim();
  if (/device-flow:\s*token response received/i.test(raw)) {
    return [
      '飞书已经回传 token，但 lark-cli 没有完成本地用户 token 保存/读取。',
      statusText ? `auth status: ${statusText}` : raw,
      '请重新点击“授权所有能力”；如果仍失败，先在终端运行 `lark-cli --profile openagent auth status` 检查本机 keychain / CLI 配置。'
    ].join('\n');
  }
  return raw;
}

async function runCommand(command: string, args: string[], timeoutMs: number, stdin?: string) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: augmentPath(process.env.PATH || '') }
    });
    let stdout = '';
    let stderr = '';
    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timeout after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: stdout.slice(0, 12000), stderr: stderr.slice(0, 12000) });
    });
  });
}

function augmentPath(current: string) {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(os.homedir(), '.npm-global', 'bin')];
  return [...extra, current].filter(Boolean).join(path.delimiter);
}

function getPrivateLarkCliPath(pluginId: string) {
  return path.join(getOpenAgentHome(), 'plugins', pluginId, 'deps', 'node_modules', '.bin', process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
}

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function findAuthUrl(input: unknown): string | null {
  if (!input) return null;
  if (typeof input === 'string') {
    const match = input.match(/https?:\/\/\S+/);
    return match?.[0] ?? null;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findAuthUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['verification_uri_complete', 'verificationUrl', 'verification_url', 'authUrl', 'auth_url', 'url', 'verification_uri']) {
      const value = record[key];
      if (typeof value === 'string' && value.startsWith('http')) return value;
    }
    for (const value of Object.values(record)) {
      const found = findAuthUrl(value);
      if (found) return found;
    }
  }
  return null;
}

function findDeviceCode(input: unknown): string | null {
  if (!input) return null;
  if (typeof input === 'string') {
    const parsed = parseJson(input);
    return parsed ? findDeviceCode(parsed) : null;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findDeviceCode(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['device_code', 'deviceCode', 'code']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    for (const value of Object.values(record)) {
      const found = findDeviceCode(value);
      if (found) return found;
    }
  }
  return null;
}
