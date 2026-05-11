# OpenAgent Agents Guide

> 本文件是 OpenAgent 项目的 agent 开发入口。进入本仓库时，优先阅读本文，再按任务类型跳转到对应文档或源码区域。

## 1. 项目定位

OpenAgent 是一个基于 Electron + Vite + React + TypeScript 的桌面 Agent 工作台。

当前仓库处于 UI 原型 + runtime 设计阶段：

- Renderer 已具备工作台式 UI：会话、消息、任务、审批、Git、上下文、记忆、日志等区域。
- Main 进程目前主要是 Electron preload / IPC 桥接和 local demo stub。
- 后续核心方向是接入真实 agent runtime，并优先参考 OpenClaw 的 Embedded Pi AgentSession 方案。

## 2. 必读文档

| 文档 | 何时阅读 |
| --- | --- |
| `README.md` | 了解项目启动方式、目录和当前 UI 原型状态。 |
| `docs/pi.md` | 设计或实现 Pi runtime、agent loop、tool adapter、session/memory/compaction 时必须阅读。 |
| `docs/plan-mode.md` | 设计或实现 Agent Plan Mode、计划审批、分步执行、plan 持久化时必须阅读。 |
| `docs/knowledge.md` | 设计或实现 system wiki、llm-wiki-agent schema、知识库工具时必须阅读。 |
| `docs/plugins.md` | 设计或实现插件系统、飞书/Slack/企业微信等 channel、插件 tools/skills/remote UI 时必须阅读。 |
| `docs/approval-scope.md` | 设计或实现审批按钮、外部路径授权、tool approval scope 时必须阅读。 |
| `agents.md` | 每次开始开发前阅读，用作路由和约束入口。 |

## 3. 当前目录职责

```text
src/
├── main/                 # Electron 主进程、IPC handler、后续 runtime 接入点
├── renderer/             # React UI 工作台
└── shared/types/         # preload / renderer / main 共享类型契约

docs/
├── pi.md                 # Pi Agent 集成开发指导
├── plan-mode.md          # Agent Plan Mode 设计与实现计划
├── knowledge.md          # system wiki 知识层设计
└── plugins.md            # OpenAgent 插件系统标准
```

### `src/main`

当前职责：

- 创建 Electron 窗口。
- 注册 IPC handler。
- 提供 workspace、agent、thread、message、plugin、model 等 demo 数据。

后续职责：

- 接入 `runtime-service`。
- 承载 OpenAgent Runtime 状态机。
- 调用 Pi Runtime Adapter。
- 统一把 runtime 事件转成 UI events。

### `src/renderer`

职责：

- 只消费 `window.desktopApi` 暴露的接口。
- 不直接依赖 Node、Electron main 内部实现或 Pi SDK 类型。
- UI 状态通过 `useUiEventStream()` 聚合。

### `src/shared/types`

职责：

- 放置 main / preload / renderer 都需要理解的稳定数据契约。
- 新增 IPC 或 UI event 时，优先在这里定义类型。

## 4. Runtime 设计原则

开发真实 agent runtime 时遵循以下原则：

1. **UI 与 runtime 解耦**：Renderer 不感知 Pi、OpenAI、Codex 等具体 agent engine。
2. **Runtime Adapter 优先**：先定义 OpenAgent 自己的 `AgentRuntimeAdapter`，Pi 只是其中一种实现。
3. **不要包壳 Pi CLI**：优先嵌入 `@mariozechner/pi-coding-agent`，通过 `createAgentSession()` 管理 agent loop。
4. **工具统一由 OpenAgent 管理**：不要直接暴露 Pi 默认工具绕过 OpenAgent 的审批、sandbox、日志和 UI 状态。
5. **事件必须可观测**：run、message、tool、approval、patch、terminal、memory 都要能映射到 UI event。
6. **session 可恢复**：thread/session transcript 应落地到 JSONL，并由 UI 元数据建立索引。
7. **prompt 不无脑膨胀**：skills、plugins、memory、docs 只注入必要摘要，长内容走按需检索。
8. **知识库收敛**：当前只保留 llm-wiki-agent 风格 system wiki 作为系统公共知识库；runtime 只能通过 OpenAgent KnowledgeProvider/Tool 访问。

## 5. 建议新增 runtime 结构

实现 Pi runtime 时，优先按下面结构推进：

```text
src/main/runtime/
├── runtime-service.ts          # prompt/run 总入口
├── run-state.ts                # active run、取消、状态机
├── event-bus.ts                # UI event 分发
├── session-store.ts            # thread/session 文件定位与元数据
├── planning/                   # Agent Plan Mode、计划审批、分步执行
├── knowledge/                  # agent brain / system wiki provider 与工具
└── pi/
    ├── pi-runtime-adapter.ts   # OpenAgent -> Pi 主适配层
    ├── pi-session.ts           # createAgentSession / SessionManager
    ├── pi-events.ts            # Pi events -> OpenAgent UiEvent
    ├── pi-tools.ts             # OpenAgent tools -> Pi ToolDefinition
    ├── pi-system-prompt.ts     # 系统提示词构建
    ├── pi-model.ts             # provider/model/auth 解析
    └── pi-errors.ts            # failover、abort、context overflow 分类
```

如果实际落地需要拆分，可以调整，但不要让 Pi SDK 类型向 renderer 或共享 UI 类型层泄漏。

## 6. IPC / UI Event 约定

现有边界：

- `preload.ts` 通过 `window.desktopApi` 暴露能力。
- `useUiEventStream()` 负责拉取 bootstrap state 并订阅 `ui:event`。
- `prompt:send` 是当前提交 prompt 的主入口。

新增能力时：

- 优先扩展 `src/shared/types`。
- IPC handler 保持薄层，复杂逻辑下沉到 service。
- streaming 不要只等最终完成；应补充 delta 或 runtime task 事件。
- 失败需要写入 run log，并返回可定位的错误摘要。

## 7. Tool / Plugin / Skill 约束

实现工具系统时：

- Tool 必须支持 `AbortSignal`。
- Tool start/update/end/fail 必须能进入 UI 事件流。
- shell、git、外部路径、破坏性操作必须走 policy / approval。
- MCP plugin tool 先转成 OpenAgent tool，再统一转 Pi tool。
- skill 注入应区分：已发现、已启用、已加载、当前任务相关；不要把所有 skill 全局塞进每一轮 prompt。
- knowledge tool 必须走 OpenAgent `ToolRegistry`、policy、run log 和 UI event，不允许绕过 OpenAgent 直接执行。

## 8. 本地数据布局建议

OpenAgent 业务数据应落在：

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

注意：Electron / Chromium cache 不应混入业务数据目录。

## 9. 开发命令

```bash
pnpm install
pnpm dev
pnpm dev:electron
pnpm typecheck
pnpm build
```

提交或交付前至少运行：

```bash
pnpm typecheck
```

如果改了 Electron main、preload、Vite 配置或共享类型，优先再跑：

```bash
pnpm build
```

## 10. Git 与安全约束

- 不要擅自创建、切换、发布 Git 分支；需要先得到用户明确确认。
- 不要重置、删除或覆盖用户改动，除非用户明确要求。
- 涉及 destructive shell、外部路径写入、数据库清理、`git reset`、批量删除等操作时必须先确认。
- branch/worktree 创建不是默认动作。
- 如果用户只要求写文档，不要顺手实现代码。

## 11. 当前优先级路线

1. 先保持 UI 原型可运行。
2. 完成 runtime 文档和边界设计。
3. 实现最小 `AgentRuntimeAdapter`。
4. 默认接入 Pi embedded session，并使用 Pi ModelRegistry / AuthStorage。
5. 接 streaming / tool events / cancellation。
6. 接 OpenAgent tool policy / approval / patch。
7. 接 skills / plugins / MCP。
8. 接 session 恢复、memory、compaction。
9. 接 knowledge layer：system wiki、知识检索和沉淀审批。

## 12. 不要做的事

- 不要把 OpenClaw 的代码结构整包复制过来。
- 不要让 renderer 直接 import Pi SDK。
- 不要在系统 prompt 中全量注入所有 skills、docs、memory。
- 不要绕过 OpenAgent policy 直接执行 Pi 默认 shell/write/edit 工具。
- 不要把 local demo stub 当作最终 runtime 设计。

## 13. 快速判断任务入口

| 用户任务 | 优先查看/修改 |
| --- | --- |
| UI 样式、布局、交互 | `src/renderer` |
| IPC、新 desktopApi 能力 | `src/main/preload.ts`、`src/shared/types`、`src/main/main.ts` |
| agent loop / Pi 集成 | `docs/pi.md`，然后新增 `src/main/runtime` |
| Agent Plan Mode / 计划审批 / 分步执行 | `docs/plan-mode.md`，然后新增 `src/main/runtime/planning` |
| session/thread 持久化 | `src/main/runtime/session-store.ts` 及 `~/.openagent/agents/<agentId>/sessions` 设计 |
| tool/approval/sandbox | `docs/pi.md` 的 Tool 和 Sandbox 章节，审批 scope 另见 `docs/approval-scope.md` |
| model/provider 配置 | 后续 model config store，避免写死在 Pi adapter |
| plugin/skill 注入 | `docs/plugins.md`，先设计 enabled/loaded/relevant 过滤，再进入 prompt |
| 飞书/Slack/企业微信等外部入口 | `docs/plugins.md`，按 channel + tools + remote UI 插件实现 |
| agent brain / system wiki / 知识库 | `docs/knowledge.md`，然后 `src/main/runtime/knowledge` |
