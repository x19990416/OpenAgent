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

export class TranscriptStore {
  constructor(private readonly filePath: string) {}

  appendMessage(message: RuntimeMessage) {
    this.ensureParent();
    const record: TranscriptRecord = { type: 'message', message };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  readMessages() {
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
