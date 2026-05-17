import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeTool } from '../runtime-types.js';
import { discoverSkillCandidates } from './skill-discovery.js';
import { parseCandidate } from './skill-parser.js';
import { buildSkillPromptBlock } from './skill-prompt.js';
import { resolveRelevantSkills } from './skill-resolver.js';
import { createSkillTools } from './skill-tools.js';
import { DEFAULT_TRUST, SOURCE_PRIORITY } from './skill-types.js';
import type { PluginSkillPackage, ResolvedSkillContext, SkillCatalogItem, SkillResolutionInput, SkillSettings } from './skill-types.js';
import { isSafeRealpath } from './skill-utils.js';
import { installLocalSkill } from './skill-installer.js';

export type { PluginSkillPackage, ResolvedSkillContext, SkillCatalogItem, SkillResolutionInput, SkillRisk, SkillSource } from './skill-types.js';

export class SkillService {
  private pluginSkills: PluginSkillPackage[] = [];
  private readonly settingsPath: string;
  private readonly stateDir: string;

  constructor(private readonly options: { agentId: string; workspaceRoot: string; appRoot?: string; openAgentRoot?: string }) {
    const openAgentRoot = options.openAgentRoot ?? process.env.OPENAGENT_HOME ?? path.join(process.env.HOME ?? '', '.openagent');
    this.settingsPath = path.join(openAgentRoot, 'settings', 'skills.json');
    this.stateDir = path.join(openAgentRoot, 'state');
    mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
  }

  setPluginSkills(skills: PluginSkillPackage[]) {
    this.pluginSkills = skills;
  }

  listSkills(): SkillCatalogItem[] {
    const settings = this.readSettings();
    const byName = new Map<string, SkillCatalogItem>();
    for (const candidate of this.discoverCandidates()) {
      const parsed = parseCandidate(candidate, settings);
      const existing = byName.get(parsed.name);
      if (!existing || SOURCE_PRIORITY[parsed.source] > SOURCE_PRIORITY[existing.source]) {
        byName.set(parsed.name, parsed);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  refreshSkills() {
    const skills = this.listSkills();
    const indexPath = path.join(this.stateDir, 'skills-index.json');
    writeFileSync(indexPath, `${JSON.stringify({ updatedAt: new Date().toISOString(), skills }, null, 2)}\n`, 'utf8');
    return skills;
  }

  getSkill(nameOrId: string) {
    const value = String(nameOrId || '').trim();
    return this.listSkills().find((skill) => skill.name === value || skill.id === value) ?? null;
  }

  setEnabled(nameOrId: string, enabled: boolean) {
    const skill = this.getSkill(nameOrId);
    if (!skill) return { ok: false, error: `Skill not found: ${nameOrId}` };
    const settings = this.readSettings();
    settings.enabled = settings.enabled ?? {};
    settings.enabled[skill.name] = enabled;
    this.writeSettings(settings);
    return { ok: true, skill: this.getSkill(skill.name) };
  }

  testSkill(nameOrId: string) {
    const skill = this.getSkill(nameOrId);
    if (!skill) return { ok: false, error: `Skill not found: ${nameOrId}` };
    const checks = [
      { name: 'SKILL.md exists', ok: existsSync(skill.skillFile), message: skill.skillFile },
      { name: 'description', ok: Boolean(skill.description.trim()), message: skill.description ? 'ok' : 'description is required' },
      { name: 'root realpath', ok: isSafeRealpath(skill.rootDir), message: skill.rootDir }
    ];
    return { ok: checks.every((check) => check.ok), skill, checks };
  }

  installLocal(input: { sourceDir: string; target?: 'user' | 'agent' | 'workspace'; overwrite?: boolean }) {
    const result = installLocalSkill({
      ...input,
      agentId: this.options.agentId,
      workspaceRoot: this.options.workspaceRoot,
      openAgentRoot: this.options.openAgentRoot
    });
    if (!result.ok) return result;
    return { ...result, skills: this.refreshSkills() };
  }

  resolveForPrompt(input: SkillResolutionInput): ResolvedSkillContext {
    const prompt = input.prompt || '';
    const selectedSkillId = String(input.selectedSkillId || '').trim();
    const attachments = input.attachments ?? [];
    const ranked = resolveRelevantSkills({
      skills: this.listSkills().filter((skill) => skill.enabled),
      prompt,
      attachments,
      selectedSkillId
    });
    const promptBlock = buildSkillPromptBlock(ranked);
    return { summaries: ranked, activeSkillNames: ranked.map((skill) => skill.name), promptBlock };
  }

  createTools(): RuntimeTool[] {
    return createSkillTools({
      listSkills: () => this.listSkills(),
      requireSkill: (nameOrId) => this.requireSkill(nameOrId),
      workspaceRoot: this.options.workspaceRoot
    });
  }

  private discoverCandidates() {
    return discoverSkillCandidates({
      agentId: this.options.agentId,
      workspaceRoot: this.options.workspaceRoot,
      appRoot: this.options.appRoot,
      stateDir: this.stateDir,
      pluginSkills: this.pluginSkills
    });
  }

  private requireSkill(nameOrId: string) {
    const skill = this.getSkill(nameOrId);
    if (!skill) throw new Error(`Skill not found: ${nameOrId}`);
    return skill;
  }

  private readSettings(): SkillSettings {
    if (!existsSync(this.settingsPath)) {
      const defaults: SkillSettings = { enabled: {}, trusted: DEFAULT_TRUST };
      this.writeSettings(defaults);
      return defaults;
    }
    try {
      return JSON.parse(readFileSync(this.settingsPath, 'utf8')) as SkillSettings;
    } catch {
      return { enabled: {}, trusted: DEFAULT_TRUST };
    }
  }

  private writeSettings(settings: SkillSettings) {
    mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}
