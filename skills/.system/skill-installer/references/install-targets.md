# OpenAgent Skill Install Targets

OpenAgent discovers skills from these roots, with higher-priority sources overriding lower-priority skills of the same name:

1. Workspace: `<workspace>/skills/`
2. Agent: `~/.openagent/agents/<agentId>/skills/`
3. User: `~/.openagent/skills/`
4. Plugin bundled skills
5. System built-in skills under the app `skills/` directory

Default to `agent` scope for personal agent-specific installs.
Use `user` only when the user wants the skill available to every OpenAgent agent.
Use `workspace` only when the skill should travel with or be scoped to the current project. Workspace installs go in the visible `skills/` directory at the workspace root, not directly in the workspace root and not under `.openagent/skills`.

Safety rules:

- Do not overwrite existing skills unless the user explicitly asks for overwrite.
- Do not install packages without a `SKILL.md` at the root or one level below the source root. Preserve `version` from `skill.json` or `SKILL.md` frontmatter and include it in install reports when available.
- Ignore `.git`, `node_modules`, `__pycache__`, and `.DS_Store` during copy.
- Treat Git installs as network + write operations requiring approval.
