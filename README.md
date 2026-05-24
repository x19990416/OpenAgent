# OpenAgent Desktop

基于 Electron + Vite + React + TypeScript 的 OpenAgent 桌面 UI 原型。

当前 UI 参考 `参照/renderer` 的工作台设计：左侧 session/插件/自动化入口，中间对话工作区，右侧 Plan/任务/审批/Git/上下文/记忆/日志检查器。

## 常用命令

```bash
pnpm install
pnpm dev           # 浏览器预览 renderer
pnpm dev:electron  # Electron 桌面运行
pnpm typecheck
pnpm build
```

## 目录

- `apps/desktop/src/main`：Electron 主进程与 preload 桥接。
- `apps/desktop/src/renderer`：React UI。
- `packages/shared-types/src`：renderer 与 preload 共用的类型契约（迁移期通过 `@shared-types/*` alias 使用）。
- `参照`：原始 UI 参考目录，保留不改。
