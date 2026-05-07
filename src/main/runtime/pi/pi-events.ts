import type { RuntimeEventBus } from '../event-bus.js';

export function subscribePiEventsPlaceholder(_session: unknown, _eventBus: RuntimeEventBus) {
  return () => undefined;
}
