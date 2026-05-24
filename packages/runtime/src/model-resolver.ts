export interface RuntimeModelConfig {
  providerId: string;
  providerLabel: string;
  model: string;
  mode: 'pi' | 'openai-compatible';
}

export function resolveRuntimeModel(input: { providerId: string; providerLabel: string; model: string }): RuntimeModelConfig {
  return {
    ...input,
    mode: input.providerId === 'pi' ? 'pi' : 'openai-compatible'
  };
}
