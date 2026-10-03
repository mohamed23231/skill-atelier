const {
  buildEdgeGeometry,
  estimateLabelWidth,
  labelDisplayText,
  LABEL_HEIGHT
} = ArchVizGeometry;

const ARCH_SPEC = /* __ARCHITECTURE_SPEC_DATA__ */ {};
const LAYOUT_DATA = /* __COMPUTED_LAYOUT_DATA__ */ {};
const MERMAID_DATA = /* __MERMAID_DATA__ */ {};
const MARKDOWN_REPORT = /* __MARKDOWN_DATA__ */ "";
const QUALITY_GATE = /* __QUALITY_GATE_DATA__ */ [];

// Visualizer State
const PATH_TYPES = { REQUEST: 'request', RESPONSE: 'response', READ: 'read', WRITE: 'write', EVENT: 'event', REPLICATION: 'replication', CONTROL: 'control' };
const DATA_FLOW_PATH_TYPES = new Set([PATH_TYPES.READ, PATH_TYPES.WRITE, PATH_TYPES.EVENT, PATH_TYPES.REPLICATION]);
const VIEWS = { ARCHITECTURE: 'architecture', BEFORE_AFTER: 'before_after', DATA_FLOW: 'data_flow', SEQUENCE: 'sequence', DATABASE_ER: 'database_er', IMPLEMENTATION_PLAN: 'implementation_plan' };
const DELTA_MODES = { CURRENT: 'current', PROPOSED: 'proposed', DIFF: 'diff' };
const DELTA = { ADDED: 'ADDED', CHANGED: 'CHANGED', REMOVED: 'REMOVED', UNCHANGED: 'UNCHANGED', MOVED: 'MOVED' };
const THEMES = { DARK: 'dark', LIGHT: 'light' };
const THEME_STORAGE_KEY = 'arch-viz-theme';
const COLLAPSED_PILL_HEIGHT = 56;

const state = {
  theme: THEMES.DARK,
  currentView: VIEWS.ARCHITECTURE,
  deltaMode: DELTA_MODES.DIFF,
  animatingFlow: false,
  selectedNodeId: null,
  highlightedChain: null,
  activeFilter: 'all',
  searchQuery: '',
  userMovedView: false,
  sequenceIndex: 0,
  sequencePlaying: false,
  sequenceTimer: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDraggingCanvas: false,
  dragStartX: 0,
  dragStartY: 0,
  draggingNodeId: null,
  dragMoved: false,
  nodeDragOffset: { x: 0, y: 0 },
  draggingBoundaryId: null,
  boundaryDragOffset: { x: 0, y: 0 },
  boundaryInitialNodes: null,
  collapsedBoundaries: new Set(),
  focusMode: null,
  selectedEdgeId: null,
  presentation: false,
  scenarioId: null,
  scenarioStage: 0,
  scenarioActive: false,
  scenarioTimer: null,
  prefersReducedMotion: false
};
