#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.name) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const name = safeName(args.name);
const displayName = args.displayName || titleize(name);
const description = oneLine(args.description || `Provide ${displayName} skill guidance and reusable automation.`);
const output = path.resolve(args.output || defaultOutputDir(name));
const risk = normalizeRisk(args.risk || 'read');
const tags = splitList(args.tags || 'skill');
const allowedTools = splitList(args.allowedTools || 'skill_load,skill_resource');

if (existsSync(output) && !args.overwrite) {
  fail(`Destination already exists: ${output}. Pass --overwrite to replace files in place.`);
}
mkdirSync(output, { recursive: true });

const skillMd = `---\nname: ${name}\ndescription: ${description}\nversion: 0.1.0\ntags:\n${tags.map((tag) => `  - ${tag}`).join('\n')}\nrisk: ${risk}\nallowed-tools:\n${allowedTools.map((tool) => `  - ${tool}`).join('\n')}\n---\n\n# ${displayName}\n\n## When to use\n\nUse this skill when ${args.whenToUse || 'the user asks for this capability'}.\n\n## When not to use\n\nDo not use this skill for unrelated tasks or to bypass OpenAgent policies.\n\n## Instructions\n\n1. Load only the supporting files needed for the current task.\n2. Prefer deterministic scripts for fragile or repetitive operations.\n3. Load user-specific parameters, credentials, tokens, account/password values, endpoint URLs, and local configuration from \`.env\` in this skill's root directory from scripts only; do not hard-code them in skill files or outputs.\n4. Do not expose \`.env\` or \`.env.example\` through \`skill.json.resources\`; resources must live under \`templates/\`, \`references/\`, \`examples/\`, or \`assets/\`. If configuration guidance is needed, add a sanitized \`references/config.md\` with placeholder names only.\n5. Keep outputs concise and verifiable.\n\n## Supporting files\n\n- Add templates, references, examples, assets, or scripts here as needed.\n\n## Output expectations\n\nState what changed and what validation was performed.\n`;

const skillJson = {
  schemaVersion: 'openagent.skill.v1',
  name,
  version: '0.1.0',
  displayName,
  description,
  risk,
  tags,
  allowedTools,
  scripts: [],
  resources: []
};

writeFileSync(path.join(output, 'SKILL.md'), skillMd, 'utf8');
writeFileSync(path.join(output, 'skill.json'), `${JSON.stringify(skillJson, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, path: output, name, files: ['SKILL.md', 'skill.json'] }, null, 2));

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
function splitList(value) { return String(value).split(',').map((item) => item.trim()).filter(Boolean); }
function safeName(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'new-skill'; }
function titleize(value) { return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' '); }
function oneLine(value) { return String(value).replace(/\s+/g, ' ').trim(); }
function normalizeRisk(value) { return ['read', 'write', 'network', 'external', 'destructive'].includes(value) ? value : 'read'; }
function defaultOutputDir(name) {
  const cwd = process.cwd();
  const parent = path.dirname(cwd);
  if (path.basename(cwd) === 'workspace' && path.basename(path.dirname(parent)) === 'agents') {
    return path.join(parent, 'skills', name);
  }
  return path.join(cwd, 'skills', name);
}
function fail(message) { console.error(JSON.stringify({ ok: false, error: message }, null, 2)); process.exit(1); }
function printHelp() { console.log('Usage: init_skill.mjs --name <skill-name> [--description <text>] [--output <dir>] [--tags a,b] [--risk read|write|network|external|destructive] [--allowedTools skill_load,skill_resource] [--overwrite]'); }
