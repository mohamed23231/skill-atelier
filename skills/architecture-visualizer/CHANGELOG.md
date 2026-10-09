# Changelog

All notable changes to the `architecture-visualizer` open-source skill will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [3.0.0] - 2026-10-09

A reading workbench: swimlanes with right-angled routes, four lenses, a reading rail with chapters and a component sheet, and a moving, branching walkthrough, checked on sixty generated specs as well as the examples. Specs need no change; see "Migrating from 2.x" in the README for the new default layout, links and moved controls.

### Added

- **Big lanes stay readable**: a lane wrapped at four cards per row with wide gaps, so one or two big lanes opened at about 0.55 zoom with connections crowding between rows. The row width is now chosen (four to seven cards) for the best fit on the docked canvas, rows inside a lane are separated by a channel sized for the routes that use it, links within a row stay in that row, and no route doubles back through a row channel. Generated specs with 14 and 24 components open at 0.87 and 0.72 (from about 0.6); the median fit over sixty generated specs improves, none gets more than 5% worse, and the examples, with at most three cards per lane, are unchanged.
- **Every model gets the examples' care**: a seeded generator builds specs of every shape (one to six lanes, two to twenty-six components of every kind, long names, dense and backward connections, no scenario or several, parallel steps, outcome branches with an empty and a recovery path, policies, evidence, deltas). Sixty of them must compile within the page budget, route without crossing a card, keep every card in its lane and every label apart, and lay out identically each time; fourteen go through the same real-interaction sweep as the examples (a jittery real click opens a card, every component, connection, step, outcome, lens and chapter, at desktop and phone widths) with no error, no overlapping cards or labels, no sideways scroll and nothing printed as undefined.
- **The walkthrough reads like the prototype**: the rail scrolls to the current step's card (inside the rail only, never jumping a stacked page), components outside the step recede with their connections, numbered hop markers sit on the line clear of every label, the minimap stays hidden while a walkthrough frames the camera, the scenario picker appears only when there is more than one scenario, a generated narrative no longer repeats the payload that the table below it shows, starting a walkthrough from the track, a key or the palette opens the Walkthrough chapter, and the step's components carry the accent outline. The canvas has a faint dot grid.
- **Hover previews a component**: hovering a card darkens its connections (hovering a connection darkens it), focus changes fade instead of snapping, and on phones the track's steps are full-size touch targets.
- **Clicking a component works like the prototype**: the component and its neighbours glide into view while everything else recedes and its connections darken; the rail shows a component sheet that reads as a document (kind and technology, name, description, evidence and change chips, the walkthrough steps it appears in, on every outcome, each opening that step, responsibilities, connections in and out, each opening the other component, evidence, failure modes, tasks). Clicking a connection frames both of its ends. Leaving the sheet returns to the whole diagram.
- **The walkthrough moves**: each step glides the camera to its participants (never smaller than the whole-diagram fit) and sends a packet along every hop of the step, again after a pause until the step changes, in the warning colour on a recovery outcome; parallel hops travel together. Reduced motion keeps the highlight and jumps the camera.
- **The page stacks below 900px, as the prototype does**: canvas and walkthrough track first, then the reading rail as a section of the page, always open; selecting a component scrolls its details into view. The overlay drawer, its backdrop and focus trap are gone.
- **The track shows every outcome before you start**: the idle track lists the main path and one lane per outcome ("↳ Dispatch Successful", "↳ Damaged Item DLQ Quarantine & Compensation") with the steps numbered across them, the step count covers every outcome (11 on example 3, as on the Walkthrough tab), and previous and next use chevrons.
- **A reading rail and track like the prototype**: the Overview opens with the system, its description, a components / layers / connections card, "How it works" (the default path's steps and the decision with its outcomes) and Start walkthrough; trust rows open their chapter; chapter tabs carry counts; trust pills lead with a bold number; the header shows the component count and date; the lens key is one slim line with the layer and data-flow controls behind Filters.
- **Shareability is tested**: example 3 makes no network request and logs no error through every lens, every walkthrough step of every outcome, both themes and every chapter; a keyboard-only reader walks the whole default path with J; and a copied link opens in a fresh browser on the same lens, step, outcome and camera.
- **A keyboard shortcut sheet**: `?` (or "Keyboard shortcuts" in the palette) lists every shortcut the workbench handles, grouped by navigation, walkthrough, lenses and view; Escape closes it and returns focus.
- **Performance is measured**: a 60-component, 90-connection fixture with a 20-stage scenario boots in about 110ms, and a walkthrough step or a lens change takes a median of about 34ms (two animation frames included), both checked against a 100ms limit.
- **Every scenario step reads as a sentence**: stages and interactions without an authored `narrative` get a generated one at build time ("Outbox Relay Worker sends Publish OrderCreated to Apache Kafka Event Bus. Payload: orderId=9901."), marked `narrativeGenerated` so the page and report can say so; authored narratives are never changed. The Markdown report gains a Scenarios section that tells each scenario as numbered steps, with outcomes nested under decisions and generated sentences marked. Scenarios with no authored narrative produce a validation notice (not a warning, so `--strict` builds are unaffected).
- **Freshness is real**: `arch-viz validate --stamp` records the commit the evidence was checked against as `meta.groundedAt`; `build` marks every evidence record whose file changed since then (or is untracked) as `stale` with `staleSince`, and records `meta.builtFrom`; `arch-viz validate --fresh` lists stale records and exits 1 on drift, so CI can block a stale diagram. Paths are matched relative to `--repo-root`, which may be a folder inside a larger repository. Illustrative specs are never stamped or checked, and their builds stay reproducible.
- **The lens engine** (`scripts/lenses.js`): Structure, Evidence, Change and Risk as pure functions from the model to an encoding per component and connection (stroke, line style, tint, badge words, struck name, muted text, exception marker), ghost connections for policies (forbidden and absent, required and missing, at most three unless one is selected) and a key listing only the states present. Encodings are token names, never colors, and never opacity, so a lens composes with any spotlight. Rendering them arrives with the lens switcher.
- **The walkthrough engine** (`scripts/walkthrough.js`): a scenario plus the reader's outcome choices becomes one path of numbered steps, decisions and outcome ends, with nested branches, parallel stages, a default outcome (`default: true`, else the first) and per-path step numbers; each entry says which components and connections it puts in focus, numbered markers for parallel hops, and ghost links for hops with no modelled connection.
- **A command palette (⌘K / Ctrl+K)**: one keyboard-first place to jump to any component, connection, view or scenario stage, and to run every workbench command (fit, reset, presentation, fullscreen, animate, theme, quality gate, copy link, show neighbours, show blast radius) and every export. Arrow keys, Home/End, Enter and Escape work as in any combobox; Escape returns focus to where it was and leaves the selection alone. It is the new home of the navigator's search, and the header Search button opens it at every width.
- **A trust model** (`scripts/trust.js`): per-component evidence state (Verified, Declared, Declared but not checked, Missing, Stale, Asserted, Planned, Inferred/Assumed/Unknown, the worst record deciding) and the summary behind the coming trust strip: grounding, evidence ("6/6 existing backed · 4 planned"), rule results, open items and the gate line ("13 of 14 pass · 1 skipped"). Every number comes from the validator's embedded output. A component lacks evidence only when it claims some that is not there; actors are not counted, since nothing in a repository can back them; and an empty model reads as unchecked, never as verified.

### Fixed

- **Review of the 3.0 pull request (73 automated findings, each checked against the code: 72 fixed, every code fix with a test that fails without it; 1 kept, the example saga's parallel step, which matches the approved prototype)**:
  - *Build and CLI*: a hub with many connections on one card face made the orthogonal router throw and the build fail; it now falls back to curved routes. `--direction LR|TB` selects the column layout instead of being silently ignored by lanes. `validate --stamp` can replace a `meta.groundedAt` that a rebase removed. A numeric node `order` now pins lane slots.
  - *Freshness*: evidence without a `verification` field, legacy `details.files` citations, absolute paths inside the repository and cited files that git ignores are now checked for drift, so `--fresh` no longer passes on changed evidence; ignored files are listed only for the paths a spec cites. SHA-256 repositories are supported.
  - *Workbench*: Reset view (`0`) clears the selection; light-theme SVG and PNG exports use the light palette; dragging a lane moves its whole title; node ids with CSS syntax no longer break fitting; the shortcuts dialog keeps its keys from the canvas; a link opens on the view it names, not on whatever the page showed before; outcome ids with `:` or `,` survive a link; selection and walkthrough focus are no longer faded by a lens; reading text can be selected and copied; presentation mode hides the trust strip; the minimap maps clicks correctly when letterboxed; the Sequence view does not autoplay under reduced motion.
  - *Chapters*: one failure mode reads "1 known failure mode"; a spec with no rules says "No rules defined" instead of "All rules pass"; removal-only and move-only proposals are counted in Changes; failure modes written as plain strings show their text; assumed and unknown components are no longer called inferred; required-path rules written with types or boundaries are drawn; parallel hop markers clear when a step ends; recovery packets follow each hop's status; steps after a decision are shown; walkthrough timing uses interaction durations.
- **The Plan chapter no longer widens a phone page**: a long file path or command in a plan task has no spaces, so it could not wrap and pushed the page sideways at 320 to 390px. Rail text now breaks such tokens when it must; a rendered test opens every chapter of every example at 320 and 390px.
- **Every chapter is one click away, as in the prototype**: seven chapter tabs do not fit a 400px rail, and with an ordinary mouse wheel Evidence, Data and Plan could not be reached. The strip now shows a chevron at each end with chapters behind it, a vertical wheel scrolls it sideways, and the open chapter's tab is kept in view. The component sheet opens under the tabs instead of covering them (one close button at a time), a chapter opens at its top rather than where the last sheet was scrolled, the selected card no longer gains a square frame once focus moves on, and walkthrough packets pause 0.4s between runs instead of 0.9s, so a step always looks alive.
- **Clicking a card zooms in on it, as the prototype does**: framing reserved the zoom controls' height across the whole canvas, so a component's neighbourhood almost never fitted closer than the whole diagram and the camera stayed put. The controls now reserve only their column, so a selection (and each walkthrough step) frames its neighbourhood at up to full size; the minimap stays hidden while the workbench frames the view and appears once the reader pans or zooms. Checked by running the prototype's own interactions on both pages with a real mouse.
- **Big models lay out in milliseconds**: the label search's budget did not count its last step, so a dense model could make millions of placement attempts; some 25-component specs took 7 to 15 seconds to build, and dragging a card (which re-routes with the same code) froze the page as long. Every step now counts: the slowest of sixty generated specs takes about 0.1s, the examples' layouts are unchanged, and a test holds every generated layout under 1.5s.
- **A label with no room is never drawn over a card**: when the router finds no clear place for a connection's label it is left off the canvas (the connection's tooltip and sheet still name it) instead of being drawn at a fallback point over cards and other labels. The last-resort search reaches further first, so this now happens to 5 labels across sixty generated specs (it was 8, all drawn over something), and the interaction sweep fails if a drawn label covers a card.
- **Moving dots pass behind labels**: data-flow dots and walkthrough packets were drawn over the text of the label on their own connection; they now disappear while they cross it, as if passing behind. A rendered test samples every frame for a second and a half.
- **A walkthrough can always be left**: the track has an End button while it runs, clicking empty canvas ends it, and choosing a card or connection leaves it for that item, as in the prototype; nothing stays lit afterwards.
- **A click is a click**: any pointer movement while the button was down counted as a drag, so ordinary clicks on cards and on empty canvas were ignored (and could nudge a card). A press now becomes a pan or drag only after 4px (8px for a finger); touch adds two-finger pinch zoom. Escape and Back clear a selection completely, as clicking empty canvas and the close button do.
- **Walkthrough cards are clickable**: every step, decision and outcome card in the Walkthrough chapter goes to that point of the story on click, Enter or Space.
- **Clicking a card does what it says**: a click (or Enter on a focused card) only marked the card selected and filled a hidden sheet; it now opens the component sheet, frames the neighbourhood and spotlights it. Connections can be clicked too, through a wide invisible hit line or their label, and open the connection's sheet. A rendered test clicks with a real mouse.
- **Cards and connections can no longer come apart**: card positions saved from a drag were keyed by the model alone, so a rebuilt page applied them to a different layout, and the lane router, which cannot route cards outside their lanes, failed silently and left every connection where it was. Saved positions now belong to the layout they came from, a saved arrangement that no longer routes is discarded, and re-routing falls back to the column router and then to curves so connections always follow their cards.
- **Out-of-focus connections stay readable**: during a walkthrough or in a lens, connections outside the focus drew at 12-15% in the background colour, leaving labels floating over invisible lines; they now keep the edge colour at about a third of its strength, and their labels keep a solid pill with faded text.
- **Inside an embedded viewer nothing dead-ends**: when the page runs in a frame (a chat artifact pane), Copy link is hidden because the host owns the address bar, Markdown and SVG exports open as copyable text, and HTML and PNG say how to download instead of silently doing nothing.
- **A link copied during a walkthrough keeps the sender's camera**: the camera was left out of the link whenever a walkthrough was active, so the reader opened on the step's default framing instead of what the sender was looking at.
- **No floating Data Flow banner**: the "Data Flow view: …" pill ran under the lens key; the pressed "Data flow only" toggle and the status announcement already say it.
- **SVG and PNG exports carry every color**: the export copied a hand-kept list of variables, three of which did not exist (`--bg-main`, `--border`, `--bg-elevated`), so exported files lost colors and always used a hard-coded dark background. Exports now resolve the full token list for the current theme, and component icons live inside the canvas so exported files include them.
- **The diagram opens fitted, and shared links restore**: during boot the scenario navigator wrote the default camera (`z=1&x=0&y=0`) into the URL before `restoreUrlState()` read it, so every page undid its own fit-to-screen and every shared deep link was overwritten before it could be applied. URL state is now written only after the incoming hash has been read, a missing `x`/`y`/`z` parameter no longer reads as `0`, and fit-to-screen uses the same zoom floor as the zoom controls so wide diagrams also fit on a phone.
- **Flat scenario stages are normalized**: stages written as one hop (`type`, `from`/`source`, `to`/`target`, `label`, `payload`, …) and parallel stages that nest `stages` are lifted into the canonical `{ kind, interactions }` shape on ingest. They were previously neither rendered nor validated, so a bad node reference inside one passed silently. All three shipped examples used this shape.
- **Displaced edge labels keep a leader**: when collision avoidance pushes a label more than 24px from its edge, a thin dashed leader ties it back to the point on the curve it belongs to (`geometry.labelLeader`, with the curve point recorded as `labelTether`), so it no longer floats as an orphan.
- **Repository grounding is confined to the repository root**: evidence and `details.files` paths now have to resolve strictly under `--repo-root`. Absolute paths elsewhere, `../` escapes, symlinks that lead out of the root, and the root itself are `unresolved` and raise the new `evidence.outside_repo` finding and a Gate 13 warning (which fails `--strict`). Previously `/etc/hosts` could verify a node.
- **No machine-local paths in artifacts**: evaluated evidence records `resolvedPath` (repo-relative) instead of `absolutePath`, and the compiler rewrites absolute paths written in the spec (evidence locators and `details.files`) before embedding them: repo-relative when under the root, the file name alone otherwise. A `../` path that leaves the root is reduced the same way. Built HTML and Markdown no longer carry the author's home directory. `RepoInspector#verifyFiles` returns `insideRepo` and `resolvedPath` in place of `absolutePath`.
- **Outside-root evidence is reported for every node**: an `INFERRED` or `ASSUMED` node citing a path outside the repository also raises `evidence.outside_repo`. A missing file under a symlink that leads out of the repository is classified as outside too.
- **API evidence**: `locator.path` on `api` evidence is the route (`/api/orders`), so it is no longer checked as a file. Set `locator.file` to tie an endpoint to its handler file; without it the record stays `compatibility`.
- **Stricter symbol evidence**: a symbol must appear as a whole identifier, so `create` no longer verifies against `createOrder` or `createΩ` (Unicode identifier characters count), and it must fall inside `startLine`–`endLine` when a range is given.
- **`scaffold --repo-root <subdir>`**: paths are written relative to the requested root, so `validate --repo-root <subdir>` resolves them, and a changed symlink leading out of that root is scaffolded as `INFERRED`, not `VERIFIED`. Previously they were git-root-relative and failed Gate 13. `--ignore` prefixes are now matched against those root-relative paths.

### Changed

- **Trust reads in plain words**: the evidence pill leads with what is backed ("6/6 backed · 4 planned", "6/19 backed · 3 missing evidence · 10 inferred · 4 planned"), its detail says what each number means in sentences, the gate's detail names the checks that need a look instead of printing validator output, and counts read correctly for one of anything. The Overview ends with "What this proposal changes" (added, changed, removed, moved, with names) and "Open items" (assumptions, decisions, open questions), each a row into its chapter.
- **Lenses read like the prototype**: lens badges (Added, Changed, failure modes, evidence) are tags on a card's top edge, so names and technology keep their full width; the Change lens fades unchanged components and connections, the Risk lens fades what no rule touches, and forbidden or missing paths are routed at right angles around cards with one tag each.
- **Changes, Review and Evidence read like the prototype**: each opens with an eyebrow, a headline that answers the chapter's question ("4 added, 2 changed, 2 new connections", "All rules pass, 2 known failure modes") and a generated sentence; every row is clickable (a component opens its sheet, a new connection frames both ends, a rule selects the Risk lens and frames its ends, a failure mode opens its component); decisions are folded; the quality gate is a folded section at the end that the trust pill opens. Counts read correctly for one of anything.
- **Connections read like the prototype**: labels show in full up to 28 characters, ports spread across 60% of a card face in the order of the cards they lead to, parallel runs in a channel stay at least 14px apart and use the whole gap between lanes, no label sits on another connection's line (when none fits on its own line it moves to clear space with a leader), and each lane's order is mirrored or swapped when that removes crossings.
- **The workbench fits the claude.ai viewer and other narrow windows**: the reading rail docks beside the canvas from 900px wide (it was an overlay below 1100px, so a viewer pane showed a bare canvas), the minimap hides while the whole diagram is in view and returns when part of it is not, and lane titles wrap to three lines instead of being cut off.
- **Swimlanes on a shared grid**: the default layout (`layout: 'lanes'`) stacks one full-width lane per boundary in tier order, with the lane's title and component count in a left gutter, and places cards on shared column slots chosen from their neighbours, so connected cards line up and most connections are straight. Every route leaves and enters a card with a straight stub long enough for its arrowhead, and a crossing next to a route's end is bridged on the other route, so arrowheads never bend. Fitting keeps lane titles, cards and labels clear of the overlays. `layout: 'columns'` keeps the previous arrangement.
- **The canvas is clear**: only the zoom controls, the lens key, the minimap and the walkthrough track float over the diagram. The layer chips (All, Frontend, Backend, Data, External) moved into the Structure lens key and the palette ("Show layer: …"), the Current / Proposed / Diff switch into the Change lens key, and the legend is gone (the lens key explains encodings; `?` lists shortcuts). Fitting and framing keep cards and labels out from under the overlays.
- **The offline page budget is 500 KB** (was 400 KB). The 400 KB figure was set when pages were about 300 KB, before the reading rail, lenses, walkthrough and orthogonal router; after compact JSON, stripped indentation and comments, and removing duplicated layout data, example 3 is about 460 KB (92 KB gzipped). The budget is enforced by a test on every example and on sixty generated specs.
- **Layout tests measure the page, not the window**: on Linux and Windows a classic scrollbar takes about 15px of the window, so checks that compared widths with `innerWidth` failed on CI while the page was fine. They now use the page's own width, and every rendered run reserves scrollbar space as Linux and Windows do (`ARCH_VIZ_CLASSIC_SCROLLBARS=0` turns it off), which also caught the phone Sequence bar reaching the zoom buttons when a scrollbar is present.
- **Rendered tests survive a flaky browser launch**: when headless Chrome fails to start (an empty `DevToolsActivePort`, a refused or timed-out DevTools connection), the harness relaunches it up to twice; assertions and page errors are never retried.
- **The diagram reads at a glance**: every component is a uniform 220×72 card whose icon tile shows its kind (the cylinder, chevron and pill outlines are gone), spacing is tighter, and the layout picks left-to-right or top-to-bottom by whichever fits the canvas better (`direction: 'auto'`). At 1440×900 with the rail docked the three examples now open at a zoom of 1.03, 1.05 and 0.76 (they opened at about 0.65), with every routing guarantee kept in both directions.
- **Connections are drawn as right-angled routes**: the layout now routes every connection orthogonally (face ports, channel tracks between columns, corridors around intermediate columns, local loops for backward edges), draws a small jump wherever two routes cross, places every label on its route, and widens a column gap the router reports as overfull. No route passes through a card on any example or adversarial fixture. Dragging a card re-routes in the browser with the same code. `--router curved` (build and scaffold) keeps the previous curves.
- **The Risk lens shows every policy kind**: layer-direction violations carry an against-the-flow chevron, cycle edges are numbered in order, fan-in and fan-out overloads badge the component with actual and limit ("fan-in 7 / max 5"), and required-evidence failures get an evidence marker, alongside the existing required and forbidden dependency ghosts. Each policy kind has a rendered test.
- **Built pages are smaller again**: the injected geometry and router runtimes, like the template, drop indentation and comment-only lines (build placeholders are kept), and the embedded layout no longer repeats each boundary's members or each route's polyline and label slot. Tests check the page carries exactly that code and that browser and Node routes agree.
- **Scenarios are a walkthrough**: a scenario becomes a path of numbered steps, decisions and outcome ends; you pick outcomes at decisions and the path (and step numbers) follow. A track at the bottom of the canvas shows one bead per entry (steps, parallel steps with ticks, decisions, outcome ends) with previous / play / next; the Walkthrough chapter lists every step with its narrative (generated ones marked) and the outcome buttons at each decision. Each step lights its components and connections, numbers parallel hops on the canvas, and is announced ("Step 4 of 11, …"). Keys: → / `j` next, ← / `k` previous, Space play (disabled under reduced motion), Esc ends. Links carry the step and any non-default outcomes (`at=`, `o=<decision>:<index>`); old stage links still land. Every lens works during a walkthrough.
- **The canvas shows the active lens**: Structure is neutral (a dashed ring marks anything not verified); Evidence borders and badges each card by its evidence state ("Verified · 3", "Declared · 2", "Planned", "Missing"); Change colours added, changed and removed components and their connections and mutes the unchanged ones; Risk marks failure modes and policy violations and draws ghost connections for forbidden-and-absent or required-and-missing rules. A lens key at the canvas's top right lists only the states present, and in Structure offers "Data flow only". Change colours no longer appear outside the Change lens. A lens never changes opacity, so the scenario spotlight reads the same in every lens.
- **A lens switcher replaces the view tabs**: Structure, Evidence, Change and Risk, as a radio group in the header (arrow keys, Home/End), keys `1`–`4`, a select on phones, a Lenses group in the palette, and `l=` in links. Change shows the Current / Proposed / Diff bar that the Delta tab had; old `view=before_after` links open Change. Chapters suggest a lens (Review suggests Risk, Evidence suggests Evidence, Changes and Plan suggest Change); a lens you pick survives the next chapter change, after which suggestions resume. Data Flow and Sequence are views in the palette; the Structure lens key's Filters toggles Data flow.
- **The rail is complete, and the left navigator is gone**: Overview (default; summary, facts, the trust rows with a button into each chapter, "How it works" from the primary scenario, what changes), Changes (added, changed, removed and moved components, blast radius, traceability gaps) and Evidence (every component's evidence state and every locator, uncapped) join Walkthrough, Review, Data and Plan. The navigator's outline and evidence list live in Evidence, its search in the ⌘K palette, its findings in Review and its scenarios in Walkthrough, so the canvas now runs from the left edge to the rail.
- **A trust strip under the header**: four pills say whether to believe the document (grounding, evidence, rules, open items), each with a state dot and words, each opening the chapter that explains it. Every value comes from the trust model; an illustrative diagram's grounding pill is dashed. It replaces the filter bar's Illustrative badge and the header's Gate button.
- **A calmer header**: title and status, the view tabs, Search (⌘K), Copy link (new: copies a link to the exact current view), the rail toggle, theme and Export, at most seven persistent controls. Present, Fullscreen and Animate are palette commands (Animate keeps its `A` key). Header and trust strip together stay within 104px.
- **A reading rail replaces the inspector drawer**: the right-hand rail holds chapters (Walkthrough, Review, Data, Plan) and a component sheet that opens over the current chapter, with Back to return and Show neighbours / Show blast radius on the sheet. Review gathers the quality gate, rules, findings, assumptions, open questions and decisions; Data and Plan replace the full-screen Data Model and Plan tabs, which no longer sit under the navigator. The rail docks from 900px wide, collapses and reopens from the header, and below 900px becomes a section of the page under the canvas. Links gain `c=<chapter>`, and old `view=database_er` / `view=implementation_plan` links open the matching chapter. The gate panel, the two tabs and the header Focus/Impact buttons are gone; their features live in the rail and the palette.
- **Built pages drop leading indentation** (about 35 KB): no workbench text depends on it, and a test guards that.
- **Built pages are about 45 KB smaller**: the embedded specification and layout are written as compact JSON instead of indented JSON. The data is identical; example 3 dropped from 390 KB to 344 KB at the time.
- **The header no longer pushes its controls off screen**: a long title ellipsizes instead of overflowing, so on a phone the menu, theme and search buttons stay reachable. Below 1100px the header drops Present, Fullscreen, Animate, Focus and Impact, which are palette commands.
- **Shared links are version 2, and old links keep working**: the URL hash is now `#v=2&n=<node>&s=<scenario>&at=<stage id>&step=<step number>&cam=<x>,<y>,<width>…`. Scenario stages and sequence steps are linked by their authored id and number instead of a position, so a link survives stages being added before it. The camera is a world region (centre and visible width) instead of screen pixels, so a link frames the same part of the diagram on any screen size and keeps framing it while panels dock or the window settles, until the reader moves the camera. An untouched, fitted view and a link to a scenario stage carry no camera, so they fit whatever screen opens them. Version 1 links (`view`, `node`, `scenario`, `stage`, `z`, `x`, `y`, …) still restore exactly as before. A link naming a component, connection, scenario, stage or step the model no longer has drops that part and says so in one sentence ("Step stage_x no longer exists; showing the walkthrough start."), and a link from a newer version is not half-applied.
- **View state has one writer**: theme, view, selection, filter, search, focus, presentation, scenario, stage, sequence step and camera change only through the named actions in `scripts/store.js`; a test fails if any other module writes them directly. The URL codec (`scripts/url.js`) is pure and unit-tested on its own.
- **A design system for the workbench**: one token set for both themes (`styles/tokens.css`) with an accent that means active and ok, warn and risk that carry meaning; three type voices (interface sans, explanation serif, mono for protocols, paths and technology); and one line-icon set for every component kind and control, so no emoji remain. Cards show an icon tile, a name that wraps to two lines instead of being cut, technology in mono, at most one change badge, and a dashed ring when a component is not verified, in place of the bracketed `[VERIFIED] [CHANGED]` tags. Boundaries are quiet tinted lanes; highlighted edges end in an accent arrowhead; focus rings use the accent instead of amber; data-model keys are chips instead of `[PK]` and `[FK→x]`. Behavior and geometry are unchanged: node, edge and label positions, camera and URL state, and every control's role are identical to the previous release.
- **Accessible names for icon-only buttons**: close, zoom, fit, reset, theme and the panel toggles carry an `aria-label` now that their glyphs are icons; several had no usable name before.

- **The workbench template is split into modules**: the 3,600-line `src/engine/template.html` is now `src/workbench/shell.html` plus 8 style and 18 script modules, joined by `src/workbench/assemble.js` into the same single offline HTML file. Behavior is unchanged: the assembled template is byte-identical to the old file, and the built examples render pixel-identical at 1440×900 in both themes. New tests check that every module is included exactly once, that the compiled page loads nothing from outside the file, and that every example stays within the page budget.

---

## [2.0.0] - 2026-09-21

Major architecture modeling and workbench release introducing the version 2 model schema, first-class evidence verification, policy enforcement, multi-scenario playback, and an overhauled responsive four-region workbench.

### Added

- **Version 2 Model Schema**: Introduced `schemaVersion: 2` with full backward-compatibility normalization for version 1 specifications.
- **Evidence Verification Subsystem**: First-class `evidence` array supporting `file`, `symbol`, `api`, `table`, `command`, `document`, and `assertion` locators with automated verification status evaluation (`verified`, `unresolved`, `stale`, `asserted`, `compatibility`).
- **Policy Engine & Structured Findings**: Built-in and customizable policies (`forbidden_dependency`, `required_dependency`, `layer_direction`, `cycle`, `required_evidence`, `fan_in`, `fan_out`, and `evidence.*`) with structured `findings` reported across the CLI, workbench, and Markdown reports.
- **Execution Scenarios**: Multi-scenario player supporting named serial, parallel, and branching stages with guard conditions, payload details, optional steps, failure modes, and automated recovery actions.
- **Review & Traceability Metadata**: Automated blast radius calculation (upstream and downstream dependencies of modified components), explicit assumptions, unresolved stakeholder questions, and implementation task traceability.
- **Responsive Four-Region Workbench**: Overhauled UI comprising a unified header bar, collapsible hierarchical navigator, main SVG canvas with minimap, and inspector drawers.
- **Mobile & Accessibility Enhancements**: Modal drawer behaviors on mobile viewports (320px/768px) with focus trapping and focus restoration on close; complete keyboard shortcuts; high-contrast non-color state indicators (shapes, borders, line dashes); and native `prefers-reduced-motion` support.
- **Canvas Exploration**: Focus-neighbor and affected-path isolation, search across nodes and edges, fullscreen presentation mode, URL state synchronization, and model-namespaced `localStorage` layout persistence.
- **Shared Geometry Runtime**: Unified `geometry.js` shared between compiler and client runtime providing reciprocal routing, port allocation, total visual bounds computation, and deterministic label collision avoidance.
- **Headless Chrome Automated Test Suite**: Expanded automated suite to 129 passing tests, including real Chrome validation at 320px, 768px, and 1440px viewports. A deterministic 100-node / 250-edge real-Chrome readiness smoke test measured 74ms on the maintainer machine (reported as a local reference measurement, not a universal benchmark).

### Changed

- **Normalization Standard**: V1 specifications with legacy `details.files`, `details.apis`, `details.tables`, and `views.sequence.steps` are automatically normalized into first-class `evidence` and `scenarios` structures.
- **Quality Gate Integration**: Quality Gate checks evaluate evidence resolution and policy findings alongside visual legibility metrics.
- **Package & Author Metadata**: Updated package version to `2.0.0` with author set to `Skill Atelier contributors`.

---

## [1.3.0] - 2026-09-17

Rendering-correctness release. Driven by visual correctness analysis of the generated page; every defect below
was reproduced and measured before it was changed, and re-measured after.

### Added

- `tests/rendered.test.js` — builds each example, runs it in **headless Chrome**, and asserts
  against the rendered DOM: path ends via `getPointAtLength`, every box via `getBBox` (so cylinder,
  chevron and pill node shapes are measured, not silently skipped), no label overlapping another
  label or a node, endpoints 6-20px outside their target, zero console errors. Skips cleanly when
  no browser is present. Mutation-verified: forcing `EDGE_END_GAP = 0` fails it with the offending
  edge and target named.
- Port distribution: edges arriving on the same node face fan out along it instead of stacking.
- Candidate-route scoring extended with a curve-sanity score that rejects a route whose curve
  reverses direction, folds back, or loops near its own end point.
- Deterministic label-overlap resolution pass after placement, plus endpoint zones as obstacles so
  a chip cannot cover an arrowhead.
- Boundary drag: a boundary moves with every node inside it, via a full-width invisible header hit
  strip (the title's real hit area was 13x5px of glyph).
- Regression tests for arrowhead orientation, arrowhead/line alignment, and shared arrival points.

### Fixed

- **Arrowheads scaled with stroke width.** The markers had no `markerUnits`, so SVG defaulted to
  `strokeWidth`: ~10.5px normally and ~21px on a highlighted edge. Now `userSpaceOnUse` at a fixed
  size.
- **Arrowheads stacked into a star-shaped blob** where several edges shared one arrival point
  (3 such points in the saga example). Port distribution fixes it: 0.
- **Arrowheads pointed the wrong way** — 18 of 43. SVG orients a marker along the curve's end
  tangent, which is set entirely by the last control point; `skip` and `sibling` detour routes put
  it off-axis. The last control point now sits on the arrival face's inward normal.
- **Arrowheads were rotated away from their own line** — 23 of 43, up to 63 degrees. Fixing the
  previous item snapped the tangent perpendicular while the curve body still arrived at an angle,
  leaving a visible corner under the arrow. Approach distance is now proportional to endpoint
  separation instead of a fixed 12-28px clamp. Worst case is now 10 degrees.
- **Curves folded back on themselves** between vertically adjacent cards: the sibling detour bowed
  ~140px sideways to cross a 34px gap.
- **Label chips overlapped** (`state + handlers` rendered as `tate + handlers`).
- **The boundary header painted the browser's default focus ring** over its label —
  `.boundary-toggle` had `tabindex="0"` but no `:focus-visible` rule.
- **Boundary tiers had ragged bottoms** (six tiers ending at 268/528/398/528/398/398). Equalised as
  a render-time display height; no node or edge moves.
- Contrast: light-theme accents darkened, badge tints split out with `currentColor` borders,
  `.filter-chip.active` corrected. Dead `--accent-indigo` removed; the dot grid was invisible in
  both themes (1.12:1 and 1.08:1).
- No `resize` handling at all: `overflow: hidden` plus a fixed transform stranded content with no
  way back. Added `dvh` units with `vh` fallbacks, a responsive inspector width, and a debounced
  re-fit gated behind a "user moved the view" latch.
- `validate --json` ignored `--strict`, so CI passed specs that failed locally.

### Changed

- Verification standard: model-level assertions are no longer sufficient on their own. Several
  checks in 1.2.0 scored a visibly broken page as clean, because they measured `computeLayout`'s
  output rather than what the browser paints. Rendered-DOM assertions are now the primary guard.
- Test count 67 -> 83.

---

## [1.2.0] - 2026-09-17

Review release. Three independent reviews (UI/UX, architecture, teaching) ran against the 1.1.0 output; everything
below was reproduced before it was changed, and measured after.

### Added

- `arch-viz scaffold` — drafts a spec from `git status` or `git diff --name-status <base>`: one node per changed
  file, boundaries grouped by directory, `delta` from the git status code, deleted files marked `INFERRED`/`REMOVED`,
  and edges derived from real `import`/`require` statements. Runs in under a second on a 21-file diff.
- `build` opens the generated page in the default browser by default; `--no-open` / `ARCH_VIZ_NO_OPEN=1` suppress it.
- Candidate-route scoring in the layout engine: each edge is drawn with the least-colliding of several deterministic
  routes (direct, channel above/below the content band via the side or the face, sibling detour left/right).
- Two-dimensional label placement: the anchor search now walks nine points along the curve **and** nine perpendicular
  offsets, treating other placed labels and boundary headers as obstacles.
- 25 tests (67 total), covering the diff scaffold, hostile placeholder content, CLI exit codes, label anchoring,
  edge/card crossings, and `failureModes` shape handling.

### Fixed

- **`failureModes` authored as strings rendered as `undefined`.** Both the Markdown report and the inspector read
  `{failure, impact, mitigation}`; the shipped spec used plain strings, so 7 real risk notes printed as
  `⚠️ **undefined** (Impact: *undefined*) -> Mitigation: undefined`. Both renderers now accept either shape, and the
  validator raises a hard error on an object with no `failure` text.
- **Placeholder substitution could emit a syntactically broken page and exit 0.** Placeholders were resolved left to
  right, so spec content containing a later placeholder's literal text was rescanned and replaced. Offsets are now
  computed against the pristine template and spliced from the last one backwards; duplicates are rejected.
- **`.delta-removed .node-rect` set `opacity: 0.6`**, making REMOVED cards translucent so edges and labels bled
  through them. Now `stroke-opacity`, leaving the card opaque.
- **Edge labels were pinned to `t = 0.5`** with no awareness of node boxes. Measured across the three examples and
  the working-tree diagram: 12 labels sat on a card and 1 pair overlapped; now 0 and 0.
- **The label anchor search compared a full collision sum against partial sums** (an early `break` that only fired
  once a best existed), making the winner depend on node array order.
- **The compiler and the browser reserved different label widths** (`len*5.6+12` vs `len*6.5`), so a "collision-free"
  anchor was not collision-free and labels jumped on the first drag. Both now use one `estimateLabelWidth`.
- **Backward edges exited through the top of their own card**, arching through whatever sat above them in the same
  column; they now leave sideways like a mirrored forward edge.
- **Edges spanning two or more tiers ran at near-constant `y` straight through every card in between.** Routing
  through a channel plus candidate scoring cut edges crossing a non-endpoint card from 14/43 to 6/43.
- **`scaffold --repo-root <subdir>` produced a wrong spec**: git reports paths relative to the repository root, so
  every node was mis-badged `INFERRED` and every edge lost. The real root is resolved with `rev-parse --show-toplevel`
  and `--repo-root` now scopes the diff instead.
- **`scaffold` invented edges from imports mentioned in comments and string literals**, and resolved an ambiguous
  trailing path to whichever file sorted first. Comments and strings are stripped; an ambiguous match yields no edge
  and is recorded in `meta.assumptions`.
- **`validate --json` ignored `--strict`** and exited 0 on warnings — the exact mode CI uses.
- **Status and delta badges had no matching CSS.** Only `.PROPOSED` and `.ACCEPTED` existed, so `VERIFIED`,
  `CHANGED`, `IN_REVIEW`, `REMOVED` and the rest rendered as bare uppercase text.
- **`.edge-path.read` cancelled the async dash** at equal specificity, leaving async encoded by colour alone.
- **`fitToScreen` counted its padding twice and then discounted by 0.9**, fitting at 0.52 zoom — card text landed at
  under 7px. Now 0.69 on the same diagram.
- **`resetView` showed 58% of the canvas anchored top-left**; it now clears selection and fits.
- Non-`VERIFIED` status text used `--text-dim` (3.07:1 at 9px); it is now amber at 10px.
- `init` and `scaffold` crashed with a raw `ENOENT` stack on a nested output path.
- `scaffold` id suffixes compounded (`card_card_2_3`); non-ASCII paths were C-quoted by porcelain v1 and never
  resolved (both now use `-z`).
- `openInBrowser` reported success before `spawn` could fail.
- Header tab labels wrapped onto three lines; they are now a single non-wrapping, scrollable row, and the subtitle
  is clamped to one line with the full text in its tooltip.

### Changed

- Gate 5 ("Clean routing") now **measures the drawing**: it samples every computed curve and counts the ones passing
  through a card that is not an endpoint. It previously counted rank distance and passed diagrams whose edges were
  drawn straight over components. Tolerance is 15% of edges; above that it warns and names them.
- Card metrics tightened for legibility: 240×110 → 200×96, title 13px → 15px, technology 11px → 10px uppercase,
  badges 9px → 10px, boundary gutter 90 → 120 with padding 36 → 20.
- Edge labels are painted at a maximum of 20 characters, with the full text in the element tooltip.
- `examples/2-complex-database-migration` pins `order` on its CDC tier, which removes a real edge/card crossing.

---

## [1.1.0] - 2026-09-17

Correctness release. Several 1.0.0 capabilities were documented but not implemented; they are implemented now, and
the documentation was rewritten to describe only what the code does.

### Added
- **Working exports**: SVG (theme variables inlined), PNG (2× canvas rasterization), Markdown report, and Mermaid
  source in a copyable modal, alongside standalone HTML. 1.0.0 shipped an HTML-only button.
- **Collapsible boundaries**: clicking (or keyboard-activating) a boundary title collapses the tier into a pill and
  hides its nodes *and their edges*. In 1.0.0 `collapsedBoundaries` was declared in state and never used.
- **Working Data Flow tab**: keeps `read` / `write` / `event` / `replication` paths, dims control traffic, starts the
  animation. In 1.0.0 the tab did nothing.
- **Executable quality gate**: `validateArchitecture` now returns all 14 gate results (`PASS` / `WARN` / `SKIP`), the
  CLI prints them, `compileArchitecture` embeds them in the page, and the Markdown report tabulates them.
  New checks: legibility, density, routing spans, layout determinism (computed twice and compared), inspector
  content, assumption justification, `VERIFIED` evidence, and implementation traceability.
- **CLI**: `mermaid` and `inspect` commands; `--strict`, `--repo-root` and `--json` on `validate`; `--repo-root` on
  `build`; unknown commands/options and missing option values now exit non-zero; `init` refuses to overwrite.
- **Slash commands** in `commands/` (`/visualize`, `/architecture`, `/design`, `/review-architecture`) with an install
  step. 1.0.0 claimed Claude Code registered them automatically; it does not.
- **Accessibility & input**: focusable nodes and boundary toggles with `role`/`aria-label`, Enter/Space activation,
  `<title>` tooltips carrying untruncated text, keyboard shortcuts (`F`, `0`, `+`/`−`, `A`, arrows, `Esc`),
  one-finger touch panning, shape-based node encoding (cylinder, chevron, pill, dashed border) so meaning never
  depends on colour alone, and `prefers-reduced-motion` support.
- **Theming**: follows `prefers-color-scheme` on first load and persists the manual toggle in `localStorage`.
- **Tests**: 42 cases across validator, layout, compiler/exporter and CLI suites, with per-case reporting.
- **`meta.grounding: "illustrative"`** to mark teaching examples whose file paths are not meant to exist.

### Fixed
- **Dangling edges**: hiding a node in `Current State` / `Proposed State` left its edges floating. Visibility is now
  computed in one pass over nodes *and* edges.
- **Edge labels during drag**: dragging a node moved its curves but left the labels behind; labels now follow, and the
  browser re-uses the compiler's bezier maths, including the backward and self-edge cases the drag handler ignored.
- **Label anchoring**: labels sit on the curve (cubic at t=0.5) instead of at the straight-line midpoint, which put
  them off the path on arcs.
- **Same-rank and self edges**: previously routed right-edge-to-left-edge and looped back through the node; they are
  now classified as `sibling` / `self` and routed accordingly.
- **Script injection**: spec JSON is `\u003c`-escaped before inlining, so a `</script>` in a description can no longer
  break out of the page; every DOM sink (inspector, ER view, plan view) escapes HTML.
- **`$&` corruption**: template placeholder substitution used `String.replace`, so a `$&` or `$'` inside the spec
  mangled the embedded JSON. Replacement is now literal.
- **Sequence player**: leaving the tab left nodes stuck in the selected state; steps with no backing edge highlighted
  nothing silently and now draw a dashed ghost link (and warn at validation time). `durationMs` per step is honoured.
- **Layout crash**: `computeLayout` threw a bare `TypeError` on a spec without `nodes`; it now fails with a message
  that says to validate first.
- **Non-deterministic particles**: initial particle offsets used `Math.random()` and the speed was per-frame, so the
  animation ran twice as fast on 120 Hz displays. Offsets are index-derived and the speed is time-based.
- **Crossing minimization**: 1.0.0 sorted nodes by in-degree and called it barycenter ordering. Real iterative
  barycenter sweeps are now implemented, with explicit `order` still pinning a node.
- **CLI `--strict` on validate** was documented but never parsed; `--md` no longer claims a default it does not have.

### Changed
- Examples are now `grounding: "illustrative"`, carry labels that fit the card, cite evidence for every `VERIFIED`
  node, include the saga's compensation edges that the sequence already referenced, and pass `validate --strict`.
- README rewritten: the "25 diagram types" claim is now a lens → view mapping, the layout engine is described as
  barycenter ordering over boundary ranks (not a full Sugiyama pipeline), and limitations list what is genuinely
  missing (no in-place C4 drill-down, PNG needs a browser, ER view is a card list).

---

## [1.0.0] - 2026-09-17

### Added
- **Initial Open Source Release** of `architecture-visualizer` for Claude Code, Cursor, and software engineering teams.
- **Core Reasoning Principle**: Implemented the 6-phase architectural workflow: `UNDERSTAND → MODEL → CHOOSE DIAGRAMS → VISUALIZE → VALIDATE → EXPLAIN`.
- **25 Supported Diagram Types**: Documented diagram selection matrix across system architectures, C4 models, data flows, sequence lifecycles, database ER diagrams, sagas, and migrations.
- **Deterministic Hierarchical Layout Engine**: Sugiyama-style rank assignment, barycenter crossings minimization, and smooth cubic bezier edge routing with zero random placement.
- **Zero-Dependency Interactive HTML Viewer**:
  - Fullscreen SVG canvas with matrix-based pan and smooth wheel zoom.
  - Draggable nodes with real-time dynamic edge updates.
  - Collapsible hierarchical boundary containers (`Frontend`, `API Gateway`, `Core Services`, `Data Tier`, `External`).
  - Side Inspector Drawer displaying responsibilities, repo source files, APIs, DB tables, test suites, checkable implementation tasks, and failure modes.
  - 1-click "Highlight Dependency Chain" isolating upstream and downstream blast radius.
  - Animated SVG particle flows communicating synchronous requests vs asynchronous events.
  - Step-by-step sequence player with Prev, Next, Play/Pause, and scrubber slider.
  - Before vs After 3-mode toggle: `Current State`, `Proposed State`, and `Delta Diff` (`ADDED`, `CHANGED`, `REMOVED`).
  - Search and filter bar by layer, delta status, and verification status.
  - Dual dark/light theme support.
  - Export suite: standalone HTML, SVG, PNG, Markdown reports, and Mermaid code.
- **Grounded Truth Verification**: Badges components as `VERIFIED`, `INFERRED`, `ASSUMED`, or `UNKNOWN`, verifying file paths against the repository on disk.
- **14-Point Quality Gate & Validator**: Automated structural and cross-reference validation engine.
- **Command-Line Interface (`arch-viz`)**:
  - `arch-viz build <spec.json>`: Compiles spec into interactive HTML and companion Markdown.
  - `arch-viz validate <spec.json>`: Runs quality gate validation.
  - `arch-viz init [output.json]`: Scaffolds a complete starter architecture model.
- **Three Realistic Production Scenarios**:
  1. *CRUD Business Feature*: Supplier Discounts & Volume Rebates in Inventory Valuation.
  2. *Complex Database Migration*: Zero-Downtime Monolithic Orders Table Partitioning with Dual-Writes & Debezium CDC.
  3. *Asynchronous Event-Driven Workflow*: Distributed Order Fulfillment Saga with Outbox Pattern, Kafka, DLQ, and Compensating Rollbacks.
- **Zero-Dependency Test Runner**: Comprehensive unit test suites for validator, layout engine, and compiler.
