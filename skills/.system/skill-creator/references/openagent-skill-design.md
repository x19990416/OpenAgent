# OpenAgent Skill Design Checklist

- `SKILL.md` is the model-readable entrypoint and must include clear trigger conditions.
- `skill.json` is optional but preferred for UI, indexing, policy, declared scripts, and resources.
- Use progressive disclosure: summarize core workflow in `SKILL.md`; move long details to `references/`, `examples/`, and `templates/`.
- Scripts must live under `scripts/` and be declared in `skill.json` before `skill_script` can run them.
- Declare script metadata honestly: runtime, risk, timeout, network, and writes.
- User-specific parameters, credentials, tokens, account/password values, endpoint URLs, and local configuration must be loaded by scripts from `.env` in the current skill root. Never hard-code them in `SKILL.md`, `skill.json`, scripts, templates, examples, or generated output.
- Root `.env` and `.env.example` are private/local config files, not `skill_resource` resources. Do not declare them in `skill.json.resources`; declared resources must live under `templates/`, `references/`, `examples/`, or `assets/`. If the agent needs a readable setup guide, create a sanitized `references/config.md` with placeholder variable names only.
- Skills cannot bypass OpenAgent system, approval, sandbox, git, or tool policies.
- Avoid extra README-style files unless they are directly loaded as task references.
