import type { AgentRuntimeAdapter } from '@openagent/runtime';
import { createPiRuntimeAdapter } from './pi-adapter-factory.js';
import { getOpenAgentAppSettings } from './settings/openagent-settings.js';

export interface DesktopRuntimeHost {
  createDefaultAdapter(): AgentRuntimeAdapter;
  createPiRuntimeAdapter(): AgentRuntimeAdapter;
  shouldAutoApproveRuntimeApprovals(): boolean;
}

export function createDesktopRuntimeHost(): DesktopRuntimeHost {
  return {
    createDefaultAdapter,
    createPiRuntimeAdapter,
    shouldAutoApproveRuntimeApprovals
  };
}

function createDefaultAdapter(): AgentRuntimeAdapter {
  return createPiRuntimeAdapter();
}

function shouldAutoApproveRuntimeApprovals() {
  try {
    return getOpenAgentAppSettings().runtime.autoApproveRuntimeApprovals;
  } catch {
    return false;
  }
}
