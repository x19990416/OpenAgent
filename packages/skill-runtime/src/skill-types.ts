import type { RuntimeAttachment } from '@openagent/runtime';

export type SkillSource = 'system' | 'user' | 'agent' | 'workspace' | 'plugin';
export type SkillRisk = 'read' | 'write' | 'network' | 'external' | 'destructive';

export interface SkillResourceItem {
  path: string;
  kind: 'script' | 'template' | 'reference' | 'example' | 'asset';
  size?: number;
  description?: string;
}

export interface SkillScriptDescriptor {
  path: string;
  runtime?: 'python' | 'node' | 'shell' | 'binary' | string;
  description?: string;
  risk?: SkillRisk;
  timeoutMs?: number;
  network?: boolean;
  writes?: boolean;
  dependencies?: {
    pip?: string[];
    npm?: string[];
    system?: string[];
  };
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  displayName: string;
  description: string;
  source: SkillSource;
  sourceLabel: string;
  rootDir: string;
  skillFile: string;
  version?: string;
  tags: string[];
  risk: SkillRisk;
  allowedTools: string[];
  resources: SkillResourceItem[];
  scripts: SkillScriptDescriptor[];
  enabled: boolean;
  state: 'indexed' | 'enabled' | 'disabled' | 'failed';
  hash?: string;
  error?: string;
}

export interface SkillResolutionInput {
  prompt: string;
  attachments?: RuntimeAttachment[];
  selectedSkillId?: string | null;
}

export interface ResolvedSkillContext {
  summaries: SkillCatalogItem[];
  activeSkillNames: string[];
  promptBlock: string;
}

export interface SkillSettings {
  enabled?: Record<string, boolean>;
  trusted?: Partial<Record<SkillSource, boolean>>;
}

export interface PluginSkillPackage {
  pluginId: string;
  pluginName: string;
  name: string;
  description?: string;
  content?: string;
  rootDir?: string;
  skillFile?: string;
}

export interface SkillCandidate {
  source: SkillSource;
  rootDir: string;
}

export const SOURCE_LABELS: Record<SkillSource, string> = {
  system: 'System',
  user: 'User',
  agent: 'Agent',
  workspace: 'Workspace',
  plugin: 'Plugin'
};

export const SOURCE_PRIORITY: Record<SkillSource, number> = {
  workspace: 50,
  agent: 40,
  user: 30,
  plugin: 20,
  system: 10
};

export const DEFAULT_TRUST: Record<SkillSource, boolean> = {
  system: true,
  user: true,
  agent: true,
  workspace: false,
  plugin: false
};
