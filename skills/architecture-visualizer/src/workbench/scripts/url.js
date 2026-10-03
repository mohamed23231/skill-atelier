// Pure, DOM-free codec for the workbench URL hash. Nothing here touches the document: callers pass
// plain values in and get plain values out, so the same functions run under Node in the tests.
const URL_CODEC_DEFAULT_VIEW = 'architecture';

// A "set" value is anything that survives the round trip. 0, false and '' all mean "not set".
function urlSet(value) {
  return value !== null && value !== undefined && value !== false && value !== '';
}

function urlFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function urlRound1(value) {
  return Math.round(value * 10) / 10;
}

// Integer >= 0 from a string or number, or null when absent, malformed or negative.
function urlIndexOf(raw) {
  if (!urlSet(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function urlParseCamera(raw) {
  if (!urlSet(raw)) return null;
  const parts = String(raw).split(',');
  if (parts.length !== 3) return null;
  const numbers = parts.map((part) => Number(part));
  if (!numbers.every(Number.isFinite)) return null;
  const [x, y, w] = numbers;
  if (!(w > 0)) return null;
  return { x, y, w };
}

// Version 1 keeps the stage and step as indices into the authored arrays; version 2 stores the
// authored stage id and step number instead. Both live on different keys so the caller can tell.
function urlParseV1(params) {
  const result = { version: 1 };
  const view = params.get('view');
  if (urlSet(view)) result.view = view;
  const node = params.get('node');
  if (urlSet(node)) result.node = node;
  const edge = params.get('edge');
  if (urlSet(edge)) result.edge = edge;
  const filter = params.get('filter');
  if (urlSet(filter)) result.filter = filter;
  const scenario = params.get('scenario');
  if (urlSet(scenario)) result.scenario = scenario;
  const focus = params.get('focus');
  if (urlSet(focus)) result.focus = focus;
  if (params.get('present') === '1') result.present = true;
  const stepIndex = urlIndexOf(params.get('step'));
  if (stepIndex !== null) result.stepIndex = stepIndex;
  const stageIndex = urlIndexOf(params.get('stage'));
  if (stageIndex !== null) result.stageIndex = stageIndex;
  const screenCamera = {};
  // Number(null) is 0, so a missing parameter must stay absent rather than read as the origin.
  const z = params.has('z') ? Number(params.get('z')) : NaN;
  if (Number.isFinite(z)) screenCamera.zoom = z;
  const x = params.has('x') ? Number(params.get('x')) : NaN;
  if (Number.isFinite(x)) screenCamera.panX = x;
  const y = params.has('y') ? Number(params.get('y')) : NaN;
  if (Number.isFinite(y)) screenCamera.panY = y;
  if (Object.keys(screenCamera).length > 0) result.screenCamera = screenCamera;
  return result;
}

function urlParseV2(params) {
  const result = { version: 2 };
  const chapter = params.get('c');
  if (urlSet(chapter)) result.chapter = chapter;
  const lens = params.get('l');
  if (urlSet(lens)) result.lens = lens;
  const view = params.get('view');
  if (urlSet(view)) result.view = view;
  const node = params.get('n');
  if (urlSet(node)) result.node = node;
  const edge = params.get('e');
  if (urlSet(edge)) result.edge = edge;
  const scenario = params.get('s');
  if (urlSet(scenario)) result.scenario = scenario;
  const stage = params.get('at');
  if (urlSet(stage)) result.stage = stage;
  const step = urlIndexOf(params.get('step'));
  if (step !== null) result.step = step;
  const filter = params.get('filter');
  if (urlSet(filter)) result.filter = filter;
  const focus = params.get('focus');
  if (urlSet(focus)) result.focus = focus;
  if (params.get('present') === '1') result.present = true;
  const camera = urlParseCamera(params.get('cam'));
  if (camera) result.camera = camera;
  return result;
}

function encodeViewHash(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const params = new URLSearchParams();
  let camSuffix = '';
  params.set('v', '2');
  if (urlSet(source.chapter) && source.chapter !== 'overview') params.set('c', String(source.chapter));
  if (urlSet(source.lens) && source.lens !== 'structure') params.set('l', String(source.lens));
  if (urlSet(source.view) && source.view !== URL_CODEC_DEFAULT_VIEW) params.set('view', String(source.view));
  if (urlSet(source.node)) params.set('n', String(source.node));
  if (urlSet(source.edge)) params.set('e', String(source.edge));
  if (urlSet(source.scenario)) params.set('s', String(source.scenario));
  if (urlSet(source.stage)) params.set('at', String(source.stage));
  const step = urlIndexOf(source.step);
  if (step !== null) params.set('step', String(step));
  if (urlSet(source.filter)) params.set('filter', String(source.filter));
  if (urlSet(source.focus)) params.set('focus', String(source.focus));
  if (source.present === true) params.set('present', '1');
  const camera = source.camera;
  if (camera && typeof camera === 'object') {
    const { x, y, w } = camera;
    if (urlFiniteNumber(x) && urlFiniteNumber(y) && urlFiniteNumber(w) && w > 0) {
      // The comma is part of the grammar, so it is appended unencoded rather than through `set`.
      camSuffix = `&cam=${urlRound1(x)},${urlRound1(y)},${urlRound1(w)}`;
    }
  }
  return params.toString() + camSuffix;
}

function parseViewHash(hash) {
  const source = typeof hash === 'string' ? hash : '';
  const raw = source.startsWith('#') ? source.slice(1) : source;
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch (error) {
    params = new URLSearchParams('');
  }
  const version = params.get('v');
  if (version === null) return urlParseV1(params);
  if (version === '2') return urlParseV2(params);
  const numeric = Number(version);
  return { version: Number.isFinite(numeric) ? numeric : version, unsupported: true };
}

// The SVG viewport is drawn with matrix(zoom 0 0 zoom panX panY), so the world point under the
// canvas centre is the inverse of that transform, and the visible width is the canvas width / zoom.
function cameraToWorld(camera, size) {
  const zoom = camera && Number.isFinite(camera.zoom) && camera.zoom !== 0 ? camera.zoom : 1;
  const panX = camera && Number.isFinite(camera.panX) ? camera.panX : 0;
  const panY = camera && Number.isFinite(camera.panY) ? camera.panY : 0;
  const width = size ? size.width : 0;
  const height = size ? size.height : 0;
  return {
    x: (width / 2 - panX) / zoom,
    y: (height / 2 - panY) / zoom,
    w: width / zoom,
  };
}

function worldToCamera(world, size) {
  const x = world && Number.isFinite(world.x) ? world.x : 0;
  const y = world && Number.isFinite(world.y) ? world.y : 0;
  const w = world && Number.isFinite(world.w) && world.w !== 0 ? world.w : 1;
  const width = size ? size.width : 0;
  const height = size ? size.height : 0;
  const zoom = width / w;
  return {
    zoom,
    panX: width / 2 - x * zoom,
    panY: height / 2 - y * zoom,
  };
}
