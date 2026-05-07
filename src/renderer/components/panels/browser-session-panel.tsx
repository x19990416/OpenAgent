import { Globe, MousePointerClick, Send, Sparkles } from 'lucide-react';
import type { BrowserSessionItem } from '@/types/workbench';

export function BrowserSessionPanel({ browserSessions }: { browserSessions: BrowserSessionItem[] }) {
  return (
    <div className="section-list">
      <div className="section-title">浏览器会话</div>
      {browserSessions.length === 0 ? (
        <div className="section-card">
          <div className="text-strong">暂无 browser session</div>
          <div className="body-copy-soft mt-8">模型一旦调用 browser tool，这里会显示会话列表、状态和最后一次动作。</div>
        </div>
      ) : (
        browserSessions.map((session) => (
          <div key={session.browserSessionId} className="section-card">
            <div className="inspector-inline-meta">
              <div className="row row-gap-8">
                <Globe size={16} />
                <div className="text-strong">{session.title || session.browserSessionId}</div>
              </div>
              <span
                className={`status-badge ${
                  session.status === 'failed'
                    ? 'error'
                    : session.status === 'waiting_verification'
                      ? 'warn'
                      : session.status === 'running'
                        ? 'info'
                        : 'success'
                }`}
              >
                {session.status}
              </span>
            </div>

            <div className="body-copy-soft mt-8 break-all">{session.url || 'about:blank'}</div>

            <div className="inspector-inline-meta mt-12">
              <span className="text-soft">动作</span>
              <span className="text-strong">{session.browserAction}</span>
            </div>

            <div className="inspector-inline-meta mt-8">
              <span className="text-soft">更新时间</span>
              <span className="text-strong">{formatDateTime(session.lastUpdated)}</span>
            </div>

            <div className="browser-session-activity mt-12">
              <ActivityIcon action={session.browserAction} />
              <pre className="browser-session-summary">{session.lastSummary}</pre>
            </div>

            {session.screenshotPath ? (
              <div className="body-copy-soft mt-10 break-all">
                <span className="text-soft">截图：</span>
                {session.screenshotPath}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function ActivityIcon({ action }: { action: string }) {
  if (action === 'click') {
    return <MousePointerClick size={14} />;
  }

  if (action === 'type' || action === 'press') {
    return <Send size={14} />;
  }

  return <Sparkles size={14} />;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
