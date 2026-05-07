import { useEffect, useState } from 'react';
import type {
  ApprovalRequest,
  ApprovalResolution,
  MessageItem,
  PatchArtifact,
  PlanStepItem,
  RunFailurePayload,
  ToolCallItem,
  UiEvent,
  WorkspaceMeta
} from '@shared-types/events';
import type { CreateScheduledTaskInput, PromptSubmission, ScheduledTaskItem } from '@shared-types/index';
import type { PromptSubmissionResult } from '@shared-types/index';
import { initialWorkbenchData } from '@/mock/mock-data';
import type {
  AgentSummaryItem,
  BrowserSessionItem,
  MainAgentBootstrapSnapshot,
  RunLogItem,
  RuntimeTaskItem,
  WorkbenchViewModel
} from '@/types/workbench';
import type { RunStatus } from '@shared-types/events';

const PLACEHOLDER_PLAN_STEP_ID = 'run-placeholder-step';

export function useUiEventStream() {
  const [viewModel, setViewModel] = useState<WorkbenchViewModel>(initialWorkbenchData);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const desktopApi = window.desktopApi;

    if (!desktopApi) {
      console.warn('desktopApi is unavailable, using empty workspace state');
      return;
    }

    void desktopApi
      .getWorkspaceMeta()
      .then((workspace: WorkspaceMeta) => {
        setViewModel((prev) => ({ ...prev, workspace, runStatus: workspace.runStatus }));
      })
      .catch((error) => {
        console.error('getWorkspaceMeta failed', error);
      });

    void desktopApi
.getActiveAgentBootstrap()
      .then((agentBootstrap: MainAgentBootstrapSnapshot) => {
        setViewModel((prev) => ({ ...prev, agentBootstrap }));
      })
      .catch((error) => {
        console.error('getActiveAgentBootstrap failed', error);
      });


    void desktopApi
      .listAgents()
      .then(({ activeAgentId, agents }: { activeAgentId: string; agents: AgentSummaryItem[] }) => {
        setViewModel((prev) => ({ ...prev, activeAgentId, agents }));
      })
      .catch((error) => {
        console.error('listAgents failed', error);
      });

    const refreshStateSnapshot = async () => {
      try {
        const snapshot = await desktopApi.getStateSnapshot();
        if (!snapshot) return;
        setViewModel((prev) => applyStateSnapshot(prev, snapshot));
      } catch (error) {
        console.error('getStateSnapshot failed', error);
      }
    };

    const refreshRuntimeTasks = async () => {
      try {
        const tasks = await desktopApi.getRuntimeTasks?.();
        if (!tasks) return;
        setViewModel((prev) => ({ ...prev, runtimeTasks: tasks as RuntimeTaskItem[] }));
      } catch (error) {
        console.error('getRuntimeTasks failed', error);
      }
    };

    const refreshScheduledTasks = async () => {
      try {
        const tasks = await desktopApi.listScheduledTasks?.();
        if (!tasks) return;
        setViewModel((prev) => ({ ...prev, scheduledTasks: tasks as ScheduledTaskItem[] }));
      } catch (error) {
        console.error('listScheduledTasks failed', error);
      }
    };

    void refreshStateSnapshot();
    void refreshRuntimeTasks();
    void refreshScheduledTasks();

    try {
      cleanup = desktopApi.onUiEvent((event: UiEvent) => {
        setViewModel((prev) => mapUiEvent(prev, event));
        if (
          event.type === 'run.started' ||
          event.type === 'approval.required' ||
          event.type === 'approval.resolved' ||
          event.type === 'run.completed' ||
          event.type === 'run.cancelled' ||
          event.type === 'run.failed'
        ) {
          void refreshStateSnapshot();
        }
        if (
          event.type === 'run.started' ||
          event.type === 'tool.started' ||
          event.type === 'tool.completed' ||
          event.type === 'run.completed' ||
          event.type === 'run.cancelled' ||
          event.type === 'run.failed'
        ) {
          void refreshRuntimeTasks();
        }
        if (event.type === 'scheduled-task.updated') {
          const tasks = (event.payload as { tasks?: ScheduledTaskItem[] }).tasks;
          if (tasks) {
            setViewModel((prev) => ({ ...prev, scheduledTasks: tasks }));
          } else {
            void refreshScheduledTasks();
          }
        }
      });
    } catch (error) {
      console.error('onUiEvent subscription failed', error);
    }

    return () => {
      cleanup?.();
    };
  }, []);

  return {
    viewModel,
    updateWorkspace: (workspace: WorkspaceMeta) => {
      setViewModel((prev) => ({
        ...prev,
        workspace: {
          ...prev.workspace,
          ...workspace
        },
        runStatus: workspace.runStatus
      }));
    },
    submitPrompt: async (payload: PromptSubmission) => {
      const createdAt = new Date().toISOString();
      const prompt = payload.prompt;

      setViewModel((prev) => ({
        ...prev,
        runStatus: 'running',
        workspace: { ...prev.workspace, runStatus: 'running' },
        messages: [
          ...prev.messages,
          {
            id: `user-${createdAt}`,
            role: 'user',
            content: prompt,
            createdAt,
            attachments: payload.attachments ?? []
          }
        ],
        runLog: [...prev.runLog, { id: `log-${createdAt}`, level: 'info', text: `Prompt submitted: ${prompt}`, createdAt }]
      }));

      if (!window.desktopApi) {
        console.warn('desktopApi is unavailable, prompt will only update local workspace state');
        return { ok: true };
      }

      try {
        const result = await window.desktopApi.sendPrompt(payload);

        try {
          const snapshot = await window.desktopApi.getStateSnapshot();
          if (snapshot) {
            setViewModel((prev) => applyStateSnapshot(prev, snapshot));
          }
        } catch (error) {
          console.error('post-send getStateSnapshot failed', error);
        }

        return result as PromptSubmissionResult;
      } catch (error) {
        console.error('sendPrompt failed', error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        } as PromptSubmissionResult;
      }
    },
    stopRun: async (runId?: string) => {
      if (!window.desktopApi?.stopRun) {
        return { ok: false, error: 'desktopApi.stopRun is unavailable' };
      }

      try {
        const result = await window.desktopApi.stopRun(runId ? { runId } : undefined);

        try {
          const snapshot = await window.desktopApi.getStateSnapshot();
          if (snapshot) {
            setViewModel((prev) => applyStateSnapshot(prev, snapshot));
          }
        } catch (error) {
          console.error('post-stop getStateSnapshot failed', error);
        }

        try {
          const tasks = await window.desktopApi.getRuntimeTasks?.();
          if (tasks) {
            setViewModel((prev) => ({ ...prev, runtimeTasks: tasks as RuntimeTaskItem[] }));
          }
        } catch (error) {
          console.error('post-stop getRuntimeTasks failed', error);
        }

        return result;
      } catch (error) {
        console.error('stopRun failed', error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    },
    createScheduledTask: async (payload: CreateScheduledTaskInput) => {
      if (!window.desktopApi?.createScheduledTask) {
        return { ok: false, error: 'desktopApi.createScheduledTask is unavailable' };
      }
      try {
        await window.desktopApi.createScheduledTask(payload);
        const tasks = await window.desktopApi.listScheduledTasks?.();
        if (tasks) setViewModel((prev) => ({ ...prev, scheduledTasks: tasks as ScheduledTaskItem[] }));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
    deleteScheduledTask: async (taskId: string) => {
      if (!window.desktopApi?.deleteScheduledTask) return { ok: false, error: 'desktopApi.deleteScheduledTask is unavailable' };
      const result = await window.desktopApi.deleteScheduledTask({ taskId });
      const tasks = await window.desktopApi.listScheduledTasks?.();
      if (tasks) setViewModel((prev) => ({ ...prev, scheduledTasks: tasks as ScheduledTaskItem[] }));
      return result;
    },
    setScheduledTaskEnabled: async (taskId: string, enabled: boolean) => {
      if (!window.desktopApi?.setScheduledTaskEnabled) return { ok: false, error: 'desktopApi.setScheduledTaskEnabled is unavailable' };
      const result = await window.desktopApi.setScheduledTaskEnabled({ taskId, enabled });
      const tasks = await window.desktopApi.listScheduledTasks?.();
      if (tasks) setViewModel((prev) => ({ ...prev, scheduledTasks: tasks as ScheduledTaskItem[] }));
      return result;
    },
    runScheduledTaskNow: async (taskId: string) => {
      if (!window.desktopApi?.runScheduledTaskNow) return { ok: false, error: 'desktopApi.runScheduledTaskNow is unavailable' };
      const result = await window.desktopApi.runScheduledTaskNow({ taskId });
      const tasks = await window.desktopApi.listScheduledTasks?.();
      if (tasks) setViewModel((prev) => ({ ...prev, scheduledTasks: tasks as ScheduledTaskItem[] }));
      return result;
    },
    createAgent: async (id: string, description: string) => {
      if (!window.desktopApi) {
        return { ok: false, error: 'desktopApi is unavailable' };
      }

      try {
        const result = await window.desktopApi.createAgent({ id, description, activate: true });
        if (!result.ok) {
          throw new Error(result.error || 'Failed to create agent');
        }

        setViewModel((prev) => ({
          ...prev,
          activeAgentId: result.activeAgentId,
          agents: result.agents,
          agentBootstrap: result.agentBootstrap ?? prev.agentBootstrap
        }));

        const snapshot = result.snapshot;
        if (snapshot) {
          setViewModel((prev) => applyStateSnapshot(prev, snapshot));
        }

        return { ok: true };
      } catch (error) {
        console.error('createAgent failed', error);
        return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
    selectAgent: async (agentId: string) => {
      if (!window.desktopApi) {
        setViewModel((prev) => ({ ...prev, activeAgentId: agentId }));
        return { ok: true };
      }

      try {
        const result = await window.desktopApi.setActiveAgent({ agentId });
        if (!result.ok) {
          throw new Error(result.error || 'Failed to switch agent');
        }

        setViewModel((prev) => ({
          ...prev,
          activeAgentId: result.activeAgentId,
          agents: result.agents,
          agentBootstrap: result.agentBootstrap ?? prev.agentBootstrap
        }));

        const snapshot = result.snapshot;
        if (snapshot) {
          setViewModel((prev) => applyStateSnapshot(prev, snapshot));
        }

        return { ok: true };
      } catch (error) {
        console.error('selectAgent failed', error);
        return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
    createThread: async () => {
      if (!window.desktopApi) {
        return;
      }

      try {
        const result = await window.desktopApi.createThread();

        if (!result.ok) {
          throw new Error(result.error || 'Failed to create thread');
        }

        const snapshot = result.snapshot;
        if (snapshot) {
          setViewModel((prev) => applyStateSnapshot(prev, snapshot));
        }
      } catch (error) {
        console.error('createThread failed', error);
      }
    },
    selectThread: async (threadId: string) => {
      if (!window.desktopApi) {
        setViewModel((prev) => ({
          ...prev,
          activeThreadId: threadId
        }));
        return;
      }

      try {
        const result = await window.desktopApi.selectThread({ threadId });

        if (!result.ok) {
          throw new Error(result.error || 'Failed to select thread');
        }

        const snapshot = result.snapshot;
        if (snapshot) {
          setViewModel((prev) => applyStateSnapshot(prev, snapshot));
        }
      } catch (error) {
        console.error('selectThread failed', error);
      }
    },
    resolveApproval: async (approvalId: string, decision: 'approved' | 'rejected') => {
      if (!window.desktopApi) {
        const createdAt = new Date().toISOString();
        setViewModel((prev) => ({
          ...prev,
          approvals: prev.approvals.filter((approval) => approval.id !== approvalId),
          runLog: [
            ...prev.runLog,
            {
              id: `log-${approvalId}-${createdAt}`,
              level: decision === 'approved' ? 'info' : 'warn',
              text: decision === 'approved' ? 'Approval granted' : 'Approval rejected',
              createdAt
            }
          ]
        }));
        return;
      }

      try {
        const result = await window.desktopApi.resolveApproval({ approvalId, decision });

        if (!result.ok) {
          throw new Error(result.error || 'Failed to resolve approval');
        }
      } catch (error) {
        console.error('resolveApproval failed', error);
      }
    },
    deleteThread: async (threadId: string) => {
      if (!window.desktopApi) {
        return;
      }

      try {
        const result = await window.desktopApi.deleteThread({ threadId });

        if (!result.ok) {
          throw new Error(result.error || 'Failed to delete thread');
        }

        const snapshot = result.snapshot;
        if (snapshot) {
          setViewModel((prev) => applyStateSnapshot(prev, snapshot));
        }
      } catch (error) {
        console.error('deleteThread failed', error);

        try {
          const snapshot = await window.desktopApi.getStateSnapshot();
          if (snapshot) {
            setViewModel((prev) => applyStateSnapshot(prev, snapshot));
          }
        } catch (refreshError) {
          console.error('post-delete getStateSnapshot failed', refreshError);
        }
      }
    }
  };
}

function applyStateSnapshot(
  prev: WorkbenchViewModel,
  snapshot: NonNullable<Awaited<ReturnType<typeof window.desktopApi.getStateSnapshot>>>
): WorkbenchViewModel {
  const nextRunStatus = mapRunStatus(snapshot.latestRun?.status);

  return {
    ...prev,
    workspace: { ...prev.workspace, runStatus: nextRunStatus },
    activeAgentId: snapshot.activeAgentId,
    runStatus: nextRunStatus,
    latestSessionSummary: snapshot.latestRun?.summary?.trim() || null,
    browserSessions: prev.browserSessions,
    approvals: snapshot.pendingApproval
      ? [
          {
            id: snapshot.pendingApproval.approvalId,
            title: snapshot.pendingApproval.title,
            risk: snapshot.pendingApproval.actionType === 'update-soul' ? 'high' : 'medium',
            description: snapshot.pendingApproval.payloadPreview
          }
        ]
      : [],
    threads: snapshot.threads,
    recentRuns: snapshot.recentRuns,
    messages: snapshot.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: normalizeMessageContent(message.content),
      createdAt: message.createdAt,
      attachments: message.attachments ?? []
    })),
    activeThreadId: snapshot.activeThread?.threadId ?? null
  };
}

function mapUiEvent(prev: WorkbenchViewModel, event: UiEvent): WorkbenchViewModel {
  switch (event.type) {
    case 'run.started':
      return {
        ...prev,
        runStatus: 'running',
        workspace: { ...prev.workspace, runStatus: 'running' },
        plan: [
          {
            id: PLACEHOLDER_PLAN_STEP_ID,
            title: '正在执行任务…',
            status: 'in_progress'
          }
        ],
        runErrorSummary: null,
        runErrorDetail: null,
        runLog: [...prev.runLog, makeLog(event, 'info', 'Run started')]
      };
    case 'plan.updated':
      return {
        ...prev,
        plan: mergePlanStepsForDisplay(prev.plan, (event.payload as { steps?: PlanStepItem[] }).steps ?? prev.plan, prev.runStatus),
        runLog: [...prev.runLog, makeLog(event, 'info', 'Plan updated')]
      };
    case 'tool.started': {
      const tool = event.payload as ToolCallItem;
      const browserSessions = upsertBrowserSessionFromTool(prev.browserSessions, tool);
      return {
        ...prev,
        tools: upsertTool(prev.tools, tool),
        browserSessions,
        plan:
          prev.plan.length === 1 && prev.plan[0]?.id === PLACEHOLDER_PLAN_STEP_ID
            ? [
                {
                  ...prev.plan[0],
                  title: `正在执行：${tool.name}`
                }
              ]
            : prev.plan,
        runLog: [...prev.runLog, makeLog(event, 'info', `${tool.name} started`)]
      };
    }
    case 'tool.completed': {
      const tool = event.payload as ToolCallItem;
      const browserSessions = upsertBrowserSessionFromTool(prev.browserSessions, tool);
      return {
        ...prev,
        tools: prev.tools.map((item) => (item.id === tool.id ? tool : item)),
        browserSessions,
        runLog: [...prev.runLog, makeLog(event, 'info', `${tool.name} completed`)]
      };
    }
    case 'tool.failed': {
      const tool = event.payload as ToolCallItem;
      const browserSessions = upsertBrowserSessionFromTool(prev.browserSessions, tool);
      return {
        ...prev,
        tools: prev.tools.map((item) => (item.id === tool.id ? tool : item)),
        browserSessions,
        runLog: [...prev.runLog, makeLog(event, 'error', `${tool.name} failed`)]
      };
    }
    case 'message.completed': {
      const message = event.payload as MessageItem;
      return {
        ...prev,
        messages: [...prev.messages, { ...message, content: normalizeMessageContent(message.content) }]
      };
    }
    case 'patch.ready': {
      const patch = event.payload as PatchArtifact;
      return {
        ...prev,
        patch,
        runLog: [...prev.runLog, makeLog(event, 'info', 'Patch ready')]
      };
    }
    case 'approval.required': {
      const approval = event.payload as ApprovalRequest;
      return {
        ...prev,
        runStatus: 'waiting_approval',
        workspace: { ...prev.workspace, runStatus: 'waiting_approval' },
        approvals: [...prev.approvals, approval],
        runLog: [...prev.runLog, makeLog(event, 'warn', 'Approval required')]
      };
    }
    case 'approval.resolved': {
      const resolution = event.payload as ApprovalResolution;
      const nextRunStatus = resolution.decision === 'approved' ? 'running' : 'failed';
      return {
        ...prev,
        runStatus: nextRunStatus,
        workspace: { ...prev.workspace, runStatus: nextRunStatus },
        approvals: prev.approvals.filter((approval) => approval.id !== resolution.approvalId),
        runLog: [
          ...prev.runLog,
          makeLog(event, resolution.decision === 'approved' ? 'info' : 'warn', resolution.summary)
        ]
      };
    }
    case 'terminal.delta': {
      const text = (event.payload as { text?: string }).text ?? 'terminal output';
      return {
        ...prev,
        runLog: [...prev.runLog, makeLog(event, 'info', text)]
      };
    }
    case 'run.completed':
      {
        const summary = ((event.payload as { summary?: string }).summary || '').trim() || prev.latestSessionSummary;
      return {
        ...prev,
        runStatus: 'succeeded',
        workspace: { ...prev.workspace, runStatus: 'succeeded' },
        latestSessionSummary: summary,
        plan: prev.plan.map((step) => ({ ...step, status: 'completed' })),
        runErrorSummary: null,
        runErrorDetail: null,
        runLog: [...prev.runLog, makeLog(event, 'info', 'Run completed')]
      };
      }
    case 'run.cancelled': {
      const summary = ((event.payload as { summary?: string }).summary || '运行已停止。').trim();
      return {
        ...prev,
        runStatus: 'cancelled',
        workspace: { ...prev.workspace, runStatus: 'cancelled' },
        latestSessionSummary: summary,
        plan: prev.plan.map((step) => ({
          ...step,
          title: step.title.startsWith('正在执行：') ? step.title.replace('正在执行：', '已停止：') : step.title,
          status: step.status === 'completed' ? 'completed' : 'pending'
        })),
        runErrorSummary: summary,
        runErrorDetail: null,
        runLog: [...prev.runLog, makeLog(event, 'warn', summary)]
      };
    }
    case 'run.failed': {
      const failure = event.payload as RunFailurePayload;
      return {
        ...prev,
        runStatus: 'failed',
        workspace: { ...prev.workspace, runStatus: 'failed' },
        latestSessionSummary: failure.summary?.trim() || prev.latestSessionSummary,
        plan: prev.plan.map((step) => ({
          ...step,
          title: step.title.startsWith('正在执行：') ? step.title.replace('正在执行：', '执行中断：') : step.title,
          status: step.status === 'completed' ? 'completed' : 'pending'
        })),
        runErrorSummary: failure.summary,
        runErrorDetail: failure.details ?? null,
        runLog: [...prev.runLog, makeLog(event, 'error', failure.summary)]
      };
    }
    case 'memory.updated': {
      const payload = event.payload as { snapshot?: MainAgentBootstrapSnapshot | null };
      if (!payload.snapshot) {
        return prev;
      }

      return {
        ...prev,
        agentBootstrap: payload.snapshot,
        runLog: [...prev.runLog, makeLog(event, 'info', 'Memory updated')]
      };
    }
    default:
      return prev;
  }
}

function mergePlanStepsForDisplay(previousPlan: PlanStepItem[], nextPlan: PlanStepItem[], runStatus: RunStatus) {
  if (nextPlan.length === 0) {
    return previousPlan;
  }

  const previousByKey = new Map(previousPlan.map((step) => [getPlanStepKey(step), step]));
  const merged = nextPlan.map((step) => {
    const previous = previousByKey.get(getPlanStepKey(step));
    if (previous?.status === 'completed' && step.status !== 'completed') {
      return { ...step, status: 'completed' as const };
    }

    return { ...step };
  });

  if (merged.some((step) => step.status !== 'pending')) {
    return merged;
  }

  const previousInProgressIndex = previousPlan.findIndex((step) => step.status === 'in_progress');
  const completedPrefixCount = countCompletedPrefix(previousPlan);

  if (previousInProgressIndex >= 0) {
    for (let index = 0; index <= previousInProgressIndex && index < merged.length; index += 1) {
      merged[index] = { ...merged[index], status: 'completed' };
    }

    const nextIndex = previousInProgressIndex + 1;
    if (nextIndex < merged.length && (runStatus === 'running' || runStatus === 'waiting_approval')) {
      merged[nextIndex] = { ...merged[nextIndex], status: 'in_progress' };
    }

    return merged;
  }

  for (let index = 0; index < completedPrefixCount && index < merged.length; index += 1) {
    merged[index] = { ...merged[index], status: 'completed' };
  }

  const firstOpenIndex = merged.findIndex((step) => step.status !== 'completed');
  if (firstOpenIndex >= 0 && (runStatus === 'running' || runStatus === 'waiting_approval')) {
    merged[firstOpenIndex] = { ...merged[firstOpenIndex], status: 'in_progress' };
  }

  return merged;
}

function countCompletedPrefix(plan: PlanStepItem[]) {
  let count = 0;
  for (const step of plan) {
    if (step.status !== 'completed') {
      break;
    }
    count += 1;
  }
  return count;
}

function getPlanStepKey(step: PlanStepItem) {
  return `${step.id}::${step.title}`;
}

function upsertTool(previousTools: ToolCallItem[], tool: ToolCallItem) {
  const existingIndex = previousTools.findIndex((item) => item.id === tool.id);
  if (existingIndex < 0) {
    return [...previousTools, tool];
  }

  return previousTools.map((item, index) => (index === existingIndex ? tool : item));
}

function normalizeMessageContent(content: unknown) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') return content.text;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function makeLog(event: UiEvent, level: RunLogItem['level'], text: string): RunLogItem {
  return {
    id: `log-${event.id}`,
    level,
    text,
    createdAt: event.createdAt
  };
}

function upsertBrowserSessionFromTool(previousSessions: BrowserSessionItem[], tool: ToolCallItem) {
  if (!tool.name.startsWith('tool.browser.')) {
    return previousSessions;
  }

  const meta = (tool.meta ?? {}) as Record<string, unknown>;
  const browserSessionId = typeof meta.browserSessionId === 'string' && meta.browserSessionId.trim() ? meta.browserSessionId.trim() : null;
  if (!browserSessionId) {
    return previousSessions;
  }

  const browserAction = typeof meta.browserAction === 'string' && meta.browserAction.trim() ? meta.browserAction.trim() : tool.name.replace('tool.browser.', '');
  const lastUpdated = tool.createdAt;
  const title = typeof meta.browserTitle === 'string' ? meta.browserTitle : '';
  const url = typeof meta.browserUrl === 'string' ? meta.browserUrl : '';
  const screenshotPath = typeof meta.screenshotPath === 'string' ? meta.screenshotPath : undefined;
  const selector = typeof meta.selector === 'string' ? meta.selector : undefined;
  const text = typeof meta.text === 'string' ? meta.text : undefined;
  const key = typeof meta.key === 'string' ? meta.key : undefined;
  const browserStatus =
    typeof meta.browserStatus === 'string' &&
    ['running', 'completed', 'failed', 'waiting_verification'].includes(meta.browserStatus)
      ? (meta.browserStatus as BrowserSessionItem['status'])
      : tool.status;

  if (tool.name === 'tool.browser.close' && tool.status === 'completed') {
    return previousSessions.filter((session) => session.browserSessionId !== browserSessionId);
  }

  const nextItem: BrowserSessionItem = {
    browserSessionId,
    status: browserStatus,
    browserAction,
    title,
    url,
    lastSummary: tool.summary,
    lastUpdated,
    screenshotPath,
    selector,
    text,
    key
  };

  const index = previousSessions.findIndex((session) => session.browserSessionId === browserSessionId);
  if (index >= 0) {
    const next = [...previousSessions];
    next[index] = { ...previousSessions[index], ...nextItem };
    return next;
  }

  return [nextItem, ...previousSessions].slice(0, 10);
}

function mapRunStatus(status?: string): RunStatus {
  if (status === 'completed') return 'succeeded';
  if (status === 'waiting_approval') return 'waiting_approval';
  if (status === 'running') return 'running';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'idle';
}
