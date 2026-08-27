# Praetorium

Praetorium is a local-only Owner Console for directing several real Codex workstreams with minimal human intervention. The product is organized around an observable execution trace, not a collection of chat tabs.

- One Owner Console
- Three project Directors
- One Skill Director
- Durable Goal supervision across disposable Director and Worker sessions
- Read-only xterm Worker consoles with live local output, durable interventions, and Director-mediated steering
- Per-project native Windows or WSL2 execution
- Dynamically sized fresh Worker sessions; writes in one project cwd are serialized
- Hermes profiles and Kanban state
- Codex app-server inference over child-process stdio

Praetorium never starts a remote-control service. Its small HTTP server is forced to `127.0.0.1`; non-loopback bind settings, peers, and Host headers are rejected. Hermes gateway, dashboard, webhook, messaging, Tailscale, daemon, browser terminal, PR, and CI/CD modes are not included in the product runtime.

## Install on the company Windows PC

`v2.0.0` is the last published binary baseline. The current `v2.3.0` source adds Owner-controlled durable Goal queues, restart-safe autonomous supervision, durable Worker interventions with delivery receipts and acknowledgements, fair cross-project dispatch, exact candidate binding, and fail-closed high-risk workflows; build it locally until the Owner publishes a reviewed release tag whose tag and packaged versions match. The only expected interactive step is `codex login` when the machine has not already been authenticated.

```powershell
git clone https://github.com/wooinwoo/praetorium.git
cd praetorium
npm ci
npm test
npm run tauri build -- --bundles nsis
```

After that reviewed, matching tag and its checksummed release assets exist, run the company-PC installer from the checked-out repository:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-praetorium.ps1 -Version v2.3.0 -ProjectsRoot C:\projects
```

The versioned bootstrap script (`scripts/install-praetorium.ps1`) used for published releases:

1. installs Git and Node.js through winget when missing;
2. installs Codex CLI `0.149.0` and verifies the local Codex login;
3. downloads and checksum-verifies Hermes `v2026.8.19` / Agent `v0.20.5`;
4. checks out the exact requested Praetorium release;
5. installs 14 role profiles, 12 skills, four boards, and the pinned Codex runtime bridges;
6. downloads the Windows release installer and verifies its SHA-256 file;
7. installs and launches Praetorium, then rejects the installation if port `3848` is not loopback-only.

Praetorium is a standalone product and repository. Its durable project and Director state lives in `%LOCALAPPDATA%\PraetoriumData`, outside the desktop shell installation, so reinstalling or uninstalling the shell does not erase orchestration state.

Choose the company PC's initial state explicitly:

- **Start fresh:** run the installer and do not copy either state directory. Praetorium creates new Director/Goal state and Hermes creates new local boards.
- **Continue the current machine:** close Praetorium on both PCs, confirm no process is listening on port `3848`, back up any target-PC copies, then copy `%LOCALAPPDATA%\PraetoriumData` and Hermes' durable board state at `%LOCALAPPDATA%\hermes\kanban` from the source PC to the same locations on the company PC. Rerun the same reviewed-tag installer command to re-pin the runtime and profiles for the target `-ProjectsRoot`, then reconnect or correct project paths before resuming Goals. For a WSL runtime, transfer that distribution's `~/.hermes/kanban` separately. Do not merge live state or copy `.env`, session, or Codex credential files; complete `codex login` on the company PC.

## How it works

```text
Owner
└─ Praetorium Owner Console (127.0.0.1:3848)
   ├─ Project Director 1 → fresh implementer/review/fix sessions
   ├─ Project Director 2 → independent worker pool and quality loop
   ├─ Project Director 3 → independent worker pool and quality loop
   └─ Skill Director     → evaluated skill lifecycle
```

Each delegated Owner request creates one durable Goal. A clear request first uses a combined read-only analysis-and-plan turn; if either envelope is invalid or times out, Praetorium falls back to separate analysis and planning checkpoints. Every later evidence assessment uses a fresh Director Codex app-server turn. A completed Director turn is only a checkpoint and does not complete the Goal. Conversation-only messages remain disposable turns. Praetorium injects a bounded handoff for conversation context and a bounded durable Goal snapshot for supervision, avoiding unbounded context growth and Hermes `v0.20.5` resume stalls.

Each Director supervises one active Goal at a time because all writers for that project share one working directory. Additional delegated requests enter a durable ordered Goal queue instead of being rejected. The Owner can reorder, defer, or cancel queued Goals; terminal completion automatically promotes the next eligible Goal. A stopped blocked or failed Goal can be retried through a fresh planning generation, while an `awaiting_owner` Goal must continue through its exact pending decision. Different project Directors still run independently in parallel.

The Director emits a validated `executing`, `awaiting_owner`, `complete`, or `blocked` control decision. The host materializes `executing` actions as a bounded Worker wave. When every card in that wave reaches a terminal task state, a fresh Director turn reads its results and public evidence, then starts remediation or fresh review, asks one material Owner question, or proposes completion. Persisted Goal status makes planning, execution, evaluation, remediation, verification, waiting, and terminal state visible.

Hermes stores durable profiles, boards, tasks, results, and Worker lifecycle state; Praetorium stores the Goal, workflow, action journal, waves, decisions, evidence, and completion report. Terminal history is compacted to bounded retention windows while active, queued, approval-bound, and referenced audit state is preserved. Every credited task receives a host-observation receipt containing hashes of the Hermes task record, validation, events, runs, comments, raw log when available, and the exact evidence object credited by the gate. That receipt proves which local bytes Praetorium observed; it is explicitly not an independent attestation that a Worker-authored command-exit claim is true.

The scheduler evaluates project boards independently, so a slow or broken project does not stall the others. It checks active work promptly and exponentially backs idle boards off to a 60-second ceiling; repeated board or dispatch failures use a persisted per-project infrastructure breaker, and a bounded zero-spawn pass still reconciles orphaned Worker processes every minute. Parallelism is selected from ready work, running work, CPU, and memory, capped at 12 workers across the app. Capacity is assigned to ready project Directors before asynchronous board reads and rotates fairly across ticks, so a fast project cannot repeatedly consume every slot while another board is slow. Workers use `dir:<project cwd>`, not per-task worktrees: the host dependency-serializes every write action in a project, rejects mixed write/review waves, and also applies a fail-closed board-wide writer cap to legacy or manually created cards. Read-only review/gate-only waves and separate projects can still run in parallel. A declared `write_scope` is a task contract, not a narrower filesystem sandbox than the project root. Supervision and remediation loops are bounded; reaching a limit produces an explicit Owner decision instead of retrying forever.

After a restart, an interrupted Director turn is marked failed while its non-terminal Goal remains active. Praetorium resumes initial planning through a fresh planning generation, idempotent wave materialization, approved exact-plan execution, or evidence evaluation from persisted state and the Hermes board rather than relying on the old model session or duplicating cards. Persisted Owner pause/resume intent is reconciled before dispatch; materializing, authority-bound, and `awaiting_owner` Goals remain dispatch-quiescent until their saved contract has been recovered and revalidated.

## Owner Console

Open the desktop app or browse locally to `http://127.0.0.1:3848`.

The single product screen contains the three project Directors, Skill Director, active/queued/recent Goal switcher, current objective, execution trace, Owner decision queue, detail inspector, Director conversation, and one workspace tab for every opened Worker. The tabs do not create or own Worker sessions; they are views over the Director-managed durable tasks. Queue receipts distinguish accepted work from a Director turn that is actually running, and Owner cancellation is rendered as a separate terminal meaning rather than as an unexplained failure.

The central trace is ordered as:

```text
Owner objective
→ Director requirement/risk analysis and workflow choice
→ Worker wave
→ fresh Director evidence assessment
→ remediation / fresh review / quality gate (repeat as needed)
→ Owner decision or verified terminal report
```

Selecting a Director checkpoint exposes its public decision journal: success criteria, evidence, constraints, risks, alternatives, worker split, review strategy, gate freshness, and stop conditions. Wave boundaries distinguish task dispatch from later Director judgment. Every dispatched Worker owns a real Codex app-server thread. Selecting it opens that thread's live public session transcript in xterm: Director input, readable reasoning summaries, plans, commands, stdout/stderr, file changes, tool calls, and answers. The attached composer persists each Owner instruction and then injects it into the active thread with Codex `turn/steer`; Director-generated Worker corrections use the same path. xterm itself remains a renderer rather than an arbitrary shell PTY, and raw hidden chain-of-thought is never exposed.

The console also subscribes to bounded same-origin Server-Sent Events streams. One carries public Director run, Goal, scheduler, and output-activity receipts; the Worker console follows the managed local Hermes log file directly on Windows and uses a bounded snapshot fallback for WSL/custom runtimes. Hermes mirrors the underlying Codex item stream into that task log, and both streams reconnect and resynchronize from durable state when needed. Input uses a bounded task-scoped HTTP action and Codex `turn/steer`; there is no raw stdin, browser shell, remote-control gateway, private model output, or private chain-of-thought channel.

Owner communication follows the Owner's language. When an Owner request contains Korean, public Director summaries and questions plus Worker task text, checkpoints, and final reports are written in Korean. Machine contracts remain stable English: JSON keys, schema names, enum values, identifiers, and the `PLAN`, `OBSERVED`, `DECISION`, and `VERIFY` markers are never translated.

New Worker tasks are required to publish concise `PLAN`, `OBSERVED`, `DECISION`, and `VERIFY` comments at meaningful checkpoints. These are public operational artifacts, not private chain-of-thought. Historical tasks still expose their raw Hermes log even when they predate the structured checkpoint contract.

The Owner can intervene from the selected Worker console or its Inspector:

- add a durable instruction to a queued or blocked task;
- steer a running Worker's active Codex turn in-place through the durable comment bridge and native `turn/steer` (normally delivered within about six seconds);
- immediately pause a running Worker, which terminates its current local process and parks the task for Owner input;
- resume a paused task and return it to automatic dispatch;
- reorder, defer, or cancel a queued Goal, and safely retry a stopped blocked or failed Goal;
- answer a pending Goal decision with a listed option or a written answer, which records the decision and resumes supervision;
- steer the selected Worker directly inside its existing task boundary, or route a proposed objective/completion-condition change to the Director without first injecting it into that Worker. Director-mediated guidance is recorded durably, invalidates stale authority/gate conclusions, and receives a fresh Director judgment at the next safe checkpoint after the current wave settles. An `awaiting_owner` Goal must use its exact decision control instead;
- attach up to four local PNG, JPEG, WebP, or GIF images to a Director message or current-Goal guidance (5 MiB each, 12 MiB total); images are validated, hashed, stored locally, and exposed only through same-origin previews;
- enlarge the Inspector or change global text scale for long traces;
- drag the Inspector splitter to change its width and the activity splitter to change the activity area's height. Double-click resets a splitter, focused splitters accept Arrow keys, and both dimensions persist locally across reloads.

An Owner intervention is persisted with a unique ID before Hermes delivery. The Inspector distinguishes `DELIVERY PENDING`, `DELIVERY FAILED`, `ACCEPTED / QUEUED`, and `WORKER OBSERVED`; delivery failures retry the same ID, and accepted delivery is never presented as Worker acknowledgement. `WORKER OBSERVED` requires later Worker-authored public evidence containing that intervention ID.

The local Goal API used by this screen is:

```text
GET  /api/directors                         summary including activeGoals, queuedGoals, scheduler, and retention state
GET  /api/directors/:id/activity            bounded public SSE lifecycle/checkpoint receipts; no raw model output
GET  /api/directors/:id/goals/:goalId      one durable Goal with its bounded run history, waves, evidence, events, and decision state
POST /api/directors/:id/goals/:goalId/guidance
     { "message": "...", "attachments": [{ "name": "screen.png", "mimeType": "image/png", "dataBase64": "..." }] }
POST /api/directors/:id/goals/:goalId/decision
     { "selectedOption": "..." } or { "answer": "..." }
POST /api/directors/:id/goals/:goalId/control
     { "action": "reorder", "position": "front" | "back" | 1 } or { "action": "defer" | "cancel" | "retry" }
GET  /api/directors/:id/tasks/:taskId       one Worker task with durable Praetorium metadata and current evidence
GET  /api/directors/:id/tasks/:taskId/trace raw local Worker execution trace
GET  /api/directors/:id/tasks/:taskId/trace-stream read-only same-origin Worker trace SSE
POST /api/directors/:id/tasks/:taskId/interventions
     { "message": "..." }
POST /api/directors/:id/tasks/:taskId/control
     { "action": "pause" | "resume" }
POST /api/directors/:id/messages
     { "prompt": "...", "mode": "auto" | "delegate" | "conversation", "attachments": [...] }
GET  /api/directors/:id/attachments/:attachmentId
     same-origin validated image preview
```

The state-changing endpoints return `202 Accepted` and continue asynchronously. Decision answers are accepted only while that Goal is `awaiting_owner`; Goal cancellation and retry first prove that owned Worker cards have stopped, and orphan or terminal tasks reject new interventions. These are loopback-only, same-host application routes, not remote-control APIs.

Project slots are populated from existing configuration. On a fresh install, Praetorium discovers up to three immediate Git repositories under `PRAETORIUM_PROJECTS_ROOT` (default `C:\projects`). Environment Management can validate, discover, and connect either a Windows absolute path or a Linux path inside a selected WSL2 distribution.

For WSL2 projects, Praetorium does not run Windows tools against a UNC share. Every Director, Kanban, and Worker command is launched through `wsl.exe --distribution <name> --cd <linux-path>` and uses that distribution's own pinned Hermes, Codex, profiles, boards, permissions, and shell toolchain. The Runtimes screen distinguishes a readable path from a fully prepared execution runtime and provides the pinned setup commands when work is required.

Each WSL distribution has its own Codex login. The WSL bootstrap installs a native pinned launcher backed by Hermes-managed Linux Node, verifies `codex login status`, and opens the one-time login flow when that distribution is not authenticated. A distribution is never reported as ready from versions and profiles alone.

The Roles screen exposes all 14 installed profiles with model, reasoning effort, sandbox authority, assigned skill, purpose, and per-runtime installation status. Runtime and role configuration is therefore inspectable without opening Hermes files by hand.

## Roles and skills

Profiles:

- `project-director-1`, `project-director-2`, `project-director-3`
- `skill-director`
- `codex-implementer`
- `security-reviewer`, `convention-reviewer`, `adversarial-reviewer`
- `test-gap-reviewer`, `architecture-reviewer`, `performance-reviewer`
- `release-reviewer`, `remediator`, `quality-gate-reviewer`

Skills:

- `project-director`, `skill-director`, `context-handoff`
- `security-review`, `convention-review`, `adversarial-review`
- `test-gap-review`, `architecture-review`, `performance-review`
- `release-readiness`, `remediate-findings`, `quality-gate`

Specialist reviews are fresh-context, read-only, and bound to an exact revision or artifact digest. Implementers do not review their own work, fixers are separate from reviewers, and relevant reviews become stale after remediation changes the candidate revision.

The nine built-in workflows are quick fix, standard feature, high-risk change, research/planning, release, skill development, and high-risk variants for release, research/planning, and skill development. Deterministic security, authorization, payment, secret, schema, data-integrity, concurrency, or public-contract signals impose a high-risk floor. Workflow changes may escalate monotonically but may not discard the release, research, or skill lifecycle. A release Goal is not complete merely because readiness passed: a planned `external_mutation` task must actually finish and be observed.

The Skill Director uses the same durable supervisor and its semantic contract stages observed evidence → scoped `skill-proposal.v1` → Worker implementation → independent forward evaluation → canary/rollout decision. The host enforces the skill-development implementer, adversarial review, quality gate, and Owner completion approval; `skill-proposal.v1` remains a governance artifact rather than the outer control envelope. Drafting or editing inside the Skill Director workspace uses `workspace_write` and does not activate anything. A proposed activation, install, or publication action uses `skill_activation` and parks before task creation for exact plan-bound Owner approval. Skill activation and external mutation cannot share an approval wave.

## Approval and sandbox policy

Praetorium is designed for background operation without approval popups inside the authority already granted by the Owner:

- every Codex app-server remains in `workspace-write`, never full-access;
- the selected project is the app-server thread root;
- only the active Hermes board directory is added as an extra writable root;
- sandboxed shell network access is disabled for Director and worker runs;
- inherited gateway, relay, webhook, messaging, cloud, package-registry, source-host, API-key, token, password, and credential-file environment variables are stripped while local runtime paths and on-disk Codex login state are preserved;
- external actions, new authority, irreversible operations, and material product decisions remain Owner decisions;
- an action wave cannot combine `external_mutation` with `skill_activation`; either effect parks for its own exact-plan Owner approval;
- `external_mutation` and `skill_activation` must be a standalone wave after fresh host-receipted reviews and a consistent quality gate; their approvals bind the exact action plan, wave, and verified candidate digest, which is rechecked before execution;
- approval is a control-plane decision, not a privilege switch: the exact plan resumes without model regeneration but retains the same project-root `workspace-write`, no-network sandbox and receives no credentials or out-of-root access;
- unattended escalation without a local decision path fails closed.

Worker intervention does not broaden authority. A mid-run Owner note may narrow or redirect work inside the existing project objective, but new external authority, destructive operations, remote access, or publication still requires an explicit Owner decision. If the approved action cannot run within the already configured local sandbox, it must block for Owner/manual handling; Praetorium does not silently grant network, secrets, system privilege, or global skill-directory writes.

Praetorium exit and update are session-safe. A Windows named mutex permits one desktop instance and forwards a second launch into a focus signal instead of creating another logger or server owner. Tray Quit asks the backend for a fresh Director/Worker activity check and refuses to exit while execution is active. The desktop shell starts Node suspended, assigns it to a kill-on-close Windows Job Object, then resumes it; this contains Hermes/Codex descendants before they can spawn. The watchdog cleans the contained tree before a bounded restart, while intentional shutdown first uses the backend's graceful pending/committed flow and only tears down leftovers after the bounded grace period. The NSIS updater still aborts while Praetorium or its loopback server is active.

The pinned bridge applies only to Hermes Agent `v0.20.5` and fails closed on an unknown layout. It removes a redundant Hermes OAuth preflight while leaving the real Codex app-server login check intact, fixes the narrow Windows Kanban writable-root override, and makes the selected project override static profile working directories.

## Local development

Requirements: Node.js 22+, Rust stable, Codex CLI `0.149.0`, and the pinned Hermes installation.

```powershell
git clone https://github.com/wooinwoo/praetorium.git
cd praetorium
npm ci
npm test
npm start
```

The production-style development server is available only at `http://127.0.0.1:3848`. `npm start` builds the React/Vite source in `src/` into `dist/`, then the loopback Node server serves that generated output. Re-run `npm run build` for UI source changes and restart the Node process for service changes; use `npm run dev` only for Vite's separate local development server. Persistent Director and project state, including validated local image attachments, is read from `%LOCALAPPDATA%\PraetoriumData`, while Hermes boards and logs remain in the selected Windows or WSL Hermes data directory.

Useful verification commands:

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

The test suite covers Director control-envelope validation, durable Goal/wave supervision, ordered Goal controls, workflow gate freshness, exact candidate snapshots, Owner decisions, restart and materialization recovery, infrastructure backoff, fair shared Worker capacity, stable project-to-Director assignment, bounded handoff, board caching, Worker concurrency, local-only policy, WSL launch boundaries, intervention delivery leases and Worker acknowledgement, direct versus Director-mediated steering, read-only Worker trace streaming, pause/resume commands, evidence-free blocker handling, release execution proof, and route behavior.

Bootstrap profiles and skills:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap-director-system.ps1 -DefaultWorkdir C:\projects
```

Build the Windows desktop installer:

```powershell
npm run tauri build -- --bundles nsis
```

## Security invariants

- HTTP listens on `127.0.0.1` only; the product has no WebSocket or browser shell endpoint.
- Live activity uses a same-origin, loopback-only SSE endpoint with bounded public metadata, connection limits, heartbeat/resync behavior, and no raw inference text.
- The server acquires an atomic, token-bound single-writer lease before loading or recovering Director state; an append-only expected-token guard journal serializes stale recovery, and process-start identity distinguishes PID reuse while lookup uncertainty fails closed.
- Non-loopback socket peers are rejected before routing.
- Host headers are limited to `localhost`, `127.0.0.1`, and IPv6 loopback forms.
- No LAN discovery, remote-connect route, login token, proxy, or remote bridge is registered.
- State-changing requests require a same-host Origin when an Origin or Referer is present.
- Hermes child processes use argument arrays with `shell: false`.
- Director state, project assignment, Goals, action journals, and waves are written atomically. Interrupted disposable runs recover as failed while non-terminal Goals resume from persisted evidence and idempotent task materialization.
- Owner interventions are written durably before delivery, retried under a lease with the same identifier, and credited as observed only from later Worker-authored evidence. Orphan, legacy, and terminal cards cannot receive an unaudited intervention.
- Candidate digests include tracked content and every declared output path, including ignored or not-yet-created deliverables. Traversal, globs, protected roots, root escapes, opaque submodules, external symlink targets, oversized candidates, and files that change while hashing fail closed; exact authority plans revalidate the digest immediately before execution.
- All materialized current reviews participate in completion gates and require host-observation receipts. Synthetic or evidence-free blocker text cannot terminalize a Goal, and release readiness cannot stand in for completed external execution.
- Project identities are unique and Director slots are stable, so deleting and later reconnecting a same-named repository cannot inherit another project's board or execution history.
- Project removal refreshes Hermes state and fails closed while any non-terminal task remains.
- Normal app exit and update require a clean backend activity check and graceful shutdown; unexpected server death or a failed bounded shutdown is contained and cleaned through the desktop-owned Windows Job Object before restart or exit.
- Existing user project changes are never reset or discarded by the installer.
- Worker logs and comments are read from local Hermes Kanban state and are never relayed to a remote Praetorium service.
- Director image files stay in bounded local state storage. MIME signatures, dimensions, hashes, path containment, and symlink safety are checked before use; base64 payloads are excluded from durable summaries and activity events.

## Source map

- `index.html`, `src/`, `vite.config.js`: production React/Vite trace-first Owner Console source
- `dist/`: generated UI served by `server.js` and packaged by the desktop shell
- `css/owner-console.css`, `js/owner-console.js`: legacy reference UI, not the production console
- `lib/director-service.js`: Director turns, durable Goal lifecycle, wave materialization, board scheduler, restart recovery, Owner decisions, Worker intervention
- `lib/worker-trace-stream.js`: bounded local Worker log SSE with ownership checks, resync, backpressure, and connection cleanup
- `lib/director-attachments.js`: bounded local image validation, storage, integrity checks, and same-origin previews
- `lib/goal-supervisor.js`: Goal normalization, task/wave synchronization, evidence snapshots, acceptance checks, and supervision prompts
- `lib/director-actions.js`: strict Director analysis and action-envelope extraction/validation
- `lib/owner-language.js`: Owner-language detection and public communication contract
- `lib/candidate-snapshot.js`: bounded, runtime-aware candidate identity and declared-output binding
- `lib/workflow-catalog.js`: nine built-in workflows, twelve operating skills, approved Worker profiles
- `lib/hermes-runtime.js`: local Hermes process adapter, task evidence/logs, comments, pause/resume primitives
- `lib/wsl-runtime.js`: WSL2 distribution discovery, project validation, readiness diagnostics, and injection-safe native launch bridge
- `routes/directors.js`: local Director, Goal/guidance/decision, attachment, public activity SSE, board, trace, intervention, and control HTTP API
- `.agents/skills/`: Director, reviewer, remediation, release, and quality-gate skills
- `.agents/hermes-profiles/`: Director and Worker role profiles
- `scripts/bootstrap-director-system.ps1`: deterministic local profile, skill, and board setup
- `scripts/patch-hermes-codex-runtime.ps1`: pinned Hermes/Codex bridge patches
- `scripts/bootstrap-wsl-runtime.mjs`: idempotent WSL profile, skill, board, and local-only policy bootstrap
- `src-tauri/`: Windows/macOS desktop shell and installer packaging

Repository automation instructions live in `AGENTS.md`; `CLAUDE.md` points Claude-based coding sessions to the same source of truth.

## Release

Tags matching `v*` run the active test suite and build Windows NSIS and macOS DMG artifacts. The workflow first requires package, lockfile, Cargo, Tauri, installer-default, and tag versions to match exactly. Release assets include SHA-256 checksum files. The company-PC bootstrap currently supports Windows; macOS packaging remains available for the desktop shell.

The `v2.0.0` installer is the last published binary baseline. The current source version is `v2.3.0`; create a reviewed release with a tag that matches every packaged version before advertising or using the versioned bootstrap installer on another machine. For development or continuation now, clone the working branch and run the local-development steps above.

License and internal deployment policy follow the repository and company policy.
