#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.source) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const tempDirs = [];
try {
  const sourceRoot = resolveSource(args.source, tempDirs, args.ref);
  const selectedRoot = args.path ? path.resolve(sourceRoot, args.path) : sourceRoot;
  if (!existsSync(selectedRoot) || !statSync(selectedRoot).isDirectory()) fail(`Install path not found: ${selectedRoot}`);
  const skillRoots = discoverSkillRoots(selectedRoot);
  if (skillRoots.length === 0) fail(`No installable skills found under ${selectedRoot}. Expected SKILL.md at root or in direct child folders.`);

  const target = normalizeTarget(args.target || 'agent');
  const openAgentRoot = path.resolve(args.home || process.env.OPENAGENT_HOME || path.join(homedir(), '.openagent'));
  const workspaceRoot = path.resolve(args.workspace || process.cwd());
  const agentId = args.agent || 'main';
  const destinationRoot = resolveDestinationRoot(target, { openAgentRoot, workspaceRoot, agentId });
  mkdirSync(destinationRoot, { recursive: true });

  const installed = [];
  for (const skillRoot of skillRoots) {
    const metadata = resolveSkillMetadata(skillRoot);
    const skillName = metadata.name;
    const destinationDir = path.join(destinationRoot, skillName);
    if (existsSync(destinationDir)) {
      if (!args.overwrite) fail(`Skill already exists: ${destinationDir}. Pass --overwrite to replace it.`);
      rmSync(destinationDir, { recursive: true, force: true });
    }
    cpSync(skillRoot, destinationDir, {
      recursive: true,
      dereference: false,
      filter: (entry) => shouldCopy(skillRoot, entry)
    });
    installed.push({ name: skillName, version: metadata.version, source: skillRoot, destination: destinationDir });
  }

  console.log(JSON.stringify({ ok: true, target, openAgentRoot, workspaceRoot, agentId, installed }, null, 2));
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}

function resolveSource(source, tempDirs, ref) {
  if (isGitUrl(source)) {
    const temp = mkdtempSync(path.join(tmpdir(), 'openagent-skill-install-'));
    tempDirs.push(temp);
    const cloneArgs = ['clone', '--depth', '1'];
    if (ref) cloneArgs.push('--branch', ref);
    cloneArgs.push(normalizeGitUrl(source), temp);
    const result = spawnSync('git', cloneArgs, { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) fail(`git clone failed: ${result.stderr || result.stdout}`);
    return temp;
  }
  const local = path.resolve(source.replace(/^file:\/\//, ''));
  if (!existsSync(local) || !statSync(local).isDirectory()) fail(`Source directory not found: ${source}`);
  return local;
}

function discoverSkillRoots(root) {
  if (existsSync(path.join(root, 'SKILL.md'))) return [root];
  const results = [];
  for (const entry of safeReaddir(root)) {
    const child = path.join(root, entry);
    if (safeIsDirectory(child) && existsSync(path.join(child, 'SKILL.md'))) results.push(child);
  }
  return results;
}

function resolveSkillMetadata(skillRoot) {
  const skillJson = readJson(path.join(skillRoot, 'skill.json'));
  const frontmatter = parseFrontmatter(readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'));
  const name = safeName(String(skillJson.name || frontmatter.name || path.basename(skillRoot)).trim() || path.basename(skillRoot));
  const version = String(skillJson.version || frontmatter.version || '').trim() || null;
  return { name, version };
}

function resolveDestinationRoot(target, input) {
  if (target === 'user') return path.join(input.openAgentRoot, 'skills');
  if (target === 'workspace') return path.join(input.workspaceRoot, 'skills');
  return path.join(input.openAgentRoot, 'agents', input.agentId, 'skills');
}

function parseArgs(items) {
  const result = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    if (key === 'help' || key === 'overwrite') result[key] = true;
    else result[key] = items[++i];
  }
  return result;
}
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const result = {};
  for (const line of raw.slice(3, end).trim().split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) result[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return result;
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }
function safeReaddir(dir) { try { return readdirSync(dir); } catch { return []; } }
function safeIsDirectory(target) { try { return statSync(target).isDirectory(); } catch { return false; } }
function safeName(value) { return value.replace(/[^a-zA-Z0-9._-]/g, '_'); }
function normalizeTarget(value) { return ['agent', 'user', 'workspace'].includes(value) ? value : 'agent'; }
function isGitUrl(value) { return /^(https?:\/\/|git@|ssh:\/\/).+/.test(value) || /^github:[^/]+\/.+/.test(value); }
function normalizeGitUrl(value) { return value.startsWith('github:') ? `https://github.com/${value.slice('github:'.length)}.git` : value; }
function shouldCopy(root, entry) {
  const relative = path.relative(root, entry).split(path.sep).join('/');
  if (!relative) return true;
  const segments = relative.split('/');
  return !segments.some((segment) => ['.git', 'node_modules', '__pycache__', '.DS_Store'].includes(segment));
}
function fail(message) { console.error(JSON.stringify({ ok: false, error: message }, null, 2)); process.exit(1); }
function printHelp() { console.log('Usage: install_openagent_skill.mjs --source <local-dir|git-url> [--path <repo/subpath>] [--target agent|user|workspace] [--agent main] [--workspace <dir>] [--home <dir>] [--ref <branch-or-tag>] [--overwrite]'); }
