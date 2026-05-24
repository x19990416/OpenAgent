import { ChevronRight, FileCode2, FolderGit2, Star } from 'lucide-react';
import type { WorkspaceMeta } from '@openagent/shared-types/events';

export function FileTreePanel({ workspace }: { workspace: WorkspaceMeta }) {
  const files = [
    { name: 'README.md', meta: '项目入口文档', starred: true },
    { name: 'AGENTS.md', meta: 'Agent 协作规则', starred: true },
    { name: 'docs/ARCHITECTURE.md', meta: '桌面 + Runtime 架构', starred: false },
    { name: 'docs/ui/MAIN_WORKBENCH_WIREFRAME.md', meta: '主界面线框', starred: false },
    { name: 'OpenAgent/renderer/App.tsx', meta: '桌面主界面入口', starred: false }
  ];

  return (
    <div className="section-list">
      <div className="workspace-card">
        <div className="node-title-row">
          <div className="row row-gap-8">
            <FolderGit2 size={16} />
            <strong>{workspace.name}</strong>
          </div>
          <span className="text-muted">root</span>
        </div>
        <div className="body-copy-soft mt-8">{workspace.rootPath}</div>
      </div>

      {files.map((file) => (
        <div key={file.name} className="file-node">
          <div className="node-title-row">
            <div className="row row-gap-8">
              <FileCode2 size={15} />
              <span>{file.name}</span>
            </div>
            <div className="row row-gap-8">
              {file.starred && <Star size={14} color="var(--warning)" fill="var(--warning)" />}
              <ChevronRight size={14} className="text-muted" />
            </div>
          </div>
          <div className="text-muted">{file.meta}</div>
        </div>
      ))}
    </div>
  );
}
