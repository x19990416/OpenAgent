<p align="center">
  <img src="build/app.png" alt="OpenAgent logo" width="120" height="120" />
</p>

<h1 align="center">OpenAgent</h1>

<p align="center">
  面向真实工作流的开源桌面 Agent 工作台。<br />
  用统一的桌面界面组织对话、计划、工具、审批、知识、记忆、日志与插件，让 AI Agent 更可控、更可观察、更适合长期使用。
</p>

<p align="center">
  <strong>Electron</strong> · <strong>React</strong> · <strong>TypeScript</strong> · <strong>Vite</strong> · <strong>Embedded Pi Runtime</strong>
</p>

---

## OpenAgent 是什么？

OpenAgent 是一个基于 Electron + Vite + React + TypeScript 构建的桌面 Agent 工作台。它不是一个简单的聊天窗口，也不是把 CLI 包一层壳的桌面应用，而是希望把 Agent 在真实工作中需要的能力沉淀为一套可运营、可扩展、可治理的本地工作台：

- **对话与任务工作区**：围绕 session/thread 管理多轮任务、消息、计划和执行结果。
- **Agent Runtime 编排层**：由 OpenAgent 自己管理 run、context、tool、approval、session、memory 和 event stream。
- **Embedded Pi 主路径**：默认通过 `@earendil-works/pi-coding-agent` 的 `AgentSession` 嵌入式运行，不维护 local demo stub。
- **统一工具治理**：shell、文件、Git、知识库、插件和子 agent 都必须通过 OpenAgent 的 ToolRegistry、Policy、Approval、Log 和 UI event。
- **长期上下文**：围绕 transcript、compaction、memory、system wiki 和 knowledge tools 建立可恢复的 agent 工作记忆。
- **插件与 Skill 体系**：为 MCP、企业工具、外部 channel、SKILL.md、script/template/reference 等扩展能力预留标准化入口。

项目当前处于 **UI 原型 + Embedded Pi runtime 落地阶段**。桌面 UI、runtime 主链路、monorepo packages、技能/插件/知识/计划/子 agent 等核心模块已经进入分层实现阶段，仍在持续演进中。

## 目标用户

OpenAgent 面向希望把 AI Agent 用在真实工作流中的开发者、团队和自动化工具构建者：

- 需要一个本地桌面 Agent 工作台，而不是纯 Web Chat 或单次 CLI 调用。
- 希望 Agent 执行 shell、文件、代码、Git、知识库和插件工具时可以被审计、被审批、被追踪。
- 希望把私有工作区、长期记忆、系统知识库和组织工具统一到一个可扩展 runtime 中。
- 希望研究或构建多 agent、Plan Mode、工具策略、插件系统、MCP 集成、企业 IM/Docs/Calendar 工具入口。

## 核心特性

### 桌面工作台

- Electron 桌面宿主，React renderer 工作台界面。
- 左侧 session、插件、自动化入口。
- 中间对话与任务执行工作区。
- 右侧计划、任务、审批、Git、上下文、记忆、日志检查器等辅助面板。
- Renderer 只通过 `window.desktopApi` 访问主进程能力，不直接依赖 Node、Electron main 或 Pi SDK。

### Runtime 与事件流

- `RuntimeService` 作为桌面 prompt/run 编排入口。
- `AgentRuntimeAdapter` 作为 OpenAgent 自己的 runtime 抽象，Pi 只是默认实现。
- runtime events 转成 UI event stream，支撑消息、tool、approval、terminal、log、memory、planning 等可观察状态。
- session transcript 使用 JSONL 方向设计，支持后续恢复、压缩和索引。

### Embedded Pi 集成

- 优先嵌入 `@earendil-works/pi-coding-agent`，通过 `createAgentSession()` 管理 agent loop。
- 不包壳 Pi CLI。
- 不让 Pi SDK 类型泄漏到 renderer、shared-types 或纯 UI 层。
- Pi 默认工具不直接暴露给用户；OpenAgent 将工具统一转换为 Pi custom tools。

### Tool / Policy / Approval

- 所有工具通过 OpenAgent ToolRegistry 注册和执行。
- shell、git、外部路径、破坏性操作等能力必须进入 policy / approval 流程。
- 工具执行产生 start/update/end/fail 事件，便于 UI 追踪和日志审计。
- Tool 必须支持 `AbortSignal`，以便取消长任务或失败清理。

### Plan Mode、Memory 与 Knowledge

- Agent Plan Mode 用于复杂任务拆解、计划审批、分步执行与计划持久化。
- Memory/Soul/User 上下文用于长期个性化与任务连续性。
- Knowledge 模块面向 system wiki、知识检索、知识沉淀审批和知识工具。
- prompt 注入遵循“按需、摘要、可检索”的原则，不无脑膨胀上下文。

### Skills、Plugins 与 Subagents

- Skill runtime 支持技能发现、解析、注入、脚本执行、安装和 selected-skill 路由。
- Plugin runtime 面向插件 manifest、registry、loader、config 和 MCP/企业工具接入。
- Subagents 包含 `shell_agent`、`knowledge_agent`、`pi_coding_agent` 等分层能力：
  - `shell_agent`：确定性只读文件搜索/统计 fast path。
  - `knowledge_agent`：知识库入口。
  - `pi_coding_agent`：执行型子 agent，面向写代码、运行脚本、修复和复杂产物。

## 当前状态

OpenAgent 仍在快速迭代中，建议把它视为一个面向正式运营的早期开放项目：

- ✅ 桌面 UI 工作台原型已具备主要区域。
- ✅ monorepo workspace 已拆分为 desktop app 与多个可复用 package。
- ✅ RuntimeService、Pi adapter、tools、planning、knowledge、skills、plugins、subagents 已形成基础模块边界。
- ✅ macOS / Windows 图标资源已放在 `build/` 目录。
- 🚧 runtime 事件、审批、terminal、patch、session 恢复、memory、knowledge layer 仍在持续巩固。
- 🚧 插件生态、外部 channel、发布安装包、文档站和贡献流程仍需完善。

## 快速开始

### 环境要求

- Node.js：建议使用当前 LTS 版本。
- pnpm：本仓库使用 pnpm workspace。
- 操作系统：当前主要在 macOS 上开发；Electron 打包脚本同时预留 Windows 入口。

### 安装依赖

```bash
pnpm install
```

### 启动开发环境

浏览器预览 renderer：

```bash
pnpm dev
```

启动 Electron 桌面应用：

```bash
pnpm dev:electron
```

### 类型检查与构建

```bash
pnpm typecheck
pnpm build
```

如果修改了 Electron main、preload、Vite 配置、共享类型或 package 边界，建议至少运行：

```bash
pnpm typecheck
pnpm build
```

## 打包

根目录提供了常用打包脚本：

```bash
pnpm package:macos:app       # 生成 macOS .app
pnpm package:macos:dmg       # 生成 macOS DMG
pnpm package:windows:installer
pnpm package:windows:installer:bash
```

图标资源位于 `build/`：

```text
build/
├── app.png           # README / 品牌展示图标
├── icon-source.png   # 原始图标源文件
├── icon.icns         # macOS 应用图标
└── icon.ico          # Windows 应用图标
```

## 常用脚本

| 命令                               | 说明                                               |
| ---------------------------------- | -------------------------------------------------- |
| `pnpm install`                   | 安装 workspace 依赖。                              |
| `pnpm dev`                       | 构建 workspace packages 后启动 renderer 开发服务。 |
| `pnpm dev:electron`              | 构建 workspace packages 后启动 Electron 桌面应用。 |
| `pnpm typecheck`                 | 构建依赖包并执行桌面端类型检查。                   |
| `pnpm build`                     | 构建 runtime packages 与 desktop app。             |
| `pnpm preview`                   | 预览 desktop renderer 构建产物。                   |
| `pnpm package:macos:app`         | 打包 macOS `.app`。                              |
| `pnpm package:macos:dmg`         | 打包 macOS DMG。                                   |
| `pnpm package:windows:installer` | 打包 Windows 安装器。                              |
| `pnpm smoke:skills`              | Skill 系统 smoke test。                            |
| `pnpm e2e:skill-selected`        | selected-skill 流程端到端测试。                    |
| `pnpm smoke:plugin-skills`       | plugin skills smoke test。                         |

## 仓库结构

```text
.
├── apps/
│   └── desktop/                  # Electron 桌面应用
├── packages/
│   ├── runtime/                  # runtime core：run/session/tool/policy/log/context
│   ├── planning/                 # Agent Plan Mode service/store/executor
│   ├── pi-adapter/               # OpenAgent -> Embedded Pi 适配层
│   ├── skill-runtime/            # Skill discovery/injection/script/install
│   ├── knowledge/                # system wiki / knowledge provider / tools
│   ├── plugin-runtime/           # plugin manifest/runtime/registry/loader/config
│   ├── subagents/                # shell_agent / knowledge_agent / pi_coding_agent
│   ├── shared-types/             # preload / renderer / main 共享类型契约
│   └── ui/                       # 可复用 React workbench UI 组件
├── docs/                         # 内部架构与开发设计文档
├── github-docs/                  # 发布到 GitHub docs 的公开文档源
├── build/                        # 应用图标和打包资源
├── scripts/                      # 发布、技能、smoke/e2e 等脚本
├── skills/                       # OpenAgent runtime skills 示例/内置资源
├── builtins/                     # 内置资源
├── openagent-plugins/            # 插件相关资源
├── electron-builder.config.cjs   # Electron Builder 配置
├── package.json                  # workspace 根脚本
└── agents.md                     # agent 开发入口与约束
```

## 架构概览

OpenAgent 当前主链路可以概括为：

```text
Renderer React Workbench
  -> preload.ts / window.desktopApi
  -> Electron Main IPC handlers
  -> RuntimeService
  -> Plan / Memory / Knowledge / Tool / Approval / Session
  -> PiRuntimeAdapter
  -> Embedded Pi AgentSession
  -> OpenAgent-controlled tools
  -> RuntimeEventBus
  -> UI event stream
```

核心原则：

1. **UI 与 runtime 解耦**：renderer 不感知 Pi、OpenAI、Codex 等具体 engine。
2. **Runtime Adapter 优先**：先定义 OpenAgent 自己的 adapter 契约，再接 Pi。
3. **工具统一治理**：不绕过 OpenAgent policy 直接暴露 Pi 默认工具。
4. **事件必须可观测**：run、message、tool、approval、patch、terminal、memory 都应进入 UI event/log。
5. **session 可恢复**：thread/session transcript、metadata 与 compaction 面向长期使用设计。
6. **上下文按需注入**：docs、skills、plugins、memory、knowledge 通过相关性过滤和检索进入 prompt。

## 本地数据目录

OpenAgent 业务数据规划落在 `~/.openagent/`：

```text
~/.openagent/
├── agents/
│   └── <agentId>/
│       ├── workspace/
│       ├── sessions/
│       ├── MEMORY.md
│       ├── USER.md
│       └── skills/
├── system/
│   └── wiki/
│       ├── raw/
│       ├── wiki/
│       └── graph/
├── settings/
├── state/
└── logs/
```

Electron / Chromium cache 不应混入 OpenAgent 业务数据目录。

## 开发文档

建议从以下文档继续阅读：

| 文档                               | 内容                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `agents.md`                      | 仓库级 agent 开发入口、边界和约束。                                    |
| `docs/architecture.md`           | 当前系统架构、模块边界和数据流。                                       |
| `docs/pi.md`                     | Pi runtime、agent loop、tool adapter、session/memory/compaction 指导。 |
| `docs/embedded-pi-roadmap.md`    | Embedded Pi 技术路线、里程碑和遗留问题。                               |
| `docs/subagents.md`              | `shell_agent`、`knowledge_agent`、`pi_coding_agent` 分层设计。   |
| `docs/plan-mode.md`              | Agent Plan Mode、计划审批、分步执行与持久化。                          |
| `docs/knowledge.md`              | system wiki、llm-wiki-agent schema、知识库工具。                       |
| `docs/plugins.md`                | 插件系统、channel、tools、skills、remote UI。                          |
| `docs/skills.md`                 | Skill 包、`SKILL.md`、scripts/templates/references、skill_script。   |
| `docs/approval-scope.md`         | 审批按钮、外部路径授权和 tool approval scope。                         |
| `docs/feishu-cli-integration.md` | 飞书 CLI 插件、飞书 IM/Docs/Calendar/Bitable tools。                   |

## 贡献指南

欢迎参与 OpenAgent 的设计、实现、文档和测试。当前项目还在早期阶段，贡献时请优先遵守以下边界：

- Renderer 只消费 `window.desktopApi` 和共享类型，不直接 import Electron main 或 Pi SDK。
- 新增 IPC 或 UI event 时，优先在 `packages/shared-types/src` 定义稳定 DTO。
- 复杂逻辑下沉到 service/package，IPC handler 保持薄层。
- Tool 必须支持 `AbortSignal`，并进入 log / UI event / policy / approval 链路。
- shell、git、外部路径、破坏性操作必须走审批策略。
- 不要重新引入 local demo stub 作为 runtime 分支。
- 不要把所有 skills、docs、memory 全量注入系统 prompt。
- 提交前至少运行 `pnpm typecheck`；涉及 main/preload/build/shared-types 时建议运行 `pnpm build`。

如果你要贡献较大的功能，建议先在 issue 或讨论中说明：

1. 目标用户场景。
2. 会影响的 package/app 边界。
3. 新增的 IPC、UI event、tool 或持久化格式。
4. 安全、审批、日志和回滚策略。
5. 验证方式。

## 路线图

短期重点：

- 巩固 Embedded Pi 主路径：`RuntimeService -> AgentRuntimeAdapter -> AgentSession`。
- 补齐 streaming、tool events、approval、terminal、compaction 的可观测性。
- 固化 OpenAgent tool policy / approval / patch，不暴露 Pi 默认工具绕过治理。
- 完善 `shell_agent`、`knowledge_agent`、`pi_coding_agent` 的职责分层和生命周期。
- 接入 skills / plugins / MCP，并保持按需注入。
- 完善 session 恢复、memory、knowledge layer、system wiki 和知识沉淀审批。
- 改进发布包、更新机制、文档站、示例和贡献流程。

中长期方向：

- 多 agent workspace 与可切换 agent profile。
- 插件市场与企业工具连接器。
- 更细粒度的审批 scope 与组织级策略。
- 更完整的 runtime replay、debugger、trace 和 eval 工具。
- 面向团队运营的知识库、记忆治理和任务自动化。

## 安全说明

OpenAgent 的目标是让 Agent 能操作真实工作区，因此安全边界非常重要：

- 不建议在未理解 tool policy 的情况下授予 Agent 任意 shell 或外部路径写权限。
- 不建议把敏感密钥、生产数据库凭据或不可恢复的生产操作直接交给自动化流程。
- 插件、MCP server、skill script、外部 channel 都应视为需要审计的执行边界。

---

## License

OpenAgent 使用 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 开源。

如果你在自己的项目中使用、修改或分发 OpenAgent，请遵守 Apache-2.0 的许可证条款，并保留必要的版权与许可证声明。

<p align="center">
  OpenAgent is built for controllable, observable, extensible desktop agents.
</p>
