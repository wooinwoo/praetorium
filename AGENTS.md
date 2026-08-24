# Praetorium agent instructions

This file is the canonical repository guide for Codex, Claude, and other coding agents. Read it before changing the project.

## Product contract

Praetorium is a local-only desktop Owner Console for directing three project workstreams plus one Skill Director. The Owner should see one execution trace per objective: Director analysis, Director plan, Worker execution, review, remediation, and quality gates. Workers are disposable sessions; durable state belongs to Hermes Kanban and Praetorium's local state files.

The product must answer these questions without opening another tab:

1. What objective is active?
2. What is the Director deciding, and on what public evidence?
3. Which Workers were created, what is each doing, and what depends on what?
4. What commands, observations, decisions, and verification evidence exist?
5. Does the Owner need to intervene?
6. Can the Owner steer, pause, or resume the selected Worker here?

Do not regress the UI into a generic dashboard, a Kanban card wall, or a chat-only interface. The execution trace is the primary navigation; the Inspector is the primary detail and control surface.

## Non-negotiable security boundaries

- Bind HTTP only to `127.0.0.1`.
- Reject non-loopback peers and unrecognized Host headers before routing.
- Never add remote control, LAN listening, Tailscale, tunnels, proxies, webhooks, messaging adapters, gateway mode, or daemon mode.
- Hermes and Codex integration stays on local child-process stdio. Never start `hermes gateway`, `dashboard`, `serve`, or `kanban daemon`.
- Never weaken Codex to a full-access sandbox. Worker writes are limited to the selected project and exact active board directory.
- Strip inherited remote gateway, relay, webhook, and messaging environment variables.
- Existing user project files, Git state, and Praetorium/Hermes durable state must be preserved. Never reset, clean, or discard them automatically.
- External actions, destructive changes, publication, secrets, and authority outside the active objective remain Owner decisions.

## Orchestration rules

- The stable semantic layer is three Project Directors plus one Skill Director.
- A Director is structurally read-only. It analyzes and returns a validated control envelope; the host creates Worker tasks.
- Every delegated request uses a known workflow from `lib/workflow-catalog.js` and only approved profiles and skills.
- Director analysis must publish success criteria, constraints, checked evidence, risks, unknowns, workflow alternatives, worker strategy, review strategy, and stop conditions. Do not expose private chain-of-thought.
- Worker tasks must publish concise `PLAN`, `OBSERVED`, `DECISION`, and `VERIFY` Kanban comments at meaningful checkpoints. Do not publish secrets, private chain-of-thought, or repetitive narration.
- Owner comments are a live Worker steering channel. Preserve the Hermes comment-injection behavior and make delivery/status clear in the UI.
- Pausing a running Worker must reclaim and terminate its local process before parking the task. Resuming must return it to dispatch safely.
- Implementers do not review their own work. Reviewers are fresh-context and read-only. Remediators are separate from reviewers. Relevant review evidence becomes stale after the candidate revision changes.
- Durable task lifecycle is authoritative. Plain chat text is not task completion; Workers must complete or block the Kanban task with concrete evidence.

## Architecture and ownership

- `server.js`: process lifecycle and loopback-only HTTP boundary
- `routes/directors.js`: Owner Console Director/Worker API
- `lib/director-service.js`: Director registry, bounded context, public analysis, task graph, scheduler, Worker controls
- `lib/director-actions.js`: schema extraction and validation for Director checkpoints
- `lib/workflow-catalog.js`: workflows, skills, and Worker profile catalog
- `lib/hermes-runtime.js`: stdio-only Hermes adapter and sandbox environment
- `lib/local-only.js`: loopback peer and Host invariants
- `lib/praetorium-config.js`: project slots and configuration migration
- `index.html`, `css/owner-console.css`, `js/owner-console.js`: trace-first local UI
- `.agents/skills/`: reusable orchestration and review procedures
- `.agents/hermes-profiles/`: role prompts and policies
- `scripts/bootstrap-director-system.ps1`: deterministic local setup
- `scripts/patch-hermes-codex-runtime.ps1`: pinned Hermes `v0.20.5` compatibility bridge
- `scripts/install-praetorium.ps1`: company-PC installer
- `src-tauri/`: desktop shell and packaging

Keep route handlers thin. Put lifecycle and policy in `DirectorService`; put CLI argument construction and identifier validation in `HermesRuntime`; put strict data-contract validation in `director-actions.js`. Never construct shell command strings from Owner input.

## UI and UX rules

- Lead with the current objective and current operational focus.
- Use the central trace for chronology and dependency; use the right Inspector for full detail and controls.
- Show concrete product language: Worker name, task, evidence, command, status, dependency, and elapsed time.
- Do not hide actual Worker execution behind a completion summary. Show structured public checkpoints, extracted observed steps, raw local log, events, and final evidence.
- Preserve readable text scale controls, keyboard focus, responsive layout, empty/loading/error states, and an expandable detail view.
- Avoid speculative metrics, decorative card grids, tiny body text, duplicate information, and controls that are not backed by real APIs.
- Historical tasks may not have structured public comments; the UI must degrade to raw logs and lifecycle evidence without pretending otherwise.

## Working rules

- Search with `rg` or `rg --files` first.
- Use `apply_patch` for source edits.
- Preserve unrelated worktree changes and inspect overlapping diffs before editing.
- Do not use destructive Git commands.
- Keep the server local-only during development and tests.
- When changing a backend route or runtime primitive, add or update tests in the same change.
- When changing task contracts, ensure old persisted runs and tasks still render safely.

## Required verification

For ordinary source changes, run:

```powershell
node --check .\js\owner-console.js
node --check .\lib\director-service.js
node --check .\lib\hermes-runtime.js
npm test
git diff --check
```

For installer or release changes, also:

```powershell
cargo check --manifest-path .\src-tauri\Cargo.toml
npm run tauri build -- --bundles nsis
```

Before a release, validate skill files, parse PowerShell scripts, verify hostile Host requests receive 403, confirm port `3848` has no non-loopback listener, and exercise a real Director → Worker workflow. The exercise must confirm live comments, task evidence, raw log visibility, and safe pause/resume without modifying a read-only target unexpectedly.

## Current release state

`v2.0.0` is the last published binary baseline. The current source version is `v2.1.0` and adds per-project Windows/WSL execution plus environment, runtime, and role-profile management. Build, verify, and publish a new versioned installer before claiming these features are available through the release installer.
