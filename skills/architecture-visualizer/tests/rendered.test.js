const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileArchitecture } = require('../src/engine/compiler.js');
const geometry = require('../src/engine/geometry.js');
const { loadTemplate } = require('../src/workbench/assemble.js');
const fixtures = require('./fixtures.js');

const REGION_NAMES = ['topbar', 'canvas', 'rail'];
const CAMERA_CONTROL_SELECTORS = ['#btn-zoom-in', '#btn-zoom-out', '#btn-fit', '#btn-reset'];
const templateHtml = loadTemplate();
const bpMatch = templateHtml.match(/const\s+PANEL_BREAKPOINT\s*=\s*(\d+)/);
const PANEL_BREAKPOINT = bpMatch ? Number(bpMatch[1]) : 1100;
const VIEWPORTS = [
  { width: 320, height: 800, mobile: false },
  { width: 768, height: 900, mobile: false },
  { width: 1440, height: 900, mobile: false },
];

const q = (value) => JSON.stringify(value);

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const commands = ['google-chrome', 'chromium', 'chromium-browser'];
  for (const cmd of commands) {
    try {
      const p = execFileSync('which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const CDP_WORKER_SOURCE = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitForFile(file, timeoutMs) {
  var start = Date.now();
  for (;;) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch (e) {}
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + file);
    await delay(50);
  }
}

async function fetchJson(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    var res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function CdpSession(ws) {
  var self = this;
  this.ws = ws;
  this.nextId = 0;
  this.pending = new Map();
  this.listeners = new Map();
  ws.addEventListener('message', function (event) {
    var message = JSON.parse(event.data);
    if (message.id != null) {
      var entry = self.pending.get(message.id);
      if (!entry) return;
      self.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.code + ': ' + message.error.message));
      else entry.resolve(message.result);
      return;
    }
    var handlers = self.listeners.get(message.method);
    if (handlers) handlers.slice().forEach(function (handler) { handler(message.params); });
  });
}

CdpSession.prototype.send = function (method, params) {
  var self = this;
  var id = ++this.nextId;
  return new Promise(function (resolve, reject) {
    self.pending.set(id, { resolve: resolve, reject: reject });
    self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
};

CdpSession.prototype.once = function (method, timeoutMs) {
  var self = this;
  var limit = timeoutMs || 20000;
  return new Promise(function (resolve, reject) {
    var handler = function (params) {
      clearTimeout(timer);
      var handlers = self.listeners.get(method) || [];
      var index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
      resolve(params);
    };
    var timer = setTimeout(function () {
      var handlers = self.listeners.get(method) || [];
      var index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
      reject(new Error('timed out waiting for ' + method));
    }, limit);
    var handlers = self.listeners.get(method) || [];
    handlers.push(handler);
    self.listeners.set(method, handlers);
  });
};

async function evaluate(session, expression) {
  var result = await session.send('Runtime.evaluate', {
    expression: expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    var details = result.exceptionDetails;
    var description = (details.exception && (details.exception.description || details.exception.value)) || details.text;
    throw new Error('page script failed: ' + description);
  }
  return result.result ? result.result.value : undefined;
}

async function dispatchMouse(session, type, point, button, buttons, clickCount) {
  await session.send('Input.dispatchMouseEvent', {
    type: type,
    x: point.x,
    y: point.y,
    button: button || 'none',
    buttons: buttons == null ? 0 : buttons,
    clickCount: clickCount == null ? 0 : clickCount,
  });
}

async function resolvePoint(session, selector, fx, fy, fallbackX, fallbackY) {
  if (selector) {
    var packed = await evaluate(session, 'JSON.stringify((function () { var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })())');
    if (!packed) return null;
    var rect = JSON.parse(packed);
    if (!rect) return null;
    var useX = fx == null ? 0.5 : fx;
    var useY = fy == null ? 0.5 : fy;
    return { x: rect.x + rect.width * useX, y: rect.y + rect.height * useY };
  }
  return { x: fallbackX, y: fallbackY };
}

async function runKeyStep(session, step) {
  var virtualKeyCode = step.windowsVirtualKeyCode || 0;
  var common = {
    key: step.key,
    code: step.code || step.key,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers: step.modifiers || 0,
  };
  await session.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, common));
  await session.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, common));
}

async function runMouseStep(session, step) {
  if (step.action === 'click') {
    var point = await resolvePoint(session, step.selector, step.fx, step.fy, step.x, step.y);
    if (!point) return;
    await dispatchMouse(session, 'mousePressed', point, 'left', 1, 1);
    await dispatchMouse(session, 'mouseReleased', point, 'left', 0, 1);
    return;
  }
  if (step.action === 'drag') {
    var from = await resolvePoint(session, step.selector, step.fromFx, step.fromFy, step.x, step.y);
    var to = await resolvePoint(session, step.selector, step.toFx, step.toFy, step.toX, step.toY);
    if (!from || !to) return;
    await dispatchMouse(session, 'mouseMoved', from, 'none', 0, 0);
    await dispatchMouse(session, 'mousePressed', from, 'left', 1, 1);
    var segments = step.segments || 8;
    for (var s = 1; s <= segments; s++) {
      var t = s / segments;
      await dispatchMouse(session, 'mouseMoved', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, 'left', 1, 0);
      await delay(12);
    }
    await dispatchMouse(session, 'mouseReleased', to, 'left', 0, 1);
    return;
  }
  throw new Error('unknown mouse action: ' + step.action);
}

async function main() {
  var config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  var profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-chrome-'));
  var child = spawn(
    config.chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true }
  );

  var socket = null;
  var terminated = false;

  async function teardown() {
    try {
      if (socket) socket.close();
    } catch (e) {}
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (e) {
      try { child.kill('SIGKILL'); } catch (e2) {}
    }
    await delay(100);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (e) {}
  }

  function onTerminate() {
    if (terminated) return;
    terminated = true;
    teardown().then(function () { process.exit(1); }, function () { process.exit(1); });
  }
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onTerminate);

  try {
    var activePort = await waitForFile(path.join(profileDir, 'DevToolsActivePort'), 20000);
    var port = parseInt(activePort.split('\n')[0], 10);
    if (!port) throw new Error('invalid DevToolsActivePort contents: ' + JSON.stringify(activePort));

    var page = null;
    var deadline = Date.now() + 15000;
    while (!page && Date.now() < deadline) {
      try {
        var targets = await fetchJson('http://127.0.0.1:' + port + '/json/list', 5000);
        page = targets.find(function (target) { return target.type === 'page' && target.webSocketDebuggerUrl; }) || null;
      } catch (e) {
        page = null;
      }
      if (!page) await delay(50);
    }
    if (!page) throw new Error('no debuggable page target appeared');

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(function (resolve, reject) {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', function () { reject(new Error('failed to open DevTools websocket')); }, { once: true });
    });
    var session = new CdpSession(socket);

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    if (config.preload) {
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: config.preload });
    }

    var loaded = session.once('Page.loadEventFired', 20000);
    await session.send('Page.navigate', { url: config.url });
    await loaded;
    await evaluate(session, 'new Promise(function (resolve) { if (document.readyState === "complete") resolve(1); else window.addEventListener("load", function () { resolve(1); }, { once: true }); })');
    await session.send('Page.bringToFront');

    var results = [];
    var phases = config.phases || [];
    for (var i = 0; i < phases.length; i++) {
      var phase = phases[i];
      if (phase.width && phase.height) {
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: phase.width,
          height: phase.height,
          deviceScaleFactor: 1,
          mobile: !!phase.mobile,
        });
      } else {
        await session.send('Emulation.clearDeviceMetricsOverride');
      }
      await evaluate(session, 'new Promise(function (resolve) { requestAnimationFrame(function () { resolve(1); }); })');

      if (phase.steps) {
        var stepResults = [];
        for (var s = 0; s < phase.steps.length; s++) {
          var step = phase.steps[s];
          if (step.kind === 'eval') {
            var evaluated = await evaluate(session, step.script);
            stepResults.push({ kind: 'eval', value: evaluated == null ? null : evaluated });
          } else if (step.kind === 'key') {
            await runKeyStep(session, step);
            stepResults.push({ kind: 'key', key: step.key });
          } else if (step.kind === 'mouse') {
            await runMouseStep(session, step);
            stepResults.push({ kind: 'mouse', action: step.action });
          } else {
            throw new Error('unknown step kind: ' + step.kind);
          }
        }
        results.push(stepResults);
      } else {
        var value = await evaluate(session, phase.script);
        results.push(value == null ? null : value);
      }
      await delay(40);
    }

    process.stdout.write('\n__ARCH_VIZ_RESULT__' + JSON.stringify(results) + '\n');
    await teardown();
    process.exit(0);
  } catch (error) {
    process.stdout.write('\n__ARCH_VIZ_ERROR__' + JSON.stringify(String((error && error.stack) || error)) + '\n');
    await teardown();
    process.exit(1);
  }
}

main();
`;

const ERROR_PRELOAD =
  'window.__errors = []; window.onerror = function (msg, url, line, col, err) { window.__errors.push({ msg: String(msg), url: url, line: line, col: col, stack: err && err.stack }); };';

function runBrowser(config) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-browser-'));
  const workerPath = path.join(workDir, 'cdp-worker.js');
  const configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(workerPath, CDP_WORKER_SOURCE, 'utf8');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

  let output;
  try {
    output = execFileSync(process.execPath, [workerPath, configPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.timeoutMs || 90000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    const errorMatch = stdout.match(/__ARCH_VIZ_ERROR__([\s\S]*)/);
    if (errorMatch) {
      let message = errorMatch[1].trim();
      try {
        message = JSON.parse(message);
      } catch {}
      throw new Error(message);
    }
    throw new Error('browser worker failed: ' + (stderr || stdout || err.message));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const match = output.match(/__ARCH_VIZ_RESULT__([\s\S]*)/);
  assert.ok(match, 'browser worker produced no result payload');
  return JSON.parse(match[1].trim());
}

function runPhases(specRelOrSpec, phases, timeoutMs, options = {}) {
  const chrome = findChrome();
  assert.ok(chrome, 'no Chrome/Chromium binary available for rendered verification');

  let html;
  if (typeof specRelOrSpec === 'string') {
    const specPath = path.join(__dirname, '..', specRelOrSpec);
    html = compileArchitecture(JSON.parse(fs.readFileSync(specPath, 'utf8')), options.compileOptions || {}).html;
  } else {
    html = compileArchitecture(specRelOrSpec, options.compileOptions || {}).html;
  }

  const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-page-'));
  const pagePath = path.join(pageDir, 'rendered.html');
  fs.writeFileSync(pagePath, html, 'utf8');
  try {
    return runBrowser({
      chrome,
      url: 'file://' + pagePath,
      // A deep link is injected before the page boots: file:// fragments are not reliably kept by navigation.
      preload: options.hash ? `${ERROR_PRELOAD} history.replaceState(null, '', ${JSON.stringify(`#${options.hash}`)});` : ERROR_PRELOAD,
      phases,
      timeoutMs,
    });
  } finally {
    fs.rmSync(pageDir, { recursive: true, force: true });
  }
}

const ev = (script) => ({ kind: 'eval', script });
const key = (keyName, options) => Object.assign({ kind: 'key', key: keyName }, options);
const mouse = (options) => Object.assign({ kind: 'mouse' }, options);

const TAB = () => key('Tab', { code: 'Tab', windowsVirtualKeyCode: 9 });
const SHIFT_TAB = () => key('Tab', { code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
const ESCAPE = () => key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
const ENTER = () => key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 });

function lastEvalValue(stepResults) {
  if (!Array.isArray(stepResults)) return null;
  const values = stepResults.filter((step) => step && step.kind === 'eval').map((step) => step.value);
  return values.length ? values[values.length - 1] : null;
}

const MEASURE_SCRIPT = `(function () {
  const data = { edges: [], nodes: [], labels: [], errors: window.__errors || [] };

  (LAYOUT_DATA.nodes || []).forEach(function (n) {
    const nodeEl = document.getElementById("node-" + n.id);
    const rectEl = nodeEl ? nodeEl.querySelector(".node-rect") : null;
    const bbox = rectEl ? rectEl.getBBox() : null;
    data.nodes.push({
      id: n.id,
      x: n.x,
      y: n.y,
      type: n.type || null,
      width: n.width || null,
      height: n.height || null,
      bbox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null
    });
  });

  (LAYOUT_DATA.edges || []).forEach(function (e) {
    const pathEl = document.getElementById("path-" + e.id);
    const len = pathEl ? pathEl.getTotalLength() : 0;
    const pt = pathEl ? pathEl.getPointAtLength(len) : null;
    let kinkDeg = null;
    if (pathEl && len >= 12) {
      const ptNear = pathEl.getPointAtLength(Math.max(0, len - 0.1));
      const pt12 = pathEl.getPointAtLength(Math.max(0, len - 12));
      const tan = { x: pt.x - ptNear.x, y: pt.y - ptNear.y };
      const chord = { x: pt.x - pt12.x, y: pt.y - pt12.y };
      const m = Math.hypot(tan.x, tan.y) * Math.hypot(chord.x, chord.y);
      kinkDeg = Math.round(Math.acos(Math.max(-1, Math.min(1, m > 0 ? (tan.x * chord.x + tan.y * chord.y) / m : 1))) * 180 / Math.PI);
    }
    data.edges.push({
      id: e.id,
      target: e.target,
      targetFace: e.points && e.points.targetFace ? e.points.targetFace : null,
      modelX2: e.points.x2,
      modelY2: e.points.y2,
      endPt: pt ? { x: pt.x, y: pt.y } : null,
      kinkDeg: kinkDeg
    });
  });

  const labelEls = document.querySelectorAll(".edge-label");
  labelEls.forEach(function (el) {
    const bg = el.querySelector(".edge-label-bg");
    const bbox = bg ? bg.getBBox() : el.getBBox();
    data.labels.push({
      id: el.id,
      bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
    });
  });

  return data;
})()`;

function measureRenderedDom(specRel) {
  const results = runPhases(specRel, [{ width: 1440, height: 900, mobile: false, script: MEASURE_SCRIPT }]);
  return results[0];
}

function assertMeasurements(metrics, specRel) {
  assert.ok(metrics, `rendered measurement data missing for ${specRel}`);
  assert.strictEqual(metrics.errors.length, 0, `console errors detected in ${specRel}: ${JSON.stringify(metrics.errors)}`);

  const nodeMap = new Map(
    metrics.nodes.map((n) => [
      n.id,
      {
        left: n.x + (n.bbox ? n.bbox.x : 0),
        right: n.x + (n.bbox ? n.bbox.x + n.bbox.width : 0),
        top: n.y + (n.bbox ? n.bbox.y : 0),
        bottom: n.y + (n.bbox ? n.bbox.y + n.bbox.height : 0),
      },
    ])
  );

  metrics.edges.forEach((e) => {
    assert.ok(e.endPt, `rendered path endpoint missing for edge ${e.id} in ${specRel}`);

    const drift = Math.hypot(e.endPt.x - e.modelX2, e.endPt.y - e.modelY2);
    assert.ok(drift <= 2, `endpoint drift ${drift.toFixed(2)}px > 2px on edge ${e.id} in ${specRel}`);

    const targetNode = metrics.nodes.find((n) => n.id === e.target);
    if (targetNode && targetNode.width && targetNode.height) {
      // Gap is measured against the *drawn* shape outline (chevron, pill,
      // cylinder, rounded card), not the rectangular bounding box.
      const face = e.targetFace || 'left';
      let gap;
      if (face === 'left' || face === 'right') {
        const dy = e.endPt.y - (targetNode.y + targetNode.height / 2);
        const boundaryX = face === 'left' ? geometry.shapeLeftX(targetNode, dy) : geometry.shapeRightX(targetNode, dy);
        gap = Math.abs(e.endPt.x - boundaryX);
      } else {
        const dx = e.endPt.x - (targetNode.x + targetNode.width / 2);
        const boundaryY = face === 'top' ? geometry.shapeTopY(targetNode, dx) : geometry.shapeBottomY(targetNode, dx);
        gap = Math.abs(e.endPt.y - boundaryY);
      }
      assert.ok(
        gap >= 6 && gap <= 16,
        `endpoint gap ${gap.toFixed(2)}px from the ${face} outline not between 6px and 16px on edge ${e.id} arriving at ${e.target} in ${specRel}`
      );
    }

    if (typeof e.kinkDeg === 'number') {
      assert.ok(e.kinkDeg <= 8, `rendered marker kink ${e.kinkDeg} deg > 8 deg on edge ${e.id} in ${specRel}`);
    }
  });

  for (let i = 0; i < metrics.labels.length; i++) {
    for (let j = i + 1; j < metrics.labels.length; j++) {
      const b1 = metrics.labels[i].bbox;
      const b2 = metrics.labels[j].bbox;
      const overlapping = b1.x < b2.x + b2.width && b1.x + b1.width > b2.x && b1.y < b2.y + b2.height && b1.y + b1.height > b2.y;
      assert.strictEqual(overlapping, false, `label collision between ${metrics.labels[i].id} and ${metrics.labels[j].id} in ${specRel}`);
    }
  }

  for (const l of metrics.labels) {
    const lb = l.bbox;
    for (const [nid, nb] of nodeMap.entries()) {
      const overlapping = lb.x < nb.right && lb.x + lb.width > nb.left && lb.y < nb.bottom && lb.y + lb.height > nb.top;
      assert.strictEqual(overlapping, false, `label ${l.id} overlaps node card ${nid} in ${specRel}`);
    }
  }
}

const PAGE_HELPERS = [
  'const __sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };',
  'const __q = function (sel) { return document.querySelector(sel); };',
  'const __qa = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };',
  'const __region = function (name) { return document.querySelector(\'[data-region="\' + name + \'"]\'); };',
  'const __open = function (name) { var el = __region(name); return el ? el.getAttribute("data-open") : null; };',
  'const __rect = function (el) { if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };',
  'const __visible = function (el) { if (!el) return false; if (el.getAttribute("data-open") === "false") return false; var r = el.getBoundingClientRect(); if (r.width <= 0.5 || r.height <= 0.5) return false; var vw = window.innerWidth; var vh = window.innerHeight; var ix = Math.min(r.right, vw) - Math.max(r.left, 0); var iy = Math.min(r.bottom, vh) - Math.max(r.top, 0); return ix > 0.5 && iy > 0.5; };',
  'const __transform = function () { var el = document.getElementById("viewport-group"); return el ? el.getAttribute("transform") : null; };',
  'const __fire = function (el, type, x, y) { if (!el) return; var init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 }; var isPointer = type.indexOf("pointer") === 0 && typeof PointerEvent === "function"; var Ctor = isPointer ? PointerEvent : MouseEvent; if (isPointer) { init.pointerId = 1; init.pointerType = "mouse"; init.isPrimary = true; } el.dispatchEvent(new Ctor(type, init)); };',
  'const __click = function (el) { if (!el) return false; var r = el.getBoundingClientRect(); var x = r.left + r.width / 2; var y = r.top + r.height / 2; ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (t) { __fire(el, t, x, y); }); return true; };',
  'const __input = function (el, value) { if (!el) return; var proto = Object.getPrototypeOf(el); var desc = Object.getOwnPropertyDescriptor(proto, "value"); if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; } el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };',
  'const __waitFor = async function (fn, ms) { var limit = ms || 2000; var start = Date.now(); for (;;) { var v = null; try { v = fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - start > limit) return null; await __sleep(30); } };',
  'const __inside = function (el) { return !!(el && (el === document.activeElement || el.contains(document.activeElement))); };',
  'const __tabbables = function (root) { if (!root) return []; var nodes = Array.prototype.slice.call(root.querySelectorAll(\'a[href], button, input, select, textarea, [tabindex]\')); return nodes.filter(function (el) { if (el.disabled) return false; var ti = el.getAttribute("tabindex"); if (ti != null && parseInt(ti, 10) < 0) return false; if (el.getAttribute("aria-hidden") === "true") return false; var r = el.getBoundingClientRect(); if (r.width <= 0.5 || r.height <= 0.5) return false; if (el.getAttribute("data-open") === "false") return false; return true; }); };',
  'const __record = function (k, v) { if (!window.__obs) window.__obs = {}; window.__obs[k] = v; return v; };',
  'const __observed = function () { return window.__obs || {}; };',
].join('\n');

function regionsScript() {
  return `(async function () {
    ${PAGE_HELPERS}
    await __sleep(120);
    var out = { innerWidth: window.innerWidth, innerHeight: window.innerHeight, present: {}, rects: {}, visible: {} };
    ${q(REGION_NAMES)}.forEach(function (name) {
      var el = __region(name);
      out.present[name] = !!el;
      out.rects[name] = __rect(el);
      out.visible[name] = __visible(el);
    });
    out.navigatorPresent = !!__q('.workbench-navigator');
    var minimap = __region('minimap');
    out.minimap = { present: !!minimap, rect: __rect(minimap), visible: __visible(minimap) };
    out.cameraControls = ${q(CAMERA_CONTROL_SELECTORS)}.map(function (sel) {
      var el = __q(sel);
      return { selector: sel, rect: __rect(el), visible: __visible(el) };
    });
    return out;
  })()`;
}

function drawerSteps() {
  const railToggle = '[data-action="rail-toggle"]';
  const steps = [];

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('railToggle', !!__q(${q(railToggle)}));
      __record('railInitialOpen', __open('rail'));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q(${q(railToggle)}));
      await __sleep(100);
      __record('railOpen', __open('rail'));
      __record('railVisible', __visible(__region('rail')));
      __record('railFocusOnOpen', __inside(__region('rail')));
      var tabbables = __tabbables(__region('rail'));
      __record('railTabbableCount', tabbables.length);
      var last = tabbables[tabbables.length - 1];
      var first = tabbables[0];
      if (last) last.focus();
      __record('railLastTabbableFocused', !!last && document.activeElement === last);
      if (first) first.focus();
      __record('railFirstTabbableFocused', !!first && document.activeElement === first);
      return __observed();
    })()`)
  );

  steps.push(TAB());
  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(60);
      __record('railForwardWrappedInside', __inside(__region('rail')));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      var tabbables = __tabbables(__region('rail'));
      var first = tabbables[0];
      if (first) first.focus();
      __record('railFirstRefocused', !!first && document.activeElement === first);
      return __observed();
    })()`)
  );

  steps.push(SHIFT_TAB());
  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(60);
      __record('railBackwardWrappedInside', __inside(__region('rail')));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      var backdrop = __q('[data-action="drawer-backdrop"]');
      __record('backdropPresent', !!backdrop);
      __click(backdrop);
      await __sleep(120);
      __record('railAfterBackdropOpen', __open('rail'));
      __record('backdropFocusRestored', document.activeElement === __q(${q(railToggle)}));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q(${q(railToggle)}));
      await __sleep(100);
      var close = __q('[data-action="rail-close"]');
      __record('railCloseControl', !!close);
      __click(close);
      await __sleep(120);
      __record('railAfterCloseOpen', __open('rail'));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      openInspectorForNode('api');
      await __sleep(100);
      var back = __q('[data-action="sheet-back"]');
      __record('sheetBackPresent', !!back);
      hideSheetKeepSelection();
      setDrawerOpen('rail', false);
      return __observed();
    })()`)
  );

  return steps;
}

// Search now lives in the command palette; these rows carry the same data-model-id contract.
function searchSteps(label, modelId, selectedSelector, expectedKind) {
  const resultSelector = `#palette-list [data-model-id=${q(modelId)}]`;
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('expectedKind', ${q(expectedKind)});
      __click(__q('#btn-palette'));
      await __sleep(120);
      var input = __q('#palette-input');
      __record('paletteOpen', __q('#palette-scrim') ? __q('#palette-scrim').getAttribute('data-open') : null);
      __record('paletteInputPresent', !!input);
      __record('transformBefore', __transform());
      __input(input, ${q(label)});
      var result = await __waitFor(function () { return __q(${q(resultSelector)}); }, 2500);
      __record('resultPresent', !!result);
      // The palette rows are combo options driven by aria-activedescendant, so the input keeps focus.
      __record('resultFocused', document.activeElement === input && !!result && input.getAttribute('aria-activedescendant') === result.id);
      return __observed();
    })()`),
    ENTER(),
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(200);
      __record('selectionPresent', !!__q(${q(selectedSelector)}));
      __record('railOpen', __open('rail'));
      __record('railSheet', __region('rail') ? __region('rail').getAttribute('data-sheet') : null);
      __record('transformAfter', __transform());
      return __observed();
    })()`),
  ];
}

function minimapSteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      var minimap = __region('minimap');
      __record('minimapPresent', !!minimap);
      __record('nodeMarkCount', __qa('[data-minimap-mark="node"]').length);
      __record('boundaryMarkCount', __qa('[data-minimap-mark="boundary"]').length);
      __record('expectedNodeMarks', (LAYOUT_DATA.nodes || []).length);
      __record('expectedBoundaryMarks', (LAYOUT_DATA.boundaries || []).length);
      var viewport = __q('[data-minimap-viewport]');
      __record('viewportPresent', !!viewport);
      __record('viewportBefore', __rect(viewport));
      __record('transformBefore', __transform());
      return __observed();
    })()`),
    mouse({ action: 'click', selector: '#btn-zoom-in', fx: 0.5, fy: 0.5 }),
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(180);
      __record('viewportAfterZoom', __rect(__q('[data-minimap-viewport]')));
      __record('transformAfterZoom', __transform());
      return __observed();
    })()`),
    mouse({ action: 'drag', selector: '[data-region="canvas"]', fromFx: 0.42, fromFy: 0.9, toFx: 0.66, toFy: 0.74, segments: 10 }),
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(180);
      __record('viewportAfterPan', __rect(__q('[data-minimap-viewport]')));
      __record('transformAfterPan', __transform());
      return __observed();
    })()`),
    mouse({ action: 'click', selector: '[data-region="minimap"]', fx: 0.25, fy: 0.75 }),
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(180);
      __record('transformAfterMinimapClick', __transform());
      return __observed();
    })()`),
  ];
}

function desktopInspectorCloseSteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('innerWidth', window.innerWidth);
      // The harness opens the page small and then resizes to 1440, which slides the docked rail in.
      await __sleep(320);
      __record('initialRailOpen', __open('rail'));
      __record('initialRailVisible', __visible(__region('rail')));
      __record('initialCanvasWidth', __rect(__region('canvas')).width);
      __record('railRectOpen', __rect(__region('rail')));
      __record('zoomControlRectOpen', __rect(__q('#btn-zoom-in')));
      __click(__q('[data-action="rail-close"]'));
      await __sleep(320);
      var rect = __rect(__region('rail'));
      __record('railOpenAfterClose', __open('rail'));
      __record('railVisibleAfterClose', __visible(__region('rail')));
      __record('railRectAfterClose', rect);
      __record('railOffscreenAfterClose', !!rect && rect.x >= window.innerWidth - 0.5);
      __record('canvasWidthRailClosed', __rect(__region('canvas')).width);
      return __observed();
    })()`),
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q('[data-action="rail-toggle"]'));
      await __sleep(320);
      __record('railOpenAfterReopen', __open('rail'));
      __record('railVisibleAfterReopen', __visible(__region('rail')));
      __record('canvasWidthRailReopened', __rect(__region('canvas')).width);
      return __observed();
    })()`),
  ];
}

function tabletRailOverlaySteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('innerWidth', window.innerWidth);
      __record('docScrollWidthInitial', document.documentElement.scrollWidth);
      __record('railInitialOpen', __open('rail'));
      __record('railInitialVisible', __visible(__region('rail')));
      __record('canvasWidthInitial', __rect(__region('canvas')).width);
      __click(__q('[data-action="rail-toggle"]'));
      await __sleep(320);
      __record('railOpenAfterToggle', __open('rail'));
      __record('railVisibleAfterToggle', __visible(__region('rail')));
      __record('railRectOpen', __rect(__region('rail')));
      __record('canvasRectOpen', __rect(__region('canvas')));
      __record('canvasWidthOpen', __rect(__region('canvas')).width);
      __record('docScrollWidthOpen', document.documentElement.scrollWidth);
      return __observed();
    })()`),
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q('[data-action="rail-close"]'));
      await __sleep(320);
      __record('railOpenAfterClose', __open('rail'));
      __record('railVisibleAfterClose', __visible(__region('rail')));
      __record('railRectAfterClose', __rect(__region('rail')));
      __record('canvasRectAfterClose', __rect(__region('canvas')));
      __record('canvasWidthAfterClose', __rect(__region('canvas')).width);
      __record('docScrollWidthAfterClose', document.documentElement.scrollWidth);
      return __observed();
    })()`),
  ];
}

// The Evidence chapter carries the full, uncapped locator text that used to live in the navigator.
function longEvidenceTextSteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      openChapter('evidence');
      await __sleep(160);
      var body = __q('.rail-body');
      var locators = __qa('#evidence-list .evidence-locator');
      __record('evidenceCount', locators.length);
      __record('evidenceTextLength', locators.length ? locators[0].textContent.length : 0);
      __record('innerWidth', window.innerWidth);
      __record('docScrollWidth', document.documentElement.scrollWidth);
      __record('bodyScrollWidth', body ? body.scrollWidth : null);
      __record('bodyClientWidth', body ? body.clientWidth : null);
      __record('bodyOverflowX', body ? window.getComputedStyle(body).overflowX : null);
      __record('railRect', __rect(__region('rail')));
      return __observed();
    })()`),
  ];
}

function longEvidenceSpec() {
  const spec = fixtures.clone(fixtures.VERSION_2_SPEC);
  const longToken = 'z'.repeat(400);
  spec.nodes[0].label = `API Service ${longToken}`;
  spec.evidence = [
    {
      id: `ev_${longToken}`,
      type: 'file',
      locator: { path: `src/${longToken}/${longToken}.ts` },
      verification: 'compatibility',
    },
  ];
  spec.nodes[0].evidenceIds = [`ev_${longToken}`];
  return spec;
}

function rectsOverlap(a, b) {
  return !!(a && b && a.x < b.right - 0.5 && a.right > b.x + 0.5 && a.y < b.bottom - 0.5 && a.bottom > b.y + 0.5);
}

function rectChanged(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) > 0.5 ||
    Math.abs(a.y - b.y) > 0.5 ||
    Math.abs(a.width - b.width) > 0.5 ||
    Math.abs(a.height - b.height) > 0.5
  );
}

function assertDesktopInspectorClose(raw) {
  assert.ok(raw, 'no desktop rail observations returned');
  assert.strictEqual(raw.initialRailOpen, 'true', 'rail should start open at 1440px');
  assert.ok(raw.initialRailVisible, 'rail should be visible at 1440px initially');
  assert.ok(raw.railRectOpen && raw.railRectOpen.width > 0.5, 'rail has no rendered size while open at 1440px');
  if (raw.zoomControlRectOpen) {
    assert.ok(
      raw.zoomControlRectOpen.right <= raw.railRectOpen.x + 1,
      `viewport controls are covered by the open rail (controls right=${raw.zoomControlRectOpen.right}, rail left=${raw.railRectOpen.x})`
    );
  }
  assert.strictEqual(raw.railOpenAfterClose, 'false', 'rail close control did not close the rail');
  assert.strictEqual(raw.railVisibleAfterClose, false, 'rail is still visible after clicking its close control');
  assert.ok(
    raw.railOffscreenAfterClose,
    `rail was not pushed off-screen after close: ${JSON.stringify(raw.railRectAfterClose)}`
  );
  assert.ok(
    raw.canvasWidthRailClosed > raw.initialCanvasWidth + 1,
    `canvas usable width did not expand after the rail closed (open=${raw.initialCanvasWidth}, closed=${raw.canvasWidthRailClosed})`
  );
  assert.strictEqual(raw.railOpenAfterReopen, 'true', 'rail did not reopen from the header toggle');
  assert.ok(raw.railVisibleAfterReopen, 'rail is not visible after reopening from the header toggle');
  assert.ok(
    raw.canvasWidthRailReopened < raw.canvasWidthRailClosed - 1,
    `canvas width did not shrink back after reopening rail (closed=${raw.canvasWidthRailClosed}, open=${raw.canvasWidthRailReopened})`
  );
}

function assertTabletRailOverlay(raw) {
  assert.ok(raw, 'no tablet rail observations returned');
  assert.strictEqual(raw.innerWidth, 900, `Emulation override not applied: innerWidth=${raw.innerWidth}, expected 900`);
  assert.strictEqual(raw.railInitialOpen, 'false', 'rail should start closed at 900px');
  assert.strictEqual(raw.railInitialVisible, false, 'rail should not be visible at 900px before opening');

  assert.strictEqual(raw.railOpenAfterToggle, 'true', 'rail header toggle did not open the overlay');
  assert.ok(raw.railVisibleAfterToggle, 'rail overlay is not visible after opening');
  assert.ok(
    rectsOverlap(raw.railRectOpen, raw.canvasRectOpen),
    'rail should overlay the canvas at 900px'
  );
  assert.ok(
    Math.abs(raw.canvasWidthOpen - raw.canvasWidthInitial) <= 1,
    `overlay rail permanently shrank the canvas (initial=${raw.canvasWidthInitial}, open=${raw.canvasWidthOpen})`
  );

  assert.strictEqual(raw.railOpenAfterClose, 'false', 'rail close control did not dismiss the overlay');
  assert.strictEqual(raw.railVisibleAfterClose, false, 'rail overlay is still visible after dismissal');
  assert.ok(
    Math.abs(raw.canvasWidthAfterClose - raw.canvasWidthInitial) <= 1,
    `canvas width changed after overlay dismissal (initial=${raw.canvasWidthInitial}, after=${raw.canvasWidthAfterClose})`
  );
  assert.ok(
    !rectsOverlap(raw.railRectAfterClose, raw.canvasRectAfterClose),
    'dismissed rail overlay still overlaps the canvas'
  );
  assert.ok(
    raw.docScrollWidthInitial <= raw.innerWidth + 1 && raw.docScrollWidthOpen <= raw.innerWidth + 1 &&
      raw.docScrollWidthAfterClose <= raw.innerWidth + 1,
    `rail caused horizontal page overflow (initial=${raw.docScrollWidthInitial}, open=${raw.docScrollWidthOpen}, after=${raw.docScrollWidthAfterClose}, viewport=${raw.innerWidth})`
  );
}

function assertLongEvidenceText(raw) {
  assert.ok(raw, 'no long evidence text observations returned');
  assert.ok(raw.evidenceCount >= 1, 'long evidence locator was not rendered in the Evidence chapter');
  assert.ok(raw.evidenceTextLength > 200, `evidence text was truncated too early (length=${raw.evidenceTextLength})`);
  assert.ok(raw.railRect && raw.railRect.width > 0.5, 'rail has no rendered size');
  assert.ok(
    raw.docScrollWidth <= raw.innerWidth + 1,
    `long evidence text overflowed the page horizontally (scrollWidth=${raw.docScrollWidth}, viewport=${raw.innerWidth})`
  );
  assert.ok(
    raw.bodyScrollWidth <= raw.bodyClientWidth + 1,
    `rail body is horizontally scrollable (scrollWidth=${raw.bodyScrollWidth}, clientWidth=${raw.bodyClientWidth})`
  );
  assert.strictEqual(raw.bodyOverflowX, 'hidden', `rail body overflow-x should be hidden, got ${raw.bodyOverflowX}`);
}

function assertRegionLayout(raw, width) {
  assert.ok(raw, `no region observations returned at ${width}px`);

  REGION_NAMES.forEach((name) => {
    assert.ok(raw.present[name], `missing stable [data-region="${name}"] region at ${width}px`);
  });

  assert.strictEqual(raw.innerWidth, width, `Emulation override not applied: innerWidth=${raw.innerWidth}, expected ${width}`);
  assert.strictEqual(raw.navigatorPresent, false, `the removed navigator panel must not exist at ${width}px`);

  assert.ok(raw.visible.topbar, `topbar region not visible at ${width}px`);
  assert.ok(raw.visible.canvas, `canvas region not visible at ${width}px`);
  if (width >= PANEL_BREAKPOINT) {
    assert.ok(raw.visible.rail, `rail should be docked open by default at ${width}px`);
    const expectedRailWidth = width >= 1280 ? 400 : 340;
    assert.ok(
      Math.abs(raw.rects.rail.width - expectedRailWidth) <= 1,
      `rail width should be ${expectedRailWidth}px at ${width}px, got ${raw.rects.rail.width}`
    );
    const expectedCanvasWidth = width - expectedRailWidth;
    assert.ok(
      Math.abs(raw.rects.canvas.width - expectedCanvasWidth) <= 1,
      `canvas width should be ${expectedCanvasWidth}px at ${width}px, got ${raw.rects.canvas.width}`
    );
    assert.ok(Math.abs(raw.rects.canvas.x) <= 1, `canvas should start at x=0 at ${width}px, got ${raw.rects.canvas.x}`);
  } else {
    assert.ok(!raw.visible.rail, `rail region should be collapsed by default at ${width}px`);
  }

  const visibleNames = REGION_NAMES.filter((name) => raw.visible[name]);
  visibleNames.forEach((name) => {
    const r = raw.rects[name];
    assert.ok(r && r.width > 0.5 && r.height > 0.5, `[data-region="${name}"] has no rendered size at ${width}px`);
  });
  for (let i = 0; i < visibleNames.length; i += 1) {
    for (let j = i + 1; j < visibleNames.length; j += 1) {
      assert.ok(
        !rectsOverlap(raw.rects[visibleNames[i]], raw.rects[visibleNames[j]]),
        `visible regions ${visibleNames[i]} and ${visibleNames[j]} overlap at ${width}px`
      );
    }
  }
}

function assertMinimapContainment(raw, width) {
  assert.ok(raw.minimap, `minimap observation missing at ${width}px`);
  assert.ok(raw.minimap.present, `missing nested [data-region="minimap"] at ${width}px`);
  assert.ok(raw.visible.canvas, `canvas region not visible at ${width}px`);

  const minimapRect = raw.minimap.rect;
  assert.ok(minimapRect && minimapRect.width > 0.5 && minimapRect.height > 0.5, `minimap has no rendered size at ${width}px`);

  const canvasRect = raw.rects.canvas;
  assert.ok(canvasRect, `canvas rect unavailable at ${width}px`);
  const tolerance = 1;
  assert.ok(minimapRect.x >= canvasRect.x - tolerance, `minimap escapes the canvas on the left at ${width}px`);
  assert.ok(minimapRect.y >= canvasRect.y - tolerance, `minimap escapes the canvas on the top at ${width}px`);
  assert.ok(minimapRect.right <= canvasRect.right + tolerance, `minimap escapes the canvas on the right at ${width}px`);
  assert.ok(minimapRect.bottom <= canvasRect.bottom + tolerance, `minimap escapes the canvas on the bottom at ${width}px`);

  raw.cameraControls
    .filter((control) => control.visible && control.rect)
    .forEach((control) => {
      assert.ok(
        !rectsOverlap(minimapRect, control.rect),
        `minimap overlaps essential camera control ${control.selector} at ${width}px`
      );
    });
}

function assertDrawerBehavior(raw) {
  assert.ok(raw, 'no drawer observations returned');
  assert.ok(raw.railToggle, 'missing [data-action="rail-toggle"] control at 320px');

  assert.strictEqual(raw.railInitialOpen, 'false', 'rail drawer should start collapsed at 320px');

  assert.strictEqual(raw.railOpen, 'true', 'rail toggle did not open the drawer');
  assert.ok(raw.railVisible, 'rail drawer is not visibly rendered after opening');
  assert.ok(raw.railFocusOnOpen, 'keyboard focus was not moved into the rail drawer on open');
  assert.ok(raw.railTabbableCount >= 2, `rail drawer exposes ${raw.railTabbableCount} tabbables, expected at least 2`);
  assert.ok(raw.railLastTabbableFocused, 'could not focus the last tabbable in the rail drawer');
  assert.ok(raw.railFirstTabbableFocused, 'could not focus the first tabbable in the rail drawer');
  assert.ok(raw.railForwardWrappedInside, 'real Tab from the last rail tabbable escaped the rail drawer');
  assert.ok(raw.railFirstRefocused, 'could not refocus the first tabbable in the rail drawer');
  assert.ok(raw.railBackwardWrappedInside, 'real Shift+Tab from the first rail tabbable escaped the rail drawer');

  assert.ok(raw.backdropPresent, 'missing [data-action="drawer-backdrop"] while the rail drawer is open');
  assert.strictEqual(raw.railAfterBackdropOpen, 'false', 'backdrop click did not dismiss the rail drawer');
  assert.ok(raw.backdropFocusRestored, 'focus was not restored to the rail toggle after backdrop dismissal');

  assert.ok(raw.railCloseControl, 'missing [data-action="rail-close"] control at 320px');
  assert.strictEqual(raw.railAfterCloseOpen, 'false', 'rail close control did not dismiss the drawer');

  if (raw.sheetBackPresent !== undefined) {
    assert.ok(raw.sheetBackPresent, 'missing [data-action="sheet-back"] when sheet open');
  }
}

function assertSearchActivation(raw, expectedKind, modelId) {
  assert.ok(raw, 'no search activation observations returned');
  assert.strictEqual(raw.paletteOpen, 'true', 'the command palette did not open');
  assert.ok(raw.paletteInputPresent, 'no palette search input rendered');
  assert.ok(raw.resultPresent, `no palette result rendered for ${modelId}`);
  assert.ok(raw.resultFocused, `palette result for ${modelId} is not keyboard focusable`);
  assert.ok(raw.selectionPresent, `real Enter on the palette row for ${modelId} did not mark it data-selected="true"`);
  assert.strictEqual(raw.railOpen, 'true', `activating palette result for ${modelId} did not open the rail`);
  assert.strictEqual(raw.railSheet, expectedKind, `rail is not in the ${expectedKind} sheet state after activating ${modelId}`);
  assert.notStrictEqual(raw.transformAfter, raw.transformBefore, `camera transform did not change after activating palette result for ${modelId}`);
}

function assertMinimapBehavior(raw) {
  assert.ok(raw, 'no minimap observations returned');
  assert.ok(raw.minimapPresent, 'missing [data-region="minimap"] region');
  assert.ok(
    raw.nodeMarkCount >= raw.expectedNodeMarks,
    `minimap has ${raw.nodeMarkCount} node marks, expected at least ${raw.expectedNodeMarks}`
  );
  assert.ok(
    raw.boundaryMarkCount >= raw.expectedBoundaryMarks,
    `minimap has ${raw.boundaryMarkCount} boundary marks, expected at least ${raw.expectedBoundaryMarks}`
  );
  assert.ok(raw.viewportPresent, 'minimap has no [data-minimap-viewport] rectangle');
  assert.ok(raw.viewportBefore && raw.viewportBefore.width > 0 && raw.viewportBefore.height > 0, 'minimap viewport rectangle has no rendered size');

  assert.ok(
    raw.viewportAfterZoom && raw.viewportAfterZoom.width > 0 && raw.viewportAfterZoom.height > 0,
    'minimap viewport rectangle is missing or collapsed after real zoom-in click'
  );
  assert.ok(
    rectChanged(raw.viewportBefore, raw.viewportAfterZoom),
    'minimap viewport rectangle did not change after real zoom-in click'
  );
  assert.notStrictEqual(raw.transformAfterZoom, raw.transformBefore, 'camera transform did not change after minimap zoom');

  assert.ok(
    raw.viewportAfterPan && raw.viewportAfterPan.width > 0 && raw.viewportAfterPan.height > 0,
    'minimap viewport rectangle is missing or collapsed after real canvas pan drag'
  );
  assert.ok(
    rectChanged(raw.viewportAfterZoom, raw.viewportAfterPan),
    'minimap viewport rectangle did not change after real canvas pan drag'
  );
  assert.notStrictEqual(raw.transformAfterPan, raw.transformAfterZoom, 'camera transform did not change after real canvas pan drag');

  assert.notStrictEqual(
    raw.transformAfterMinimapClick,
    raw.transformAfterPan,
    'clicking the minimap did not change the camera transform'
  );
}

function lensBarSteps() {
  const steps = [ev(`window.__lensVisits = []; document.querySelector('.lens-switcher [data-lens="structure"]').focus(); 0`)];
  ['structure', 'evidence', 'change', 'risk'].forEach((lens, index) => {
    if (index) steps.push(key('ArrowRight', { code: 'ArrowRight', windowsVirtualKeyCode: 39 }));
    steps.push(ev(`window.__lensVisits.push({
      lens: state.lens,
      checked: document.activeElement.getAttribute('aria-checked'),
      focus: document.activeElement.dataset.lens,
      tabStops: [...document.querySelectorAll('.lens-switcher button')].filter(b => b.tabIndex === 0).length,
    }); 0`));
  });
  steps.push(ev(`JSON.stringify({
    visits: window.__lensVisits,
    fits: [...document.querySelectorAll('.lens-switcher button')].every(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.left >= 0 && r.right <= innerWidth;
    }),
    noOverlap: document.querySelector('.lens-switcher').getBoundingClientRect().right <= document.querySelector('.header-actions').getBoundingClientRect().left,
  })`));
  return steps;
}

function assertLensBarBehavior(raw) {
  const probe = JSON.parse(raw);
  assert.ok(probe.fits, 'all four lens buttons must fit in the header');
  assert.ok(probe.noOverlap, 'lens buttons must not overlap header actions');
  assert.deepStrictEqual(probe.visits, ['structure', 'evidence', 'change', 'risk'].map(lens => ({
    lens, checked: 'true', focus: lens, tabStops: 1,
  })));
}

function riskNode(id, boundary) {
  return Object.assign({ id, label: id.toUpperCase(), type: 'service', status: 'VERIFIED' }, boundary ? { boundary } : {});
}

function riskFixture(overrides) {
  return Object.assign(
    { meta: { title: 'Risk lens fixture', description: 'Risk lens policy verification', grounding: 'illustrative' } },
    overrides || {}
  );
}

// Compile a small inline spec, select the Risk lens, and return whatever the script observed.
function riskRender(spec, script) {
  return JSON.parse(lastEvalValue(runPhases(spec, [{ width: 1440, height: 900, steps: [ev(script)] }])[0]));
}

const cases = [
  ['p2: fit every example at 1440×900 with the rail docked at zoom ≥ 0.75', () => {
    for (const name of ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow']) {
      const [phase] = runPhases(`examples/${name}/architecture.json`, [{ width: 1440, height: 900, steps: [ev(`(function () {
        const b = computeTotalVisualBounds();
        const r = svg.getBoundingClientRect();
        return { zoom: state.zoom, width: r.width, height: r.height,
          rail: document.querySelector('[data-region="rail"]').getAttribute('data-open'),
          left: state.panX + b.minX * state.zoom, right: state.panX + b.maxX * state.zoom,
          top: state.panY + b.minY * state.zoom, bottom: state.panY + b.maxY * state.zoom };
      })()`)] }]);
      const m = lastEvalValue(phase);
      assert.strictEqual(m.rail, 'true', name);
      assert.ok(m.zoom >= 0.75, `${name}: zoom ${m.zoom}`);
      assert.ok(m.left >= 0 && m.top >= 0 && m.right <= m.width && m.bottom <= m.height, `${name}: diagram leaves canvas`);
    }
  }],
  ['p2: compact cards keep names, technology, badges and exception rings clear in every lens', () => {
    for (const name of ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow']) {
      const [phase] = runPhases(`examples/${name}/architecture.json`, [{ width: 1440, height: 900, steps: [ev(`(function () {
        const problems = [];
        const overlap = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        for (const lens of ['structure', 'evidence', 'change', 'risk']) {
          selectLens(lens);
          for (const n of LAYOUT_DATA.nodes) {
            const g = document.getElementById('node-' + n.id);
            const shape = g.querySelector('.node-rect');
            const tile = g.querySelector('.node-tile');
            const title = g.querySelector('.node-name');
            const tech = g.querySelector('.node-tech');
            const badge = g.querySelector('.node-badge');
            const ring = g.querySelector('.node-exception');
            const badgeBox = badge ? badge.getBBox() : null;
            if (badgeBox) { const t = badge.transform.baseVal.consolidate().matrix; badgeBox.x += t.e; badgeBox.y += t.f; }
            if (shape.tagName !== 'rect' || shape.getAttribute('rx') !== '12' || n.width !== 220 || n.height !== 72) problems.push(n.id + ': shape');
            if ([tile.getAttribute('x'), tile.getAttribute('y'), tile.getAttribute('width'), tile.getAttribute('height')].join(',') !== '12,12,28,28') problems.push(n.id + ': tile');
            if (title.getAttribute('x') !== '50' || title.children.length > 2 || tech.getAttribute('y') !== '60') problems.push(n.id + ': text');
            if (getComputedStyle(title).fontSize !== '13px' || getComputedStyle(title).fontWeight !== '600' || getComputedStyle(tech).fontSize !== '10.5px') problems.push(n.id + ': typography');
            if (ring && (ring.getAttribute('cx') !== '204' || ring.getAttribute('cy') !== '16')) problems.push(n.id + ': ring');
            if (overlap(title.getBBox(), tech.getBBox()) || overlap(title.getBBox(), badgeBox) || overlap(tech.getBBox(), badgeBox) || overlap(title.getBBox(), ring && ring.getBBox())) problems.push(n.id + ': overlap in ' + lens);
          }
        }
        return problems;
      })()`)] }]);
      assert.deepStrictEqual(lastEvalValue(phase), [], name);
    }
  }],

  [
    'p2: orthogonal paths use lines and bounded arcs with arrowheads',
    () => {
      const phase = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`JSON.stringify({
        paths: [...document.querySelectorAll('.edge-path')].map(p => ({ d: p.getAttribute('d'), marker: p.getAttribute('marker-end') })),
        cardCrossings: LAYOUT_DATA.routingStats.cardCrossings,
        jumps: LAYOUT_DATA.routingStats.jumps,
        drawnJumps: LAYOUT_DATA.edges.reduce((sum, e) => sum + e.jumps.length, 0)
      })`)] }])[0];
      const result = JSON.parse(lastEvalValue(phase));
      assert.ok(result.paths.length);
      result.paths.forEach(p => {
        assert.ok(!/[CQHVSTZ]/i.test(p.d), 'orthogonal path contains only M, L and A commands');
        assert.ok(p.marker && /^url\(#arrow/.test(p.marker), 'arrowhead is present');
        const arcs = [...p.d.matchAll(/A ([\d.]+) ([\d.]+)/g)];
        arcs.forEach(a => assert.ok(Number(a[1]) <= 6 && Number(a[2]) <= 6, 'arc exceeds corner radius'));
      });
      assert.strictEqual(result.cardCrossings, 0);
      assert.ok(result.jumps > 0);
      assert.strictEqual(result.drawnJumps, result.jumps);
    },
  ],
  [
    'p2: orthogonal card dragging reroutes every edge without card crossings',
    () => {
      const spec = fixtures.clone(fixtures.ADVERSARIAL_DENSE_PORTS_SPEC);
      const phase = runPhases(spec, [{ width: 1440, height: 900, steps: [
        ev(`window.__before = LAYOUT_DATA.edges.map(e => e.path); 0`),
        mouse({ action: 'drag', selector: '#node-hub', fromFx: 0.5, fromFy: 0.5, toFx: 0.65, toFy: 0.75, segments: 3 }),
        ev(`JSON.stringify({ changed: LAYOUT_DATA.edges.some((e, i) => e.path !== window.__before[i]),
          crossings: LAYOUT_DATA.routingStats.cardCrossings,
          matches: LAYOUT_DATA.edges.every(e => document.getElementById('path-' + e.id).getAttribute('d') === e.path),
          labels: LAYOUT_DATA.edges.every(e => !e.labelWidth || e.labelSlot) })`)
      ] }])[0];
      const result = JSON.parse(lastEvalValue(phase));
      assert.ok(result.changed, 'drag must change routes');
      assert.strictEqual(result.crossings, 0);
      assert.ok(result.matches, 'all DOM paths reflect current routes');
      assert.ok(result.labels, 'all labels retain slots');
    },
  ],
  [
    '1e: lens arrows wrap, Home and End select and announce without panning',
    () => {
      const steps = [ev(`document.querySelector('.lens-switcher [data-lens="structure"]').focus(); window.__camera = [state.panX, state.panY]; window.__visits = []; 0`)];
      [['ArrowLeft', 37, 'risk'], ['ArrowRight', 39, 'structure'], ['End', 35, 'risk'], ['Home', 36, 'structure']].forEach(([name, code]) => {
        steps.push(key(name, { code: name, windowsVirtualKeyCode: code }));
        steps.push(ev(`window.__visits.push([state.lens, document.activeElement.dataset.lens, document.activeElement.getAttribute('aria-checked')]); 0`));
      });
      // Live-region announcements are deferred to the next animation frame.
      steps.push(ev('new Promise(resolve => requestAnimationFrame(() => resolve(0)))'));
      steps.push(ev(`JSON.stringify({ visits: window.__visits, cameraHeld: window.__camera.every((n, i) => n === [state.panX, state.panY][i]), status: document.getElementById('workbench-status').textContent })`));
      const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1024, height: 900, steps }])[0]));
      assert.deepStrictEqual(obs.visits, ['risk', 'structure', 'risk', 'structure'].map(lens => [lens, lens, 'true']));
      assert.ok(obs.cameraHeld);
      assert.strictEqual(obs.status, 'Structure lens');
    },
  ],
  [
    '1e: lens keys 1–4 select explicitly and Change alone shows the delta bar',
    () => {
      const steps = [ev('window.__visits = []; document.activeElement.blur(); 0')];
      [3, 1, 3, 2, 3, 4].forEach(number => {
        steps.push(key(String(number), { code: `Digit${number}`, windowsVirtualKeyCode: 48 + number }));
        steps.push(ev(`window.__visits.push([state.lens, state.lensExplicit, state.currentView, document.getElementById('delta-bar').classList.contains('visible'), document.body.dataset.lens, document.querySelector('.lens-select').value]); 0`));
      });
      steps.push(ev('JSON.stringify(window.__visits)'));
      const visits = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1024, height: 900, steps }])[0]));
      assert.deepStrictEqual(visits, ['change', 'structure', 'change', 'evidence', 'change', 'risk'].map(lens => [
        lens, true, lens === 'change' ? 'before_after' : 'architecture', lens === 'change', lens, lens,
      ]));
    },
  ],
  [
    '1e: lens chapter suggestions resume after an explicit pick survives one change',
    () => {
      const steps = [
        ev(`openChapter('review'); window.__suggested = state.lens; openChapter('walkthrough'); document.activeElement.blur(); 0`),
        key('2', { code: 'Digit2', windowsVirtualKeyCode: 50 }),
        ev(`openChapter('review'); window.__held = [state.lens, state.lensExplicit]; openChapter('walkthrough'); window.__resumed = state.lens; openChapter('review'); JSON.stringify([window.__suggested, window.__held, window.__resumed, state.lens])`),
      ];
      const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1024, height: 900, steps }])[0]));
      assert.deepStrictEqual(obs, ['risk', ['evidence', false], 'structure', 'risk']);
    },
  ],
  [
    '1e: lens links restore Risk and legacy Delta links restore Change explicitly',
    () => {
      [['v=2&l=risk', 'risk'], ['view=before_after', 'change'], ['v=2&view=before_after', 'change'], ['v=2&c=review&view=architecture', 'structure'], ['v=2&c=review&l=evidence&view=before_after', 'evidence']].forEach(([hash, lens]) => {
        const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1024, height: 900, steps: [ev(`JSON.stringify([state.lens, state.lensExplicit, document.body.dataset.lens, document.querySelector('.lens-switcher [data-lens="${lens}"]').getAttribute('aria-checked')])`)] }], undefined, { hash })[0]));
        assert.deepStrictEqual(obs, [lens, true, lens, 'true'], hash);
      });
    },
  ],
  [
    '1e: lens palette group selects a lens and Views retain Data Flow and Sequence',
    () => {
      const steps = [
        key('k', { code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 }),
        ev(`window.__groups = PALETTE_GROUPS.slice(0, 3); window.__lenses = paletteCurrentItems.filter(i => i.group === 'Lenses').map(i => i.label); window.__views = paletteCurrentItems.filter(i => i.group === 'Views').map(i => i.label); const index = paletteCurrentItems.findIndex(i => i.id === 'lens-risk'); document.querySelector('#palette-opt-' + index).click(); JSON.stringify({ groups: window.__groups, lenses: window.__lenses, views: window.__views, lens: state.lens, explicit: state.lensExplicit })`),
      ];
      const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1024, height: 900, steps }])[0]));
      assert.deepStrictEqual(obs, { groups: ['Commands', 'Lenses', 'Views'], lenses: ['Structure', 'Evidence', 'Change', 'Risk'], views: ['Data Flow', 'Sequence Flow'], lens: 'risk', explicit: true });
    },
  ],
  [
    '1e: lens mobile select at 390 changes and synchronizes the lens',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 390, height: 844, steps: [ev(`const select = document.querySelector('.lens-select'); const visible = select.getBoundingClientRect().width > 0; const radiosHidden = document.querySelector('.lens-switcher').getBoundingClientRect().width === 0; select.value = 'change'; select.dispatchEvent(new Event('change', { bubbles: true })); JSON.stringify([visible, radiosHidden, state.lens, state.lensExplicit, document.querySelector('.lens-switcher [data-lens="change"]').getAttribute('aria-checked'), document.getElementById('delta-bar').classList.contains('visible')])`)] }])[0]));
      assert.deepStrictEqual(obs, [true, true, 'change', true, 'true', true]);
    },
  ],
  [
    '1e: lens remains selected in playback views and text fields ignore numeric shortcuts',
    () => {
      const steps = [
        ev(`selectLens('risk'); switchView(VIEWS.DATA_FLOW); window.__flowLens = state.lens; switchView(VIEWS.SEQUENCE); window.__sequenceLens = state.lens; document.getElementById('search-box').focus(); 0`),
        key('1', { code: 'Digit1', windowsVirtualKeyCode: 49 }),
        ev('JSON.stringify([window.__flowLens, window.__sequenceLens, state.lens])'),
      ];
      const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1024, height: 900, steps }])[0]));
      assert.deepStrictEqual(obs, ['risk', 'risk', 'risk']);
    },
  ],

  [
    '1e: lens canvas encodes example 3 cards, connections and present-state key without dimming',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`JSON.stringify(LENSES.map(lens => {
        selectLens(lens);
        const encoding = lensEncoding(lens, ARCH_SPEC);
        return {
          lens,
          nodes: ARCH_SPEC.nodes.map(node => {
            const group = document.getElementById('node-' + node.id);
            const mark = encoding.nodes[node.id];
            return [group.dataset.lensStroke === mark.stroke,
              group.dataset.lensStyle === mark.strokeStyle,
              (group.dataset.lensFill || null) === mark.fill,
              group.hasAttribute('data-lens-muted') === mark.mutedText,
              group.hasAttribute('data-lens-strike') === mark.strike,
              (group.querySelector('.node-badge text')?.textContent || null) === (mark.badge?.text || null),
              Boolean(group.querySelector('.node-exception')) === (mark.marker === 'exception-ring'),
              getComputedStyle(group).opacity === '1'];
          }),
          edges: ARCH_SPEC.edges.map(edge => {
            const path = document.getElementById('path-' + edge.id);
            return [path.dataset.lensStroke === encoding.edges[edge.id].stroke,
              path.dataset.lensStyle === encoding.edges[edge.id].strokeStyle,
              getComputedStyle(path).opacity === '1'];
          }),
          key: [...document.querySelectorAll('.lens-key-row')].map(row => row.textContent),
          expectedKey: encoding.keyItems.map(item => item.label),
          structureNeutral: lens !== 'structure' || !document.querySelector('.node-group[data-lens-stroke="ok"], .node-group[data-lens-stroke="warn"], .node-group[data-lens-stroke="risk"], .node-badge'),
          added: lens !== 'change' || ARCH_SPEC.nodes.filter(node => node.delta === 'ADDED').every(node => {
            const group = document.getElementById('node-' + node.id);
            return group.dataset.lensStroke === 'ok' && group.querySelector('.node-badge text').textContent === 'Added';
          })
        };
      }))`)] }])[0]));
      obs.forEach(result => {
        assert.ok(result.nodes.flat().every(Boolean), result.lens + ' node encoding');
        assert.ok(result.edges.flat().every(Boolean), result.lens + ' edge encoding');
        assert.deepStrictEqual(result.key, result.expectedKey, result.lens + ' key');
        assert.ok(result.structureNeutral && result.added, result.lens + ' change marks');
      });
    },
  ],
  [
    '1e: lens canvas preserves scenario opacity through every lens and Structure toggles Data Flow',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(async function () {
        startWalkthrough('scenario_fulfillment_saga_dlq'); walkTo('stage_publish_order_created');
        await new Promise(resolve => setTimeout(resolve, 250));
        const snapshot = () => [...document.querySelectorAll('.node-group, .edge-path:not(.ghost)')].map(item => [item.id, getComputedStyle(item).opacity]);
        const before = snapshot();
        const visits = [];
        for (const lens of LENSES) {
          selectLens(lens);
          await new Promise(resolve => setTimeout(resolve, 250));
          visits.push(snapshot());
        }
        deactivateScenario();
        selectLens('structure');
        const toggle = () => document.querySelector('.lens-key button');
        toggle().click();
        const flow = [state.currentView, toggle().getAttribute('aria-pressed')];
        toggle().click();
        return JSON.stringify({before, visits, flow, architecture: [state.currentView, toggle().getAttribute('aria-pressed')]});
      })()`)] }])[0]));
      obs.visits.forEach(snapshot => assert.deepStrictEqual(snapshot, obs.before));
      assert.deepStrictEqual(obs.flow, ['data_flow', 'true']);
      assert.deepStrictEqual(obs.architecture, ['architecture', 'false']);
    },
  ],
  [
    '1e: lens canvas Risk draws and clears a forbidden policy ghost',
    () => {
      const spec = JSON.parse(JSON.stringify(fixtures.VALID_SPEC));
      spec.policies = [{ id: 'forbidden-test', kind: 'forbidden_dependency', from: spec.nodes[1].id, to: spec.nodes[0].id }];
      const policy = spec.policies[0];
      assert.ok(!spec.edges.some(edge => edge.source === policy.from && edge.target === policy.to), 'the forbidden dependency must be absent');
      const obs = JSON.parse(lastEvalValue(runPhases(spec, [{ width: 1440, height: 900, steps: [ev(`selectLens('risk'); const ghosts = [...document.querySelectorAll('#ghost-layer .policy-ghost')].map(group => [group.querySelector('text').textContent, group.querySelector('line').dataset.lensStroke, getComputedStyle(group.querySelector('line')).strokeDasharray]); selectLens('structure'); JSON.stringify([ghosts, document.querySelectorAll('#ghost-layer .policy-ghost').length])`)] }])[0]));
      assert.deepStrictEqual(obs, [[['Forbidden · absent', 'risk', '2px, 4px']], 0]);
    },
  ],

  [
    'p3: risk lens required_dependency draws a Required · missing ghost',
    () => {
      const spec = riskFixture({ nodes: [riskNode('a'), riskNode('b')], policies: [{ id: 'pol_req', kind: 'required_dependency', from: 'a', to: 'b' }] });
      const obs = riskRender(spec, `selectLens('risk'); JSON.stringify([...document.querySelectorAll('#ghost-layer .policy-ghost')].map(group => [group.querySelector('text').textContent, group.querySelector('line').dataset.lensStroke]))`);
      assert.deepStrictEqual(obs, [['Required · missing', 'warn']]);
    },
  ],

  [
    'p3: risk lens forbidden_dependency marks the offending edge risk',
    () => {
      const spec = riskFixture({
        nodes: [riskNode('a'), riskNode('b')],
        edges: [{ id: 'e1', source: 'a', target: 'b', label: 'Forbidden call', communication: 'sync' }],
        policies: [{ id: 'pol_forbidden', kind: 'forbidden_dependency', from: 'a', to: 'b' }],
      });
      const obs = riskRender(spec, `selectLens('risk'); const path = document.getElementById('path-e1'); JSON.stringify([path.dataset.lensStroke, path.dataset.lensStyle])`);
      assert.deepStrictEqual(obs, ['risk', 'solid']);
    },
  ],

  [
    'p3: risk lens layer_direction draws an against-flow chevron on the edge',
    () => {
      const spec = riskFixture({
        boundaries: [{ id: 'top', label: 'Top tier' }, { id: 'bottom', label: 'Bottom tier' }],
        nodes: [riskNode('upper', 'top'), riskNode('lower', 'bottom')],
        edges: [{ id: 'e1', source: 'lower', target: 'upper', label: 'Back Up', communication: 'sync' }],
        policies: [{ id: 'pol_dir', kind: 'layer_direction', layers: ['top', 'bottom'] }],
      });
      const obs = riskRender(spec, `selectLens('risk'); const path = document.getElementById('path-e1'); const chevron = document.querySelector('#edge-e1 .edge-chevron'); JSON.stringify({ stroke: path.dataset.lensStroke, chevron: Boolean(chevron), edgeId: chevron && chevron.dataset.edgeId })`);
      assert.deepStrictEqual(obs, { stroke: 'risk', chevron: true, edgeId: 'e1' });
    },
  ],

  [
    'p3: risk lens cycle numbers the cycle edges in order',
    () => {
      const spec = riskFixture({
        nodes: [riskNode('a'), riskNode('b'), riskNode('c')],
        edges: [
          { id: 'ab', source: 'a', target: 'b', label: 'ab' },
          { id: 'bc', source: 'b', target: 'c', label: 'bc' },
          { id: 'ca', source: 'c', target: 'a', label: 'ca' },
        ],
        policies: [{ id: 'pol_cycle', kind: 'cycle' }],
      });
      const obs = riskRender(spec, `selectLens('risk'); const marks = [...document.querySelectorAll('#edges-layer .edge-cycle-marker')].sort((x, y) => Number(x.dataset.cycleIndex) - Number(y.dataset.cycleIndex)).map(marker => [marker.dataset.cycleIndex, marker.querySelector('text').textContent]); const path = document.getElementById('path-ab'); JSON.stringify({ marks, stroke: path.dataset.lensStroke })`);
      assert.deepStrictEqual(obs, { marks: [['1', '1'], ['2', '2'], ['3', '3']], stroke: 'risk' });
    },
  ],

  [
    'p3: risk lens fan_in badges the overloaded node with the count',
    () => {
      const spec = riskFixture({
        nodes: [riskNode('hub'), riskNode('s1'), riskNode('s2'), riskNode('s3')],
        edges: [
          { id: 'e1', source: 's1', target: 'hub', label: 'e1' },
          { id: 'e2', source: 's2', target: 'hub', label: 'e2' },
          { id: 'e3', source: 's3', target: 'hub', label: 'e3' },
        ],
        policies: [{ id: 'pol_fan_in', kind: 'fan_in', max: 2 }],
      });
      const obs = riskRender(spec, `selectLens('risk'); const group = document.getElementById('node-hub'); const badge = group.querySelector('.node-badge text'); JSON.stringify([group.dataset.lensStroke, badge && badge.textContent])`);
      assert.deepStrictEqual(obs, ['risk', 'fan-in 3 / max 2']);
    },
  ],

  [
    'p3: risk lens fan_out badges the overloaded node with the count',
    () => {
      const spec = riskFixture({
        nodes: [riskNode('hub'), riskNode('s1'), riskNode('s2'), riskNode('s3')],
        edges: [
          { id: 'e1', source: 'hub', target: 's1', label: 'e1' },
          { id: 'e2', source: 'hub', target: 's2', label: 'e2' },
          { id: 'e3', source: 'hub', target: 's3', label: 'e3' },
        ],
        policies: [{ id: 'pol_fan_out', kind: 'fan_out', max: 1 }],
      });
      const obs = riskRender(spec, `selectLens('risk'); const group = document.getElementById('node-hub'); const badge = group.querySelector('.node-badge text'); JSON.stringify([group.dataset.lensStroke, badge && badge.textContent])`);
      assert.deepStrictEqual(obs, ['risk', 'fan-out 3 / max 1']);
    },
  ],

  [
    'p3: risk lens required_evidence draws a missing-evidence marker',
    () => {
      const spec = riskFixture({
        nodes: [riskNode('a')],
        policies: [{ id: 'pol_evidence', kind: 'required_evidence', status: 'VERIFIED' }],
      });
      const obs = riskRender(spec, `selectLens('risk'); const group = document.getElementById('node-a'); const badge = group.querySelector('.node-badge text'); JSON.stringify({ marker: Boolean(group.querySelector('.node-evidence-marker')), badge: badge && badge.textContent || null })`);
      assert.deepStrictEqual(obs, { marker: true, badge: null });
    },
  ],

  [
    'Chrome binary is available for rendered verification',
    () => {
      const chrome = findChrome();
      assert.ok(chrome, 'no Chrome/Chromium binary found; rendered verification requires a real browser');
      assert.ok(fs.existsSync(chrome), 'detected Chrome binary does not exist on disk');
    },
  ],

  [
    'example 1 (crud-business-feature) passes rendered-DOM layout and gap assertions',
    () => {
      const specRel = 'examples/1-crud-business-feature/architecture.json';
      const metrics = measureRenderedDom(specRel);
      assertMeasurements(metrics, specRel);
    },
  ],

  [
    'example 2 (complex-database-migration) passes rendered-DOM layout and gap assertions',
    () => {
      const specRel = 'examples/2-complex-database-migration/architecture.json';
      const metrics = measureRenderedDom(specRel);
      assertMeasurements(metrics, specRel);
    },
  ],

  [
    'example 3 (async-event-driven-workflow) passes rendered-DOM layout and gap assertions',
    () => {
      const specRel = 'examples/3-async-event-driven-workflow/architecture.json';
      const metrics = measureRenderedDom(specRel);
      assertMeasurements(metrics, specRel);
    },
  ],

  [
    'B2a: topbar, canvas and rail render without overlap at 320, 768 and 1440',
    () => {
      const phases = VIEWPORTS.map((viewport) => ({
        width: viewport.width,
        height: viewport.height,
        mobile: viewport.mobile,
        script: regionsScript(),
      }));
      const results = runPhases(fixtures.VALID_SPEC, phases);
      VIEWPORTS.forEach((viewport, index) => {
        assertRegionLayout(results[index], viewport.width);
        assertMinimapContainment(results[index], viewport.width);
      });
    },
  ],

  [
    'B2b: at 1440 the rail close button closes the docked panel, expands the canvas and reopens from the header toggle',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps: desktopInspectorCloseSteps() }]);
      assertDesktopInspectorClose(lastEvalValue(results[0]));
    },
  ],

  [
    'B2b: at 900 the rail is an overlay, dismisses cleanly and never shrinks or overlaps the canvas',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 900, height: 900, mobile: false, steps: tabletRailOverlaySteps() }]);
      assertTabletRailOverlay(lastEvalValue(results[0]));
    },
  ],

  [
    'B2b: long evidence locator text wraps without horizontal page or rail scrolling',
    () => {
      const results = runPhases(longEvidenceSpec(), [{ width: 1440, height: 900, mobile: false, steps: longEvidenceTextSteps() }]);
      assertLongEvidenceText(lastEvalValue(results[0]));
    },
  ],

  [
    'B2a: at 320 the rail drawer traps focus, dismisses and restores focus',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 320, height: 800, mobile: false, steps: drawerSteps() }]);
      assertDrawerBehavior(lastEvalValue(results[0]));
    },
  ],

  [
    'B2a: real Enter on a node palette row selects it, opens the inspector and moves the camera',
    () => {
      const steps = searchSteps('API Service', 'api', '#node-api[data-selected="true"]', 'node');
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      assertSearchActivation(lastEvalValue(results[0]), 'node', 'api');
    },
  ],

  [
    'B2a: real Enter on an edge palette row selects it, opens the edge inspector and moves the camera',
    () => {
      const steps = searchSteps('SQL Write', 'e1', '#path-e1[data-selected="true"]', 'edge');
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      assertSearchActivation(lastEvalValue(results[0]), 'edge', 'e1');
    },
  ],

  [
    'B2a: lens switcher fits at 768 and 1024 with every option reachable by keyboard',
    () => {
      [768, 1024].forEach(width => {
        const results = runPhases(fixtures.VALID_SPEC, [{ width, height: 900, mobile: false, steps: lensBarSteps() }]);
        assertLensBarBehavior(lastEvalValue(results[0]));
      });
    },
  ],

  [
    'B2a: minimap marks and viewport rectangle react to real zoom, canvas pan and minimap click',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps: minimapSteps() }]);
      assertMinimapBehavior(lastEvalValue(results[0]));
    },
  ],

  [
    'Phase 0: every example opens with the whole diagram fitted inside the canvas at 1280 and 1600',
    () => {
      const FIT = ev(`(function () {
        const b = computeTotalVisualBounds();
        const r = document.querySelector('#canvas-container svg').getBoundingClientRect();
        const box = { left: state.panX + b.minX * state.zoom, right: state.panX + b.maxX * state.zoom, top: state.panY + b.minY * state.zoom, bottom: state.panY + b.maxY * state.zoom };
        return { box, width: r.width, height: r.height, hash: location.hash };
      })()`);
      ['examples/1-crud-business-feature/architecture.json', 'examples/3-async-event-driven-workflow/architecture.json'].forEach((spec) => {
        const results = runPhases(spec, [{ width: 1280, height: 800, steps: [FIT] }, { width: 1600, height: 960, steps: [ev('fitToScreen(); 0'), FIT] }]);
        results.forEach((phase) => {
          const { box, width, height, hash } = lastEvalValue(phase);
          assert.ok(box.left >= -1 && box.top >= -1 && box.right <= width + 1 && box.bottom <= height + 1, `${spec}: diagram not fitted ${JSON.stringify({ box, width, height })}`);
          assert.ok(!/[#&](cam|z)=/.test(hash), `${spec}: an untouched fitted view must not pin a camera into the URL: ${hash}`);
        });
      });
    },
  ],

  [
    'Phase 0: a walkthrough step spotlights its participants and edges on the canvas, and Esc clears it',
    () => {
      const SNAPSHOT = `JSON.stringify({
        edges: [...document.querySelectorAll('.edge-path.highlighted')].map((p) => p.id).sort(),
        nodes: [...document.querySelectorAll('.node-group.selected')].map((n) => n.id).sort(),
        dimmed: document.querySelectorAll('.edge-path.dimmed').length,
        text: (document.querySelector('[data-walk-list] [data-walk-entry="stage_publish_order_created"]') || {}).innerText || '',
        hash: location.hash,
      })`;
      const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{
        width: 1440,
        height: 900,
        steps: [
          ev(SNAPSHOT),
          ev(`startWalkthrough('scenario_fulfillment_saga_dlq'); walkTo('stage_publish_order_created'); ${SNAPSHOT}`),
          ev(`walkTo('stage_parallel_fulfillment_branches'); ${SNAPSHOT}`),
          ESCAPE(),
          ev(SNAPSHOT),
        ],
      }]);
      const [idle, single, parallel, cleared] = results[0].filter((step) => step.kind === 'eval').map((step) => JSON.parse(step.value));
      assert.deepStrictEqual(idle.edges, [], 'canvas must not open mid-walkthrough');
      assert.deepStrictEqual(single.edges, ['path-e_poller_kafka']);
      assert.deepStrictEqual(single.nodes, ['node-kafka_broker', 'node-outbox_poller']);
      assert.ok(single.dimmed > 0, 'non-participating edges should dim');
      assert.ok(/Publish to Kafka Event Bus/.test(single.text) && /Outbox Relay Worker/.test(single.text), single.text);
      assert.ok(!/stage_publish_order_created|outbox_poller/.test(single.text), `raw ids leaked into the chapter list: ${single.text}`);
      assert.ok(/[#&]s=scenario_fulfillment_saga_dlq&at=stage_publish_order_created(&|$)/.test(single.hash), single.hash);
      assert.ok(!/cam=/.test(single.hash), `a link to a step carries no camera: ${single.hash}`);
      assert.strictEqual(parallel.edges.length, 4, `parallel stage should light every branch: ${parallel.edges}`);
      assert.deepStrictEqual([cleared.edges.length, cleared.dimmed], [0, 0], 'Esc should end the walkthrough spotlight');
      assert.ok(!/[#&]s=/.test(cleared.hash), cleared.hash);
    },
  ],

  [
    '1f: walkthrough starts on example 3 with a track bead per entry and steps by key',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const PROBE = ev(`(async function () {
        ${PAGE_HELPERS}
        window.__obs = {};
        __record('beforeActive', state.scenarioActive);
        __record('beforeHidden', __q('.walk-track').hidden);
        startWalkthrough('scenario_fulfillment_saga_dlq');
        await __sleep(80);
        var entries = linearizeScenario(selectedScenario(), state.walkChoices);
        var first = entries[0];
        var hop = first.interactions[0];
        __record('total', walkthroughTotal(entries));
        __record('entryCount', entries.length);
        __record('beadCount', __qa('.walk-track .walk-bead').length);
        __record('countText', (__q('.walk-count') || {}).textContent);
        __record('trackHidden', __q('.walk-track').hidden);
        __record('cursor', state.walkCursor);
        __record('firstEntry', first.id);
        __record('activeBead', (__q('.walk-bead[aria-selected="true"]') || {}).getAttribute('data-walk-entry'));
        __record('announce', document.getElementById('workbench-status').textContent);
        __record('expectedAnnounce', 'Step ' + first.number + ' of ' + walkthroughTotal(entries) + ', '
          + (first.stage.name || first.id) + ', '
          + (nodeById.get(hop.from).label || hop.from) + ' to ' + (nodeById.get(hop.to).label || hop.to));
        __record('selectedNodes', __qa('.node-group.selected').map(function (n) { return n.id; }).sort());
        return __observed();
      })()`);
      const AFTER_NEXT = ev(`(async function () {
        ${PAGE_HELPERS}
        await __sleep(80);
        var entries = linearizeScenario(selectedScenario(), state.walkChoices);
        var second = entries[1];
        var hop = second.interactions[0];
        window.__obs = {};
        __record('cursor', state.walkCursor);
        __record('expectedSecond', second.id);
        __record('countText', (__q('.walk-count') || {}).textContent);
        __record('expectedCount', 'Step ' + second.number + ' of ' + walkthroughTotal(entries));
        __record('activeBead', (__q('.walk-bead[aria-selected="true"]') || {}).getAttribute('data-walk-entry'));
        __record('announce', document.getElementById('workbench-status').textContent);
        __record('expectedAnnounce', 'Step ' + second.number + ' of ' + walkthroughTotal(entries) + ', '
          + (second.stage.name || second.id) + ', '
          + (nodeById.get(hop.from).label || hop.from) + ' to ' + (nodeById.get(hop.to).label || hop.to));
        __record('selectedNodes', __qa('.node-group.selected').map(function (n) { return n.id; }).sort());
        return __observed();
      })()`);
      const AFTER_PREV = ev(`(async function () {
        ${PAGE_HELPERS}
        await __sleep(80);
        window.__obs = {};
        __record('cursor', state.walkCursor);
        __record('activeBead', (__q('.walk-bead[aria-selected="true"]') || {}).getAttribute('data-walk-entry'));
        return __observed();
      })()`);
      const NEXT = key('j', { code: 'KeyJ', windowsVirtualKeyCode: 74 });
      const PREV = key('k', { code: 'KeyK', windowsVirtualKeyCode: 75 });
      const [phase] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [PROBE, NEXT, AFTER_NEXT, PREV, AFTER_PREV] }]);
      const [probe, afterNext, afterPrev] = phase.filter((step) => step.kind === 'eval').map((step) => step.value);
      assert.strictEqual(probe.beforeActive, false);
      assert.strictEqual(probe.beforeHidden, true, 'the track is hidden until a walkthrough starts');
      assert.strictEqual(probe.trackHidden, false, 'starting shows the track');
      assert.strictEqual(probe.beadCount, probe.entryCount, 'one bead per entry');
      assert.strictEqual(probe.countText, 'Step 1 of ' + probe.total);
      assert.strictEqual(probe.cursor, probe.firstEntry);
      assert.strictEqual(probe.activeBead, probe.firstEntry, 'the cursor bead is aria-selected');
      assert.strictEqual(probe.announce, probe.expectedAnnounce, 'the step announcement matches the format');
      assert.strictEqual(afterNext.cursor, afterNext.expectedSecond, 'j moves to the next entry');
      assert.strictEqual(afterNext.activeBead, afterNext.expectedSecond);
      assert.strictEqual(afterNext.countText, afterNext.expectedCount);
      assert.strictEqual(afterNext.announce, afterNext.expectedAnnounce, 'the next step announcement matches too');
      assert.notDeepStrictEqual(afterNext.selectedNodes, probe.selectedNodes, 'the canvas spotlight follows the cursor');
      assert.strictEqual(afterPrev.cursor, probe.firstEntry, 'k moves back to the first entry');
      assert.strictEqual(afterPrev.activeBead, probe.firstEntry);
    },
  ],

  [
    '1f: walkthrough parallel step draws numbered markers and the warehouse decision changes the path',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const MARKERS = ev(`(async function () {
        ${PAGE_HELPERS}
        startWalkthrough('scenario_fulfillment_saga_dlq');
        walkTo('stage_parallel_fulfillment_branches');
        await __sleep(80);
        window.__obs = {};
        var entries = linearizeScenario(selectedScenario(), state.walkChoices);
        var parallel = entries.find(function (e) { return e.id === 'stage_parallel_fulfillment_branches'; });
        __record('beforeTotal', walkthroughTotal(entries));
        __record('beforeList', __qa('[data-walk-list] .walk-item').length);
        __record('interactions', parallel.interactions.length);
        __record('markers', __qa('.walk-marker').map(function (m) { return m.getAttribute('data-walk-marker'); }).sort());
        __record('parallelBeads', __qa('.walk-bead-parallel').length);
        __record('decisionBeads', __qa('.walk-bead-decision').length);
        __record('endBeads', __qa('.walk-bead-end').length);
        __record('outcomePressed', __qa('[data-walk-entry="stage_warehouse_outcome_branch"] .walk-outcome').map(function (b) { return b.getAttribute('aria-pressed'); }));
        return __observed();
      })()`);
      const AFTER_CHOOSE = ev(`(async function () {
        ${PAGE_HELPERS}
        await __sleep(60);
        chooseOutcome('stage_warehouse_outcome_branch', 1);
        await __sleep(80);
        var entries = linearizeScenario(selectedScenario(), state.walkChoices);
        window.__obs = {};
        __record('afterTotal', walkthroughTotal(entries));
        __record('afterList', __qa('[data-walk-list] .walk-item').length);
        __record('hasDlq', entries.some(function (e) { return e.id === 'stage_route_dlq'; }));
        __record('cursor', state.walkCursor);
        __record('dlqPressed', (__q('[data-walk-entry="stage_warehouse_outcome_branch"] .walk-outcome[data-walk-outcome="1"]') || {}).getAttribute('aria-pressed'));
        __record('otherPressed', (__q('[data-walk-entry="stage_warehouse_outcome_branch"] .walk-outcome[data-walk-outcome="0"]') || {}).getAttribute('aria-pressed'));
        return __observed();
      })()`);
      const [phase] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [MARKERS, AFTER_CHOOSE] }]);
      const [before, after] = phase.filter((step) => step.kind === 'eval').map((step) => step.value);
      assert.deepStrictEqual(before.markers, ['1', '2', '3', '4'], 'a parallel step numbers each hop');
      assert.strictEqual(before.markers.length, before.interactions);
      assert.strictEqual(before.parallelBeads, 1);
      assert.strictEqual(before.decisionBeads, 1);
      assert.strictEqual(before.endBeads, 1);
      assert.deepStrictEqual(before.outcomePressed, ['true', 'false']);
      assert.ok(after.afterTotal > before.beforeTotal, 'the DLQ outcome adds steps');
      assert.ok(after.afterList > before.beforeList, 'the chapter list grows with the path');
      assert.strictEqual(after.hasDlq, true);
      assert.strictEqual(after.cursor, 'stage_warehouse_outcome_branch', 'choosing moves the cursor to the decision');
      assert.strictEqual(after.dlqPressed, 'true');
      assert.strictEqual(after.otherPressed, 'false');
    },
  ],

  [
    '1f: an o= link restores the chosen outcome and step, and Esc ends the walkthrough',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const PROBE = ev(`(async function () {
        ${PAGE_HELPERS}
        window.__obs = {};
        __record('active', state.scenarioActive);
        __record('cursor', state.walkCursor);
        __record('choices', state.walkChoices);
        __record('trackHidden', __q('.walk-track').hidden);
        __record('beadCount', __qa('.walk-track .walk-bead').length);
        __record('hasDlq', linearizeScenario(selectedScenario(), state.walkChoices).some(function (e) { return e.id === 'stage_route_dlq'; }));
        __record('pressed', (__q('[data-walk-entry="stage_warehouse_outcome_branch"] .walk-outcome[data-walk-outcome="1"]') || {}).getAttribute('aria-pressed'));
        return __observed();
      })()`);
      const AFTER_ESC = ev(`(async function () {
        ${PAGE_HELPERS}
        await __sleep(80);
        window.__obs = {};
        __record('active', state.scenarioActive);
        __record('trackHidden', __q('.walk-track').hidden);
        __record('edges', __qa('.edge-path.highlighted').length);
        return __observed();
      })()`);
      const hash = 'v=2&s=scenario_fulfillment_saga_dlq&at=stage_compensation_refund&o=stage_warehouse_outcome_branch:1';
      const [phase] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [PROBE, ESCAPE(), AFTER_ESC] }], undefined, { hash });
      const [before, after] = phase.filter((step) => step.kind === 'eval').map((step) => step.value);
      assert.strictEqual(before.active, true);
      assert.strictEqual(before.cursor, 'stage_compensation_refund');
      assert.deepStrictEqual(before.choices, { stage_warehouse_outcome_branch: 1 });
      assert.strictEqual(before.hasDlq, true, 'the restored choice selects the DLQ path');
      assert.strictEqual(before.trackHidden, false);
      assert.ok(before.beadCount > 0);
      assert.strictEqual(before.pressed, 'true', 'the restored outcome shows as chosen');
      assert.strictEqual(after.active, false, 'Esc ends the walkthrough');
      assert.strictEqual(after.trackHidden, true, 'Esc removes the track');
      assert.strictEqual(after.edges, 0);
    },
  ],

  [
    '1f: choosing a non-default outcome writes an o= walkthrough link',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const WRITE = ev(`(async function () {
        startWalkthrough('scenario_fulfillment_saga_dlq');
        chooseOutcome('stage_warehouse_outcome_branch', 1);
        updateUrlState();
        return location.hash;
      })()`);
      const [phase] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [WRITE] }]);
      const hash = lastEvalValue(phase);
      assert.ok(/[#&]s=scenario_fulfillment_saga_dlq(&|$)/.test(hash), hash);
      assert.ok(/[#&]at=stage_warehouse_outcome_branch(&|$)/.test(hash), hash);
      assert.ok(/[#&]o=stage_warehouse_outcome_branch:1(&|$)/.test(hash), hash);
    },
  ],

  [
    '1f: the Walkthrough chapter lists steps with narratives and reduced motion disables play',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const CHAPTER = ev(`(async function () {
        ${PAGE_HELPERS}
        startWalkthrough('scenario_fulfillment_saga_dlq');
        await __sleep(80);
        window.__obs = {};
        var entries = linearizeScenario(selectedScenario(), state.walkChoices);
        var first = __q('[data-walk-list] .walk-item[data-walk-entry="stage_submit_checkout"]');
        var decision = __q('[data-walk-list] [data-walk-entry="stage_warehouse_outcome_branch"]');
        __record('listCount', __qa('[data-walk-list] .walk-item').length);
        __record('entryCount', entries.length);
        __record('secondEntry', entries[1].id);
        __record('firstNumber', first ? (first.querySelector('.walk-item-number') || {}).textContent : null);
        __record('firstName', first ? (first.querySelector('.walk-item-name') || {}).textContent : null);
        __record('firstNarrative', first ? (first.querySelector('.walk-item-narrative') || {}).textContent : null);
        __record('generated', !!__q('[data-walk-list] .walk-generated'));
        __record('currentFirst', first ? first.classList.contains('current') : false);
        __record('condition', decision ? (decision.querySelector('.walk-condition') || {}).textContent : null);
        __record('outcomeCount', decision ? decision.querySelectorAll('.walk-outcome').length : -1);
        __record('endName', (__q('[data-walk-list] [data-walk-entry^="end:"] .walk-outcome-name') || {}).textContent);
        state.prefersReducedMotion = true;
        renderWalkTrack();
        await __sleep(40);
        var play = __q('.walk-play');
        __record('playDisabled', play ? play.disabled : null);
        __record('playPressed', play ? play.getAttribute('aria-pressed') : null);
        __record('note', (__q('.walk-note') || {}).textContent);
        toggleWalkPlayback();
        await __sleep(40);
        __record('announce', document.getElementById('workbench-status').textContent);
        __record('stillPaused', (__q('.walk-play') || {}).getAttribute('aria-pressed'));
        var beforeCursor = state.walkCursor;
        walkNext();
        await __sleep(40);
        __record('stepped', state.walkCursor !== beforeCursor);
        __record('steppedCursor', state.walkCursor);
        return __observed();
      })()`);
      const [phase] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [CHAPTER] }]);
      const obs = lastEvalValue(phase);
      assert.strictEqual(obs.listCount, obs.entryCount, 'the chapter lists one item per entry');
      assert.strictEqual(obs.firstNumber, '1');
      assert.strictEqual(obs.firstName, 'Initiate Checkout');
      assert.ok(obs.firstNarrative && obs.firstNarrative.length > 0, 'the step shows its narrative');
      assert.strictEqual(obs.generated, true, 'generated narratives are marked');
      assert.strictEqual(obs.currentFirst, true, 'the current step is highlighted');
      assert.strictEqual(obs.condition, 'Decision: Physical items intact in warehouse bin');
      assert.strictEqual(obs.outcomeCount, 2);
      assert.strictEqual(obs.endName, 'Outcome: Dispatch Successful');
      assert.strictEqual(obs.playDisabled, true, 'reduced motion disables play');
      assert.strictEqual(obs.playPressed, 'false');
      assert.ok(/Play is unavailable under reduced motion/.test(obs.note), obs.note);
      assert.ok(/Play is unavailable under reduced motion/.test(obs.announce), obs.announce);
      assert.strictEqual(obs.stillPaused, 'false', 'reduced motion does not start playback');
      assert.strictEqual(obs.stepped, true, 'stepping still works under reduced motion');
      assert.strictEqual(obs.steppedCursor, obs.secondEntry);
    },
  ],

  [
    'Phase 0: a shared deep link restores the selected node and camera instead of being overwritten on boot',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{
        width: 1440,
        height: 900,
        steps: [ev('JSON.stringify({ node: state.selectedNodeId, zoom: state.zoom, x: state.panX, y: state.panY })')],
      }], undefined, { hash: 'node=api&z=0.9&x=10&y=20' });
      assert.deepStrictEqual(JSON.parse(lastEvalValue(results[0])), { node: 'api', zoom: 0.9, x: 10, y: 20 });
    },
  ],

  [
    '1d: a version 2 link round-trips view, selection, filter, focus, step, presentation and camera',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const SNAP = `({ view: state.currentView, node: state.selectedNodeId, filter: state.activeFilter, focus: state.focusMode,
        present: state.presentation, seq: state.sequenceIndex, world: cameraToWorld(state, canvasSize()) })`;
      const [written] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [ev(`(function () {
        switchView('sequence');
        goToSequenceStep(4);
        openInspectorForNode('saga_orchestrator');
        document.querySelector('[data-filter="backend"]').click();
        setFocusMode('neighbors');
        setPresentation(true);
        zoomAround(state.zoom * 1.3, 400, 300);
        updateUrlState();
        return JSON.stringify({ hash: location.hash, snap: ${SNAP} });
      })()`)] }]);
      const before = JSON.parse(lastEvalValue(written));
      assert.ok(/^#v=2&view=sequence&n=saga_orchestrator&step=\d+&filter=backend&focus=neighbors&present=1&cam=-?[\d.]+,-?[\d.]+,[\d.]+$/.test(before.hash), before.hash);
      const [restored] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [ev(`JSON.stringify(${SNAP})`)] }], undefined, { hash: before.hash.slice(1) });
      const after = JSON.parse(lastEvalValue(restored));
      const { world: worldBefore, ...restBefore } = before.snap;
      const { world: worldAfter, ...restAfter } = after;
      assert.deepStrictEqual(restAfter, restBefore);
      ['x', 'y', 'w'].forEach((axis) => assert.ok(Math.abs(worldAfter[axis] - worldBefore[axis]) <= 0.1, `camera ${axis}: ${worldBefore[axis]} -> ${worldAfter[axis]}`));
    },
  ],

  [
    '1d: a version 2 camera frames the same world region on a different screen',
    () => {
      const WORLD = ev('JSON.stringify(cameraToWorld(state, canvasSize()))');
      [[1440, 900], [1024, 768]].forEach(([width, height]) => {
        const [phase] = runPhases(fixtures.VALID_SPEC, [{ width, height, steps: [WORLD] }], undefined, { hash: 'v=2&cam=600,400,1200' });
        const world = JSON.parse(lastEvalValue(phase));
        assert.ok(Math.abs(world.x - 600) < 0.01 && Math.abs(world.y - 400) < 0.01 && Math.abs(world.w - 1200) < 0.01, `${width}x${height}: ${JSON.stringify(world)}`);
      });
      const [moved] = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, steps: [ev('const held = holdsLinkedCamera(); zoomAround(state.zoom * 1.2, 100, 100); JSON.stringify([held, holdsLinkedCamera()])')] }], undefined, { hash: 'v=2&cam=600,400,1200' });
      assert.deepStrictEqual(JSON.parse(lastEvalValue(moved)), [true, false], 'the reader zooming releases the linked camera, so a later resize leaves their view alone');
    },
  ],

  [
    '1d: stage links use stable ids, and stale ids or newer versions are dropped with a notice',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const PROBE = ev(`JSON.stringify({ node: state.selectedNodeId, active: state.scenarioActive, stage: state.scenarioStage,
        edges: [...document.querySelectorAll('.edge-path.highlighted')].map((p) => p.id).sort(),
        status: document.getElementById('workbench-status').textContent })`);
      const probe = (hash) => JSON.parse(lastEvalValue(runPhases(SAGA, [{ width: 1440, height: 900, steps: [PROBE] }], undefined, { hash })[0]));

      const byId = probe('v=2&s=scenario_fulfillment_saga_dlq&at=stage_publish_order_created');
      assert.deepStrictEqual([byId.active, byId.stage, byId.edges], [true, 3, ['path-e_poller_kafka']]);

      const stale = probe('v=2&n=ghost_component&s=scenario_fulfillment_saga_dlq&at=stage_gone');
      assert.deepStrictEqual([stale.node, stale.active, stale.stage], [null, true, 0]);
      assert.ok(/Component ghost_component no longer exists\./.test(stale.status), stale.status);
      assert.ok(/Step stage_gone no longer exists; showing the walkthrough start\./.test(stale.status), stale.status);

      const future = probe('v=3&n=saga_orchestrator');
      assert.strictEqual(future.node, null, 'a newer link format must not be half-applied');
      assert.ok(/newer format \(version 3\)/.test(future.status), future.status);
    },
  ],

  [
    'Phase 0: playback, delta and gate overlays never sit under each other or a docked panel at 1440 and 1600',
    () => {
      const OVERLAPS = ev(`(function () {
        const sel = ['.filter-bar', '#delta-bar', '#sequence-bar', '.legend-box', '.workbench-minimap', '.viewport-controls', '#rail'];
        const vis = sel.map((s) => [s, document.querySelector(s)])
          .filter(([, e]) => e && e.getAttribute('data-open') !== 'false' && getComputedStyle(e).display !== 'none')
          .map(([s, e]) => [s, e.getBoundingClientRect()])
          .filter(([, r]) => r.width > 0 && r.right > 0 && r.left < innerWidth);
        const hits = [];
        for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
          const a = vis[i][1], b = vis[j][1];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) hits.push(vis[i][0] + ' x ' + vis[j][0]);
        }
        return hits;
      })()`);
      const settle = ev('new Promise((resolve) => setTimeout(() => resolve(0), 350))');
      const steps = [
        ev("switchView('sequence'); goToSequenceStep(2); 0"), settle, OVERLAPS,
        ev("openInspectorForNode('saga_orchestrator'); 0"), settle, OVERLAPS,
        ev("closeInspector(); selectLens('change', { explicit: true }); 0"), settle, OVERLAPS,
        ev("switchView('architecture'); toggleGatePanel(); 0"), settle, OVERLAPS,
      ];
      const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [
        { width: 1440, height: 900, steps },
        { width: 1600, height: 960, steps },
      ]);
      results.forEach((phase, index) => {
        const checks = phase.filter((step) => step.kind === 'eval' && Array.isArray(step.value)).map((step) => step.value);
        assert.strictEqual(checks.length, 4);
        checks.forEach((hits, state) => assert.deepStrictEqual(hits, [], `viewport ${index}, state ${state}: ${hits.join('; ')}`));
      });
    },
  ],

  [
    'Phase 0: a label displaced off a short edge is tethered to it by a leader line',
    () => {
      const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{
        width: 1440,
        height: 900,
        steps: [ev(`(function () {
          const edge = LAYOUT_DATA.edges.find((e) => e.id === 'e_dlq_triage');
          const leader = document.querySelector('#label-e_dlq_triage .edge-label-leader');
          return { leader: Boolean(leader), x1: leader && Number(leader.getAttribute('x1')), tetherX: edge.labelTether.x };
        })()`)],
      }], undefined, { compileOptions: { layoutOverrides: { router: 'curved' } } });
      const value = lastEvalValue(results[0]);
      assert.ok(value.leader, 'the pushed-out "Consume Poison Message" label must have a leader back to its edge');
      assert.strictEqual(value.x1, value.tetherX);
    },
  ],

  [
    'Phase 0: the sequence playback bar keeps every control inside it and on screen from phone to tablet widths',
    () => {
      const MEASURE = ev(`(function () {
        switchView('sequence'); goToSequenceStep(1);
        const bar = document.getElementById('sequence-bar').getBoundingClientRect();
        const out = [...document.getElementById('sequence-bar').children].filter((c) => { const r = c.getBoundingClientRect(); return r.left < bar.left - 1 || r.right > bar.right + 1; }).length;
        return { left: bar.left, right: bar.right, width: bar.width, out, viewport: innerWidth };
      })()`);
      const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [
        { width: 390, height: 844, steps: [MEASURE] },
        { width: 768, height: 900, steps: [MEASURE] },
        { width: 1024, height: 768, steps: [MEASURE] },
      ]);
      results.forEach((phase) => {
        const m = lastEvalValue(phase);
        assert.strictEqual(m.out, 0, `controls spill out of the playback bar at ${m.viewport}px: ${JSON.stringify(m)}`);
        assert.ok(m.left >= 0 && m.right <= m.viewport, `playback bar leaves the viewport at ${m.viewport}px: ${JSON.stringify(m)}`);
      });
    },
  ],

  [
    '1c: palette Ctrl+K opens and selects component and connection',
    () => {
      const CTRL_K = key('k', { code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          __record('transformBefore', __transform());
          return __observed();
        })()`),
        CTRL_K,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(100);
          var scrim = __q('#palette-scrim');
          var input = __q('#palette-input');
          __record('paletteOpen', scrim ? scrim.getAttribute('data-open') : null);
          __record('inputFocused', document.activeElement === input);
          __input(input, 'API Service');
          await __sleep(100);
          var firstRow = __q('#palette-opt-0');
          __record('firstRowModelId', firstRow ? firstRow.getAttribute('data-model-id') : null);
          return __observed();
        })()`),
        ENTER(),
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(200);
          var scrim = __q('#palette-scrim');
          var node = __q('#node-api');
          var rail = __region('rail');
          __record('paletteClosedAfterNode', scrim ? scrim.getAttribute('data-open') : null);
          __record('nodeSelected', node ? node.getAttribute('data-selected') : null);
          __record('railOpenNode', __open('rail'));
          __record('railSheetNode', rail ? rail.getAttribute('data-sheet') : null);
          __record('transformAfterNode', __transform());
          return __observed();
        })()`),
        CTRL_K,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(100);
          var input = __q('#palette-input');
          __input(input, 'SQL Write');
          await __sleep(100);
          var firstRow = __q('#palette-opt-0');
          __record('edgeRowModelId', firstRow ? firstRow.getAttribute('data-model-id') : null);
          return __observed();
        })()`),
        ENTER(),
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(200);
          var scrim = __q('#palette-scrim');
          var edge = __q('#path-e1');
          var rail = __region('rail');
          __record('paletteClosedAfterEdge', scrim ? scrim.getAttribute('data-open') : null);
          __record('edgeSelected', edge ? edge.getAttribute('data-selected') : null);
          __record('railOpenEdge', __open('rail'));
          __record('railSheetEdge', rail ? rail.getAttribute('data-sheet') : null);
          __record('transformAfterEdge', __transform());
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.paletteOpen, 'true', 'Ctrl+K should open the palette');
      assert.strictEqual(obs.inputFocused, true, 'Palette input should be focused on open');
      assert.strictEqual(obs.firstRowModelId, 'api', 'Typing "API Service" should put api component first');
      assert.strictEqual(obs.nodeSelected, 'true', 'Enter should mark #node-api data-selected="true"');
      assert.strictEqual(obs.railOpenNode, 'true', 'Selecting node should open rail');
      assert.strictEqual(obs.railSheetNode, 'node', 'Rail should be in node sheet state');
      assert.notStrictEqual(obs.transformAfterNode, obs.transformBefore, 'Camera transform should change on node selection');
      assert.strictEqual(obs.paletteClosedAfterNode, 'false', 'Palette should close after running node item');

      assert.strictEqual(obs.edgeRowModelId, 'e1', 'Typing "SQL Write" should put e1 connection first');
      assert.strictEqual(obs.edgeSelected, 'true', 'Enter should mark #path-e1 data-selected="true"');
      assert.strictEqual(obs.railOpenEdge, 'true', 'Selecting edge should open rail');
      assert.strictEqual(obs.railSheetEdge, 'edge', 'Rail should be in edge sheet state');
      assert.notStrictEqual(obs.transformAfterEdge, obs.transformAfterNode, 'Camera transform should change on edge selection');
      assert.strictEqual(obs.paletteClosedAfterEdge, 'false', 'Palette should close after running edge item');
    },
  ],

  [
    '1c: palette ArrowDown moves aria-activedescendant and aria-selected to the second row',
    () => {
      const CTRL_K = key('k', { code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
      const ARROW_DOWN = key('ArrowDown', { code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      const steps = [
        CTRL_K,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(100);
          window.__obs = {};
          var input = __q('#palette-input');
          var row0 = __q('#palette-opt-0');
          var row1 = __q('#palette-opt-1');
          __record('initialDescendant', input ? input.getAttribute('aria-activedescendant') : null);
          __record('initialRow0Selected', row0 ? row0.getAttribute('aria-selected') : null);
          __record('initialRow1Selected', row1 ? row1.getAttribute('aria-selected') : null);
          return __observed();
        })()`),
        ARROW_DOWN,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(80);
          var input = __q('#palette-input');
          var row0 = __q('#palette-opt-0');
          var row1 = __q('#palette-opt-1');
          __record('afterDescendant', input ? input.getAttribute('aria-activedescendant') : null);
          __record('afterRow0Selected', row0 ? row0.getAttribute('aria-selected') : null);
          __record('afterRow1Selected', row1 ? row1.getAttribute('aria-selected') : null);
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.initialDescendant, 'palette-opt-0', 'Initial aria-activedescendant should be first row');
      assert.strictEqual(obs.initialRow0Selected, 'true', 'First row should be selected initially');
      assert.strictEqual(obs.initialRow1Selected, 'false', 'Second row should not be selected initially');
      assert.strictEqual(obs.afterDescendant, 'palette-opt-1', 'ArrowDown should move aria-activedescendant to second row');
      assert.strictEqual(obs.afterRow0Selected, 'false', 'First row should no longer be selected after ArrowDown');
      assert.strictEqual(obs.afterRow1Selected, 'true', 'Second row should be selected after ArrowDown');
    },
  ],

  [
    '1c: palette presentation and mermaid commands run from search',
    () => {
      const CTRL_K = key('k', { code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
      const steps = [
        CTRL_K,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(100);
          window.__obs = {};
          var input = __q('#palette-input');
          __input(input, 'presentation');
          await __sleep(100);
          return __observed();
        })()`),
        ENTER(),
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(150);
          __record('presentation', document.body.getAttribute('data-presentation'));
          var scrim = __q('#palette-scrim');
          __record('paletteClosedAfterPres', scrim ? scrim.getAttribute('data-open') : null);
          return __observed();
        })()`),
        CTRL_K,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(100);
          var input = __q('#palette-input');
          __input(input, 'mermaid');
          await __sleep(100);
          return __observed();
        })()`),
        ENTER(),
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(150);
          var modal = __q('#modal');
          var scrim = __q('#palette-scrim');
          __record('modalOpen', modal ? modal.classList.contains('open') : false);
          __record('paletteClosedAfterMermaid', scrim ? scrim.getAttribute('data-open') : null);
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.presentation, 'true', 'presentation + Enter should set body[data-presentation="true"]');
      assert.strictEqual(obs.paletteClosedAfterPres, 'false', 'Palette should close after presentation command');
      assert.strictEqual(obs.modalOpen, true, 'mermaid + Enter should open the Mermaid modal');
      assert.strictEqual(obs.paletteClosedAfterMermaid, 'false', 'Palette should close after mermaid command');
    },
  ],

  [
    '1c: palette Escape closes, restores button focus and preserves selection',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          openInspectorForNode('api');
          await __sleep(120);
          var node = __q('#node-api');
          __record('initiallySelected', node ? node.getAttribute('data-selected') : null);
          var btn = __q('#btn-palette');
          __click(btn);
          await __sleep(100);
          var scrim = __q('#palette-scrim');
          __record('paletteOpen', scrim ? scrim.getAttribute('data-open') : null);
          return __observed();
        })()`),
        ESCAPE(),
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(120);
          var scrim = __q('#palette-scrim');
          var node = __q('#node-api');
          var btn = __q('#btn-palette');
          __record('paletteOpenAfterEscape', scrim ? scrim.getAttribute('data-open') : null);
          __record('focusRestoredToBtn', document.activeElement === btn);
          __record('nodeStillSelected', node ? node.getAttribute('data-selected') : null);
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.initiallySelected, 'true', 'Node should be selected before opening palette');
      assert.strictEqual(obs.paletteOpen, 'true', 'Clicking #btn-palette should open palette');
      assert.strictEqual(obs.paletteOpenAfterEscape, 'false', 'Escape should close palette');
      assert.strictEqual(obs.focusRestoredToBtn, true, 'Focus should return to #btn-palette after Escape');
      assert.strictEqual(obs.nodeStillSelected, 'true', 'Existing selection should remain selected');
    },
  ],

  [
    '1c: palette fits inside viewport and prevents horizontal scroll at 320x800',
    () => {
      const CTRL_K = key('k', { code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
      const steps = [
        CTRL_K,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(120);
          window.__obs = {};
          var scrim = __q('#palette-scrim');
          var palette = __q('#palette-dialog') || __q('.palette');
          var r = palette ? palette.getBoundingClientRect() : null;
          __record('paletteOpen', scrim ? scrim.getAttribute('data-open') : null);
          __record('rect', r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null);
          __record('innerWidth', window.innerWidth);
          __record('innerHeight', window.innerHeight);
          __record('scrollWidth', document.documentElement.scrollWidth);
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 320, height: 800, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.paletteOpen, 'true', 'Palette should open at 320x800');
      assert.strictEqual(obs.innerWidth, 320, 'innerWidth should be 320');
      assert.ok(obs.scrollWidth <= obs.innerWidth, `document.documentElement.scrollWidth (${obs.scrollWidth}) must not be greater than innerWidth (${obs.innerWidth})`);
      assert.ok(obs.rect, 'Palette rect must exist');
      assert.ok(obs.rect.left >= 0, `Palette left (${obs.rect.left}) must be >= 0`);
      assert.ok(obs.rect.right <= obs.innerWidth, `Palette right (${obs.rect.right}) must be <= innerWidth (${obs.innerWidth})`);
      assert.ok(obs.rect.top >= 0, `Palette top (${obs.rect.top}) must be >= 0`);
      assert.ok(obs.rect.bottom <= obs.innerHeight, `Palette bottom (${obs.rect.bottom}) must be <= innerHeight (${obs.innerHeight})`);
    },
  ],


  [
    '1c: from phone to desktop the header keeps every visible control on screen, the palette reachable and the title ellipsized',
    () => {
      const PROBE = ev(`JSON.stringify((function () {
        const controls = [...document.querySelectorAll('header button')].filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0);
        const mark = document.querySelector('.brand-mark').getBoundingClientRect();
        const palette = document.getElementById('btn-palette').getBoundingClientRect();
        return {
          scroll: document.documentElement.scrollWidth - innerWidth,
          offscreen: controls.filter((b) => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 0.5; }).map((b) => b.id || b.getAttribute('aria-label')),
          palette: palette.width > 0 && palette.left >= mark.right,
          markWidth: mark.width,
        };
      })())`);
      [320, 390, 768, 900, 1024, 1280, 1440].forEach((width) => {
        const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width, height: 844, steps: [PROBE] }]);
        const probe = JSON.parse(lastEvalValue(phase));
        assert.strictEqual(probe.scroll, 0, `${width}: the page scrolls sideways`);
        assert.deepStrictEqual(probe.offscreen, [], `${width}: header controls pushed off screen`);
        assert.ok(probe.palette, `${width}: the palette button is hidden or overlaps the brand mark`);
        assert.ok(probe.markWidth >= 14, `${width}: the brand mark was squeezed`);
      });
    },
  ],

  [
    '1c: rail chapter tabs by keyboard (arrows change aria-selected and the visible panel)',
    () => {
      const ARROW_RIGHT = key('ArrowRight', { code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      const ARROW_LEFT = key('ArrowLeft', { code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          var tabOv = __q('#chapter-tab-overview');
          if (tabOv) tabOv.focus();
          await __sleep(60);
          __record('initialFocus', document.activeElement === tabOv);
          __record('initialChapter', state.chapter);
          __record('initialOvSelected', tabOv ? tabOv.getAttribute('aria-selected') : null);
          __record('initialOvHidden', __q('#chapter-overview') ? __q('#chapter-overview').hidden : null);
          __record('initialWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
          return __observed();
        })()`),
        ARROW_RIGHT,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(60);
          var tabWalk = __q('#chapter-tab-walkthrough');
          var tabOv = __q('#chapter-tab-overview');
          __record('afterRightFocusWalk', document.activeElement === tabWalk);
          __record('afterRightOvSelected', tabOv ? tabOv.getAttribute('aria-selected') : null);
          __record('afterRightWalkSelected', tabWalk ? tabWalk.getAttribute('aria-selected') : null);
          __record('afterRightOvHidden', __q('#chapter-overview') ? __q('#chapter-overview').hidden : null);
          __record('afterRightWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
          return __observed();
        })()`),
        ARROW_RIGHT,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(60);
          var tabCh = __q('#chapter-tab-changes');
          var tabWalk = __q('#chapter-tab-walkthrough');
          __record('afterSecondFocusChanges', document.activeElement === tabCh);
          __record('afterSecondWalkSelected', tabWalk ? tabWalk.getAttribute('aria-selected') : null);
          __record('afterSecondChangesSelected', tabCh ? tabCh.getAttribute('aria-selected') : null);
          __record('afterSecondWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
          __record('afterSecondChangesHidden', __q('#chapter-changes') ? __q('#chapter-changes').hidden : null);
          return __observed();
        })()`),
        ARROW_LEFT,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(60);
          var tabWalk = __q('#chapter-tab-walkthrough');
          var tabCh = __q('#chapter-tab-changes');
          __record('afterLeftFocus', document.activeElement === tabWalk);
          __record('afterLeftWalkSelected', tabWalk ? tabWalk.getAttribute('aria-selected') : null);
          __record('afterLeftChangesSelected', tabCh ? tabCh.getAttribute('aria-selected') : null);
          __record('afterLeftWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
          __record('afterLeftChangesHidden', __q('#chapter-changes') ? __q('#chapter-changes').hidden : null);
          return __observed();
        })()`),
      ];
      const results = runPhases('examples/2-complex-database-migration/architecture.json', [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.initialFocus, true, 'Overview tab should be focused initially');
      assert.strictEqual(obs.initialChapter, 'overview', 'Overview should be the default chapter');
      assert.strictEqual(obs.initialOvSelected, 'true', 'Overview tab should be selected initially');
      assert.strictEqual(obs.initialOvHidden, false, 'Overview panel should be visible initially');
      assert.strictEqual(obs.initialWalkHidden, true, 'Walkthrough panel should be hidden initially');
      assert.strictEqual(obs.afterRightFocusWalk, true, 'ArrowRight should move focus to Walkthrough tab');
      assert.strictEqual(obs.afterRightOvSelected, 'false', 'Overview tab should not be selected after ArrowRight');
      assert.strictEqual(obs.afterRightWalkSelected, 'true', 'Walkthrough tab should be selected after ArrowRight');
      assert.strictEqual(obs.afterRightOvHidden, true, 'Overview panel should be hidden after ArrowRight');
      assert.strictEqual(obs.afterRightWalkHidden, false, 'Walkthrough panel should be visible after ArrowRight');
      assert.strictEqual(obs.afterSecondFocusChanges, true, 'A second ArrowRight should move focus to Changes tab');
      assert.strictEqual(obs.afterSecondWalkSelected, 'false', 'Walkthrough tab should not be selected after the second ArrowRight');
      assert.strictEqual(obs.afterSecondChangesSelected, 'true', 'Changes tab should be selected after the second ArrowRight');
      assert.strictEqual(obs.afterSecondWalkHidden, true, 'Walkthrough panel should be hidden after the second ArrowRight');
      assert.strictEqual(obs.afterSecondChangesHidden, false, 'Changes panel should be visible after the second ArrowRight');
      assert.strictEqual(obs.afterLeftFocus, true, 'ArrowLeft should move focus back to Walkthrough tab');
      assert.strictEqual(obs.afterLeftWalkSelected, 'true', 'Walkthrough tab should be selected after ArrowLeft');
      assert.strictEqual(obs.afterLeftChangesSelected, 'false', 'Changes tab should not be selected after ArrowLeft');
      assert.strictEqual(obs.afterLeftWalkHidden, false, 'Walkthrough panel should be visible after ArrowLeft');
      assert.strictEqual(obs.afterLeftChangesHidden, true, 'Changes panel should be hidden after ArrowLeft');
    },
  ],

  [
    '1c: rail the trust strip rules pill opens Review with the gate rows visible',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          var btnGate = __q('.trust-pill[data-trust="rules"]');
          __record('gateButtonPresent', !!btnGate);
          __record('initialChapter', state.chapter);
          if (btnGate) __click(btnGate);
          await __sleep(120);
          var revTab = __q('#chapter-tab-review');
          var revPanel = __q('#chapter-review');
          var gateBody = __q('#gate-body');
          var gateRows = gateBody ? gateBody.querySelectorAll('.gate-row') : [];
          __record('railOpen', __open('rail'));
          __record('chapterAfter', state.chapter);
          __record('revTabSelected', revTab ? revTab.getAttribute('aria-selected') : null);
          __record('revPanelHidden', revPanel ? revPanel.hidden : null);
          __record('gateRowsCount', gateRows.length);
          __record('gateBodyVisible', gateBody ? gateBody.getBoundingClientRect().height > 0 : false);
          return __observed();
        })()`),
      ];
      const results = runPhases('examples/2-complex-database-migration/architecture.json', [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.gateButtonPresent, true, 'the rules pill should be present in the trust strip');
      assert.strictEqual(obs.railOpen, 'true', 'Rail should be open after clicking the rules pill');
      assert.strictEqual(obs.chapterAfter, 'review', 'Active chapter should be review after clicking the rules pill');
      assert.strictEqual(obs.revTabSelected, 'true', 'Review tab should be selected');
      assert.strictEqual(obs.revPanelHidden, false, 'Review panel should be visible');
      assert.ok(obs.gateRowsCount > 0, `Expected gate rows to be rendered in #gate-body, found ${obs.gateRowsCount}`);
      assert.strictEqual(obs.gateBodyVisible, true, '#gate-body should be visible in the Review chapter');
    },
  ],

  [
    '1c: rail a #view=database_er link opens the Data chapter with every table of example 2',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          __record('chapter', state.chapter);
          __record('currentView', state.currentView);
          var dataTab = __q('#chapter-tab-data');
          var dataPanel = __q('#chapter-data');
          __record('dataTabSelected', dataTab ? dataTab.getAttribute('aria-selected') : null);
          __record('dataPanelHidden', dataPanel ? dataPanel.hidden : null);
          var tables = __qa('#chapter-data .er-table-card');
          __record('tableCount', tables.length);
          __record('tableNames', tables.map(function (t) { return t.getAttribute('data-table'); }));
          return __observed();
        })()`),
      ];
      const results = runPhases('examples/2-complex-database-migration/architecture.json', [{ width: 1440, height: 900, mobile: false, steps }], undefined, { hash: 'view=database_er' });
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.chapter, 'data', 'Active chapter should be data');
      assert.strictEqual(obs.currentView, 'architecture', 'Canvas view should be architecture');
      assert.strictEqual(obs.dataTabSelected, 'true', 'Data chapter tab should be selected');
      assert.strictEqual(obs.dataPanelHidden, false, 'Data chapter panel should be visible');
      assert.strictEqual(obs.tableCount, 4, 'All 4 tables of example 2 should be rendered in the Data chapter');
      const expected = ['orders_legacy', 'orders_partitioned', 'orders_2026_09', 'orders_2026_10'];
      expected.forEach((name) => {
        assert.ok(obs.tableNames.includes(name), `Expected table ${name} to be rendered in Data chapter`);
      });
    },
  ],

  [
    '1c: rail sheet Back returns to the chapter and keeps the node selected',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          openInspectorForNode('api');
          await __sleep(80);
          var rail = __region('rail');
          var sheet = __q('#component-sheet');
          var backBtn = __q('[data-action="sheet-back"]');
          __record('sheetOpen', rail ? rail.getAttribute('data-sheet') : null);
          __record('sheetHidden', sheet ? sheet.hidden : null);
          __record('nodeSelectedBefore', state.selectedNodeId);
          __record('backText', backBtn ? backBtn.textContent.trim() : null);
          if (backBtn) __click(backBtn);
          await __sleep(80);
          __record('sheetClosed', rail ? rail.getAttribute('data-sheet') : null);
          __record('sheetHiddenAfter', sheet ? sheet.hidden : null);
          __record('nodeSelectedAfter', state.selectedNodeId);
          var nodeEl = __q('#node-api');
          __record('nodeAttrSelected', nodeEl ? nodeEl.getAttribute('data-selected') : null);
          __record('chapter', state.chapter);
          __record('chapterOverviewHidden', __q('#chapter-overview') ? __q('#chapter-overview').hidden : null);
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.sheetOpen, 'node', 'Sheet should open in node mode');
      assert.strictEqual(obs.sheetHidden, false, 'Sheet should be visible');
      assert.strictEqual(obs.nodeSelectedBefore, 'api', 'Node should be selected before Back');
      assert.strictEqual(obs.sheetClosed, 'none', 'Rail data-sheet should be none after Back');
      assert.strictEqual(obs.sheetHiddenAfter, true, 'Sheet should be hidden after Back');
      assert.strictEqual(obs.nodeSelectedAfter, 'api', 'Node should still be selected in state after Back');
      assert.strictEqual(obs.nodeAttrSelected, 'true', '#node-api should keep data-selected="true" after Back');
      assert.strictEqual(obs.chapter, 'overview', 'Should return to the default chapter (overview)');
      assert.strictEqual(obs.chapterOverviewHidden, false, 'Overview chapter should be visible');
    },
  ],

  [
    '1c: rail the sheet\'s "Show neighbours" sets aria-pressed and body[data-focus-mode="neighbors"]',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          openInspectorForNode('api');
          await __sleep(80);
          var btn = __q('#btn-focus-neighbors');
          __record('btnPresent', !!btn);
          __record('btnText', btn ? btn.textContent.trim() : null);
          __record('initialPressed', btn ? btn.getAttribute('aria-pressed') : null);
          __record('initialBodyMode', document.body.getAttribute('data-focus-mode'));
          if (btn) __click(btn);
          await __sleep(80);
          __record('afterPressed', btn ? btn.getAttribute('aria-pressed') : null);
          __record('afterBodyMode', document.body.getAttribute('data-focus-mode'));
          __record('storeFocusMode', state.focusMode);
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.btnPresent, true, '#btn-focus-neighbors should be present in the sheet');
      assert.strictEqual(obs.initialPressed, 'false', 'Initial aria-pressed should be false');
      assert.strictEqual(obs.initialBodyMode, null, 'Initial body[data-focus-mode] should be null');
      assert.strictEqual(obs.afterPressed, 'true', 'Clicking Show neighbours should set aria-pressed="true"');
      assert.strictEqual(obs.afterBodyMode, 'neighbors', 'Clicking Show neighbours should set body[data-focus-mode="neighbors"]');
      assert.strictEqual(obs.storeFocusMode, 'neighbors', 'state.focusMode should be set to "neighbors"');
    },
  ],

  [
    '1c: rail at 1440 the canvas starts at x=0 and ends at the rail edge with no navigator',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(300);
          window.__obs = {};
          var canvas = __region('canvas');
          var rail = __region('rail');
          __record('navigatorPresent', !!__q('.workbench-navigator'));
          __record('canvasRect', __rect(canvas));
          __record('railRect', __rect(rail));
          __record('scrollWidth', document.documentElement.scrollWidth);
          __record('innerWidth', window.innerWidth);
          return __observed();
        })()`),
      ];
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.innerWidth, 1440);
      assert.strictEqual(obs.navigatorPresent, false, 'the navigator panel must not exist at 1440px');
      assert.ok(obs.scrollWidth <= 1440 + 1, `Page should not scroll horizontally (scrollWidth=${obs.scrollWidth}, innerWidth=${obs.innerWidth})`);
      assert.ok(Math.abs(obs.railRect.width - 400) <= 1, `Rail width should be 400 at 1440px, got ${obs.railRect.width}`);
      const expectedCanvasWidth = 1440 - 400;
      assert.ok(Math.abs(obs.canvasRect.width - expectedCanvasWidth) <= 1, `Canvas width should be ${expectedCanvasWidth}, got ${obs.canvasRect.width}`);
      assert.ok(Math.abs(obs.canvasRect.x) <= 1, `Canvas should start at x=0, got ${obs.canvasRect.x}`);
      assert.ok(obs.canvasRect.right <= obs.railRect.x + 1, 'Canvas should end at the rail edge');
      assert.ok(obs.railRect.right <= obs.innerWidth + 1, 'Rail should stay within viewport right boundary');
      assert.ok(!rectsOverlap(obs.canvasRect, obs.railRect), 'Canvas and rail must not overlap');
    },
  ],

  [
    '1c: chapters Overview shows the five trust rows and its Open Evidence button selects Evidence',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          openChapter('overview');
          await __sleep(150);
          var summary = trustSummary(ARCH_SPEC, QUALITY_GATE);
          __record('expected', Object.keys(summary).map(function (key) {
            return { key: key, label: summary[key].label, state: summary[key].state, chapter: summary[key].chapter };
          }));
          __record('rows', __qa('#overview-trust .ov-trust-row').map(function (row) {
            var dot = row.querySelector('.trust-dot');
            return {
              key: row.getAttribute('data-trust-key'),
              label: (row.querySelector('.ov-trust-label') || {}).textContent,
              state: dot ? dot.getAttribute('data-state') : null,
              chapter: row.querySelector('.ov-trust-open') ? row.querySelector('.ov-trust-open').getAttribute('data-trust-chapter') : null,
            };
          }));
          __record('title', (__q('#overview-title') || {}).textContent);
          __record('expectedTitle', ARCH_SPEC.meta.title);
          __record('facts', __qa('#overview-facts .overview-fact').length);
          var evidenceBtn = __q('#overview-trust [data-trust-chapter="evidence"]');
          __record('evidenceButtonText', evidenceBtn ? evidenceBtn.textContent : null);
          if (evidenceBtn) __click(evidenceBtn);
          await __sleep(120);
          __record('chapterAfter', state.chapter);
          __record('evidencePanelHidden', __q('#chapter-evidence') ? __q('#chapter-evidence').hidden : null);
          __record('evidenceTabSelected', __q('#chapter-tab-evidence') ? __q('#chapter-tab-evidence').getAttribute('aria-selected') : null);
          return __observed();
        })()`),
      ];
      const results = runPhases(SAGA, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.rows.length, 5, `Overview should show five trust rows, found ${obs.rows.length}`);
      assert.deepStrictEqual(obs.rows, obs.expected, 'Overview trust rows must mirror trustSummary(ARCH_SPEC, QUALITY_GATE)');
      assert.strictEqual(obs.title, obs.expectedTitle, 'Overview h2 should be the model title');
      assert.strictEqual(obs.facts, 4, `Overview should show four facts, found ${obs.facts}`);
      assert.strictEqual(obs.evidenceButtonText, 'Open Evidence', 'grounding/evidence rows should offer an Open Evidence button');
      assert.strictEqual(obs.chapterAfter, 'evidence', 'Open Evidence should select the Evidence chapter');
      assert.strictEqual(obs.evidencePanelHidden, false, 'Evidence panel should be visible after Open Evidence');
      assert.strictEqual(obs.evidenceTabSelected, 'true', 'Evidence tab should be selected after Open Evidence');
    },
  ],

  [
    '1c: chapters Overview "How it works" item activates that stage on the canvas',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          openChapter('overview');
          await __sleep(150);
          var buttons = __qa('#overview-stages button');
          __record('names', buttons.map(function (b) { return b.textContent; }));
          var target = null;
          buttons.forEach(function (b) {
            if (b.getAttribute('data-overview-stage') === 'stage_publish_order_created') target = b;
          });
          __record('targetPresent', !!target);
          if (target) __click(target);
          await __sleep(220);
          __record('scenarioActive', state.scenarioActive);
          __record('stageId', (flattenScenarioStages(selectedScenario().stages)[state.scenarioStage] || {}).id);
          __record('highlighted', __qa('.edge-path.highlighted').length);
          __record('chapter', state.chapter);
          return __observed();
        })()`),
      ];
      const results = runPhases(SAGA, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.ok(obs.names.includes('Publish to Kafka Event Bus'), `top-level stage names missing: ${JSON.stringify(obs.names)}`);
      assert.strictEqual(obs.targetPresent, true, 'the Publish to Kafka Event Bus stage button should exist');
      assert.strictEqual(obs.scenarioActive, true, 'selecting an Overview stage should activate the scenario');
      assert.strictEqual(obs.stageId, 'stage_publish_order_created', 'the clicked stage should be the active stage');
      assert.ok(obs.highlighted > 0, 'the canvas should spotlight the stage interactions');
      assert.strictEqual(obs.chapter, 'walkthrough', 'selecting a stage should open the Walkthrough chapter');
    },
  ],

  [
    '1c: chapters Changes lists every added component and its blast-radius counts',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          openChapter('changes');
          await __sleep(150);
          __record('added', __qa('[data-change-delta="ADDED"] [data-change-component]').map(function (b) {
            return b.getAttribute('data-change-component');
          }).sort());
          __record('expectedAdded', ARCH_SPEC.review.changedComponents.filter(function (c) {
            return c.delta === 'ADDED';
          }).map(function (c) { return c.id; }).sort());
          __record('blast', __qa('#changes-blast [data-blast-node]').map(function (d) {
            return {
              id: d.getAttribute('data-blast-node'),
              up: Number(d.getAttribute('data-blast-up')),
              down: Number(d.getAttribute('data-blast-down')),
            };
          }));
          __record('expectedBlast', ARCH_SPEC.review.blastRadius.map(function (e) {
            return { id: e.nodeId, up: e.upstream.length, down: e.downstream.length };
          }));
          var trace = __q('#changes-traceability [data-trace-summary]');
          __record('trace', trace ? trace.textContent : null);
          __record('traceExpected', ARCH_SPEC.review.traceability.mapped.length + ' of ' + ARCH_SPEC.review.traceability.changed.length + ' changed components mapped');
          return __observed();
        })()`),
      ];
      const results = runPhases(SAGA, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.deepStrictEqual(obs.added, obs.expectedAdded, 'Changes must list every ADDED component of example 3');
      assert.ok(obs.expectedAdded.length >= 4, `example 3 should have several ADDED components, found ${obs.expectedAdded.length}`);
      assert.strictEqual(obs.blast.length, obs.expectedBlast.length, 'every blast-radius entry should render');
      assert.deepStrictEqual(obs.blast, obs.expectedBlast, 'blast-radius counts must match the model');
      assert.strictEqual(obs.trace, obs.traceExpected, 'traceability line should state mapped of changed');
    },
  ],

  [
    '1c: chapters Evidence lists every locator of a component without a cap',
    () => {
      const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          openChapter('evidence');
          await __sleep(150);
          var evidence = nodeEvidence(ARCH_SPEC, 'saga_orchestrator');
          var row = __q('[data-evidence-node="saga_orchestrator"]');
          __record('locatorCount', row ? row.querySelectorAll('.evidence-locator').length : -1);
          __record('expectedLocators', evidence.locators.length);
          __record('chipState', row && row.querySelector('.evidence-chip') ? row.querySelector('.evidence-chip').getAttribute('data-evidence-state') : null);
          __record('expectedState', evidence.state);
          __record('firstLocatorText', row && row.querySelector('.evidence-locator') ? row.querySelector('.evidence-locator').textContent : null);
          return __observed();
        })()`),
      ];
      const results = runPhases(SAGA, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.ok(obs.expectedLocators >= 1, 'saga_orchestrator should have at least one locator');
      assert.strictEqual(obs.locatorCount, obs.expectedLocators, 'Evidence must render every locator of saga_orchestrator');
      assert.strictEqual(obs.chipState, obs.expectedState, 'evidence state chip must match nodeEvidence');
      assert.ok(obs.firstLocatorText && obs.firstLocatorText.length > 0, 'locator buttons should carry their text');
    },
  ],

  [
    '1c: chapters every chapter opens without horizontal page scroll from 320 to 1440',
    () => {
      const CHAPTERS = ['overview', 'walkthrough', 'changes', 'review', 'evidence'];
      const WIDTHS = [320, 390, 768, 1024, 1440];
      const phases = WIDTHS.map((width) => ({
        width,
        height: 844,
        mobile: false,
        script: `(async function () {
          ${PAGE_HELPERS}
          var out = { innerWidth: window.innerWidth, overflow: {} };
          var chapters = ${q(CHAPTERS)};
          for (var i = 0; i < chapters.length; i++) {
            openChapter(chapters[i]);
            await __sleep(50);
            out.overflow[chapters[i]] = document.documentElement.scrollWidth - window.innerWidth;
          }
          return out;
        })()`,
      }));
      const results = runPhases(fixtures.VALID_SPEC, phases);
      WIDTHS.forEach((width, index) => {
        const raw = results[index];
        assert.ok(raw, `no chapter overflow observations at ${width}px`);
        assert.strictEqual(raw.innerWidth, width, `Emulation override not applied at ${width}px`);
        CHAPTERS.forEach((chapter) => {
          assert.ok(
            raw.overflow[chapter] <= 0,
            `${chapter} caused horizontal page scroll at ${width}px (overflow=${raw.overflow[chapter]})`
          );
        });
      });
    },
  ],

  [
    '1c: trust strip pills equal the trust model for every example',
    () => {
      ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow'].forEach((name) => {
        const [phase] = runPhases(`examples/${name}/architecture.json`, [{ width: 1440, height: 900, steps: [ev(`JSON.stringify({
          pills: [...document.querySelectorAll('.trust-pill')].map((p) => [p.dataset.trust, p.dataset.state, p.textContent.trim()]),
          model: (function () { const t = trustSummary(ARCH_SPEC, QUALITY_GATE); return ['grounding', 'evidence', 'rules', 'openItems'].map((k) => [k, t[k].state, t[k].label]); })(),
        })`)] }]);
        const { pills, model } = JSON.parse(lastEvalValue(phase));
        assert.deepStrictEqual(pills, model, `${name}: the strip must say exactly what the trust model says`);
      });
    },
  ],

  [
    '1c: trust strip pills open their chapter, docked at 1440 and as a drawer at 900',
    () => {
      const CLICK = ev(`(async function () {
        ${PAGE_HELPERS}
        window.__obs = {};
        __click(__q('.trust-pill[data-trust="openItems"]'));
        // Wait for the outcome, not a fixed time: under load the drawer animation can run long.
        await __waitFor(function () { return state.chapter === 'review' && __open('rail') === 'true'; }, 3000);
        __record('chapter', state.chapter);
        __record('railOpen', __open('rail'));
        __record('tabSelected', __q('#chapter-tab-review').getAttribute('aria-selected'));
        return __observed();
      })()`);
      [1440, 900].forEach((width) => {
        const obs = lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width, height: 900, steps: [CLICK] }])[0]);
        assert.deepStrictEqual([obs.chapter, obs.railOpen, obs.tabSelected], ['review', 'true', 'true'], `${width}: ${JSON.stringify(obs)}`);
      });
    },
  ],

  [
    '1c: header and trust strip stay within 104px with at most 7 persistent controls at 1440',
    () => {
      const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`JSON.stringify({
        bottom: document.querySelector('.trust-strip').getBoundingClientRect().bottom,
        canvasTop: document.getElementById('canvas-container').getBoundingClientRect().top,
        controls: [...document.querySelector('.header-actions').children, document.querySelector('.lens-switcher')]
          .filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0).map((el) => el.id || el.className),
      })`)] }]);
      const probe = JSON.parse(lastEvalValue(phase));
      assert.ok(probe.bottom <= 104, `header and trust strip take ${probe.bottom}px`);
      assert.ok(Math.abs(probe.canvasTop - probe.bottom) <= 1, `the canvas should start right under the strip (${probe.canvasTop} vs ${probe.bottom})`);
      assert.ok(probe.controls.length <= 7, `${probe.controls.length} persistent controls: ${probe.controls.join(', ')}`);
    },
  ],

  [
    '1c: the Copy link button copies the current view and says so',
    () => {
      const obs = lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, steps: [ev(`(async function () {
        ${PAGE_HELPERS}
        window.__obs = {};
        var copied = null;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (text) { copied = text; return Promise.resolve(); } } });
        openInspectorForNode('api');
        __click(__q('#btn-copy-link'));
        await __sleep(200);
        __record('copied', copied);
        __record('status', document.getElementById('workbench-status').textContent);
        return __observed();
      })()`)] }])[0]);
      assert.ok(/#v=2/.test(obs.copied) && /[#&]n=api(&|$)/.test(obs.copied), `copied ${obs.copied}`);
      assert.strictEqual(obs.status, 'Link copied.');
    },
  ],

  [
    '1f: every lens works during a walkthrough, including Change, without ending it',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(async function () {
        startWalkthrough('scenario_fulfillment_saga_dlq');
        walkTo('stage_publish_order_created');
        const out = [];
        for (const lens of ['change', 'risk', 'evidence', 'structure']) {
          selectLens(lens, { explicit: true });
          await new Promise((resolve) => setTimeout(resolve, 120));
          out.push([lens, state.scenarioActive, state.walkCursor, !!document.querySelector('.walk-track:not([hidden])'),
            [...document.querySelectorAll('.edge-path.highlighted')].map((p) => p.id).sort().join(',')]);
        }
        return JSON.stringify(out);
      })()`)] }])[0]));
      obs.forEach(([lens, active, cursor, track, lit]) => {
        assert.strictEqual(active, true, `${lens}: the walkthrough ended`);
        assert.strictEqual(cursor, 'stage_publish_order_created', `${lens}: the cursor moved`);
        assert.ok(track, `${lens}: the track disappeared`);
        assert.strictEqual(lit, 'path-e_poller_kafka', `${lens}: the step's spotlight changed`);
      });
    },
  ],

  [
    'p4: perf large fixture boots with a ready time and the full model rendered',
    () => {
      const [phase] = runPhases(fixtures.LARGE_SPEC, [{ width: 1440, height: 900, steps: [ev(`JSON.stringify({
        ready: document.body.getAttribute('data-ready-ms'),
        nodes: document.querySelectorAll('.node-group').length,
        edges: document.querySelectorAll('.edge-path').length,
        errors: window.__errors || [],
      })`)] }]);
      const obs = JSON.parse(lastEvalValue(phase));
      assert.deepStrictEqual(obs.errors, [], `console errors detected: ${JSON.stringify(obs.errors)}`);
      assert.ok(obs.ready != null, 'body[data-ready-ms] must be set once the workbench has booted');
      assert.ok(Number(obs.ready) >= 0, `body[data-ready-ms] must be a number, got ${obs.ready}`);
      assert.strictEqual(obs.nodes, fixtures.LARGE_SPEC.nodes.length, 'every component of the large fixture must render');
      assert.strictEqual(obs.edges, fixtures.LARGE_SPEC.edges.length, 'every edge of the large fixture must render');
      console.log(`  p4: large fixture ready in ${obs.ready}ms (${obs.nodes} nodes, ${obs.edges} edges)`);
    },
  ],

  [
    'p4: perf walkthrough and lens changes stay under 100ms on the large fixture',
    () => {
      const MEASURE = ev(`(async function () {
        ${PAGE_HELPERS}
        function frame() {
          return new Promise(function (resolve) {
            requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
          });
        }
        function median(values) {
          var sorted = values.slice().sort(function (a, b) { return a - b; });
          var mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        }

        // Lens switches while the walkthrough is idle, cycling Structure -> Evidence -> Change -> Risk.
        var order = ['structure', 'evidence', 'change', 'risk'];
        selectLens('structure', { explicit: true });
        await frame();
        var lensTimes = [];
        for (var i = 0; i < 8; i += 1) {
          var lens = order[(i + 1) % order.length];
          var lensStart = performance.now();
          selectLens(lens, { explicit: true });
          await frame();
          lensTimes.push(performance.now() - lensStart);
        }

        // Ten walkthrough step changes on the 20-stage scenario.
        startWalkthrough('scenario_large');
        await frame();
        var stepTimes = [];
        for (var j = 0; j < 10; j += 1) {
          var stepStart = performance.now();
          walkNext();
          await frame();
          stepTimes.push(performance.now() - stepStart);
        }
        deactivateScenario();

        return JSON.stringify({
          stepMedian: median(stepTimes),
          lensMedian: median(lensTimes),
          stepTimes: stepTimes,
          lensTimes: lensTimes,
        });
      })()`);
      const [phase] = runPhases(fixtures.LARGE_SPEC, [{ width: 1440, height: 900, steps: [MEASURE] }]);
      const obs = JSON.parse(lastEvalValue(phase));
      console.log(`  p4: large fixture medians — step change ${obs.stepMedian.toFixed(1)}ms, lens change ${obs.lensMedian.toFixed(1)}ms`);
      assert.ok(obs.stepMedian < 100, `median walkthrough step change ${obs.stepMedian.toFixed(1)}ms must be under 100ms: ${JSON.stringify(obs.stepTimes)}`);
      assert.ok(obs.lensMedian < 100, `median lens change ${obs.lensMedian.toFixed(1)}ms must be under 100ms: ${JSON.stringify(obs.lensTimes)}`);
    },
  ],

  [
    'p4: shortcuts sheet opens, closes with focus restore, works from palette, and fits 320px',
    () => {
      const phase = runPhases(fixtures.VALID_SPEC, [{ width: 320, height: 800, steps: [
        ev(`window.__shortcutOrigin = document.querySelector('#btn-palette'); window.__shortcutOrigin.focus(); 0`),
        key('?', { code: 'Slash', modifiers: 8 }),
        ev(`({ open: !document.querySelector('#shortcuts-scrim').hidden, focused: document.activeElement.id,
          role: document.querySelector('#shortcuts-dialog').getAttribute('role'), title: document.querySelector('#shortcuts-title').textContent,
          keys: [...document.querySelectorAll('.shortcuts-table kbd')].map(el => el.textContent),
          overflow: document.documentElement.scrollWidth > innerWidth })`),
        ESCAPE(),
        ev(`({ closed: document.querySelector('#shortcuts-scrim').hidden, restored: document.activeElement === window.__shortcutOrigin })`),
        ev(`openPalette(document.querySelector('#btn-palette')); paletteFilter('Keyboard shortcuts'); paletteSetActive(0); paletteRunActive();
          ({ paletteOpened: !document.querySelector('#shortcuts-scrim').hidden, focused: document.activeElement.id })`),
      ] }])[0];
      const results = phase.filter(step => step.kind === 'eval').map(step => step.value);
      assert.ok(results[1].open && results[1].focused === 'shortcuts-dialog', 'question mark did not focus the dialog');
      assert.strictEqual(results[1].role, 'dialog');
      assert.strictEqual(results[1].title, 'Keyboard shortcuts');
      ['⌘K', '1', 'j', 'F', 'Esc'].forEach(value => assert.ok(results[1].keys.includes(value), `missing ${value}`));
      assert.strictEqual(results[1].overflow, false, 'page scrolls horizontally at 320px');
      assert.ok(results[2].closed && results[2].restored, 'Escape did not close and restore focus');
      assert.ok(results[3].paletteOpened, 'palette command did not open the sheet');
    },
  ],
];

module.exports = { name: 'Rendered DOM Verification', cases };
