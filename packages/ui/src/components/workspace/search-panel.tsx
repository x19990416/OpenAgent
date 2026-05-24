import { Search, Sparkles } from 'lucide-react';

export function SearchPanel() {
  const results = [
    { title: 'docs/ARCHITECTURE.md', snippet: 'Renderer UI / Preload / Electron Main / Agent Runtime / Workspace Runtime' },
    { title: 'docs/DESIGN_SYSTEM.md', snippet: '主工作台采用三栏布局，右侧承载 Plan / Patch / Approval / Context / Run Log' },
    { title: 'OpenAgent/renderer/components/layout/app-shell.tsx', snippet: 'AppShell 负责 top / left / center / right / bottom 五区布局' }
  ];

  return (
    <div className="section-list">
      <div className="workspace-card">
        <div className="row row-gap-8">
          <Search size={16} />
          <strong>Global Search</strong>
        </div>
        <input className="search-input" placeholder="Search code, file, symbol..." />
      </div>

      {results.map((result) => (
        <div key={result.title} className="search-result">
          <div className="node-title-row">
            <strong>{result.title}</strong>
            <Sparkles size={14} color="var(--accent)" />
          </div>
          <div className="text-soft">{result.snippet}</div>
        </div>
      ))}
    </div>
  );
}
