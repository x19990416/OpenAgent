import { CheckCircle2, CircleDashed, LoaderCircle } from 'lucide-react';

export function TaskListPanel() {
  const tasks = [
    { title: '梳理桌面主界面 IA', status: 'completed', owner: 'Planner' },
    { title: '生成 Electron 骨架', status: 'in_progress', owner: 'Executor' },
    { title: '补充审批交互', status: 'pending', owner: 'Auditor' }
  ];

  return (
    <div className="section-list">
      {tasks.map((task) => {
        const Icon = task.status === 'completed' ? CheckCircle2 : task.status === 'in_progress' ? LoaderCircle : CircleDashed;
        return (
          <div key={task.title} className="task-node">
            <div className="node-title-row">
              <div className="row row-gap-8">
                <Icon size={15} />
                <strong>{task.title}</strong>
              </div>
              <span className="text-muted">{task.status}</span>
            </div>
            <div className="text-soft">owner: {task.owner}</div>
          </div>
        );
      })}
    </div>
  );
}
