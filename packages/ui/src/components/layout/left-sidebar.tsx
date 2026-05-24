import { CircleUserRound, Clock3, LogOut, Bot, ChevronDown, ChevronUp, FolderOpen, Plus, Puzzle, Settings, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceMeta } from '@openagent/shared-types/events';
import type { LeftSidebarTab, MainAgentBootstrapSnapshot, SettingsTab, ThreadListItem } from '../../types/workbench';
import { resolveMainAgentDisplayName } from '../../lib/agent-name';

interface LeftSidebarProps {
  activeTab: LeftSidebarTab;
  onTabChange: (tab: LeftSidebarTab) => void;
  workspace: WorkspaceMeta;
  agentBootstrap: MainAgentBootstrapSnapshot | null;
  threads: ThreadListItem[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onOpenSettings: (tab: SettingsTab) => void;
}

const navItems: Array<{ key: LeftSidebarTab; label: string; icon: typeof Clock3 }> = [
  { key: 'schedules', label: '定时任务', icon: Clock3 }
];

const MAX_VISIBLE_RUNS = 5;

export function LeftSidebar({
  activeTab,
  onTabChange,
  workspace,
  agentBootstrap,
  threads,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onDeleteThread,
  onOpenSettings
}: LeftSidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const agentDisplayName = resolveMainAgentDisplayName(agentBootstrap);
  const [settingsPosition, setSettingsPosition] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const sortedThreads = useMemo(() => sortThreadsForDisplay(threads), [threads]);
  const visibleThreads = showAllThreads ? sortedThreads : sortedThreads.slice(0, MAX_VISIBLE_RUNS);
  const hiddenThreadCount = Math.max(0, sortedThreads.length - MAX_VISIBLE_RUNS);
  const workspaceRoot = workspace?.rootPath?.trim();

  useEffect(() => {
    if (!settingsOpen) {
      setSettingsPosition(null);
      return;
    }

    const updateSettingsPosition = () => {
      const button = settingsButtonRef.current;
      const sidebar = sidebarRef.current;
      if (!button) return;

      const rect = button.getBoundingClientRect();
      const sidebarRect = sidebar?.getBoundingClientRect();
      const menuWidth = rect.width;
      const minLeft = sidebarRect ? sidebarRect.left : 16;
      const maxLeft = sidebarRect
        ? sidebarRect.right - menuWidth
        : window.innerWidth - menuWidth - 16;
      const left = Math.max(minLeft, Math.min(rect.left, maxLeft));
      const bottom = Math.max(12, window.innerHeight - rect.top + 12);
      setSettingsPosition({ left, bottom, width: menuWidth });
    };

    const closeOnOutsideClick = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (settingsButtonRef.current?.contains(target)) return;
      if (settingsMenuRef.current?.contains(target)) return;
      setSettingsOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    };

    updateSettingsPosition();
    window.addEventListener('resize', updateSettingsPosition);
    window.addEventListener('scroll', updateSettingsPosition, true);
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('touchstart', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('resize', updateSettingsPosition);
      window.removeEventListener('scroll', updateSettingsPosition, true);
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('touchstart', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [settingsOpen]);

  return (
    <aside ref={sidebarRef} className="sidebar">
      <div className="sidebar-nav">
        <button
          type="button"
          className="sidebar-nav-item"
          onClick={() => onOpenSettings('plugins')}
        >
          <span className="row row-gap-12">
            <Puzzle size={18} />
            插件
          </span>
        </button>

        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.key || (item.key === 'threads' && activeTab === 'threads');
          return (
            <button
              key={item.key}
              type="button"
              className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onTabChange(item.key)}
            >
              <span className="row row-gap-12">
                <Icon size={18} />
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

      <div className="sidebar-content scroll-y">
        <div className="sidebar-section sidebar-agent-sessions">
          <div className="sidebar-agent-header">
            <div className="sidebar-agent-header-title">
              <div className="sidebar-agent-header-main">
                <Bot size={18} />
                <span className="sidebar-agent-name">{agentDisplayName}</span>
              </div>
              <button
                type="button"
                className="sidebar-agent-toggle"
                aria-label={sessionsExpanded ? '折叠 session 列表' : '展开 session 列表'}
                title={sessionsExpanded ? '折叠 session 列表' : '展开 session 列表'}
                onClick={() => setSessionsExpanded((prev) => !prev)}
              >
                {sessionsExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </button>
            </div>
            <div className="sidebar-agent-actions">
              <button
                type="button"
                className="sidebar-agent-workspace"
                aria-label="打开 workspace 目录"
                title={workspaceRoot ? `打开 workspace 目录：${workspaceRoot}` : '打开 workspace 目录'}
                disabled={!workspaceRoot}
                onClick={() => {
                  if (!workspaceRoot) return;
                  void window.desktopApi?.openPromptAttachment?.({ path: workspaceRoot, action: 'open' });
                }}
              >
                <FolderOpen size={16} />
              </button>
              <button
                type="button"
                className="sidebar-agent-create"
                aria-label="新建 session"
                title="新建 session"
                onClick={() => void onCreateThread()}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>

          {sessionsExpanded ? (
            <div className="sidebar-thread-list">
              {visibleThreads.length > 0 ? (
              <>
                {visibleThreads.map((thread) => (
                  <div
                    key={thread.threadId}
                    role="button"
                    tabIndex={0}
                    className={`sidebar-thread-item ${thread.threadId === activeThreadId ? 'active' : ''}`}
                    onClick={() => onSelectThread(thread.threadId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectThread(thread.threadId);
                      }
                    }}
                  >
                    <div className="sidebar-thread-title">{formatThreadTitle(thread)}</div>
                    <div className="sidebar-thread-action-slot">
                      <span className="sidebar-thread-time">{formatRelativeDate(thread.updatedAt)}</span>
                      <button
                        type="button"
                        className="sidebar-thread-delete"
                        aria-label={`删除 session：${formatThreadTitle(thread)}`}
                        title="删除 session（暂未开放）"
                        disabled
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}

                {hiddenThreadCount > 0 && (
                  <button type="button" className="sidebar-expand-button" onClick={() => setShowAllThreads((prev) => !prev)}>
                    <span>{showAllThreads ? '收起显示' : '展开显示'}</span>
                    {showAllThreads ? <ChevronUp size={14} /> : <ChevronUp size={14} className="rotate-180" />}
                  </button>
                )}
              </>
            ) : (
              <div className="sidebar-thread-item">
                <div>
                  <div className="sidebar-thread-title">暂无历史 session</div>
                  <div className="sidebar-thread-summary">每次对话都会作为一个 session 显示在这里。</div>
                </div>
              </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="sidebar-footer">
        <button
          ref={settingsButtonRef}
          className={`sidebar-nav-item w-full ${settingsOpen ? 'active' : ''}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((prev) => !prev)}
        >
          <span className="row row-gap-10">
            <Settings size={16} />
            设置
          </span>
        </button>
      </div>

      {settingsOpen && settingsPosition && (
        <div
          ref={settingsMenuRef}
          className="settings-popover panel panel-strong"
          style={{
            left: `${settingsPosition.left}px`,
            bottom: `${settingsPosition.bottom}px`,
            width: `${settingsPosition.width}px`
          }}
          role="menu"
          aria-label="设置菜单"
        >
          <button
            className="settings-popover-account"
            type="button"
            role="menuitem"
            onClick={() => {
              setSettingsOpen(false);
              onOpenSettings('account');
            }}
          >
            <div className="settings-popover-avatar">
              <CircleUserRound size={24} />
            </div>
            <div className="settings-popover-account-copy">
              <div className="settings-popover-email">OpenAgent</div>
            </div>
          </button>

          <div className="settings-popover-divider" />

          <button
            className="settings-popover-item"
            type="button"
            role="menuitem"
            onClick={() => {
              setSettingsOpen(false);
              onOpenSettings('models');
            }}
          >
            <span className="row row-gap-10">
              <Settings size={18} />
              设置
            </span>
          </button>

          <div className="settings-popover-divider" />

          <button className="settings-popover-item" type="button" role="menuitem" onClick={() => setSettingsOpen(false)}>
            <span className="row row-gap-10">
              <LogOut size={18} />
              退出登录
            </span>
          </button>
        </div>
      )}
    </aside>
  );
}

function formatThreadTitle(thread: ThreadListItem) {
  return thread.title?.trim() || '未命名 session';
}

function sortThreadsForDisplay(threads: ThreadListItem[]) {
  return [...threads].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.createdAt);
    const bTime = Date.parse(b.updatedAt || b.createdAt);
    return normalizeTime(bTime) - normalizeTime(aTime);
  });
}

function normalizeTime(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function formatRelativeDate(value: string) {
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return '';

  const diff = Math.max(0, Date.now() - target);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < hour) {
    return `${Math.max(1, Math.floor(diff / minute))} 分钟`;
  }

  if (diff < day) {
    return `${Math.max(1, Math.floor(diff / hour))} 小时`;
  }

  return `${Math.max(1, Math.floor(diff / day))} 天`;
}
