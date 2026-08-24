# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Praetorium is for one technical Owner operating several local software projects on a Windows workstation, including projects whose source and toolchain live inside WSL2. This is inferred from the repository contract, installer, and the Owner's current request.

## Product Purpose

Praetorium is a local-only desktop Owner Console that turns one objective into an observable Director analysis, Worker plan, execution trace, review, remediation, and quality-gate flow. Success means the Owner can understand what is active, why it is happening, what evidence exists, and where intervention is required without opening another agent UI.

## Positioning

The product's distinct mechanism is a trace-first control surface over durable Hermes Kanban state: disposable Codex sessions perform bounded work while the Owner retains one chronological, inspectable, and steerable execution record.

## Operating Context

- Three project Director slots and one Skill Director run from a Windows desktop shell.
- A project may use the native Windows runtime or a selected WSL2 distribution and Linux path.
- Hermes profiles, boards, task lifecycle, logs, and public checkpoints provide durable operating evidence.
- The Owner regularly monitors long-running work, changes projects and runtimes, inspects role configuration, and intervenes in active Workers.

## Capabilities and Constraints

- HTTP remains bound to loopback only; remote gateways, browser terminals, messaging adapters, tunnels, webhooks, and daemon modes are outside the product.
- Windows and WSL runtimes must remain visibly distinct. A WSL path is not considered ready merely because Windows can read its UNC share.
- WSL execution uses the selected distribution's own Hermes, Codex, filesystem, shell environment, profiles, boards, and permissions.
- Existing project files, Git state, active sessions, and durable Praetorium/Hermes state must never be reset, cleaned, or discarded automatically.
- Director and reviewer read-only boundaries, Worker workspace-write boundaries, and Owner-controlled external authority remain intact.
- The execution trace remains the primary navigation and the Inspector remains the primary detail/control surface.

## Brand Commitments

The product name is Praetorium. Its voice is calm, technical, direct, and operational. Status language must describe real runtime and task state rather than decorative activity.

## Evidence on Hand

- Product and security contract: `AGENTS.md`
- Existing Owner Console: `index.html`, `css/owner-console.css`, `js/owner-console.js`
- Runtime and lifecycle implementation: `lib/hermes-runtime.js`, `lib/director-service.js`
- Role and workflow assets: `.agents/hermes-profiles/`, `.agents/skills/`, `lib/workflow-catalog.js`
- Existing tests under `tests/`

No customer claims, remote-service claims, or performance benchmarks are available and none may be fabricated.

## Product Principles

1. Show operational truth before summaries.
2. Make runtime, authority, and failure boundaries explicit.
3. Keep intervention close to the evidence that motivates it.
4. Preserve durable state while treating execution sessions as replaceable.
5. Prefer one coherent console over a collection of disconnected dashboards.

## Accessibility & Inclusion

The console must remain keyboard operable, expose visible focus and plain-language status, support text scaling and reduced motion, and provide reliable independent scrolling at the supported 900×640 minimum window as well as narrower browser widths.
