export interface KnowledgeLoggerHooks {
  appendLlmResponseLog?: (input: { scope: string; message: string; data?: unknown }) => void;
}

let loggerHooks: KnowledgeLoggerHooks = {};

export function configureKnowledgeLoggerHooks(hooks: KnowledgeLoggerHooks) {
  loggerHooks = hooks;
}

export function appendKnowledgeLlmResponseLog(input: { scope: string; message: string; data?: unknown }) {
  loggerHooks.appendLlmResponseLog?.(input);
}
