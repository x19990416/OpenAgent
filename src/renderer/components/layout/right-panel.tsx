import { AgentMemoryPanel } from '@/components/panels/agent-memory-panel';
import { BrowserSessionPanel } from '@/components/panels/browser-session-panel';
import { ContextPanel } from '@/components/panels/context-panel';
import { PatchPanel } from '@/components/panels/patch-panel';
import { PlanPanel } from '@/components/panels/plan-panel';
import { RunLogPanel } from '@/components/panels/run-log-panel';
import { TasksPanel } from '@/components/panels/tasks-panel';
import type { RightInspectorTab, WorkbenchViewModel } from '@/types/workbench';

interface RightPanelProps {
  activeTab: RightInspectorTab;
  onTabChange: (tab: RightInspectorTab) => void;
  viewModel: WorkbenchViewModel;
  onStopRun: (runId?: string) => Promise<{ ok: boolean; error?: string }>;
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'always') => Promise<void>;
}

const tabs: Array<{ key: RightInspectorTab; label: string }> = [
  { key: 'plan', label: '摘要' },
  { key: 'tasks', label: '任务' },
  { key: 'browser', label: '浏览器' },
  { key: 'patch', label: 'Git' },
  { key: 'context', label: '上下文' },
  { key: 'memory', label: '记忆' },
  { key: 'run-log', label: '日志' }
];

export function RightPanel({
  activeTab,
  onTabChange,
  viewModel,
  onStopRun,
  onResolveApproval
}: RightPanelProps) {
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="inspector-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`inspector-tab ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => onTabChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-body scroll-y">
        {(activeTab === 'plan' || activeTab === 'approval') && (
          <PlanPanel
            plan={viewModel.plan}
            logs={viewModel.runLog}
            runStatus={viewModel.runStatus}
            latestSessionSummary={viewModel.latestSessionSummary}
            approvals={viewModel.approvals}
            onResolveApproval={onResolveApproval}
            onStopRun={onStopRun}
            runErrorSummary={viewModel.runErrorSummary}
            runErrorDetail={viewModel.runErrorDetail}
          />
        )}
        {activeTab === 'tasks' && <TasksPanel tasks={viewModel.runtimeTasks} onStopRun={onStopRun} />}
        {activeTab === 'browser' && <BrowserSessionPanel browserSessions={viewModel.browserSessions} />}
        {activeTab === 'patch' && <PatchPanel patch={viewModel.patch} />}
        {activeTab === 'context' && <ContextPanel workspace={viewModel.workspace} tools={viewModel.tools} />}
        {activeTab === 'memory' && <AgentMemoryPanel agentBootstrap={viewModel.agentBootstrap} />}
        {activeTab === 'run-log' && <RunLogPanel logs={viewModel.runLog} />}
      </div>
    </aside>
  );
}
