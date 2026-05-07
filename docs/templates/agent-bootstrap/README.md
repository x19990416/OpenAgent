# Agent Bootstrap Templates

本目录提供初始化新智能体时使用的长期上下文模板。

创建新智能体时，建议复制以下三个文件到：

```text
~/.openagent/agents/<agentId>/
├── SOUL.md
├── USER.md
└── MEMORY.md
```

文件定位：

- `SOUL.md`：Agent 自身设定、行为原则、能力边界。
- `USER.md`：用户长期偏好、协作习惯、稳定事实。
- `MEMORY.md`：项目/任务经验、踩坑、验证结论、复用索引。

详细设计见：

```text
docs/memory.md
```
