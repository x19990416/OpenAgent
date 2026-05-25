import type { RuntimeEventBus } from '@openagent/runtime';

type RuntimeProgressStepStatus = 'pending' | 'in_progress' | 'completed';

interface RuntimeProgressStep {
  id: string;
  title: string;
  status: RuntimeProgressStepStatus;
}

export class RuntimeProgressController {
  private readonly steps: RuntimeProgressStep[];

  constructor(
    private readonly runId: string,
    private readonly eventBus: RuntimeEventBus,
    private readonly isPlanActive: () => boolean
  ) {
    this.steps = [
      { id: `${runId}-context`, title: '构建运行上下文', status: 'completed' },
      { id: `${runId}-loop-start`, title: '启动 agent loop', status: 'in_progress' },
      { id: `${runId}-persist`, title: '保存 transcript', status: 'pending' }
    ];
  }

  emit() {
    this.eventBus.emit('plan.updated', { steps: this.steps });
  }

  append(title: string, status: RuntimeProgressStepStatus = 'in_progress') {
    if (this.isPlanActive()) return;
    for (const step of this.steps) {
      if (step.status === 'in_progress') step.status = 'completed';
    }
    const persistStep = this.steps.at(-1);
    if (persistStep?.id === `${this.runId}-persist`) this.steps.pop();
    this.steps.push({ id: `${this.runId}-step-${this.steps.length}`, title, status });
    this.steps.push({ id: `${this.runId}-persist`, title: '保存 transcript', status: 'pending' });
    this.emit();
  }

  completeAll() {
    for (const step of this.steps) step.status = 'completed';
    this.emit();
  }
}
