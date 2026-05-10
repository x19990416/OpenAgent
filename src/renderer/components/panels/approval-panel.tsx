import { useState } from 'react';
import type { ApprovalRequest } from '@shared-types/events';
import type { BrowserSessionItem } from '@/types/workbench';

export function ApprovalPanel({
  approvals,
  browserSessions,
  onResolveApproval
}: {
  approvals: ApprovalRequest[];
  browserSessions: BrowserSessionItem[];
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'always') => Promise<void>;
}) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  function getRiskLabel(risk: ApprovalRequest['risk']) {
    if (risk === 'high') return '高风险操作';
    if (risk === 'medium') return '需要确认';
    return '低风险提示';
  }

  async function handleResolve(approvalId: string, decision: 'approved' | 'rejected', scope?: 'once' | 'always') {
    setResolvingId(approvalId);

    try {
      await onResolveApproval(approvalId, decision, scope);
    } finally {
      setResolvingId((current) => (current === approvalId ? null : current));
    }
  }

  return (
    <div className="section-list">
      <div className="section-title">审批</div>
      {approvals.length === 0 ? (
        <div className="section-card">
          <div className="text-strong">暂无审批请求</div>
          <div className="body-copy-soft mt-8">当 agent 需要你确认高风险动作时，会在这里出现。</div>
        </div>
      ) : (
        approvals.map((approval) => (
          <div key={approval.id} className="approval-card">
            <div className="text-strong">{approval.title}</div>
            <div className="text-soft mt-6">{getRiskLabel(approval.risk)}</div>
            <div className="body-copy-soft mt-10" style={{ whiteSpace: 'pre-wrap' }}>{approval.description}</div>
            {approval.targetPath ? (
              <div className="body-copy-soft mt-8 break-all">
                路径：{approval.targetPath}
              </div>
            ) : null}
            {approval.access || approval.scope || typeof approval.recursive === 'boolean' ? (
              <div className="body-copy-soft mt-8 text-soft">
                权限：{formatAccess(approval.access)} · 范围：{formatScope(approval.scope)}
                {typeof approval.recursive === 'boolean' ? ` · ${approval.recursive ? '包含子目录' : '仅当前文件/目录'}` : ''}
              </div>
            ) : null}
            <div className="inline-actions mt-12">
              <button
                className="success-button"
                type="button"
                disabled={resolvingId === approval.id}
                onClick={() => void handleResolve(approval.id, 'approved')}
              >
                批准
              </button>
              <button
                className="ghost-button"
                type="button"
                disabled={resolvingId === approval.id}
                onClick={() => void handleResolve(approval.id, 'approved', 'always')}
              >
                始终允许
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={resolvingId === approval.id}
                onClick={() => void handleResolve(approval.id, 'rejected')}
              >
                拒绝
              </button>
            </div>
          </div>
          ))
      )}

      <div className="section-title mt-16">浏览器活动</div>
      {browserSessions.length === 0 ? (
        <div className="section-card">
          <div className="text-strong">暂无 browser session</div>
          <div className="body-copy-soft mt-8">当模型调用 browser tool 时，这里会显示对应会话和最近动作。</div>
        </div>
      ) : (
        browserSessions.map((session) => (
          <div key={session.browserSessionId} className="approval-card">
            <div className="text-strong">{session.title || session.browserSessionId}</div>
            <div className="text-soft mt-6">
              {session.browserAction} · {session.status}
            </div>
            <div className="body-copy-soft mt-10 break-all">{session.url || 'about:blank'}</div>
            <div className="body-copy-soft mt-8">{session.lastSummary}</div>
            {session.status === 'waiting_verification' ? (
              <div className="body-copy-soft mt-8 text-soft">请在已打开的浏览器窗口中手动完成验证，然后继续执行。</div>
            ) : null}
            <div className="body-copy-soft mt-8 text-soft">
              更新于 {formatDateTime(session.lastUpdated)}
            </div>
          </div>
        ))
      )}
    </div>
  );
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


function formatAccess(access: ApprovalRequest['access']) {
  if (access === 'read') return '只读';
  if (access === 'write') return '写入';
  if (access === 'execute') return '执行';
  return '未指定';
}

function formatScope(scope: ApprovalRequest['scope']) {
  if (scope === 'once') return '本次';
  if (scope === 'session') return '本会话';
  if (scope === 'always') return '长期';
  return '本次';
}
