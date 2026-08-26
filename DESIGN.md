---
name: Praetorium Operator Studio
description: A trace-first graphite workbench for observing and steering local Director and Worker execution.
colors:
  dark-bg: "#0d0f13"
  dark-surface-0: "#101319"
  dark-surface-1: "#14181f"
  dark-surface-2: "#191e26"
  dark-surface-3: "#202631"
  dark-border: "#262d38"
  dark-border-strong: "#343d4b"
  dark-text: "#e8ebf1"
  dark-text-soft: "#bac1cc"
  dark-muted: "#9aa4b3"
  dark-faint: "#7f8998"
  dark-accent: "#7c86f8"
  dark-accent-soft: "rgba(124, 134, 248, .13)"
  dark-accent-line: "rgba(124, 134, 248, .42)"
  dark-green: "#54c99c"
  dark-green-soft: "rgba(84, 201, 156, .12)"
  dark-amber: "#e7b760"
  dark-amber-soft: "rgba(231, 183, 96, .12)"
  dark-red: "#ef7575"
  dark-red-soft: "rgba(239, 117, 117, .12)"
  dark-blue: "#6fa8f7"
  light-bg: "#f4f5f7"
  light-surface-0: "#f8f9fa"
  light-surface-1: "#ffffff"
  light-surface-2: "#f2f4f7"
  light-surface-3: "#e9edf3"
  light-border: "#dce1e8"
  light-border-strong: "#c7ced8"
  light-text: "#1c222b"
  light-text-soft: "#4f5967"
  light-muted: "#566170"
  light-faint: "#596574"
  light-accent: "#5967df"
  light-accent-soft: "rgba(89, 103, 223, .09)"
  light-accent-line: "rgba(89, 103, 223, .32)"
  light-green: "#0f6f4f"
  light-green-soft: "rgba(24, 135, 96, .09)"
  light-amber: "#9a6818"
  light-amber-soft: "rgba(154, 104, 24, .09)"
  light-red: "#c84d50"
  light-red-soft: "rgba(200, 77, 80, .09)"
  light-blue: "#397ac8"
  primary-action: "#6570e5"
  primary-action-hover: "#7380f3"
  director-avatar: "#5862c7"
  log-bg: "#0b0d11"
  log-bg-light-theme: "#1c222b"
  log-border: "#282e37"
  log-text: "#aeb7c4"
  log-title: "#c2c8d2"
  log-muted: "#78818f"
typography:
  title:
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.35
  body:
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: ".85rem"
    fontWeight: 400
    lineHeight: 1.5
  compact:
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: ".8rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: ".75rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: ".07em"
  mono:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: ".75rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  progress: "2px"
  message-notch: "4px"
  xs: "5px"
  control: "6px"
  sm: "7px"
  compact-panel: "8px"
  panel: "9px"
  md: "10px"
  dialog: "12px"
  round: "50%"
spacing:
  micro: "3px"
  tight: "5px"
  inline: "7px"
  compact: "8px"
  control: "10px"
  block: "12px"
  panel: "14px"
  section: "18px"
  content: "20px"
  page: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-action}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.primary-action-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  button-secondary-dark:
    backgroundColor: "{colors.dark-surface-2}"
    textColor: "{colors.dark-text-soft}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  field-dark:
    backgroundColor: "{colors.dark-surface-0}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "34px"
  conclusion-preview-dark:
    backgroundColor: "{colors.dark-accent-soft}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.md}"
    padding: "13px 14px"
  live-log:
    backgroundColor: "{colors.log-bg}"
    textColor: "{colors.log-text}"
    rounded: "{rounded.md}"
    padding: "13px 14px"
---

# Design System: Praetorium Operator Studio

## Overview

**Creative North Star: "The Trace-First Graphite Workbench"**

Praetorium is a dense local operations surface, not a dashboard gallery or terminal imitation. Its hierarchy begins with durable execution truth: the selected Goal, the Director's latest conclusion, the chronological trace, the selected Worker's raw log, and the Inspector's controls remain spatially connected. The interface uses flat graphite planes, one-pixel structure, compact bilingual type, and restrained indigo authority marks so long-running work can be scanned without decorative noise.

Dark is the default theme and light is a complete token swap over the same geometry. Indigo identifies selection, focus, and Owner action. Semantic colors report observed state; they never imply activity that the local data does not provide.

**Key Characteristics:**

- A fixed-height shell with a project rail, central workbench, and evidence Inspector.
- A fixed latest-conclusion strip above an independently scrolling trace and persistent live-log drawer.
- One tab row for aggregate Trace, the complete Director conversation, and each Worker.
- Compact sans-serif interface copy, with monospace reserved for IDs, timestamps, roles, commands, and raw output.
- Persistent local preferences for theme, text scale, rail width, and Inspector width.

## Colors

The frontmatter records the exact implemented CSS theme values. Dark and light use the same semantic roles; the fixed action, avatar, and log colors remain deliberately separate from the theme accent.

### Primary

- **Authority Indigo:** `dark-accent` and `light-accent` mark current selection, tab underlines, focus outlines, and interactive emphasis. Primary buttons use the fixed `primary-action` and `primary-action-hover` values instead.
- **Selection Planes:** The matching soft and line tokens create selected rows, Owner chat bubbles, the conclusion preview, and focus-within borders without adding elevation.

### Secondary

- **Runtime Green:** Green covers active execution and successful completion. The adjacent text label must distinguish those meanings.
- **Owner-Attention Amber:** Amber marks blocked work, explicit Owner decisions, and setup needs.
- **Failure Red:** Red marks failed, errored, cancelled, offline, or delivery-failed conditions.
- **Auxiliary Blue:** The blue token is available in both themes but is not currently a primary interaction or status role.

### Neutral

- **Graphite Stack:** Background plus surfaces 0–3 establish depth through tonal steps. Surface 0 holds shell chrome, surface 1 holds foreground panels, and surfaces 2–3 carry controls and hover states.
- **Text Ladder:** Text, soft, muted, and faint form four exact contrast levels for titles, operational copy, metadata, and de-emphasized context.
- **Raw Log Palette:** Logs always use the dedicated near-black background and fixed cool-gray text, including in light mode, so raw output remains a stable machine surface.

### Named Rules

**The Authority and Status Rule.** Indigo means selection, focus, or Owner action. Green, amber, and red describe runtime state.

**The Label Carries Truth Rule.** Color is redundant support. Always pair a state dot or tint with a plain-text status label; known states use the implemented Korean localization.

## Typography

**Display Font:** None.

**Body Font:** Inter, followed by `ui-sans-serif`, Apple system fonts, Segoe UI, Noto Sans KR, and `sans-serif`.

**Label/Mono Font:** The same sans stack for labels; SFMono-Regular, Consolas, Liberation Mono, and `monospace` for machine-shaped content.

**Character:** The implemented scale is deliberately compressed. At the 16px root, it uses .75rem for status, metadata, mono labels, and times; .76rem for dense chat and error copy; .78rem for compact counts and select titles; .8rem for operational copy; .82–.86rem for small headings, controls, and body variants; .92rem for the settings title; and 1rem for Goal and Worker titles. Weight ranges from 400 for copy to 520–570 for task facts, 600–650 for controls and titles, and 700–800 for labels, brand, and avatars.

### Hierarchy

- **Title** (650, 1rem, 1.35): Goal and Worker titles. Titles remain one line and ellipsize in constrained panes.
- **Body** (400, .85rem, usually 1.5–1.6): descriptions, checkpoints, settings copy, and empty states.
- **Compact** (400, .8rem, usually 1.45–1.55): operational facts, controls, Inspector values, and trace details.
- **Label** (600–700, .75rem, 1–1.4): states, roles, timestamps, uppercase section labels, and metadata.
- **Dense Chat** (400, .76rem, 1.65): Director and Owner message bodies.
- **Mono** (400 or 700, .75–.8rem, 1–1.65): IDs, paths, roles, timestamps, commands, and raw logs only.

The text-scale control changes the root from 90% to 125% in 5% steps, so every rem-based size scales from this exact base.

### Named Rules

**The No Hero Type Rule.** One rem is the top of the operating scale; the work, not a promotional heading, owns attention.

**The Machine Content Rule.** Do not use monospace for ordinary interface prose.

## Layout

The viewport never page-scrolls. A 48px top bar sits above a fixed-height application grid. The conceptual three panes are a left Director/Goal rail, the central workspace, and the right Inspector. The rail defaults to 268px and resizes from 220px to 420px through a 5px separator. The Inspector defaults to 336px and resizes from 280px to 520px through its own 5px separator. The 42px workspace tab row spans both the center and Inspector.

The aggregate Overview is the `종합 Trace` tab. Its grid rows are the Goal header, the latest-conclusion bar, the trace viewport, and a live-log drawer. The conclusion bar is outside the trace scroller and therefore remains fixed. The trace owns vertical scrolling and follows new events only while the reader remains within 48px of the bottom; it initially shows the newest 160 events and exposes older batches explicitly. The live-log drawer occupies 30% of the remaining view, clamped from 180px to 280px, while its `<pre>` owns raw-log scrolling. The Inspector has a separate scroll container. Overview content uses an 880px centered measure; chat uses 760px messages and an 820px composer; Worker pages use a 900px centered measure.

Spacing is compact and optical rather than a strict generated scale. The preferred recurring rhythm is 3, 5, 7, 8, 10, 12, 14, 18, 20, and 24px, as captured in frontmatter. Existing fit adjustments also use 2, 4, 6, 9, 11, 13, 15, 16, 17, 22, 26, and 28px; do not create additional values without a concrete fit need.

Breakpoints are exact implementation boundaries:

- Above 1180px, the full top-bar session state and Goal progress are visible.
- From 1041px to 1180px, the three panes remain expanded but those secondary summaries hide.
- From 761px to 1040px, the rail becomes a 60px icon index, resize handles hide, and the Inspector remains at 280px.
- At 760px and below, the top bar becomes 44px, the Inspector hides, the rail remains 60px, labels compress, and key icon/tab targets become 44px. Settings becomes full-screen.

The implementation has rendered references at 1440×900 and 760×820. The product's 900×640 minimum falls in the compact-rail, visible-Inspector layout.

### Named Rules

**The Fixed Conclusion Rule.** Keep the Director's latest judgment visible above the trace; opening it must land in the complete Director conversation.

**The Independent Scroll Rule.** The shell, trace, live log, Director conversation, Inspector, Worker page, and settings body each retain their implemented scroll ownership.

## Elevation & Depth

Persistent workbench structure is flat and separated by one-pixel borders and tonal surfaces. Two resting elements use the shared shadow: the anchored Director composer and the settings dialog. Dark uses `0 20px 60px rgba(0, 0, 0, .3)`; light uses `0 20px 60px rgba(32, 40, 52, .14)`. The settings backdrop is `rgba(5, 7, 10, .66)`. Selected rows and settings navigation use a two-pixel inset indigo edge rather than lift.

### Named Rules

**The Tonal Structure Rule.** Use surfaces and one-pixel borders for ordinary containment. Reserve the large soft shadow for the composer and modal sheet.

## Shapes

The exact radius vocabulary is 2px for the progress track, 4px for tab avatars and the tight corner of chat bubbles, 5px for compact selects and workflow tags, 6px for controls, 7px for navigation rows and common icons, 8px for larger glyphs and settings list items, 9px for Worker and management panels, 10px for conclusion, log, and composer containers, and 12px for the desktop settings dialog. Status dots and presence indicators are circular; count badges may use a fully rounded capsule. Borders are one pixel unless the two-pixel selection or focus treatment is required.

## Components

### Global Bar, Rail, and Tabs

The top bar shows Praetorium, selected Director/runtime identity, local connection truth, running session count, scale, theme, and settings. The rail groups Directors and Goals into Now, Queue, and Recent, with search and scheduler truth fixed around its own scroll region. Selecting a Director or Goal returns the workspace to aggregate Trace. The tab row contains aggregate Trace, Director Chat, then horizontally scrollable Worker tabs; Left/Right/Home/End move and activate tabs.

### Overview, Trace, Live Log, and Inspector

The Goal header reports actual status, workflow, queue position, completed-success-task count, and the Director entry point. Its contextual operations expose only valid lifecycle actions: queued Goals can move, defer, or cancel; blocked or failed Goals can safely retry or cancel; Owner-waiting Goals can cancel without bypassing their exact decision contract. The latest-conclusion preview reads the Goal final report first, then the latest durable run output or public decision, and opens Director Chat. Trace entries are chronological and select into the Inspector without navigating away. Goal is depth 0, explicit Wave boundaries are depth 1, root Worker tasks are depth 2, and dependent tasks nest one 14px step beneath their deepest prerequisite while naming the parent task IDs. Selecting a task-bearing entry also selects that Worker's log. The Inspector shows either event evidence or Worker execution, interventions, steering, and pause/resume controls; terminal Workers cannot be steered.

### Director and Worker Tabs

Director Chat owns the complete Goal-scoped conversation and final response. Owner messages align right on an indigo plane; Director messages align left on a neutral panel. The conversation scrolls independently while the 10px-radius composer remains anchored below it. Sending is optimistic, announced through the polite chat log, and supports `Ctrl+Enter`/`Cmd+Enter`. Modes are `자동 판단`, `Worker 실행`, and `답변만`. When a new Goal is accepted, the UI selects it and returns to aggregate Trace.

Each Worker tab opens a dedicated scrolling page with assignee, title, truthful status, Task ID, start time, public checkpoint summary, structured public comments, lifecycle events, final result or verification evidence, and the full raw command/result log. Evidence lists and raw output scroll independently. The selected Worker's condensed raw log remains visible in Overview, so inspection does not require opening the Worker tab.

### Status and Feedback

The shared status model maps running, executing, materializing, planning, clarifying, evaluating, remediating, and verifying to green; done, completed, succeeded, success, and archived to green; blocked and awaiting_owner to amber; failed, error, and cancelled to red; and idle, queued, ready, todo, review, scheduled, unknown, or missing values to gray. Worker-tab and trace dots preserve the same success, attention, and failure distinction. Preserve these distinctions and always keep the status text visible.

Errors use inline or global `role="alert"` surfaces with retry where available. Sync failures explicitly preserve the last Goal, Worker list, or execution record. Worker intervention receipts distinguish delivery pending, delivery failed, Hermes acceptance, and Worker observation; durable pending or failed delivery explicitly says automatic retry is scheduled and warns the Owner not to resend. Empty, not-started, disabled, and fatal states have separate truthful copy; no synthetic progress, syntax coloring, or timeline duration is added.

### Settings Modal

The settings sheet is at most 940×700px, with a 170px navigation column, 66px header, independently scrolling body, 12px radius, and shared shadow. It manages Projects, Runtime diagnostics, Role Profiles, and Skills/Flows. Project tools connect, discover, and remove assignments; removal requires native confirmation and may be rejected when work is active. The modal traps focus, focuses Close on entry, closes with Escape or backdrop click, and restores prior focus. At 760px and below it becomes a borderless full-screen sheet with horizontal navigation and single-column content.

### Preferences and Accessibility

Theme defaults to dark. Theme, 90–125% text scale, 268px rail width, and 336px Inspector width persist in local storage. Splitters support pointer dragging, 16px ArrowLeft/ArrowRight keyboard steps, Home reset, and double-click reset. All native controls use a two-pixel accent `:focus-visible` outline with a two-pixel offset. Tabs expose tablist semantics; splitters expose separator values; decorative SVGs are hidden from assistive technology; chat updates are polite; modal and errors expose their native roles. Reduced motion disables smooth scrolling and transitions and collapses animation duration to .01ms. The document begins with a keyboard-focusable skip link to the active workspace panel.

## Do's and Don'ts

### Do:

- **Do** preserve the three-pane evidence relationship and the fixed conclusion, trace, live-log, and Inspector scroll boundaries.
- **Do** render IDs, status, runtime, timestamps, evidence, and authority from real local state.
- **Do** keep dark and light geometry identical and use the exact theme token roles.
- **Do** retain keyboard tabs, splitters, visible focus, focus-trapped settings, reduced motion, and 90–125% text scaling.
- **Do** keep Korean operational labels concise and monospace limited to machine-shaped data.

### Don't:

- **Don't** replace the trace-first workbench with cards, dashboards, or decorative terminal styling.
- **Don't** scroll the page shell, move the conclusion into the trace scroller, or merge the trace and live-log scroll containers.
- **Don't** use indigo as a runtime status or infer status from color without text.
- **Don't** invent duration bars, progress, log syntax classes, evidence, or capabilities absent from local data.
- **Don't** add gradients, resting card shadows, oversized type, inflated pills, or rounded containers outside the implemented vocabulary.
