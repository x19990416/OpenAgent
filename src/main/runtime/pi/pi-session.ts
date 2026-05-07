export interface PiSessionFactoryInput {
  workspaceRoot: string;
  agentDir: string;
  sessionFile: string;
  model: string;
}

export async function createPiSessionPlaceholder(_input: PiSessionFactoryInput) {
  throw new Error('Pi session factory is not implemented yet. See docs/pi.md for the intended createAgentSession flow.');
}
