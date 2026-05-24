import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeMessage } from './runtime-types.js';

interface TranscriptRecord {
  type: 'message';
  message: RuntimeMessage;
}

function isOpenAgentTranscriptRecord(record: Partial<TranscriptRecord>): record is TranscriptRecord {
  const message = record.message;
  return (
    record.type === 'message' &&
    Boolean(message) &&
    typeof message?.id === 'string' &&
    typeof message?.createdAt === 'string' &&
    typeof message?.content === 'string'
  );
}

export interface TranscriptReadOptions {
  limit?: number;
}

export interface TranscriptStats {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export class TranscriptStore {
  constructor(private readonly filePath: string) {}

  appendMessage(message: RuntimeMessage) {
    this.ensureParent();
    const record: TranscriptRecord = { type: 'message', message };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  readMessages(options: TranscriptReadOptions = {}) {
    const messages = this.readAllMessages();
    const limit = normalizeLimit(options.limit);
    return limit ? messages.slice(-limit) : messages;
  }

  getStats(): TranscriptStats {
    const messages = this.readAllMessages();
    return {
      messageCount: messages.length,
      userMessageCount: messages.filter((message) => message.role === 'user').length,
      assistantMessageCount: messages.filter((message) => message.role === 'assistant').length,
      firstMessageAt: messages[0]?.createdAt ?? null,
      lastMessageAt: messages.at(-1)?.createdAt ?? null
    };
  }

  private readAllMessages() {
    this.ensureParent();
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, '', 'utf8');
      return [];
    }

    return readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as TranscriptRecord;
          return isOpenAgentTranscriptRecord(record) ? [record.message] : [];
        } catch {
          return [];
        }
      });
  }

  private ensureParent() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
  }
}

function normalizeLimit(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}
