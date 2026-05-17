import { realpathSync, readdirSync, statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SkillRisk } from './skill-types.js';

export function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizeRisk(value: unknown): SkillRisk {
  return value === 'write' || value === 'network' || value === 'external' || value === 'destructive' ? value : 'read';
}

export function normalizePositiveInt(value: unknown, fallback: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

export function tokenize(value: string) {
  return value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/u).map((item) => item.trim()).filter(Boolean);
}

export function titleize(value: string) {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ') || value;
}

export function firstParagraph(markdown: string) {
  return markdown.split(/\n\s*\n/).find((block) => block.trim() && !block.trim().startsWith('#'))?.trim() ?? '';
}

export function unquote(value: string) {
  return value.replace(/^['"]|['"]$/g, '');
}

export function safeReaddir(dir: string) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function safeIsDirectory(target: string) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isSafeRealpath(target: string) {
  try {
    realpathSync(target);
    return true;
  } catch {
    return false;
  }
}

export function safeFileName(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Skill tool execution aborted');
}

export async function resolveSkillChild(rootDir: string, requestedPath: string, allowedTopDirs: string[]) {
  const normalized = requestedPath.replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('Skill path is required');
  const top = normalized.split(/[\\/]/)[0];
  if (!allowedTopDirs.includes(top)) throw new Error(`Skill path must be under: ${allowedTopDirs.join(', ')}`);
  const rootReal = await realpath(rootDir);
  const target = path.resolve(rootReal, normalized);
  const targetReal = await realpath(target);
  const relative = path.relative(rootReal, targetReal);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill path escapes skill root');
  return targetReal;
}

export function resolveWorkspaceCwd(workspaceRoot: string, requested: string) {
  const value = requested || '.';
  return path.resolve(workspaceRoot, value.replace(/^~(?=\/|$)/, os.homedir()));
}

export async function readLimitedFile(file: string, maxBytes: number, signal: AbortSignal) {
  throwIfAborted(signal);
  const content = await readFile(file, 'utf8');
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  return `${content.slice(0, maxBytes)}\n\n...[truncated at ${maxBytes} bytes]`;
}
