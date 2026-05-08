import path from 'node:path';

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
  list_directory: { argName: 'path', fallback: '.', access: 'read' },
  read_file: { argName: 'path', fallback: '', access: 'read' },
  shell_agent: { argName: 'root', fallback: '.', access: 'read' }
};

export function classifyToolPathAccess(input: { toolName: string; args: unknown; workspaceRoot: string }): PathAccessClassification | null {
  const rule = PATH_ARG_BY_TOOL[input.toolName];
  if (!rule) return null;

  const args = asRecord(input.args);
  const argValue = args[rule.argName];
  const rawPath = typeof argValue === 'string' && argValue.trim() ? argValue.trim() : rule.fallback;
  const targetPath = resolveAgainstWorkspace(input.workspaceRoot, rawPath);

  return {
    targetPath,
    access: rule.access,
    isExternal: !isInsidePath(targetPath, input.workspaceRoot)
  };
}

export function resolveAgainstWorkspace(workspaceRoot: string, requestedPath: string) {
  return path.resolve(workspaceRoot, requestedPath || '.');
}

export function isInsidePath(targetPath: string, rootPath: string) {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}
