import os from 'node:os';
import path from 'node:path';

export function getOpenAgentHome() {
  return path.join(os.homedir(), '.openagent');
}

export function getSystemWikiRoot() {
  return path.join(getOpenAgentHome(), 'system', 'wiki');
}
