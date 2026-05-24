import { TerminalSquare, Wrench } from 'lucide-react';
import type { ToolCallItem } from '@openagent/shared-types/events';

export function ToolTimeline({ tools }: { tools: ToolCallItem[] }) {
  if (tools.length === 0) {
    return null;
  }

  return (
    <div className="timeline-block">
      <div className="section-head">
        <div className="row row-gap-8">
          <TerminalSquare size={16} />
          <strong>执行轨迹</strong>
        </div>
        <span className="text-muted">{tools.length} items</span>
      </div>

      <div className="timeline-list">
        {tools.map((tool, index) => (
          <div key={`${tool.id}-${index}`} className="timeline-item">
            <div className="tool-head">
              <div className="row row-gap-8">
                <Wrench size={14} />
                <strong className="timeline-item-name">{tool.name}</strong>
              </div>
              <span className={`status-badge status-${tool.status}`}>
                <span className={`status-dot dot-${tool.status}`} />
                {tool.status}
              </span>
            </div>
            <div className="timeline-item-summary">{tool.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
