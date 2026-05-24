import { SquareTerminal } from 'lucide-react';
import type { RuntimeTaskItem } from '../../types/workbench';

export function TasksPanel({
  tasks,
  onStopRun
}: {
  tasks: RuntimeTaskItem[];
  onStopRun: (runId?: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  return (
    <div className="section-list">
      <div className="section-title">运行中的任务</div>
      {tasks.length === 0 ? (
        <div className="section-card">
          <div className="text-strong">暂无长期任务</div>
          <div className="body-copy-soft mt-8">像 npx serve . 这样的常驻命令启动后，会在这里统一管理。</div>
        </div>
      ) : (
        tasks.map((task) => (
          <div key={task.runId} className="task-runtime-card">
            <div className="task-runtime-card-header">
              <div className="task-runtime-title">
                <SquareTerminal size={16} />
                <span>tool.shell.exec</span>
              </div>
              <div className="task-runtime-actions">
                <span className={`status-badge ${task.status === 'stopping' ? 'warn' : 'info'}`}>{task.status}</span>
                <button
                  type="button"
                  className="task-runtime-stop-button"
                  disabled={task.status === 'stopping'}
                  onClick={() => void onStopRun(task.runId)}
                >
                  停止
                </button>
              </div>
            </div>
            <div className="task-runtime-meta">
              <div><span className="text-soft">目录：</span>{task.cwd}</div>
              <div><span className="text-soft">开始：</span>{formatDateTime(task.startedAt)}</div>
            </div>
            <pre className="task-runtime-command">{task.command}</pre>
          </div>
        ))
      )}
    </div>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
