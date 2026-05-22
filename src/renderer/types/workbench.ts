import type {
  ApprovalRequest,
  MessageItem,
  PatchArtifact,
  PlanStepItem,
  RunStatus,
  RuntimeActivityItem,
  ToolCallItem,
  WorkspaceMeta
} from '@shared-types/events';
import type { ScheduledTaskItem } from '@shared-types/index';

export type LeftSidebarTab = 'threads' | 'schedules';
export type RightInspectorTab = 'plan' | 'tasks' | 'patch' | 'approval' | 'browser' | 'context' | 'memory' | 'run-log';
export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'models'
  | 'plugins'
  | 'skills'
  | 'knowledge'
  | 'config'
  | 'logs'
  | 'personalization'
  | 'account'
  | 'mcp'
  | 'git'
  | 'environment'
  | 'workspace'
  | 'computer'
  | 'archived'
  | 'usage';

export interface AgentConfigSnapshot {
  id: string;
  kind: 'system' | 'user';
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  providerId: string;
  model: string;
  description: string;
  toolPolicy: {
    workspaceRead: boolean;
    workspaceWrite: boolean;
    shell: boolean;
    git: boolean;
    mcp: boolean;
  };
  routing: {
    routable: boolean;
    takeoverByMainAllowed: boolean;
  };
}

export interface MainAgentBootstrapSnapshot {
  agentId: string;
  agentRoot: string;
  soulPath: string;
  userPath: string;
  memoryPath: string;
  skillsDir: string;
  configPath: string;
  soul: string;
  user: string;
  memory: string;
  config: AgentConfigSnapshot;
}

export interface AgentSummaryItem {
  id: string;
  kind: 'system' | 'user';
  workspaceRoot: string;
  providerId: string;
  model: string;
  description: string;
  updatedAt: string;
}

export interface RunLogItem {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  createdAt: string;
}

export interface RuntimeTaskItem {
  runId: string;
  command: string;
  cwd: string;
  startedAt: string;
  status: 'running' | 'stopping';
}

export interface BrowserSessionItem {
  browserSessionId: string;
  status: 'running' | 'completed' | 'failed' | 'waiting_verification';
  browserAction: string;
  title: string;
  url: string;
  lastSummary: string;
  lastUpdated: string;
  screenshotPath?: string;
  selector?: string;
  text?: string;
  key?: string;
}

export interface RecentRunItem {
  runId: string;
  threadId: string;
  prompt: string;
  currentAgent: string;
  status: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  summary: string | null;
}

export interface ThreadListItem {
  threadId: string;
  agentId: string;
  workspaceRoot: string;
  workspaceName: string;
  branch: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  runCount: number;
}

export interface WorkbenchViewModel {
  workspace: WorkspaceMeta;
  activeAgentId: string;
  agents: AgentSummaryItem[];
  agentBootstrap: MainAgentBootstrapSnapshot | null;
  threads: ThreadListItem[];
  recentRuns: RecentRunItem[];
  activeThreadId: string | null;
  latestSessionSummary: string | null;
  messages: MessageItem[];
  tools: ToolCallItem[];
  runtimeActivities: RuntimeActivityItem[];
  runtimeTasks: RuntimeTaskItem[];
  scheduledTasks: ScheduledTaskItem[];
  browserSessions: BrowserSessionItem[];
  plan: PlanStepItem[];
  approvals: ApprovalRequest[];
  patch: PatchArtifact | null;
  runErrorSummary: string | null;
  runErrorDetail: string | null;
  runLog: RunLogItem[];
  runStatus: RunStatus;
}
