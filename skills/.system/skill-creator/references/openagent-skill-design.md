# OpenAgent Skill Design Checklist

- `SKILL.md` is the model-readable entrypoint and must include clear trigger conditions.
- `skill.json` is optional but preferred for UI, indexing, policy, declared scripts, and resources.
- Use progressive disclosure: summarize core workflow in `SKILL.md`; move long details to `references/`, `examples/`, and `templates/`.
- Scripts must live under `scripts/` and be declared in `skill.json` before `skill_script` can run them.
- Declare script metadata honestly: runtime, risk, timeout, network, and writes.
- Skills cannot bypass OpenAgent system, approval, sandbox, git, or tool policies.
- Avoid extra README-style files unless they are directly loaded as task references.
