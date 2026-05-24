import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUILTIN_SKILL_NAMES = ['skill-creator', 'skill-installer'] as const;

export function ensureOpenAgentSystemSkills(openAgentRoot: string, appRoot?: string) {
  const userSkillsDir = path.join(openAgentRoot, 'skills');
  const systemSkillsDir = path.join(userSkillsDir, '.system');
  mkdirSync(systemSkillsDir, { recursive: true });

  const bundledSkillsDir = path.resolve(appRoot ?? process.cwd(), 'skills', '.system');
  const backupSkillsDir = path.join(os.homedir(), '.openagent-bk', 'agents', 'main', 'skills');
  for (const skillName of BUILTIN_SKILL_NAMES) {
    const sourceDir = resolveSourceSkillDir(skillName, bundledSkillsDir, backupSkillsDir);
    if (!sourceDir) continue;
    const targetDir = path.join(systemSkillsDir, skillName);
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });
  }
}

function resolveSourceSkillDir(skillName: (typeof BUILTIN_SKILL_NAMES)[number], bundledSkillsDir: string, backupSkillsDir: string) {
  for (const sourceRoot of [bundledSkillsDir, backupSkillsDir]) {
    const sourceDir = path.join(sourceRoot, skillName);
    if (existsSync(path.join(sourceDir, 'SKILL.md'))) return sourceDir;
  }
  return null;
}
