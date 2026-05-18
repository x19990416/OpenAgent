# Approval Scope 语义

OpenAgent 的审批按钮不能把一次安全确认误解为“后续所有风险操作都放行”。审批授权必须按作用域和操作特征匹配。

## 按钮语义

| 按钮 | scope | 行为 |
| --- | --- | --- |
| 批准并继续 | `once` | 只批准当前 pending approval 对应的一次 tool 调用。 |
| 本会话允许 | `session` | 在当前 `threadId/session` 内，对同类操作自动通过。 |
| 始终允许 | `always` | 在当前 app runtime 生命周期内，对同类操作自动通过；后续可扩展为 settings 白名单持久化。 |
| 拒绝 | - | 拒绝当前调用，不创建授权规则。 |

## 授权匹配规则

授权规则不能只存一个全局布尔值，必须至少匹配：

- `actionType`：例如 `external-path-read`、`external-path-write`、`shell`。
- `access`：`read` / `write` / `execute`。
- `targetPath`：如果审批请求包含路径，后续请求必须命中同一目标。
- `recursive`：如果授权是递归路径，后续路径可匹配该目录前缀；否则只匹配精确路径。
- `threadId`：`session` scope 必须限制在同一个 thread/session；`always` 不限制 thread。

## 路径归一化与 symlink 边界

审批判断不能只依赖 `path.resolve()` 这类字符串级路径归一化。对于本地文件和 shell cwd：

- 读已有文件/目录、执行已有 cwd 时，应使用真实路径（`realpath`）判断是否位于 workspace 内。
- 写已有文件时，应使用目标真实路径判断是否位于 workspace 内。
- 写不存在文件时，应解析最近的已存在父目录真实路径，再拼接待创建路径判断边界。
- workspace 内 symlink 指向外部目录/文件时，必须按外部路径处理并触发审批。
- 审批请求里展示的 `targetPath` 应尽量是真实目标路径，避免用户批准的是 workspace 内表象路径但实际写到外部位置。

## 当前实现边界

第一版实现只做内存授权：

- `session` 和 `always` 都在当前 RuntimeService / app 运行期间生效。
- app 重启后授权消失。
- 不提供 settings 白名单管理 UI。
- 不改变 tool-level policy；具体工具仍可继续触发更细的审批。

后续如果需要真正“始终允许”，应把 `always` grant 落到 settings，并提供查看、撤销、按路径管理的 UI。
