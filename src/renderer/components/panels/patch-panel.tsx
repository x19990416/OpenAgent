import type { PatchArtifact } from '@shared-types/events';

export function PatchPanel({ patch }: { patch: PatchArtifact | null }) {
  return (
    <div className="section-list">
      <div className="section-title">Git</div>
      {patch ? (
        <pre className="patch-code">{`files changed: ${patch.filesChanged}
+${patch.additions} / -${patch.deletions}`}</pre>
      ) : (
        <div className="section-card">
          <div className="text-strong">暂无 patch</div>
          <div className="body-copy-soft mt-8">当 agent 生成修改建议时，这里会展示变更摘要。</div>
        </div>
      )}
    </div>
  );
}
