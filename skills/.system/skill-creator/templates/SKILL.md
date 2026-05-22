---
name: {{name}}
description: {{description}}
version: {{version}}
tags:
  - {{tag}}
risk: read
allowed-tools:
  - skill_load
  - skill_resource
  - skill_script
---

# {{displayName}}

## When to use

Use this skill when {{whenToUse}}.

## When not to use

Do not use this skill when the task is unrelated to {{domain}}.

## Instructions

1. Load only the supporting files needed for the current task.
2. Prefer deterministic scripts for fragile or repetitive operations.
3. If this skill has any `scripts/` entry, keep `skill_script` in `allowed-tools` / `allowedTools`.
4. Load user-specific parameters, credentials, tokens, account/password values, endpoint URLs, and local configuration from `.env` in this skill's root directory from scripts only; do not hard-code them in skill files or outputs.
5. Keep outputs concise and easy to verify.
6. Do not expose `.env` or `.env.example` through `skill.json.resources`; resources must live under `templates/`, `references/`, `examples/`, or `assets/`. If configuration guidance is needed, add a sanitized `references/config.md` with placeholder names only.

## Supporting files

- Add templates, references, examples, assets, or scripts here as needed.

## Output expectations

State what changed, where outputs were written, and what validation was performed.
