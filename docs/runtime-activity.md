# Runtime Activity Stream 设计方案

> 本文定义 OpenAgent 的运行过程 Activity Stream。它用于展示 agent 在一次 run 中“正在做什么、刚做了什么”，例如读取文件、搜索代码、调用工具、等待审批。它不是 Agent Plan Mode，但可以服务于普通 agent loop 和 Plan Mode。

## 1. 背景

当前右侧“摘要/进度”面板有两类信息容易混在一起：

1. **Agent Plan Mode**：用户任务级计划，例如“分析现状、设计方案、修改代码、运行验证”。
2. **Runtime Progress / Activity**：运行过程中的具体动作，例如“Read pi.md”“Searched for createAgentSession”“Listed files in tools”。

之前普通 agent loop 没有进入 Plan Mode 时，右侧容易出现两种问题：

- 什么都不显示，用户会觉得系统卡住或坏了。
- 把 runtime 日志伪装成 plan steps，又会和真正的 Plan Mode 混淆。

因此需要单独引入 **Runtime Activity Stream**。

## 2. 目标

Runtime Activity Stream 的目标：

1. **展示当前动作**：运行中至少显示“思考中”以及最近执行动作。
2. **不重复最终回答**：最终回复正文只在中间对话区展示，右侧不重复长摘要。
3. **不污染 Plan Mode**：activity 不作为 plan step，不改变 plan 的语义。
4. **轻量、可读**：UI 不使用卡片堆叠，使用类似 Codex 的简洁动作流。
5. **可观测**：工具开始、完成、失败、审批等待都可以被表达。
6. **可扩展**：后续可以支持持久化、按 step 归属、活动详情展开。

## 3. 非目标

第一版不做：

- 不展示完整 runtime debug log。
- 不把所有 `terminal.delta` 原文直接显示给用户。
- 不替代 `run-log` 面板。
- 不让 renderer 通过复杂正则解析所有日志。
- 不在 activity 中展示大段 tool 返回内容。
- 不要求 activity 持久化恢复；第一版可以只存在当前 UI 状态中。

## 4. 和 Plan Mode 的关系

| 能力 | Plan Mode | Runtime Activity Stream |
| --- | --- | --- |
| 关注点 | 用户目标的任务拆解 | agent 执行过程中的动作 |
| 示例 | 修改 Renderer 与 Runtime 代码实现 | Read plan-panel.tsx |
| 是否需要用户确认 | 高风险计划需要确认 | 本身不需要确认 |
| 是否指导工具权限 | 是 | 否 |
| 是否可持久化为计划 | 是 | 第一版不需要 |
| UI 位置 | 右侧进度主列表 | 当前状态下方的动作流 |

结论：

- Plan Mode 显示 **计划步骤**。
- Runtime Activity Stream 显示 **执行动作**。
- 二者可以同时存在，但不能互相替代。

## 5. UI 设计

### 5.1 普通 agent loop

没有进入 Plan Mode 时，右侧“摘要/进度”区域显示：

```text
进度

⟳ 思考中

正在搜索 sdk.js 文件夹中的文件
Read pi.md
Read shell-agent-tool.ts
Read shell-agent.ts
Searched for createAgentSession in pi-coding-agent
Listed files in tools
```

完成后只保留状态：

```text
✓ 本次运行已完成
```

不显示最终回答正文，因为中间对话区已经展示。

### 5.2 等待审批

如果遇到审批，审批内容显示在“思考中”下面，activity 可以继续显示在审批内容下方：

```text
⟳ 思考中

请求读取外部路径
{"path":"/Users/.../wiki/index.md"}

[批准并继续] [始终允许] [拒绝]

Read MEMORY.md
Read pi.md
```

### 5.3 Plan Mode

第一版建议：

- Plan Mode 主体仍然显示计划步骤。
- activity 暂时不混入计划列表。
- 后续可以把 activity 挂在当前 `in_progress` step 的详情里。

后续增强形态：

```text
5. 修改 Renderer 与 Runtime 代码实现

   ⟳ Reading plan-panel.tsx
   Read runtime-service.ts
   Searched for runtime.activity
```

## 6. 数据模型

建议新增共享类型：

```ts
export type RuntimeActivityKind =
  | 'thinking'
  | 'search'
  | 'read'
  | 'list'
  | 'tool'
  | 'approval'
  | 'message'
  | 'command';

export type RuntimeActivityStatus = 'running' | 'completed' | 'failed';

export interface RuntimeActivityItem {
  id: string;
  runId?: string;
  threadId?: string;
  kind: RuntimeActivityKind;
  status: RuntimeActivityStatus;
  title: string;
  detail?: string;
  toolName?: string;
  target?: string;
  planId?: string;
  planStepId?: string;
  createdAt: string;
  completedAt?: string;
}
```

Renderer 的 `WorkbenchViewModel` 增加：

```ts
runtimeActivities: RuntimeActivityItem[];
```

## 7. UI Event 设计

建议新增事件：

```text
runtime.activity
```

payload：

```ts
export interface RuntimeActivityPayload extends RuntimeActivityItem {
  // same as RuntimeActivityItem
}
```

`UiEvent.type` 增加：

```ts
| 'runtime.activity'
```

事件语义：

- 同一个 `id` 的 activity 可以多次更新。
- `running` 表示当前动作。
- `completed` 表示动作完成。
- `failed` 表示动作失败。

Renderer 收到后按 `id` upsert。

## 8. Runtime 侧事件来源

### 8.1 ToolExecutor

主要来源是：

- `tool.started`
- `tool.completed`
- `tool.failed`

建议在 `/src/main/runtime/tool-executor.ts` 中，在现有 tool event 旁边额外发 `runtime.activity`。

示例：

```ts
emitUiEvent?.('runtime.activity', {
  id: input.toolCallId,
  runId,
  threadId,
  kind: inferActivityKind(input.toolName, input.args),
  status: 'running',
  title: formatActivityTitle(input.toolName, input.args, 'running'),
  toolName: input.toolName,
  target: inferActivityTarget(input.toolName, input.args),
  createdAt: new Date().toISOString()
});
```

完成时：

```ts
emitUiEvent?.('runtime.activity', {
  id: input.toolCallId,
  status: 'completed',
  title: formatActivityTitle(input.toolName, input.args, 'completed'),
  completedAt: new Date().toISOString()
});
```

失败时：

```ts
emitUiEvent?.('runtime.activity', {
  id: input.toolCallId,
  status: 'failed',
  title: `${formatActivityTitle(...)} failed`,
  detail: errorMessage,
  completedAt: new Date().toISOString()
});
```

### 8.2 RuntimeService onLog

`runtime-service.ts` 里的 `onLog` 目前会把日志发成 `terminal.delta`。

第一版不建议直接把所有 `terminal.delta` 转成 activity。只对明确可读的事件转 activity，例如：

- 构建运行上下文完成
- 解析模型配置
- 创建 Pi AgentSession
- 保存 transcript

这些可以作为系统级 activity，但优先级低于 tool activity。

### 8.3 Approval

审批请求可以转成 activity：

```ts
{
  kind: 'approval',
  status: 'running',
  title: 'Waiting for approval: 请求读取外部路径'
}
```

审批通过或拒绝后更新为 completed / failed。

## 9. Activity Title Formatter

不要直接展示 tool name 和 JSON 参数，需要格式化成人类可读短句。

建议第一版规则：

| tool | running title | completed title |
| --- | --- | --- |
| `read_file` / `read` | `Reading <file>` | `Read <file>` |
| `write_file` | `Writing <file>` | `Wrote <file>` |
| `list_directory` / `ls` | `Listing files in <dir>` | `Listed files in <dir>` |
| `grep` / `search.text` / `find` | `Searching for <query>` | `Searched for <query>` |
| `knowledge_agent` | `Querying knowledge base` | `Queried knowledge base` |
| `shell_agent` | `Running shell agent task` | `Ran shell agent task` |
| `tool.shell.exec` | `Running command` | `Ran command` |
| unknown | `Running <toolName>` | `Completed <toolName>` |

文件路径展示建议：

- 优先显示 basename，例如 `pi.md`。
- 如果 basename 不足以区分，可以显示相对路径，例如 `src/main/runtime/pi/pi-runtime-adapter.ts`。
- 不默认显示完整绝对路径，避免 UI 太长。

## 10. Renderer 侧设计

### 10.1 状态维护

`use-ui-event-stream.ts` 增加：

```ts
case 'runtime.activity': {
  const activity = event.payload as RuntimeActivityItem;
  return {
    ...prev,
    runtimeActivities: upsertRuntimeActivity(prev.runtimeActivities, activity).slice(-12)
  };
}
```

建议最多显示最近 12 条，避免面板无限增长。

### 10.2 PlanPanel 展示

`PlanPanel` 增加 prop：

```ts
runtimeActivities: RuntimeActivityItem[];
```

普通 agent loop：

```tsx
{plan.length === 0 ? (
  <>
    <RunStatusCard ... />
    <RuntimeActivityList activities={runtimeActivities} />
  </>
) : (...)}
```

第一版只在 `plan.length === 0` 时显示 activity。

### 10.3 样式

样式保持轻量：

```text
.activity-list
.activity-item
.activity-item.running
.activity-item.completed
.activity-item.failed
```

建议视觉：

- running：小 spinner + `var(--text-muted)`
- completed：无图标或淡色 dot + `var(--text-muted)`
- failed：红色
- 字号与右侧进度说明一致，不加粗

## 11. 与现有代码的改造点

### 11.1 Shared Types

文件：

```text
src/shared/types/events.ts
```

新增：

- `RuntimeActivityKind`
- `RuntimeActivityStatus`
- `RuntimeActivityItem`
- `runtime.activity` event type

### 11.2 Renderer ViewModel

文件：

```text
src/renderer/types/workbench.ts
src/renderer/mock/mock-data.ts
src/renderer/hooks/use-ui-event-stream.ts
```

新增：

- `runtimeActivities`
- `runtime.activity` reducer
- upsert helper

### 11.3 PlanPanel

文件：

```text
src/renderer/components/layout/right-panel.tsx
src/renderer/components/panels/plan-panel.tsx
```

新增：

- `runtimeActivities` prop
- `RuntimeActivityList` 组件
- 非 Plan Mode 下展示 activity

### 11.4 Runtime

文件：

```text
src/main/runtime/tool-executor.ts
src/main/runtime/runtime-service.ts
```

新增：

- activity formatter
- tool started/completed/failed -> runtime.activity
- 可选：approval required/resolved -> runtime.activity

## 12. 第一版实施范围

建议第一版只做：

1. 新增类型和事件 `runtime.activity`。
2. `ToolExecutor` 发 tool activity。
3. Renderer 保存最近 12 条 activity。
4. `PlanPanel` 在非 Plan Mode 下显示 activity。
5. 活动 title 做基础 formatter。
6. 跑 `pnpm typecheck` 和 `pnpm build`。

暂不做：

- activity 持久化。
- Plan step 下挂载 activity。
- 全量 terminal.delta 解析。
- activity 展开详情。

## 13. 后续增强

后续可以逐步增强：

1. **按 Plan Step 归属**：activity 带 `planStepId`，显示在当前 step 下面。
2. **持久化**：写入 transcript 或 run metadata，历史 run 可回放。
3. **详情展开**：点击 activity 展示 tool args preview / result preview。
4. **更智能 formatter**：针对 shell、knowledge、search、read_file 做更准确的人类可读标题。
5. **失败定位**：failed activity 可链接到 run-log 对应日志。
6. **隐私与安全过滤**：隐藏 token、secret、完整绝对路径等敏感内容。

## 14. 设计结论

Runtime Activity Stream 应作为 OpenAgent 的独立运行可观测层：

- 它解决“agent 正在做什么”的问题。
- 它不替代 Plan Mode。
- 它不重复最终回答。
- 它应该由 runtime 产生结构化事件，renderer 只负责展示。

第一版优先实现 tool activity，就能显著改善普通 agent loop 下右侧面板空白或信息不足的问题。
