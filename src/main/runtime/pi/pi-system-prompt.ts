import { buildSystemPrompt } from '../prompt-builder.js';

export function buildPiSystemPrompt(input: { agentId: string; workspaceRoot: string }) {
  return buildSystemPrompt(input);
}
