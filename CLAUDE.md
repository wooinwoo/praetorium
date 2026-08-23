# Claude Code instructions

`AGENTS.md` is the canonical repository guide. Read it completely before inspecting or changing Praetorium, and treat its product contract, local-only security boundaries, orchestration rules, UI rules, and verification requirements as mandatory.

## Claude-specific reminders

- Do not reinterpret “local app” as permission to add a remotely reachable development server. Port `3847` remains loopback-only in every mode.
- Do not bypass the validated Director analysis/action envelopes by letting a Director edit the project directly.
- Do not describe hidden chain-of-thought as a product feature. Praetorium exposes public operational reasoning through Director decision artifacts, Worker `PLAN`/`OBSERVED`/`DECISION`/`VERIFY` comments, tool/command logs, events, and evidence.
- Do not replace working Hermes task controls with mocked UI state. Owner steering, pause, and resume must remain backed by durable Kanban commands.
- Preserve existing project and orchestration state. If a change would require destructive migration, stop and request an explicit Owner decision.
- Run the verification commands in `AGENTS.md` before handing off a change.

Start with `README.md` for product and setup context, then use the source map in `AGENTS.md` to locate the owning module.
