import { configurePiHttpLoggerHooks, PiRuntimeAdapter } from '@openagent/pi-adapter';
import type { AgentRuntimeRunInput } from '@openagent/runtime';
import { recordModelUsageFromResponse } from '@openagent/runtime';
import { getOpenAgentAppSettings } from './settings/openagent-settings.js';
import { ToolExecutor } from '@openagent/runtime';
import { appendLlmResponseLog } from '@openagent/runtime';

export function createPiRuntimeAdapter() {
  configurePiHttpLoggerHooks({
    appendLlmResponseLog,
    recordModelUsageFromResponse
  });

  return new PiRuntimeAdapter({
    appendLlmResponseLog,
    createToolExecutor: createOpenAgentToolExecutor,
    getToolLoopGuardSettings: () => {
      const settings = getOpenAgentAppSettings();
      return {
        maxConsecutiveSameToolCalls: settings.runtime.maxConsecutiveSameToolCalls,
        maxConsecutiveSameToolResults: settings.runtime.maxConsecutiveSameToolResults
      };
    },
    allowTextToolCallRecovery: () => getOpenAgentAppSettings().runtime.allowTextToolCallRecovery
  });
}

function createOpenAgentToolExecutor(input: AgentRuntimeRunInput) {
  return new ToolExecutor(input.tools, {
    runId: input.runId,
    threadId: input.threadId,
    agentId: input.agentId,
    sessionFile: input.sessionFile,
    providerId: input.providerId,
    model: input.model,
    onLog: input.onLog,
    emitUiEvent: input.emitUiEvent,
    workspaceRoot: input.workspaceRoot,
    requestApproval: input.requestApproval,
    getPlanContext: input.getPlanContext
  });
}
