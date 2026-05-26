import {
  Maximize2,
  Minus,
  PanelLeft,
  PanelRight,
  X
} from 'lucide-react';
import type { WorkspaceMeta } from '@openagent/shared-types/events';
import type { RunStatus } from '@openagent/shared-types/events';

interface TopBarProps {
  workspace: WorkspaceMeta;
  sessionTitle: string | null;
  runStatus: RunStatus;
  inspectorVisible: boolean;
  onToggleInspector: () => void;
}

export function TopBar({
  workspace,
  sessionTitle,
  runStatus,
  inspectorVisible,
  onToggleInspector
}: TopBarProps) {
  const sessionLabel = sessionTitle?.trim() || '当前会话';
  const runIndicator = getRunIndicator(runStatus);
  const handleWindowControl = (action: 'minimize' | 'maximize' | 'close') => {
    void window.desktopApi?.windowControl?.({ action });
  };

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="window-controls" aria-label="窗口控制">
          <button
            className="window-control-button window-control-close"
            type="button"
            aria-label="关闭窗口"
            onClick={() => handleWindowControl('close')}
          >
            <X size={10} strokeWidth={2.4} />
          </button>
          <button
            className="window-control-button window-control-minimize"
            type="button"
            aria-label="最小化窗口"
            onClick={() => handleWindowControl('minimize')}
          >
            <Minus size={10} strokeWidth={2.4} />
          </button>
          <button
            className="window-control-button window-control-maximize"
            type="button"
            aria-label="最大化或还原窗口"
            onClick={() => handleWindowControl('maximize')}
          >
            <Maximize2 size={9} strokeWidth={2.4} />
          </button>
        </div>
        <span
          className={`topbar-run-dot ${runIndicator.className}`}
          aria-label={runIndicator.label}
          title={runIndicator.label}
        />
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

function getRunIndicator(runStatus: RunStatus) {
  if (runStatus === 'running' || runStatus === 'waiting_approval') {
    return { className: 'is-running', label: '执行中' };
  }
  if (runStatus === 'succeeded') {
    return { className: 'is-succeeded', label: '执行完毕' };
  }
  if (runStatus === 'failed' || runStatus === 'cancelled') {
    return { className: 'is-failed', label: runStatus === 'failed' ? '执行失败' : '执行已取消' };
  }
  return { className: 'is-idle', label: '未执行' };
}
