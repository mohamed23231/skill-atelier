// The only writer of view state. Reads stay as `state.x`; every write goes through an action here.
const STORE_FIELDS = Object.freeze(['theme', 'chapter', 'lens', 'lensExplicit', 'currentView', 'deltaMode', 'selectedNodeId', 'selectedEdgeId',
  'activeFilter', 'searchQuery', 'focusMode', 'presentation', 'scenarioId', 'scenarioStage', 'scenarioActive',
  'walkChoices', 'walkCursor',
  'sequenceIndex', 'zoom', 'panX', 'panY', 'userMovedView']);

const actions = Object.freeze({
  setTheme(theme) { state.theme = theme; },
  setChapter(chapter) { state.chapter = chapter; },
  setLens(lens, explicit) { state.lens = lens; state.lensExplicit = explicit; },
  setView(view) { state.currentView = view; },
  setDeltaMode(mode) { state.deltaMode = mode; },
  selectNode(id) { state.selectedNodeId = id; },        // id or null
  selectEdge(id) { state.selectedEdgeId = id; },        // id or null
  clearSelection() { state.selectedNodeId = null; state.selectedEdgeId = null; state.focusMode = null; },
  setFilter(filter) { state.activeFilter = filter; },
  setSearchQuery(query) { state.searchQuery = query; },
  setFocusMode(mode) { state.focusMode = mode; },       // mode or null; not a toggle
  setPresentation(enabled) { state.presentation = enabled; },
  setScenario(id) { state.scenarioId = id; },
  setScenarioStage(index) { state.scenarioStage = index; },
  setScenarioActive(active) { state.scenarioActive = active; },
  setWalkChoices(choices) { state.walkChoices = choices && typeof choices === 'object' ? { ...choices } : {}; },
  setWalkChoice(decisionId, index) { state.walkChoices = { ...state.walkChoices, [decisionId]: index }; },
  setWalkCursor(id) { state.walkCursor = id; },
  setSequenceIndex(index) { state.sequenceIndex = index; },
  // Any subset of { zoom, panX, panY, userMoved }; omitted keys are left as they are.
  setCamera({ zoom, panX, panY, userMoved } = {}) {
    if (zoom !== undefined) state.zoom = zoom;
    if (panX !== undefined) state.panX = panX;
    if (panY !== undefined) state.panY = panY;
    if (userMoved !== undefined) state.userMovedView = userMoved;
  }
});
