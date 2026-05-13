import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  CircleUserRound,
  Cpu,
  Database,
  Eye,
  FolderGit2,
  FolderOpen,
  Gauge,
  GitBranch,
  KeyRound,
  MinusCircle,
  Monitor,
  Palette,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Settings,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  Wrench,
  X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  LlmAuthType,
  KnowledgeArticleReadResult,
  KnowledgeBrowseSnapshot,
  KnowledgeGraphResult,
  KnowledgeHealthResult,
  KnowledgeLintResult,
  KnowledgeResult,
  LlmProviderCatalog,
  LlmProviderConfig,
  LlmProviderKindDefinition,
  LlmProviderKind,
  PluginRegistrySnapshot,
  UpsertLlmProviderInput,
  WechatOfficialAccountPluginConfig,
  WorkspaceMeta
} from '@shared-types/index';
import type { SettingsTab } from '@/types/workbench';

interface SettingsScreenProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onWorkspaceChange: (workspace: WorkspaceMeta) => void;
  onBack: () => void;
}

type SettingRow =
  | {
      title: string;
      description: string;
      kind: 'select';
      value: string;
      leading?: ReactNode;
    }
  | {
      title: string;
      description: string;
      kind: 'toggle';
      value: boolean;
    }
  | {
      title: string;
      description: string;
      kind: 'actions';
      status: string;
      action: string;
    }
  | {
      title: string;
      description: string;
      kind: 'segments';
      segments: [string, string];
      activeIndex: 0 | 1;
    };

const navItems: Array<{
  key: SettingsTab;
  label: string;
  icon: typeof Settings2;
}> = [
  { key: 'general', label: '常规', icon: Settings2 },
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'models', label: '模型', icon: Bot },
  { key: 'plugins', label: '插件', icon: Puzzle },
  { key: 'knowledge', label: '知识库', icon: Database },
  { key: 'config', label: '配置', icon: SlidersHorizontal },
  { key: 'personalization', label: '个性化', icon: Sparkles },
  { key: 'mcp', label: 'MCP 服务器', icon: CircleUserRound },
  { key: 'git', label: 'Git', icon: GitBranch },
  { key: 'environment', label: '环境', icon: Monitor },
  { key: 'workspace', label: '工作树', icon: FolderGit2 },
  { key: 'computer', label: '电脑使用', icon: Monitor },
  { key: 'archived', label: '已归档聊天', icon: Archive },
  { key: 'usage', label: '使用情况', icon: Gauge }
];

const pageTitles: Record<SettingsTab, string> = {
  general: '常规',
  appearance: '外观',
  models: '模型与提供方',
  plugins: '插件',
  knowledge: '知识库',
  config: '配置',
  personalization: '个性化',
  account: '账户',
  mcp: 'MCP 服务器',
  git: 'Git',
  environment: '环境',
  workspace: '工作树',
  computer: '电脑使用',
  archived: '已归档聊天',
  usage: '使用情况'
};

const pageRows: Record<SettingsTab, SettingRow[]> = {
  general: [
    { title: '默认打开目标', description: '默认打开文件和文件夹的位置', kind: 'select', value: 'VS Code' },
    { title: '语言', description: '应用 UI 语言', kind: 'select', value: '自动检测' },
    { title: '详细级别', description: '选择要在应用中显示的详情模式', kind: 'select', value: '编程' },
    {
      title: '在菜单栏中显示',
      description: '主窗口关闭后，将 Codex 保留在 macOS 菜单栏中',
      kind: 'toggle',
      value: true
    },
    {
      title: '弹出窗口热键',
      description: '为弹出窗口设置全局快捷键。留空可保持关闭状态。',
      kind: 'actions',
      status: '禁用',
      action: '设置'
    },
    {
      title: '运行时防止系统休眠',
      description: '在 Codex 运行聊天时，让电脑保持唤醒状态',
      kind: 'toggle',
      value: false
    },
    {
      title: '需按 ⌘ + 回车键发送长文本提示',
      description: '启用后，长文本提示需按 ⌘ + 回车键发送。',
      kind: 'toggle',
      value: false
    },
    {
      title: '速度',
      description: '选择聊天、子代理和压缩中的推理速度。快速模式消耗 2 倍计划用量',
      kind: 'select',
      value: '标准'
    },
    {
      title: '跟进行为',
      description: '在 Codex 运行时排队跟进任务，或引导当前运行。按 ⌘Enter 可对单条消息执行相反操作。',
      kind: 'segments',
      segments: ['排队', '引导'],
      activeIndex: 0
    },
    {
      title: '代码审查',
      description: '尽可能在当前聊天中启动 /review，或发起单独的评审聊天',
      kind: 'segments',
      segments: ['行内', '独立'],
      activeIndex: 0
    }
  ],
  appearance: [
    { title: '主题', description: '当前界面主题', kind: 'select', value: '浅色' },
    { title: '布局密度', description: '控制界面留白与紧凑程度', kind: 'select', value: '舒适' },
    { title: '字号', description: 'UI 字体大小', kind: 'select', value: '标准' },
    { title: '圆角', description: '卡片和按钮的圆角强度', kind: 'select', value: '中等' }
  ],
  models: [],
  plugins: [],
  knowledge: [],
  config: [
    { title: '工作区默认行为', description: '设置启动后的默认动作', kind: 'select', value: '恢复上次状态' },
    { title: '模型切换提示', description: '是否显示模型切换时的提示信息', kind: 'toggle', value: true },
    { title: '自动保存窗口状态', description: '窗口大小、分栏状态与打开页签', kind: 'toggle', value: true }
  ],
  personalization: [
    { title: '欢迎语', description: '首次进入时显示的欢迎信息', kind: 'select', value: '简洁模式' },
    { title: '强调色', description: '界面的高亮颜色', kind: 'select', value: '蓝色' },
    { title: '消息气泡', description: '对话消息的显示风格', kind: 'select', value: '柔和' }
  ],
  account: [
    {
      title: '登录身份',
      description: '当前会话的账户信息',
      kind: 'select',
      value: 'starseeker.limin@gmail.com',
      leading: <CircleUserRound size={16} />
    },
    { title: '账户类型', description: '当前登录的账户类别', kind: 'select', value: '个人帐户' },
    { title: '登录状态', description: '会话身份状态', kind: 'toggle', value: true }
  ],
  mcp: [
    { title: 'MCP 服务连接', description: '管理可用的 MCP 服务', kind: 'select', value: '本地连接' },
    { title: '默认启用范围', description: '决定启动时加载哪些 MCP 服务', kind: 'select', value: '工作区' }
  ],
  git: [
    { title: '提交前检查', description: '提交前自动执行校验', kind: 'toggle', value: true },
    { title: '默认分支策略', description: '新任务的分支创建规则', kind: 'select', value: '当前分支' },
    { title: 'Git 操作提示', description: '显示提交、推送和合并提示', kind: 'toggle', value: true }
  ],
  environment: [
    { title: '终端环境', description: '用于执行命令的默认 shell', kind: 'select', value: 'zsh' },
    { title: '系统变量', description: '工作区运行时变量与路径', kind: 'select', value: '自动加载' },
    { title: '代理设置', description: '网络代理或远程访问配置', kind: 'select', value: '跟随系统' }
  ],
  workspace: [
    { title: '工作树模式', description: '工作区与变更树的组织方式', kind: 'select', value: '默认' },
    { title: '自动聚焦工作树', description: '切换任务后自动定位到相关工作树', kind: 'toggle', value: true }
  ],
  computer: [
    { title: '桌面控制', description: '允许当前工作区访问桌面操作', kind: 'toggle', value: false },
    { title: '截图辅助', description: '在需要时截取屏幕作为上下文', kind: 'toggle', value: false },
    { title: '窗口聚焦', description: '自动聚焦当前活动窗口', kind: 'toggle', value: true }
  ],
  archived: [
    { title: '归档方式', description: '隐藏已结束或已关闭的聊天', kind: 'select', value: '自动归档' },
    { title: '恢复策略', description: '从归档区恢复聊天的默认行为', kind: 'select', value: '手动恢复' }
  ],
  usage: [
    { title: '使用统计', description: '显示当前会话的使用概览', kind: 'select', value: '本月' },
    { title: '额度展示', description: '显示剩余额度与消耗情况', kind: 'toggle', value: true }
  ]
};

const providerKindLabels: Record<LlmProviderKind, string> = {
  openai: 'OpenAI 官方',
  'openai-codex': 'ChatGPT / Codex 订阅',
  codex: 'Codex / Responses',
  'openai-compatible': 'OpenAI 兼容',
  'pi-provider': '内置 AgentSession Provider',
  anthropic: 'Anthropic',
  google: 'Google / Gemini',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  dashscope: '阿里百炼',
  'dashscope-responses': '阿里百炼 / Responses'
};

const authTypeLabels: Record<LlmAuthType, string> = {
  api_key: 'API Key',
  bearer: 'Bearer Token',
  api_key_header: '自定义 Header',
  openai_auth: 'OpenAI Auth',
  none: '无认证'
};

const providerAppearance: Record<string, { badge: string; tone: string; icon?: typeof Bot }> = {
  'openai-official': { badge: 'O', tone: 'is-openai' },
  'custom-openai-compatible': { badge: 'C', tone: 'is-compatible' },
  'dashscope-compatible': { badge: '阿', tone: 'is-dashscope' }
};

type ProviderDraft = {
  name: string;
  kind: LlmProviderKind;
  invocationMode: 'chat-completions' | 'responses' | 'pi-agent-session';
  baseUrl: string;
  apiKey: string;
  authType: LlmAuthType;
  headerName: string;
  modelInput: string;
  models: string[];
  defaultModel: string;
  discoveredModels: string[];
};

type ModelContextWindowDraft = {
  providerId: string;
  modelId: string;
  modelName: string;
  contextWindow: string;
};

const initialProviderDraft: ProviderDraft = {
  name: '',
  kind: 'openai-compatible',
  invocationMode: 'chat-completions',
  baseUrl: '',
  apiKey: '',
  authType: 'bearer',
  headerName: 'Authorization',
  modelInput: '',
  models: [],
  defaultModel: '',
  discoveredModels: []
};

const emptyProviderCatalog: LlmProviderCatalog = {
  activeProviderId: '',
  providers: []
};

const fallbackProviderDefinitions: LlmProviderKindDefinition[] = [
  {
    kind: 'openai-compatible',
    label: '自定义兼容接口',
    description: '公司网关 / 本地模型服务 / OpenAI-compatible。',
    supportedAuthTypes: ['bearer', 'api_key_header', 'none'],
    invocationMode: 'chat-completions',
    defaultInvocationMode: 'chat-completions',
    defaultBaseUrl: 'https://your-gateway.example.com/v1'
  }
];

const invocationModeOptions: Array<{
  value: ProviderDraft['invocationMode'];
  label: string;
  description: string;
}> = [
  {
    value: 'chat-completions',
    label: 'Chat Completions',
    description: '兼容性更广，适合基础消息/函数调用。'
  },
  {
    value: 'responses',
    label: 'Responses',
    description: '更完整的 Agents / tools 入口。'
  }
];

function SettingsRow({ row }: { row: SettingRow }) {
  const control = (() => {
    if (row.kind === 'select') {
      return (
        <button className="settings-control settings-control-select" type="button">
          <span className="settings-control-select-leading">
            {row.leading && <span className="settings-control-leading">{row.leading}</span>}
            <span>{row.value}</span>
          </span>
          <ChevronDown size={14} />
        </button>
      );
    }

    if (row.kind === 'toggle') {
      return (
        <button className={`settings-switch ${row.value ? 'is-on' : 'is-off'}`} type="button" aria-pressed={row.value}>
          <span className="settings-switch-knob" />
        </button>
      );
    }

    if (row.kind === 'actions') {
      return (
        <div className="settings-actions">
          <span className="settings-actions-status">{row.status}</span>
          <button className="settings-control settings-control-action" type="button">
            {row.action}
          </button>
        </div>
      );
    }

    return (
      <div className="settings-segments" role="group" aria-label={row.title}>
        {row.segments.map((segment, index) => (
          <button
            key={`${segment}-${index}`}
            className={`settings-segment ${row.activeIndex === index ? 'active' : ''}`}
            type="button"
            aria-pressed={row.activeIndex === index}
          >
            {segment}
          </button>
        ))}
      </div>
    );
  })();

  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{row.title}</div>
        <div className="settings-row-description">{row.description}</div>
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

function ProviderAvatar({ provider }: { provider: LlmProviderConfig }) {
  const appearance = providerAppearance[provider.id] ?? { badge: provider.name.slice(0, 1), tone: 'is-generic', icon: Cpu };
  const Icon = appearance.icon;

  return (
    <span className={`settings-provider-avatar ${appearance.tone}`}>
      {Icon ? <Icon size={16} /> : appearance.badge}
    </span>
  );
}

function deriveProviderName(baseUrl: string, index: number) {
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^www\./, '');
    return hostname || `Custom Provider ${index}`;
  } catch {
    return `Custom Provider ${index}`;
  }
}

function normalizeDraftProviderId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createUniqueProviderId(name: string, providers: LlmProviderCatalog['providers']) {
  const baseId = normalizeDraftProviderId(name) || `custom-provider-${providers.length + 1}`;
  const existingIds = new Set(providers.map((provider) => provider.id));

  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let index = 2;
  let nextId = `${baseId}-${index}`;

  while (existingIds.has(nextId)) {
    index += 1;
    nextId = `${baseId}-${index}`;
  }

  return nextId;
}

function formatTokenWindow(value?: number) {
  const tokenValue = value ?? 128000;
  return tokenValue >= 1000 ? `${Math.round(tokenValue / 1000)}K` : String(tokenValue);
}

function ModelCapabilityIcons({ provider }: { provider: LlmProviderConfig['models'][number] }) {
  const values = new Set(provider.capabilities?.map((item) => item.value) ?? []);

  return (
    <>
      {(values.has('reasoning') || values.has('high-performance') || values.has('general')) && (
        <span className="settings-model-capability reasoning">
          <WandSparkles size={14} />
        </span>
      )}
      {(values.has('vision') || provider.name.toLowerCase().includes('4v')) && (
        <span className="settings-model-capability vision">
          <Eye size={14} />
        </span>
      )}
      {(values.has('coding') || values.has('tool-calling') || values.has('openai-compatible')) && (
        <span className="settings-model-capability tool">
          <Wrench size={14} />
        </span>
      )}
      <span className="settings-model-capability tokens">
        <Database size={14} />
      </span>
    </>
  );
}

function LlmProviderPanel({ onWorkspaceChange }: { onWorkspaceChange: (workspace: WorkspaceMeta) => void }) {
  const [catalog, setCatalog] = useState<LlmProviderCatalog>(emptyProviderCatalog);
  const [catalogSeed, setCatalogSeed] = useState<LlmProviderCatalog>(emptyProviderCatalog);
  const [providerDefinitions, setProviderDefinitions] = useState<LlmProviderKindDefinition[]>(fallbackProviderDefinitions);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [addStep, setAddStep] = useState<'type' | 'connect' | 'models' | 'review'>('type');
  const [isCheckingDraft, setIsCheckingDraft] = useState(false);
  const [isDiscoveringDraft, setIsDiscoveringDraft] = useState(false);
  const [isSecretVisible, setIsSecretVisible] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(initialProviderDraft);
  const [saveFeedback, setSaveFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [providerFeedback, setProviderFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selectedProviderApiKey, setSelectedProviderApiKey] = useState('');
  const [isCodexLoginInProgress, setIsCodexLoginInProgress] = useState(false);
  const [contextWindowDraft, setContextWindowDraft] = useState<ModelContextWindowDraft | null>(null);
  const [contextWindowFeedback, setContextWindowFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const draftModelInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.getLlmProviderCatalog) {
      return;
    }

    void desktopApi
      .getLlmProviderCatalog()
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        setCatalogSeed(nextCatalog);
        setSelectedProviderId(nextCatalog.activeProviderId || nextCatalog.providers[0]?.id || '');
      })
      .catch((error) => {
        console.error('getLlmProviderCatalog failed', error);
      });
  }, []);

  useEffect(() => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.getLlmProviderDefinitions) {
      return;
    }

    void desktopApi
      .getLlmProviderDefinitions()
      .then((nextDefinitions) => {
        if (nextDefinitions.length > 0) {
          setProviderDefinitions(nextDefinitions);
        }
      })
      .catch((error) => {
        console.error('getLlmProviderDefinitions failed', error);
      });
  }, []);

  useEffect(() => {
    if (!isCreateOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeCreateDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isCreateOpen]);

  useEffect(() => {
    setIsSecretVisible(false);
    setSelectedProviderApiKey('');
  }, [selectedProviderId]);

  useEffect(() => {
    if (providerFeedback?.type !== 'success') {
      return;
    }

    const timer = window.setTimeout(() => {
      setProviderFeedback((current) => (current === providerFeedback ? null : current));
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [providerFeedback]);

  useEffect(() => {
    if (!contextWindowDraft) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextWindowDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextWindowDraft]);

  const selectedProvider = useMemo<LlmProviderConfig | null>(() => {
    return catalog.providers.find((provider) => provider.id === selectedProviderId) ?? catalog.providers[0] ?? null;
  }, [catalog.providers, selectedProviderId]);

  const selectedDraftProviderDefinition = useMemo(() => {
    return providerDefinitions.find((definition) => definition.kind === draft.kind) ?? fallbackProviderDefinitions[0];
  }, [draft.kind, providerDefinitions]);

  const availableDraftAuthTypes = selectedDraftProviderDefinition.supportedAuthTypes;
  const draftNeedsSecret = draft.authType !== 'none';
  const draftInvocationModeLocked = true;
  const canSubmitDraft = Boolean(
    (draft.name.trim() || selectedDraftProviderDefinition.label) &&
      (draft.kind !== 'openai-compatible' || draft.baseUrl.trim()) &&
      (!draftNeedsSecret || draft.apiKey.trim()) &&
      draft.models.length > 0 &&
      (draft.defaultModel || draft.models[0])
  );

  const updateDraft = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const applyDraftProviderKind = (kind: LlmProviderKind) => {
    const definition = providerDefinitions.find((item) => item.kind === kind) ?? fallbackProviderDefinitions[0];
    const nextAuthType = definition.supportedAuthTypes[0] ?? 'bearer';

    setDraft((prev) => ({
      ...prev,
      kind,
      invocationMode: (definition.defaultInvocationMode || definition.invocationMode || 'pi-agent-session') as ProviderDraft['invocationMode'],
      authType: definition.supportedAuthTypes.includes(prev.authType) ? prev.authType : nextAuthType,
      headerName: nextAuthType === 'api_key_header' ? prev.headerName || 'X-API-Key' : 'Authorization',
      baseUrl:
        !prev.baseUrl.trim() || prev.baseUrl === selectedDraftProviderDefinition.defaultBaseUrl
          ? definition.defaultBaseUrl ?? ''
          : prev.baseUrl
    }));
  };

  const applyDraftInvocationMode = (invocationMode: ProviderDraft['invocationMode']) => {
    setDraft((prev) => ({
      ...prev,
      invocationMode
    }));
  };

  const applyDraftAuthType = (authType: LlmAuthType) => {
    setDraft((prev) => ({
      ...prev,
      authType,
      headerName: authType === 'api_key_header' ? prev.headerName || 'X-API-Key' : 'Authorization'
    }));
  };

  const serializeModels = (models: LlmProviderConfig['models']) =>
    models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities
    }));

  const persistSelectedProviderModels = async (nextProvider: LlmProviderConfig, successText: string) => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.updateLlmProviderModels) {
      desktopApi?.logDiagnostic?.('error', 'renderer missing updateLlmProviderModels', {
        availableMethods: desktopApi ? Object.keys(desktopApi) : []
      });
      setProviderFeedback({ type: 'error', text: '当前环境未挂载模型保存接口，请先重启桌面应用。' });
      return false;
    }

    try {
      const result = await desktopApi.updateLlmProviderModels({
        providerId: nextProvider.id,
        defaultModel: nextProvider.defaultModel,
        models: serializeModels(nextProvider.models)
      });

      if (!result.ok) {
        desktopApi.logDiagnostic?.('error', 'selected provider model update rejected', {
          providerId: nextProvider.id,
          error: result.error
        });
        setProviderFeedback({
          type: 'error',
          text: `模型保存失败：${result.error ?? '未知错误'}`
        });
        return false;
      }

      setCatalog(result.catalog);
      setSelectedProviderId(result.providerId);
      onWorkspaceChange(result.workspace);
      setProviderFeedback({
        type: 'success',
        text: successText
      });
      desktopApi.logDiagnostic?.('info', 'selected provider model update success', {
        providerId: result.providerId,
        modelCount: nextProvider.models.length,
        configPath: result.configPath
      });
      return true;
    } catch (error) {
      desktopApi.logDiagnostic?.('error', 'selected provider model update exception', {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        providerId: nextProvider.id
      });
      setProviderFeedback({
        type: 'error',
        text: `模型保存失败：${error instanceof Error ? error.message : '未知错误'}`
      });
      return false;
    }
  };

  const addDraftModel = () => {
    const nextModel = draft.modelInput.trim();

    if (!nextModel || draft.models.includes(nextModel)) {
      return;
    }

    setDraft((prev) => ({
      ...prev,
      modelInput: '',
      models: [...prev.models, nextModel],
      defaultModel: prev.defaultModel || nextModel
    }));
  };

  const removeDraftModel = (modelName: string) => {
    setDraft((prev) => ({
      ...prev,
      models: prev.models.filter((item) => item !== modelName),
      defaultModel: prev.defaultModel === modelName ? prev.models.find((item) => item !== modelName) ?? '' : prev.defaultModel
    }));
  };

  const toggleDraftModel = (modelName: string) => {
    setDraft((prev) => {
      if (prev.models.includes(modelName)) {
        const nextModels = prev.models.filter((item) => item !== modelName);
        return {
          ...prev,
          models: nextModels,
          defaultModel: prev.defaultModel === modelName ? nextModels[0] ?? '' : prev.defaultModel
        };
      }

      return {
        ...prev,
        models: [...prev.models, modelName],
        defaultModel: prev.defaultModel || modelName
      };
    });
  };

  const selectDraftProviderKind = (kind: LlmProviderKind) => {
    const definition = providerDefinitions.find((item) => item.kind === kind) ?? fallbackProviderDefinitions[0];
    applyDraftProviderKind(kind);
    setDraft((prev) => ({
      ...prev,
      name: kind === 'openai-compatible' ? '' : definition.label
    }));
    setSaveFeedback(null);
    setAddStep('connect');
  };

  const fillDraftModelInput = (modelName: string) => {
    setDraft((prev) => ({
      ...prev,
      modelInput: modelName
    }));
    draftModelInputRef.current?.focus();
    draftModelInputRef.current?.select();
  };

  const openContextWindowDialog = (model: LlmProviderConfig['models'][number]) => {
    setContextWindowFeedback(null);
    setContextWindowDraft({
      providerId: selectedProvider?.id ?? '',
      modelId: model.id,
      modelName: model.name,
      contextWindow: String(model.contextWindow ?? model.maxOutputTokens ?? 128000)
    });
  };

  const closeContextWindowDialog = (clearFeedback = true) => {
    setContextWindowDraft(null);
    if (clearFeedback) {
      setContextWindowFeedback(null);
    }
  };

  const saveContextWindow = () => {
    if (!selectedProvider || !contextWindowDraft || contextWindowDraft.providerId !== selectedProvider.id) {
      return;
    }

    const rawValue = contextWindowDraft.contextWindow.trim();

    if (rawValue && (!Number.isFinite(Number(rawValue)) || Number(rawValue) <= 0)) {
      setContextWindowFeedback({
        type: 'error',
        text: '请输入一个大于 0 的上下文窗口数值，或留空恢复默认值。'
      });
      return;
    }

    const parsedValue = rawValue ? Number(rawValue) : undefined;

    const nextProvider = {
      ...selectedProvider,
      models: selectedProvider.models.map((model) => {
        if (model.id !== contextWindowDraft.modelId) {
          return model;
        }

        return {
          id: model.id,
          name: model.name,
          ...(parsedValue !== undefined ? { contextWindow: parsedValue } : {}),
          ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
          ...(model.capabilities?.length ? { capabilities: model.capabilities } : {})
        };
      })
    };

    void persistSelectedProviderModels(
      nextProvider,
      parsedValue !== undefined ? '已更新上下文窗口。' : '已恢复默认上下文窗口。'
    ).then((ok) => {
      if (ok) {
        closeContextWindowDialog(false);
      }
    });
  };

  const discoverDraftModels = async (mode: 'check' | 'discover' = 'discover') => {
    const desktopApi = window.desktopApi;
    const baseUrl = draft.baseUrl.trim();
    const apiKey = draft.apiKey.trim();

    if (draftNeedsSecret && !apiKey) {
      setSaveFeedback({ type: 'error', text: '请先填写 API Key。' });
      return false;
    }

    if (!desktopApi?.discoverLlmModels) {
      desktopApi?.logDiagnostic?.('error', 'renderer missing discoverLlmModels', {
        availableMethods: desktopApi ? Object.keys(desktopApi) : []
      });
      setSaveFeedback({ type: 'error', text: '当前环境未挂载模型发现接口，请先重启桌面应用。' });
      return false;
    }

    try {
      if (mode === 'check') {
        setIsCheckingDraft(true);
      } else {
        setIsDiscoveringDraft(true);
      }

      const result = await desktopApi.discoverLlmModels({
        kind: draft.kind,
        baseUrl,
        auth: {
          type: draft.authType,
          secret: apiKey,
          headerName: draft.authType === 'api_key_header' ? draft.headerName.trim() || 'X-API-Key' : 'Authorization',
          description: ''
        }
      });

      if (!result.ok) {
        setSaveFeedback({
          type: 'error',
          text: `${mode === 'check' ? '连接检查' : '模型发现'}失败：${result.error ?? '未知错误'}`
        });
        desktopApi.logDiagnostic?.('error', 'draft model discovery rejected', {
          kind: draft.kind,
          baseUrl,
          error: result.error
        });
        return false;
      }

      const discovered = result.models.map((item) => item.id).filter(Boolean);
      setDraft((prev) => ({
        ...prev,
        discoveredModels: discovered
      }));
      setSaveFeedback({
        type: 'success',
        text: mode === 'check' ? '连接成功' : `发现 ${result.models.length} 个模型`
      });
      desktopApi.logDiagnostic?.('info', 'draft model discovery success', {
        requestUrl: result.requestUrl,
        count: result.models.length
      });
      return true;
    } catch (error) {
      desktopApi.logDiagnostic?.('error', 'draft model discovery exception', {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        kind: draft.kind,
        baseUrl
      });
      setSaveFeedback({
        type: 'error',
        text: `${mode === 'check' ? '连接检查' : '模型发现'}失败：${error instanceof Error ? error.message : '未知错误'}`
      });
      return false;
    } finally {
      setIsCheckingDraft(false);
      setIsDiscoveringDraft(false);
    }
  };

  const closeCreateDialog = (clearFeedback = true) => {
    setIsCreateOpen(false);
    setAddStep('type');
    setDraft(initialProviderDraft);
    if (clearFeedback) {
      setSaveFeedback(null);
    }
  };

  const openCreateDialog = () => {
    const defaultDefinition =
      providerDefinitions.find((definition) => definition.kind === 'openai-compatible') ??
      fallbackProviderDefinitions[0];
    const defaultAuthType = defaultDefinition.supportedAuthTypes[0] ?? 'bearer';

    setSaveFeedback(null);
    setAddStep('type');
    setDraft({
      ...initialProviderDraft,
      kind: defaultDefinition.kind,
      invocationMode: (defaultDefinition.defaultInvocationMode || defaultDefinition.invocationMode || 'chat-completions') as ProviderDraft['invocationMode'],
      name: defaultDefinition.kind === 'openai-compatible' ? '' : defaultDefinition.label,
      baseUrl: defaultDefinition.defaultBaseUrl ?? '',
      authType: defaultAuthType,
      headerName: defaultAuthType === 'api_key_header' ? 'X-API-Key' : 'Authorization'
    });
    setIsCreateOpen(true);
  };

  const createProvider = () => {
    if (!canSubmitDraft) {
      return;
    }

    const providerIndex = catalog.providers.length + 1;
    const providerName = draft.name.trim() || selectedDraftProviderDefinition.label || deriveProviderName(draft.baseUrl.trim(), providerIndex);
    const providerId = draft.kind === 'openai-compatible' ? createUniqueProviderId(providerName, catalog.providers) : draft.kind;
    const payload: UpsertLlmProviderInput = {
      name: providerName,
      kind: draft.kind,
      invocationMode: draft.invocationMode,
      enabled: true,
      providerId,
      baseUrl: draft.baseUrl.trim(),
      auth: {
        type: draft.authType,
        secret: draft.apiKey.trim(),
        headerName: draft.authType === 'api_key_header' ? draft.headerName.trim() || 'X-API-Key' : 'Authorization',
        description: ''
      },
      defaultModel: draft.defaultModel || draft.models[0],
      models: draft.models.map((modelName) => ({
        id: modelName,
        name: modelName,
        contextWindow: 128000,
        capabilities: [{ value: 'tool-calling', label: 'Tool calling' }]
      })),
      notes: ''
    };

    const desktopApi = window.desktopApi;

    if (!desktopApi?.upsertLlmProvider) {
      desktopApi?.logDiagnostic?.('error', 'renderer missing upsertLlmProvider', {
        availableMethods: desktopApi ? Object.keys(desktopApi) : []
      });
      setSaveFeedback({ type: 'error', text: '当前环境未挂载保存接口，请先重启桌面应用。' });
      return;
    }

    void desktopApi
      .upsertLlmProvider(payload)
      .then((result) => {
        if (!result.ok) {
          desktopApi.logDiagnostic?.('error', 'settings save rejected', {
            error: result.error,
            payload
          });
          setSaveFeedback({
            type: 'error',
            text: `保存失败：${result.error ?? '未知错误'}`
          });
          return;
        }

        setCatalog(result.catalog);
        setCatalogSeed(result.catalog);
        setSelectedProviderId(result.providerId || result.catalog.activeProviderId || result.catalog.providers[0]?.id || '');
        onWorkspaceChange(result.workspace);
        desktopApi.logDiagnostic?.('info', 'settings save success', {
          configPath: result.configPath,
          providerId: result.providerId
        });
        setSaveFeedback({
          type: 'success',
          text: `已保存到 ${result.configPath}`
        });
        closeCreateDialog(false);
      })
      .catch((error) => {
        desktopApi.logDiagnostic?.('error', 'settings save exception', {
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          payload
        });
        setSaveFeedback({
          type: 'error',
          text: `保存失败：${error instanceof Error ? error.message : '未知错误'}`
        });
      });
  };

  const saveSelectedProviderApiKey = async () => {
    const desktopApi = window.desktopApi;

    if (!selectedProvider || !selectedProviderApiKey.trim()) {
      return;
    }

    if (!desktopApi?.upsertLlmProvider || !desktopApi?.refreshLlmProviderModels) {
      setProviderFeedback({ type: 'error', text: '当前环境未挂载 provider 保存或检查接口，请先重启桌面应用。' });
      return;
    }

    try {
      setProviderFeedback({ type: 'success', text: '正在检查连接…' });
      const checkResult = await desktopApi.refreshLlmProviderModels({
        providerId: selectedProvider.id,
        baseUrl: selectedProvider.baseUrl,
        auth: {
          type: 'bearer',
          secret: selectedProviderApiKey.trim(),
          headerName: 'Authorization'
        }
      });

      if (!checkResult.ok) {
        throw new Error(checkResult.error || 'API Key 检查失败');
      }

      const result = await desktopApi.upsertLlmProvider({
        providerId: selectedProvider.id,
        kind: selectedProvider.id,
        name: selectedProvider.name,
        defaultModel: selectedProvider.defaultModel,
        auth: { type: 'api_key', secret: selectedProviderApiKey.trim() }
      });

      if (!result.ok) {
        throw new Error(result.error || '保存 API Key 失败');
      }

      setCatalog(result.catalog);
      setCatalogSeed(result.catalog);
      setSelectedProviderId(result.providerId || selectedProvider.id);
      onWorkspaceChange(result.workspace);
      setSelectedProviderApiKey('');
      setProviderFeedback({ type: 'success', text: `连接检查通过，获取 ${checkResult.models?.length ?? 0} 个模型，API Key 已保存。` });
    } catch (error) {
      setProviderFeedback({ type: 'error', text: `API Key 保存失败：${error instanceof Error ? error.message : '未知错误'}` });
    }
  };

  const clearSelectedProviderApiKey = async () => {
    const desktopApi = window.desktopApi;

    if (!selectedProvider) {
      return;
    }

    if (!desktopApi?.clearLlmProviderApiKey) {
      setProviderFeedback({ type: 'error', text: '当前环境未挂载密钥清空接口，请先重启桌面应用。' });
      return;
    }

    try {
      const result = await desktopApi.clearLlmProviderApiKey({ providerId: selectedProvider.id });

      if (!result.ok) {
        throw new Error(result.error || '清空 API Key 失败');
      }

      setCatalog(result.catalog);
      setCatalogSeed(result.catalog);
      setSelectedProviderId(result.providerId || selectedProvider.id);
      if (result.workspace) {
        onWorkspaceChange(result.workspace);
      }
      setSelectedProviderApiKey('');
      setIsSecretVisible(false);
      setProviderFeedback({ type: 'success', text: 'API Key 已清空。' });
    } catch (error) {
      setProviderFeedback({ type: 'error', text: `API Key 清空失败：${error instanceof Error ? error.message : '未知错误'}` });
    }
  };

  const deleteSelectedProvider = async () => {
    const desktopApi = window.desktopApi;

    if (!selectedProvider || selectedProvider.kind !== 'openai-compatible') {
      return;
    }

    if (!desktopApi?.deleteLlmProvider) {
      setProviderFeedback({ type: 'error', text: '当前环境未挂载删除接入接口，请先重启桌面应用。' });
      return;
    }

    try {
      const result = await desktopApi.deleteLlmProvider({ providerId: selectedProvider.id });

      if (!result.ok) {
        throw new Error(result.error || '删除接入失败');
      }

      setCatalog(result.catalog);
      setCatalogSeed(result.catalog);
      setSelectedProviderId(result.catalog.activeProviderId || result.catalog.providers[0]?.id || '');
      if (result.workspace) {
        onWorkspaceChange(result.workspace);
      }
      setSelectedProviderApiKey('');
      setIsSecretVisible(false);
      setProviderFeedback({ type: 'success', text: '接入已删除。' });
    } catch (error) {
      setProviderFeedback({ type: 'error', text: `接入删除失败：${error instanceof Error ? error.message : '未知错误'}` });
    }
  };

  const fetchSelectedProviderModels = () => {
    const desktopApi = window.desktopApi;

    if (!selectedProvider) {
      return;
    }

    if (!desktopApi?.refreshLlmProviderModels) {
      desktopApi?.logDiagnostic?.('error', 'renderer missing refreshLlmProviderModels', {
        availableMethods: desktopApi ? Object.keys(desktopApi) : []
      });
      setProviderFeedback({ type: 'error', text: '当前环境未挂载模型刷新接口，请先重启桌面应用。' });
      return;
    }

    const checkSecret = selectedProviderApiKey.trim() || selectedProviderSavedSecret;

    setProviderFeedback({
      type: 'success',
      text: checkSecret || selectedProvider.baseUrl ? '正在检查连接…' : '正在获取模型列表…'
    });

    void desktopApi
      .refreshLlmProviderModels({
        providerId: selectedProvider.id,
        baseUrl: selectedProvider.baseUrl,
        auth: checkSecret
          ? {
              type: 'bearer',
              secret: checkSecret,
              headerName: 'Authorization'
            }
          : undefined
      })
      .then((result) => {
        if (!result.ok) {
          setProviderFeedback({
            type: 'error',
            text: `模型获取失败：${result.error ?? '未知错误'}`
          });
          desktopApi.logDiagnostic?.('error', 'selected provider model refresh rejected', {
            providerId: selectedProvider.id,
            error: result.error
          });
          return;
        }

        setCatalog(result.catalog);
        setCatalogSeed(result.catalog);
        setSelectedProviderId(result.providerId || result.catalog.activeProviderId || result.catalog.providers[0]?.id || '');
        if (result.workspace) {
          onWorkspaceChange(result.workspace);
        }
        setProviderFeedback({
          type: 'success',
          text: `获取 ${result.models.length} 个模型`
        });
        desktopApi.logDiagnostic?.('info', 'selected provider model refresh success', {
          providerId: result.providerId,
          requestUrl: result.requestUrl,
          count: result.models.length,
          configPath: result.configPath
        });
      })
      .catch((error) => {
        desktopApi.logDiagnostic?.('error', 'selected provider model refresh exception', {
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          providerId: selectedProvider.id
        });
        setProviderFeedback({
          type: 'error',
          text: `模型获取失败：${error instanceof Error ? error.message : '未知错误'}`
        });
      });
  };

  const openPiCodexLogin = async () => {
    const desktopApi = window.desktopApi;

    if (isCodexLoginInProgress) {
      return;
    }

    if (!desktopApi?.openPiCodexLogin) {
      setProviderFeedback({ type: 'error', text: '当前环境未挂载登录入口，请先重启桌面应用。' });
      return;
    }

    try {
      setIsCodexLoginInProgress(true);
      setProviderFeedback({ type: 'success', text: '已打开浏览器授权页，请完成 ChatGPT / Codex 登录授权。' });
      const result = await desktopApi.openPiCodexLogin();

      if (!result.ok) {
        setProviderFeedback({ type: 'error', text: `登录失败：${result.error ?? '未知错误'}` });
        return;
      }

      if (result.catalog) {
        setCatalog(result.catalog);
        setCatalogSeed(result.catalog);
        setSelectedProviderId(result.providerId || 'openai-codex');
      }

      if (result.workspace) {
        onWorkspaceChange(result.workspace);
      }

      setProviderFeedback({ type: 'success', text: 'ChatGPT / Codex 登录成功。' });
    } catch (error) {
      setProviderFeedback({ type: 'error', text: `登录失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      setIsCodexLoginInProgress(false);
    }
  };

  const resetSelectedProviderModels = () => {
    if (!selectedProvider) {
      return;
    }

    const seedProvider = catalogSeed.providers.find((provider) => provider.id === selectedProvider.id);

    if (seedProvider) {
      void persistSelectedProviderModels(seedProvider, '已恢复模型列表到上次保存的状态。');
      return;
    }

    void persistSelectedProviderModels(
      {
        ...selectedProvider,
        models: selectedProvider.models.slice(0, 1),
        defaultModel: selectedProvider.models[0]?.id ?? selectedProvider.defaultModel
      },
      '已重置模型列表。'
    );
  };

  const removeSelectedProviderModel = (modelId: string) => {
    if (!selectedProvider) {
      return;
    }

    const nextModels = selectedProvider.models.filter((model) => model.id !== modelId);

    if (nextModels.length === 0) {
      return;
    }

    void persistSelectedProviderModels(
      {
        ...selectedProvider,
        models: nextModels,
        defaultModel: selectedProvider.defaultModel === modelId ? nextModels[0].id : selectedProvider.defaultModel
      },
      '已删除模型。'
    );
  };

  const setDefaultSelectedProviderModel = (modelId: string) => {
    if (!selectedProvider) {
      return;
    }

    if (!selectedProvider.models.some((model) => model.id === modelId)) {
      return;
    }

    void persistSelectedProviderModels(
      {
        ...selectedProvider,
        models: selectedProvider.models,
        defaultModel: modelId
      },
      '已更新默认模型。'
    );
  };

  const selectedProviderKindLabel = selectedProvider
    ? providerKindLabels[selectedProvider.id] ?? providerKindLabels[selectedProvider.kind] ?? selectedProvider.kind
    : '';
  const selectedDefaultModel = selectedProvider?.models.find((model) => model.id === selectedProvider.defaultModel);
  const selectedProviderUsesPiDefaultOAuth = selectedProvider?.id === 'openai-codex';
  const selectedProviderSavedSecret = typeof selectedProvider?.auth?.secret === 'string' ? selectedProvider.auth.secret : '';
  const selectedProviderSecretValue =
    selectedProviderApiKey ||
    (isSecretVisible && selectedProviderSavedSecret ? selectedProviderSavedSecret : '');
  const selectedProviderSecretPlaceholder = selectedProvider?.auth?.configured
    ? selectedProviderSavedSecret
      ? '已保存 API Key，点击眼睛可查看明文'
      : '已保存 API Key；输入新 Key 可覆盖'
    : '输入 API Key 后点击保存';
  const selectedProviderSecretHelp = selectedProvider?.baseUrl
    ? '用于当前自定义接入的鉴权。'
    : '输入新的 API Key 可覆盖当前配置。';
  const isSelectedProviderRunnable = Boolean(
    selectedProvider &&
      (selectedProviderUsesPiDefaultOAuth ? selectedProvider.auth?.configured : selectedProvider.enabled || selectedProvider.auth?.configured)
  );
  const isSelectedProviderActive = Boolean(selectedProvider && selectedProvider.id === catalog.activeProviderId && isSelectedProviderRunnable);

  return (
    <>
      <div className="settings-provider-layout">
        <section className="settings-card settings-provider-list-card">
          <div className="settings-section-header">
            <div>
              <div className="settings-section-title">模型接入</div>
              <div className="settings-section-description">管理 provider、密钥和默认模型。</div>
            </div>

            <button
              className="toolbar-button"
              type="button"
              onClick={openCreateDialog}
            >
              <Plus size={14} />
              添加接入
            </button>
          </div>

          <div className="settings-provider-list">
            {catalog.providers.map((provider) => {
              const isActive = provider.id === selectedProvider?.id;
              const isRunnable = provider.id === 'openai-codex' ? provider.auth?.configured : provider.enabled || provider.auth?.configured;

              return (
                <button
                  key={provider.id}
                  className={`settings-provider-item ${isActive ? 'active' : ''}`}
                  type="button"
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <div className="settings-provider-item-leading">
                    <ProviderAvatar provider={provider} />
                  </div>

                  <div className="settings-provider-item-header settings-provider-item-header-compact">
                    <div className="settings-provider-item-name">{provider.name}</div>
                    <span className={`settings-provider-status-dot ${provider.auth?.configured ? 'is-online' : 'is-offline'}`} />
                  </div>

                  <div className="settings-provider-item-footer settings-provider-item-footer-compact">
                    <span className="settings-provider-muted">
                      {provider.defaultModel || provider.models[0]?.id || '未选择模型'}
                    </span>
                  </div>
                  <div className="settings-provider-item-flags">
                    {provider.id === catalog.activeProviderId && isRunnable ? <span className="settings-provider-chip is-enabled">当前</span> : null}
                    <span className={`settings-provider-chip ${provider.auth?.configured ? 'is-enabled' : 'is-disabled'}`}>
                      {provider.id === 'openai-codex'
                        ? provider.auth?.configured
                          ? '已登录'
                          : '未登录'
                        : provider.auth?.configured
                          ? '已配置密钥'
                          : '未配置密钥'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <div className="settings-provider-detail">
          {selectedProvider ? (
            <section className="settings-provider-console">
              <div className="settings-provider-hero-card">
                {selectedProvider.kind === 'openai-compatible' ? (
                  <button
                    className="settings-provider-delete-button"
                    type="button"
                    onClick={() => void deleteSelectedProvider()}
                    aria-label={`删除接入 ${selectedProvider.name}`}
                  >
                    <X size={18} />
                  </button>
                ) : null}
                <div className="settings-provider-hero-main">
                  <ProviderAvatar provider={selectedProvider} />
                  <div className="settings-provider-title-stack">
                    <div className="settings-provider-console-title">{selectedProvider.name}</div>
                    <div className="settings-provider-console-subtitle">
                      {selectedProviderKindLabel}
                    </div>
                  </div>
                </div>

                <div className="settings-provider-hero-actions">
                  {isSelectedProviderActive ? <span className="settings-provider-chip is-enabled">当前运行接入</span> : null}
                  <span className={`settings-provider-chip ${selectedProvider.auth?.configured ? 'is-enabled' : 'is-disabled'}`}>
                    {selectedProviderUsesPiDefaultOAuth
                      ? selectedProvider.auth?.configured
                        ? '已登录'
                        : '需要登录'
                      : selectedProvider.auth?.configured
                        ? '密钥已保存'
                        : '待配置密钥'}
                  </span>
                </div>

                <div className="settings-provider-summary-grid">
                  <div className="settings-provider-summary-item">
                    <span>默认模型</span>
                    <strong>{selectedDefaultModel?.name || selectedProvider.defaultModel || '未选择'}</strong>
                  </div>
                  <div className="settings-provider-summary-item">
                    <span>模型数量</span>
                    <strong>{selectedProvider.models.length}</strong>
                  </div>
                  <div className="settings-provider-summary-item">
                    <span>上下文</span>
                    <strong>{formatTokenWindow(selectedDefaultModel?.contextWindow ?? selectedDefaultModel?.maxOutputTokens)}</strong>
                  </div>
                </div>

                {selectedProvider.baseUrl ? (
                  <div className="settings-provider-endpoint">
                    <span>Base URL</span>
                    <code>{selectedProvider.baseUrl}</code>
                  </div>
                ) : null}
              </div>

              {selectedProviderUsesPiDefaultOAuth ? (
                <div className="settings-provider-secret-block settings-provider-card-section">
                  <div className="settings-provider-section-title-row">
                    <div>
                      <div className="settings-provider-console-label">ChatGPT / Codex 登录</div>
                      <div className="settings-form-help">这里不输入 API Key，请通过浏览器完成授权。</div>
                    </div>
                    <div className="inline-actions">
                      <button className="toolbar-button is-accent" type="button" onClick={() => void openPiCodexLogin()} disabled={isCodexLoginInProgress}>
                        <KeyRound size={14} />
                        {isCodexLoginInProgress ? '认证中…' : '浏览器授权'}
                      </button>
                      <button className="toolbar-button" type="button" onClick={fetchSelectedProviderModels}>
                        <RefreshCw size={14} />
                        刷新状态
                      </button>
                    </div>
                  </div>
                  <div className={`settings-oauth-status ${selectedProvider.auth?.configured ? 'is-ready' : 'is-waiting'}`}>
                    <KeyRound size={18} />
                    <div>
                      <div className="settings-oauth-status-title">
                        {selectedProvider.auth?.configured ? '已检测到 Codex 登录' : '还没有检测到 Codex 登录'}
                      </div>
                      <div className="settings-form-help">
                        点击“浏览器授权”后会打开授权页；成功后 OpenAgent 会自动刷新状态。
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="settings-provider-secret-block settings-provider-card-section">
                  <div className="settings-provider-section-title-row">
                    <div>
                      <div className="settings-provider-console-label">API 密钥</div>
                      <div className="settings-form-help">{selectedProviderSecretHelp}</div>
                    </div>
                    <button className="toolbar-button" type="button" onClick={fetchSelectedProviderModels}>
                      <RefreshCw size={14} />
                      检查
                    </button>
                  </div>
                  <div className="settings-provider-secret-row">
                    <div className="settings-provider-secret-input">
                      <KeyRound size={16} />
                      <input
                        value={selectedProviderSecretValue}
                        onChange={(event) => setSelectedProviderApiKey(event.target.value)}
                        type={isSecretVisible ? 'text' : 'password'}
                        placeholder={selectedProviderSecretPlaceholder}
                      />
                      <button
                        type="button"
                        className="settings-provider-icon-button"
                        aria-label={isSecretVisible ? '隐藏密钥' : '查看密钥'}
                        onClick={() => setIsSecretVisible((prev) => !prev)}
                      >
                        <Eye size={16} />
                      </button>
                    </div>
                    <button className="toolbar-button" type="button" onClick={() => void saveSelectedProviderApiKey()} disabled={!selectedProviderApiKey.trim()}>
                      保存
                    </button>
                    <button className="danger-button" type="button" onClick={() => void clearSelectedProviderApiKey()} disabled={!selectedProvider.auth?.configured && !selectedProviderApiKey.trim()}>
                      清空
                    </button>
                  </div>
                </div>
              )}

              <div className="settings-provider-model-block settings-provider-card-section">
                <div className="settings-provider-model-toolbar">
                  <div>
                    <div className="settings-provider-console-label">模型列表</div>
                    <div className="settings-form-help">默认模型会用于新对话和当前运行配置。</div>
                  </div>
                  <div className="inline-actions">
                    <button className="toolbar-button" type="button" onClick={resetSelectedProviderModels}>
                      <RotateCcw size={14} />
                      重置
                    </button>
                    <button className="toolbar-button" type="button" onClick={fetchSelectedProviderModels}>
                      <RefreshCw size={14} />
                      获取
                    </button>
                  </div>
                </div>

                {providerFeedback ? (
                  <div className={`settings-inline-feedback ${providerFeedback.type === 'success' ? 'success' : 'error'}`}>
                    {providerFeedback.text}
                  </div>
                ) : null}

                <div className="settings-provider-model-table">
                  {selectedProvider.models.length > 0 ? (
                    selectedProvider.models.map((model, index) => (
                      <div key={`${model.id}-${index}`} className={`settings-provider-model-row ${selectedProvider.defaultModel === model.id ? 'is-default' : ''}`}>
                        <div className="settings-provider-model-main">
                          <div className="settings-provider-model-name">
                            <span>{model.name}</span>
                            {selectedProvider.defaultModel === model.id ? <span className="settings-provider-default-badge">默认</span> : null}
                          </div>
                          <div className="settings-provider-model-meta-line">
                            <code>{model.id}</code>
                            <span className="settings-provider-model-token">{formatTokenWindow(model.contextWindow ?? model.maxOutputTokens)}</span>
                            <ModelCapabilityIcons provider={model} />
                          </div>
                        </div>

                        <div className="settings-provider-model-actions">
                          {selectedProvider.defaultModel !== model.id ? (
                            <button
                              className="settings-provider-inline-action"
                              type="button"
                              onClick={() => setDefaultSelectedProviderModel(model.id)}
                            >
                              设为默认
                            </button>
                          ) : null}
                          <button
                            className="settings-provider-icon-button"
                            type="button"
                            aria-label="编辑上下文窗口"
                            title="编辑上下文窗口"
                            onClick={() => openContextWindowDialog(model)}
                          >
                            <Settings size={18} />
                          </button>
                          <button
                            className="settings-provider-icon-button danger"
                            type="button"
                            aria-label="删除模型"
                            onClick={() => removeSelectedProviderModel(model.id)}
                            disabled={selectedProvider.models.length <= 1}
                          >
                            <MinusCircle size={18} />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="settings-provider-model-empty">
                      <div className="settings-provider-empty-title">还没有模型</div>
                      <div className="settings-provider-empty-copy">点击“添加接入”或“获取”来选择可用模型。</div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <section className="settings-provider-empty">
              <div className="settings-provider-empty-title">还没有模型配置</div>
              <div className="settings-provider-empty-copy">当前没有任何 provider 或模型数据。你可以点击左侧或这里的“添加”，开始接入真实模型。</div>
              <button
                className="primary-button"
                type="button"
                onClick={openCreateDialog}
              >
                <Plus size={14} />
                添加接入
              </button>
            </section>
          )}
        </div>
      </div>

      {isCreateOpen && (
        <div className="settings-modal-backdrop" role="presentation" onClick={() => closeCreateDialog()}>
          <div className="settings-modal panel panel-strong settings-add-provider-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <div className="settings-section-title">添加模型接入</div>
                <div className="settings-section-description">选择提供方、验证连接、选择模型，然后保存为当前运行配置。</div>
              </div>

              <button className="settings-modal-close" type="button" onClick={() => closeCreateDialog()} aria-label="关闭">
                <X size={14} />
              </button>
            </div>

            <div className="settings-add-steps" aria-label="添加模型接入步骤">
              {[
                ['type', '选择类型'],
                ['connect', '认证地址'],
                ['models', '模型列表'],
                ['review', '确认保存']
              ].map(([stepKey, stepLabel], index) => (
                <button
                  key={stepKey}
                  type="button"
                  className={`settings-add-step ${addStep === stepKey ? 'active' : ''}`}
                  onClick={() => setAddStep(stepKey as typeof addStep)}
                >
                  <span>{index + 1}</span>
                  {stepLabel}
                </button>
              ))}
            </div>

            {saveFeedback ? (
              <div className={`settings-inline-feedback ${saveFeedback.type === 'success' ? 'success' : 'error'}`}>{saveFeedback.text}</div>
            ) : null}

            <div className="settings-modal-body settings-add-provider-body">
              {addStep === 'type' ? (
                <div className="settings-add-type-grid">
                  {providerDefinitions.map((definition) => {
                    const isSelected = draft.kind === definition.kind;
                    return (
                      <button
                        key={definition.kind}
                        type="button"
                        className={`settings-add-type-card ${isSelected ? 'active' : ''}`}
                        onClick={() => selectDraftProviderKind(definition.kind)}
                      >
                        <span className="settings-add-type-icon"><Bot size={18} /></span>
                        <span className="settings-add-type-main">
                          <span className="settings-add-type-name">{definition.label}</span>
                          <span className="settings-add-type-copy">{definition.description || '模型接入'}</span>
                        </span>
                        {isSelected ? <Check size={16} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {addStep === 'connect' ? (
                <div className="settings-add-panel">
                  <div className="settings-add-panel-heading">
                    <div className="settings-section-title">{selectedDraftProviderDefinition.label}</div>
                    <div className="settings-form-help">先保存接入名称和认证信息。官方 provider 默认使用 AgentSession，自定义接口使用 OpenAI-compatible 模式。</div>
                  </div>

                  <div className="settings-add-form-grid">
                    <label className="settings-form-field">
                      <span className="settings-form-label">接入名称</span>
                      <input
                        className="settings-text-input"
                        value={draft.name}
                        onChange={(event) => updateDraft('name', event.target.value)}
                        placeholder={draft.kind === 'openai-compatible' ? '例如：阿里百炼 / 公司网关 / 本地模型' : selectedDraftProviderDefinition.label}
                      />
                    </label>

                    <label className="settings-form-field">
                      <span className="settings-form-label">认证方式</span>
                      <select
                        className="settings-text-input settings-select-input"
                        value={draft.authType}
                        onChange={(event) => applyDraftAuthType(event.target.value as LlmAuthType)}
                      >
                        {availableDraftAuthTypes.map((authType) => (
                          <option key={authType} value={authType}>
                            {authTypeLabels[authType] ?? authType}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="settings-form-field">
                    <span className="settings-form-label">Base URL</span>
                    <input
                      className="settings-text-input"
                      value={draft.baseUrl}
                      onChange={(event) => updateDraft('baseUrl', event.target.value)}
                      placeholder={selectedDraftProviderDefinition.defaultBaseUrl ?? 'https://your-gateway.example.com/v1'}
                    />
                    <div className="settings-form-help">官方 provider 可留空使用内置默认地址；自定义兼容接口必须填写。</div>
                  </label>

                  {draft.authType === 'api_key_header' ? (
                    <label className="settings-form-field">
                      <span className="settings-form-label">Header 名称</span>
                      <input
                        className="settings-text-input"
                        value={draft.headerName}
                        onChange={(event) => updateDraft('headerName', event.target.value)}
                        placeholder="例如：X-API-Key"
                      />
                    </label>
                  ) : null}

                  <label className="settings-form-field">
                    <span className="settings-form-label">{draftNeedsSecret ? 'API Key / Token' : '认证信息'}</span>
                    <input
                      className="settings-text-input"
                      type="password"
                      value={draft.apiKey}
                      onChange={(event) => updateDraft('apiKey', event.target.value)}
                      placeholder={draftNeedsSecret ? '请输入 API Key 或 Token' : '当前模式无需认证信息'}
                      disabled={!draftNeedsSecret}
                    />
                  </label>

                  <div className="settings-add-actions">
                    <button className="toolbar-button" type="button" onClick={() => setAddStep('type')}>上一步</button>
                    <button
                      className="toolbar-button"
                      type="button"
                      onClick={() => void discoverDraftModels('check')}
                      disabled={isCheckingDraft || (draftNeedsSecret && !draft.apiKey.trim()) || (draft.kind === 'openai-compatible' && !draft.baseUrl.trim())}
                    >
                      {isCheckingDraft ? '检查中…' : '检查连接'}
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => setAddStep('models')}
                      disabled={(draftNeedsSecret && !draft.apiKey.trim()) || (draft.kind === 'openai-compatible' && !draft.baseUrl.trim())}
                    >
                      下一步
                    </button>
                  </div>
                </div>
              ) : null}

              {addStep === 'models' ? (
                <div className="settings-add-panel">
                  <div className="settings-add-panel-heading">
                    <div className="settings-section-title">选择模型</div>
                    <div className="settings-form-help">可以先从接口发现模型；如果网关不支持 /models，也可以手动添加模型 ID。</div>
                  </div>

                  <div className="settings-add-discovery-bar">
                    <button
                      className="toolbar-button is-accent"
                      type="button"
                      onClick={() => void discoverDraftModels('discover')}
                      disabled={isDiscoveringDraft || (draftNeedsSecret && !draft.apiKey.trim()) || (draft.kind === 'openai-compatible' && !draft.baseUrl.trim())}
                    >
                      <RefreshCw size={14} />
                      {isDiscoveringDraft ? '获取中…' : '获取模型列表'}
                    </button>
                    <span className="settings-provider-muted">发现失败不影响保存，可以手动添加。</span>
                  </div>

                  {draft.discoveredModels.length > 0 ? (
                    <div className="settings-form-field">
                      <span className="settings-form-label">发现结果</span>
                      <div className="settings-add-model-grid">
                        {draft.discoveredModels.map((modelName, index) => {
                          const checked = draft.models.includes(modelName);
                          return (
                            <button
                              key={`${modelName}-${index}`}
                              type="button"
                              className={`settings-add-model-option ${checked ? 'active' : ''}`}
                              onClick={() => toggleDraftModel(modelName)}
                            >
                              <span>{modelName}</span>
                              {checked ? <Check size={15} /> : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  <div className="settings-form-field">
                    <span className="settings-form-label">手动添加模型 ID</span>
                    <div className="settings-model-input-row">
                      <input
                        ref={draftModelInputRef}
                        className="settings-text-input"
                        value={draft.modelInput}
                        onChange={(event) => updateDraft('modelInput', event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addDraftModel();
                          }
                        }}
                        placeholder="例如：qwen-plus / gpt-4.1-mini / deepseek-chat"
                      />
                      <button className="toolbar-button" type="button" onClick={addDraftModel}>添加</button>
                    </div>
                  </div>

                  <div className="settings-form-field">
                    <span className="settings-form-label">已选择模型</span>
                    {draft.models.length > 0 ? (
                      <div className="settings-add-selected-list">
                        {draft.models.map((modelName, index) => (
                          <div key={`${modelName}-${index}`} className="settings-add-selected-row">
                            <label>
                              <input
                                type="radio"
                                name="default-draft-model"
                                checked={(draft.defaultModel || draft.models[0]) === modelName}
                                onChange={() => updateDraft('defaultModel', modelName)}
                              />
                              <span>{modelName}</span>
                            </label>
                            <button type="button" className="settings-provider-icon-button danger" onClick={() => removeDraftModel(modelName)} aria-label={`删除 ${modelName}`}>
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="settings-provider-muted">请至少选择或添加一个模型。</span>
                    )}
                  </div>

                  <div className="settings-add-actions">
                    <button className="toolbar-button" type="button" onClick={() => setAddStep('connect')}>上一步</button>
                    <button className="primary-button" type="button" onClick={() => setAddStep('review')} disabled={draft.models.length === 0}>下一步</button>
                  </div>
                </div>
              ) : null}

              {addStep === 'review' ? (
                <div className="settings-add-panel">
                  <div className="settings-add-panel-heading">
                    <div className="settings-section-title">确认接入</div>
                    <div className="settings-form-help">保存后会写入 OpenAgent 的模型配置，并立即刷新当前运行模型。</div>
                  </div>

                  <div className="settings-add-review-card">
                    <div><span>接入名称</span><strong>{draft.name.trim() || selectedDraftProviderDefinition.label}</strong></div>
                    <div><span>提供方</span><strong>{selectedDraftProviderDefinition.label}</strong></div>
                    <div><span>Base URL</span><strong>{draft.baseUrl.trim() || '内置默认'}</strong></div>
                    <div><span>默认模型</span><strong>{draft.defaultModel || draft.models[0]}</strong></div>
                    <div><span>模型数量</span><strong>{draft.models.length}</strong></div>
                  </div>

                  <div className="settings-add-actions">
                    <button className="toolbar-button" type="button" onClick={() => setAddStep('models')}>上一步</button>
                    <button className="primary-button" type="button" onClick={createProvider} disabled={!canSubmitDraft}>保存并设为当前模型</button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {contextWindowDraft && (
        <div className="settings-modal-backdrop" role="presentation" onClick={() => closeContextWindowDialog()}>
          <div className="settings-modal panel panel-strong settings-model-context-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <div className="settings-section-title">设置上下文窗口</div>
                <div className="settings-form-help settings-model-context-help">
                  {contextWindowDraft.modelName} · 空白则恢复默认回退值（当前列表会显示 128K）。
                </div>
              </div>

              <button className="settings-modal-close" type="button" onClick={() => closeContextWindowDialog()} aria-label="关闭">
                <X size={14} />
              </button>
            </div>

            {contextWindowFeedback ? (
              <div className={`settings-inline-feedback ${contextWindowFeedback.type === 'success' ? 'success' : 'error'}`}>
                {contextWindowFeedback.text}
              </div>
            ) : null}

            <div className="settings-modal-body">
              <label className="settings-form-field">
                <span className="settings-form-label">上下文窗口</span>
                <input
                  className="settings-text-input"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={contextWindowDraft.contextWindow}
                  onChange={(event) =>
                    setContextWindowDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            contextWindow: event.target.value
                          }
                        : prev
                    )
                  }
                  placeholder="例如：128000"
                />
                <div className="settings-form-help">这里会写入模型的 contextWindow 字段，运行时和列表展示都会使用它。</div>
              </label>
            </div>

            <div className="settings-modal-footer">
              <button className="toolbar-button" type="button" onClick={() => closeContextWindowDialog()}>
                取消
              </button>
              <div className="inline-actions">
                <button
                  className="toolbar-button"
                  type="button"
                  onClick={() =>
                    setContextWindowDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            contextWindow: ''
                          }
                        : prev
                    )
                  }
                >
                  恢复默认
                </button>
                <button className="primary-button" type="button" onClick={saveContextWindow}>
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const emptyPluginRegistry: PluginRegistrySnapshot = {
  schemaVersion: 1,
  repoRoot: '',
  pluginsRoot: '',
  lastDiscoveredAt: null,
  lastLoadedAt: null,
  plugins: []
};

const defaultWechatPluginConfig: WechatOfficialAccountPluginConfig = {
  appId: '',
  appSecret: '',
  apiBase: 'https://api.weixin.qq.com'
};

const defaultWechatStyleConfig = {
  background: '#ffffff',
  text: '#333333',
  mutedText: '#666666',
  primary: '#000000',
  accent: '#f8f8f8',
  border: '#dfe2e5',
  quoteBg: '#f8f8f8',
  quoteBorder: '#dddddd',
  codeBg: '#f8f8f8',
  codeText: '#333333',
  tableHeaderBg: '#f5f5f5',
  p: {
    margin: '15px 0',
    fontSize: '15px',
    lineHeight: '1.6',
    color: '#333333',
    letterSpacing: '0.01em'
  },
  h1: {
    margin: '24px 0 16px',
    padding: '0',
    fontSize: '28px',
    lineHeight: '1.2',
    color: '#333333',
    borderLeft: 'none',
    background: 'transparent',
    borderRadius: '0',
    fontWeight: '700'
  },
  h2: {
    margin: '22px 0 12px',
    padding: '0',
    fontSize: '24px',
    lineHeight: '1.4',
    color: '#333333',
    borderLeft: 'none',
    borderBottom: '1px solid #cccccc',
    fontWeight: '700'
  },
  h3: {
    margin: '18px 0 10px',
    padding: '0',
    fontSize: '18px',
    lineHeight: '1.45',
    color: '#333333',
    borderLeft: 'none',
    fontWeight: '600'
  },
  h4: {
    margin: '16px 0 8px',
    fontSize: '16px',
    lineHeight: '1.5',
    color: '#333333',
    fontWeight: '600'
  },
  h5: {
    margin: '14px 0 8px',
    fontSize: '14px',
    lineHeight: '1.5',
    color: '#333333',
    fontWeight: '600'
  },
  h6: {
    margin: '12px 0 8px',
    fontSize: '14px',
    lineHeight: '1.5',
    color: '#666666',
    fontWeight: '600'
  },
  blockquote: {
    margin: '15px 0',
    padding: '0 15px',
    background: '#f8f8f8',
    borderLeft: '4px solid #dddddd',
    color: '#666666',
    borderRadius: '0'
  },
  quote: {
    margin: 0,
    lineHeight: '1.7',
    fontSize: '14px',
    color: '#666666'
  },
  list: {
    margin: '15px 0',
    paddingLeft: '2em',
    color: '#333333',
    lineHeight: '1.6'
  },
  listItem: {
    margin: '4px 0',
    fontSize: '15px',
    color: '#333333'
  },
  code: {
    color: '#333333',
    fontSize: '13px',
    lineHeight: '1.8',
    fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
    whiteSpace: 'pre'
  },
  codeInline: {
    background: '#f8f8f8',
    color: '#c7254e',
    padding: '0.1em 0.3em',
    borderRadius: '3px'
  },
  pre: {
    margin: '15px 0',
    borderRadius: '0',
    overflow: 'hidden',
    border: '1px solid #cccccc',
    background: '#f8f8f8'
  },
  preHeader: {
    padding: '8px 12px',
    fontSize: '12px',
    color: '#666666',
    borderBottom: '1px solid #cccccc',
    background: '#ffffff'
  },
  preCode: {
    margin: 0,
    padding: '12px 15px',
    overflowX: 'auto',
    background: '#f8f8f8'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    margin: '15px 0',
    fontSize: '14px',
    color: '#333333'
  },
  th: {
    padding: '8px',
    border: '1px solid #cccccc',
    background: '#f5f5f5',
    textAlign: 'left',
    fontWeight: '600'
  },
  td: {
    padding: '8px',
    border: '1px solid #cccccc',
    verticalAlign: 'top'
  },
  a: {
    color: '#4183c4',
    textDecoration: 'none',
    borderBottom: '1px solid #4183c4'
  },
  img: {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    margin: '12px auto',
    borderRadius: '0'
  }
};

function stripJsonComments(source: string) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      result += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function stripTrailingCommas(source: string) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ',') {
      let nextIndex = i + 1;
      while (nextIndex < source.length && /\s/.test(source[nextIndex] ?? '')) {
        nextIndex += 1;
      }

      if (source[nextIndex] === '}' || source[nextIndex] === ']') {
        continue;
      }
    }

    result += char;
  }

  return result;
}

function parseStyleJson(source: string) {
  const cleaned = stripTrailingCommas(stripJsonComments(source));
  const parsed = JSON.parse(cleaned);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('风格 JSON 必须是一个对象。');
  }

  return parsed as Record<string, unknown>;
}

function PluginAvatar() {
  return (
    <span className="settings-provider-avatar is-generic">
      <Puzzle size={16} />
    </span>
  );
}

type KnowledgeFeedback = { type: 'success' | 'error'; text: string } | null;

function KnowledgePanel() {
  const [health, setHealth] = useState<KnowledgeHealthResult[]>([]);
  const [browseSnapshot, setBrowseSnapshot] = useState<KnowledgeBrowseSnapshot | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [selectedArticleId, setSelectedArticleId] = useState('');
  const [articlePreview, setArticlePreview] = useState<KnowledgeArticleReadResult | null>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState(false);
  const [isLoadingBrowse, setIsLoadingBrowse] = useState(false);
  const [query, setQuery] = useState('OpenAgent runtime');
  const [queryResults, setQueryResults] = useState<KnowledgeResult[]>([]);
  const [isQuerying, setIsQuerying] = useState(false);
  const [ingestTitle, setIngestTitle] = useState('');
  const [ingestContent, setIngestContent] = useState('');
  const [lintResult, setLintResult] = useState<KnowledgeLintResult | null>(null);
  const [graphResult, setGraphResult] = useState<KnowledgeGraphResult | null>(null);
  const [isMaintaining, setIsMaintaining] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [feedback, setFeedback] = useState<KnowledgeFeedback>(null);

  const loadBrowse = async () => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.browseKnowledge) return;

    try {
      setIsLoadingBrowse(true);
      const result = await desktopApi.browseKnowledge();
      setBrowseSnapshot(result);
      setSelectedSourceId((current) => current || result.sources[0]?.id || '');
      setSelectedArticleId((current) => current || result.articles[0]?.id || '');
    } catch (error) {
      setFeedback({ type: 'error', text: `知识库索引读取失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      setIsLoadingBrowse(false);
    }
  };

  const loadHealth = async () => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.getKnowledgeHealth) {
      setFeedback({ type: 'error', text: '当前环境未挂载知识库状态接口，请重启桌面应用。' });
      return;
    }

    try {
      setIsLoadingHealth(true);
      const result = await desktopApi.getKnowledgeHealth({ scope: 'system' });
      setHealth(result);
      setFeedback(null);
      await loadBrowse();
    } catch (error) {
      setFeedback({ type: 'error', text: `知识库状态读取失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      setIsLoadingHealth(false);
    }
  };

  useEffect(() => {
    void loadHealth();
  }, []);

  const submitQuery = async () => {
    const desktopApi = window.desktopApi;
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setFeedback({ type: 'error', text: '请输入要查询的问题。' });
      return;
    }

    if (!desktopApi?.queryKnowledge) {
      setFeedback({ type: 'error', text: '当前环境未挂载 knowledge base 查询接口，请重启桌面应用。' });
      return;
    }

    try {
      setIsQuerying(true);
      const results = await desktopApi.queryKnowledge({ query: normalizedQuery, limit: 8 });
      setQueryResults(results);
      setFeedback({ type: 'success', text: results.length > 0 ? `找到 ${results.length} 条 knowledge base 结果。` : '没有找到匹配结果。' });
    } catch (error) {
      setFeedback({ type: 'error', text: `查询失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      setIsQuerying(false);
    }
  };

  const submitIngest = async () => {
    const desktopApi = window.desktopApi;
    const title = ingestTitle.trim();
    const content = ingestContent.trim();
    if (!title || !content) {
      setFeedback({ type: 'error', text: '请输入标题和内容。' });
      return;
    }

    if (!desktopApi?.ingestKnowledge) {
      setFeedback({ type: 'error', text: '当前环境未挂载 knowledge base 摄取接口，请重启桌面应用。' });
      return;
    }

    try {
      const result = await desktopApi.ingestKnowledge({
        title,
        content,
        tags: ['openagent']
      });
      if (!result.ok) {
        setFeedback({ type: 'error', text: result.message || '摄取失败。' });
        return;
      }
      setFeedback({ type: 'success', text: `${result.message}${result.path ? ` 写入：${result.path}` : ''}` });
      setIngestTitle('');
      setIngestContent('');
      await loadHealth();
      setQuery(title);
      setQueryResults((await desktopApi.queryKnowledge?.({ query: title, limit: 5 })) ?? []);
    } catch (error) {
      setFeedback({ type: 'error', text: `摄取失败：${error instanceof Error ? error.message : '未知错误'}` });
    }
  };

  const importFiles = async () => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.chooseAndIngestKnowledgeFiles) {
      setFeedback({ type: 'error', text: '当前环境未挂载文件导入接口，请重启桌面应用。' });
      return;
    }

    try {
      const result = await desktopApi.chooseAndIngestKnowledgeFiles();
      if (result.cancelled) return;
      const okCount = result.results.filter((item) => item.ok).length;
      const failCount = result.results.length - okCount;
      setFeedback({
        type: result.ok ? 'success' : 'error',
        text: `文件导入完成：成功 ${okCount} 个，失败 ${failCount} 个。`
      });
      await loadHealth();
      if (result.results[0]?.id) {
        setQuery(result.results[0].id);
        setQueryResults((await desktopApi.queryKnowledge?.({ query: result.results[0].id, limit: 5 })) ?? []);
      }
    } catch (error) {
      setFeedback({ type: 'error', text: `文件导入失败：${error instanceof Error ? error.message : '未知错误'}` });
    }
  };

  const runCompile = async () => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.compileKnowledge) {
      setFeedback({ type: 'error', text: '当前环境未挂载 knowledge base compile 接口，请重启桌面应用。' });
      return;
    }

    try {
      setIsCompiling(true);
      const result = await desktopApi.compileKnowledge({ limit: 20, tier: 3 });
      setFeedback({ type: result.ok ? 'success' : 'error', text: result.message });
      await loadHealth();
    } catch (error) {
      setFeedback({ type: 'error', text: `编译失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      setIsCompiling(false);
    }
  };

  const runLint = async () => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.lintKnowledge) {
      setFeedback({ type: 'error', text: '当前环境未挂载 knowledge base lint 接口，请重启桌面应用。' });
      return;
    }

    try {
      setIsMaintaining(true);
      const result = await desktopApi.lintKnowledge();
      setLintResult(result);
      setFeedback({ type: result.ok ? 'success' : 'error', text: result.message });
      await loadHealth();
    } catch (error) {
      setFeedback({ type: 'error', text: `Lint 失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      setIsMaintaining(false);
    }
  };

  const buildGraph = async () => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.buildKnowledgeGraph) {
      setFeedback({ type: 'error', text: '当前环境未挂载 knowledge base graph 接口，请重启桌面应用。' });
      return;
    }

    try {
      setIsMaintaining(true);
      const result = await desktopApi.buildKnowledgeGraph();
      setGraphResult(result);
      setFeedback({ type: result.ok ? 'success' : 'error', text: result.message });
      await loadHealth();
    } catch (error) {
      setFeedback({ type: 'error', text: `Graph 构建失败：${error instanceof Error ? error.message : '未知错误'}` });
    } finally {
      setIsMaintaining(false);
    }
  };

  const openArticle = async (articleId: string) => {
    const desktopApi = window.desktopApi;
    setSelectedArticleId(articleId);
    if (!desktopApi?.readKnowledgeArticle) return;

    try {
      const result = await desktopApi.readKnowledgeArticle({ articleId });
      setArticlePreview(result);
      if (!result.ok) setFeedback({ type: 'error', text: result.message || '文章读取失败。' });
    } catch (error) {
      setFeedback({ type: 'error', text: `文章读取失败：${error instanceof Error ? error.message : '未知错误'}` });
    }
  };

  const knowledgeHealth = health.find((item) => item.source === 'openagent-system-compiler');
  const knowledgeData = asRecord(knowledgeHealth?.data);
  const selectedSource = browseSnapshot?.sources.find((item) => item.id === selectedSourceId) ?? browseSnapshot?.sources[0] ?? null;
  const selectedQuality = selectedSource?.quality ?? browseSnapshot?.quality.find((item) => item.sourceId === selectedSource?.id) ?? null;
  const visibleArticles = selectedSource
    ? browseSnapshot?.articles.filter((article) => article.sourceIds.includes(selectedSource.id)) ?? []
    : browseSnapshot?.articles ?? [];
  const graphNodes = Array.isArray(graphResult?.data?.nodes) ? graphResult.data.nodes : [];
  const graphEdges = Array.isArray(graphResult?.data?.edges) ? graphResult.data.edges : [];

  return (
    <div className="settings-knowledge-layout">
      <section className="settings-card settings-knowledge-card">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Knowledge Layer</div>
            <div className="settings-section-description">内置 Knowledge Compiler：初始化、摄取、批量编译、质量评估和 provenance 浏览。</div>
          </div>
          <button className="toolbar-button" type="button" onClick={() => void loadHealth()} disabled={isLoadingHealth || isLoadingBrowse}>
            <RefreshCw size={14} />
            {isLoadingHealth || isLoadingBrowse ? '刷新中…' : '刷新状态'}
          </button>
        </div>

        {feedback ? <div className={`settings-inline-feedback ${feedback.type === 'success' ? 'success' : 'error'}`}>{feedback.text}</div> : null}

        <div className="settings-knowledge-status-grid single">
          <div className="settings-provider-card-section">
            <div className="settings-provider-section-title-row">
              <div>
                <div className="settings-provider-console-label">Knowledge Base</div>
                <div className="settings-form-help">sage-wiki 风格的内置 Knowledge Compiler。</div>
              </div>
              <span className={`settings-provider-chip ${knowledgeHealth?.ok ? 'is-enabled' : 'is-disabled'}`}>
                {knowledgeHealth?.ok ? '就绪' : '未初始化'}
              </span>
            </div>
            <div className="settings-info-grid">
              <div className="settings-info-row">
                <div className="settings-info-label">Memory Root</div>
                <div className="settings-info-value">{browseSnapshot?.root || String(knowledgeData.root ?? '~/.openagent/system/wiki')}</div>
              </div>
              <div className="settings-info-row">
                <div className="settings-info-label">Sources</div>
                <div className="settings-info-value">{String(browseSnapshot?.sources.length ?? knowledgeData.sources ?? 0)}</div>
              </div>
              <div className="settings-info-row">
                <div className="settings-info-label">Articles</div>
                <div className="settings-info-value">{String(browseSnapshot?.articles.length ?? knowledgeData.articles ?? 0)}</div>
              </div>
              <div className="settings-info-row">
                <div className="settings-info-label">Pending</div>
                <div className="settings-info-value">{String(browseSnapshot?.pending.length ?? knowledgeData.pending ?? 0)}</div>
              </div>
            </div>
            <div className="settings-form-help">{knowledgeHealth?.message ?? '点击刷新状态初始化 knowledge base。'}</div>
            <div className="inline-actions">
              <button className="toolbar-button" type="button" onClick={() => void runCompile()} disabled={isCompiling}>
                {isCompiling ? '编译中…' : '编译 Pending'}
              </button>
              <button className="toolbar-button" type="button" onClick={() => void runLint()} disabled={isMaintaining}>
                {isMaintaining ? '处理中…' : 'Lint'}
              </button>
              <button className="toolbar-button" type="button" onClick={() => void buildGraph()} disabled={isMaintaining}>
                构建 Graph
              </button>
            </div>
            {lintResult ? <div className="settings-form-help">Lint 报告：<code>{lintResult.reportPath}</code></div> : null}
            {graphResult ? <div className="settings-form-help">Graph：<code>{graphResult.graphJsonPath}</code> · <code>{graphResult.graphHtmlPath}</code></div> : null}
            {graphNodes.length > 0 ? (
              <div className="settings-knowledge-graph-preview">
                <div className="settings-provider-console-label">Graph Preview</div>
                <div className="settings-model-chip-list">
                  {graphNodes.slice(0, 12).map((node) => (
                    <span key={node.id} className="settings-model-chip" title={node.path}>
                      <span className="settings-model-chip-label">{node.label}</span>
                    </span>
                  ))}
                </div>
                <div className="settings-knowledge-edge-list">
                  {graphEdges.slice(0, 12).map((edge, index) => (
                    <div key={`${edge.from}-${edge.to}-${index}`} className="settings-knowledge-edge">{edge.from} → {edge.to}</div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="settings-card settings-knowledge-card">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Sources / Articles / Quality</div>
            <div className="settings-section-description">查看导入源、编译文章、质量分和 provenance 路径。</div>
          </div>
          <button className="toolbar-button" type="button" onClick={() => void loadBrowse()} disabled={isLoadingBrowse}>
            <RefreshCw size={14} />
            {isLoadingBrowse ? '刷新中…' : '刷新索引'}
          </button>
        </div>

        <div className="settings-knowledge-browser-grid">
          <div className="settings-knowledge-browser-panel">
            <div className="settings-provider-console-label">Sources</div>
            <div className="settings-knowledge-source-list">
              {browseSnapshot?.sources.length ? browseSnapshot.sources.map((source) => (
                <button key={source.id} className={`settings-knowledge-source-item ${source.id === selectedSource?.id ? 'active' : ''}`} type="button" onClick={() => setSelectedSourceId(source.id)}>
                  <span className="settings-knowledge-source-title">{source.title}</span>
                  <span className="settings-provider-model-meta-line">
                    {source.kind} · {source.status ?? 'unknown'} · score {source.quality?.score ?? '-'}
                  </span>
                </button>
              )) : (
                <div className="settings-provider-model-empty">
                  <div className="settings-provider-empty-title">暂无 Sources</div>
                  <div className="settings-provider-empty-copy">导入文件或写入文本后会出现在这里。</div>
                </div>
              )}
            </div>
          </div>

          <div className="settings-knowledge-browser-panel">
            <div className="settings-provider-console-label">Quality</div>
            {selectedSource ? (
              <div className="settings-knowledge-quality-card">
                <div className="settings-provider-model-name">
                  <span>{selectedSource.title}</span>
                  <span className="settings-provider-default-badge">{selectedSource.status ?? 'unknown'}</span>
                </div>
                <div className="settings-provider-model-meta-line"><code>{selectedSource.rawTextPath ?? selectedSource.id}</code></div>
                <div className="settings-info-grid">
                  <div className="settings-info-row"><div className="settings-info-label">Score</div><div className="settings-info-value">{selectedQuality?.score ?? '-'}</div></div>
                  <div className="settings-info-row"><div className="settings-info-label">Grade</div><div className="settings-info-value">{selectedQuality?.grade ?? '-'}</div></div>
                  <div className="settings-info-row"><div className="settings-info-label">Articles</div><div className="settings-info-value">{String(selectedSource.articleIds?.length ?? 0)}</div></div>
                </div>
                {selectedQuality?.issues.length ? (
                  <ul className="settings-knowledge-issue-list">
                    {selectedQuality.issues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                ) : <div className="settings-form-help">暂无质量问题。</div>}
              </div>
            ) : <div className="settings-form-help">选择左侧 source 查看质量报告。</div>}
          </div>

          <div className="settings-knowledge-browser-panel">
            <div className="settings-provider-console-label">Articles</div>
            <div className="settings-knowledge-source-list">
              {visibleArticles.length ? visibleArticles.map((article) => (
                <button key={article.id} className={`settings-knowledge-source-item ${article.id === selectedArticleId ? 'active' : ''}`} type="button" onClick={() => void openArticle(article.id)}>
                  <span className="settings-knowledge-source-title">{article.title}</span>
                  <span className="settings-provider-model-meta-line"><code>{article.path}</code></span>
                </button>
              )) : <div className="settings-form-help">当前 source 暂无文章，点击“编译 Pending”。</div>}
            </div>
          </div>
        </div>

        <div className="settings-knowledge-article-preview">
          <div className="settings-provider-console-label">Article Preview</div>
          {articlePreview?.ok ? (
            <>
              <div className="settings-provider-model-name"><span>{articlePreview.title}</span></div>
              <div className="settings-provider-model-meta-line"><code>{articlePreview.path}</code></div>
              <pre className="settings-knowledge-pre">{articlePreview.content}</pre>
            </>
          ) : <div className="settings-form-help">选择一篇 article 查看 Markdown 内容与 provenance frontmatter。</div>}
        </div>
      </section>

      <section className="settings-card settings-knowledge-card">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">查询 Knowledge Base</div>
            <div className="settings-section-description">用于验证 Knowledge Compiler 的 summaries、articles、chunks 检索效果。</div>
          </div>
        </div>
        <div className="settings-knowledge-form">
          <div className="settings-model-input-row">
            <input className="settings-text-input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submitQuery(); } }} placeholder="例如：OpenAgent runtime 如何接入知识库？" />
            <button className="primary-button" type="button" onClick={() => void submitQuery()} disabled={isQuerying}>{isQuerying ? '查询中…' : '查询'}</button>
          </div>

          <div className="settings-provider-model-table">
            {queryResults.length > 0 ? queryResults.map((result) => (
              <div key={result.id} className="settings-provider-model-row settings-knowledge-result-row">
                <div className="settings-provider-model-main">
                  <div className="settings-provider-model-name"><span>{result.title}</span><span className="settings-provider-default-badge">{result.source}</span></div>
                  <div className="settings-provider-model-meta-line">
                    {result.path ? <code>{result.path}</code> : null}
                    {typeof result.score === 'number' ? <span className="settings-provider-model-token">score {result.score}</span> : null}
                  </div>
                  <div className="settings-knowledge-result-content">{result.content}</div>
                </div>
              </div>
            )) : (
              <div className="settings-provider-model-empty">
                <div className="settings-provider-empty-title">还没有查询结果</div>
                <div className="settings-provider-empty-copy">先摄取一段系统知识，或查询已编译的知识文章。</div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="settings-card settings-knowledge-card">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">摄取到 Knowledge Base</div>
            <div className="settings-section-description">把明确提供的系统/项目知识写入 raw，并编译生成 summaries、concepts、wiki articles、graph 和 index；文件原件会归档到 media 或 files。</div>
          </div>
        </div>
        <div className="settings-knowledge-form">
          <label className="settings-form-field">
            <span className="settings-form-label">标题</span>
            <input className="settings-text-input" value={ingestTitle} onChange={(event) => setIngestTitle(event.target.value)} placeholder="例如：OpenAgent Knowledge Layer 设计" />
          </label>
          <label className="settings-form-field">
            <span className="settings-form-label">内容</span>
            <textarea className="settings-textarea settings-knowledge-textarea" value={ingestContent} onChange={(event) => setIngestContent(event.target.value)} placeholder="粘贴 Markdown 或纯文本内容。" rows={10} />
          </label>
          <div className="settings-model-input-row">
            <button className="primary-button" type="button" onClick={() => void submitIngest()}>写入 Knowledge Base</button>
            <button className="toolbar-button" type="button" onClick={() => void importFiles()}><FolderOpen size={14} />导入文件</button>
            <span className="settings-provider-muted">支持文本、图片、音视频、doc/docx、PDF、xlsx、pptx 等本地文件导入。</span>
          </div>
        </div>
      </section>
    </div>
  );
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function PluginPanel() {
  const [registry, setRegistry] = useState<PluginRegistrySnapshot>(emptyPluginRegistry);
  const [selectedPluginName, setSelectedPluginName] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selectedPluginsRoot, setSelectedPluginsRoot] = useState('');
  const [wechatConfig, setWechatConfig] = useState<WechatOfficialAccountPluginConfig>(defaultWechatPluginConfig);
  const [wechatStyleJson, setWechatStyleJson] = useState<string>(JSON.stringify(defaultWechatStyleConfig, null, 2));
  const [wechatConfigFeedback, setWechatConfigFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [wechatConfigLoadedAt, setWechatConfigLoadedAt] = useState<string | null>(null);

  const selectedPlugin = useMemo(() => {
    return registry.plugins.find((plugin) => plugin.name === selectedPluginName) ?? registry.plugins[0] ?? null;
  }, [registry.plugins, selectedPluginName]);

  useEffect(() => {
    const desktopApi = window.desktopApi;

    if (selectedPlugin?.name !== 'wechat-official-account') {
      setWechatConfig(defaultWechatPluginConfig);
      setWechatStyleJson(JSON.stringify(defaultWechatStyleConfig, null, 2));
      setWechatConfigLoadedAt(null);
      setWechatConfigFeedback(null);
      return;
    }

    if (!desktopApi?.getPluginConfig) {
      setWechatConfigFeedback({ type: 'error', text: '当前环境未挂载插件配置接口，请先重启桌面应用。' });
      return;
    }

    let cancelled = false;

    void desktopApi
      .getPluginConfig({ pluginName: selectedPlugin.name })
      .then((result) => {
        if (cancelled) return;

        if (!result.ok || !result.config) {
          setWechatConfig(defaultWechatPluginConfig);
          setWechatConfigLoadedAt(null);
          setWechatConfigFeedback({
            type: 'error',
            text: `插件配置加载失败：${result.error ?? '未知错误'}`
          });
          return;
        }

        setWechatConfig(result.config.wechat ?? defaultWechatPluginConfig);
        setWechatStyleJson(JSON.stringify(result.config.wechat?.style ?? defaultWechatStyleConfig, null, 2));
        setWechatConfigLoadedAt(result.config.updatedAt);
        setWechatConfigFeedback(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setWechatConfig(defaultWechatPluginConfig);
        setWechatStyleJson(JSON.stringify(defaultWechatStyleConfig, null, 2));
        setWechatConfigLoadedAt(null);
        setWechatConfigFeedback({
          type: 'error',
          text: `插件配置加载失败：${error instanceof Error ? error.message : '未知错误'}`
        });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPlugin?.name]);

  const applyRegistry = (nextRegistry: PluginRegistrySnapshot) => {
    setRegistry(nextRegistry);
    setSelectedPluginName((prev) => {
      if (prev && nextRegistry.plugins.some((plugin) => plugin.name === prev)) {
        return prev;
      }
      return nextRegistry.plugins[0]?.name ?? '';
    });
  };

  const refreshRegistry = async (mode: 'discover' | 'load' | 'read' = 'read') => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.getPluginRegistry) {
      setFeedback({ type: 'error', text: '当前环境未挂载插件注册接口，请先重启桌面应用。' });
      return;
    }

    try {
      if (mode === 'discover' && desktopApi.discoverPlugins) {
        if (!selectedPluginsRoot) {
          setFeedback({ type: 'error', text: '请先选择插件目录。' });
          return;
        }

        const result = desktopApi.discoverPluginsInDirectory
          ? await desktopApi.discoverPluginsInDirectory({ pluginsRoot: selectedPluginsRoot })
          : await desktopApi.discoverPlugins();
        if (!result.ok) {
          setFeedback({ type: 'error', text: `插件发现失败：${result.error ?? '未知错误'}` });
          applyRegistry(result.registry);
          return;
        }
        applyRegistry(result.registry);
        setFeedback({
          type: 'success',
          text: `已在 ${selectedPluginsRoot} 发现 ${result.discoveredCount ?? result.registry.plugins.length} 个插件`
        });
        return;
      }

      if (mode === 'load' && desktopApi.loadPlugins) {
        const result = await desktopApi.loadPlugins();
        if (!result.ok) {
          setFeedback({ type: 'error', text: `插件加载失败：${result.error ?? '未知错误'}` });
          applyRegistry(result.registry);
          return;
        }
        applyRegistry(result.registry);
        setFeedback({
          type: 'success',
          text: `已加载 ${result.loadedCount ?? result.registry.plugins.filter((plugin) => plugin.status === 'loaded').length} 个插件`
        });
        return;
      }

      const nextRegistry = await desktopApi.getPluginRegistry();
      applyRegistry(nextRegistry ?? emptyPluginRegistry);
    } catch (error) {
      setFeedback({
        type: 'error',
        text: `插件操作失败：${error instanceof Error ? error.message : '未知错误'}`
      });
    }
  };

  const handleChoosePluginsRoot = async () => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.choosePluginDirectory) {
      setFeedback({ type: 'error', text: '当前环境未挂载目录选择接口，请先重启桌面应用。' });
      return;
    }

    try {
      const result = await desktopApi.choosePluginDirectory();
      if (!result.ok) {
        if (!result.canceled) {
          setFeedback({ type: 'error', text: `选择目录失败：${result.error ?? '未知错误'}` });
        }
        return;
      }

      const directoryPath = result.directoryPath?.trim() || '';
      if (!directoryPath) {
        setFeedback({ type: 'error', text: '未读取到有效的插件目录路径。' });
        return;
      }

      setSelectedPluginsRoot(directoryPath);
      setFeedback({ type: 'success', text: `已选择目录：${directoryPath}。点击“发现”可开始扫描。` });
    } catch (error) {
      setFeedback({
        type: 'error',
        text: `选择目录失败：${error instanceof Error ? error.message : '未知错误'}`
      });
    }
  };

  useEffect(() => {
    void refreshRegistry('read');
  }, []);

  const togglePluginEnabled = async (pluginName: string, enabled: boolean) => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.setPluginEnabled) {
      setFeedback({ type: 'error', text: '当前环境未挂载插件启用接口，请先重启桌面应用。' });
      return;
    }

    try {
      const result = await desktopApi.setPluginEnabled({ pluginName, enabled });
      if (!result.ok) {
        setFeedback({ type: 'error', text: `更新插件状态失败：${result.error ?? '未知错误'}` });
        applyRegistry(result.registry);
        return;
      }
      applyRegistry(result.registry);

      if (enabled) {
        const loadResult = await desktopApi.loadPlugins({ pluginNames: [pluginName] });
        if (!loadResult.ok) {
          applyRegistry(loadResult.registry);
          setFeedback({
            type: 'error',
            text: `已启用 ${pluginName}，但自动加载失败：${loadResult.error ?? '未知错误'}`
          });
          return;
        }

        applyRegistry(loadResult.registry);
        setFeedback({ type: 'success', text: `已启用并自动加载 ${pluginName}` });
        return;
      }

      setFeedback({
        type: 'success',
        text: enabled ? `已启用 ${pluginName}` : `已禁用 ${pluginName}`
      });
    } catch (error) {
      setFeedback({
        type: 'error',
        text: `更新插件状态失败：${error instanceof Error ? error.message : '未知错误'}`
      });
    }
  };

  const loadPlugin = async (pluginName: string) => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.loadPlugins) {
      setFeedback({ type: 'error', text: '当前环境未挂载插件加载接口，请先重启桌面应用。' });
      return;
    }

    try {
      const result = await desktopApi.loadPlugins({ pluginNames: [pluginName] });
      if (!result.ok) {
        setFeedback({ type: 'error', text: `加载插件失败：${result.error ?? '未知错误'}` });
        applyRegistry(result.registry);
        return;
      }
      applyRegistry(result.registry);
      setFeedback({ type: 'success', text: `已加载插件 ${pluginName}` });
    } catch (error) {
      setFeedback({
        type: 'error',
        text: `加载插件失败：${error instanceof Error ? error.message : '未知错误'}`
      });
    }
  };

  const saveWechatPluginConfig = async () => {
    const desktopApi = window.desktopApi;

    if (selectedPlugin?.name !== 'wechat-official-account') {
      return;
    }

    if (!desktopApi?.savePluginConfig) {
      setWechatConfigFeedback({ type: 'error', text: '当前环境未挂载插件配置保存接口，请先重启桌面应用。' });
      return;
    }

    try {
      let parsedStyle: Record<string, unknown> | undefined;
      const trimmedStyleJson = wechatStyleJson.trim();
      if (trimmedStyleJson) {
        parsedStyle = parseStyleJson(trimmedStyleJson);
      }

      const result = await desktopApi.savePluginConfig({
        pluginName: selectedPlugin.name,
        config: {
          schemaVersion: 1,
          pluginName: selectedPlugin.name,
          updatedAt: wechatConfigLoadedAt,
          wechat: {
            appId: wechatConfig.appId.trim(),
            appSecret: wechatConfig.appSecret.trim(),
            apiBase: wechatConfig.apiBase.trim() || defaultWechatPluginConfig.apiBase,
            style: parsedStyle
          }
        }
      });

      if (!result.ok || !result.config) {
        setWechatConfigFeedback({
          type: 'error',
          text: `保存插件配置失败：${result.error ?? '未知错误'}`
        });
        return;
      }

      setWechatConfig(result.config.wechat ?? defaultWechatPluginConfig);
      setWechatConfigLoadedAt(result.config.updatedAt);
      setWechatConfigFeedback({
        type: 'success',
        text: `已保存微信配置到本地。`
      });
    } catch (error) {
      setWechatConfigFeedback({
        type: 'error',
        text: `保存插件配置失败：${error instanceof Error ? error.message : '未知错误'}`
      });
    }
  };

  const selectedManifest = selectedPlugin?.manifest;
  const selectedSkillCount = selectedPlugin?.skills.length ?? 0;
  const selectedMcpCount = selectedPlugin?.mcpServers.length ?? 0;

  return (
    <div className="settings-provider-layout">
      <section className="settings-card settings-provider-list-card">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">插件发现</div>
            <div className="settings-section-description">点击图标选择插件目录，然后扫描其中的 <code>.openagent-plugin/plugin.json</code>。</div>
          </div>

          <div className="inline-actions">
            <button
              className="toolbar-button settings-icon-button"
              type="button"
              onClick={() => void handleChoosePluginsRoot()}
              title="选择插件目录"
              aria-label="选择插件目录"
            >
              <FolderOpen size={14} />
            </button>
            <button
              className="toolbar-button settings-icon-button"
              type="button"
              onClick={() => void refreshRegistry('discover')}
              title="发现插件"
              aria-label="发现插件"
              disabled={!selectedPluginsRoot}
            >
              <RefreshCw size={14} />
            </button>
            <button
              className="toolbar-button settings-icon-button is-accent"
              type="button"
              onClick={() => void refreshRegistry('load')}
              title="加载启用插件"
              aria-label="加载启用插件"
            >
              <WandSparkles size={14} />
            </button>
          </div>
        </div>

        {feedback ? <div className={`settings-inline-feedback ${feedback.type === 'success' ? 'success' : 'error'}`}>{feedback.text}</div> : null}

        <div className="settings-provider-note">
          <div className="settings-provider-note-copy">
            当前插件目录：<span className="text-strong">{selectedPluginsRoot || '未选择'}</span>。先选目录，再点“发现”扫描插件。
          </div>
        </div>

        <div className="settings-provider-list">
          {registry.plugins.length === 0 ? (
            <div className="settings-provider-empty">
              <div className="settings-provider-empty-title">还没有发现插件</div>
              <div className="settings-provider-empty-copy">点击“发现”后，先选择目录，再扫描其中的插件。</div>
            </div>
          ) : (
            registry.plugins.map((plugin) => {
              const isActive = plugin.name === selectedPlugin?.name;

              return (
                <button
                  key={plugin.name}
                  className={`settings-provider-item ${isActive ? 'active' : ''}`}
                  type="button"
                  onClick={() => setSelectedPluginName(plugin.name)}
                >
                  <div className="settings-provider-item-leading">
                    <PluginAvatar />
                  </div>

                  <div className="settings-provider-item-header settings-provider-item-header-compact">
                    <div className="settings-provider-item-name">{plugin.manifest.interface?.displayName ?? plugin.name}</div>
                    <div className="settings-plugin-status-group">
                      <span
                        className={`status-badge ${plugin.status === 'loaded' ? 'completed' : plugin.status === 'error' ? 'failed' : plugin.status === 'disabled' ? 'info' : 'warn'}`}
                      >
                        {plugin.status === 'loaded' ? '已加载' : plugin.status === 'disabled' ? '已禁用' : plugin.status === 'error' ? '错误' : '已发现'}
                      </span>
                      <span className={`settings-provider-status-dot ${plugin.enabled ? 'is-online' : 'is-offline'}`} />
                    </div>
                  </div>

                  <div className="settings-provider-item-footer settings-provider-item-footer-compact">
                    <span className="settings-provider-muted">
                      {plugin.skills.length} 个 skill · {plugin.mcpServers.length} 个 MCP · {plugin.manifest.interface?.category ?? '未分类'}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </section>

      <div className="settings-provider-detail">
        {selectedPlugin ? (
          <section className="settings-provider-console">
            <div className="settings-provider-console-header">
                <div>
                  <div className="settings-provider-console-title">{selectedPlugin.manifest.interface?.displayName ?? selectedPlugin.name}</div>
                  <div className="settings-provider-console-subtitle">{selectedPlugin.manifest.description ?? '未提供描述'}</div>
                  <div className="settings-provider-console-subtitle">{selectedPlugin.rootPath}</div>
                  <div className="settings-provider-console-subtitle">插件根目录：{registry.pluginsRoot || '未选择'}</div>
                </div>
                <div className="inline-actions">
                  <button
                    className="toolbar-button"
                    type="button"
                    onClick={() => void togglePluginEnabled(selectedPlugin.name, !selectedPlugin.enabled)}
                    title={selectedPlugin.enabled ? '禁用插件' : '启用插件'}
                    aria-label={selectedPlugin.enabled ? '禁用插件' : '启用插件'}
                  >
                    {selectedPlugin.enabled ? '禁用' : '启用'}
                  </button>
                <button
                  className="toolbar-button settings-icon-button"
                  type="button"
                  onClick={() => void loadPlugin(selectedPlugin.name)}
                    disabled={!selectedPlugin.enabled}
                    title="加载插件"
                    aria-label="加载插件"
                  >
                    <WandSparkles size={14} />
                  </button>
                </div>
              </div>

            <div className="settings-provider-secret-block">
              <div className="settings-provider-console-label">插件状态</div>
              <div className="settings-info-grid">
                <div className="settings-info-row">
                  <div className="settings-info-label">manifest</div>
                  <div className="settings-info-value">{selectedPlugin.manifestPath}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">状态</div>
                  <div className="settings-info-value">{selectedPlugin.status}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">启用状态</div>
                  <div className="settings-info-value">{selectedPlugin.enabled ? '已启用' : '已禁用'}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">发现时间</div>
                  <div className="settings-info-value">{selectedPlugin.discoveredAt}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">最后加载</div>
                  <div className="settings-info-value">{selectedPlugin.lastLoadedAt ?? '未加载'}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">错误</div>
                  <div className="settings-info-value">{selectedPlugin.lastError ?? '无'}</div>
                </div>
              </div>
            </div>

            {selectedPlugin.name === 'wechat-official-account' ? (
              <div className="settings-provider-secret-block">
                <div className="settings-provider-console-label">微信配置</div>
                <div className="settings-form-field">
                  <div className="settings-form-help">配置会保存到 <code>~/.openagent/settings/plugin-configs/wechat-official-account.json</code>。</div>
                </div>
                {wechatConfigFeedback ? (
                  <div className={`settings-inline-feedback ${wechatConfigFeedback.type === 'success' ? 'success' : 'error'}`}>
                    {wechatConfigFeedback.text}
                  </div>
                ) : null}
                <div className="settings-form-field">
                  <span className="settings-form-label">AppID</span>
                  <input
                    className="settings-text-input"
                    value={wechatConfig.appId}
                    onChange={(event) => setWechatConfig((prev) => ({ ...prev, appId: event.target.value }))}
                    onBlur={() => void saveWechatPluginConfig()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void saveWechatPluginConfig();
                      }
                    }}
                    placeholder="请输入微信公众号 AppID"
                    autoComplete="off"
                  />
                </div>
                <div className="settings-form-field">
                  <span className="settings-form-label">AppSecret</span>
                  <input
                    className="settings-text-input"
                    type="password"
                    value={wechatConfig.appSecret}
                    onChange={(event) => setWechatConfig((prev) => ({ ...prev, appSecret: event.target.value }))}
                    onBlur={() => void saveWechatPluginConfig()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void saveWechatPluginConfig();
                      }
                    }}
                    placeholder="请输入微信公众号 AppSecret"
                    autoComplete="off"
                  />
                </div>
                <div className="settings-form-field">
                  <span className="settings-form-label">API Base</span>
                  <input
                    className="settings-text-input"
                    value={wechatConfig.apiBase}
                    onChange={(event) => setWechatConfig((prev) => ({ ...prev, apiBase: event.target.value }))}
                    onBlur={() => void saveWechatPluginConfig()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void saveWechatPluginConfig();
                      }
                    }}
                    placeholder="https://api.weixin.qq.com"
                    autoComplete="off"
                  />
                </div>
                <div className="settings-form-field">
                  <span className="settings-form-label">风格 JSON</span>
                  <div className="settings-form-help">
                    这里保存到 <code>~/.openagent/settings/plugin-configs/wechat-official-account.json</code> 的 <code>wechat.style</code> 字段。默认样例参考 markdown-weixin 的视觉风格，直接按 <code>h1</code>、<code>h2</code>、<code>p</code>、<code>blockquote</code>、<code>code</code>、<code>table</code> 这些键修改即可；支持 <code>//</code> 或 <code>/* */</code> 注释，保存时会自动去掉。
                  </div>
                  <textarea
                    className="settings-textarea"
                    value={wechatStyleJson}
                    onChange={(event) => setWechatStyleJson(event.target.value)}
                    onBlur={() => void saveWechatPluginConfig()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && event.metaKey) {
                        event.preventDefault();
                        void saveWechatPluginConfig();
                      }
                    }}
                    placeholder={`{
  // 主题基础色
  "primary": "#000000",

  // 一级标题
  "h1": {
    "margin": "24px 0 16px",
    "fontSize": "28px",
    "lineHeight": "1.2"
  },

  // 正文
  "p": {
    "fontSize": "15px",
    "lineHeight": "1.6",
    "color": "#333333"
  }
}`}
                    rows={12}
                    spellCheck={false}
                  />
                </div>
                <div className="settings-model-input-row">
                  <button className="toolbar-button" type="button" onClick={() => void saveWechatPluginConfig()}>
                    保存配置
                  </button>
                  <span className="settings-provider-muted">
                    {wechatConfigLoadedAt ? `最后加载：${wechatConfigLoadedAt}` : '尚未加载本地配置'}
                  </span>
                </div>
              </div>
            ) : null}

            <div className="settings-provider-model-block">
              <div className="settings-provider-model-toolbar">
                <div className="settings-provider-console-label">能力摘要</div>
              </div>

              <div className="settings-info-grid">
                <div className="settings-info-row">
                  <div className="settings-info-label">Skill 数量</div>
                  <div className="settings-info-value">{selectedSkillCount}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">MCP 数量</div>
                  <div className="settings-info-value">{selectedMcpCount}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">分类</div>
                  <div className="settings-info-value">{selectedManifest?.interface?.category ?? '未分类'}</div>
                </div>
                <div className="settings-info-row">
                  <div className="settings-info-label">品牌色</div>
                  <div className="settings-info-value">{selectedManifest?.interface?.brandColor ?? '默认'}</div>
                </div>
              </div>

              {selectedPlugin.skills.length > 0 ? (
                <div className="settings-form-field">
                  <span className="settings-form-label">Skills</span>
                  <div className="settings-model-chip-list">
                    {selectedPlugin.skills.map((skill) => (
                      <span key={`${selectedPlugin.name}-${skill.name}`} className="settings-model-chip">
                        <span className="settings-model-chip-label">{skill.name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedPlugin.mcpServers.length > 0 ? (
                <div className="settings-form-field">
                  <span className="settings-form-label">MCP Servers</span>
                  <div className="settings-model-chip-list">
                    {selectedPlugin.mcpServers.map((server) => (
                      <span key={`${selectedPlugin.name}-${server.name}`} className="settings-model-chip">
                        <span className="settings-model-chip-label">{server.name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="settings-provider-empty">
            <div className="settings-provider-empty-title">还没有选中插件</div>
            <div className="settings-provider-empty-copy">先点击“发现”扫描项目里的插件，随后可以启用并加载。</div>
          </section>
        )}
      </div>
    </div>
  );
}

export function SettingsScreen({ activeTab, onTabChange, onWorkspaceChange, onBack }: SettingsScreenProps) {
  const rows = pageRows[activeTab];
  const title = pageTitles[activeTab];

  return (
    <div className="settings-screen">
      <div className="settings-body">
        <aside className="settings-sidebar">
          <button className="settings-back settings-sidebar-back" type="button" onClick={onBack}>
            <ArrowLeft size={18} />
            返回应用
          </button>

          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.key;

            return (
              <button
                key={item.key}
                type="button"
                className={`settings-sidebar-item ${isActive ? 'active' : ''}`}
                onClick={() => onTabChange(item.key)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </aside>

        <main className="settings-content">
          <div className="settings-content-inner">
            <h1 className="settings-page-title">{title}</h1>

            {activeTab === 'models' ? (
              <LlmProviderPanel onWorkspaceChange={onWorkspaceChange} />
            ) : activeTab === 'plugins' ? (
              <PluginPanel />
            ) : activeTab === 'knowledge' ? (
              <KnowledgePanel />
            ) : (
              <section className="settings-card">
                {rows.map((row, index) => (
                  <div key={`${row.title}-${index}`} className={`settings-card-row ${index === rows.length - 1 ? 'is-last' : ''}`}>
                    <SettingsRow row={row} />
                  </div>
                ))}
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
