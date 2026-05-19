import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillMarkdown } from './skill-parser.js';
import { safeFileName } from './skill-utils.js';
import type { SkillSource } from './skill-types.js';

export interface InstallLocalSkillInput {
  sourceDir: string;
  target?: 'user' | 'agent' | 'workspace';
  overwrite?: boolean;
}

export function installLocalSkill(input: InstallLocalSkillInput & { agentId: string; workspaceRoot: string; openAgentRoot?: string }) {
  const sourceDir = path.resolve(String(input.sourceDir || ''));
  if (!sourceDir || !existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    return { ok: false, error: `Skill source directory not found: ${input.sourceDir || '(empty)'}` };
  }

  const sourceSkillFile = path.join(sourceDir, 'SKILL.md');
  if (!existsSync(sourceSkillFile) || !statSync(sourceSkillFile).isFile()) {
    return { ok: false, error: `Selected directory must contain SKILL.md: ${sourceDir}` };
  }

  const parsed = parseSkillMarkdown(readFileSync(sourceSkillFile, 'utf8'));
  const skillJson = readSkillJson(sourceDir);
  const rawName = String(skillJson.name || parsed.frontmatter.name || path.basename(sourceDir)).trim();
  const skillName = safeFileName(rawName || path.basename(sourceDir));
  if (!skillName) return { ok: false, error: 'Cannot resolve skill name from SKILL.md or skill.json' };

  const targetSource = normalizeInstallTarget(input.target);
  const root = resolveInstallRoot(targetSource, {
    agentId: input.agentId,
    workspaceRoot: input.workspaceRoot,
    openAgentRoot: input.openAgentRoot
  });
  mkdirSync(root, { recursive: true });
  const destinationDir = path.join(root, skillName);
  const sourceReal = path.resolve(sourceDir);
  const destinationReal = path.resolve(destinationDir);
  if (sourceReal === destinationReal) {
    return { ok: true, installed: false, reason: 'source already at destination', skillName, target: targetSource, destinationDir };
  }

  if (existsSync(destinationDir)) {
    if (!input.overwrite) {
      return { ok: false, error: `Skill already exists at ${destinationDir}. Enable overwrite to replace it.`, skillName, target: targetSource, destinationDir };
    }
    rmSync(destinationDir, { recursive: true, force: true });
  }

  cpSync(sourceDir, destinationDir, {
    recursive: true,
    dereference: false,
    filter: (source) => shouldCopySkillPath(sourceDir, source)
  });

  return { ok: true, installed: true, skillName, target: targetSource, destinationDir, sourceDir };
}

export function resolveInstallRoot(target: SkillSource, input: { agentId: string; workspaceRoot: string; openAgentRoot?: string }) {
  const openAgentRoot = input.openAgentRoot ?? process.env.OPENAGENT_HOME ?? path.join(os.homedir(), '.openagent');
  if (target === 'user') return path.join(openAgentRoot, 'skills');
  if (target === 'workspace') return path.join(input.workspaceRoot, 'skills');
  return path.join(openAgentRoot, 'agents', input.agentId, 'skills');
}

function normalizeInstallTarget(value: unknown): 'user' | 'agent' | 'workspace' {
  return value === 'user' || value === 'workspace' ? value : 'agent';
}

function readSkillJson(rootDir: string): Record<string, unknown> {
  const file = path.join(rootDir, 'skill.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function shouldCopySkillPath(rootDir: string, source: string) {
  const relative = path.relative(rootDir, source).split(path.sep).join('/');
  if (!relative) return true;
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '.git' || segment === 'node_modules' || segment === '__pycache__')) return false;
  if (segments.some((segment) => segment === '.DS_Store')) return false;
  return true;
}
