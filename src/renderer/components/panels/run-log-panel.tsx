import type { RunLogItem } from '@/types/workbench';

export function RunLogPanel({ logs }: { logs: RunLogItem[] }) {
  function getLevelLabel(level: RunLogItem['level']) {
    if (level === 'error') return '错误';
    if (level === 'warn') return '警告';
    return '信息';
  }

  return (
    <div className="section-list">
      <div className="section-title">运行日志</div>
      {logs.length === 0 ? (
        <div className="section-card">
          <div className="text-strong">暂无运行日志</div>
          <div className="body-copy-soft mt-8">运行开始后，模型与工具相关日志会在这里显示。</div>
        </div>
      ) : (
        logs.map((log) => (
          <div key={log.id} className="log-card">
            <div className="inspector-inline-meta">
              <div className="text-strong">{getLevelLabel(log.level)}</div>
              <span className={`status-badge ${log.level}`}>{log.level}</span>
            </div>
            <pre>{log.text}</pre>
          </div>
        ))
      )}
    </div>
  );
}
