import { useEffect, useState } from 'react';
import { AppShell, SettingsScreen } from '@openagent/ui';
import { useUiEventStream } from '@/hooks/use-ui-event-stream';
import type { LeftSidebarTab, RightInspectorTab, SettingsTab } from '@openagent/ui';

type AppScreen = 'workspace' | 'settings';

export function WorkbenchScreen() {
  const {
    viewModel,
    submitPrompt,
    stopRun,
    resolveApproval,
    updateWorkspace,
    selectThread,
    createThread,
    deleteThread,
    compactThread,
    createScheduledTask,
    deleteScheduledTask,
    setScheduledTaskEnabled,
    runScheduledTaskNow
  } = useUiEventStream();
  const [screen, setScreen] = useState<AppScreen>('workspace');
  const [leftTab, setLeftTab] = useState<LeftSidebarTab>('threads');
  const [rightTab, setRightTab] = useState<RightInspectorTab>('plan');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('models');

  useEffect(() => {
    if (viewModel.runStatus === 'waiting_approval') {
      setRightTab('plan');
    }
  }, [viewModel.runStatus]);

  if (screen === 'settings') {
    return (
      <SettingsScreen
        activeTab={settingsTab}
        onTabChange={setSettingsTab}
        onWorkspaceChange={updateWorkspace}
        onBack={() => setScreen('workspace')}
      />
    );
  }

  return (
    <AppShell
      viewModel={viewModel}
      leftTab={leftTab}
      rightTab={rightTab}
      sidebarVisible={sidebarVisible}
      inspectorVisible={inspectorVisible}
      onLeftTabChange={setLeftTab}
      onRightTabChange={setRightTab}
      onToggleSidebar={() => setSidebarVisible((prev) => !prev)}
      onToggleInspector={() => setInspectorVisible((prev) => !prev)}
      onOpenSettings={(tab) => {
        setSettingsTab(tab);
        setScreen('settings');
      }}
      onSubmitPrompt={submitPrompt}
      onStopRun={stopRun}
      onWorkspaceChange={updateWorkspace}
      onSelectThread={(threadId) => {
        setScreen('workspace');
        setLeftTab('threads');
        void selectThread(threadId);
      }}
      onCreateThread={async () => {
        setScreen('workspace');
        setLeftTab('threads');
        await createThread();
      }}
      onDeleteThread={deleteThread}
      onCompactThread={compactThread}
      onResolveApproval={resolveApproval}
      onCreateScheduledTask={createScheduledTask}
      onDeleteScheduledTask={deleteScheduledTask}
      onSetScheduledTaskEnabled={setScheduledTaskEnabled}
      onRunScheduledTaskNow={runScheduledTaskNow}
    />
  );
}
