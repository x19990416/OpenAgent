import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SkillCandidate, SkillCatalogItem, SkillResourceItem, SkillScriptDescriptor, SkillSettings } from './skill-types.js';
import { DEFAULT_TRUST, SOURCE_LABELS } from './skill-types.js';
import { firstParagraph, normalizeRisk, normalizeStringArray, titleize, unquote } from './skill-utils.js';

export function parseCandidate(candidate: SkillCandidate, settings: SkillSettings): SkillCatalogItem {
  const skillFile = path.join(candidate.rootDir, 'SKILL.md');
  try {
    const raw = readFileSync(skillFile, 'utf8');
    const parsed = parseSkillMarkdown(raw);
    const skillJson = readSkillJson(candidate.rootDir);
    const name = String(skillJson.name || parsed.frontmatter.name || path.basename(candidate.rootDir)).trim();
    const description = String(skillJson.description || parsed.frontmatter.description || firstParagraph(parsed.body) || '').trim();
    const risk = normalizeRisk(skillJson.risk || parsed.frontmatter.risk);
    const tags = normalizeStringArray(skillJson.tags || parsed.frontmatter.tags);
    const allowedTools = normalizeStringArray(skillJson.allowedTools || parsed.frontmatter['allowed-tools'] || parsed.frontmatter.allowedTools);
    const trusted = settings.trusted?.[candidate.source] ?? DEFAULT_TRUST[candidate.source];
    const explicitEnabled = settings.enabled?.[name];
    const enabled = typeof explicitEnabled === 'boolean' ? explicitEnabled : trusted;
    return {
      id: `${candidate.source}:${name}`,
      name,
      displayName: String(skillJson.displayName || parsed.frontmatter.displayName || titleize(name)),
      description,
      source: candidate.source,
      sourceLabel: SOURCE_LABELS[candidate.source],
      rootDir: candidate.rootDir,
      skillFile,
      version: String(skillJson.version || parsed.frontmatter.version || '').trim() || undefined,
      tags,
      risk,
      allowedTools,
      resources: collectSkillResources(candidate.rootDir, skillJson),
      scripts: collectSkillScripts(skillJson),
      enabled,
      state: enabled ? 'enabled' : 'disabled',
      hash: createHash('sha256').update(raw).digest('hex').slice(0, 16)
    };
  } catch (error) {
    return {
      id: `${candidate.source}:${path.basename(candidate.rootDir)}`,
      name: path.basename(candidate.rootDir),
      displayName: titleize(path.basename(candidate.rootDir)),
      description: '',
      source: candidate.source,
      sourceLabel: SOURCE_LABELS[candidate.source],
      rootDir: candidate.rootDir,
      skillFile,
      tags: [],
      risk: 'read',
      allowedTools: [],
      resources: [],
      scripts: [],
      enabled: false,
      state: 'failed',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function parseSkillMarkdown(raw: string) {
  if (!raw.startsWith('---')) return { frontmatter: {} as Record<string, unknown>, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {} as Record<string, unknown>, body: raw };
  const frontmatterText = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, '');
  return { frontmatter: parseSimpleYaml(frontmatterText), body };
}

function parseSimpleYaml(text: string) {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let currentKey = '';
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^\s*-\s*(.*)$/);
    if (listMatch && currentKey) {
      const existing = Array.isArray(result[currentKey]) ? result[currentKey] as string[] : [];
      existing.push(unquote(listMatch[1].trim()));
      result[currentKey] = existing;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    currentKey = match[1];
    const value = match[2].trim();
    if (!value) {
      result[currentKey] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[currentKey] = value.slice(1, -1).split(',').map((item) => unquote(item.trim())).filter(Boolean);
    } else {
      result[currentKey] = unquote(value);
    }
  }
  return result;
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



function collectSkillScripts(skillJson: Record<string, unknown>): SkillScriptDescriptor[] {
  const declaredScripts = Array.isArray(skillJson.scripts) ? skillJson.scripts : [];
  const scripts: SkillScriptDescriptor[] = [];
  for (const item of declaredScripts) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const pathValue = String(record.path || '').trim();
    if (!pathValue) continue;
    scripts.push({
      path: pathValue,
      runtime: typeof record.runtime === 'string' ? record.runtime : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
      risk: normalizeRisk(record.risk),
      timeoutMs: typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0 ? Math.floor(record.timeoutMs) : undefined,
      network: typeof record.network === 'boolean' ? record.network : undefined,
      writes: typeof record.writes === 'boolean' ? record.writes : undefined
    });
  }
  return scripts;
}

function collectSkillResources(rootDir: string, skillJson: Record<string, unknown>): SkillResourceItem[] {
  const items: SkillResourceItem[] = [];
  const declaredScripts = Array.isArray(skillJson.scripts) ? skillJson.scripts : [];
  const declaredResources = Array.isArray(skillJson.resources) ? skillJson.resources : [];
  for (const item of declaredScripts) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const pathValue = String(record.path || '').trim();
    if (!pathValue) continue;
    items.push({ path: pathValue, kind: 'script', description: typeof record.description === 'string' ? record.description : undefined, size: getSize(rootDir, pathValue) });
  }
  for (const item of declaredResources) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const pathValue = String(record.path || '').trim();
    if (!pathValue) continue;
    items.push({ path: pathValue, kind: normalizeResourceKind(record.type, pathValue), description: typeof record.description === 'string' ? record.description : undefined, size: getSize(rootDir, pathValue) });
  }
  for (const [dir, kind] of [['scripts', 'script'], ['templates', 'template'], ['references', 'reference'], ['examples', 'example'], ['assets', 'asset']] as const) {
    for (const pathValue of listNestedFiles(rootDir, dir)) {
      if (!items.some((item) => item.path === pathValue)) items.push({ path: pathValue, kind, size: getSize(rootDir, pathValue) });
    }
  }
  return items.sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`));
}

function normalizeResourceKind(value: unknown, resourcePath: string): SkillResourceItem['kind'] {
  if (value === 'script' || value === 'template' || value === 'reference' || value === 'example' || value === 'asset') return value;
  if (resourcePath.startsWith('scripts/')) return 'script';
  if (resourcePath.startsWith('templates/')) return 'template';
  if (resourcePath.startsWith('references/')) return 'reference';
  if (resourcePath.startsWith('examples/')) return 'example';
  return 'asset';
}

function listNestedFiles(rootDir: string, childDir: string) {
  const base = path.join(rootDir, childDir);
  if (!existsSync(base)) return [];
  const results: string[] = [];
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(current); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }
      if (stat.isDirectory()) stack.push(fullPath);
      else if (stat.isFile()) results.push(path.relative(rootDir, fullPath).split(path.sep).join('/'));
    }
  }
  return results;
}

function getSize(rootDir: string, resourcePath: string) {
  try { return statSync(path.join(rootDir, resourcePath)).size; } catch { return undefined; }
}

export function summarizeSkillMarkdown(content: string) {
  const parsed = parseSkillMarkdown(content);
  const lines = parsed.body.split(/\r?\n/);
  const picked: string[] = [];
  for (const line of lines) {
    if (picked.length > 160) break;
    picked.push(line);
  }
  return picked.join('\n').slice(0, 24_000);
}
