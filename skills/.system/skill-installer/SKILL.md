---
name: skill-installer
description: Install OpenAgent-compatible skills from a local folder, Git URL, or cloned skills pack into user, agent, or workspace skill roots.
version: 0.1.0
tags:
  - skill
  - install
  - git
risk: network
allowed-tools:
  - skill_load
  - skill_resource
  - skill_script
---

# Skill Installer

## When to use

Use this skill when the user asks to install, copy, import, or migrate a skill package into OpenAgent.

## When not to use

Do not use this skill to execute a skill's task workflow. Install first, then use the installed skill in a later run.

## Instructions

1. Determine the install source: local directory, Git URL, or repository folder that contains one or more `SKILL.md` files.
2. Determine the target scope:
   - `agent`: `~/.openagent/agents/<agentId>/skills/` for the current agent.
   - `user`: `~/.openagent/skills/` for all agents.
   - `workspace`: `<workspace>/.openagent/skills/` for the current workspace.
3. Prefer `agent` scope unless the user asks for global or workspace install.
4. Use `scripts/install_openagent_skill.mjs` for deterministic installation.
5. Do not overwrite an existing skill unless the user explicitly requests overwrite.
6. Git/network installs require OpenAgent approval because the script may clone remote content and write files.
7. After install, tell the user the destination path and that OpenAgent may need a skill refresh or app restart to pick up newly installed skills.

## Supporting files

- `scripts/install_openagent_skill.mjs`: installs one or more SKILL.md packages from local or Git sources.
- `references/install-targets.md`: target layout and safety rules.

## Output expectations

Report installed skill names, target scope, destination paths, whether overwrite was used, and any refresh/restart note.
