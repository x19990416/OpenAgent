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
4. Every new or updated skill should declare a semantic version in both `SKILL.md` frontmatter and `skill.json`. Default to `0.1.0` for new skills, or use the user-provided version. Keep both files in sync.
5. Skills must be created only under one of the discoverable skill roots:
   - Default/current agent scope: `~/.openagent/agents/<agentId>/skills/<skill-name>/`
   Do not create skill packages under the workspace root or workspace `skills/` directory, such as `<workspace>/<skill-name>/` or `<workspace>/skills/<skill-name>/`.
6. If scaffolding a new package, use `scripts/init_skill.mjs` after choosing the destination path. When no destination is explicitly requested, default to the current agent skill root.
7. If writing files directly with `write_file`, every path must stay inside one skill package under the agent skill root or workspace `skills/` root.
8. If editing an existing skill, preserve user content and update `skill.json` only when metadata, resources, or scripts changed.
9. Do not add secrets, machine-local credentials, or hidden policy bypasses to a skill.
10. If a skill needs user-specific parameters, credentials, tokens, account/password values, endpoint URLs, or other local configuration, require the skill script to read them from `.env` in that skill's root directory. Do not hard-code these values in `SKILL.md`, `skill.json`, scripts, templates, examples, or generated output.
11. Treat root `.env` and `.env.example` as private/local config files, not progressive-disclosure resources. Do not add them to `skill.json.resources`; only declare resources whose paths are under `templates/`, `references/`, `examples/`, or `assets/`. If the agent needs readable config guidance, create a sanitized file such as `references/config.md` with placeholder names only.
12. Skill scripts must be declared in `skill.json`; mark `runtime`, `network`, `writes`, `risk`, and `timeoutMs` honestly.
13. If a script needs public packages, declare them as structured dependencies in `skill.json.scripts[].dependencies` (for example `pip: ["pypdf"]` or `npm: ["some-package"]`) and optionally add `requirements.txt` / package metadata. Do not use `.env` for public package dependencies.
14. `skill-creator` is the governed authoring path for skill packages. Do not delegate skill creation/scaffolding to `pi_coding_agent`; use this skill's templates/scripts and `write_file` inside the allowed skill root.

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
- validation performed, including the declared version
