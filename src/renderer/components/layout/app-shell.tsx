import { LeftSidebar } from '@/components/layout/left-sidebar';
import { RightPanel } from '@/components/layout/right-panel';
import { TopBar } from '@/components/layout/top-bar';
import { BottomStatusStrip } from '@/components/layout/bottom-status-strip';
import { ConversationPane } from '@/components/chat/conversation-pane';
import { PromptComposer } from '@/components/chat/prompt-composer';
import { ScheduledTasksScreen } from '@/components/scheduled/scheduled-tasks-screen';
import type { CreateScheduledTaskInput, PromptSubmission, PromptSubmissionResult } from '@shared-types/index';
import type {
  LeftSidebarTab,
  RightInspectorTab,
  SettingsTab,
  WorkbenchViewModel
} from '@/types/workbench';

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
          agentBootstrap={viewModel.agentBootstrap}
          runStatus={viewModel.runStatus}
          latestSessionSummary={viewModel.latestSessionSummary}
          sidebarVisible={sidebarVisible}
          inspectorVisible={inspectorVisible}
          onToggleSidebar={onToggleSidebar}
          onToggleInspector={onToggleInspector}
          onOpenSettings={onOpenSettings}
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
                <ConversationPane messages={viewModel.messages} />

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
