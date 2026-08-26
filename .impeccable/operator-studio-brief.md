# Operator Studio surface brief

- Scope: replace the desktop Owner Console visual world while preserving local runtime, durable Goal, Director, Worker, evidence, and control behavior.
- Mode: Operate. Technical Owner monitors long-running Windows and WSL work, asks the Director questions, inspects Worker execution, and makes explicit gates.
- Approved composition: `.impeccable/mocks/operator-studio-b-trace.png`.
- Direction: trace-first graphite workbench. Restrained indigo authority accent, semantic state colors, compact sans UI, mono only for commands, timing, and raw output.
- Primary task: understand what is running, what happened, what failed, what the Director concluded, and where the evidence lives without changing screens unnecessarily.
- Memorable moment: a nested execution trace and live log drawer stay visible together; selecting an event updates the right Inspector without losing place.
- Director answer: the Director tab owns the complete conversation and final response. Overview keeps a compact latest-conclusion preview that opens the exact conversation surface.
- Constraints: no session termination; preserve IDs, routes, runtime authority boundaries, keyboard operation, text scaling, reduced motion, independent scrolling, and existing management dialogs.

## Implementation inventory

| Comp commitment | Implementation medium |
| --- | --- |
| Slim global status and project bar | Semantic HTML and CSS |
| Resizable project rail | Existing HTML/JS splitter, rethemed |
| Overview, Director, and Worker tabs | Existing tab state and DOM, recomposed |
| Nested execution trace with status and time | Existing trace renderer, new CSS hierarchy |
| Visible combined Worker log drawer | New semantic HTML and minimal renderer using existing task trace data |
| Director latest conclusion preview | New semantic HTML and renderer using existing durable run/final report data |
| Right evidence Inspector | Existing inspector renderer, persistent split layout |
| Resizable Inspector | Native pointer and keyboard splitter using stored UI preference |
| Owner gate | Existing decision controls presented inline |
| Icons | Existing coherent stroke SVG set; no new dependency |
| Motion | CSS state transitions only, reduced-motion safe |

## Non-literal comp details

- Example task names, timestamps, commands, counts, and evidence files in the comp are illustrative and must come from real local state.
- The comp's waterfall timing bars are omitted until the runtime exposes trustworthy span duration data.
- Raw log colors remain restrained and data-driven; no invented syntax classification.
