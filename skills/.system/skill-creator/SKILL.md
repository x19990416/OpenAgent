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
4. If scaffolding a new package, use `scripts/init_skill.mjs` after choosing the destination path.
5. If editing an existing skill, preserve user content and update `skill.json` only when metadata, resources, or scripts changed.
6. Do not add secrets, machine-local credentials, or hidden policy bypasses to a skill.
7. Skill scripts must be declared in `skill.json`; mark `network`, `writes`, `risk`, and `timeoutMs` honestly.

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
