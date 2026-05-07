import { FileText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SoulChangeProposal } from '@shared-types/index';
import type { MainAgentBootstrapSnapshot } from '@/types/workbench';

interface AgentMemoryPanelProps {
  agentBootstrap: MainAgentBootstrapSnapshot | null;
}

type MemoryFileKey = 'soul' | 'user' | 'memory';

const fileMeta: Array<{
  key: MemoryFileKey;
  label: string;
  pathKey: keyof Pick<MainAgentBootstrapSnapshot, 'soulPath' | 'userPath' | 'memoryPath'>;
}> = [
  { key: 'soul', label: 'SOUL.md', pathKey: 'soulPath' },
  { key: 'user', label: 'USER.md', pathKey: 'userPath' },
  { key: 'memory', label: 'MEMORY.md', pathKey: 'memoryPath' }
];

export function AgentMemoryPanel({ agentBootstrap }: AgentMemoryPanelProps) {
  const [activeFile, setActiveFile] = useState<MemoryFileKey>('soul');
  const [soulProposals, setSoulProposals] = useState<SoulChangeProposal[]>([]);
  const [proposalError, setProposalError] = useState<string | null>(null);

  const refreshSoulProposals = async () => {
    if (!window.desktopApi?.listSoulProposals) return;
    try {
      const proposals = await window.desktopApi.listSoulProposals({ status: 'pending_approval' });
      setSoulProposals(proposals);
      setProposalError(null);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '读取 SOUL 提案失败');
    }
  };

  useEffect(() => {
    void refreshSoulProposals();
  }, [agentBootstrap?.agentId]);

  const resolveSoulProposal = async (proposalId: string, decision: 'approved' | 'rejected') => {
    try {
      const api = decision === 'approved' ? window.desktopApi?.approveSoulProposal : window.desktopApi?.rejectSoulProposal;
      if (!api) throw new Error('SOUL proposal API is unavailable');
      const result = await api({ proposalId });
      if (!result?.ok) throw new Error(result?.error || '处理 SOUL 提案失败');
      await refreshSoulProposals();
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '处理 SOUL 提案失败');
    }
  };

  const content = useMemo(() => {
    if (!agentBootstrap) {
      return {
        title: '记忆未加载',
        path: '等待当前智能体 bootstrap 加载',
        text: '当前还没有读取到所选智能体的记忆文件。'
      };
    }

    switch (activeFile) {
      case 'user':
        return {
          title: 'USER.md',
          path: agentBootstrap.userPath,
          text: agentBootstrap.user
        };
      case 'memory':
        return {
          title: 'MEMORY.md',
          path: agentBootstrap.memoryPath,
          text: agentBootstrap.memory
        };
      case 'soul':
      default:
        return {
          title: 'SOUL.md',
          path: agentBootstrap.soulPath,
          text: agentBootstrap.soul
        };
    }
  }, [activeFile, agentBootstrap]);

  return (
    <div className="section-list">
      <div className="section-title">记忆文件</div>
      <div className="section-card">
        <div className="text-strong">当前智能体身份来源</div>
        <div className="body-copy-soft mt-8">
          当前智能体的 SOUL / USER / MEMORY 读取自 <code>{agentBootstrap?.agentRoot ?? 'userData/agents/<agentId>'}</code>。
          workspace 根目录下的同名文件只会被当作普通工作区文件处理，不会自动覆盖智能体身份。
        </div>
      </div>
      <div className="section-card">
        <div className="row row-between">
          <div>
            <div className="text-strong">SOUL.md 待审批变更</div>
            <div className="body-copy-soft mt-8">
              SOUL.md 不静默自动更新；系统只生成提案，用户接受后才写入 managed 区域。
            </div>
          </div>
          <button type="button" className="toolbar-button" onClick={() => void refreshSoulProposals()}>
            刷新
          </button>
        </div>
        {proposalError ? <div className="body-copy-soft mt-12">{proposalError}</div> : null}
        {soulProposals.length === 0 ? (
          <div className="body-copy-soft mt-12">暂无待审批 SOUL 变更。</div>
        ) : (
          <div className="section-list mt-12">
            {soulProposals.map((proposal) => (
              <div key={proposal.id} className="section-card">
                <div className="row row-between row-gap-10">
                  <div>
                    <div className="text-strong">{proposal.title}</div>
                    <div className="text-soft mt-4">
                      {proposal.targetSection} · 风险：{proposal.riskLevel}
                    </div>
                  </div>
                  <div className="row row-gap-8">
                    <button type="button" className="primary-button" onClick={() => void resolveSoulProposal(proposal.id, 'approved')}>
                      接受
                    </button>
                    <button type="button" className="ghost-button" onClick={() => void resolveSoulProposal(proposal.id, 'rejected')}>
                      拒绝
                    </button>
                  </div>
                </div>
                <div className="body-copy-soft mt-8">{proposal.reason}</div>
                <pre className="patch-code mt-12">{proposal.diff}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="section-card">
        <div className="sidebar-thread-list">
          {fileMeta.map((item) => {
            const isActive = item.key === activeFile;
            return (
              <button
                key={item.key}
                type="button"
                className={`sidebar-thread-item w-full ${isActive ? 'active' : ''}`}
                onClick={() => setActiveFile(item.key)}
              >
                <span className="row row-gap-10">
                  <FileText size={16} />
                  <span>
                    <div className="sidebar-thread-title">{item.label}</div>
                    <div className="sidebar-thread-summary">
                      {agentBootstrap ? agentBootstrap[item.pathKey] : '未加载'}
                    </div>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="section-card">
        <div className="text-strong">{content.title}</div>
        <div className="text-soft mt-8">{content.path}</div>
        <pre className="patch-code mt-12">{content.text}</pre>
      </div>
    </div>
  );
}
