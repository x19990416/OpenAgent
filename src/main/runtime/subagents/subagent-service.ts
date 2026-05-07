import { ShellAgent } from './shell-agent.js';
import type { SubagentRunInput, SubagentRunResult, SystemSubagentId } from './subagent-types.js';

export class SubagentService {
  private readonly shellAgent: ShellAgent;

  constructor() {
    this.shellAgent = new ShellAgent();
  }

  invoke(agentId: SystemSubagentId, input: Omit<SubagentRunInput, 'callerAgentId'> & { callerAgentId?: string }): Promise<SubagentRunResult> {
    const payload = { ...input, callerAgentId: input.callerAgentId ?? 'unknown' };
    if (agentId === 'shell') return this.shellAgent.run(payload);
    return Promise.resolve({ ok: false, agentId, summary: `Unknown subagent: ${agentId}`, error: 'unknown_subagent' });
  }
}
