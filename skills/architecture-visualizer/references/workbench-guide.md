# Workbench guide

## Regions

| Region | What it does |
| --- | --- |
| Header | Shows the document title and status, lens switcher, Search (opens the command palette), Copy link, rail toggle, theme, and export controls. |
| Trust strip | Summarizes grounding, evidence, rules, and open items. Each pill opens the chapter with its details. |
| Canvas | Displays the architecture or active view. Pan, zoom, fit, and use the lens key to interpret encodings. Select a component to open its sheet. |
| Reading rail | Holds chapters and the component sheet. The sheet overlays the current chapter; Back returns to it. The rail docks on wide screens and becomes a drawer on narrow screens. |

## Chapters

| Chapter | Contents |
| --- | --- |
| Overview | Summary, facts, trust rows, primary scenario, and changes. |
| Walkthrough | The scenario player: pick a scenario and step through its stages while the canvas spotlights each one. |
| Changes | Added, changed, removed, and moved components, blast radius, and traceability gaps. |
| Review | Quality gate, rules, findings, assumptions, open questions, and decisions. |
| Evidence | Component evidence states and all evidence locators. |
| Data | Data model view and related details. |
| Plan | Implementation plan and tasks. |

## Lenses

| Lens | Shows |
| --- | --- |
| Structure | Neutral architecture; dashed rings identify components not verified. |
| Evidence | Evidence state on component cards. |
| Change | Added, changed, and removed components and connections; unchanged items are muted. |
| Risk | Failure modes and policy violations, including ghost links for missing or forbidden relationships. |

The lens key lists only states present. In Structure it offers Data flow only. A selected lens can be changed by chapter suggestions; an explicitly chosen lens remains selected through the next chapter change.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| ⌘K (macOS) / Ctrl+K | Open or close the command palette. |
| 1–4 | Select Structure, Evidence, Change, or Risk. |
| F | Fit the diagram. |
| 0 | Reset the view. |
| + / =, - | Zoom in, zoom out. |
| A | Toggle flow animation. |
| Arrow keys | Pan the canvas. |
| Escape | Close the active workbench overlay or clear active exploration state. |
| In the command palette: Up/Down, Home/End, Enter, Escape | Move through commands, jump to first/last, run selection, or close. |

The lens switcher also supports Left/Right and Home/End. The palette includes commands and exports; type to filter its items.

## Share links

The hash uses version 2 state parameters. Parameters are optional and describe the current chapter, lens, selection, scenario, stage, sequence step, or camera region.

| Parameter | Meaning |
| --- | --- |
| `v=2` | Link format version. |
| `c=` | Chapter. |
| `l=` | Lens. |
| `n=` | Selected node/component. |
| `e=` | Selected connection/edge. |
| `s=` | Scenario. |
| `at=` | Authored stage id. |
| `step=` | Sequence step number. |
| `cam=` | Camera world region: centre x, centre y, visible width. |

Example:

```text
architecture.html#v=2&c=walkthrough&l=risk&n=order-service&s=order-flow&at=publish&step=2
```

Version 1 links using `view`, `node`, `scenario`, `stage`, `z`, `x`, and `y` continue to work. Missing model items in a link are dropped with a brief explanation; links from a newer version are not partly applied.
