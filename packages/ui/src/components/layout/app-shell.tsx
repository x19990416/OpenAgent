import { LeftSidebar } from './left-sidebar';
import { RightPanel } from './right-panel';
import { TopBar } from './top-bar';
import { BottomStatusStrip } from './bottom-status-strip';
import { ConversationPane } from '../chat/conversation-pane';
import { PromptComposer } from '../chat/prompt-composer';
import { ScheduledTasksScreen } from '../scheduled/scheduled-tasks-screen';
import type { CreateScheduledTaskInput, PromptSubmission, PromptSubmissionResult } from '@openagent/shared-types/index';
import type {
  LeftSidebarTab,
  RightInspectorTab,
  SettingsTab,
  WorkbenchViewModel
} from '../../types/workbench';

interface AppShellProps {
  viewModel: WorkbenchViewModel;
  leftTab: LeftSidebarTab;
  rightTab: RightInspectorTab;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  onLeftTabChange: (tab: LeftSidebarTab) => void;
  onRightTabChange: (tab: RightInspectorTab) => void;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onSubmitPrompt: (payload: PromptSubmission) => Promise<PromptSubmissionResult>;
  onStopRun: (runId?: string) => Promise<{ ok: boolean; error?: string }>;
  onWorkspaceChange: (workspace: WorkbenchViewModel['workspace']) => void;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onCompactThread: (threadId?: string) => Promise<{ ok: boolean; error?: string }>;
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'session' | 'always') => Promise<void>;
  onCreateScheduledTask: (payload: CreateScheduledTaskInput) => Promise<{ ok: boolean; error?: string }>;
  onDeleteScheduledTask: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  onSetScheduledTaskEnabled: (taskId: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  onRunScheduledTaskNow: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
}

export function AppShell(props: AppShellProps) {
  const {
    viewModel,
    leftTab,
    rightTab,
    sidebarVisible,
    inspectorVisible,
    onLeftTabChange,
    onRightTabChange,
    onToggleSidebar,
    onToggleInspector,
    onOpenSettings,
    onSubmitPrompt,
    onStopRun,
    onWorkspaceChange,
    onSelectThread,
    onCreateThread,
    onDeleteThread,
    onCompactThread,
    onResolveApproval,
    onCreateScheduledTask,
    onDeleteScheduledTask,
    onSetScheduledTaskEnabled,
    onRunScheduledTaskNow
  } = props;

  return (
    <main className={`app-shell-grid ${sidebarVisible ? 'with-sidebar' : 'without-sidebar'}`}>
      {sidebarVisible && (
        <div className="shell-left">
          <LeftSidebar
            activeTab={leftTab}
            onTabChange={onLeftTabChange}
            workspace={viewModel.workspace}
            agentBootstrap={viewModel.agentBootstrap}
            threads={viewModel.threads}
            activeThreadId={viewModel.activeThreadId}
            onSelectThread={onSelectThread}
            onCreateThread={onCreateThread}
            onDeleteThread={onDeleteThread}
            onOpenSettings={onOpenSettings}
          />
        </div>
      )}

      <section className="shell-main workspace-shell">
        <TopBar
          workspace={viewModel.workspace}
          sessionTitle={viewModel.threads.find((thread) => thread.threadId === viewModel.activeThreadId)?.title || viewModel.latestSessionSummary}
          inspectorVisible={inspectorVisible}
          onToggleInspector={onToggleInspector}
        />

        {leftTab === 'schedules' ? (
          <section className="workspace-main without-inspector">
            <ScheduledTasksScreen
              scheduledTasks={viewModel.scheduledTasks}
              agents={viewModel.agents}
              activeAgentId={viewModel.activeAgentId}
              threads={viewModel.threads}
              onCreateScheduledTask={onCreateScheduledTask}
              onDeleteScheduledTask={onDeleteScheduledTask}
              onSetScheduledTaskEnabled={onSetScheduledTaskEnabled}
              onRunScheduledTaskNow={onRunScheduledTaskNow}
            />
          </section>
        ) : (
          <section className={`workspace-main ${inspectorVisible ? 'with-inspector' : 'without-inspector'}`}>
            <div className={`workspace-split ${inspectorVisible ? 'with-inspector' : 'without-inspector'}`}>
              <div className="workspace-chat">
                <ConversationPane
                  messages={viewModel.messages}
                  threadTitle={viewModel.threads.find((thread) => thread.threadId === viewModel.activeThreadId)?.title}
                  onOpenSettings={onOpenSettings}
                />

                <PromptComposer
                  onSubmitPrompt={onSubmitPrompt}
                  onStopRun={onStopRun}
                  onWorkspaceChange={onWorkspaceChange}
                  runStatus={viewModel.runStatus}
                  workspace={viewModel.workspace}
                />
              </div>

              {inspectorVisible && (
                <RightPanel
                  activeTab={rightTab}
                  onTabChange={onRightTabChange}
                  viewModel={viewModel}
                  onStopRun={onStopRun}
                  onResolveApproval={onResolveApproval}
                  onCompactThread={onCompactThread}
                />
              )}
            </div>
          </section>
        )}

        <BottomStatusStrip viewModel={viewModel} />
      </section>
    </main>
  );
}
