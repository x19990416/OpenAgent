# Packages

Reusable OpenAgent workspace packages live here.

Current packages:

- `runtime/`: OpenAgent runtime core contracts, event bus, run/session stores, tool registry/policy/executor, prompt/context helpers, model/memory/plugin resolvers, scheduled tasks, and runtime logging.
- `planning/`: Agent Plan Mode types, persistence, service, executor, and runtime prompt helpers.
- `pi-adapter/`: Pi SDK integration layer built on `@earendil-works/pi-coding-agent`.
- `skill-runtime/`: skill discovery, parsing, prompt injection, execution tools, script executor, installer, audit log, selected-skill routing, and skill creator fast path.
- `knowledge/`: system wiki / knowledge provider services, routing, tools, LLM integration, and knowledge types.
- `plugin-runtime/`: plugin manifest/runtime framework, registry, loader, config store, context, and bridge types.
- `subagents/`: `shell_agent`, `knowledge_agent`, `pi_coding_agent`, their tool wrappers, and `SubagentService`.
- `shared-types/`: stable cross-process and cross-package DTOs shared by preload / renderer / main.
- `ui/`: reusable React workbench components, renderer view-model types, and UI helper functions.

Desktop-specific composition remains under `apps/desktop`. Packages should not import Electron app internals directly; inject desktop-only behavior from the app layer instead.
