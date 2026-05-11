import { AlertTriangle, Check, CheckCircle2, ChevronDown, Circle, Clock3, Infinity, LoaderCircle, ShieldCheck, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest, PlanStepItem, RunStatus, RuntimeActivityItem } from '@shared-types/events';
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
  runtimeActivities,
  approvals,
  onResolveApproval,
  onStopRun,
  runErrorSummary,
  runErrorDetail
}: {
  plan: PlanStepItem[];
  logs: RunLogItem[];
  runStatus: RunStatus;
  latestSessionSummary: string | null;
  runtimeActivities: RuntimeActivityItem[];
  approvals: ApprovalRequest[];
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'session' | 'always') => Promise<void>;
  onStopRun: (runId?: string) => Promise<{ ok: boolean; error?: string }>;
  runErrorSummary: string | null;
  runErrorDetail: string | null;
}) {
  const completedCount = plan.filter((step) => step.status === 'completed').length;
  const effectivePlan = plan;
  const effectiveCompletedCount = completedCount;
  const pendingApproval = approvals[0] ?? null;
  const commandScript = useMemo(() => extractLatestCommandScript(logs), [logs]);
  const currentStep = effectivePlan.find((step) => step.status === 'in_progress') ?? null;
  const approvalStepId = pendingApproval ? getApprovalStepId(effectivePlan, currentStep) : null;
  const stepScripts = useMemo(() => {
    const next: Record<string, string> = {};

    if (currentStep?.id && commandScript) {
      next[currentStep.id] = commandScript;
    }

    return next;
  }, [commandScript, currentStep?.id]);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [arePlanStepsExpanded, setArePlanStepsExpanded] = useState(false);
  const planActivities = useMemo(() => groupActivitiesByPlanStep(runtimeActivities), [runtimeActivities]);
  const visiblePlanEntries = useMemo(() => {
    const entries = effectivePlan.map((step, index) => ({ step, index }));
    if (arePlanStepsExpanded || entries.length <= 1) return entries;
    const focusedIndex = getFocusedPlanStepIndex(effectivePlan, runStatus, approvalStepId);
    return focusedIndex >= 0 ? [entries[focusedIndex]] : entries.slice(-1);
  }, [approvalStepId, arePlanStepsExpanded, effectivePlan, runStatus]);

  useEffect(() => {
    if (currentStep?.id && stepScripts[currentStep.id]) {
      setExpandedStepId((prev) => prev ?? currentStep.id);
    }
  }, [currentStep?.id, stepScripts]);

  async function handleResolveApproval(approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'session' | 'always') {
    setResolvingApprovalId(approvalId);
    try {
      await onResolveApproval(approvalId, decision, scope);
    } finally {
      setResolvingApprovalId((current) => (current === approvalId ? null : current));
    }
  }

  return (
    <div className="section-list">
      <div className="section-title">进度</div>
      {plan.length === 0 ? (
        <>
          <RunStatusCard
            runStatus={runStatus}
            approvals={approvals}
            latestSessionSummary={latestSessionSummary}
            runErrorSummary={runErrorSummary}
            runErrorDetail={runErrorDetail}
            resolvingApprovalId={resolvingApprovalId}
            onResolveApproval={handleResolveApproval}
          />
          {shouldShowRuntimeActivities(runStatus, runtimeActivities) ? (
            <RuntimeActivityList activities={runtimeActivities} />
          ) : null}
        </>
      ) : (
        <div className="task-progress-card task-progress-card-compact plan-mode-progress-card">
          <PlanModeHeader
            runStatus={runStatus}
            pendingApproval={pendingApproval}
            completedCount={effectiveCompletedCount}
            totalCount={effectivePlan.length}
            runErrorSummary={runErrorSummary}
            runErrorDetail={runErrorDetail}
          />

          {shouldShowRuntimeActivities(runStatus, runtimeActivities) ? (
            <div className="plan-mode-activity-section plan-mode-activity-overview">
              <div className="plan-mode-subtitle">运行明细</div>
              <RuntimeActivityList activities={runtimeActivities} embedded />
            </div>
          ) : null}

          <div className="plan-mode-step-toolbar">
            <span>执行步骤</span>
            {effectivePlan.length > 1 ? (
              <button
                type="button"
                className="runtime-activity-toggle plan-mode-steps-toggle"
                onClick={() => setArePlanStepsExpanded((current) => !current)}
              >
                <span>{arePlanStepsExpanded ? '收起步骤' : `展开全部 ${effectivePlan.length} 个步骤`}</span>
                <ChevronDown size={14} className={arePlanStepsExpanded ? 'expanded' : ''} />
              </button>
            ) : null}
          </div>

          <div className="task-progress-list plan-mode-step-list">
            {visiblePlanEntries.map(({ step, index }) => {
              const stepActivities = planActivities[step.id] ?? [];
              return (
              <div key={`${step.id}-${index}`} className={`task-progress-step ${step.status}`}>
                <div className={`task-progress-item ${step.status}`}>
                  <div className="task-progress-index">{index + 1}.</div>
                  <div className="task-progress-marker">{getStepIcon(step.status)}</div>
                  <span className="task-progress-text">{step.title}</span>
                  {(step.riskLevel || step.requiresApproval || shouldShowStopButton(step, runStatus)) && (
                    <div className="plan-step-inline-actions">
                      {step.requiresApproval && (
                        <span className="plan-step-badge approval"><ShieldCheck size={12} />需审批</span>
                      )}
                      {step.riskLevel && <span className={`plan-step-badge risk-${step.riskLevel}`}>{formatRisk(step.riskLevel)}</span>}
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
                  )}
                </div>
                {(step.description || step.allowedTools?.length || step.resultSummary || step.error) && (
                  <div className="plan-step-detail">
                    {step.description && <div className="plan-step-description">{step.description}</div>}
                    {step.allowedTools?.length ? (
                      <div className="plan-step-tools">
                        {step.allowedTools.map((tool) => <span key={tool} className="plan-step-tool">{tool}</span>)}
                      </div>
                    ) : null}
                    {step.resultSummary && <div className="plan-step-result">结果：{step.resultSummary}</div>}
                    {step.error && <div className="plan-step-error"><AlertTriangle size={12} />{step.error}</div>}
                  </div>
                )}
                {pendingApproval && step.id === approvalStepId ? (
                  <PlanStepApprovalActions
                    approval={pendingApproval}
                    resolvingApprovalId={resolvingApprovalId}
                    onResolveApproval={handleResolveApproval}
                  />
                ) : null}
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
                {stepActivities.length > 0 ? (
                  <div className="plan-step-activity">
                    <div className="plan-mode-subtitle">本步骤运行明细</div>
                    <RuntimeActivityList activities={stepActivities} embedded />
                  </div>
                ) : null}
              </div>
              );
            })}
          </div>

        </div>
      )}
    </div>
  );
}

function PlanModeHeader({
  runStatus,
  pendingApproval,
  completedCount,
  totalCount,
  runErrorSummary,
  runErrorDetail
}: {
  runStatus: RunStatus;
  pendingApproval: ApprovalRequest | null;
  completedCount: number;
  totalCount: number;
  runErrorSummary: string | null;
  runErrorDetail: string | null;
}) {
  const content = getRunStatusContent(runStatus, pendingApproval, null, runErrorSummary, runErrorDetail);
  const detail = pendingApproval ? formatAgentPlanApprovalReason(pendingApproval) : content.description || runErrorDetail;

  return (
    <div className="plan-mode-header">
      <div className={`run-status-line ${content.status}`}>
        <span className="run-status-icon">{getStepIcon(content.status)}</span>
        <div className="plan-mode-title-stack">
          <span className="run-status-title">{formatPlanModeTitle(content.title)}</span>
          <span className="plan-mode-count">共 {totalCount} 个计划步骤，已完成 {completedCount} 个</span>
        </div>
      </div>
      {detail ? <div className="run-status-description plan-mode-description">{detail}</div> : null}
    </div>
  );
}

function groupActivitiesByPlanStep(activities: RuntimeActivityItem[]) {
  return activities.reduce<Record<string, RuntimeActivityItem[]>>((groups, activity) => {
    if (!activity.planStepId) return groups;
    groups[activity.planStepId] = [...(groups[activity.planStepId] ?? []), activity];
    return groups;
  }, {});
}

function getFocusedPlanStepIndex(plan: PlanStepItem[], runStatus: RunStatus, approvalStepId: string | null) {
  if (approvalStepId) {
    const approvalIndex = plan.findIndex((step) => step.id === approvalStepId);
    if (approvalIndex >= 0) return approvalIndex;
  }

  const activeIndex = plan.findIndex((step) => step.status === 'in_progress' || step.status === 'blocked');
  if (activeIndex >= 0) return activeIndex;

  const failedIndex = plan.findIndex((step) => step.status === 'failed');
  if (failedIndex >= 0) return failedIndex;

  if (runStatus === 'succeeded') {
    const lastCompletedIndex = findLastPlanStepIndex(plan, (step) => step.status === 'completed');
    if (lastCompletedIndex >= 0) return lastCompletedIndex;
  }

  const pendingIndex = plan.findIndex((step) => step.status === 'pending');
  return pendingIndex >= 0 ? pendingIndex : plan.length - 1;
}

function findLastPlanStepIndex(plan: PlanStepItem[], predicate: (step: PlanStepItem) => boolean) {
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    if (predicate(plan[index])) return index;
  }
  return -1;
}

function RuntimeActivityList({ activities, embedded = false }: { activities: RuntimeActivityItem[]; embedded?: boolean }) {

  const collapseLimit = 3;
  const [isExpanded, setIsExpanded] = useState(false);

  if (activities.length === 0) return null;

  const shouldCollapse = activities.length > collapseLimit;
  const visibleActivities = shouldCollapse && !isExpanded ? activities.slice(-collapseLimit) : activities;
  const hiddenCount = activities.length - visibleActivities.length;
  const summary = summarizeRuntimeActivities(activities);

  return (
    <div className={`runtime-activity-block${embedded ? ' embedded' : ''}`}>
      <button
        type="button"
        className="runtime-activity-summary-toggle"
        onClick={() => shouldCollapse && setIsExpanded((current) => !current)}
        disabled={!shouldCollapse}
      >
        <span className="runtime-activity-summary-icon">⌘</span>
        <span>{summary}</span>
        {shouldCollapse ? <ChevronDown size={14} className={isExpanded ? 'expanded' : ''} /> : null}
      </button>
      <div className="runtime-activity-list">
        {hiddenCount > 0 ? <div className="runtime-activity-hidden-tip">已折叠前 {hiddenCount} 条</div> : null}
        {visibleActivities.map((activity) => (
          <div key={activity.id} className={`runtime-activity-item ${activity.status}`}>
            <span className="runtime-activity-icon">
              {activity.status === 'running' ? (
                <LoaderCircle size={13} className="task-progress-icon spinning" />
              ) : activity.status === 'failed' ? (
                <AlertTriangle size={13} />
              ) : (
                <CheckCircle2 size={13} />
              )}
            </span>
            <span className="runtime-activity-title" title={activity.title}>{activity.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function summarizeRuntimeActivities(activities: RuntimeActivityItem[]) {
  const completed = activities.filter((activity) => activity.status !== 'failed');
  const readCount = completed.filter((activity) => activity.kind === 'read' || activity.kind === 'list').length;
  const searchCount = completed.filter((activity) => activity.kind === 'search').length;
  const commandCount = completed.filter((activity) => activity.kind === 'command').length;
  const toolCount = completed.filter((activity) => activity.kind === 'tool').length;
  const failedCount = activities.filter((activity) => activity.status === 'failed').length;
  const parts: string[] = [];

  if (readCount > 0) parts.push(`已探索 ${readCount} 个文件`);
  if (searchCount > 0) parts.push(`${searchCount} 次搜索`);
  if (commandCount > 0) parts.push(`已运行 ${commandCount} 条命令`);
  if (toolCount > 0) parts.push(`已调用 ${toolCount} 个工具`);
  if (failedCount > 0) parts.push(`${failedCount} 个失败`);

  return parts.length > 0 ? parts.join('，') : `${activities.length} 条运行明细`;
}

function PlanStepApprovalActions({
  approval,
  resolvingApprovalId,
  onResolveApproval
}: {
  approval: ApprovalRequest;
  resolvingApprovalId: string | null;
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'session' | 'always') => Promise<void>;
}) {
  return (
    <div className="plan-step-approval">
      <div className="plan-step-approval-header">
        <ShieldCheck size={13} />
        <span>{approval.title}</span>
        <span className={`plan-step-badge risk-${approval.risk}`}>{formatApprovalRisk(approval.risk)}</span>
      </div>
      <pre className="run-status-detail compact minimal plan-step-approval-detail">
        {formatCompactApprovalDetail(approval)}
      </pre>
      <div className="run-status-actions minimal plan-step-approval-actions approval-icon-actions">
        <button
          className="success-button compact approval-icon-button"
          type="button"
          aria-label="批准并继续"
          data-tooltip="批准并继续"
          disabled={resolvingApprovalId === approval.id}
          onClick={() => void onResolveApproval(approval.id, 'approved')}
        >
          <Check size={14} />
        </button>
        <button
          className="ghost-button compact approval-icon-button"
          type="button"
          aria-label="本会话允许"
          data-tooltip="本会话允许"
          disabled={resolvingApprovalId === approval.id}
          onClick={() => void onResolveApproval(approval.id, 'approved', 'session')}
        >
          <Clock3 size={14} />
        </button>
        <button
          className="ghost-button compact approval-icon-button"
          type="button"
          aria-label="始终允许"
          data-tooltip="始终允许"
          disabled={resolvingApprovalId === approval.id}
          onClick={() => void onResolveApproval(approval.id, 'approved', 'always')}
        >
          <Infinity size={14} />
        </button>
        <button
          className="danger-button compact approval-icon-button"
          type="button"
          aria-label="拒绝"
          data-tooltip="拒绝"
          disabled={resolvingApprovalId === approval.id}
          onClick={() => void onResolveApproval(approval.id, 'rejected')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}


function RunStatusCard({
  runStatus,
  approvals,
  latestSessionSummary,
  runErrorSummary,
  runErrorDetail,
  resolvingApprovalId,
  onResolveApproval
}: {
  runStatus: RunStatus;
  approvals: ApprovalRequest[];
  latestSessionSummary: string | null;
  runErrorSummary: string | null;
  runErrorDetail: string | null;
  resolvingApprovalId: string | null;
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'session' | 'always') => Promise<void>;
}) {
  const pendingApproval = approvals[0] ?? null;
  const content = getRunStatusContent(runStatus, pendingApproval, null, runErrorSummary, runErrorDetail);
  const approvalDetail = pendingApproval ? formatCompactApprovalDetail(pendingApproval) : content.detail;

  return (
    <div className="run-status-minimal">
      <div className={`run-status-line ${content.status}`}>
        <span className="run-status-icon">{getStepIcon(content.status)}</span>
        <span className="run-status-title">{content.title}</span>
      </div>
      {content.description ? <div className="run-status-description">{content.description}</div> : null}
      {approvalDetail ? <pre className="run-status-detail compact minimal">{approvalDetail}</pre> : null}
      {pendingApproval ? (
        <div className="run-status-actions minimal approval-icon-actions">
          <button
            className="success-button compact approval-icon-button"
            type="button"
            aria-label="批准并继续"
            data-tooltip="批准并继续"
            disabled={resolvingApprovalId === pendingApproval.id}
            onClick={() => void onResolveApproval(pendingApproval.id, 'approved')}
          >
            <Check size={14} />
          </button>
          <button
            className="ghost-button compact approval-icon-button"
            type="button"
            aria-label="本会话允许"
            data-tooltip="本会话允许"
            disabled={resolvingApprovalId === pendingApproval.id}
            onClick={() => void onResolveApproval(pendingApproval.id, 'approved', 'session')}
          >
            <Clock3 size={14} />
          </button>
          <button
            className="ghost-button compact approval-icon-button"
            type="button"
            aria-label="始终允许"
            data-tooltip="始终允许"
            disabled={resolvingApprovalId === pendingApproval.id}
            onClick={() => void onResolveApproval(pendingApproval.id, 'approved', 'always')}
          >
            <Infinity size={14} />
          </button>
          <button
            className="danger-button compact approval-icon-button"
            type="button"
            aria-label="拒绝"
            data-tooltip="拒绝"
            disabled={resolvingApprovalId === pendingApproval.id}
            onClick={() => void onResolveApproval(pendingApproval.id, 'rejected')}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}


function getRunStatusContent(
  runStatus: RunStatus,
  pendingApproval: ApprovalRequest | null,
  latestSessionSummary: string | null,
  runErrorSummary: string | null,
  runErrorDetail: string | null
) {
  if (pendingApproval || runStatus === 'waiting_approval') {
    return {
      meta: '普通运行状态',
      title: '等待审批',
      description: pendingApproval?.title || '需要审批后继续执行。',
      detail: pendingApproval?.description || pendingApproval?.payloadPreview || null,
      status: 'in_progress' as const
    };
  }

  if (runStatus === 'running') {
    return {
      meta: '普通运行状态',
      title: '思考中',
      description: '',
      detail: null,
      status: 'in_progress' as const
    };
  }

  if (runStatus === 'failed') {
    return {
      meta: '普通运行状态',
      title: '运行失败',
      description: runErrorSummary || '本次运行失败。',
      detail: runErrorDetail,
      status: 'failed' as const
    };
  }

  if (runStatus === 'cancelled') {
    return {
      meta: '普通运行状态',
      title: '运行已停止',
      description: runErrorSummary || '本次运行已被取消或停止。',
      detail: runErrorDetail,
      status: 'pending' as const
    };
  }

  if (runStatus === 'succeeded') {
    return {
      meta: '普通运行状态',
      title: '本次运行已完成',
      description: '',
      detail: null,
      status: 'completed' as const
    };
  }

  return {
    meta: '普通运行状态',
    title: '等待任务',
    description: '提交请求后，这里会显示 Plan 或普通运行状态。',
    detail: null,
    status: 'pending' as const
  };
}

function formatPlanModeTitle(title: string) {
  if (title === '思考中') return '计划执行中';
  if (title === '本次运行已完成') return '计划执行完成';
  return title;
}

function shouldShowStopButton(step: PlanStepItem, runStatus: RunStatus) {
  return runStatus === 'running' && step.status === 'in_progress' && step.title.includes('tool.shell.exec');
}

function shouldShowRuntimeActivities(runStatus: RunStatus, activities: RuntimeActivityItem[]) {
  if (activities.length === 0) return false;
  return runStatus === 'running' || runStatus === 'waiting_approval' || runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled';
}

function getApprovalStepId(plan: PlanStepItem[], currentStep: PlanStepItem | null) {
  const approvalStep =
    (currentStep && currentStep.status !== 'completed' ? currentStep : null) ??
    plan.find((step) => step.status === 'in_progress' || step.status === 'blocked') ??
    plan.find((step) => step.status === 'pending') ??
    plan.find((step) => step.requiresApproval && step.status !== 'completed' && step.status !== 'skipped') ??
    plan.at(-1);

  return approvalStep?.id ?? null;
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

function formatRisk(risk: NonNullable<PlanStepItem['riskLevel']>) {
  if (risk === 'high') return '高风险';
  if (risk === 'medium') return '中风险';
  return '低风险';
}

function formatCompactApprovalDetail(approval: ApprovalRequest) {
  if (approval.actionType === 'agent-plan.execute') {
    return formatAgentPlanApprovalReason(approval);
  }

  const lines = [
    approval.description,
    approval.targetPath ? `${formatAccess(approval.access)}：${approval.targetPath}` : null,
    approval.scope ? `范围：${formatScope(approval.scope)}` : null,
    approval.payloadPreview
  ].filter(Boolean);

  return lines.join('\n');
}

function formatAgentPlanApprovalReason(approval: ApprovalRequest) {
  const descriptionLines = approval.description
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const reasonLine = descriptionLines.find((line) => line.startsWith('审批原因：'));
  const reason = reasonLine?.replace(/^审批原因：/u, '').trim();
  const fallbackReason =
    approval.risk === 'high'
      ? '该计划包含高风险操作，需要你确认后才能继续。'
      : approval.risk === 'medium'
        ? '该计划可能修改文件、执行工具或影响当前工作区，需要你确认后继续。'
        : '该计划进入执行阶段前需要你确认。';

  return reason || fallbackReason;
}

function formatApprovalRisk(risk: ApprovalRequest['risk']) {
  if (risk === 'high') return '高风险操作';
  if (risk === 'medium') return '需要确认';
  return '低风险提示';
}

function formatAccess(access: ApprovalRequest['access']) {
  if (access === 'read') return '只读';
  if (access === 'write') return '写入';
  if (access === 'execute') return '执行';
  return '未指定';
}

function formatScope(scope: ApprovalRequest['scope']) {
  if (scope === 'once') return '本次';
  if (scope === 'session') return '本会话';
  if (scope === 'always') return '长期';
  return '本次';
}
