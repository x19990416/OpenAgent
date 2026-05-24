export { getOpenAgentHome } from './openagent-home.js';
import { getOpenAgentPath } from './openagent-home.js';


export function getSystemKnowledgeRoot() {
  return getOpenAgentPath('system', 'wiki');
}
