import type { RuntimeUiEvent } from '../runtime/runtime-types.js';
import type { PluginEventSubscribe, PluginRuntimeSubmit } from './plugin-types.js';

export class PluginRuntimeBridge {
  private submitHandler: PluginRuntimeSubmit | null = null;
  private readonly listeners = new Set<(event: RuntimeUiEvent) => void>();

  setSubmitHandler(handler: PluginRuntimeSubmit) {
    this.submitHandler = handler;
  }

  async submitPrompt(input: unknown) {
    if (!this.submitHandler) throw new Error('Plugin runtime.submitPrompt is not available before RuntimeService is ready.');
    return this.submitHandler(input);
  }

  subscribe: PluginEventSubscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(event: RuntimeUiEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Plugin event listeners are isolated from OpenAgent event dispatch.
      }
    }
  }
}
