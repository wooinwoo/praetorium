# Praetorium

Praetorium is a local-only Owner Console for directing several real Codex workstreams with minimal human intervention. The product is organized around an observable execution trace, not a collection of chat tabs.

- One Owner Console
- Three project Directors
- One Skill Director
- Per-project native Windows or WSL2 execution
- Dynamically sized, isolated implementation and review workers
- Hermes profiles and Kanban state
- Codex app-server inference over child-process stdio

Praetorium never starts a remote-control service. Its small HTTP server is forced to `127.0.0.1`; non-loopback bind settings, peers, and Host headers are rejected. Hermes gateway, dashboard, webhook, messaging, Tailscale, daemon, browser terminal, PR, and CI/CD modes are not included in the product runtime.

## Install on the company Windows PC

`v2.0.0` is the last published binary baseline. The current `v2.1.0` source adds native WSL2 projects and the environment-management console; build it locally until the Owner publishes a signed release tag. The only expected interactive step is `codex login` when the machine has not already been authenticated.

```powershell
git clone https://github.com/wooinwoo/praetorium.git
cd praetorium
npm ci
npm test
npm run tauri build -- --bundles nsis
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

## How it works

```text
Owner
└─ Praetorium Owner Console (127.0.0.1:3848)
   ├─ Project Director 1 → isolated implementer/review/fix workers
   ├─ Project Director 2 → independent worker pool and quality loop
   ├─ Project Director 3 → independent worker pool and quality loop
   └─ Skill Director     → evaluated skill lifecycle
```

Each Owner message starts a fresh Director Codex app-server session. Praetorium injects only a bounded handoff of the last eight completed turns, capped at 24,000 characters. This avoids unbounded Director context growth and Hermes `v0.20.5` resume stalls.

Hermes stores durable profiles, boards, tasks, results, and worker lifecycle state. The scheduler evaluates all three project boards independently every ten seconds, so a slow or broken project does not stall the others. Parallelism is selected from ready work, running work, CPU, and memory, capped at 12 workers.

## Owner Console

Open the desktop app or browse locally to `http://127.0.0.1:3848`.

The single product screen contains the three project Directors, Skill Director, current objective, execution trace, Owner decision queue, detail inspector, and Director conversation. There are no worker tabs to manage.

The central trace is ordered as:

```text
Owner objective
→ Director requirement/risk analysis
→ Director workflow and worker plan
→ Worker execution, review, remediation, and gates
```

Selecting a Director checkpoint exposes its public decision journal: success criteria, evidence, constraints, risks, alternatives, worker split, review strategy, and stop conditions. Selecting a Worker exposes the full task contract, live public reasoning checkpoints, observed commands, raw worker log, lifecycle events, acceptance criteria, and final evidence.

New Worker tasks are required to publish concise `PLAN`, `OBSERVED`, `DECISION`, and `VERIFY` comments at meaningful checkpoints. These are public operational artifacts, not private chain-of-thought. Historical tasks still expose their raw Hermes log even when they predate the structured checkpoint contract.

The Owner can intervene without opening a Worker tab:

- add a durable instruction to a queued or blocked task;
- steer a running Worker in-place through Hermes' live comment bridge (normally observed within about six seconds);
- immediately pause a running Worker, which terminates its current local process and parks the task for Owner input;
- resume a paused task and return it to automatic dispatch;
- enlarge the Inspector or change global text scale for long traces.

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

## Approval and sandbox policy

Praetorium is designed for background operation without approval popups inside the authority already granted by the Owner:

- every Codex app-server remains in `workspace-write`, never full-access;
- the selected project is the app-server thread root;
- only the active Hermes board directory is added as an extra writable root;
- sandboxed shell network access is disabled for Director and worker runs;
- inherited gateway, relay, webhook, and messaging environment variables are stripped;
- external actions, new authority, irreversible operations, and material product decisions remain Owner decisions;
- unattended escalation without a local decision path fails closed.

Worker intervention does not broaden authority. A mid-run Owner note may narrow or redirect work inside the existing project objective, but new external authority, destructive operations, remote access, or publication still requires an explicit Owner decision.

Praetorium exit and update are session-safe. Tray Quit asks the backend for a fresh Director/Worker activity check and refuses to exit while execution is active. The NSIS updater aborts when Praetorium or its loopback server is still running; it never uses force-kill or child-tree termination.

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

The development server is available only at `http://127.0.0.1:3848`. Static UI changes are served directly; Node service changes require a restart. Persistent Director and project state is read from `%LOCALAPPDATA%\PraetoriumData`, while Hermes boards and logs remain in the selected Windows or WSL Hermes data directory.

Useful verification commands:

```powershell
node --check .\js\owner-console.js
npm test
git diff --check
```

The test suite covers Director control-envelope validation, stable project-to-Director assignment, bounded handoff, durable task materialization, board caching, worker concurrency, local-only policy, WSL launch boundaries, live task evidence, Owner intervention, pause/resume commands, and route behavior.

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
- Non-loopback socket peers are rejected before routing.
- Host headers are limited to `localhost`, `127.0.0.1`, and IPv6 loopback forms.
- No LAN discovery, remote-connect route, login token, proxy, or remote bridge is registered.
- State-changing requests require a same-host Origin when an Origin or Referer is present.
- Hermes child processes use argument arrays with `shell: false`.
- Director state and project assignment are written atomically; interrupted runs recover as failed on restart.
- Project identities are unique and Director slots are stable, so deleting and later reconnecting a same-named repository cannot inherit another project's board or execution history.
- Project removal refreshes Hermes state and fails closed while any non-terminal task remains.
- App exit and update never force-terminate the Node/Hermes/Codex process tree.
- Existing user project changes are never reset or discarded by the installer.
- Worker logs and comments are read from local Hermes Kanban state and are never relayed to a remote Praetorium service.

## Source map

- `index.html`, `css/owner-console.css`, `js/owner-console.js`: trace-first Owner Console
- `lib/director-service.js`: Director lifecycle, public analysis checkpoint, task graph materialization, board scheduler, Worker intervention
- `lib/director-actions.js`: strict Director analysis and action-envelope extraction/validation
- `lib/workflow-catalog.js`: six built-in workflows, twelve operating skills, approved Worker profiles
- `lib/hermes-runtime.js`: local Hermes process adapter, task evidence/logs, comments, pause/resume primitives
- `lib/wsl-runtime.js`: WSL2 distribution discovery, project validation, readiness diagnostics, and injection-safe native launch bridge
- `routes/directors.js`: local Director, board, trace, intervention, and control HTTP API
- `.agents/skills/`: Director, reviewer, remediation, release, and quality-gate skills
- `.agents/hermes-profiles/`: Director and Worker role profiles
- `scripts/bootstrap-director-system.ps1`: deterministic local profile, skill, and board setup
- `scripts/patch-hermes-codex-runtime.ps1`: pinned Hermes/Codex bridge patches
- `scripts/bootstrap-wsl-runtime.mjs`: idempotent WSL profile, skill, board, and local-only policy bootstrap
- `src-tauri/`: Windows/macOS desktop shell and installer packaging

Repository automation instructions live in `AGENTS.md`; `CLAUDE.md` points Claude-based coding sessions to the same source of truth.

## Release

Tags matching `v*` run the active test suite and build Windows NSIS and macOS DMG artifacts. Release assets include SHA-256 checksum files. The company-PC bootstrap currently supports Windows; macOS packaging remains available for the desktop shell.

The `v2.0.0` installer is the last published binary baseline. The current source version is `v2.1.0`; create a reviewed release before advertising or using the versioned bootstrap installer on another machine. For development or continuation now, clone the working branch and run the local-development steps above.

License and internal deployment policy follow the repository and company policy.
