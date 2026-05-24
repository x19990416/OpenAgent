# OpenAgent 仓库结构演进路线图

> 本文用于记录 OpenAgent 从当前单包 Electron 项目，逐步演进到更清晰的模块化 / monorepo 结构的路线。本文只描述目录边界和迁移顺序，不要求立即大规模搬目录。

## 1. 背景

OpenAgent 当前起点是一个 Electron + Vite + React + TypeScript 桌面 UI 原型，目录结构相对直接：

```text
src/
├── main/                 # Electron 主进程、IPC、runtime、plugin host
├── renderer/             # React renderer UI
└── shared/types/         # main / preload / renderer 共享类型

docs/                     # 架构与设计文档
scripts/                  # 构建、打包、smoke 脚本
skills/                   # 内置 skill 包
openagent-plugins/        # 插件示例 / 开发态插件
build/                    # 应用图标与打包资源
```

这个结构适合早期 UI 原型，但 OpenAgent 现在已经扩展到：

- Embedded Pi runtime adapter
- OpenAgent tool policy / approval / logs
- subagents
- skills
- plugins
- system wiki / knowledge layer
- scheduled tasks
- desktop packaging
- 未来 Feishu / Slack / 企业微信等 channel plugin

因此，项目的实际复杂度已经超过“单个 Electron UI app”的边界，后续需要逐步整理目录职责。

## 2. 当前结构判断

当前结构不是错误的，但属于“单包原型结构”：

```text
openagent/
├── package.json
├── src/
│   ├── main/
│   ├── renderer/
│   └── shared/
├── docs/
├── scripts/
├── skills/
└── openagent-plugins/
```

主要问题是：

1. `src/main/runtime` 已经变成 OpenAgent runtime 平台核心，不只是 Electron main 的附属代码。
2. `src/main/plugins`、`skills/`、`openagent-plugins/` 三类概念混在根目录附近，但语义不同。
3. renderer、runtime、shared types 之间的边界还停留在源码目录级别，没有 package 级别边界。
4. 未来如果增加 Web UI、CLI、remote channel、plugin SDK，当前结构会越来越拥挤。

## 3. 设计原则

仓库结构演进应遵循以下原则：

1. **先稳定 runtime，再搬目录**
   不要在 Pi runtime、tool policy、approval、packaging 仍频繁变化时做大规模迁移。

2. **保持 renderer 与 runtime 解耦**
   Renderer 只通过 shared types / desktopApi / UI events 访问能力，不直接 import Pi SDK 或 main 内部实现。

3. **把产品入口和可复用能力分开**
   App 放在 `apps/`，可复用 runtime / UI / plugin SDK 放在 `packages/`。

4. **内置资源和运行时框架分开**
   Plugin runtime、skill runtime 是代码；内置 plugins、内置 skills 是资源包，不应混为一谈。

5. **分阶段迁移，避免一次性大改**
   每一步都应能独立 typecheck / build / package。

## 4. 短期目标：整理当前单包结构

短期不建议立刻 monorepo 化。可以先在现有 `src/` 下细化边界。

建议目标：

```text
src/
├── main/
│   ├── app/              # Electron app lifecycle、window、IPC registration
│   ├── platform/         # macOS / Windows / filesystem / OS integration
│   ├── runtime/          # OpenAgent runtime 核心
│   └── plugins/          # plugin host / plugin loader / plugin services
│
├── renderer/
│   ├── app/              # renderer app entry、routes / top-level composition
│   ├── components/       # 通用 UI components
│   ├── features/         # chat / settings / scheduled / review 等功能域
│   ├── hooks/
│   ├── lib/
│   ├── styles/
│   └── types/
│
└── shared/
    ├── ipc/              # IPC channel contracts
    └── types/            # UI events、runtime DTO、shared models
```

这一步的重点不是换工具链，而是让职责更清晰。

### 推荐短期动作

1. 将 Electron app/window/ipc 相关代码逐步从 `src/main/main.ts` 拆到 `src/main/app/`。
2. 保持 `src/main/runtime/` 作为 runtime 聚合点，但内部按领域继续分层。
3. Renderer 新增 `features/`，逐步把大组件按功能域迁移。
4. 将 shared IPC 类型从普通 shared types 中拆出来。
5. README 和 AGENTS.md 同步更新目录说明。

## 5. 中期目标：引入 workspace / monorepo

当 runtime 主路径稳定后，可以迁移为 monorepo。

目标结构：

```text
openagent/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/
│       │   ├── preload/
│       │   └── renderer/
│       ├── package.json
│       └── electron-builder.config.cjs
│
├── packages/
│   ├── runtime/          # OpenAgent runtime service、run state、events、tools
│   ├── pi-adapter/       # Pi AgentSession adapter、Pi tools/events/model/auth glue
│   ├── shared-types/     # main / renderer / plugin / external channel 共享类型
│   ├── ui/               # 可复用 React UI components
│   ├── plugin-runtime/   # plugin manifest、loader、policy、remote UI bridge
│   ├── skill-runtime/    # Skill discovery、resolver、script runner
│   └── knowledge/        # system wiki provider、ingest、graph、tools
│
├── builtins/
│   ├── skills/           # 内置 skills
│   └── plugins/          # 内置 plugins，如需要
│
├── examples/
│   ├── plugins/
│   └── skills/
│
├── docs/
├── scripts/
├── build/
├── package.json
└── pnpm-workspace.yaml
```

## 6. 目标目录职责

### `apps/desktop`

桌面产品入口。

职责：

- Electron app lifecycle
- BrowserWindow / tray / dock / native menu
- preload bridge
- renderer app composition
- desktop packaging config

不应承担：

- Pi SDK 深层适配
- plugin / skill / knowledge 的核心实现
- 可复用 runtime 业务逻辑

### `packages/runtime`

当前已迁入基础 runtime 模块：event-bus、run-state、transcript-store、prompt-builder、path-policy、tool-policy；RuntimeService、tool executor/registry、session store、planning/subagents 仍保留在 desktop host，后续继续拆。

OpenAgent runtime 核心。

职责：

- `RuntimeService`
- run state
- event bus
- transcript / session store
- tool registry / executor / policy
- approval flow
- scheduled run orchestration

不应直接依赖 renderer。

### `packages/pi-adapter`

Pi 集成层。

职责：

- `AgentRuntimeAdapter` 的 Pi 实现
- `createAgentSession()` glue code
- Pi events -> OpenAgent UI events
- OpenAgent tools -> Pi custom tools
- Pi model/auth/session compatibility

不应让 Pi SDK 类型泄漏到 renderer 或 shared UI types。

### `packages/shared-types`

跨进程、跨包稳定契约。

职责：

- UI event DTO
- IPC request/response types
- runtime public DTO
- plugin public types

### `packages/ui`

可复用 UI 组件。

职责：

- buttons / panels / dialogs
- markdown / diff / terminal rendering components
- shared layout primitives

不应直接依赖 Electron main 或 runtime internal code。

### `packages/plugin-runtime`

插件系统代码。

职责：

- plugin manifest schema
- plugin loader
- plugin registry
- tool bridge
- policy bridge
- remote UI bridge

### `packages/skill-runtime`

Skill 系统代码。

职责：

- skill discovery
- `SKILL.md` parsing
- skill relevance / loading state
- script / templates / references execution policy

### `packages/knowledge`

知识库系统。

职责：

- system wiki provider
- ingest / compile / lint / graph
- knowledge tools
- knowledge context router

## 7. 迁移顺序建议

不要一次性迁移。建议按下面顺序：

### Phase 0：现状固化

- 确保当前 `pnpm typecheck` 通过。
- 确保 `pnpm build` 通过。
- 确保 macOS packaging 通过。
- README / AGENTS.md 描述当前实际结构。

### Phase 1：单包内整理

- 拆分 `src/main/main.ts`。
- Renderer 引入 `features/`。
- shared 拆出 `ipc/`。
- 不改变 package/workspace 工具链。

### Phase 2：抽 shared types

新增：

```text
packages/shared-types
```

迁移：

```text
src/shared/types -> packages/shared-types/src
```

调整 main / renderer import。

验证：

```bash
pnpm typecheck
pnpm build
```

### Phase 3：抽 runtime

新增：

```text
packages/runtime
```

迁移 runtime 中不依赖 Electron 的部分：

- run state
- event bus
- transcript/session store
- tool registry/executor/policy
- planning
- scheduled task orchestration

保留 desktop-specific bridge 在 `apps/desktop`。

### Phase 4：抽 pi-adapter（已开始）

新增：

```text
packages/pi-adapter
```

迁移：

```text
src/main/runtime/pi -> packages/pi-adapter/src
```

要求：

- Pi SDK 只在该包直接 import。
- renderer/shared-types 不直接感知 Pi SDK。
- desktop-specific 的 settings、logging、tool approval/policy 通过 `apps/desktop/src/main/runtime/pi-adapter-factory.ts` 注入，不让 `packages/pi-adapter` 反向依赖 desktop app。

### Phase 5：抽 plugin / skill / knowledge

按稳定程度拆分：

```text
packages/plugin-runtime
packages/skill-runtime
packages/knowledge
```

内置资源迁移到：

```text
builtins/skills
builtins/plugins
```

示例迁移到：

```text
examples/plugins
examples/skills
```

### Phase 6：desktop app 迁入 apps

最终迁移：

```text
src/main      -> apps/desktop/src/main
src/renderer  -> apps/desktop/src/renderer
src/shared    -> packages/shared-types
```

根目录只保留 workspace、docs、scripts、build、builtins、examples。

## 8. 不建议现在立刻做的事

- 不要一次性把所有 `src/` 搬到 `apps/desktop`。
- 不要边迁移目录边重写 runtime 逻辑。
- 不要在 Pi SDK 迁移还没稳定时拆 `pi-adapter` package。
- 不要让 renderer 直接 import runtime package 的内部实现。
- 不要把内置 skills/plugins 和 runtime framework 混在同一个 package。

## 9. 与 Palot 的差异

Palot 是 OpenCode 的桌面 GUI wrapper，已经采用：

```text
apps/
packages/
```

这种 monorepo 结构。OpenAgent 当前更像从 Electron 原型逐步长出的 runtime 平台。

因此 OpenAgent 不需要完全照搬 Palot，但可以借鉴它的几个工程边界：

1. 产品入口放 `apps/`。
2. 共享 UI / runtime / converter / plugin SDK 放 `packages/`。
3. 根目录负责 workspace、lint、build、release 编排。
4. docs 明确说明每个 package 的职责。

## 10. 推荐目标

OpenAgent 最终推荐演进为：

```text
openagent/
├── apps/desktop
├── packages/runtime
├── packages/pi-adapter
├── packages/shared-types
├── packages/ui
├── packages/plugin-runtime
├── packages/skill-runtime
├── packages/knowledge
├── builtins/skills
├── examples/plugins
├── docs
├── scripts
└── build
```

但短期应优先保持：

1. Pi runtime 可运行。
2. tool / approval / logs 可观测。
3. packaging 稳定。
4. 目录迁移可回滚、可验证。
