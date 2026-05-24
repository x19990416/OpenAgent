import type { MainAgentBootstrapSnapshot } from '../types/workbench';

export function resolveMainAgentDisplayName(agentBootstrap: MainAgentBootstrapSnapshot | null) {
  if (!agentBootstrap?.agentRoot) {
    return 'main';
  }

  const normalized = agentBootstrap.agentRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) || 'main';
}
