import type { ToolCallItem, WorkspaceMeta } from '@shared-types/events';

interface ContextPanelProps {
  workspace: WorkspaceMeta;
  tools: ToolCallItem[];
}

export function ContextPanel({ workspace, tools }: ContextPanelProps) {
  return (
    <div className="section-list">
      <div className="section-title">上下文</div>
      <div className="section-card">
        <div className="text-strong">{workspace.name || '未加载工作区'}</div>
        <div className="text-soft mt-8">{workspace.rootPath || '等待加载当前工作区路径'}</div>
      </div>
      <div className="section-card">
        <div className="text-strong">最近工具</div>
        {tools.length === 0 ? (
          <div className="body-copy-soft mt-8">暂无工具记录。</div>
        ) : (
          <div className="section-list">
            {tools.map((tool, index) => (
              <div key={`${tool.id}-${index}`} className="inspector-inline-meta">
                <span className="text-soft">{tool.name}</span>
                <span className={`status-badge ${tool.status}`}>{tool.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
