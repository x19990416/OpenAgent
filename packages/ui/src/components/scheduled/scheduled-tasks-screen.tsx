import { useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, Clock3, PauseCircle, Play, Plus, Trash2, Zap } from 'lucide-react';
import type { CreateScheduledTaskInput, ScheduledTaskFrequency, ScheduledTaskItem, ScheduledTaskSessionPolicy } from '@openagent/shared-types/index';
import type { AgentSummaryItem, ThreadListItem } from '../../types/workbench';

export function ScheduledTasksScreen({
  scheduledTasks,
  agents,
  activeAgentId,
  threads,
  onCreateScheduledTask,
  onDeleteScheduledTask,
  onSetScheduledTaskEnabled,
  onRunScheduledTaskNow
}: {
  scheduledTasks: ScheduledTaskItem[];
  agents: AgentSummaryItem[];
  activeAgentId: string;
  threads: ThreadListItem[];
  onCreateScheduledTask: (payload: CreateScheduledTaskInput) => Promise<{ ok: boolean; error?: string }>;
  onDeleteScheduledTask: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  onSetScheduledTaskEnabled: (taskId: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  onRunScheduledTaskNow: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const stats = useMemo(() => buildStats(scheduledTasks), [scheduledTasks]);
  const agentOptions = useMemo(() => normalizeAgentOptions(agents, activeAgentId), [agents, activeAgentId]);

  return (
    <section className="scheduled-page scroll-y">
      <div className="scheduled-console">
        <header className="scheduled-console-header compact">
          <div>
            <h1>定时任务</h1>
            <p>让 OpenAgent 在指定时间自动提交任务、运行 agent loop，并保留每次运行状态。</p>
          </div>
        </header>

        <div className="scheduled-stats-grid">
          <StatCard icon={Zap} label="启用中" value={stats.active} tone="blue" />
          <StatCard icon={PauseCircle} label="已暂停" value={stats.paused} tone="amber" />
          <StatCard icon={CheckCircle2} label="成功运行" value={stats.succeeded} tone="green" />
          <StatCard icon={Clock3} label="下次执行" value={stats.nextRunLabel} tone="slate" />
        </div>

        <div className="scheduled-console-body">
          <main className="scheduled-list-panel">
            <div className="scheduled-panel-title-row">
              <div>
                <div className="scheduled-page-section-title">任务列表</div>
                <div className="body-copy-soft">共 {scheduledTasks.length} 个定时任务</div>
              </div>
            </div>

            {scheduledTasks.length === 0 ? (
              <div className="scheduled-empty-state">
                <div className="scheduled-empty-icon"><CalendarClock size={28} /></div>
                <h2>还没有自动化计划</h2>
                <p>在右侧创建第一个任务，例如每天 09:00 检查仓库状态、生成日报或清理待办。</p>
              </div>
            ) : (
              <div className="scheduled-task-list">
                {scheduledTasks.map((task) => (
                  <article key={task.id} className="scheduled-task-row-card">
                    <div className="scheduled-task-main">
                      <div className="scheduled-task-icon"><CalendarClock size={17} /></div>
                      <div className="scheduled-task-content">
                        <div className="scheduled-task-title-line">
                          <h3>{task.title}</h3>
                          <span className={`status-badge ${task.status === 'active' ? 'info' : 'warn'}`}>{task.status === 'active' ? '启用' : '暂停'}</span>
                        </div>
                        <div className="scheduled-task-meta-line">
                          <span>智能体：{formatAgentName(task.agentId, agentOptions)}</span>
                          <span>Session：{formatSessionPolicy(task, threads)}</span>
                          <span>{formatSchedule(task)}</span>
                          <span>下次：{task.nextRunAt ? formatDateTime(task.nextRunAt) : '—'}</span>
                          <span>上次：{task.lastRunAt ? `${formatDateTime(task.lastRunAt)} / ${formatRunStatus(task.lastRunStatus)}` : '未运行'}</span>
                        </div>
                        <p>{task.prompt}</p>
                        {task.lastRunSummary ? <div className="scheduled-task-summary">{task.lastRunSummary}</div> : null}
                      </div>
                    </div>
                    <div className="scheduled-task-actions">
                      <button type="button" className="task-runtime-stop-button neutral" onClick={() => void onRunScheduledTaskNow(task.id)}>
                        <Play size={13} />
                        运行
                      </button>
                      <button type="button" className="task-runtime-stop-button neutral" onClick={() => void onSetScheduledTaskEnabled(task.id, task.status !== 'active')}>
                        {task.status === 'active' ? '暂停' : '启用'}
                      </button>
                      <button type="button" className="task-runtime-stop-button" onClick={() => void onDeleteScheduledTask(task.id)} aria-label={`删除 ${task.title}`}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </main>

          <aside className="scheduled-create-panel">
            <ScheduledTaskComposer
              agents={agentOptions}
              activeAgentId={activeAgentId}
              threads={threads}
              onCreateScheduledTask={onCreateScheduledTask}
            />
          </aside>
        </div>
      </div>
    </section>
  );
}

function StatCard({ icon: Icon, label, value, tone }: { icon: typeof Clock3; label: string; value: string | number; tone: 'blue' | 'amber' | 'green' | 'slate' }) {
  return (
    <div className={`scheduled-stat-card ${tone}`}>
      <div className="scheduled-stat-icon"><Icon size={17} /></div>
      <div>
        <div className="scheduled-stat-value">{value}</div>
        <div className="scheduled-stat-label">{label}</div>
      </div>
    </div>
  );
}

function ScheduledTaskComposer({
  agents,
  activeAgentId,
  threads,
  onCreateScheduledTask
}: {
  agents: AgentSummaryItem[];
  activeAgentId: string;
  threads: ThreadListItem[];
  onCreateScheduledTask: (payload: CreateScheduledTaskInput) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState(activeAgentId || agents[0]?.id || 'main');
  const [sessionPolicy, setSessionPolicy] = useState<ScheduledTaskSessionPolicy>('new_each_run');
  const [threadId, setThreadId] = useState('');
  const [frequency, setFrequency] = useState<ScheduledTaskFrequency>('daily');
  const [runAt, setRunAt] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!prompt.trim()) {
      setError('请填写要执行的任务内容。');
      return;
    }

    const payload: CreateScheduledTaskInput = {
      title,
      prompt,
      agentId: agentId || 'main',
      sessionPolicy,
      threadId: sessionPolicy === 'reuse_existing' ? threadId || null : null,
      frequency,
      enabled: true
    };
    if (frequency === 'once') payload.runAt = runAt ? new Date(runAt).toISOString() : new Date(Date.now() + 60_000).toISOString();
    if (frequency === 'interval') payload.intervalMinutes = intervalMinutes;
    if (frequency === 'daily') payload.timeOfDay = timeOfDay;

    const result = await onCreateScheduledTask(payload);
    if (!result.ok) {
      setError(result.error || '创建定时任务失败。');
      return;
    }
    setTitle('');
    setPrompt('');
    setSessionPolicy('new_each_run');
    setThreadId('');
  };

  return (
    <div className="scheduled-create-card">
      <div className="scheduled-create-title">
        <div className="scheduled-create-icon"><Plus size={16} /></div>
        <div>
          <h2>新建任务</h2>
          <p>配置触发周期和要交给 agent 的 prompt。</p>
        </div>
      </div>
      <label className="scheduled-field">
        <span>任务标题</span>
        <input className="scheduled-task-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：每日仓库巡检" />
      </label>
      <div className="scheduled-field-grid">
        <label className="scheduled-field">
          <span>执行智能体</span>
          <select className="scheduled-task-input" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{formatAgentName(agent.id, agents)}</option>
            ))}
          </select>
        </label>
        <label className="scheduled-field">
          <span>会话策略</span>
          <select className="scheduled-task-input" value={sessionPolicy} onChange={(event) => setSessionPolicy(event.target.value as ScheduledTaskSessionPolicy)}>
            <option value="new_each_run">每次创建新 session</option>
            <option value="reuse_existing">复用 session</option>
          </select>
        </label>
      </div>
      {sessionPolicy === 'reuse_existing' ? (
        <label className="scheduled-field">
          <span>指定 session</span>
          <select className="scheduled-task-input" value={threadId} onChange={(event) => setThreadId(event.target.value)}>
            <option value="">首次执行自动创建，后续复用</option>
            {threads.map((thread) => (
              <option key={thread.threadId} value={thread.threadId}>{formatThreadTitle(thread)}</option>
            ))}
          </select>
          <div className="scheduled-form-hint">任务会保存到本地，重启 OpenAgent 后继续按周期触发。</div>
        </label>
      ) : (
        <div className="scheduled-form-hint">默认每次执行创建独立 session，避免长期上下文互相污染。</div>
      )}
      <label className="scheduled-field">
        <span>执行内容</span>
        <textarea className="scheduled-task-textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：检查当前仓库 TODO、未提交变更和最近运行失败，并给出摘要" />
      </label>
      <div className="scheduled-field-grid">
        <label className="scheduled-field">
          <span>周期</span>
          <select className="scheduled-task-input" value={frequency} onChange={(event) => setFrequency(event.target.value as ScheduledTaskFrequency)}>
            <option value="daily">每天</option>
            <option value="interval">间隔</option>
            <option value="once">一次性</option>
          </select>
        </label>
        <label className="scheduled-field">
          <span>{frequency === 'daily' ? '执行时间' : frequency === 'interval' ? '间隔分钟' : '执行日期'}</span>
          {frequency === 'daily' && <input className="scheduled-task-input" type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />}
          {frequency === 'interval' && <input className="scheduled-task-input" type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value || 1))} />}
          {frequency === 'once' && <input className="scheduled-task-input" type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />}
        </label>
      </div>
      {frequency === 'interval' ? <div className="scheduled-form-hint">任务会每 {intervalMinutes || 1} 分钟自动提交一次。</div> : null}
      {error ? <div className="settings-inline-error">{error}</div> : null}
      <button type="button" className="scheduled-primary-button" onClick={() => void submit()}>
        <Plus size={15} />
        创建定时任务
      </button>
    </div>
  );
}


function normalizeAgentOptions(agents: AgentSummaryItem[], activeAgentId: string): AgentSummaryItem[] {
  if (agents.length > 0) return agents;
  return [
    {
      id: activeAgentId || 'main',
      kind: 'system',
      workspaceRoot: '',
      providerId: '',
      model: '',
      description: 'OpenAgent 主智能体',
      updatedAt: new Date().toISOString()
    }
  ];
}

function formatAgentName(agentId: string, agents: AgentSummaryItem[]) {
  const agent = agents.find((item) => item.id === agentId);
  return agent?.description || agent?.id || agentId || 'main';
}

function formatSessionPolicy(task: ScheduledTaskItem, threads: ThreadListItem[]) {
  if (task.sessionPolicy !== 'reuse_existing') return '每次新建';
  const thread = threads.find((item) => item.threadId === task.threadId);
  return thread ? formatThreadTitle(thread) : task.threadId || '首次执行后复用';
}

function formatThreadTitle(thread: ThreadListItem) {
  return `${thread.title || '未命名 session'} · ${thread.threadId.slice(0, 12)}`;
}

function buildStats(tasks: ScheduledTaskItem[]) {
  let active = 0;
  let paused = 0;
  let succeeded = 0;
  let nextRun = Number.POSITIVE_INFINITY;

  for (const task of tasks) {
    if (task.status === 'active') active += 1;
    if (task.status === 'paused') paused += 1;
    if (task.lastRunStatus === 'succeeded') succeeded += 1;

    const nextRunAt = task.nextRunAt ? new Date(task.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
    if (Number.isFinite(nextRunAt) && nextRunAt < nextRun) {
      nextRun = nextRunAt;
    }
  }

  return {
    active,
    paused,
    succeeded,
    nextRunLabel: Number.isFinite(nextRun) ? formatDateTime(new Date(nextRun).toISOString()) : '—'
  };
}

function formatSchedule(task: ScheduledTaskItem) {
  if (task.frequency === 'once') return `一次性 / ${task.runAt ? formatDateTime(task.runAt) : '未设置时间'}`;
  if (task.frequency === 'interval') return `每 ${task.intervalMinutes || 60} 分钟`;
  return `每天 ${task.timeOfDay || '09:00'}`;
}

function formatRunStatus(status: ScheduledTaskItem['lastRunStatus']) {
  if (status === 'succeeded') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  return '未运行';
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}
