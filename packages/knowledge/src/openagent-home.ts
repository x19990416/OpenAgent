import os from 'node:os';
import path from 'node:path';

export function getOpenAgentHome() {
  return process.env.OPENAGENT_HOME || path.join(os.homedir(), '.openagent');
}

export function getOpenAgentPath(...segments: string[]) {
  return path.join(getOpenAgentHome(), ...segments);
}
