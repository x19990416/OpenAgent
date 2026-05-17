#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command !== 'install') {
  fail(`Unknown command: ${command}`);
}

const source = args[1];
if (!source) fail('Usage: openagent-skill install <local-path|git-url> [--target agent|user|workspace] [--agent main] [--workspace /path] [--overwrite]');

const options = parseOptions(args.slice(2));
const target = ['agent', 'user', 'workspace'].includes(options.target) ? options.target : 'agent';
const agentId = options.agent || 'main';
const workspaceRoot = options.workspace ? path.resolve(options.workspace) : process.cwd();
const openAgentRoot = options.home ? path.resolve(options.home) : process.env.OPENAGENT_HOME || path.join(homedir(), '.openagent');
const overwrite = Boolean(options.overwrite);
const tempDirs = [];

try {
  const sourceRoot = resolveSource(source, tempDirs);
  const skillRoots = discoverInstallableSkillRoots(sourceRoot);
  if (skillRoots.length === 0) fail(`No installable skills found under ${sourceRoot}. Expected SKILL.md at root or under child folders.`);

  const destinationRoot = resolveDestinationRoot(target, { openAgentRoot, agentId, workspaceRoot });
  mkdirSync(destinationRoot, { recursive: true });
  const installed = [];
  for (const skillRoot of skillRoots) {
    const skillName = resolveSkillName(skillRoot);
    const destinationDir = path.join(destinationRoot, skillName);
    if (existsSync(destinationDir)) {
      if (!overwrite) fail(`Skill already exists: ${destinationDir}. Re-run with --overwrite to replace it.`);
      rmSync(destinationDir, { recursive: true, force: true });
    }
    cpSync(skillRoot, destinationDir, {
      recursive: true,
      dereference: false,
      filter: (entry) => shouldCopySkillPath(skillRoot, entry)
    });
    installed.push({ name: skillName, source: skillRoot, destination: destinationDir });
  }

  console.log(JSON.stringify({ ok: true, target, openAgentRoot, installed }, null, 2));
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}

function resolveSource(value, tempDirs) {
  if (isLikelyGitUrl(value)) {
    const temp = mkdtempSync(path.join(tmpdir(), 'openagent-skill-git-'));
    tempDirs.push(temp);
    const result = spawnSync('git', ['clone', '--depth', '1', value, temp], { stdio: 'pipe', encoding: 'utf8' });
    if (result.status !== 0) fail(`git clone failed: ${result.stderr || result.stdout}`);
    return temp;
  }
  const resolved = path.resolve(value.replace(/^file:\/\//, ''));
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) fail(`Source directory not found: ${value}`);
  return resolved;
}

function discoverInstallableSkillRoots(root) {
  if (existsSync(path.join(root, 'SKILL.md'))) return [root];
  const results = [];
  const entries = safeReaddir(root);
  for (const entry of entries) {
    const full = path.join(root, entry);
    if (safeIsDirectory(full) && existsSync(path.join(full, 'SKILL.md'))) results.push(full);
  }
  return results;
}

function resolveSkillName(skillRoot) {
  const skillJson = readJson(path.join(skillRoot, 'skill.json'));
  const frontmatter = parseFrontmatter(readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'));
  return safeFileName(String(skillJson.name || frontmatter.name || path.basename(skillRoot)).trim() || path.basename(skillRoot));
}

function resolveDestinationRoot(target, input) {
  if (target === 'user') return path.join(input.openAgentRoot, 'skills');
  if (target === 'workspace') return path.join(input.workspaceRoot, '.openagent', 'skills');
  return path.join(input.openAgentRoot, 'agents', input.agentId, 'skills');
}

function parseOptions(items) {
  const result = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    if (key === 'overwrite') {
      result.overwrite = true;
    } else {
      result[key] = items[index + 1];
      index += 1;
    }
  }
  return result;
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const text = raw.slice(3, end).trim();
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) result[match[1]] = unquote(match[2].trim());
  }
  return result;
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function safeIsDirectory(target) {
  try { return statSync(target).isDirectory(); } catch { return false; }
}

function safeFileName(input) {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '');
}

function shouldCopySkillPath(rootDir, entry) {
  const relative = path.relative(rootDir, entry).split(path.sep).join('/');
  if (!relative) return true;
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '.git' || segment === 'node_modules' || segment === '__pycache__')) return false;
  if (segments.some((segment) => segment === '.DS_Store')) return false;
  return true;
}

function isLikelyGitUrl(value) {
  return /^(https?:\/\/|git@|ssh:\/\/).+\.git(?:#.+)?$/.test(value) || /^github:[^/]+\/.+/.test(value);
}

function printHelp() {
  console.log(`OpenAgent Skill CLI\n\nUsage:\n  openagent-skill install <local-path|git-url> [--target agent|user|workspace] [--agent main] [--workspace /path] [--home ~/.openagent] [--overwrite]\n\nExamples:\n  openagent-skill install ./my-skill --target agent\n  openagent-skill install ./skills-pack --target user --overwrite\n  openagent-skill install https://github.com/acme/openagent-skills.git --target agent\n`);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
