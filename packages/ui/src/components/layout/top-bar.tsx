import {
  PanelLeft,
  PanelRight
} from 'lucide-react';
import type { WorkspaceMeta } from '@openagent/shared-types/events';

interface TopBarProps {
  workspace: WorkspaceMeta;
  sessionTitle: string | null;
  inspectorVisible: boolean;
  onToggleInspector: () => void;
}

export function TopBar({
  workspace,
  sessionTitle,
  inspectorVisible,
  onToggleInspector
}: TopBarProps) {
  const sessionLabel = sessionTitle?.trim() || '当前会话';

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-branch-name" title={workspace.branch}>{workspace.branch || 'main'}</span>
        <span className="topbar-divider">/</span>
        <span className="topbar-session-name" title={sessionLabel}>{sessionLabel}</span>
      </div>

      <div className="topbar-actions">
        <button
          className="topbar-button topbar-button-icon"
          type="button"
          aria-label={inspectorVisible ? '隐藏右侧边侧栏' : '显示右侧边侧栏'}
          onClick={onToggleInspector}
        >
          {inspectorVisible ? <PanelRight size={14} /> : <PanelLeft size={14} />}
        </button>
      </div>
    </header>
  );
}
