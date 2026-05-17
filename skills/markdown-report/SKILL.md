---
name: markdown-report
description: Create concise Markdown reports from notes, command output, or short text snippets, with optional read-only text statistics.
version: 0.1.0
tags:
  - markdown
  - report
  - writing
risk: read
allowed-tools:
  - skill_load
  - skill_resource
  - skill_script
---

# Markdown Report

## When to use

Use this skill when the user asks for a concise Markdown report, summary, checklist, or lightweight analysis from short text input.

## When not to use

Do not use this skill for large document conversion, binary office files, or tasks that need external network access.

## Instructions

1. Clarify the intended audience only when it changes the report structure.
2. Load `templates/report.md` when a structured report is needed.
3. Use `scripts/word_count.mjs` only for deterministic read-only text statistics.
4. Keep generated Markdown copy-paste friendly.
5. Do not write files unless the user explicitly requests a target path and the relevant OpenAgent tool is approved.

## Supporting files

- `templates/report.md`: default concise report layout.
- `references/style.md`: tone and formatting guidance.
- `examples/summary.md`: example output.
- `scripts/word_count.mjs`: read-only text statistics helper.
