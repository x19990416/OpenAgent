import type { RuntimeTool } from './runtime-types.js';

export interface PluginContextResolver {
  getRuntimeTools(): RuntimeTool[];
  getRelevantSkillSummaries(prompt: string): string[];
}

export async function resolvePluginContext(input: { prompt?: string; resolver?: PluginContextResolver } = {}) {
  const resolver = input.resolver;
  if (!resolver) return { skills: '', tools: [] as RuntimeTool[] };
  const skillSummaries = resolver.getRelevantSkillSummaries(input.prompt || '');
  return {
    skills: skillSummaries.join('\n'),
    tools: resolver.getRuntimeTools()
  };
}
