const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compileArchitecture } = require('../src/engine/compiler.js');
const fixtures = require('./fixtures.js');

const REGION_NAMES = ['topbar', 'navigator', 'canvas', 'inspector'];
const CAMERA_CONTROL_SELECTORS = ['#btn-zoom-in', '#btn-zoom-out', '#btn-fit', '#btn-reset'];
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

function runPhases(specRelOrSpec, phases, timeoutMs) {
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
      preload: ERROR_PRELOAD,
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

    const targetBox = nodeMap.get(e.target);
    if (targetBox) {
      let gap;
      const px = e.endPt.x;
      const py = e.endPt.y;
      if (px >= targetBox.left && px <= targetBox.right && py >= targetBox.top && py <= targetBox.bottom) {
        gap = -Math.min(px - targetBox.left, targetBox.right - px, py - targetBox.top, targetBox.bottom - py);
      } else {
        const dx = Math.max(targetBox.left - px, 0, px - targetBox.right);
        const dy = Math.max(targetBox.top - py, 0, py - targetBox.bottom);
        gap = Math.hypot(dx, dy);
      }
      assert.ok(gap >= 8 && gap <= 16, `endpoint gap ${gap.toFixed(2)}px not between 8px and 16px on edge ${e.id} arriving at ${e.target} in ${specRel}`);
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
  const inspectorToggle = '[data-action="inspector-toggle"]';
  const steps = [];

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('navigatorToggle', !!__q(${q(navigatorToggle)}));
      __record('inspectorToggle', !!__q(${q(inspectorToggle)}));
      __record('navigatorInitialOpen', __open('navigator'));
      __record('inspectorInitialOpen', __open('inspector'));
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
      __click(__q(${q(inspectorToggle)}));
      await __sleep(100);
      __record('inspectorOpen', __open('inspector'));
      __record('inspectorVisible', __visible(__region('inspector')));
      __record('inspectorFocusOnOpen', __inside(__region('inspector')));
      var tabbables = __tabbables(__region('inspector'));
      __record('inspectorTabbableCount', tabbables.length);
      var last = tabbables[tabbables.length - 1];
      var first = tabbables[0];
      if (last) last.focus();
      __record('inspectorLastTabbableFocused', !!last && document.activeElement === last);
      if (first) first.focus();
      __record('inspectorFirstTabbableFocused', !!first && document.activeElement === first);
      return __observed();
    })()`)
  );

  steps.push(TAB());
  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(60);
      __record('inspectorForwardWrappedInside', __inside(__region('inspector')));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      var tabbables = __tabbables(__region('inspector'));
      var first = tabbables[0];
      if (first) first.focus();
      __record('inspectorFirstRefocused', !!first && document.activeElement === first);
      return __observed();
    })()`)
  );

  steps.push(SHIFT_TAB());
  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      await __sleep(60);
      __record('inspectorBackwardWrappedInside', __inside(__region('inspector')));
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
      __record('inspectorAfterBackdropOpen', __open('inspector'));
      __record('backdropFocusRestored', document.activeElement === __q(${q(inspectorToggle)}));
      return __observed();
    })()`)
  );

  steps.push(
    ev(`(async function () {
      ${PAGE_HELPERS}
      __click(__q(${q(inspectorToggle)}));
      await __sleep(100);
      var close = __q('[data-action="inspector-close"]');
      __record('inspectorCloseControl', !!close);
      __click(close);
      await __sleep(120);
      __record('inspectorAfterCloseOpen', __open('inspector'));
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
      __record('inspectorOpen', __open('inspector'));
      __record('inspectorKind', __region('inspector') ? __region('inspector').getAttribute('data-inspector-kind') : null);
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

function assertRegionLayout(raw, width) {
  assert.ok(raw, `no region observations returned at ${width}px`);

  REGION_NAMES.forEach((name) => {
    assert.ok(raw.present[name], `missing stable [data-region="${name}"] region at ${width}px`);
  });

  assert.strictEqual(raw.innerWidth, width, `Emulation override not applied: innerWidth=${raw.innerWidth}, expected ${width}`);

  if (width >= 768) {
    REGION_NAMES.forEach((name) => {
      assert.ok(raw.visible[name], `[data-region="${name}"] is not visibly rendered at ${width}px`);
    });
  } else {
    assert.ok(raw.visible.topbar, `topbar region not visible at ${width}px`);
    assert.ok(raw.visible.canvas, `canvas region not visible at ${width}px`);
    assert.ok(!raw.visible.navigator, `navigator region should be collapsed by default at ${width}px`);
    assert.ok(!raw.visible.inspector, `inspector region should be collapsed by default at ${width}px`);
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
  assert.ok(raw.inspectorToggle, 'missing [data-action="inspector-toggle"] control at 320px');

  assert.strictEqual(raw.navigatorInitialOpen, 'false', 'navigator drawer should start collapsed at 320px');
  assert.strictEqual(raw.inspectorInitialOpen, 'false', 'inspector drawer should start collapsed at 320px');

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

  assert.strictEqual(raw.inspectorOpen, 'true', 'inspector toggle did not open the drawer');
  assert.ok(raw.inspectorVisible, 'inspector drawer is not visibly rendered after opening');
  assert.ok(raw.inspectorFocusOnOpen, 'keyboard focus was not moved into the inspector drawer on open');
  assert.ok(raw.inspectorTabbableCount >= 2, `inspector drawer exposes ${raw.inspectorTabbableCount} tabbables, expected at least 2`);
  assert.ok(raw.inspectorLastTabbableFocused, 'could not focus the last tabbable in the inspector drawer');
  assert.ok(raw.inspectorFirstTabbableFocused, 'could not focus the first tabbable in the inspector drawer');
  assert.ok(raw.inspectorForwardWrappedInside, 'real Tab from the last inspector tabbable escaped the inspector drawer');
  assert.ok(raw.inspectorFirstRefocused, 'could not refocus the first tabbable in the inspector drawer');
  assert.ok(raw.inspectorBackwardWrappedInside, 'real Shift+Tab from the first inspector tabbable escaped the inspector drawer');

  assert.ok(raw.backdropPresent, 'missing [data-action="drawer-backdrop"] while the inspector drawer is open');
  assert.strictEqual(raw.inspectorAfterBackdropOpen, 'false', 'backdrop click did not dismiss the inspector drawer');
  assert.ok(raw.backdropFocusRestored, 'focus was not restored to the inspector toggle after backdrop dismissal');

  assert.ok(raw.inspectorCloseControl, 'missing [data-action="inspector-close"] control at 320px');
  assert.strictEqual(raw.inspectorAfterCloseOpen, 'false', 'inspector close control did not dismiss the drawer');

  assert.ok(raw.navigatorCloseControl, 'missing [data-action="navigator-close"] control at 320px');
  assert.strictEqual(raw.navigatorAfterCloseOpen, 'false', 'navigator close control did not dismiss the drawer');
}

function assertSearchActivation(raw, expectedKind, modelId) {
  assert.ok(raw, 'no search activation observations returned');
  assert.ok(raw.searchInputPresent, 'no search input rendered');
  assert.ok(raw.resultPresent, `no search result rendered for ${modelId}`);
  assert.ok(raw.resultFocused, `search result for ${modelId} is not keyboard focusable`);
  assert.ok(raw.selectionPresent, `real Enter on the search result for ${modelId} did not mark it data-selected="true"`);
  assert.strictEqual(raw.inspectorOpen, 'true', `activating search result for ${modelId} did not open the inspector`);
  assert.strictEqual(raw.inspectorKind, expectedKind, `inspector is not in the ${expectedKind} state after activating ${modelId}`);
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
    'B2a: topbar, navigator, canvas and inspector render without overlap at 320, 768 and 1440',
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
    'B2a: at 320 the navigator and inspector drawers trap focus, dismiss and restore focus',
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
    'B2a: minimap marks and viewport rectangle react to real zoom, canvas pan and minimap click',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 1440, height: 900, mobile: false, steps: minimapSteps() }]);
      assertMinimapBehavior(lastEvalValue(results[0]));
    },
  ],
];

module.exports = { name: 'Rendered DOM Verification', cases };
