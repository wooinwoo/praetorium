---
name: Praetorium Owner Console
description: A trace-first local operations console for inspecting and steering Director and Worker execution.
colors:
  matte-void: "#0b0d12"
  navigation-night: "#0e1117"
  surface: "#121620"
  surface-subtle: "#171c27"
  surface-hover: "#1b2130"
  text-primary: "#f0f2f7"
  text-secondary: "#c5cad6"
  text-muted: "#9ba4b6"
  text-faint: "#778297"
  hairline: "rgba(255,255,255,.085)"
  hairline-strong: "rgba(255,255,255,.14)"
  owner-violet: "#8b7cf6"
  owner-violet-hover: "#978afa"
  owner-violet-soft: "rgba(139,124,246,.13)"
  runtime-green: "#49c78e"
  runtime-green-soft: "rgba(73,199,142,.12)"
  waiting-amber: "#e7b85a"
  waiting-amber-soft: "rgba(231,184,90,.12)"
  failure-red: "#ed6d7d"
  failure-red-soft: "rgba(237,109,125,.12)"
  runtime-blue: "#65a7ed"
  light-canvas: "#f5f6f8"
  light-navigation: "#f0f1f4"
  light-surface: "#ffffff"
  light-surface-subtle: "#f7f8fa"
  light-surface-hover: "#eef0f5"
  light-text-primary: "#181b22"
  light-text-secondary: "#3f4653"
  light-text-muted: "#687083"
  light-text-faint: "#626c7c"
  light-hairline: "rgba(22,28,40,.10)"
  light-hairline-strong: "rgba(22,28,40,.17)"
  light-owner-violet-soft: "rgba(99,82,216,.10)"
  light-runtime-green-soft: "rgba(29,145,94,.10)"
  light-waiting-amber-soft: "rgba(174,117,16,.10)"
  light-failure-red-soft: "rgba(207,67,84,.10)"
typography:
  headline:
    fontFamily: "Inter, Pretendard, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(1.28rem, 2vw, 1.72rem)"
    fontWeight: 600
    lineHeight: 1.24
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Inter, Pretendard, Segoe UI, system-ui, sans-serif"
    fontSize: ".96rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter, Pretendard, Segoe UI, system-ui, sans-serif"
    fontSize: ".75rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Inter, Pretendard, Segoe UI, system-ui, sans-serif"
    fontSize: ".66rem"
    fontWeight: 600
    lineHeight: 1.4
  mono:
    fontFamily: "Cascadia Code, SFMono-Regular, Consolas, monospace"
    fontSize: ".63rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: ".035em"
rounded:
  metadata: "5px"
  compact: "7px"
  control: "8px"
  panel: "10px"
  focus: "12px"
  dialog: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "18px"
  section: "24px"
  content: "28px"
  wide: "42px"
components:
  button-owner:
    backgroundColor: "{colors.owner-violet}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "38px"
  button-owner-hover:
    backgroundColor: "{colors.owner-violet-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "38px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "38px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "40px"
  selected-row:
    backgroundColor: "{colors.owner-violet-soft}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.panel}"
    padding: "9px 10px"
  runtime-badge:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.metadata}"
    padding: "3px 6px"
---

# Design System: Praetorium Owner Console

## Overview

**Creative North Star: "The Evidence Rail"**

Praetorium is an operational console, not a marketing dashboard. Its visual hierarchy follows the work itself: choose a Director at left, scan the chronological execution trace in the center, and inspect evidence or act at right. Dense information remains calm through matte near-black surfaces, restrained type, hairline division, and small semantic markers rather than through decorative cards.

Dark is the default and most characteristic theme; the shipped light theme is a fully supported operational alternative, not a separate identity. Both themes preserve the same hierarchy, spacing, semantic colors, and interaction model. Violet marks Owner-controlled focus and action. Green reports affirmative runtime or execution truth and must never become a general call-to-action color.

This file documents the shipped implementation and is authoritative for future Owner Console work. It explicitly supersedes conflicting guidance in `design-system/praetorium/MASTER.md`: the bento showcase, hero/value-prop sequence, floating or bottom CTA, green primary CTA, lifted hover cards, and white modal model are not part of the shipped product. Non-conflicting accessibility advice in that file still applies.

**Key Characteristics:**

- Trace-first chronology with evidence and controls kept adjacent.
- Near-black matte dark surfaces plus an equivalent low-glare light theme.
- Restrained violet for Owner selection, focus, intervention, and committed action.
- Green reserved for observed readiness, active execution, completion, and connectivity.
- Hairline borders and tonal layering at rest; shadows only for true overlays.
- Compact sans-serif prose paired with monospace operational metadata.
- Windows and WSL shown as distinct execution environments, never interchangeable paths.

## Colors

The palette is neutral and low-chroma so status and authority colors remain legible signals. The frontmatter is the normative token source; the light tokens replace the corresponding dark canvas, surface, text, hairline, and semantic soft-fill roles while the solid semantic accents remain stable.

### Primary

- **Owner Violet:** Use for active Director/profile rows, keyboard focus, text carets, selected trace content, Owner/Worker intervention controls, send/connect actions, and the brand mark. Keep its footprint small enough that it reads as authority rather than decoration.
- **Owner Violet Soft:** Use behind selected or Owner-controlled regions. Pair it with a hairline violet edge when selection needs stronger definition.

### Secondary

- **Runtime Blue:** Distinguishes WSL runtime badges, read-only access, plan evidence, and observed command markers. Blue is categorical or evidentiary; it is not a second CTA color.
- **Waiting Amber:** Marks queued/ready-to-start work, setup required, pending Owner decisions, intervention delivery in progress, warnings, and write-capable authority.
- **Failure Red:** Marks failed, blocked, cancelled, offline, dangerous, destructive, or failed intervention delivery. Use text, a dot, or a single hairline edge before using a filled region.

### Neutral

- **Matte Void / Navigation Night:** Establish the dark canvas and fixed navigation rail.
- **Surface / Surface Subtle / Surface Hover:** Separate the Inspector, controls, compact rows, and hover states through tone rather than elevation.
- **Primary / Secondary / Muted / Faint Text:** Form a four-step information hierarchy. Paths, descriptions, timestamps, and supporting labels move down this scale; operationally important values stay at primary or secondary.
- **Hairline / Hairline Strong:** Divide panes, rows, fields, and selected containers without turning every region into a card.
- **Light Canvas Family:** Mirrors the neutral hierarchy in light mode. Do not convert the console to pure-white page sections or dark text on saturated fills.

### Named Rules

**The Green Is Runtime State Rule.** Green means an observed runtime or execution fact is affirmative: connected, active, running, ready, accepted, observed, or complete. An accepted intervention receipt confirms only Hermes delivery; its copy must not imply Worker acknowledgement. Never use green for a recommendation, generic button, promotion, selection, or decorative accent.

**The Violet Is Authority Rule.** Violet means the Owner can focus, select, steer, or commit. It must remain rarer than neutral structure and must not replace status semantics.

**The Theme Parity Rule.** Light mode changes neutral surfaces, text contrast, and semantic soft fills; solid status and authority colors keep their meaning. It must preserve trace hierarchy, control placement, and density.

## Typography

**Display Font:** None; the console deliberately avoids display typography.

**Body Font:** Inter with Pretendard, Segoe UI, and system UI fallbacks.

**Label/Mono Font:** Cascadia Code with SFMono-Regular and Consolas fallbacks.

**Character:** The sans stack keeps Korean and English operational prose compact and neutral. Monospace marks machine-shaped content and coordinates scanning; it is not a blanket “developer aesthetic” applied to every label.

### Hierarchy

- **Headline** (600, fluid 1.28–1.72rem, 1.24): One mission title. Keep it compact, balanced, and capped at roughly 76 characters per line.
- **Title** (600, about .96rem, 1.4): Pane and section headings, Inspector headings, and management-panel headings.
- **Body** (400, about .75–.8rem, 1.55–1.65): Descriptions, evidence, help text, and Inspector prose. Reading blocks stay near 68–72 characters wide.
- **Label** (500–600, about .61–.73rem): Control text, row titles, field labels, and compact state copy.
- **Mono** (400–600, about .55–.68rem): Paths, task and run IDs, board names, commands, timestamps, counters, runtime badges, keyboard hints, and uppercase overlines. Use tabular numerals for counts and elapsed time.

### Named Rules

**The Metadata Has a Texture Rule.** Use monospace only when the content behaves like coordinates, evidence, or machine state. Human instructions and decisions remain sans-serif.

**The No Hero Type Rule.** Operational hierarchy tops out at the mission headline. Do not introduce oversized display copy, promotional subheads, or centered hero text.

**The Owner Language Rule.** Match public operational prose to the Owner's language. Korean Owner input yields Korean Director summaries and questions and Korean Worker task text, checkpoints, and reports. Machine-shaped contracts never change locale: JSON keys, schema names, enum values, IDs, and the literal `PLAN`, `OBSERVED`, `DECISION`, and `VERIFY` markers remain English and keep their monospace treatment.

## Layout

The desktop shell is a fixed-height three-column grid beneath a 68px top bar. Its default columns are a 248px Director rail, a central trace with a 520px minimum, and an Inspector clamped between 390px and 470px at roughly 30vw. The shell itself never scrolls; the Director list, mission trace, Inspector, conversation stream, dialog bodies, profile browser, and raw logs own their relevant scroll surfaces. Stable scrollbar gutters and contained overscroll prevent adjacent panes from jumping or chaining unexpectedly.

The center pane uses 28px vertical padding and fluid horizontal padding from 22px to 42px. Its rhythm is compact: 4–12px within a datum or control, 16–18px within a container, and 24–28px between operational sections. The chronological trace is a vertical rail with 31px markers, one-pixel connectors, shallow indentation for child work, and time/status aligned at the trailing edge. Detail opens in the Inspector; it does not replace the trace as primary navigation.

At 1280px and below, the sidebar reduces to 210px and the Inspector to 390px. At 1040px and below, the Director rail becomes a 62px icon/index rail with hover and keyboard tooltips, nonessential top-bar signals collapse, and the Inspector remains a 360px third column. At 820px and below, the Inspector leaves the grid and becomes a right-edge overlay below the top bar, opened by an explicit toggle and focused programmatically; the trace remains visible underneath. At 560px and below, the top bar and rail tighten to 60px and 48px, trace metadata wraps beneath its row, forms and runtime details stack, and primary task actions expand to usable widths.

The supported 900×640 operating window must retain independent scrolling and access to the composer, Inspector, and management controls. At narrow widths, interactive controls have a minimum 44px touch target. Text scale is user-controlled from 90% to 125% and persisted; layouts must tolerate the full range without hiding evidence or creating page-level horizontal scrolling.

### Named Rules

**The Splitters Stay Put Rule.** On wide layouts, a vertical splitter on the Inspector boundary changes Inspector width continuously while dragged, and a horizontal splitter on the activity boundary changes activity-region height. Both separators are keyboard-focusable and accept Arrow keys for the matching dimension. Values are clamped to preserve usable adjacent panes, saved in `localStorage`, and restored without rerender jitter. Double-click restores the documented default. At overlay breakpoints, the Inspector splitter is inactive because width is governed by the responsive overlay.

**The Trace Owns the Center Rule.** Summaries may orient the Owner, but chronological evidence remains the main canvas and the stable return point.

**The Inspector Stays Adjacent Rule.** Put explanation, raw evidence, intervention, pause/resume, and conversation beside the selected trace item. On narrow screens, preserve the same relationship in the right-side overlay rather than creating a separate dashboard route.

**The Runtime Has a Place Rule.** Show the active runtime near mission context and project identity. Windows and WSL labels, paths, diagnostics, and setup guidance must not be collapsed into a generic “local” state.

## Elevation & Depth

Praetorium is flat by default. Depth comes from tonal steps and one-pixel hairlines, not from a stack of floating cards. The only persistent accent shadow belongs to the compact brand mark. Strong shadows are reserved for Inspector overlays, dialogs, tooltips, and transient toasts; modal backdrops darken and blur the underlying console because they suspend the current operating context.

### Shadow Vocabulary

- **Accent Mark** (`0 7px 20px rgba(97, 78, 216, .25)`): Brand mark only.
- **Floating Surface** (`0 22px 70px rgba(0, 0, 0, .38)`): Dialogs and compressed-rail tooltips.
- **Inspector Overlay** (`-22px 0 60px rgba(0, 0, 0, .42)`): Narrow-screen right Inspector only.
- **Toast** (`0 12px 36px rgba(0, 0, 0, .35)`): Transient status feedback only.

### Named Rules

**The Flat Until Detached Rule.** A surface receives a shadow only when it is physically detached from the shell or temporarily overlays another task. Rows, trace items, management panels, and workflow cards remain flat.

## Shapes

The form language is compact and gently rounded: 5px for metadata badges, 7–8px for controls, 10px for rows and panels, 12px for current focus, and 14px for dialogs. Circular geometry is reserved for status dots, trace markers, and step indices. One-pixel hairlines define panes, fields, rows, and modal edges; the Owner gate and danger rows may use a single semantic edge for urgency.

Badges are short labels, not decorative pills. Cards do not float, scale, or adopt oversized radii on hover. Icons are consistent 18px outline SVGs with rounded joins and caps; emoji and filled novelty icons do not belong in the console.

## Components

### Execution Trace

The trace is the signature component and primary navigation. Each node combines a numbered circular marker, task kind, concise title, one-line evidence summary, small metadata tags, status, and time. Running and complete states use affirmative status color; waiting and setup use amber; blocked and failed use red. Selection adds a restrained violet tonal background without changing the underlying status color. Child work indents by one shallow level and retains the same connector rail.

### Inspector

The Inspector is a structured evidence surface with a header, independently scrolling content, optional Owner–Director conversation, and a fixed composer. Its groups use hairline separators, uppercase mono labels, readable prose, code blocks, event lists, reasoning entries, and collapsible raw logs. Owner controls sit inside a violet-soft intervention region; destructive controls remain outlined red. Intervention receipts expose four non-interchangeable states: delivery pending is amber, delivery failed is red, accepted/queued is a confirmed Hermes receipt, and Worker observed is later Worker-authored evidence. “Large view” opens the current Inspector content in a native modal dialog.

On wide screens the Inspector is the third column and is always available. At 820px and below it is hidden until opened as a right overlay, the toggle exposes `aria-expanded`, focus moves to the pane, and Escape closes it. Do not change the overlay into a bottom sheet: command composition and evidence logs need vertical continuity and predictable width.

The Inspector-width splitter sits on the pane boundary rather than inside the content controls. It exposes separator semantics, the current clamped value, and a visible keyboard focus state. The activity-height splitter follows the same contract above the activity region; neither handle may move content merely because trace data refreshed.

### Buttons

- **Owner / Primary:** Solid Owner Violet, white text, 8px corners, restrained 600 weight, and no positional movement. Hover brightens slightly and may add a small violet shadow.
- **Secondary / Quiet:** Transparent with a hairline border and secondary text. Hover changes tone and border strength, not scale or position.
- **Danger:** Transparent red text with a red hairline; a soft red fill appears only on hover.
- **Icon-only:** 18px outline SVG centered in a square control. Always provide an accessible name.
- **Responsive:** Desktop controls are generally 38px high; narrow-screen controls become at least 44px high and wide.

### Inputs / Fields

Inputs, selects, and textareas use the current surface, a strong hairline, and 8px corners. Focus changes the border to Owner Violet and adds a three-pixel violet-soft ring; the global `:focus-visible` treatment remains available for keyboard-operated controls. The Owner composer accepts Enter to send and Shift+Enter for a line break. Runtime fields change their example and help copy: Windows expects a Windows absolute path, while WSL requires a selected distribution and a Linux absolute path inside that distribution.

### Status, Runtime, and Access Badges

Runtime badges are compact uppercase mono labels with visible text and border differences. Windows uses a violet-tinted badge; WSL uses a blue-tinted badge. These colors classify execution context, while adjacent green/amber readiness text reports health. A WSL path visible through a Windows UNC share is not a ready WSL runtime; readiness requires that distribution's Hermes, Codex, profiles, filesystem, and shell environment to pass diagnosis.

State dots always accompany plain-language state in the surrounding row, label, or accessible name. Green reports affirmative runtime/execution state, amber reports queued/setup/warning, red reports failure/block/offline, and faint neutral reports idle or unknown. Read-only access is blue; workspace-write authority is amber.

### Navigation and Management

The Director rail uses full text rows on wide screens and index marks with focusable tooltips when compressed. Active selection uses violet-soft fill and border, while its runtime state dot retains its semantic color. Each Director exposes a compact active/queued/recent Goal switcher: queue position and status remain visible, a queued Goal does not look like an inference turn, and cancelled Goals retain explicit cancelled language. Queue controls disclose their result in an adjacent receipt rather than relying on a transient toast alone. The management dialog uses native `dialog`, a fixed header, horizontal tabs with a two-pixel violet active indicator, and one independently scrolling body. Arrow Left/Right moves and activates tabs. Project, runtime, and role panes favor rows, dividers, and split views over collections of feature cards.

### Feedback and Motion

Toasts use `role="status"` and a polite live region, appear at the bottom center, and distinguish errors or success with a semantic border. The current-focus strip is also polite live content. Motion is limited to a subtle running pulse, toast arrival, hover/focus color changes, and requested smooth scrolling. Under `prefers-reduced-motion: reduce`, animation and transition duration collapses to effectively zero.

## Do's and Don'ts

### Do:

- **Do** lead with the current mission and chronological execution trace; reveal analysis, plans, commands, logs, reviews, and controls in the adjacent Inspector.
- **Do** use Owner Violet sparingly for focus, selection, steering, and committed Owner actions.
- **Do** reserve green for affirmative runtime and execution truth, and pair every colored status with text or another non-color cue.
- **Do** keep Windows and each WSL distribution explicit in badges, field semantics, paths, readiness, profiles, and setup guidance.
- **Do** preserve the dark default and maintain full contrast and semantic parity in the supported light theme.
- **Do** preserve the skip link, visible focus, native dialog behavior, live-region feedback, keyboard shortcuts, reduced-motion behavior, and 44px narrow-screen targets.
- **Do** use hairlines, neutral tone changes, compact rows, and independent scroll regions to organize dense evidence.
- **Do** use outline SVG icons and plain, operational language that describes real state.

### Don't:

- **Don't** follow the legacy bento-grid, marketing hero, value-prop card, floating-action-button, or bottom-CTA guidance from `design-system/praetorium/MASTER.md`; this document supersedes those patterns for the Owner Console.
- **Don't** use green for primary buttons, generic CTAs, selected navigation, brand decoration, or hover affordances.
- **Don't** turn the console into a card mosaic, lift cards on hover, scatter shadows across resting surfaces, add gradients, or enlarge corner radii into pill-heavy decoration.
- **Don't** hide the trace behind aggregate dashboards or make the Owner open another agent surface to understand what happened.
- **Don't** treat a Windows path, WSL Linux path, or UNC-visible path as interchangeable, and don't imply readiness without runtime evidence.
- **Don't** rely on color alone, remove keyboard focus, trap content behind fixed panes, or disable text scaling to protect a layout.
- **Don't** add oversized display type, emoji icons, layout-shifting hover transforms, or decorative motion.
- **Don't** fabricate remote-service, performance, customer, or security claims; status copy must describe observed local state.
