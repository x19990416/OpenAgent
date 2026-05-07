import {
  ChevronDown,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Search,
  Settings2
} from 'lucide-react';
import type { WorkspaceMeta } from '@shared-types/events';
import { resolveMainAgentDisplayName } from '@/lib/agent-name';
import type { MainAgentBootstrapSnapshot, SettingsTab } from '@/types/workbench';

interface TopBarProps {
  workspace: WorkspaceMeta;
  agentBootstrap: MainAgentBootstrapSnapshot | null;
  runStatus: WorkspaceMeta['runStatus'];
  latestSessionSummary: string | null;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
}

export function TopBar({
  workspace,
  agentBootstrap,
  runStatus,
  latestSessionSummary: _latestSessionSummary,
  sidebarVisible,
  inspectorVisible,
  onToggleSidebar,
  onToggleInspector,
  onOpenSettings
}: TopBarProps) {
  const agentDisplayName = resolveMainAgentDisplayName(agentBootstrap);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <button className="toolbar-button" type="button">
          <Play size={14} />
        </button>
        <button className="toolbar-button" type="button">
          <Search size={14} />
          Search
        </button>
        <button className={`toolbar-button ${sidebarVisible ? 'is-accent' : ''}`} type="button" onClick={onToggleSidebar}>
          <PanelLeft size={14} />
        </button>
        <button className={`toolbar-button ${inspectorVisible ? 'is-accent' : ''}`} type="button" onClick={onToggleInspector}>
          <PanelRight size={14} />
        </button>
        <div>
          <div className="topbar-title">{agentDisplayName}</div>
          <div className="topbar-subtitle">{workspace.providerLabel || '等待模型配置'}</div>
        </div>
      </div>

      <div className="topbar-actions">
        <span className="status-badge">{workspace.providerLabel || 'local'}</span>
        {workspace.model ? <span className="status-badge">{workspace.model}</span> : null}
        {workspace.branch ? <span className="status-badge">{workspace.branch}</span> : null}
        <span className={`status-badge status-${runStatus}`}>{runStatus}</span>
        <button className="toolbar-button" type="button">
          <Plus size={14} />
          新建
        </button>
        <button className="toolbar-button" type="button">
          <ChevronDown size={14} />
        </button>
        <button className="toolbar-button" type="button" onClick={() => onOpenSettings('models')}>
          <Settings2 size={14} />
          设置
        </button>
      </div>
    </header>
  );
}
