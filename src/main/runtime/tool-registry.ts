import { opendir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeTool } from './runtime-types.js';
import { expandUserPathAlias } from './path-policy.js';

const DEFAULT_LIMIT = 1000;
const MAX_READ_BYTES = 100_000;
const MAX_FIND_RESULTS = 10_000;

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  register(tool: RuntimeTool) {
    this.tools.set(tool.name, tool);
  }

  list() {
    return [...this.tools.values()];
  }

  get(name: string) {
    return this.tools.get(name) ?? null;
  }
}

export function createDefaultToolRegistry(workspaceRoot: string) {
  const registry = new ToolRegistry();

  // Pi/OpenAI-compatible read-only tool names. Keep execution owned by OpenAgent.
  registry.register(createLsTool(workspaceRoot));
  registry.register(createReadTool(workspaceRoot));
  registry.register(createFindTool(workspaceRoot));
  registry.register(createGrepTool(workspaceRoot));
  registry.register(createCountFilesTool(workspaceRoot));
  registry.register(createCurrentTimeTool());

  // Legacy OpenAgent names kept for older prompts/UI affordances.
  registry.register(createListDirectoryTool(workspaceRoot));
  registry.register(createReadFileTool(workspaceRoot));

  return registry;
}


function createCurrentTimeTool(): RuntimeTool {
  return {
    name: 'current_time',
    label: 'Current System Time',
    description: 'Return the current local system time. Use this whenever the user asks for current time, system time, today, now, or a specific current date/time format.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'Optional format. Supports yyyy-MM-dd HH:mm:ss. Defaults to ISO string.' }
      },
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const now = new Date();
      const format = String(args.format ?? '').trim();
      const formatted = format === 'yyyy-MM-dd HH:mm:ss' ? formatDateTime(now) : now.toISOString();
      return {
        ok: true,
        content: formatted,
        data: {
          format: format || 'iso',
          iso: now.toISOString(),
          timezoneOffsetMinutes: now.getTimezoneOffset()
        }
      };
    }
  };
}

function formatDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds())
  ].join('');
}

function createLsTool(workspaceRoot: string): RuntimeTool {
  return {
    name: 'ls',
    label: 'List Directory',
    description: 'List files and directories under a local directory. Use this for read-only directory inspection.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Relative paths are resolved from the OpenAgent workspace.' },
        limit: { type: 'number', description: 'Maximum entries to return. Defaults to 200.' }
      },
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const target = resolveLocalPath(workspaceRoot, String(args.path ?? '.'));
      const targetStat = await stat(target);
      if (!targetStat.isDirectory()) {
        return { ok: false, content: `Not a directory: ${target}` };
      }
      const limit = normalizeLimit(args.limit, 200, 2000);
      const entries = await readdirSorted(target, limit);
      return { ok: true, content: entries.join('\n') || '(empty)', data: { path: target, count: entries.length } };
    }
  };
}

function createReadTool(workspaceRoot: string): RuntimeTool {
  return {
    name: 'read',
    label: 'Read File',
    description: 'Read a UTF-8 text file from the local filesystem. Relative paths are resolved from the OpenAgent workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read.' },
        offset: { type: 'number', description: 'Optional 1-based line offset.' },
        limit: { type: 'number', description: 'Optional maximum number of lines to return.' },
        maxBytes: { type: 'number', description: 'Maximum bytes to return. Defaults to 20000.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async ({ input, signal }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const target = resolveLocalPath(workspaceRoot, String(args.path ?? ''));
      const targetStat = await stat(target);
      if (!targetStat.isFile()) {
        return { ok: false, content: `Not a file: ${target}` };
      }
      const maxBytes = normalizeLimit(args.maxBytes, 20_000, MAX_READ_BYTES);
      const content = await readFile(target, 'utf8');
      const sliced = content.slice(0, maxBytes);
      const offset = typeof args.offset === 'number' && args.offset > 1 ? Math.floor(args.offset) : 1;
      const lineLimit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : null;
      const lines = sliced.split('\n');
      const selected = lineLimit ? lines.slice(offset - 1, offset - 1 + lineLimit) : lines.slice(offset - 1);
      return { ok: true, content: selected.join('\n'), data: { path: target, truncated: content.length > maxBytes } };
    }
  };
}

function createCountFilesTool(workspaceRoot: string): RuntimeTool {
  return {
    name: 'count_files',
    label: 'Count Files',
    description: 'Count local files by glob pattern without returning every matching path. Use this for file count tasks.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern, e.g. '**/*.md' or 'src/**/*.ts'." },
        path: { type: 'string', description: 'Directory to count in. Relative paths are resolved from the OpenAgent workspace.' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    execute: async ({ input, signal, onUpdate }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return { ok: false, content: 'pattern is required' };
      const root = resolveLocalPath(workspaceRoot, String(args.path ?? '.'));
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) return { ok: false, content: `Not a directory: ${root}` };

      const matcher = createGlobMatcher(pattern);
      let count = 0;
      let scannedDirectories = 0;
      let skippedDirectories = 0;
      for await (const item of walkFiles(root, signal)) {
        if (item.kind === 'directory') {
          scannedDirectories += 1;
          if (scannedDirectories % 200 === 0) onUpdate?.({ scannedDirectories, matchedFiles: count });
          continue;
        }
        if (item.kind === 'skipped') {
          skippedDirectories += 1;
          continue;
        }
        const relative = toPosixPath(path.relative(root, item.path));
        if (matcher(relative)) count += 1;
      }
      return {
        ok: true,
        content: String(count),
        data: { path: root, pattern, count, scannedDirectories, skippedDirectories }
      };
    }
  };
}

function createFindTool(workspaceRoot: string): RuntimeTool {
  return {
    name: 'find',
    label: 'Find Files',
    description: 'Search local files by glob pattern. Returns matching file paths relative to the search directory.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern, e.g. '*.ts', '**/*.md', or 'src/**/*.spec.ts'." },
        path: { type: 'string', description: 'Directory to search in. Relative paths are resolved from the OpenAgent workspace.' },
        limit: { type: 'number', description: 'Maximum results to return. Defaults to 1000.' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    execute: async ({ input, signal, onUpdate }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return { ok: false, content: 'pattern is required' };
      const root = resolveLocalPath(workspaceRoot, String(args.path ?? '.'));
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) return { ok: false, content: `Not a directory: ${root}` };

      const limit = normalizeLimit(args.limit, DEFAULT_LIMIT, MAX_FIND_RESULTS);
      const matcher = createGlobMatcher(pattern);
      const results: string[] = [];
      let scannedDirectories = 0;
      let skippedDirectories = 0;

      for await (const item of walkFiles(root, signal)) {
        if (item.kind === 'directory') {
          scannedDirectories += 1;
          if (scannedDirectories % 200 === 0) {
            onUpdate?.({ scannedDirectories, matchedFiles: results.length });
          }
          continue;
        }
        if (item.kind === 'skipped') {
          skippedDirectories += 1;
          continue;
        }
        const relative = toPosixPath(path.relative(root, item.path));
        if (matcher(relative)) {
          results.push(relative);
          if (results.length >= limit) break;
        }
      }

      if (results.length === 0) {
        return { ok: true, content: 'No files found matching pattern', data: { path: root, scannedDirectories, skippedDirectories, count: 0 } };
      }
      const limitNotice = results.length >= limit ? `\n\n[${limit} results limit reached]` : '';
      return {
        ok: true,
        content: `${results.join('\n')}${limitNotice}`,
        data: { path: root, scannedDirectories, skippedDirectories, count: results.length, limitReached: results.length >= limit }
      };
    }
  };
}

function createGrepTool(workspaceRoot: string): RuntimeTool {
  return {
    name: 'grep',
    label: 'Grep Files',
    description: 'Search UTF-8 text files for a pattern. Relative paths are resolved from the OpenAgent workspace.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regular expression to search for.' },
        path: { type: 'string', description: 'Directory or file to search. Defaults to workspace root.' },
        glob: { type: 'string', description: 'Optional file glob filter, e.g. **/*.ts.' },
        ignoreCase: { type: 'boolean', description: 'Use case-insensitive matching.' },
        literal: { type: 'boolean', description: 'Treat pattern as literal text instead of RegExp.' },
        context: { type: 'number', description: 'Unused for now; reserved for compatibility.' },
        limit: { type: 'number', description: 'Maximum matches to return. Defaults to 200.' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    execute: async ({ input, signal, onUpdate }) => {
      throwIfAborted(signal);
      const args = asRecord(input);
      const pattern = String(args.pattern ?? '');
      if (!pattern) return { ok: false, content: 'pattern is required' };
      const target = resolveLocalPath(workspaceRoot, String(args.path ?? '.'));
      const targetStat = await stat(target);
      const limit = normalizeLimit(args.limit, 200, 5000);
      const fileMatcher = args.glob ? createGlobMatcher(String(args.glob)) : () => true;
      const textMatcher = createTextMatcher(pattern, Boolean(args.ignoreCase), Boolean(args.literal));
      const matches: string[] = [];
      let scannedFiles = 0;

      const files = targetStat.isFile() ? [target] : walkFilePaths(target, signal);
      for await (const file of files) {
        const relative = toPosixPath(path.relative(targetStat.isFile() ? path.dirname(target) : target, file));
        if (!fileMatcher(relative)) continue;
        scannedFiles += 1;
        if (scannedFiles % 100 === 0) onUpdate?.({ scannedFiles, matches: matches.length });
        let content = '';
        try {
          content = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (textMatcher(lines[index])) {
            matches.push(`${relative}:${index + 1}:${lines[index]}`);
            if (matches.length >= limit) break;
          }
        }
        if (matches.length >= limit) break;
      }

      if (matches.length === 0) return { ok: true, content: 'No matches found', data: { path: target, scannedFiles, count: 0 } };
      const limitNotice = matches.length >= limit ? `\n\n[${limit} matches limit reached]` : '';
      return { ok: true, content: `${matches.join('\n')}${limitNotice}`, data: { path: target, scannedFiles, count: matches.length } };
    }
  };
}

function createListDirectoryTool(workspaceRoot: string): RuntimeTool {
  return { ...createLsTool(workspaceRoot), name: 'list_directory' };
}

function createReadFileTool(workspaceRoot: string): RuntimeTool {
  return { ...createReadTool(workspaceRoot), name: 'read_file' };
}

async function readdirSorted(target: string, limit: number) {
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(target, { withFileTypes: true }));
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
}

async function* walkFiles(root: string, signal: AbortSignal): AsyncGenerator<{ kind: 'directory' | 'file' | 'skipped'; path: string }> {
  const stack = [root];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const current = stack.pop()!;
    let dir;
    try {
      dir = await opendir(current);
      yield { kind: 'directory', path: current };
    } catch {
      yield { kind: 'skipped', path: current };
      continue;
    }
    try {
      for await (const entry of dir) {
        throwIfAborted(signal);
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile()) yield { kind: 'file', path: fullPath };
      }
    } catch {
      yield { kind: 'skipped', path: current };
    }
  }
}

async function* walkFilePaths(root: string, signal: AbortSignal): AsyncGenerator<string> {
  for await (const item of walkFiles(root, signal)) {
    if (item.kind === 'file') yield item.path;
  }
}

function resolveLocalPath(workspaceRoot: string, requestedPath: string) {
  const value = requestedPath || '.';
  return path.resolve(workspaceRoot, expandUserPathAlias(value));
}

function createTextMatcher(pattern: string, ignoreCase: boolean, literal: boolean) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regexp = new RegExp(pattern, ignoreCase ? 'i' : undefined);
  return (line: string) => regexp.test(line);
}

function createGlobMatcher(pattern: string) {
  const normalized = toPosixPath(pattern).replace(/^\.\//, '');
  const regex = globToRegExp(normalized);
  return (relativePath: string) => regex.test(toPosixPath(relativePath));
}

function globToRegExp(pattern: string) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      const after = pattern[index + 2];
      if (after === '/') {
        source += '(?:.*\/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function toPosixPath(value: string) {
  return value.split(path.sep).join('/');
}

function normalizeLimit(value: unknown, fallback: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error('Tool execution aborted');
  }
}
