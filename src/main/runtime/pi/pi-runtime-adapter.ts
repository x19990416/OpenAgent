import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { AgentRuntimeAdapter, AgentRuntimeRunInput, AgentRuntimeRunResult, RuntimeMessage } from '../runtime-types.js';
import { CancelledError, errorToMessage, isCancelledError } from '../errors.js';
import { createPiModelContext } from './pi-model-registry.js';
import { appendLlmResponseLog } from '../runtime-info-logger.js';
import { ToolExecutor } from '../tool-executor.js';
import { toPiToolDefinitions } from './pi-tools.js';

export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    const agentDir = path.dirname(path.dirname(input.sessionFile));
    try {
      input.onLog?.({
        scope: 'agent-loop',
        message: 'pi loop iteration 1: resolve model context',
        data: {
          runId: input.runId,
          threadId: input.threadId,
          providerId: input.providerId,
          model: input.model,
          agentDir
        }
      });
      const { authStorage, modelRegistry, selectedModel } = createPiModelContext({
        providerId: input.providerId,
        modelId: input.model
      });
      input.onLog?.({
        scope: 'agent-loop',
        message: 'pi loop iteration 2: prepare Pi managers and resource loader',
        data: {
          selectedModel: {
            id: selectedModel.id,
            name: selectedModel.name,
            provider: selectedModel.provider,
            contextWindow: selectedModel.contextWindow,
            maxTokens: selectedModel.maxTokens
          }
        }
      });
      const settingsManager = SettingsManager.create();
      const piSessionFile = resolvePiSessionFile(input.sessionFile);
      const sessionManager = SessionManager.open(piSessionFile);
      const resourceLoader = new DefaultResourceLoader({
        cwd: input.workspaceRoot,
        agentDir,
        settingsManager
      });
      await resourceLoader.reload();

      input.onLog?.({
        scope: 'agent-loop',
        message: 'pi loop iteration 3: create AgentSession',
        data: {
          cwd: input.workspaceRoot,
          openAgentTranscriptFile: input.sessionFile,
          piSessionFile,
          toolMode: 'openAgentToolExecutor',
          thinkingLevel: 'off',
          tools: input.tools.map((tool) => tool.name)
        }
      });
      const { session } = await createAgentSession({
        cwd: input.workspaceRoot,
        agentDir,
        authStorage,
        modelRegistry,
        model: selectedModel,
        sessionManager,
        settingsManager,
        resourceLoader,
        tools: input.tools.map((tool) => ({
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
          parameters: tool.parameters as any,
          execute: async () => ({ content: [{ type: 'text' as const, text: 'OpenAgent tool placeholder' }], details: undefined })
        })),
        customTools: toPiToolDefinitions(
          input.tools,
          new ToolExecutor(input.tools, {
            runId: input.runId,
            threadId: input.threadId,
            onLog: input.onLog,
            emitUiEvent: input.emitUiEvent,
            workspaceRoot: input.workspaceRoot,
            requestApproval: input.requestApproval
          })
        ),
        thinkingLevel: 'off'
      });

      input.onLog?.({
        scope: 'agent-loop',
        message: 'pi loop iteration 4: prompt session',
        data: {
          promptLength: input.prompt.length,
          transcriptMessageCount: input.messages.length
        }
      });
      const requestBody = buildPiPrompt(input.systemPrompt, input.prompt, input.messages);
      appendLlmResponseLog({
        scope: 'agent-loop',
        message: 'LLM request body',
        data: {
          runId: input.runId,
          threadId: input.threadId,
          providerId: input.providerId,
          model: input.model,
          prompt: requestBody,
          promptLength: requestBody.length,
          transcriptMessageCount: input.messages.length
        }
      });
      const assistantText = await this.promptSession(session, requestBody, input.onLog);
      const message: RuntimeMessage = {
        id: `assistant-${randomUUID()}`,
        role: 'assistant',
        content: assistantText,
        createdAt: new Date().toISOString()
      };

      input.onLog?.({
        scope: 'agent-loop',
        message: 'pi loop iteration 5: completed',
        data: {
          assistantMessageId: message.id,
          assistantTextLength: assistantText.length
        }
      });

      return {
        status: 'completed',
        assistantMessage: message,
        summary: message.content
      };
    } catch (error) {
      if (isCancelledError(error)) {
        return { status: 'cancelled', summary: '运行已停止。' };
      }

      return {
        status: 'failed',
        error: errorToMessage(error)
      };
    }
  }

  private async promptSession(session: any, prompt: string, onLog?: AgentRuntimeRunInput['onLog']) {
    let assistantText = '';
    let loopCount = 0;
    let activeLoop = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'turn_start') {
        activeLoop = typeof event.turnIndex === 'number' ? event.turnIndex + 1 : loopCount + 1;
        loopCount = Math.max(loopCount, activeLoop);
        onLog?.({
          scope: 'agent-loop',
          message: `LLM loop #${activeLoop} request started`,
          data: buildTurnRequestSnapshot(session, prompt, activeLoop)
        });
        return;
      }

      if (event.type === 'turn_end') {
        const resolvedLoop = typeof event.turnIndex === 'number' ? event.turnIndex + 1 : activeLoop || loopCount || 1;
        loopCount = Math.max(loopCount, resolvedLoop);
        onLog?.({
          scope: 'agent-loop',
          message: `LLM loop #${resolvedLoop} reply completed`,
          data: buildTurnReplySnapshot(event, assistantText, resolvedLoop)
        });
        activeLoop = resolvedLoop;
        return;
      }

      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        assistantText += event.assistantMessageEvent.delta;
        return;
      }
    });

    try {
      onLog?.({
        scope: 'agent-loop',
        message: 'pi prompt loop: prompt started',
        data: {
          promptLength: prompt.length,
          initialRequest: buildPromptRequestSnapshot(session, prompt)
        }
      });
      await session.prompt(prompt);
      onLog?.({
        scope: 'agent-loop',
        message: 'pi prompt loop: prompt resolved',
        data: {
          loopCount,
          assistantTextLength: assistantText.length
        }
      });
    } finally {
      unsubscribe?.();
    }

    if (!assistantText.trim()) {
      const lastAssistant = session.state?.messages?.filter((message) => message.role === 'assistant').at(-1);
      assistantText = coerceAssistantText(lastAssistant?.content);
    }

    if (!assistantText.trim()) {
      throw new CancelledError('Pi session completed without assistant output');
    }

    return assistantText.trim();
  }
}


function resolvePiSessionFile(openAgentSessionFile: string) {
  const sessionsDir = path.dirname(openAgentSessionFile);
  const piSessionsDir = path.join(sessionsDir, 'pi');
  mkdirSync(piSessionsDir, { recursive: true });
  return path.join(piSessionsDir, path.basename(openAgentSessionFile));
}

function coerceAssistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text.trim();
  }

  return '';
}

function buildPiPrompt(systemPrompt: string, userPrompt: string, messages: RuntimeMessage[]) {
  const recentTranscript = formatRecentTranscript(messages, userPrompt);
  return [
    '<openagent-system-instructions>',
    systemPrompt,
    '</openagent-system-instructions>',
    '',
    '<openagent-session-context>',
    '下面是当前 OpenAgent thread 的最近对话上下文。回答时必须延续这些上下文；如果用户说“好的”“继续”“就这样”等省略表达，应结合最近对话理解。',
    recentTranscript || '(当前 thread 还没有可用历史消息。)',
    '</openagent-session-context>',
    '',
    '<user-prompt>',
    userPrompt,
    '</user-prompt>'
  ].join('\n');
}

function formatRecentTranscript(messages: RuntimeMessage[], currentPrompt: string) {
  const historyMessages =
    messages.at(-1)?.role === 'user' && messages.at(-1)?.content.trim() === currentPrompt.trim()
      ? messages.slice(0, -1)
      : messages;
  const recentMessages = historyMessages.slice(-16);
  return recentMessages
    .map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
      const content = message.content.trim();
      if (!content) return '';
      return `<message role=\"${role}\">\n${content}\n</message>`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildPromptRequestSnapshot(session: any, prompt: string) {
  return {
    prompt,
    promptLength: prompt.length,
    sessionMessages: summarizeSessionMessages(session?.state?.messages ?? session?.agent?.state?.messages ?? []),
    currentModel: summarizeCurrentModel(session),
    turnCount: session?.state?.turnCount ?? session?.agent?.state?.turnCount
  };
}

function buildTurnRequestSnapshot(session: any, prompt: string, loopNumber: number) {
  return {
    loopNumber,
    prompt,
    promptLength: prompt.length,
    requestMessages: summarizeSessionMessages(session?.state?.messages ?? session?.agent?.state?.messages ?? []),
    currentModel: summarizeCurrentModel(session),
    turnCount: session?.state?.turnCount ?? session?.agent?.state?.turnCount
  };
}

function buildTurnReplySnapshot(event: any, assistantText: string, loopNumber: number) {
  return {
    loopNumber,
    assistantText,
    assistantTextLength: assistantText.length,
    turnIndex: event?.turnIndex,
    message: summarizeSessionMessage(event?.message),
    toolResults: Array.isArray(event?.toolResults) ? event.toolResults.map((item: any) => summarizeToolResult(item)) : []
  };
}

function summarizeSessionMessages(messages: any[]) {
  return messages.map((message) => summarizeSessionMessage(message));
}

function summarizeSessionMessage(message: any) {
  return {
    role: message?.role,
    type: message?.type,
    id: message?.id,
    toolCallId: message?.toolCallId,
    toolName: message?.toolName,
    content:
      typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
          : message?.content,
    isError: message?.isError,
    createdAt: message?.createdAt,
    contentLength:
      typeof message?.content === 'string'
        ? message.content.length
        : Array.isArray(message?.content)
          ? JSON.stringify(message.content).length
          : undefined
  };
}

function summarizeToolResult(toolResult: any) {
  return {
    toolCallId: toolResult?.toolCallId,
    name: toolResult?.name ?? toolResult?.toolName,
    isError: toolResult?.isError,
    content:
      typeof toolResult?.content === 'string'
        ? toolResult.content
        : Array.isArray(toolResult?.content)
          ? toolResult.content
          : toolResult?.content,
    contentLength:
      typeof toolResult?.content === 'string'
        ? toolResult.content.length
        : Array.isArray(toolResult?.content)
          ? JSON.stringify(toolResult.content).length
          : undefined
  };
}

function summarizeCurrentModel(session: any) {
  const model = session?.state?.model ?? session?.agent?.state?.model;
  if (!model) {
    return null;
  }

  return {
    provider: model.provider,
    model: model.model || model.id,
    id: model.id,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens
  };
}
