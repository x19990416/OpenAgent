import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeAttachment } from '@openagent/runtime';
import { appendRuntimeInfoLog, decodeDataUrl, errorToMessage, getOpenAgentHome, sanitizeAttachmentName, uniquePath } from '@openagent/runtime';

export class RuntimeAttachmentController {
  constructor(private readonly agentId: string) {}

  materializePromptAttachments(input: {
    attachments: RuntimeAttachment[];
    runId: string;
    threadId: string;
  }): RuntimeAttachment[] {
    const { attachments, runId, threadId } = input;
    if (attachments.length === 0) return [];
    const attachmentDir = path.join(getOpenAgentHome(), 'agents', this.agentId, 'attachments', runId);
    mkdirSync(attachmentDir, { recursive: true });

    return attachments.map((attachment) => {
      const existingPath = typeof attachment.path === 'string' ? attachment.path : '';
      if (path.isAbsolute(existingPath) && existsSync(existingPath)) {
        return attachment;
      }

      const fileName = sanitizeAttachmentName(attachment.name || attachment.path || attachment.id || 'attachment');
      const targetPath = uniquePath(path.join(attachmentDir, fileName));
      const originalDataUrl = typeof attachment.originalDataUrl === 'string' ? attachment.originalDataUrl : undefined;
      const dataUrl = originalDataUrl || (typeof attachment.dataUrl === 'string' ? attachment.dataUrl : undefined) || (typeof attachment.imageDataUrl === 'string' ? attachment.imageDataUrl : undefined);

      try {
        if (dataUrl) {
          writeFileSync(targetPath, decodeDataUrl(dataUrl));
        } else if (typeof attachment.textContent === 'string') {
          writeFileSync(targetPath, attachment.textContent, 'utf8');
        } else {
          return attachment;
        }
        return {
          ...attachment,
          path: targetPath,
          archivedAttachmentPath: targetPath
        };
      } catch (error) {
        appendRuntimeInfoLog({
          scope: 'runtime',
          message: 'Failed to materialize prompt attachment',
          data: { runId, threadId, attachmentName: attachment.name, attachmentPath: attachment.path, error: errorToMessage(error) }
        });
        return attachment;
      }
    });
  }
}
