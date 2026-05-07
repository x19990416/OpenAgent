import { CheckCircle2, ChevronDown, Circle, LoaderCircle, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PlanStepItem, RunStatus } from '@shared-types/events';
import type { RunLogItem } from '@/types/workbench';

function getStepIcon(status: PlanStepItem['status']) {
  if (status === 'completed') {
    return <CheckCircle2 size={16} className="task-progress-icon completed" />;
  }

  if (status === 'in_progress') {
    return <LoaderCircle size={16} className="task-progress-icon spinning" />;
  }

  return <Circle size={16} className="task-progress-icon pending" />;
}

export function PlanPanel({
  plan,
  logs,
  runStatus,
  latestSessionSummary,
  onStopRun
}: {
  plan: PlanStepItem[];
  logs: RunLogItem[];
  runStatus: RunStatus;
  latestSessionSummary: string | null;
  onStopRun: (runId?: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const completedCount = plan.filter((step) => step.status === 'completed').length;
  const effectivePlan = plan;
  const effectiveCompletedCount = completedCount;
  const commandScript = useMemo(() => extractLatestCommandScript(logs), [logs]);
  const currentStep = effectivePlan.find((step) => step.status === 'in_progress') ?? null;
  const stepScripts = useMemo(() => {
    const next: Record<string, string> = {};

    if (currentStep?.id && commandScript) {
      next[currentStep.id] = commandScript;
    }

    return next;
  }, [commandScript, currentStep?.id]);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  useEffect(() => {
    if (currentStep?.id && stepScripts[currentStep.id]) {
      setExpandedStepId((prev) => prev ?? currentStep.id);
    }
  }, [currentStep?.id, stepScripts]);

  return (
    <div className="section-list">
      <div className="section-title">进度</div>
      {latestSessionSummary ? (
        <div className="section-card plan-summary-card">
          <div className="text-strong">本次摘要</div>
          <div className="body-copy-soft mt-8">{latestSessionSummary}</div>
        </div>
      ) : null}
      {plan.length === 0 ? (
        <div className="section-card">
          <div className="text-strong">暂无计划</div>
          <div className="body-copy-soft mt-8">agent 运行后会在这里展示步骤计划。</div>
        </div>
      ) : (
        <div className="task-progress-card task-progress-card-compact">
          <div className="task-progress-header">
            <div className="task-progress-summary">
              <div className="task-progress-meta">
                共 {effectivePlan.length} 个任务，已经完成 {effectiveCompletedCount} 个
              </div>
            </div>
          </div>

          <div className="task-progress-list">
            {effectivePlan.map((step, index) => (
              <div key={`${step.id}-${index}`} className={`task-progress-step ${step.status}`}>
                <div className={`task-progress-item ${step.status}`}>
                  <div className="task-progress-index">{index + 1}.</div>
                  <div className="task-progress-marker">{getStepIcon(step.status)}</div>
                  <span className="task-progress-text">{step.title}</span>
                  {shouldShowStopButton(step, runStatus) && (
                    <button
                      type="button"
                      className="task-progress-stop-button"
                      aria-label="停止当前命令"
                      title="停止当前命令"
                      onClick={() => void onStopRun()}
                    >
                      <Square size={12} />
                    </button>
                  )}
                </div>
                {stepScripts[step.id] && (
                  <div className="task-step-script">
                    <button
                      type="button"
                      className="task-step-script-toggle"
                      onClick={() => setExpandedStepId((prev) => (prev === step.id ? null : step.id))}
                    >
                      <span>{expandedStepId === step.id ? '收起脚本' : '展开脚本'}</span>
                      <ChevronDown size={14} className={expandedStepId === step.id ? 'expanded' : ''} />
                    </button>
                    {expandedStepId === step.id && <pre className="task-step-script-block">{stepScripts[step.id]}</pre>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function shouldShowStopButton(step: PlanStepItem, runStatus: RunStatus) {
  return runStatus === 'running' && step.status === 'in_progress' && step.title.includes('tool.shell.exec');
}

function extractLatestCommandScript(logs: RunLogItem[]) {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const text = logs[index]?.text?.trim() || '';
    if (!text.startsWith('执行命令：')) {
      continue;
    }

    return text.replace(/^执行命令：\s*/u, '').trim();
  }

  return '';
}
