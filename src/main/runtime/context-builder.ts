import { buildSystemPrompt } from './prompt-builder.js';
import type { AgentRuntimeRunInput, RuntimeLogEntry, RuntimeMessage, RuntimeTool } from './runtime-types.js';
import type { ApprovalDecision, RuntimeApprovalRequest } from './approval-service.js';

export interface RunContextInput {
  runId: string;
  threadId: string;
  agentId: string;
  workspaceRoot: string;
  sessionFile: string;
  prompt: string;
  providerId: string;
  model: string;
  messages: RuntimeMessage[];
  tools: RuntimeTool[];
  abortSignal: AbortSignal;
  onLog?: (entry: RuntimeLogEntry) => void;
  emitUiEvent?: (type: import('./runtime-types.js').RuntimeUiEvent['type'], payload?: unknown) => void;
  requestApproval?: (request: RuntimeApprovalRequest) => Promise<ApprovalDecision>;
}

export function buildRunInput(input: RunContextInput): AgentRuntimeRunInput {
  return {
    ...input,
    systemPrompt: buildSystemPrompt({ agentId: input.agentId, workspaceRoot: input.workspaceRoot })
  };
}

export function buildRunContextLogSnapshot(input: AgentRuntimeRunInput) {
  return {
    runId: input.runId,
    threadId: input.threadId,
    agentId: input.agentId,
    workspaceRoot: input.workspaceRoot,
    sessionFile: input.sessionFile,
    providerId: input.providerId,
    model: input.model,
    prompt: {
      length: input.prompt.length,
      preview: input.prompt.slice(0, 160)
    },
    systemPrompt: {
      length: input.systemPrompt.length,
      lineCount: input.systemPrompt.split('\n').length,
      preview: input.systemPrompt.slice(0, 240)
    },
    transcript: {
      messageCount: input.messages.length,
      messages: input.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        attachmentCount: message.attachments?.length ?? 0,
        attachments: message.attachments?.map((attachment) => ({
          id: attachment.id,
          path: attachment.path,
          name: attachment.name,
          kind: attachment.kind,
          size: attachment.size,
          mimeType: attachment.mimeType,
          textContent: attachment.textContent
        })),
        createdAt: message.createdAt,
        toolCallId: message.toolCallId
      }))
    },
    tools: input.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      descriptionLength: tool.description.length,
      description: tool.description,
      parameters: tool.parameters,
      hasExecutor: typeof tool.execute === 'function'
    })),
    abortSignal: {
      aborted: input.abortSignal.aborted
    }
  };
}
