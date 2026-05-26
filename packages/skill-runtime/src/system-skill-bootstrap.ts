import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBundledPathCandidates } from './skill-utils.js';

const BUILTIN_SKILL_NAMES = ['skill-creator', 'skill-installer'] as const;

export function ensureOpenAgentSystemSkills(openAgentRoot: string, appRoot?: string) {
  const userSkillsDir = path.join(openAgentRoot, 'skills');
  const systemSkillsDir = path.join(userSkillsDir, '.system');
  mkdirSync(systemSkillsDir, { recursive: true });

  const bundledSkillsDirs = [
    ...resolveBundledPathCandidates(appRoot, 'skills', '.system'),
    ...resolveAncestorPathCandidates(appRoot, 'skills', '.system'),
    ...resolveAncestorPathCandidates(process.cwd(), 'skills', '.system')
  ];
  const backupSkillsDir = path.join(os.homedir(), '.openagent-bk', 'agents', 'main', 'skills');
  for (const skillName of BUILTIN_SKILL_NAMES) {
    const sourceDir = resolveSourceSkillDir(skillName, [...bundledSkillsDirs, backupSkillsDir]);
    if (!sourceDir) continue;
    const targetDir = path.join(systemSkillsDir, skillName);
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });
  }
}

function resolveAncestorPathCandidates(start: string | undefined, ...parts: string[]) {
  if (!start) return [];
  const candidates: string[] = [];
  let current = path.resolve(start);
  while (true) {
    candidates.push(path.join(current, ...parts));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

function resolveSourceSkillDir(skillName: (typeof BUILTIN_SKILL_NAMES)[number], sourceRoots: string[]) {
  for (const sourceRoot of sourceRoots) {
    const sourceDir = path.join(sourceRoot, skillName);
    if (existsSync(path.join(sourceDir, 'SKILL.md'))) return sourceDir;
  }
  return null;
}
