import type { KnowledgeService } from '../knowledge/knowledge-service.js';
import { ShellAgent } from './shell-agent.js';
import { KnowledgeAgent } from './knowledge-agent.js';
import { PiCodingAgent } from './pi-coding-agent.js';
import type { ShellAgentTask, SubagentRunInput, SubagentRunResult, SystemSubagentId, KnowledgeAgentTask, PiCodingAgentTask } from './subagent-types.js';

export class SubagentService {
  private readonly shellAgent: ShellAgent;
  private readonly knowledgeAgent: KnowledgeAgent;
  private readonly piCodingAgent: PiCodingAgent;

  constructor(knowledgeService: KnowledgeService) {
    this.shellAgent = new ShellAgent();
    this.knowledgeAgent = new KnowledgeAgent(knowledgeService);
    this.piCodingAgent = new PiCodingAgent();
  }

  invoke(agentId: SystemSubagentId, input: Omit<SubagentRunInput, 'callerAgentId'> & { callerAgentId?: string }): Promise<SubagentRunResult> {
    const payload = { ...input, callerAgentId: input.callerAgentId ?? 'unknown' };
    if (agentId === 'shell') return this.shellAgent.run(payload as SubagentRunInput<ShellAgentTask>);
    if (agentId === 'knowledge') return this.knowledgeAgent.run(payload as SubagentRunInput<KnowledgeAgentTask>);
    if (agentId === 'pi_coding') {
      if (!payload.runtimeContext || !payload.toolCallId) {
        return Promise.resolve({ ok: false, agentId, summary: 'pi_coding requires runtimeContext and toolCallId.', error: 'missing_runtime_context' });
      }
      return this.piCodingAgent.run({
        task: payload.task as PiCodingAgentTask,
        toolCallId: payload.toolCallId,
        context: payload.runtimeContext,
        signal: payload.signal
      });
    }
    return Promise.resolve({ ok: false, agentId, summary: `Unknown subagent: ${agentId}`, error: 'unknown_subagent' });
  }
}
