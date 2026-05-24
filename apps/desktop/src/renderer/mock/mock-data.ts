import type { WorkbenchViewModel } from '@openagent/ui';

export const initialWorkbenchData: WorkbenchViewModel = {
  workspace: {
    name: '当前工作区',
    rootPath: '',
    branch: 'unknown',
    providerId: '',
    providerLabel: '',
    model: '',
    runStatus: 'idle'
  },
  activeAgentId: 'main',
  agents: [],
  agentBootstrap: null,
  threads: [],
  recentRuns: [],
  activeThreadId: null,
  latestSessionSummary: null,
  messages: [],
  tools: [],
  runtimeActivities: [],
  runtimeTasks: [],
  scheduledTasks: [],
  browserSessions: [],
  plan: [],
  approvals: [],
  patch: null,
  runErrorSummary: null,
  runErrorDetail: null,
  runLog: [],
  runStatus: 'idle'
};
