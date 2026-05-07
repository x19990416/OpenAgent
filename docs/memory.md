# OpenAgent 长期上下文文件定位

> 本文定义 OpenAgent 中 `SOUL.md`、`USER.md`、`MEMORY.md` 三类长期上下文文件的职责边界、适用内容和管理原则。

## 1. 总体定位

OpenAgent 的长期上下文不应该被设计成一个无限追加的普通笔记文件，而应该拆成三层：

```text
SOUL.md   -> 这个 Agent 是谁？应该怎么行动？
USER.md   -> 这个用户是谁？偏好和长期习惯是什么？
MEMORY.md -> 过去发生过什么？有哪些可复用经验？
```

一句话概括：

> **SOUL.md 定义 Agent，USER.md 定义用户，MEMORY.md 定义历史经验。**

建议统一使用大写文件名：

```text
~/.openagent/
└── agents/
    └── <agentId>/
        ├── SOUL.md
        ├── USER.md
        ├── MEMORY.md
        ├── sessions/
        └── skills/
```

不建议混用 `Memory.md`、`memory.md`、`MEMORY.md`，避免跨平台、索引和检索时产生大小写歧义。

## 2. `SOUL.md`：Agent 自身定位

### 2.1 核心问题

`SOUL.md` 回答的是：

> **Agent 应该成为什么样的 Agent？**

它是 Agent 的“人格、宪法、行为准则和能力边界”。

### 2.2 适合存放的内容

- Agent 的身份定位。
- 默认工作方式。
- 工具使用原则。
- 安全边界。
- 是否主动规划。
- 是否减少不必要追问。
- 面对不确定性时的处理方式。
- 面对代码、文件、Git、审批时的基础原则。

示例：

```md
# SOUL.md

你是 OpenAgent 桌面工作台中的主 Agent。

你应该：

- 优先帮助用户完成可落地的任务。
- 在不确定但风险较低时，做合理假设并继续推进。
- 涉及 Git 分支、删除、重置、外部路径写入时必须先确认。
- 不要让 renderer 直接感知 runtime 或具体 agent engine。
```

### 2.3 不适合存放的内容

- 某个项目的一次性 bug。
- 某次聊天总结。
- 用户个人偏好。
- 具体代码实现记录。
- 某次命令报错、构建失败等任务记忆。

### 2.4 更新原则

`SOUL.md` 应该是三类文件中最稳定的一层。

建议原则：

- 不由模型在每轮对话后自动覆盖。
- 只有用户明确要求调整 Agent 行为方式时才更新。
- Agent 可以提出修改建议，但最终应由用户确认。
- 如果需要自动化，应采用 proposal/diff/approval 模式，而不是静默写入。

一句话定位：

> `SOUL.md` 管 **Agent 自我设定和行为边界**。

## 3. `USER.md`：用户长期画像

### 3.1 核心问题

`USER.md` 回答的是：

> **这个用户长期偏好什么？以后和他协作时要注意什么？**

它不是聊天记录，而是用户偏好、习惯和稳定事实的沉淀。

### 3.2 适合存放的内容

- 用户沟通偏好。
- 开发协作习惯。
- Git 偏好。
- 文档偏好。
- 技术栈偏好。
- 项目管理偏好。
- 用户明确说过“以后都这样”的规则。
- 多次重复出现、能够稳定指导后续协作的行为模式。

示例：

```md
# USER.md

## Communication

- 用户偏好中文回答。
- 用户喜欢直接、可执行的方案，不喜欢空泛描述。
- 如果用户说“先不要开发”，应先做需求或设计分析。

## Git

- 创建、切换、发布分支前必须先确认。
- 提交信息默认用中文，除非用户要求英文。

## Development

- 用户希望 Agent 少问重复问题。
- 如果模板或项目已有明确技术栈，不要重新询问。
```

### 3.3 不适合存放的内容

- 一次性任务要求。
- 某天的临时决定。
- 未确认的猜测。
- 项目代码细节。
- 每次对话摘要。

例如：

```md
- 用户今天让我改登录页。
```

这不适合放入 `USER.md`。

但如果用户多次表达：

```md
- 用户偏好先定位根因，再改代码。
```

这就适合沉淀到 `USER.md`。

### 3.4 更新原则

`USER.md` 可以半自动沉淀，但需要筛选和去噪。

建议原则：

- 明确、稳定、长期有效的偏好才进入 `USER.md`。
- 一次性上下文只保留在 session，不进入 `USER.md`。
- 对不确定偏好先进入候选池，再根据出现次数、置信度或用户确认提升。
- 避免把用户每一句指令都永久化。

可采用候选提升机制：

```text
high confidence   -> 1 次即可候选提升
medium confidence -> 2 次出现后提升
low confidence    -> 3 次出现后提升
```

一句话定位：

> `USER.md` 管 **用户长期偏好和协作习惯**。

## 4. `MEMORY.md`：任务和项目经验

### 4.1 核心问题

`MEMORY.md` 回答的是：

> **过去做过什么？下次遇到类似任务怎么更快接上？**

它是项目经验库，不是用户画像，也不是 Agent 人格。

### 4.2 适合存放的内容

- 项目结构认知。
- 已完成的功能。
- 已验证过的命令。
- 踩过的坑。
- 某个模块的设计结论。
- 某个问题的根因。
- 下次可复用的路径、命令、注意事项。
- 特定 repo、模块、功能域的经验索引。

示例：

```md
# MEMORY.md

## OpenAgent Pi runtime

scope: /Users/guolimin/Desktop/project-git/gitlab/openagent

- runtime 入口优先看 `src/main/runtime/`。
- Pi runtime 设计文档在 `docs/pi.md`。
- Renderer 不应直接依赖 Pi SDK。
- 模型配置应走 `~/.openagent/settings/`。
- 修改 runtime 后至少运行 `pnpm typecheck`。
```

### 4.3 不适合存放的内容

- Agent 行为准则。
- 用户长期偏好。
- 原始聊天全文。
- 大段日志。
- 未整理的流水账。
- 与当前项目或未来任务复用无关的临时信息。

### 4.4 更新原则

`MEMORY.md` 可以比 `SOUL.md` 和 `USER.md` 更新更频繁，但不能变成垃圾桶。

建议原则：

- 每次任务完成后可以生成少量结构化记忆。
- 记忆条目应包含 scope、topic、summary、reuse 场景。
- 相同事实应合并或提升置信度，而不是重复追加。
- 大段原始信息留在 session JSONL，不直接写入 `MEMORY.md`。
- prompt 注入时按任务相关性检索，不应全量注入。

推荐条目格式：

```md
## 2026-05-07 OpenAgent memory management design

scope: /Users/guolimin/Desktop/project-git/gitlab/openagent
topic: memory, soul, user profile, bootstrap

### Summary

- `SOUL.md` 管 Agent 自我设定。
- `USER.md` 管用户长期偏好。
- `MEMORY.md` 管项目和任务经验。
- `MEMORY.md` 不应全量注入 prompt，应按任务检索。

### Reuse when

- 用户问 OpenAgent 长期记忆怎么管理。
- 实现 agent bootstrap、memory panel、memory.updated event。
```

一句话定位：

> `MEMORY.md` 管 **项目/任务经验和可复用上下文**。

## 5. 三者边界对比

| 文件 | 关心对象 | 回答的问题 | 稳定性 | 推荐更新方式 |
| --- | --- | --- | --- | --- |
| `SOUL.md` | Agent | 我是谁？我怎么行动？ | 最高 | 用户确认后更新 |
| `USER.md` | 用户 | 用户偏好什么？怎么配合他？ | 较高 | 筛选后沉淀 |
| `MEMORY.md` | 任务/项目 | 过去做过什么？下次怎么复用？ | 中等 | 任务后自动或半自动沉淀 |

## 6. 容易混淆的边界

### 6.1 行为规则 vs 用户偏好

例如：

```text
创建 Git 分支前必须确认。
```

如果它是 Agent 对所有用户、所有工作区都应该遵守的行为边界，可以放入 `SOUL.md`。

如果它是某个用户特别强调的协作偏好，也可以同步沉淀到 `USER.md`。

两者语义不同：

- 在 `SOUL.md`：这是 Agent 的普遍行为规则。
- 在 `USER.md`：这是当前用户的长期偏好。

### 6.2 用户偏好 vs 项目经验

例如：

```text
用户喜欢中文提交信息。
```

这是用户协作偏好，应放入 `USER.md`。

例如：

```text
OpenAgent 的 Pi runtime 主入口在 src/main/runtime/runtime-service.ts。
```

这是项目经验，应放入 `MEMORY.md`。

### 6.3 历史事实 vs 原始聊天记录

`MEMORY.md` 应该记录整理后的复用经验，而不是保存完整对话。

原始对话、tool call、日志、模型输出更适合放在：

```text
sessions/<sessionId>.jsonl
```

`MEMORY.md` 只保存未来可复用的摘要和索引。

## 7. Prompt 注入建议

这三个文件不应在每轮 prompt 中无脑全量注入。

推荐策略：

```text
SOUL.md   -> 注入稳定摘要或全文
USER.md   -> 注入稳定用户偏好摘要
MEMORY.md -> 根据 cwd、任务关键词、文件路径检索相关片段后注入
```

尤其是 `MEMORY.md`，应通过检索和摘要进入上下文，而不是全量拼接。

否则长期运行后会出现：

- prompt 过长；
- 旧信息污染当前任务；
- 不相关项目经验干扰判断；
- memory 越多，Agent 反而越不稳定。

## 8. 推荐管理方式

可以把三类文件对应到不同管理策略：

```text
SOUL.md
  - 手动编辑为主
  - Agent 可提出修改建议
  - 用户确认后更新

USER.md
  - 半自动沉淀
  - 候选池去噪
  - 达到阈值或用户确认后提升

MEMORY.md
  - 任务结束后自动生成候选
  - 按 scope/topic 归类
  - 支持检索、合并、归档
```

在 UI 上可以设计为：

```text
Memory
├── Soul
│   ├── 查看 SOUL.md
│   ├── 编辑
│   └── 变更 diff 审批
├── User
│   ├── 当前用户画像
│   ├── 候选偏好
│   ├── 接受 / 拒绝 / 合并
│   └── 按分类查看
└── Memory
    ├── 按项目
    ├── 按主题
    ├── 搜索
    ├── 最近沉淀
    └── 删除 / 合并 / 归档
```

## 9. 最终原则

OpenAgent 的长期上下文管理可以用一句话约束：

> **SOUL 稳，USER 准，MEMORY 可检索。**

具体含义：

- `SOUL.md` 不频繁变化，避免 Agent 自我设定漂移。
- `USER.md` 只沉淀稳定偏好，避免把临时要求永久化。
- `MEMORY.md` 关注复用价值，避免沦为聊天记录垃圾桶。

这三类文件边界清楚后，后续实现 agent bootstrap、memory 检索、用户偏好沉淀、设置页管理和 prompt 构建时，才不会互相污染。

## 10. `SOUL.md` 自动更新策略

`SOUL.md` 是 Agent 的长期身份和行为边界，因此不应允许模型静默覆盖。

推荐策略是：

> **检测自动化，提案自动化，写入需确认，历史可追溯，错误可回滚。**

### 10.1 触发条件

可以触发 SOUL 变更候选的情况：

- 用户明确说“写到 SOUL.md”“加入 SOUL.md”“以后这个 Agent 要……”。
- 用户为 Agent 指定持久名称，例如“你现在叫 X”“把你命名为 X”“Agent 名字设为 X”。
- 用户表达长期行为规则，例如“以后你默认先分析，不要直接改代码”。
- 用户多次纠正同类 Agent 行为，例如多次强调不要擅自创建分支。

不应触发 SOUL 更新的情况：

- “这次先别跑测试”。
- “今天先不提交”。
- “这个文件先别改”。
- 任何只对当前 session 有效的临时指令。

### 10.2 最小功能闭环

OpenAgent 第一版 SOUL 更新功能采用 **LLM 语义判断 + proposal 审批模型**：

```text
用户/运行过程
  -> LLM 输出结构化 soulChangeRequests
  -> 后端校验 schema / section / risk
  -> 写入 soul-proposals.json
  -> UI 显示待审批 diff
  -> 用户接受或拒绝
  -> 接受后备份旧 SOUL.md
  -> 写入 SOUL.md managed 区域
  -> 发送 memory.updated 事件
```

关键词匹配只作为 fallback，不作为主判断逻辑。主流程应让 LLM 判断用户表达是否具有长期性、是否属于 Agent 身份或行为边界变更，再输出结构化结果：

```ts
type SoulChangeRequest = {
  shouldUpdateSoul: boolean
  updateKind:
    | 'identity'
    | 'working_style'
    | 'safety_boundary'
    | 'tool_policy'
    | 'memory_policy'
    | 'project_specific_rule'
  title: string
  reason: string
  proposedText: string
  targetSection: string
  confidence: 'low' | 'medium' | 'high'
  requiresApproval: true
  evidence?: string
}
```

代码层只负责：

- 校验结构化字段；
- 限制允许写入的章节；
- 去重；
- 生成 diff；
- 强制审批；
- 备份和持久化。

对应文件布局：

```text
~/.openagent/agents/<agentId>/
├── SOUL.md
├── soul-proposals.json
└── history/
    └── SOUL.<timestamp>.md
```

### 10.3 写入区域

为了避免自动逻辑破坏人工维护的主体内容，自动应用的 SOUL 规则优先写入：

```md
## 7. Managed Rules

<!-- managed:start -->

- 用户审批后的规则。

<!-- managed:end -->
```

人工维护区域可以继续保留在 `Identity`、`Working Style`、`Safety Boundaries`、`Tool Policy` 等章节。
