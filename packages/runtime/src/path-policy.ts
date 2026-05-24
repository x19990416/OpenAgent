import path from 'node:path';
import os from 'node:os';
import { existsSync, realpathSync } from 'node:fs';

export type PathAccessKind = 'read' | 'write' | 'execute';

export interface PathAccessClassification {
  targetPath: string;
  access: PathAccessKind;
  isExternal: boolean;
}

const PATH_ARG_BY_TOOL: Record<string, { argName: string; fallback: string; access: PathAccessKind }> = {
  ls: { argName: 'path', fallback: '.', access: 'read' },
  read: { argName: 'path', fallback: '', access: 'read' },
  find: { argName: 'path', fallback: '.', access: 'read' },
  grep: { argName: 'path', fallback: '.', access: 'read' },
  count_files: { argName: 'path', fallback: '.', access: 'read' },
  write_file: { argName: 'path', fallback: '', access: 'write' },
  list_directory: { argName: 'path', fallback: '.', access: 'read' },
  read_file: { argName: 'path', fallback: '', access: 'read' },
  shell_agent: { argName: 'root', fallback: '.', access: 'read' },
  shell_exec: { argName: 'cwd', fallback: '.', access: 'execute' }
};

export function classifyToolPathAccess(input: { toolName: string; args: unknown; workspaceRoot: string }): PathAccessClassification | null {
  const rule = PATH_ARG_BY_TOOL[input.toolName];
  if (!rule) return null;

  const args = asRecord(input.args);
  const argValue = args[rule.argName];
  const rawPath = typeof argValue === 'string' && argValue.trim() ? argValue.trim() : rule.fallback;
  const lexicalTargetPath = resolveAgainstWorkspace(input.workspaceRoot, rawPath);
  const targetPath = resolveRealAccessPath(lexicalTargetPath, rule.access);

  return {
    targetPath,
    access: rule.access,
    isExternal: !isInsidePath(targetPath, resolveRealAccessPath(input.workspaceRoot, 'read'))
  };
}

export function resolveAgainstWorkspace(workspaceRoot: string, requestedPath: string) {
  const expandedPath = expandUserPathAlias(requestedPath || '.');
  return path.resolve(workspaceRoot, expandedPath);
}

export function expandUserPathAlias(requestedPath: string) {
  if (!path.isAbsolute(requestedPath)) return requestedPath;

  const normalizedPath = path.normalize(requestedPath);
  const segments = normalizedPath.split(path.sep);
  const topLevel = segments[1];
  const maybeHomeFolder = segments[2];
  const canonicalHomeFolder = getCanonicalHomeFolder(maybeHomeFolder);

  // macOS users often say "/Users/Downloads" when they mean the current
  // user's Downloads directory. Only rewrite that shorthand when the literal
  // path does not exist, so a real /Users/<name> directory is never hidden.
  if (topLevel !== 'Users' || !canonicalHomeFolder || existsSync(normalizedPath)) {
    return requestedPath;
  }

  return path.join(os.homedir(), canonicalHomeFolder, ...segments.slice(3));
}

export function isInsidePath(targetPath: string, rootPath: string) {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRealAccessPath(targetPath: string, access: PathAccessKind) {
  try {
    if (existsSync(targetPath)) {
      return realpathSync(targetPath);
    }

    if (access === 'write') {
      const resolved = resolveExistingParent(targetPath);
      if (resolved) return resolved;
    }
  } catch {
    // Fall back to the lexical path; the actual tool will still fail if the
    // path is invalid. Policy should not crash on broken symlinks.
  }

  return path.resolve(targetPath);
}

function resolveExistingParent(targetPath: string) {
  let current = path.dirname(path.resolve(targetPath));
  const missingSegments = [path.basename(targetPath)];

  while (current && current !== path.dirname(current)) {
    if (existsSync(current)) {
      const realParent = realpathSync(current);
      return path.join(realParent, ...missingSegments.reverse());
    }
    missingSegments.push(path.basename(current));
    current = path.dirname(current);
  }

  if (existsSync(current)) {
    const realParent = realpathSync(current);
    return path.join(realParent, ...missingSegments.reverse());
  }

  return null;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function getCanonicalHomeFolder(value?: string) {
  if (!value) return null;
  const match = STANDARD_HOME_FOLDERS.find((folder) => folder.toLowerCase() === value.toLowerCase());
  return match ?? null;
}

const STANDARD_HOME_FOLDERS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Public'
];
