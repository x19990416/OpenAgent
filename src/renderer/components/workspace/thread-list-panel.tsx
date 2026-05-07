import { Clock3, MessageSquareText } from 'lucide-react';

export function ThreadListPanel() {
  const threads = [
    { title: '主界面设计讨论', summary: '梳理桌面工作台的三栏布局与信息架构。', updatedAt: '2 分钟前' },
    { title: 'Agent 执行链路梳理', summary: '明确 coordinator / planner / executor / auditor 的协作。', updatedAt: '12 分钟前' },
    { title: '审批模型设计', summary: '高风险命令、补丁应用与 Git 操作审批策略。', updatedAt: '今天 10:42' }
  ];

  return (
    <div className="section-list">
      {threads.map((thread) => (
        <div key={thread.title} className="thread-node">
          <div className="node-title-row">
            <div className="row row-gap-8">
              <MessageSquareText size={15} />
              <strong>{thread.title}</strong>
            </div>
            <span className="text-muted">open</span>
          </div>
          <div className="text-soft">{thread.summary}</div>
          <div className="row row-gap-6 text-muted">
            <Clock3 size={13} />
            {thread.updatedAt}
          </div>
        </div>
      ))}
    </div>
  );
}
