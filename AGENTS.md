# Praetorium agent instructions

This file is the canonical repository guide for Codex, Claude, and other coding agents. Read it before changing the project.

## Product contract

Praetorium is a local-only desktop Owner Console for directing three project workstreams plus one Skill Director. Each delegated objective is a durable Goal that survives disposable Director and Worker sessions. The Owner should see one execution trace per Goal: analysis, plan, Worker waves, evidence assessment, review, remediation, quality gates, Owner decisions, and the terminal report. Durable state belongs to Hermes Kanban and Praetorium's local state files.

The product must answer these questions without opening another tab:

1. What objective is active?
2. What is the Director deciding, and on what public evidence?
3. Which Workers were created, what is each doing, and what depends on what?
4. What commands, observations, decisions, and verification evidence exist?
5. Does the Owner need to intervene?
6. Can the Owner steer, pause, or resume the selected Worker here?
7. Was an Owner instruction merely persisted, accepted by Hermes, or actually acknowledged by the Worker?
8. Which Goal is active, queued, cancelled, or recently terminal, and what queue control is safe now?
9. Is this Director turn finished, or is the durable Goal actually complete?
10. Did a new Owner message create work, or steer the currently selected Goal and its active Workers?

Do not regress the UI into a generic dashboard, a Kanban card wall, or a chat-only interface. The execution trace is the primary navigation; the Inspector is the primary detail and control surface.

## Non-negotiable security boundaries

- Bind HTTP only to `127.0.0.1`.
- Reject non-loopback peers and unrecognized Host headers before routing.
- Never add remote control, LAN listening, Tailscale, tunnels, proxies, webhooks, messaging adapters, gateway mode, or daemon mode.
- Hermes and Codex integration stays on local child-process stdio. Never start `hermes gateway`, `dashboard`, `serve`, or `kanban daemon`.
- Never import, launch, proxy, call, or read state from Cockpit. Similar interaction patterns must be implemented inside Praetorium with its own runtime and UI code.
- Never weaken Codex to a full-access sandbox. Worker writes are limited to the selected project and exact active board directory.
- Strip inherited remote gateway, relay, webhook, and messaging environment variables.
- Existing user project files, Git state, and Praetorium/Hermes durable state must be preserved. Never reset, clean, or discard them automatically.
- External actions, destructive changes, publication, secrets, and authority outside the active objective remain Owner decisions.

## Orchestration rules

- The stable semantic layer is three Project Directors plus one Skill Director.
- A Director is structurally read-only. It analyzes and returns a validated control envelope; the host creates Worker tasks.
- A Director inference turn is a disposable checkpoint, not the Goal lifecycle. Valid delegated control states are `executing`, `awaiting_owner`, `complete`, and `blocked`; persisted Goal states also expose planning, evaluation, remediation, verification, and terminal status.
- Each Director owns one active Goal and a durable ordered queue. Queued Goals may be reordered, deferred, or cancelled. Retry is limited to stopped blocked or failed Goals and starts a fresh planning generation; an `awaiting_owner` Goal must resume through its exact saved decision instead of generic retry.
- The host groups actions into bounded waves. When every card in the current wave reaches a terminal task state, a fresh Director turn evaluates its public evidence and either creates another wave, requests one material Owner decision, blocks, or proposes completion.
- Every action declares `effect` as `read_only`, `workspace_write`, `external_mutation`, or `skill_activation`. Review and gate profiles are `read_only`; external and activation effects may be assigned only to write profiles.
- All write Workers use the same selected project cwd. The host serializes every write action, even for disjoint declared scopes, rejects a wave that mixes writes with reviews/gates, and applies the same fail-closed writer cap to unknown or legacy board cards. `write_scope` is an auditable task boundary, not a per-path sandbox or worktree.
- Every delegated request uses one of the nine known workflows from `lib/workflow-catalog.js` and only approved profiles and skills. Deterministic security, authorization, payment, secret, schema, data-integrity, concurrency, or public-contract signals impose a high-risk workflow floor. Workflow changes may escalate monotonically but may not discard the release, research, or skill lifecycle.
- Director analysis must publish success criteria, constraints, checked evidence, risks, unknowns, workflow alternatives, worker strategy, review strategy, and stop conditions. Do not expose private chain-of-thought.
- Worker tasks must publish concise `PLAN`, `OBSERVED`, `DECISION`, and `VERIFY` Kanban comments at meaningful checkpoints. Do not publish secrets, private chain-of-thought, or repetitive narration.
- Public communication follows the Owner's language. If an Owner request contains Korean, Director summaries and questions plus Worker task text, checkpoints, and final reports must be Korean. Keep JSON keys, schema names, enum values, identifiers, and the literal `PLAN`, `OBSERVED`, `DECISION`, and `VERIFY` markers in English so machine contracts remain stable.
- Owner comments are a live Worker steering channel. Persist a unique intervention ID before Hermes delivery, retry a failed delivery under a lease with that same ID, and distinguish `delivery_pending`, `delivery_failed`, `accepted_queued`, and `worker_observed`. Accepted delivery is not Worker acknowledgement; observation requires later Worker-authored public evidence containing the ID. Reject interventions for orphan, legacy, or terminal cards.
- Current-Goal guidance is a durable steering channel, not a new Goal. Persist its text and attachment references before action and retain it in later Director context. Direct Worker guidance reports per-Worker delivery failures without discarding the accepted guidance. Director-mediated guidance must not be injected into a Worker before the fresh Director judgment. Both modes invalidate prior exact-authority approvals and final gate state, then force fresh analysis and planning after the current Worker wave settles; an `awaiting_owner` Goal accepts only its exact decision endpoint.
- Director messages and current-Goal guidance may include bounded local image attachments. Accept PNG, JPEG, WebP, and GIF only; verify content signatures, dimensions, hashes, storage containment, and symlink safety. Persist files in Praetorium's local state, expose only bounded metadata and same-origin previews, and never place base64 image data or private model output in state summaries, events, or the activity stream.
- Pausing a running Worker must reclaim and terminate its local process before parking the task. Resuming must return it to dispatch safely.
- Goal cancellation must quiesce every owned non-terminal Worker and confirm its live status before terminalizing the Goal. Missing cached cards do not prove that a Worker stopped; a Goal with no Worker tasks may still be cancelled during an infrastructure outage.
- Implementers do not review their own work. Reviewers are fresh-context and read-only. Remediators are separate from reviewers. Relevant review evidence becomes stale after the candidate revision changes. Every materialized current review participates in the gate even when it was supplemental to the workflow minimum.
- `complete` is accepted only when success criteria have concrete quality-gate evidence and all materialized required reports are passing, host-receipted, revision-bound, and newer than the latest relevant write. A release workflow additionally requires an actually completed `external_mutation` task; readiness or approval alone is not execution. Loop limits must end in an Owner decision or an evidenced blocked state, never an endless retry.
- A terminal `blocked` decision requires observed Worker evidence and a host receipt. Synthetic evidence-read failures or evidence-free blocker prose must park the Goal for Owner review instead of converting uncertainty into a terminal claim.
- `awaiting_owner` must contain one decision that cannot be inferred safely. Persist the question and evidence, resume through `POST /api/directors/:id/goals/:goalId/decision`, and do not treat approval as authority beyond the exact staged action.
- Read one Goal through `GET /api/directors/:id/goals/:goalId`; the Director summary also exposes `goals` and `activeGoals`. Goal reads are side-effect free, while decision answers are accepted only for the matching Director and an `awaiting_owner` Goal.
- External-mutation and skill-activation actions require a standalone wave after fresh host-receipted reviews and a consistent quality gate, then park before materialization and resume only the persisted exact plan after a matching plan-, wave-, and candidate-digest approval. A changed candidate forces reevaluation. The first skill activation must be a rollback-capable limited canary. Never combine external mutation and skill activation in one approval wave.
- Candidate identity includes tracked content and all declared output paths, including ignored and not-yet-created deliverables. Reject traversal, globs, protected roots, root escapes, external symlink targets, opaque dirty submodules, oversized candidates, or files that change while hashing. Recompute the exact candidate digest immediately before an authority-bound action.
- Owner approval never widens the Worker sandbox, enables network, injects credentials, or grants writes outside the selected project/Skill Director workspace. Work that needs those capabilities must block for an explicit Owner/manual path.
- Skill development separates proposal, implementation, fresh evaluation, canary/rollout, and activation. `skill-proposal.v1` is a governance artifact; drafting or review does not imply activation authority.
- On restart, fail the interrupted disposable run but recover the durable Goal from its saved workflow, action journal, pending exact-authority plan, waves, board tasks, and evidence. Initial planning recovery uses a fresh generation, materialization recovery retains idempotency without duplicate Worker cards, and persisted pause/resume intent is reconciled before dispatch. Materializing, authority-bound, and `awaiting_owner` states remain dispatch-quiescent until recovered and revalidated.
- Allocate the shared adaptive Worker cap across ready project Directors before awaiting board I/O, and rotate the fairness cursor across ticks. A slow board must not stall another project, and a fast board must not starve it. Persist board and dispatch failure backoff separately and retain bounded zero-spawn reconciliation.
- Durable task lifecycle is authoritative. Plain chat text is not task completion; Workers must complete or block the Kanban task with concrete evidence.

## Architecture and ownership

- `server.js`: process lifecycle and loopback-only HTTP boundary
- `routes/directors.js`: Owner Console Director, durable Goal/decision, and Worker API
- `lib/director-service.js`: Director registry, durable Goal lifecycle, bounded context, wave materialization, scheduler, restart recovery, Worker controls
- `lib/goal-supervisor.js`: Goal normalization, wave/task synchronization, evidence snapshots, acceptance checks, and fresh supervision prompts
- `lib/director-actions.js`: schema extraction and validation for Director checkpoints
- `lib/director-attachments.js`: bounded local image validation, storage, integrity checks, and preview reads
- `lib/owner-language.js`: Owner-language detection and public communication contract
- `lib/candidate-snapshot.js`: bounded candidate identity, declared-output binding, and runtime-aware path safety
- `lib/workflow-catalog.js`: workflows, skills, and Worker profile catalog
- `lib/hermes-runtime.js`: stdio-only Hermes adapter and sandbox environment
- `lib/local-only.js`: loopback peer and Host invariants
- `lib/praetorium-config.js`: project slots and configuration migration
- `index.html`, `src/`, `vite.config.js`: production React/Vite Owner Console source
- `dist/`: generated UI served by the loopback Node server and packaged by the desktop shell
- `css/owner-console.css`, `js/owner-console.js`: legacy reference UI; not served as the production console
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
- Show the durable Goal status, wave boundaries, fresh Director reassessments, gate freshness, and pending Owner decision. Never label a completed Director turn as completed work.
- Keep active, queued, and recent Goals selectable. Show queue position and explicit receipts for reorder, defer, cancel, and retry; render Owner cancellation as cancelled even when the durable compatibility status is `failed`.
- Show concrete product language: Worker name, task, evidence, command, status, dependency, and elapsed time.
- Do not hide actual Worker execution behind a completion summary. Show structured public checkpoints, extracted observed steps, raw local log, events, and final evidence.
- Render live Worker output through a read-only local terminal view. Never attach browser input or a PTY to the Codex app-server JSON-RPC transport; Worker steering uses the durable intervention or Director-guidance APIs only.
- Use the same-origin SSE activity stream for bounded public lifecycle/checkpoint receipts and reconnect/resync state. Never present raw model output or private chain-of-thought as live reasoning.
- Display intervention delivery separately from Worker acknowledgement: pending is amber, failed is red, accepted/queued is a receipt only, and observed requires Worker evidence. A delivery failure that will retry must tell the Owner not to resend and create a duplicate instruction.
- On wide layouts, make the Inspector width and activity-region height directly adjustable with pointer-draggable splitters. Double-click restores defaults, focused splitters support Arrow-key adjustment, and clamped values persist in `localStorage`; polling and rerendering must not reset or jitter the chosen layout.
- Preserve readable text scale controls, keyboard focus, responsive layout, empty/loading/error states, and an expandable detail view.
- Avoid speculative metrics, decorative card grids, tiny body text, duplicate information, and controls that are not backed by real APIs.
- Historical tasks may not have structured public comments; the UI must degrade to raw logs and lifecycle evidence without pretending otherwise.

## Working rules

- Search with `rg` or `rg --files` first.
- Use `apply_patch` for source edits.
- Preserve unrelated worktree changes and inspect overlapping diffs before editing.
- Do not use destructive Git commands.
- Cross-machine setup must make the Owner choose between fresh state and an offline transfer of `%LOCALAPPDATA%\PraetoriumData` plus the applicable Hermes Kanban state. Never merge or replace live state implicitly, copy credentials, or carry over runtime binaries as state; preserve a target backup and revalidate project paths and the reviewed, version-matching release after transfer.
- Keep the server local-only during development and tests.
- When changing a backend route or runtime primitive, add or update tests in the same change.
- When changing Goal or task contracts, ensure old persisted goals, runs, waves, and tasks still recover and render safely.

## Required verification

For ordinary source changes, run:

```powershell
node --check .\server.js
node --check .\routes\directors.js
node --check .\lib\director-service.js
node --check .\lib\director-attachments.js
node --check .\lib\hermes-runtime.js
npm run build
npm test
git diff --check
```

For installer or release changes, also:

```powershell
cargo check --manifest-path .\src-tauri\Cargo.toml
npm run tauri build -- --bundles nsis
```

Before a release, validate skill files, parse PowerShell scripts, verify package/Cargo/Tauri/installer/tag version parity, verify hostile Host requests receive 403, confirm port `3848` has no non-loopback listener, and exercise a real Director → Worker workflow. The exercise must queue at least two Goals, prove queue position and promotion, deliver an intervention and observe its Worker acknowledgement, pause a Worker, restart Praetorium, resume safely, and reach fresh review/gate evidence without modifying a read-only target unexpectedly.

## Current release state

`v2.0.0` is the last published binary baseline. The current source version is `v2.3.0` and adds Owner-controlled durable Goal queues, restart-safe autonomous supervision, durable intervention delivery and acknowledgement, fair cross-project dispatch, exact candidate binding, categorical high-risk workflows, and fail-closed completion evidence. Build, verify, and publish a new versioned installer before claiming these features are available through the release installer.
