import type { KnowledgeService } from '../knowledge/knowledge-service.js';
import { ShellAgent } from './shell-agent.js';
import { KnowledgeAgent } from './knowledge-agent.js';
import type { ShellAgentTask, SubagentRunInput, SubagentRunResult, SystemSubagentId, KnowledgeAgentTask } from './subagent-types.js';

export class SubagentService {
  private readonly shellAgent: ShellAgent;
  private readonly knowledgeAgent: KnowledgeAgent;

  constructor(knowledgeService: KnowledgeService) {
    this.shellAgent = new ShellAgent();
    this.knowledgeAgent = new KnowledgeAgent(knowledgeService);
  }

  invoke(agentId: SystemSubagentId, input: Omit<SubagentRunInput, 'callerAgentId'> & { callerAgentId?: string }): Promise<SubagentRunResult> {
    const payload = { ...input, callerAgentId: input.callerAgentId ?? 'unknown' };
    if (agentId === 'shell') return this.shellAgent.run(payload as SubagentRunInput<ShellAgentTask>);
    if (agentId === 'knowledge') return this.knowledgeAgent.run(payload as SubagentRunInput<KnowledgeAgentTask>);
    return Promise.resolve({ ok: false, agentId, summary: `Unknown subagent: ${agentId}`, error: 'unknown_subagent' });
  }
}
