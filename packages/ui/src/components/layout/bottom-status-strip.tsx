import { GitBranch, Laptop2 } from 'lucide-react';
import type { WorkbenchViewModel } from '../../types/workbench';

export function BottomStatusStrip({ viewModel }: { viewModel: WorkbenchViewModel }) {
  return (
    <footer className="bottom-strip">
      <div className="bottom-left">
        <span className="status-badge">
          <Laptop2 size={13} />
          本地工作
        </span>
        <span className="status-badge">
          <GitBranch size={13} />
          {viewModel.workspace.branch}
        </span>
      </div>
      <div className="bottom-right text-muted">{viewModel.runLog.at(-1)?.text ?? 'Ready'}</div>
    </footer>
  );
}
