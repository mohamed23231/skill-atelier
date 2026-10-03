const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileArchitecture } = require('../src/engine/compiler.js');
const geometry = require('../src/engine/geometry.js');
const { loadTemplate } = require('../src/workbench/assemble.js');
const fixtures = require('./fixtures.js');

const REGION_NAMES = ['topbar', 'navigator', 'canvas', 'rail'];
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
    html = compileArchitecture(JSON.parse(fs.readFileSync(specPath, 'utf8'))).html;
  } else {
    html = compileArchitecture(specRelOrSpec).html;
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
  const navigatorToggle = '[data-action="navigator-toggle"]';
  const railToggle = '[data-action="rail-toggle"]';
  const steps = [];

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('navigatorToggle', !!__q(${q(navigatorToggle)}));
      __record('railToggle', !!__q(${q(railToggle)}));
      __record('navigatorInitialOpen', __open('navigator'));
      __record('railInitialOpen', __open('rail'));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q(${q(navigatorToggle)}));
      await __sleep(100);
      __record('navigatorOpen', __open('navigator'));
      __record('navigatorVisible', __visible(__region('navigator')));
      __record('navigatorFocusOnOpen', __inside(__region('navigator')));
      var tabbables = __tabbables(__region('navigator'));
      __record('navigatorTabbableCount', tabbables.length);
      var last = tabbables[tabbables.length - 1];
      var first = tabbables[0];
      if (last) last.focus();
      __record('navigatorLastTabbableFocused', !!last && document.activeElement === last);
      if (first) first.focus();
      __record('navigatorFirstTabbableFocused', !!first && document.activeElement === first);
      return __observed();
    })()`)
  );

  steps.push(TAB());
  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(60);
      __record('navigatorForwardWrappedInside', __inside(__region('navigator')));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      var tabbables = __tabbables(__region('navigator'));
      var first = tabbables[0];
      if (first) first.focus();
      __record('navigatorFirstRefocused', !!first && document.activeElement === first);
      return __observed();
    })()`)
  );

  steps.push(SHIFT_TAB());
  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(60);
      __record('navigatorBackwardWrappedInside', __inside(__region('navigator')));
      return __observed();
    })()`)
  );

  steps.push(ESCAPE());
  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(120);
      __record('navigatorAfterEscapeOpen', __open('navigator'));
      __record('navigatorEscapeFocusRestored', document.activeElement === __q(${q(navigatorToggle)}));
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

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q(${q(navigatorToggle)}));
      await __sleep(100);
      var close = __q('[data-action="navigator-close"]');
      __record('navigatorCloseControl', !!close);
      __click(close);
      await __sleep(120);
      __record('navigatorAfterCloseOpen', __open('navigator'));
      return __observed();
    })()`)
  );

  return steps;
}

function searchSteps(label, modelId, selectedSelector, expectedKind) {
  const resultSelector = `[data-search-result][data-model-id=${q(modelId)}]`;
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('expectedKind', ${q(expectedKind)});
      var toggle = __q('[data-action="navigator-toggle"]');
      if (toggle && __open('navigator') !== 'true') {
        __click(toggle);
        await __sleep(120);
      }
      __record('navigatorOpen', __open('navigator'));
      var input = __q('[data-action="search-input"]') || document.getElementById('search-box');
      __record('searchInputPresent', !!input);
      __record('transformBefore', __transform());
      __input(input, ${q(label)});
      var result = await __waitFor(function () { return __q(${q(resultSelector)}); }, 2500);
      __record('resultPresent', !!result);
      if (result && typeof result.focus === 'function') result.focus();
      __record('resultFocused', !!result && document.activeElement === result);
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

function tabletNavigatorOverlaySteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('innerWidth', window.innerWidth);
      __record('docScrollWidthInitial', document.documentElement.scrollWidth);
      __record('navigatorInitialOpen', __open('navigator'));
      __record('navigatorInitialVisible', __visible(__region('navigator')));
      __record('canvasWidthInitial', __rect(__region('canvas')).width);
      __click(__q('[data-action="navigator-toggle"]'));
      await __sleep(320);
      __record('navigatorOpenAfterToggle', __open('navigator'));
      __record('navigatorVisibleAfterToggle', __visible(__region('navigator')));
      __record('navigatorRectOpen', __rect(__region('navigator')));
      __record('canvasRectOpen', __rect(__region('canvas')));
      __record('canvasWidthOpen', __rect(__region('canvas')).width);
      __record('docScrollWidthOpen', document.documentElement.scrollWidth);
      return __observed();
    })()`),
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q('[data-action="navigator-close"]'));
      await __sleep(320);
      __record('navigatorOpenAfterClose', __open('navigator'));
      __record('navigatorVisibleAfterClose', __visible(__region('navigator')));
      __record('navigatorRectAfterClose', __rect(__region('navigator')));
      __record('canvasRectAfterClose', __rect(__region('canvas')));
      __record('canvasWidthAfterClose', __rect(__region('canvas')).width);
      __record('docScrollWidthAfterClose', document.documentElement.scrollWidth);
      return __observed();
    })()`),
  ];
}

function longNavigatorTextSteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      var body = __q('.workbench-panel-body');
      var evidence = __qa('[data-review-kind="evidence"]');
      __record('evidenceCount', evidence.length);
      __record('evidenceTextLength', evidence.length ? evidence[0].textContent.length : 0);
      __record('innerWidth', window.innerWidth);
      __record('docScrollWidth', document.documentElement.scrollWidth);
      __record('bodyScrollWidth', body ? body.scrollWidth : null);
      __record('bodyClientWidth', body ? body.clientWidth : null);
      __record('bodyOverflowX', body ? window.getComputedStyle(body).overflowX : null);
      __record('navigatorRect', __rect(__region('navigator')));
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

function assertTabletNavigatorOverlay(raw) {
  assert.ok(raw, 'no tablet navigator observations returned');
  assert.strictEqual(raw.innerWidth, 900, `Emulation override not applied: innerWidth=${raw.innerWidth}, expected 900`);
  assert.strictEqual(raw.navigatorInitialOpen, 'false', 'navigator should start closed at 900px');
  assert.strictEqual(raw.navigatorInitialVisible, false, 'navigator should not be visible at 900px before opening');

  assert.strictEqual(raw.navigatorOpenAfterToggle, 'true', 'navigator header toggle did not open the overlay');
  assert.ok(raw.navigatorVisibleAfterToggle, 'navigator overlay is not visible after opening');
  assert.ok(
    rectsOverlap(raw.navigatorRectOpen, raw.canvasRectOpen),
    'navigator should overlay the canvas at 900px'
  );
  assert.ok(
    Math.abs(raw.canvasWidthOpen - raw.canvasWidthInitial) <= 1,
    `overlay navigator permanently shrank the canvas (initial=${raw.canvasWidthInitial}, open=${raw.canvasWidthOpen})`
  );

  assert.strictEqual(raw.navigatorOpenAfterClose, 'false', 'navigator close control did not dismiss the overlay');
  assert.strictEqual(raw.navigatorVisibleAfterClose, false, 'navigator overlay is still visible after dismissal');
  assert.ok(
    Math.abs(raw.canvasWidthAfterClose - raw.canvasWidthInitial) <= 1,
    `canvas width changed after overlay dismissal (initial=${raw.canvasWidthInitial}, after=${raw.canvasWidthAfterClose})`
  );
  assert.ok(
    !rectsOverlap(raw.navigatorRectAfterClose, raw.canvasRectAfterClose),
    'dismissed navigator overlay still overlaps the canvas'
  );
  assert.ok(
    raw.docScrollWidthInitial <= raw.innerWidth + 1 && raw.docScrollWidthOpen <= raw.innerWidth + 1 &&
      raw.docScrollWidthAfterClose <= raw.innerWidth + 1,
    `navigator caused horizontal page overflow (initial=${raw.docScrollWidthInitial}, open=${raw.docScrollWidthOpen}, after=${raw.docScrollWidthAfterClose}, viewport=${raw.innerWidth})`
  );
}

function assertLongNavigatorText(raw) {
  assert.ok(raw, 'no long navigator text observations returned');
  assert.ok(raw.evidenceCount >= 1, 'long evidence record was not rendered in the navigator');
  assert.ok(raw.evidenceTextLength > 200, `evidence text was truncated too early (length=${raw.evidenceTextLength})`);
  assert.ok(raw.navigatorRect && raw.navigatorRect.width > 0.5, 'navigator has no rendered size');
  assert.ok(
    raw.docScrollWidth <= raw.innerWidth + 1,
    `long navigator text overflowed the page horizontally (scrollWidth=${raw.docScrollWidth}, viewport=${raw.innerWidth})`
  );
  assert.ok(
    raw.bodyScrollWidth <= raw.bodyClientWidth + 1,
    `navigator body is horizontally scrollable (scrollWidth=${raw.bodyScrollWidth}, clientWidth=${raw.bodyClientWidth})`
  );
  assert.strictEqual(raw.bodyOverflowX, 'hidden', `navigator body overflow-x should be hidden, got ${raw.bodyOverflowX}`);
}

function assertRegionLayout(raw, width) {
  assert.ok(raw, `no region observations returned at ${width}px`);

  REGION_NAMES.forEach((name) => {
    assert.ok(raw.present[name], `missing stable [data-region="${name}"] region at ${width}px`);
  });

  assert.strictEqual(raw.innerWidth, width, `Emulation override not applied: innerWidth=${raw.innerWidth}, expected ${width}`);

  assert.ok(raw.visible.topbar, `topbar region not visible at ${width}px`);
  assert.ok(raw.visible.canvas, `canvas region not visible at ${width}px`);
  if (width >= PANEL_BREAKPOINT) {
    assert.ok(raw.visible.navigator, `navigator should be docked open by default at ${width}px`);
    assert.ok(raw.visible.rail, `rail should be docked open by default at ${width}px`);
    const expectedRailWidth = width >= 1280 ? 400 : 340;
    assert.ok(
      Math.abs(raw.rects.rail.width - expectedRailWidth) <= 1,
      `rail width should be ${expectedRailWidth}px at ${width}px, got ${raw.rects.rail.width}`
    );
    const expectedCanvasWidth = width - 240 - expectedRailWidth;
    assert.ok(
      Math.abs(raw.rects.canvas.width - expectedCanvasWidth) <= 1,
      `canvas width should be ${expectedCanvasWidth}px at ${width}px, got ${raw.rects.canvas.width}`
    );
  } else {
    assert.ok(!raw.visible.navigator, `navigator region should be collapsed by default at ${width}px`);
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
  assert.ok(raw.navigatorToggle, 'missing [data-action="navigator-toggle"] control at 320px');
  assert.ok(raw.railToggle, 'missing [data-action="rail-toggle"] control at 320px');

  assert.strictEqual(raw.navigatorInitialOpen, 'false', 'navigator drawer should start collapsed at 320px');
  assert.strictEqual(raw.railInitialOpen, 'false', 'rail drawer should start collapsed at 320px');

  assert.strictEqual(raw.navigatorOpen, 'true', 'navigator toggle did not open the drawer');
  assert.ok(raw.navigatorVisible, 'navigator drawer is not visibly rendered after opening');
  assert.ok(raw.navigatorFocusOnOpen, 'keyboard focus was not moved into the navigator drawer on open');
  assert.ok(raw.navigatorTabbableCount >= 2, `navigator drawer exposes ${raw.navigatorTabbableCount} tabbables, expected at least 2`);
  assert.ok(raw.navigatorLastTabbableFocused, 'could not focus the last tabbable in the navigator drawer');
  assert.ok(raw.navigatorFirstTabbableFocused, 'could not focus the first tabbable in the navigator drawer');
  assert.ok(raw.navigatorForwardWrappedInside, 'real Tab from the last navigator tabbable escaped the navigator drawer');
  assert.ok(raw.navigatorFirstRefocused, 'could not refocus the first tabbable in the navigator drawer');
  assert.ok(raw.navigatorBackwardWrappedInside, 'real Shift+Tab from the first navigator tabbable escaped the navigator drawer');

  assert.strictEqual(raw.navigatorAfterEscapeOpen, 'false', 'real Escape did not dismiss the navigator drawer');
  assert.ok(raw.navigatorEscapeFocusRestored, 'focus was not restored to the navigator toggle after real Escape');

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

  assert.ok(raw.navigatorCloseControl, 'missing [data-action="navigator-close"] control at 320px');
  assert.strictEqual(raw.navigatorAfterCloseOpen, 'false', 'navigator close control did not dismiss the drawer');
}

function assertSearchActivation(raw, expectedKind, modelId) {
  assert.ok(raw, 'no search activation observations returned');
  assert.ok(raw.searchInputPresent, 'no search input rendered');
  assert.ok(raw.resultPresent, `no search result rendered for ${modelId}`);
  assert.ok(raw.resultFocused, `search result for ${modelId} is not keyboard focusable`);
  assert.ok(raw.selectionPresent, `real Enter on the search result for ${modelId} did not mark it data-selected="true"`);
  assert.strictEqual(raw.railOpen, 'true', `activating search result for ${modelId} did not open the rail`);
  assert.strictEqual(raw.railSheet, expectedKind, `rail is not in the ${expectedKind} sheet state after activating ${modelId}`);
  assert.notStrictEqual(raw.transformAfter, raw.transformBefore, `camera transform did not change after activating search result for ${modelId}`);
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

function tabsBarSteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      var tabs = __q('.tabs-section');
      __record('tabsPresent', !!tabs);
      __record('tabCount', __qa('.tabs-section .tab-btn').length);
      __record('togglePresent', !!__q('[data-action="tabs-minimize"]'));
      __record('initialMinimized', tabs ? tabs.getAttribute('data-minimized') : null);
      __record('overflowing', tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : null);
      __record('scrollLeftBefore', tabs ? tabs.scrollLeft : null);
      if (tabs) {
        tabs.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 240, deltaX: 0 }));
      }
      await __sleep(60);
      __record('scrollLeftAfterWheel', tabs ? tabs.scrollLeft : null);
      return __observed();
    })()`),
    ev(`(async function () {
      ${PAGE_HELPERS}
      var tabs = __q('.tabs-section');
      __click(__q('[data-action="tabs-minimize"]'));
      await __sleep(80);
      __record('minimizedAfterClick', tabs ? tabs.getAttribute('data-minimized') : null);
      var visibleTabs = __qa('.tabs-section .tab-btn').filter(function (el) {
        var r = el.getBoundingClientRect();
        return r.width > 0.5 && r.height > 0.5;
      });
      __record('visibleTabsWhenMinimized', visibleTabs.length);
      __record('visibleTabIsActive', visibleTabs.length === 1 && visibleTabs[0].classList.contains('active'));
      __record('togglePressed', __q('[data-action="tabs-minimize"]').getAttribute('aria-pressed'));
      return __observed();
    })()`),
    ev(`(async function () {
      ${PAGE_HELPERS}
      var tabs = __q('.tabs-section');
      __click(__q('[data-action="tabs-minimize"]'));
      await __sleep(80);
      __record('minimizedAfterSecondClick', tabs ? tabs.getAttribute('data-minimized') : null);
      var visibleTabs = __qa('.tabs-section .tab-btn').filter(function (el) {
        var r = el.getBoundingClientRect();
        return r.width > 0.5 && r.height > 0.5;
      });
      __record('visibleTabsWhenExpanded', visibleTabs.length);
      return __observed();
    })()`),
  ];
}

function assertTabsBarBehavior(raw) {
  assert.ok(raw, 'no tabs bar observations returned');
  assert.strictEqual(raw.tabsPresent, true, 'tabs section is missing');
  assert.strictEqual(raw.togglePresent, true, 'tabs minimize toggle is missing');
  assert.ok(raw.tabCount >= 4, `expected at least 4 view tabs, found ${raw.tabCount}`);
  assert.strictEqual(raw.initialMinimized, 'false', 'tabs should start expanded');
  assert.strictEqual(raw.overflowing, true, 'test setup invalid: tabs bar is not overflowing at 768px');
  assert.ok(
    raw.scrollLeftAfterWheel > raw.scrollLeftBefore,
    `vertical mouse wheel did not scroll the tabs bar (before=${raw.scrollLeftBefore}, after=${raw.scrollLeftAfterWheel})`
  );
  assert.strictEqual(raw.minimizedAfterClick, 'true', 'minimize toggle did not collapse the tabs bar');
  assert.strictEqual(raw.visibleTabsWhenMinimized, 1, `minimized tabs bar should show only the active tab, found ${raw.visibleTabsWhenMinimized}`);
  assert.strictEqual(raw.visibleTabIsActive, true, 'the only visible tab after minimize is not the active view');
  assert.strictEqual(raw.togglePressed, 'true', 'minimize toggle aria-pressed was not updated');
  assert.strictEqual(raw.minimizedAfterSecondClick, 'false', 'minimize toggle did not expand the tabs bar again');
  assert.strictEqual(raw.visibleTabsWhenExpanded, raw.tabCount, `expanded tabs bar should show all ${raw.tabCount} tabs, found ${raw.visibleTabsWhenExpanded}`);
}

const cases = [
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
    'B2a: topbar, navigator, canvas and rail render without overlap at 320, 768 and 1440',
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
    'B2b: at 900 the navigator is an overlay, dismisses cleanly and never shrinks or overlaps the canvas',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 900, height: 900, mobile: false, steps: tabletNavigatorOverlaySteps() }]);
      assertTabletNavigatorOverlay(lastEvalValue(results[0]));
    },
  ],

  [
    'B2b: long navigator outline/evidence text wraps without horizontal page or panel scrolling',
    () => {
      const results = runPhases(longEvidenceSpec(), [{ width: 1440, height: 900, mobile: false, steps: longNavigatorTextSteps() }]);
      assertLongNavigatorText(lastEvalValue(results[0]));
    },
  ],

  [
    'B2a: at 320 the navigator and rail drawers trap focus, dismiss and restore focus',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 320, height: 800, mobile: false, steps: drawerSteps() }]);
      assertDrawerBehavior(lastEvalValue(results[0]));
    },
  ],

  [
    'B2a: real Enter on a node search row selects it, opens the inspector and moves the camera',
    () => {
      const steps = searchSteps('API Service', 'api', '#node-api[data-selected="true"]', 'node');
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      assertSearchActivation(lastEvalValue(results[0]), 'node', 'api');
    },
  ],

  [
    'B2a: real Enter on an edge search row selects it, opens the edge inspector and moves the camera',
    () => {
      const steps = searchSteps('SQL Write', 'e1', '#path-e1[data-selected="true"]', 'edge');
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps }]);
      assertSearchActivation(lastEvalValue(results[0]), 'edge', 'e1');
    },
  ],

  [
    'B2a: at 768 the overflowing tabs bar scrolls with the mouse wheel and minimizes to the active tab',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 768, height: 900, mobile: false, steps: tabsBarSteps() }]);
      assertTabsBarBehavior(lastEvalValue(results[0]));
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
    'Phase 0: a scenario stage spotlights its participants and edges on the canvas, names them, and Esc clears it',
    () => {
      const SNAPSHOT = `JSON.stringify({
        edges: [...document.querySelectorAll('.edge-path.highlighted')].map((p) => p.id).sort(),
        nodes: [...document.querySelectorAll('.node-group.selected')].map((n) => n.id).sort(),
        dimmed: document.querySelectorAll('.edge-path.dimmed').length,
        text: (document.querySelector('[data-scenario-stage]') || {}).innerText || '',
        hash: location.hash,
      })`;
      const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{
        width: 1440,
        height: 900,
        steps: [ev(SNAPSHOT), ev(`stepScenario(3); ${SNAPSHOT}`), ev(`stepScenario(1); ${SNAPSHOT}`), ESCAPE(), ev(SNAPSHOT)],
      }]);
      const [idle, single, parallel, cleared] = results[0].filter((step) => step.kind === 'eval').map((step) => JSON.parse(step.value));
      assert.deepStrictEqual(idle.edges, [], 'canvas must not open mid-walkthrough');
      assert.deepStrictEqual(single.edges, ['path-e_poller_kafka']);
      assert.deepStrictEqual(single.nodes, ['node-kafka_broker', 'node-outbox_poller']);
      assert.ok(single.dimmed > 0, 'non-participating edges should dim');
      assert.ok(/Publish to Kafka Event Bus/.test(single.text) && /Outbox Relay Worker/.test(single.text), single.text);
      assert.ok(!/stage_publish_order_created|outbox_poller/.test(single.text), `raw ids leaked into the stage panel: ${single.text}`);
      assert.ok(/[#&]s=scenario_fulfillment_saga_dlq&at=stage_publish_order_created(&|$)/.test(single.hash), single.hash);
      assert.ok(!/cam=/.test(single.hash), `a link to a stage carries no camera: ${single.hash}`);
      assert.strictEqual(parallel.edges.length, 4, `parallel stage should light every branch: ${parallel.edges}`);
      assert.deepStrictEqual([cleared.edges.length, cleared.dimmed], [0, 0], 'Esc should end the walkthrough spotlight');
      assert.ok(!/[#&]s=/.test(cleared.hash), cleared.hash);
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
        const sel = ['.filter-bar', '#delta-bar', '#sequence-bar', '.legend-box', '.workbench-minimap', '.viewport-controls', '[data-region=navigator]', '#rail'];
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
        ev("closeInspector(); switchView('before_after'); 0"), settle, OVERLAPS,
        ev("switchView('architecture'); document.getElementById('btn-gate').click(); 0"), settle, OVERLAPS,
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
      }]);
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
        // The view tabs scroll inside their own bar (covered by the tabs-bar test), so they are clipped there, not by the page.
        const controls = [...document.querySelectorAll('header button')].filter((b) => !b.closest('.tabs-section') && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0);
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
          var tabWalk = __q('#chapter-tab-walkthrough');
          if (tabWalk) tabWalk.focus();
          await __sleep(60);
          __record('initialFocus', document.activeElement === tabWalk);
          __record('initialWalkSelected', tabWalk ? tabWalk.getAttribute('aria-selected') : null);
          __record('initialWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
          __record('initialReviewHidden', __q('#chapter-review') ? __q('#chapter-review').hidden : null);
          return __observed();
        })()`),
        ARROW_RIGHT,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(60);
          var tabRev = __q('#chapter-tab-review');
          var tabWalk = __q('#chapter-tab-walkthrough');
          __record('afterRightFocus', document.activeElement === tabRev);
          __record('afterRightWalkSelected', tabWalk ? tabWalk.getAttribute('aria-selected') : null);
          __record('afterRightRevSelected', tabRev ? tabRev.getAttribute('aria-selected') : null);
          __record('afterRightWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
          __record('afterRightRevHidden', __q('#chapter-review') ? __q('#chapter-review').hidden : null);
          return __observed();
        })()`),
        ARROW_LEFT,
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(60);
          var tabWalk = __q('#chapter-tab-walkthrough');
          var tabRev = __q('#chapter-tab-review');
          __record('afterLeftFocus', document.activeElement === tabWalk);
          __record('afterLeftWalkSelected', tabWalk ? tabWalk.getAttribute('aria-selected') : null);
          __record('afterLeftRevSelected', tabRev ? tabRev.getAttribute('aria-selected') : null);
          __record('afterLeftWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
          __record('afterLeftRevHidden', __q('#chapter-review') ? __q('#chapter-review').hidden : null);
          return __observed();
        })()`),
      ];
      const results = runPhases('examples/2-complex-database-migration/architecture.json', [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.strictEqual(obs.initialFocus, true, 'Walkthrough tab should be focused initially');
      assert.strictEqual(obs.initialWalkSelected, 'true', 'Walkthrough tab should be selected initially');
      assert.strictEqual(obs.initialWalkHidden, false, 'Walkthrough panel should be visible initially');
      assert.strictEqual(obs.initialReviewHidden, true, 'Review panel should be hidden initially');
      assert.strictEqual(obs.afterRightFocus, true, 'ArrowRight should move focus to Review tab');
      assert.strictEqual(obs.afterRightWalkSelected, 'false', 'Walkthrough tab should not be selected after ArrowRight');
      assert.strictEqual(obs.afterRightRevSelected, 'true', 'Review tab should be selected after ArrowRight');
      assert.strictEqual(obs.afterRightWalkHidden, true, 'Walkthrough panel should be hidden after ArrowRight');
      assert.strictEqual(obs.afterRightRevHidden, false, 'Review panel should be visible after ArrowRight');
      assert.strictEqual(obs.afterLeftFocus, true, 'ArrowLeft should move focus back to Walkthrough tab');
      assert.strictEqual(obs.afterLeftWalkSelected, 'true', 'Walkthrough tab should be selected after ArrowLeft');
      assert.strictEqual(obs.afterLeftRevSelected, 'false', 'Review tab should not be selected after ArrowLeft');
      assert.strictEqual(obs.afterLeftWalkHidden, false, 'Walkthrough panel should be visible after ArrowLeft');
      assert.strictEqual(obs.afterLeftRevHidden, true, 'Review panel should be hidden after ArrowLeft');
    },
  ],

  [
    '1c: rail #btn-gate opens Review with the gate rows visible',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          window.__obs = {};
          var btnGate = __q('#btn-gate');
          __record('gateButtonPresent', !!btnGate);
          __record('gateState', btnGate ? btnGate.getAttribute('data-gate-state') : null);
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
      assert.strictEqual(obs.gateButtonPresent, true, '#btn-gate should be present in the header');
      assert.strictEqual(obs.railOpen, 'true', 'Rail should be open after clicking #btn-gate');
      assert.strictEqual(obs.chapterAfter, 'review', 'Active chapter should be review after clicking #btn-gate');
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
          __record('chapterWalkHidden', __q('#chapter-walkthrough') ? __q('#chapter-walkthrough').hidden : null);
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
      assert.strictEqual(obs.chapter, 'walkthrough', 'Should return to current chapter (walkthrough)');
      assert.strictEqual(obs.chapterWalkHidden, false, 'Walkthrough chapter should be visible');
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
    '1c: rail at 1440 the docked rail plus canvas fill the width with no overlap',
    () => {
      const steps = [
        ev(`(async function () {
          ${PAGE_HELPERS}
          await __sleep(300);
          window.__obs = {};
          var nav = __region('navigator');
          var canvas = __region('canvas');
          var rail = __region('rail');
          __record('navRect', __rect(nav));
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
      assert.ok(obs.scrollWidth <= 1440 + 1, `Page should not scroll horizontally (scrollWidth=${obs.scrollWidth}, innerWidth=${obs.innerWidth})`);
      assert.ok(Math.abs(obs.navRect.width - 240) <= 1, `Navigator width should be 240, got ${obs.navRect.width}`);
      assert.ok(Math.abs(obs.railRect.width - 400) <= 1, `Rail width should be 400 at 1440px, got ${obs.railRect.width}`);
      const expectedCanvasWidth = 1440 - 240 - 400;
      assert.ok(Math.abs(obs.canvasRect.width - expectedCanvasWidth) <= 1, `Canvas width should be ${expectedCanvasWidth}, got ${obs.canvasRect.width}`);
      assert.ok(obs.navRect.right <= obs.canvasRect.x + 1, 'Navigator should not overlap canvas on the left');
      assert.ok(obs.canvasRect.right <= obs.railRect.x + 1, 'Canvas should not overlap rail on the right');
      assert.ok(obs.railRect.right <= obs.innerWidth + 1, 'Rail should stay within viewport right boundary');
      assert.ok(!rectsOverlap(obs.navRect, obs.canvasRect), 'Navigator and canvas must not overlap');
      assert.ok(!rectsOverlap(obs.canvasRect, obs.railRect), 'Canvas and rail must not overlap');
      assert.ok(!rectsOverlap(obs.navRect, obs.railRect), 'Navigator and rail must not overlap');
    },
  ],
];

module.exports = { name: 'Rendered DOM Verification', cases };
