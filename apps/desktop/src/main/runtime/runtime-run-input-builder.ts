import type { AgentRuntimeRunInput, RuntimeAttachment, RuntimeEventBus, RuntimeServiceOptions, RuntimeThread } from '@openagent/runtime';
import { appendRuntimeInfoLog, buildRunContextLogSnapshot, buildRunInput, formatRuntimeInfoLogSummary, resolvePluginContext, resolvePromptContextMode, selectRelevantMemoryContext, summarizeProgressLogEntry } from '@openagent/runtime';
import { formatPlanForPrompt, type AgentPlan } from '@openagent/planning';
import { filterToolsForSelectedSkill, formatSelectedSkillPlanRule, formatSelectedSkillRoutingRule, maybeRunSkillCreatorScaffoldFastPath, toPlanExecutionContext, toSelectedSkillExecutionContext, type SkillService } from '@openagent/skill-runtime';
import type { RunStateStore, TranscriptStore } from '@openagent/runtime';
import type { createDefaultToolRegistry } from '@openagent/runtime';
import type { SoulManager } from './memory/soul-manager.js';
import type { RuntimeKnowledgeController } from './runtime-knowledge-controller.js';
import type { RuntimeProgressController } from './runtime-progress-controller.js';
import type { RuntimeApprovalController } from './runtime-approval-controller.js';

const MAX_RUN_CONTEXT_MESSAGES = 32;

export class RuntimeRunInputBuilder {
  constructor(
    private getOptions: () => RuntimeServiceOptions,
    private readonly eventBus: RuntimeEventBus,
    private readonly runState: RunStateStore,
    private readonly toolRegistry: ReturnType<typeof createDefaultToolRegistry>,
    private readonly skillService: SkillService,
    private readonly soulManager: SoulManager,
    private readonly knowledgeController: RuntimeKnowledgeController,
    private readonly approvalController: RuntimeApprovalController,
    private readonly syncPluginSkills: () => void
  ) {}

  async build(input: {
    prompt: string;
    runId: string;
    thread: RuntimeThread;
    transcript: TranscriptStore;
    sessionFile: string;
    abortSignal: AbortSignal;
    attachments: RuntimeAttachment[];
    selectedSkillId?: string | null;
    getActivePlan: () => AgentPlan | null;
    progressController: RuntimeProgressController;
    startedAt: number;
  }): Promise<AgentRuntimeRunInput> {
    const { prompt, runId, thread, transcript, sessionFile, abortSignal, attachments, startedAt } = input;
    const options = this.getOptions();

    appendRuntimeInfoLog({
      scope: 'context',
      message: 'resolvePluginContext start',
      data: { runId, threadId: thread.threadId, elapsedMs: Date.now() - startedAt, promptLength: prompt.length }
    });
    const pluginContext = await resolvePluginContext({
      prompt,
      resolver: options.pluginContextResolver
    });
    appendRuntimeInfoLog({
      scope: 'context',
      message: 'resolvePluginContext completed',
      data: {
        runId,
        threadId: thread.threadId,
        elapsedMs: Date.now() - startedAt,
        toolCount: pluginContext.tools.length,
        skillSummaryCount: pluginContext.skills ? pluginContext.skills.split('\n').filter(Boolean).length : 0
      }
    });

    this.syncPluginSkills();
    const explicitSelectedSkill = this.resolveSelectedSkill(input.selectedSkillId ?? null);
    const inferredSelectedSkill = explicitSelectedSkill ? null : this.skillService.inferSelectedSkill({ prompt, attachments });
    const selectedSkill = explicitSelectedSkill ?? inferredSelectedSkill;
    if (inferredSelectedSkill) {
      appendRuntimeInfoLog({
        scope: 'context',
        message: 'implicit selected skill inferred',
        data: {
          runId,
          threadId: thread.threadId,
          skillName: inferredSelectedSkill.name,
          skillId: inferredSelectedSkill.id,
          reason: 'skill authoring intent'
        }
      });
    }
    const skillContext = this.skillService.resolveForPrompt({
      prompt,
      attachments,
      selectedSkillId: selectedSkill?.id ?? input.selectedSkillId ?? null
    });
    this.eventBus.emit('skill.resolved', {
      runId,
      threadId: thread.threadId,
      skills: skillContext.summaries.map((skill) => ({ name: skill.name, source: skill.source, risk: skill.risk, description: skill.description }))
    });

    const runMessages = transcript.readMessages({ limit: MAX_RUN_CONTEXT_MESSAGES });
    appendRuntimeInfoLog({
      scope: 'context',
      message: 'prepare runInput start',
      data: {
        runId,
        threadId: thread.threadId,
        elapsedMs: Date.now() - startedAt,
        toolCount: [...this.toolRegistry.list(), ...pluginContext.tools].length,
        transcriptMessageCount: runMessages.length
      }
    });
    const availableTools = [...this.toolRegistry.list(), ...pluginContext.tools];
    const runTools = filterToolsForSelectedSkill(availableTools, selectedSkill);
    const promptContext = resolvePromptContextMode({
      prompt,
      hasSelectedSkill: Boolean(selectedSkill),
      hasActivePlan: Boolean(input.getActivePlan()),
      attachmentsCount: attachments.length
    });
    const runInput = buildRunInput({
      runId,
      threadId: thread.threadId,
      agentId: thread.agentId || options.agentId,
      workspaceRoot: options.workspaceRoot,
      sessionFile,
      prompt,
      providerId: options.providerId,
      model: options.model,
      messages: runMessages,
      attachments,
      tools: runTools,
      abortSignal,
      promptContext,
      onLog: (entry) => {
        appendRuntimeInfoLog(entry);
        this.eventBus.emit('terminal.delta', {
          runId,
          text: formatRuntimeInfoLogSummary(entry)
        });
        const progressTitle = summarizeProgressLogEntry(entry);
        if (progressTitle) input.progressController.append(progressTitle);
      },
      emitUiEvent: (type, payload) => {
        if (type === 'approval.required') {
          this.runState.update(runId, { status: 'waiting_approval', summary: '等待用户审批。' });
        }
        if (type === 'approval.resolved') {
          const decision = (payload as { decision?: string } | undefined)?.decision;
          this.runState.update(runId, {
            status: decision === 'rejected' ? 'failed' : 'running',
            summary: decision === 'rejected' ? '用户拒绝了审批。' : '审批已通过，继续执行。'
          });
        }
        this.eventBus.emit(type, payload);
      },
      requestApproval: (request) => {
        this.runState.update(runId, { status: 'waiting_approval', summary: '等待用户审批外部路径访问。' });
        return this.approvalController.requestToolApproval({
          ...request,
          runId,
          threadId: thread.threadId
        });
      },
      getPlanContext: () => toPlanExecutionContext(input.getActivePlan(), selectedSkill) ?? toSelectedSkillExecutionContext(selectedSkill)
    });
    appendRuntimeInfoLog({
      scope: 'context',
      message: 'prepare runInput completed',
      data: {
        runId,
        threadId: thread.threadId,
        elapsedMs: Date.now() - startedAt,
        messageCount: runMessages.length,
        toolCount: runInput.tools.length,
        promptContext,
        selectedSkill: selectedSkill ? {
          name: selectedSkill.name,
          allowedTools: selectedSkill.allowedTools,
          originalToolCount: availableTools.length,
          exposedToolNames: runInput.tools.map((tool) => tool.name)
        } : undefined
      }
    });

    const preExecutedToolContext = await maybeRunSkillCreatorScaffoldFastPath({
      runInput,
      selectedSkill,
      activePlan: input.getActivePlan(),
      prompt
    });
    const bootstrap = this.soulManager.getBootstrapSnapshot();
    appendRuntimeInfoLog({
      scope: 'context',
      message: 'knowledge context lookup start',
      data: { runId, threadId: thread.threadId, elapsedMs: Date.now() - startedAt, promptLength: prompt.length }
    });
    const knowledgeContext = await this.knowledgeController.buildContext(prompt, abortSignal);
    appendRuntimeInfoLog({
      scope: 'context',
      message: 'knowledge context lookup completed',
      data: {
        runId,
        threadId: thread.threadId,
        elapsedMs: Date.now() - startedAt,
        knowledgeContextLength: knowledgeContext.length
      }
    });
    const memoryContext = selectRelevantMemoryContext(bootstrap.memory, prompt);
    const transcriptStats = transcript.getStats();
    runInput.onLog?.({
      scope: 'context',
      message: 'transcript context pruned for run',
      data: {
        sessionFile,
        totalMessages: transcriptStats.messageCount,
        injectedMessages: runInput.messages.length,
        maxInjectedMessages: MAX_RUN_CONTEXT_MESSAGES,
        promptContext,
        firstMessageAt: transcriptStats.firstMessageAt,
        lastMessageAt: transcriptStats.lastMessageAt
      }
    });

    const activePlan = input.getActivePlan();
    runInput.systemPrompt = [
      runInput.systemPrompt,
      '',
      'Agent long-term identity from SOUL.md:',
      bootstrap.soul,
      '',
      'User long-term preferences from USER.md:',
      bootstrap.user,
      '',
      'Relevant long-term memory from MEMORY.md (task-filtered, not full file):',
      memoryContext || '(no relevant long-term memory found)',
      '',
      'Relevant Knowledge Base context:',
      knowledgeContext || '(no relevant knowledge context found)',
      '',
      'Relevant skill context:',
      skillContext.promptBlock,
      '',
      ...(preExecutedToolContext
        ? [
            'Pre-executed Tool Invocation:',
            preExecutedToolContext,
            ''
          ]
        : []),
      ...(selectedSkill
        ? [
            'Selected skill routing rule:',
            formatSelectedSkillRoutingRule(selectedSkill),
            ''
          ]
        : []),
      'Relevant plugin context:',
      pluginContext.skills || '(no relevant plugin context found)',
      '',
      ...(activePlan
        ? [
            'Active OpenAgent Plan Mode:',
            formatPlanForPrompt(activePlan),
            '',
            'Plan execution rule:',
            '- Follow the active plan goal and steps unless new evidence makes it unsafe or incorrect.',
            '- Use OpenAgent tools normally when needed; OpenAgent runtime owns approvals, logs, and plan status.',
            ...(selectedSkill
              ? [
                  formatSelectedSkillPlanRule(selectedSkill),
                  ...(selectedSkill.name === 'skill-creator'
                    ? [
                        '- Do not call pi_coding_agent for skill-creator runs; use skill_load, skill_resource, skill_script, and necessary write_file calls so skill authoring stays on the governed scaffold path.'
                      ]
                    : [
                        '- Do not call pi_coding_agent merely to reimplement a declared skill script that can satisfy the step.',
                        '- For normal selected-skill runs, prefer skill_script first; pi_coding_agent may be used for real blockers such as missing dependencies, runtime/environment diagnosis, script failures, or requested skill/package fixes.'
                      ]),
                  '- All shell execution, dependency installation, and file writes still must go through OpenAgent policy and approval.'
                ]
              : [
                  '- For execute steps that require coding, running scripts, generating files, or complex artifacts, you must call the appropriate OpenAgent tool such as pi_coding_agent instead of merely saying you will do it.'
                ]),
            '- Do not end the run with future-tense progress text like “请稍等/我将/正在为你” when the next action requires a tool call; call the tool in the same turn.',
            '- If the plan is insufficient, explain the needed revision in the final answer rather than silently ignoring it.',
            ''
          ]
        : []),
      'Identity rule:',
      '- The `- Name:` field under `## 1. Identity` in SOUL.md is the source of truth for who you are.',
      '- When asked “你是谁”, “你叫啥”, or “who are you”, answer with the Name and Role from SOUL.md if present.',
      '- Do not replace the SOUL.md name with the model name or project name unless SOUL.md explicitly says so.',
      '',
      'OpenAgent structured metadata rule:',
      '- After your normal user-facing answer, append exactly one hidden HTML comment metadata block.',
      '- The block must be valid JSON and must not be explained to the user.',
      '- Format:',
      '<!-- openagent:metadata',
      '{"soulChangeRequests":[],"userUpdates":[],"memoryUpdates":[],"knowledgeUpdates":[]}',
      '-->',
      '- If the user asks for a durable Agent identity, role, behavior, safety, tool, memory, or project-specific rule change, add one object to soulChangeRequests.',
      '- Do not add soulChangeRequests for one-off or session-only instructions.',
      '- Every SOUL request must set requiresApproval to true.',
      '- Object schema: shouldUpdateSoul, updateKind, title, reason, proposedText, targetSection, confidence, requiresApproval, evidence, ruleId, identityName, identityRole.',
      '- confidence must be the string "low", "medium", or "high"; do not use numbers.',
      '- targetSection should be one of the exact SOUL headings, such as "## 1. Identity" or "## 7. Managed Rules".',
      '- updateKind must be one of: identity, working_style, safety_boundary, tool_policy, memory_policy, project_specific_rule.',
      '- ruleId is required for non-identity durable rules; use a stable snake_case id such as "communication_style", "git_safety", or "tool_policy" so OpenAgent can upsert instead of append duplicates.',
      '- For identity updates, do not expect OpenAgent to parse names from prose; set identityName and/or identityRole explicitly.',
      '- proposedText must be the final durable rule text, not a restatement of the user command.',
      '- If the user only says “更新 SOUL.md” or otherwise does not specify the actual durable change, return soulChangeRequests: [] and ask a clarification question in the visible reply.',
      '- Identity questions such as “你叫啥” or “你是谁” are not SOUL changes by themselves; only create a request when the user assigns or changes a durable identity.',
      '- Decide whether USER.md or MEMORY.md should be updated after each run. This does not require user approval, so be conservative.',
      '- Add userUpdates only for stable user preferences or collaboration habits that are likely to apply across future sessions; do not add one-off task instructions.',
      '- userUpdates object schema: shouldUpdateUser, category, statement, reason, confidence, evidence. category must be one of communication, git, development, documentation, project_management, tooling, other. confidence must be medium or high.',
      '- Add memoryUpdates only for reusable project/task knowledge, verified root causes, paths, commands, or design decisions that will help a future similar task; do not store raw chat logs or temporary details.',
      '- memoryUpdates object schema: shouldUpdateMemory, scope, topic, summary, reuse, confidence, evidence. confidence must be medium or high.',
      '- Add knowledgeUpdates only for reusable OpenAgent/system/project knowledge that belongs in the shared Knowledge Base; do not store private user preferences or one-off chat details. OpenAgent will ask the user for approval before applying these updates.',
      '- If the user explicitly asks to save/write/ingest content to wiki or knowledge base, put the full Markdown content in knowledgeUpdates unless you have already called knowledge_ingest successfully.',
      '- For explicit wiki-save requests, do not use memoryUpdates as a substitute for knowledgeUpdates; memoryUpdates are only short reusable reminders, not the knowledge base source of truth.',
      '- Never say “已保存到 wiki/知识库/工作区” unless a write tool succeeded or a knowledgeUpdates request was accepted and applied.',
      '- knowledgeUpdates object schema: shouldUpdateKnowledge, title, content, reason, confidence, tags, evidence. confidence must be medium or high.'
    ].join('\n');

    runInput.onLog?.({
      scope: 'context',
      message: '构建运行上下文完成',
      data: buildRunContextLogSnapshot(runInput)
    });

    return runInput;
  }

  private resolveSelectedSkill(selectedSkillId?: string | null) {
    const value = String(selectedSkillId || '').trim();
    if (!value) return null;
    return this.skillService.getSkill(value);
  }
}
