---
name: Praetorium Owner Console
description: A Fluent desktop dispatch workbench for observing and steering local Director and Worker execution.
colors:
  light-canvas: "#f5f5f5"
  light-panel: "#ffffff"
  light-surface: "#f0f0f0"
  light-selection: "#e5f1fb"
  light-border: "#e0e0e0"
  light-border-strong: "#c7c7c7"
  light-text: "#1f1f1f"
  light-text-soft: "#424242"
  light-text-muted: "#616161"
  light-owner-cobalt: "#0f6cbd"
  light-owner-cobalt-strong: "#115ea3"
  light-active-teal: "#0f7b6c"
  light-done-green: "#107c10"
  light-waiting-amber: "#8a5b00"
  light-failure-red: "#c42b1c"
  light-code-surface: "#f3f3f3"
  dark-canvas: "#1f1f1f"
  dark-panel: "#292929"
  dark-surface: "#333333"
  dark-selection: "#14395b"
  dark-border: "#3e3e3e"
  dark-border-strong: "#5a5a5a"
  dark-text: "#f5f5f5"
  dark-text-soft: "#d6d6d6"
  dark-text-muted: "#adadad"
  dark-owner-cobalt: "#6aa8ff"
  dark-owner-cobalt-strong: "#8bbcff"
  dark-active-teal: "#5ec7b7"
  dark-done-green: "#6ccb5f"
  dark-waiting-amber: "#f5c344"
  dark-failure-red: "#ff99a4"
  dark-code-surface: "#181818"
typography:
  headline:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", Pretendard, sans-serif'
    fontSize: "clamp(1.55rem, 2vw, 1.95rem)"
    fontWeight: 680
    lineHeight: 1.24
    letterSpacing: "-0.02em"
  title:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", Pretendard, sans-serif'
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.45
  body:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", Pretendard, sans-serif'
    fontSize: ".9rem"
    fontWeight: 400
    lineHeight: 1.52
  label:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", Pretendard, sans-serif'
    fontSize: ".78rem"
    fontWeight: 650
    lineHeight: 1.45
  mono:
    fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace'
    fontSize: ".857rem"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  metadata: "3px"
  control: "4px"
  grouped: "6px"
  dialog: "10px"
spacing:
  xs: "4px"
  sm: "6px"
  control: "8px"
  compact: "10px"
  section: "12px"
  panel: "14px"
  content: "20px"
  pane: "24px"
components:
  button-owner:
    backgroundColor: "{colors.light-owner-cobalt}"
    textColor: "{colors.light-panel}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "34px"
  button-owner-hover:
    backgroundColor: "{colors.light-owner-cobalt-strong}"
    textColor: "{colors.light-panel}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "34px"
  button-secondary:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "34px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.light-failure-red}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "34px"
  field:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.control}"
    padding: "7px 9px"
    height: "34px"
  workspace-tab-selected:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text}"
    rounded: "4px 4px 0 0"
    padding: "5px 10px 7px"
    height: "48px"
  worker-dispatch-strip:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.light-text-soft}"
    rounded: "{rounded.control}"
    padding: "10px 14px 9px 28px"
    height: "76px"
---

# Design System: Praetorium Owner Console

## Overview

**Creative North Star: "The Dispatch Rail"**

Direction seed `d5a85ad0` resolves Praetorium as Fluent desktop foundations joined to a flight-dispatch strip workbench. Neutral planes, compact type, and one-pixel structure make long-running local work easy to scan; narrow status marks and chronological evidence provide the distinctive rhythm. This is an operating surface, not a dashboard gallery or terminal costume.

Light is the default theme. Dark mode has full semantic and structural parity: it changes neutral values and contrast, never information architecture or color meaning. Cobalt identifies Owner selection and action; teal means active work, green means done, amber means waiting, and red means failure.

**Key Characteristics:**

- A 52px command bar, resizable Director rail, workspace tabs, and one continuous workbench.
- Compact one-column Worker dispatch strips instead of a card mosaic.
- Independent scroll regions with the Director chat composer anchored at the bottom.
- Flat neutral planes, one-pixel borders, 4–6px working corners, and shadow only on flyouts.
- Segoe UI Variable Text for the interface and Cascadia Code only for machine-shaped content.
- Light-first theming with complete dark-mode role parity.

## Colors

The palette uses Fluent neutrals as working material and reserves chroma for authority or observed state. The frontmatter is the normative light and dark token source.

### Primary

- **Owner Cobalt:** Selection, active tabs, focus outlines, primary buttons, and Owner-authored controls. The stronger companion is the hover state; cobalt does not report runtime health.

### Secondary

- **Active Teal:** Running and reviewing work only.
- **Done Green:** Completed work, successful receipts, ready local connectivity, and passed gates.
- **Waiting Amber:** Queued work, setup needs, warnings, and Owner decisions still required.
- **Failure Red:** Failed, blocked, offline, destructive, or undelivered states.

### Neutral

- **Canvas and Panel:** The canvas holds the shell; panels form the command bar, rail content, fields, strips, and fixed composer.
- **Surface and Selection:** Neutral surface separates controls and code; the cobalt-tinted selection plane marks current context.
- **Border and Strong Border:** One-pixel dividers establish structure. The stronger border is for fields, active boundaries, and flyouts.
- **Text, Soft Text, and Muted Text:** Primary facts, supporting prose, and metadata form a three-step hierarchy.

### Named Rules

**The Authority-Status Split Rule.** Cobalt means the Owner can select or act. Teal, green, amber, and red describe observed work state and never substitute for Owner authority.

**The Theme Parity Rule.** Dark mode swaps token values, not roles, density, component placement, or status meaning.

## Typography

**Display Font:** None. Praetorium does not use display typography.

**Body Font:** Segoe UI Variable Text with Segoe UI, Pretendard, and sans-serif fallbacks.

**Label/Mono Font:** Segoe UI Variable Text for labels; Cascadia Code with SFMono-Regular and Consolas fallbacks for code, keyboard input, and preformatted evidence.

**Character:** Type is compact, calm, and native to a Windows desktop tool. The sans stack carries all interface language; monospace is restricted to genuinely machine-shaped content.

### Hierarchy

- **Headline** (680, fluid 1.55–1.95rem, 1.24): The active mission title, limited to two lines until expanded.
- **Title** (650, 1rem, 1.45): Workspace, section, and dialog headings.
- **Body** (400, about .9rem, 1.52): Conversation, evidence, descriptions, and operational guidance.
- **Label** (650, about .78rem, 1.45): Controls, compact headings, states, and metadata labels.
- **Mono** (400, about .857rem, 1.6): Code blocks, commands, keyboard hints, and raw logs.

### Named Rules

**The No Kicker Rule.** Do not place visible eyebrow or kicker text above workspace headings; the implemented detail eyebrow remains hidden.

**The No Hero Type Rule.** The mission headline is the top of the scale. No oversized display copy or promotional typography belongs in the console.

## Layout

The viewport is a fixed-height desktop shell. A 52px command bar sits above a two-column application frame: a 264px Director rail, a 6px resize separator, and a fluid workspace. The rail is user-resizable from 180px to 360px and persists its width. At 520px and below it becomes a 60px index rail and the separator disappears.

The workspace begins with a 48px horizontal tab strip. Exactly one Overview, Director Chat, Worker, or temporary Detail panel is active. The page frame does not scroll; the Director list, active workspace panel, conversation stream, inspector, and dialog body own their scroll. The Overview canvas is capped at 1180px, while chat content is capped at 860px and inspector content at 1040px.

Worker dispatch strips form one compact vertical column with 4px gaps. Current focus uses a three-column divided strip and collapses to one column at a 760px container width. The completion runway adapts from a horizontal divided strip to two columns and then one column. At 720px and below, headers stack and interactive controls reach at least 44px. Text scaling persists from 90% to 125%.

### Named Rules

**The Workbench Never Page-Scrolls Rule.** Keep the shell fixed and give each working region its own contained scroll surface with a stable scrollbar gutter.

**The One-Column Dispatch Rule.** Workers read as stacked flight strips, never as a responsive card grid.

**The Composer Stays Anchored Rule.** Director conversation scrolls independently while its composer remains fixed to the bottom of the channel.

## Elevation & Depth

Praetorium is flat at rest. Neutral fills and one-pixel borders separate every persistent plane. Only detached flyouts, dialogs, focused skip navigation, and toasts receive the shallow flyout shadow; the light theme uses a lighter 8px/24px shadow and dark mode a denser 12px/32px shadow. No resting row, panel, strip, or navigation item is elevated.

### Named Rules

**The Flyout-Only Shadow Rule.** A shadow means a surface is temporarily detached from the workbench. Persistent structure stays flat.

## Shapes

Working controls, rows, strips, and management containers use 4px corners. Grouped chat bubbles, the brand mark, focus summary, tooltips, and toasts use 6px corners. Metadata uses 3px corners, while modal dialogs alone use 10px. One-pixel borders define structure; circles are reserved for status dots, trace markers, and avatars. Short badges remain compact labels rather than inflated pills.

## Components

### Command Bar, Director Rail, and Workspace Tabs

The command bar keeps brand, current project context, live connection state, text scale, settings, and theme control on one 52px line. Director rows use a neutral hover, cobalt-tinted selection, a two-pixel active edge, and a separate semantic status dot. Workspace tabs use a neutral selected plane plus a two-pixel cobalt underline. Overflow scrolls horizontally; it never wraps into a second navigation row.

### Buttons and Fields

Primary buttons use solid Owner Cobalt; secondary buttons use a panel fill and strong neutral border; danger buttons use red text and a red-tinted border with a soft failure hover. Controls are 34px high on desktop, use 4px corners, move down by one pixel when pressed, and show a two-pixel cobalt focus outline. Inputs, selects, and textareas use the panel fill, strong border, and cobalt caret.

### Worker Dispatch Strips

The signature Worker component is a full-width, 76px minimum strip in a one-column stack. A seven-pixel dot at the leading edge carries semantic state. Role, task, state, evidence summary, and elapsed metadata remain on compact scan lines. Hover and selection change the neutral plane and border without lift or scale.

### Trace and Completion Runway

Trace nodes use 23px numbered circular markers and one-pixel vertical connectors, with child work indented by 18px. The completion runway is a single divided container whose steps use seven-pixel state dots. Workflow sequences use CSS-drawn chevrons; Unicode arrow glyphs are not part of the component language.

### Director Chat Composer

Director Chat uses a header, one independently scrolling conversation stream, and a composer anchored below it. The composer is one 6px-cornered field group with a textarea, processing mode, keyboard hint, and cobalt Send action. Focus strengthens the cobalt border and adds a restrained two-pixel ring.

### Dialogs and Feedback

Native dialogs use 10px corners, a strong one-pixel border, one scrollable body, and the flyout shadow. Toasts sit at the lower right with a semantic border and polite live-region behavior. Reduced-motion mode collapses all transition and animation durations to effectively zero.

## Do's and Don'ts

### Do:

- **Do** preserve the 52px command bar, resizable 264px rail, explicit workspace tabs, and independent scroll ownership.
- **Do** use cobalt only for Owner selection, focus, and actions; keep teal, green, amber, and red semantically distinct.
- **Do** present active Workers as compact one-column dispatch strips beside their evidence and controls.
- **Do** maintain the light-default and dark-parity token roles, visible keyboard focus, reduced motion, and 90–125% text scaling.
- **Do** use one-pixel structure, 4–6px working corners, CSS/SVG icons, and plain operational labels.

### Don't:

- **Don't** turn the workbench into a card-dashboard mosaic or collections of floating summary tiles.
- **Don't** imitate a terminal with monospace interface copy, neon color, command-line decoration, or black-on-black styling.
- **Don't** add gradients, resting shadows, lifted hover transforms, inflated typography, excessive rounded cards, or decorative pills.
- **Don't** add visible kickers above headings or use Unicode arrows to describe workflow.
- **Don't** let the page shell scroll, unfix the Director composer, or merge Windows and WSL runtime identity.
