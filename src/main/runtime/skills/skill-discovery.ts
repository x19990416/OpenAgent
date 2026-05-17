import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PluginSkillPackage, SkillCandidate, SkillSource } from './skill-types.js';
import { safeFileName, safeIsDirectory, safeReaddir } from './skill-utils.js';

export function discoverSkillCandidates(input: { agentId: string; workspaceRoot: string; appRoot?: string; stateDir: string; pluginSkills: PluginSkillPackage[] }): SkillCandidate[] {
  const openAgentRoot = process.env.OPENAGENT_HOME ?? path.join(process.env.HOME ?? '', '.openagent');
  const roots: Array<{ source: SkillSource; dir: string }> = [
    { source: 'system', dir: path.resolve(input.appRoot ?? process.cwd(), 'skills') },
    { source: 'user', dir: path.join(openAgentRoot, 'skills') },
    { source: 'agent', dir: path.join(openAgentRoot, 'agents', input.agentId, 'skills') },
    { source: 'workspace', dir: path.join(input.workspaceRoot, '.openagent', 'skills') }
  ];
  const candidates: SkillCandidate[] = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    const entries = safeReaddir(root.dir);
    if (existsSync(path.join(root.dir, 'SKILL.md'))) candidates.push({ source: root.source, rootDir: root.dir });
    for (const entry of entries) {
      const fullPath = path.join(root.dir, entry);
      if (safeIsDirectory(fullPath) && existsSync(path.join(fullPath, 'SKILL.md'))) {
        candidates.push({ source: root.source, rootDir: fullPath });
      }
    }
  }
  for (const pluginSkill of input.pluginSkills) {
    const materialized = materializePluginSkill(pluginSkill, input.stateDir);
    if (materialized) candidates.push({ source: 'plugin', rootDir: materialized });
  }
  return candidates;
}

function materializePluginSkill(skill: PluginSkillPackage, stateDir: string) {
  if (skill.rootDir && existsSync(path.join(skill.rootDir, 'SKILL.md'))) return skill.rootDir;
  if (skill.skillFile && existsSync(skill.skillFile)) return path.dirname(skill.skillFile);
  const safePluginId = safeFileName(skill.pluginId || 'plugin');
  const safeSkillName = safeFileName(skill.name || 'plugin-skill');
  const rootDir = path.join(stateDir, 'plugin-skills', safePluginId, safeSkillName);
  mkdirSync(rootDir, { recursive: true });
  const skillFile = path.join(rootDir, 'SKILL.md');
  const content = skill.content?.trim() || [
    '---',
    `name: ${skill.name}`,
    `description: ${String(skill.description || `Skill provided by plugin ${skill.pluginName}.`).replace(/\n/g, ' ')}`,
    'risk: external',
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.description || `Use this skill for tasks related to plugin ${skill.pluginName}.`,
    '',
    '## Instructions',
    '',
    `- This skill is provided by plugin ${skill.pluginName} (${skill.pluginId}).`,
    '- Use plugin tools through OpenAgent ToolPolicy, approvals, logs, and UI events.',
    '- Do not access plugin secrets directly or ask the user to paste them into the prompt.'
  ].join('\n');
  writeFileSync(skillFile, `${content}\n`, 'utf8');
  return rootDir;
}
