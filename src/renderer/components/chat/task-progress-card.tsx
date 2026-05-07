import { CheckCircle2, Circle, ListTodo, LoaderCircle } from 'lucide-react';
import type { PlanStepItem, RunStatus } from '@shared-types/events';

interface TaskProgressCardProps {
  plan: PlanStepItem[];
  runStatus: RunStatus;
  className?: string;
}

function getCompletedCount(plan: PlanStepItem[]) {
  return plan.filter((step) => step.status === 'completed').length;
}

function getStepIcon(status: PlanStepItem['status']) {
  if (status === 'completed') {
    return <CheckCircle2 size={16} className="task-progress-icon completed" />;
  }

  if (status === 'in_progress') {
    return <LoaderCircle size={16} className="task-progress-icon spinning" />;
  }

  return <Circle size={16} className="task-progress-icon pending" />;
}

export function TaskProgressCard({ plan, runStatus, className = '' }: TaskProgressCardProps) {
  if (plan.length === 0) {
    return null;
  }

  const completedCount = getCompletedCount(plan);
  const statusText =
    runStatus === 'succeeded'
      ? '全部完成'
      : runStatus === 'failed'
        ? '执行中断'
        : runStatus === 'cancelled'
          ? '已停止'
          : '执行中';

  return (
    <section className={`task-progress-card ${className}`.trim()}>
      <div className="task-progress-header">
        <div className="task-progress-summary">
          <ListTodo size={18} className="task-progress-summary-icon" />
          <div className="task-progress-meta">
            共 {plan.length} 个任务，已经完成 {completedCount} 个
          </div>
        </div>
        <div className={`task-progress-status ${runStatus}`}>{statusText}</div>
      </div>

      <div className="task-progress-list">
        {plan.map((step, index) => (
          <div key={`${step.id}-${index}`} className={`task-progress-item ${step.status}`}>
            <div className="task-progress-index">{index + 1}.</div>
            <div className="task-progress-marker">{getStepIcon(step.status)}</div>
            <div className="task-progress-text">{step.title}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
