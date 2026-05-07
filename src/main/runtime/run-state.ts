import type { RuntimeRecentRun } from './runtime-types.js';

export class RunStateStore {
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs: RuntimeRecentRun[] = [];

  start(run: RuntimeRecentRun) {
    const controller = new AbortController();
    this.controllers.set(run.runId, controller);
    this.runs.unshift(run);
    return controller;
  }

  update(runId: string, patch: Partial<RuntimeRecentRun>) {
    const run = this.runs.find((item) => item.runId === runId);
    if (run) {
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    }
  }

  finish(runId: string, patch: Partial<RuntimeRecentRun>) {
    this.update(runId, { ...patch, endedAt: new Date().toISOString() });
    this.controllers.delete(runId);
  }

  stop(runId?: string) {
    if (runId) {
      this.controllers.get(runId)?.abort();
      return this.controllers.has(runId);
    }

    let stopped = false;
    for (const controller of this.controllers.values()) {
      controller.abort();
      stopped = true;
    }
    return stopped;
  }

  list() {
    return this.runs.slice(0, 20);
  }

  getLatest() {
    return this.runs[0] ?? null;
  }
}
