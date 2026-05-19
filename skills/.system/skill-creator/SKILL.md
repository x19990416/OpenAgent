---
name: skill-creator
description: Create or update OpenAgent skills with SKILL.md frontmatter, optional skill.json metadata, progressive-disclosure resources, and governed scripts.
version: 0.1.0
tags:
  - skill
  - authoring
  - scaffolding
risk: write
allowed-tools:
  - skill_load
  - skill_resource
  - skill_script
  - write_file
---

# Skill Creator

## When to use

Use this skill when the user asks to create, scaffold, migrate, or update an OpenAgent skill package.

## When not to use

Do not use it for normal task execution inside an existing domain skill, or for creating OpenAgent plugins.

## Instructions

1. Confirm the skill's purpose, trigger conditions, risk level, and needed resources when missing or ambiguous.
2. Keep `SKILL.md` concise. Put long examples, schemas, API notes, and style guides under `references/`, `examples/`, or `templates/`.
3. Prefer the OpenAgent package shape: `SKILL.md` plus optional `skill.json`, `scripts/`, `templates/`, `references/`, `examples/`, `assets/`.
4. Skills must be created only under one of the discoverable skill roots:
   - Default/current agent scope: `~/.openagent/agents/<agentId>/skills/<skill-name>/`
   Do not create skill packages under the workspace root or workspace `skills/` directory, such as `<workspace>/<skill-name>/` or `<workspace>/skills/<skill-name>/`.
5. If scaffolding a new package, use `scripts/init_skill.mjs` after choosing the destination path. When no destination is explicitly requested, default to the current agent skill root.
6. If writing files directly with `write_file`, every path must stay inside one skill package under the agent skill root or workspace `skills/` root.
7. If editing an existing skill, preserve user content and update `skill.json` only when metadata, resources, or scripts changed.
8. Do not add secrets, machine-local credentials, or hidden policy bypasses to a skill.
9. If a skill needs user-specific parameters, credentials, tokens, account/password values, endpoint URLs, or other local configuration, require the skill script to read them from `.env` in that skill's root directory. Do not hard-code these values in `SKILL.md`, `skill.json`, scripts, templates, examples, or generated output.
10. Treat root `.env` and `.env.example` as private/local config files, not progressive-disclosure resources. Do not add them to `skill.json.resources`; only declare resources whose paths are under `templates/`, `references/`, `examples/`, or `assets/`. If the agent needs readable config guidance, create a sanitized file such as `references/config.md` with placeholder names only.
11. Skill scripts must be declared in `skill.json`; mark `network`, `writes`, `risk`, and `timeoutMs` honestly.

## Supporting files

- `scripts/init_skill.mjs`: creates a minimal OpenAgent skill package.
- `templates/SKILL.md`: starter SKILL.md template.
- `templates/skill.json`: starter structured metadata template.
- `references/openagent-skill-design.md`: OpenAgent-specific design checklist.

## Output expectations

When creating or updating a skill, summarize:

- skill path
- trigger description
- declared risk
- scripts/resources added
- validation performed
