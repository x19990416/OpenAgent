import { randomUUID } from 'node:crypto';
import type { RuntimeUiEvent } from './runtime-types.js';

export class RuntimeEventBus {
  constructor(private readonly emitUiEvent: (event: RuntimeUiEvent) => void) {}

  emit(type: RuntimeUiEvent['type'], payload?: unknown) {
    const event: RuntimeUiEvent = {
      id: randomUUID(),
      type,
      payload,
      createdAt: new Date().toISOString()
    };
    this.emitUiEvent(event);
    return event;
  }
}
