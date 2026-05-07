export interface RuntimeModelConfig {
  providerId: string;
  providerLabel: string;
  model: string;
  mode: 'local-demo' | 'pi' | 'openai-compatible';
}

export function resolveRuntimeModel(input: { providerId: string; providerLabel: string; model: string }): RuntimeModelConfig {
  return {
    ...input,
    mode: input.providerId === 'local-demo' ? 'local-demo' : 'openai-compatible'
  };
}
