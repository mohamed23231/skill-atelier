# Workbench guide

## Regions

| Region | What it does |
| --- | --- |
| Header | Shows the document title, status, component count and date, lens switcher, Search (opens the command palette), Copy link (hidden in embedded viewers), rail toggle, theme, and export controls. |
| Trust strip | Summarizes grounding, evidence (for example, “6/6 backed · 4 planned”), rules, and open items. Each pill opens the chapter with its details. |
| Canvas | Displays swimlanes with right-angled routes and jumps at crossings. Holds the top-right lens key, zoom controls, minimap, and bottom walkthrough track. |
| Reading rail | Holds chapters and the component sheet. The sheet overlays the current chapter; Back returns to it. From 900px it docks beside the canvas and can be toggled from the header. Below 900px the page stacks canvas, track, then the always-open rail as a page section; selection scrolls the sheet into view. |

## Chapters

| Chapter | Contents |
| --- | --- |
| Overview (default) | Summary, facts, trust rows, primary scenario, and changes. |
| Walkthrough | The scenario as a path of steps, decisions and outcomes, with narratives; choose outcomes at decisions. |
| Changes | Added, changed, removed, and moved components, blast radius, and traceability gaps. |
| Review | Rules, findings, failure modes, assumptions, open questions, and folded decisions; the quality gate is folded at the end and opened by its trust pill. |
| Evidence | Component evidence states and all evidence locators. |
| Data (when the spec has tables) | Table and relationship cards, columns, keys, indexes, and related details. |
| Plan (when the spec has plan phases) | Implementation plan and tasks. |

## Lenses

| Lens | Shows |
| --- | --- |
| Structure | Neutral architecture; dashed rings identify components not verified. |
| Evidence | Evidence state on component cards. |
| Change | Added, changed, and removed components and connections; unchanged items are muted. |
| Risk | Failure modes and policy violations, including ghost links for missing or forbidden relationships. |

The header switcher offers Structure, Evidence, Change, and Risk (keys 1–4), with a select on phones. The top-right lens key lists only states present; Filters holds layer controls and, in Structure, Data flow only. The Change key offers Current / Proposed / Diff. A selected lens can be changed by chapter suggestions; an explicitly chosen lens remains selected through the next chapter change.

## Canvas exploration and walkthrough

The default is `layout: 'lanes'`: one swimlane per boundary in tier order, with titles and component counts in a left gutter and cards on shared column slots. `layout: 'columns'` keeps the previous arrangement; `--router curved` keeps curves. Pan, zoom, or fit with the canvas controls; the minimap hides while everything fits and during walkthrough framing. Hovering a card darkens its connections; hovering a connection darkens that route.

Click a card (or press Enter on it) to open its component sheet, spotlight its neighbourhood, and glide the camera there. The sheet reads as a document: kind and technology, description, evidence and change chips, walkthrough steps on every outcome, responsibilities, incoming/outgoing connections, evidence, failure modes, and tasks. Step links open that walkthrough step; connection rows open the other component. Show neighbours / Show blast radius is available in the sheet and palette. Clicking a connection or its label opens its sheet and frames both ends. Escape, Back, the close button, or an empty-canvas click clears selection and returns to the whole diagram.

The idle track shows the main path plus one lane per outcome, with numbered steps and previous / play / next controls. The Walkthrough chapter lists numbered steps, decisions with outcome choices, and outcome ends; every card can be clicked or activated with Enter/Space to go there. A scenario picker appears only when there is more than one scenario. Starting from the track, a key, or the palette opens Walkthrough.

Each step glides the camera to its participants, spotlights their cards and connections, and sends packets along every hop; parallel hops move together and recovery packets use the warning colour. Hop markers number the paths. Choosing an outcome changes the path and its step numbers. The rail scrolls to the current step without jumping the stacked page. Previous / next and the track entries navigate; End appears while running. Escape or an empty-canvas click ends the walkthrough; selecting a card or connection leaves it for that item. Reduced motion keeps highlights and jumps the camera, with playback disabled.

Search opens the Cmd/Ctrl+K palette for components, connections, scenarios, stages, lenses, commands, and exports. Present, Fullscreen, Animate, fit, reset, theme, quality gate, and relationship highlighting are palette commands.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| ⌘K (macOS) / Ctrl+K | Open or close the command palette. |
| 1–4 | Select Structure, Evidence, Change, or Risk. |
| F | Fit the diagram. |
| 0 | Reset the view. |
| + / =, - | Zoom in, zoom out. |
| A | Toggle flow animation. |
| → / j, ← / k | Next / previous walkthrough step (arrow keys pan the canvas when no walkthrough is active). |
| Space | Play or pause the walkthrough (disabled under reduced motion). |
| Escape | End the walkthrough, close an overlay, or clear selection. |
| ? | Open the keyboard shortcut sheet; Escape closes it and returns focus. |
| In the command palette: Up/Down, Home/End, Enter, Escape | Move through commands, jump to first/last, run selection, or close. |

The lens switcher also supports Left/Right and Home/End. The palette includes commands and exports; type to filter its items.

## Share links

The hash uses version 2 state parameters. Parameters are optional and describe the current chapter, lens, view, filter, selection, focus, presentation, scenario, stage, sequence step, or camera region.

| Parameter | Meaning |
| --- | --- |
| `v=2` | Link format version. |
| `c=` | Chapter. |
| `l=` | Lens. |
| `view=` | Canvas view other than the architecture: `data_flow` or `sequence`. |
| `filter=` | Layer filter other than all (for example `backend`). |
| `focus=` | `neighbors` or `affected`, applied to the selected component. |
| `present=1` | Presentation mode. |
| `n=` | Selected node/component. |
| `e=` | Selected connection/edge. |
| `s=` | Scenario. |
| `at=` | Walkthrough entry (stage id). |
| `o=` | Non-default outcomes, as `decision:index` pairs. |
| `step=` | Sequence step number. |
| `cam=` | Camera world region: centre x, centre y, visible width. |

Example:

```text
architecture.html#v=2&c=walkthrough&l=risk&n=order-service&s=order-flow&at=publish
```

Version 1 links using `view`, `node`, `scenario`, `stage`, `z`, `x`, and `y` continue to work. Missing model items in a link are dropped with a brief explanation; links from a newer version are not partly applied.

In the claude.ai embedded viewer only plain `#anchor` links survive; stateful view links work from the downloaded file. Copy link is hidden when embedded because the host owns the address bar. Markdown and SVG exports open as copyable text there; HTML and PNG explain how to download. The workbench is one offline HTML file, makes no network requests, and has a 500 KB page budget.
