import type { AgentRuntimeRunInput, RuntimeEventBus } from '@openagent/runtime';
import { type RunStateStore } from '@openagent/runtime';
import type { KnowledgeService } from '@openagent/knowledge';
import { extractOpenAgentMetadata, type SoulManager } from './memory/soul-manager.js';
import type { RuntimeApprovalController } from './runtime-approval-controller.js';

export class RuntimeContextUpdateController {
  constructor(
    private readonly soulManager: SoulManager,
    private readonly knowledgeService: KnowledgeService,
    private readonly runState: RunStateStore,
    private readonly eventBus: RuntimeEventBus,
    private readonly approvalController: RuntimeApprovalController,
    private readonly getAgentBootstrapSnapshot: () => unknown
  ) {}

  extractAssistantMessage(input: { content: string }) {
    const metadata = extractOpenAgentMetadata(input.content);
    return {
      cleanContent: metadata.cleanContent || input.content,
      metadata
    };
  }

  async applyMetadata(input: {
    metadata: ReturnType<typeof extractOpenAgentMetadata>;
    prompt: string;
    runId: string;
    threadId: string;
    runInput: AgentRuntimeRunInput;
  }) {
    const { metadata, prompt, runId, threadId, runInput } = input;
    const appliedSoulUpdates = metadata.soulChangeRequests
      .map((request) =>
        this.soulManager.applySoulChangeRequest(request, {
          kind: 'runtime_detection',
          runId,
          threadId,
          excerpt: request.evidence || prompt.slice(0, 500)
        })
      )
      .filter((update): update is NonNullable<typeof update> => Boolean(update));
    const appliedUserUpdates = metadata.userUpdates
      .map((request) =>
        this.soulManager.applyUserUpdateRequest(request, {
          kind: 'runtime_detection',
          runId,
          threadId,
          excerpt: request.evidence || prompt.slice(0, 500)
        })
      )
      .filter((update): update is NonNullable<typeof update> => Boolean(update));
    const appliedMemoryUpdates = metadata.memoryUpdates
      .map((request) =>
        this.soulManager.applyProjectMemoryUpdateRequest(request, {
          kind: 'runtime_detection',
          runId,
          threadId,
          excerpt: request.evidence || prompt.slice(0, 500)
        })
      )
      .filter((update): update is NonNullable<typeof update> => Boolean(update));
    const appliedKnowledgeUpdates = [];
    for (const request of metadata.knowledgeUpdates) {
      this.runState.update(runId, {
        status: 'waiting_approval',
        summary: `等待用户审批 Knowledge Base 候选：${request.title}`
      });
      const decision = await this.approvalController.requestToolApproval({
        title: `写入 Knowledge Base：${request.title}`,
        risk: request.confidence === 'high' ? 'medium' : 'low',
        description: [
          request.reason,
          '',
          '候选内容：',
          request.content.slice(0, 1200)
        ].join('\n'),
        actionType: 'knowledge.ingest',
        access: 'write',
        scope: 'once',
        payloadPreview: request.content.slice(0, 500),
        runId,
        threadId
      });
      if (decision !== 'approved') {
        runInput.onLog?.({
          scope: 'runtime',
          message: 'Knowledge Base update rejected by user',
          data: {
            title: request.title,
            reason: request.reason
          }
        });
        continue;
      }
      this.runState.update(runId, { status: 'running', summary: `正在写入 Knowledge Base：${request.title}` });
      const applied = await this.knowledgeService.ingest({
        scope: 'system',
        title: request.title,
        content: request.content,
        tags: ['runtime-detection', ...(request.tags ?? [])]
      });
      if (applied.ok) appliedKnowledgeUpdates.push(applied);
    }
    const appliedAutoMemoryUpdates = [...appliedUserUpdates, ...appliedMemoryUpdates];
    if (appliedSoulUpdates.length > 0 || appliedAutoMemoryUpdates.length > 0 || appliedKnowledgeUpdates.length > 0) {
      const memorySummaryParts = [
        appliedSoulUpdates.length > 0 ? `SOUL.md ${appliedSoulUpdates.length} 条` : '',
        appliedUserUpdates.length > 0 ? `USER.md ${appliedUserUpdates.length} 条` : '',
        appliedMemoryUpdates.length > 0 ? `MEMORY.md ${appliedMemoryUpdates.length} 条` : '',
        appliedKnowledgeUpdates.length > 0 ? `Knowledge Base ${appliedKnowledgeUpdates.length} 条` : ''
      ].filter(Boolean);
      const memorySummary = `已自动更新长期上下文：${memorySummaryParts.join('，')}。`;
      runInput.onLog?.({
        scope: 'runtime',
        message: memorySummary,
        data: {
          source: 'llm-structured-metadata',
          soulUpdates: appliedSoulUpdates.map((update) => ({
            updateId: update.id,
            title: update.title,
            proposedText: update.proposedText
          })),
          userUpdates: appliedUserUpdates.map((update) => ({
            updateId: update.id,
            title: update.title,
            proposedText: update.proposedText
          })),
          memoryUpdates: appliedMemoryUpdates.map((update) => ({
            updateId: update.id,
            title: update.title,
            proposedText: update.proposedText
          })),
          knowledgeUpdates: appliedKnowledgeUpdates.map((update) => ({
            id: update.id,
            path: update.path,
            message: update.message
          }))
        }
      });
      this.eventBus.emit('memory.updated', {
        snapshot: this.getAgentBootstrapSnapshot(),
        soulUpdates: appliedSoulUpdates,
        userUpdates: appliedUserUpdates,
        memoryUpdates: appliedMemoryUpdates,
        knowledgeUpdates: appliedKnowledgeUpdates,
        summary: memorySummary
      });
    }
  }
}
