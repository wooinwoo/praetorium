# Claude Code instructions

`AGENTS.md` is the canonical repository guide. Read it completely before inspecting or changing Praetorium, and treat its product contract, local-only security boundaries, orchestration rules, UI rules, and verification requirements as mandatory.

## Claude-specific reminders

- Do not reinterpret “local app” as permission to add a remotely reachable development server. Port `3848` remains loopback-only in every mode.
- Do not bypass the validated Director analysis/action envelopes by letting a Director edit the project directly.
- Do not bypass durable Goal queue controls, categorical high-risk workflow floors, exact Owner approval plans, or candidate-digest revalidation. An `awaiting_owner` Goal resumes through its saved decision contract, not a regenerated generic retry.
- Do not describe hidden chain-of-thought as a product feature. Praetorium exposes public operational reasoning through Director decision artifacts, Worker `PLAN`/`OBSERVED`/`DECISION`/`VERIFY` comments, tool/command logs, events, and evidence.
- Preserve the Owner-language contract implemented by `lib/owner-language.js`: Korean Owner input produces Korean public summaries, questions, Worker task text, checkpoints, and reports, while JSON keys, schemas, enums, IDs, and the literal `PLAN`/`OBSERVED`/`DECISION`/`VERIFY` markers remain English.
- Do not replace working Hermes task controls with mocked UI state. Owner steering, pause, and resume must remain backed by durable Kanban commands.
- Preserve pointer-draggable Inspector-width and activity-height splitters, including double-click reset, Arrow-key adjustment, clamping, and `localStorage` persistence. Background polling must not make the layout jump.
- Do not treat `accepted_queued` intervention delivery as Worker acknowledgement. Preserve the durable intervention ID and require later Worker-authored evidence before displaying `worker_observed`.
- Do not convert release readiness into fictitious external execution or evidence-read failure text into a terminal blocker. Completion and blocking claims must remain host-receipted and fail closed.
- Preserve existing project and orchestration state. If a change would require destructive migration, stop and request an explicit Owner decision.
- Treat company-PC setup as an explicit fresh-state or offline state-transfer choice. A transfer preserves backups, moves `%LOCALAPPDATA%\PraetoriumData` and the applicable Hermes Kanban state only while both apps are stopped, excludes credentials and runtime binaries, then revalidates project paths and the reviewed tag/version match.
- Do not describe releases as signed unless signing is actually added. The current release contract is a reviewed tag whose tag, package, lockfile, Cargo, Tauri, and installer versions match.
- Run the verification commands in `AGENTS.md` before handing off a change.

Start with `README.md` for product and setup context, then use the source map in `AGENTS.md` to locate the owning module.
