import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeMessage, RuntimeThread } from './runtime-types.js';
import { getOpenAgentPath } from './openagent-home.js';

interface SessionsIndex {
  threads: RuntimeThread[];
}

export interface ThreadDefaults {
  workspaceRoot: string;
  workspaceName: string;
  branch: string;
}

export class SessionStore {
  private readonly sessionsDir: string;
  private readonly indexPath: string;

  constructor(private readonly agentId: string) {
    this.sessionsDir = getOpenAgentPath('agents', agentId, 'sessions');
    this.indexPath = path.join(this.sessionsDir, 'sessions.json');
  }

  ensureReady() {
    mkdirSync(this.sessionsDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      this.writeIndex({ threads: [] });
    }
  }

  getSessionFile(threadId: string) {
    this.ensureReady();
    return path.join(this.sessionsDir, `${threadId}.jsonl`);
  }

  listThreads(defaults?: ThreadDefaults) {
    const index = this.readIndex();
    const byId = new Map(index.threads.map((thread) => [thread.threadId, thread]));

    if (defaults) {
      for (const thread of this.scanTranscriptThreads(defaults)) {
        byId.set(thread.threadId, { ...thread, ...byId.get(thread.threadId) });
      }
    }

    const threads = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.writeIndex({ threads });
    return threads;
  }

  upsertThread(thread: RuntimeThread) {
    const index = this.readIndex();
    const existingIndex = index.threads.findIndex((item) => item.threadId === thread.threadId);
    if (existingIndex >= 0) {
      index.threads[existingIndex] = thread;
    } else {
      index.threads.unshift(thread);
    }
    index.threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.writeIndex(index);
  }

  removeThread(threadId: string) {
    const index = this.readIndex();
    this.writeIndex({ threads: index.threads.filter((thread) => thread.threadId !== threadId) });
  }

  private scanTranscriptThreads(defaults: ThreadDefaults) {
    this.ensureReady();
    return readdirSync(this.sessionsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => {
        const threadId = name.slice(0, -'.jsonl'.length);
        const filePath = path.join(this.sessionsDir, name);
        const messages = readTranscriptMessages(filePath);
        const firstMessage = messages[0];
        const lastMessage = messages.at(-1);
        const firstUser = messages.find((message) => message.role === 'user');
        let fileUpdatedAt = new Date().toISOString();
        try {
          fileUpdatedAt = statSync(filePath).mtime.toISOString();
        } catch {
          // keep fallback
        }
        const createdAt = firstMessage?.createdAt ?? fileUpdatedAt;
        const updatedAt = lastMessage?.createdAt ?? fileUpdatedAt;
        const title = firstUser?.content?.slice(0, 28) || (threadId === 'thread-welcome' ? '欢迎使用 OpenAgent' : '新的会话');
        const thread: RuntimeThread = {
          threadId,
          agentId: this.agentId,
          workspaceRoot: defaults.workspaceRoot,
          workspaceName: defaults.workspaceName,
          branch: defaults.branch,
          title,
          createdAt,
          updatedAt,
          archived: false,
          runCount: messages.filter((message) => message.role === 'user').length
        };
        return [thread];
      });
  }

  private readIndex(): SessionsIndex {
    this.ensureReady();
    try {
      return JSON.parse(readFileSync(this.indexPath, 'utf8')) as SessionsIndex;
    } catch {
      return { threads: [] };
    }
  }

  private writeIndex(index: SessionsIndex) {
    mkdirSync(this.sessionsDir, { recursive: true });
    writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }
}


function isOpenAgentTranscriptRecord(record: { type?: string; message?: RuntimeMessage }): record is { type: 'message'; message: RuntimeMessage } {
  const message = record.message;
  return (
    record.type === 'message' &&
    Boolean(message) &&
    typeof message?.id === 'string' &&
    typeof message?.createdAt === 'string' &&
    typeof message?.content === 'string'
  );
}

function readTranscriptMessages(filePath: string): RuntimeMessage[] {
  try {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as { type?: string; message?: RuntimeMessage };
          return isOpenAgentTranscriptRecord(record) ? [record.message] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
