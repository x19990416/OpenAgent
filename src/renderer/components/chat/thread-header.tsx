import { MoreHorizontal } from 'lucide-react';
import type { PlanStepItem, RunStatus, ToolCallItem, WorkspaceMeta } from '@shared-types/events';

interface ThreadHeaderProps {
  workspace: WorkspaceMeta;
  runStatus: RunStatus;
  plan: PlanStepItem[];
  tools: ToolCallItem[];
}

export function ThreadHeader({ workspace, runStatus, plan, tools }: ThreadHeaderProps) {
  return (
    <div className="thread-header">
      <div className="thread-file-meta">
        <div className="thread-file-title">{workspace.rootPath || '尚未选择工作区'}</div>
        <div className="thread-file-subtitle">{workspace.providerLabel || '等待模型配置'}</div>
      </div>

      <div className="thread-meta">
        <span>桌面工作区</span>
        <span>·</span>
        <span>{workspace.name || 'OpenAgent'}</span>
        <span>·</span>
        <span>{plan.length} steps</span>
        <span>·</span>
        <span>{tools.length} tools</span>
        <span>·</span>
        <span>{runStatus}</span>
      </div>
      <div className="thread-actions mt-12">
        <button className="toolbar-button" type="button">
          <MoreHorizontal size={16} />
        </button>
      </div>
      <h1 className="thread-title">{workspace.model || '等待输入任务'}</h1>
      <div className="thread-summary">
        这里会显示当前运行的摘要、计划和产物。输入任务后，agent 的输出会替换掉这个空态。
      </div>
    </div>
  );
}
