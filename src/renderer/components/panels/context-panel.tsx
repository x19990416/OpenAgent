import { useState } from 'react';
import type { RuntimeActivityItem, ToolCallItem, WorkspaceMeta } from '@shared-types/events';

interface ContextPanelProps {
  workspace: WorkspaceMeta;
  tools: ToolCallItem[];
  runtimeActivities?: RuntimeActivityItem[];
  activeThreadId: string | null;
  onCompactThread: (threadId?: string) => Promise<{ ok: boolean; error?: string }>;
}

export function ContextPanel({ workspace, tools, runtimeActivities = [], activeThreadId, onCompactThread }: ContextPanelProps) {
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactMessage, setCompactMessage] = useState<string | null>(null);

  async function handleCompactThread() {
    setIsCompacting(true);
    setCompactMessage(null);
    try {
      const result = await onCompactThread(activeThreadId ?? undefined);
      setCompactMessage(result.ok ? '已提交 AgentSession 压缩。' : result.error || 'AgentSession 压缩失败。');
    } finally {
      setIsCompacting(false);
    }
  }

  return (
    <div className="section-list">
      <div className="section-title">上下文</div>
      <div className="section-card">
        <div className="text-strong">{workspace.name || '未加载工作区'}</div>
        <div className="text-soft mt-8">{workspace.rootPath || '等待加载当前工作区路径'}</div>
      </div>
      <div className="section-card">
        <div className="inspector-inline-meta">
          <div>
            <div className="text-strong">AgentSession</div>
            <div className="body-copy-soft mt-8">压缩当前 thread 的 内部 agent session，不会改写 OpenAgent 可见聊天记录。</div>
          </div>
          <button
            type="button"
            className="toolbar-button"
            disabled={isCompacting || !activeThreadId}
            onClick={() => void handleCompactThread()}
          >
            {isCompacting ? '压缩中…' : '压缩当前会话'}
          </button>
        </div>
        {compactMessage ? <div className="body-copy-soft mt-8">{compactMessage}</div> : null}
      </div>

      <div className="section-card">
        <div className="text-strong">最近 Skill</div>
        {runtimeActivities.filter((activity) => activity.kind === 'skill').length === 0 ? (
          <div className="body-copy-soft mt-8">暂无 Skill 记录。</div>
        ) : (
          <div className="section-list">
            {runtimeActivities.filter((activity) => activity.kind === 'skill').slice(-6).map((activity, index) => (
              <div key={`${activity.id}-${index}`} className="inspector-inline-meta">
                <span className="text-soft">{activity.title}</span>
                <span className={`status-badge ${activity.status}`}>{activity.status}</span>
              </div>
            ))}
          </div>
        )}
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
