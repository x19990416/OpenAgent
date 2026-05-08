import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ScheduledTaskFrequency = 'once' | 'interval' | 'daily';
export type ScheduledTaskStatus = 'active' | 'paused';
export type ScheduledTaskRunStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export type ScheduledTaskSessionPolicy = 'new_each_run' | 'reuse_existing';

export interface ScheduledTaskRecord {
  id: string;
  title: string;
  prompt: string;
  agentId?: string;
  sessionPolicy?: ScheduledTaskSessionPolicy;
  threadId?: string | null;
  frequency: ScheduledTaskFrequency;
  status: ScheduledTaskStatus;
  runAt?: string;
  intervalMinutes?: number;
  timeOfDay?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduledTaskRunStatus;
  lastRunSummary?: string | null;
  lastRunThreadId?: string | null;
}

export interface CreateScheduledTaskInput {
  title?: string;
  prompt: string;
  agentId?: string;
  sessionPolicy?: ScheduledTaskSessionPolicy;
  threadId?: string | null;
  frequency: ScheduledTaskFrequency;
  runAt?: string;
  intervalMinutes?: number;
  timeOfDay?: string;
  enabled?: boolean;
}

interface ScheduledTaskServiceOptions {
  onDue: (task: ScheduledTaskRecord) => Promise<{ ok: boolean; summary?: string; error?: string; threadId?: string | null }>;
  onChange?: (tasks: ScheduledTaskRecord[]) => void;
  storageFile?: string;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

export class ScheduledTaskService {
  private readonly storageFile: string;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tasks = new Map<string, ScheduledTaskRecord>();

  constructor(private readonly options: ScheduledTaskServiceOptions) {
    this.storageFile = options.storageFile ?? path.join(os.homedir(), '.openagent', 'state', 'scheduled-tasks.json');
    this.load();
    this.rescheduleAll();
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => {
      const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  }

  create(input: CreateScheduledTaskInput) {
    const now = new Date();
    const title = input.title?.trim() || input.prompt.trim().slice(0, 28) || '未命名定时任务';
    const task: ScheduledTaskRecord = {
      id: `schedule-${randomUUID()}`,
      title,
      prompt: input.prompt.trim(),
      agentId: input.agentId || 'main',
      sessionPolicy: input.sessionPolicy || (input.threadId ? 'reuse_existing' : 'new_each_run'),
      threadId: input.threadId || null,
      frequency: input.frequency,
      status: input.enabled === false ? 'paused' : 'active',
      runAt: input.runAt,
      intervalMinutes: input.intervalMinutes,
      timeOfDay: input.timeOfDay,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: 'idle',
      lastRunSummary: null,
      lastRunThreadId: null
    };

    task.nextRunAt = task.status === 'active' ? computeNextRunAt(task, now) : null;
    this.tasks.set(task.id, task);
    this.persistAndNotify();
    this.schedule(task);
    return task;
  }

  delete(taskId: string) {
    this.clearTimer(taskId);
    const deleted = this.tasks.delete(taskId);
    if (deleted) this.persistAndNotify();
    return { ok: deleted };
  }

  setEnabled(taskId: string, enabled: boolean) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `Scheduled task not found: ${taskId}` };
    task.status = enabled ? 'active' : 'paused';
    task.updatedAt = new Date().toISOString();
    task.nextRunAt = enabled ? computeNextRunAt(task, new Date()) : null;
    this.clearTimer(taskId);
    this.persistAndNotify();
    this.schedule(task);
    return { ok: true, task };
  }

  async runNow(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `Scheduled task not found: ${taskId}` };
    await this.execute(task);
    return { ok: true, task };
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private load() {
    try {
      const parsed = this.readPersistedTasks(this.storageFile) ?? this.readPersistedTasks(`${this.storageFile}.bak`);
      if (!parsed) return;
      for (const task of parsed.tasks ?? []) {
        if (!task.id || !task.prompt) continue;
        if (!task.agentId) task.agentId = 'main';
        if (!task.sessionPolicy) task.sessionPolicy = task.threadId ? 'reuse_existing' : 'new_each_run';
        if (task.lastRunStatus === 'running') task.lastRunStatus = 'failed';
        if (task.status === 'active') task.nextRunAt = computeNextRunAt(task, new Date());
        this.tasks.set(task.id, task);
      }
    } catch (error) {
      console.warn('[scheduled-task-service] failed to load scheduled tasks', error);
    }
  }

  private persistAndNotify() {
    fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
    const serialized = JSON.stringify({ schemaVersion: 1, tasks: this.list() }, null, 2);
    const tempFile = `${this.storageFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, serialized);
    fs.renameSync(tempFile, this.storageFile);
    try {
      fs.copyFileSync(this.storageFile, `${this.storageFile}.bak`);
    } catch (error) {
      console.warn('[scheduled-task-service] failed to write scheduled tasks backup', error);
    }
    this.options.onChange?.(this.list());
  }

  private readPersistedTasks(file: string) {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { tasks?: ScheduledTaskRecord[] };
  }

  private rescheduleAll() {
    for (const task of this.tasks.values()) this.schedule(task);
  }

  private schedule(task: ScheduledTaskRecord) {
    this.clearTimer(task.id);
    if (task.status !== 'active' || !task.nextRunAt) return;

    const delayMs = Math.max(0, new Date(task.nextRunAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      void this.execute(task);
    }, Math.min(delayMs, MAX_TIMEOUT_MS));
    this.timers.set(task.id, timer);
  }

  private clearTimer(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
  }

  private async execute(task: ScheduledTaskRecord) {
    if (task.lastRunStatus === 'running') return;

    this.clearTimer(task.id);
    task.lastRunAt = new Date().toISOString();
    task.lastRunStatus = 'running';
    task.lastRunSummary = '定时任务已触发，正在提交给 agent runtime。';
    task.updatedAt = task.lastRunAt;
    this.persistAndNotify();

    try {
      const result = await this.options.onDue(task);
      task.lastRunStatus = result.ok ? 'succeeded' : 'failed';
      task.lastRunSummary = result.summary || result.error || (result.ok ? '定时任务已提交。' : '定时任务执行失败。');
      task.lastRunThreadId = result.threadId || task.threadId || null;
      if (task.sessionPolicy === 'reuse_existing' && result.threadId && task.threadId !== result.threadId) {
        task.threadId = result.threadId;
      }
    } catch (error) {
      task.lastRunStatus = 'failed';
      task.lastRunSummary = error instanceof Error ? error.message : String(error);
    }

    const now = new Date();
    if (task.frequency === 'once') {
      task.status = 'paused';
      task.nextRunAt = null;
    } else if (task.status === 'active') {
      task.nextRunAt = computeNextRunAt(task, now);
    }
    task.updatedAt = now.toISOString();
    this.persistAndNotify();
    this.schedule(task);
  }
}

function computeNextRunAt(task: ScheduledTaskRecord, from: Date): string | null {
  if (task.frequency === 'once') {
    const runAt = task.runAt ? new Date(task.runAt) : null;
    if (!runAt || Number.isNaN(runAt.getTime())) return null;
    return runAt.getTime() <= from.getTime() ? from.toISOString() : runAt.toISOString();
  }

  if (task.frequency === 'interval') {
    const minutes = Math.max(1, Number(task.intervalMinutes || 60));
    return new Date(from.getTime() + minutes * 60_000).toISOString();
  }

  if (task.frequency === 'daily') {
    const match = /^(\d{1,2}):(\d{2})$/.exec(task.timeOfDay || '09:00');
    const hour = Math.min(23, Math.max(0, Number(match?.[1] ?? 9)));
    const minute = Math.min(59, Math.max(0, Number(match?.[2] ?? 0)));
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  return null;
}
