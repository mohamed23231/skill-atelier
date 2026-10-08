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
      if (fs.existsSync(file)) {
        var contents = fs.readFileSync(file, 'utf8');
        // Chrome creates the file before fully writing it. An empty or partial
        // file (no complete first line yet) means "not ready", not "invalid".
        var firstLine = contents.split('\n')[0].trim();
        if (firstLine && contents.indexOf('\n') !== -1) return contents;
      }
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
  if (step.action === 'move') {
    var target = await resolvePoint(session, step.selector, step.fx, step.fy, step.x, step.y);
    if (target) await dispatchMouse(session, 'mouseMoved', target, 'none', 0, 0);
    return;
  }
  if (step.action === 'jitter-click') {
    // A real hand's click: press, drift a couple of pixels, release.
    var at = await resolvePoint(session, step.selector, step.fx, step.fy, step.x, step.y);
    if (!at) return;
    await dispatchMouse(session, 'mouseMoved', at, 'none', 0, 0);
    await dispatchMouse(session, 'mousePressed', at, 'left', 1, 1);
    await dispatchMouse(session, 'mouseMoved', { x: at.x + 1, y: at.y + 1 }, 'left', 1, 0);
    await dispatchMouse(session, 'mouseMoved', { x: at.x + 2, y: at.y + 1 }, 'left', 1, 0);
    await dispatchMouse(session, 'mouseReleased', { x: at.x + 2, y: at.y + 1 }, 'left', 0, 1);
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

const LAUNCH_RETRY_LIMIT = 2;

const LAUNCH_FAILURE_PATTERNS = [
  /DevToolsActivePort/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /no debuggable page target appeared/,
  /failed to open DevTools websocket/,
];

function launchFailureReason(error) {
  const message = String((error && error.message) || error || '');
  const line = message.split('\n').map((part) => part.trim()).find(Boolean);
  return line || message.trim();
}

// Classify only transient Chrome launch/connection failures. Assertions and
// page script errors must always propagate unchanged so real regressions fail.
function isLaunchFailure(error) {
  if (error && (error.name === 'AssertionError' || error.code === 'ERR_ASSERTION')) return false;
  const message = String((error && error.message) || error || '');
  if (!message) return false;
  if (/AssertionError/.test(message)) return false;
  if (/page script failed/.test(message)) return false;
  if (LAUNCH_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return true;
  if (/timed out waiting for/i.test(message) && /(DevTools|CDP|page target|websocket)/i.test(message)) return true;
  return false;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runBrowser(config) {
  const maxAttempts = LAUNCH_RETRY_LIMIT + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
      let failure;
      if (errorMatch) {
        let message = errorMatch[1].trim();
        try {
          message = JSON.parse(message);
        } catch {}
        failure = new Error(message);
      } else {
        failure = new Error('browser worker failed: ' + (stderr || stdout || err.message));
      }

      if (attempt < maxAttempts && isLaunchFailure(failure)) {
        // The worker already killed its Chrome process tree and deleted the
        // temporary profile before exiting; let the OS settle, then relaunch.
        process.stderr.write(`[rendered] relaunching Chrome after: ${launchFailureReason(failure)}\n`);
        sleepSync(250);
        continue;
      }
      throw failure;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    const match = output.match(/__ARCH_VIZ_RESULT__([\s\S]*)/);
    assert.ok(match, 'browser worker produced no result payload');
    return JSON.parse(match[1].trim());
  }
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

function stackedRailSteps() {
  return [
    ev(`(async function () {
      ${PAGE_HELPERS}
      window.__obs = {};
      __record('railInitialOpen', __open('rail'));
      __record('toggleShown', getComputedStyle(__q('[data-action="rail-toggle"]')).display !== 'none');
      __record('closeShown', getComputedStyle(__q('[data-action="rail-close"]')).display !== 'none');
      __record('backdropPresent', !!__q('[data-action="drawer-backdrop"]'));
      __record('scrollBefore', window.scrollY);
      var rail = __region('rail').getBoundingClientRect(), canvas = __region('canvas').getBoundingClientRect();
      __record('railBelowCanvas', rail.top >= canvas.bottom - 1);
      __record('railFullWidth', Math.abs(rail.width - innerWidth) <= 1);
      openInspectorForNode('api');
      await __sleep(400);
      __record('scrollAfterSelect', window.scrollY);
      var sheet = __q('#component-sheet').getBoundingClientRect();
      __record('sheetInView', sheet.top < innerHeight && sheet.bottom > 0);
      __record('sheetBackPresent', !!__q('[data-action="sheet-back"]'));
      setDrawerOpen('rail', false);
      __record('railAfterCloseRequest', __open('rail'));
      __record('docScrollWidth', document.documentElement.scrollWidth);
      return __observed();
    })()`),
  ];
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
      await __sleep(600);
      __record('selectionPresent', !!__q(${q(selectedSelector)}));
      __record('railOpen', __open('rail'));
      __record('railSheet', __region('rail') ? __region('rail').getAttribute('data-sheet') : null);
      __record('transformAfter', __transform());
      __record('selectionInView', (function () { var t = __q(${q(selectedSelector)}); var c = __region('canvas'); if (!t || !c) return false; var a = t.getBoundingClientRect(), b = c.getBoundingClientRect(); return (a.width > 0 || a.height > 0) && a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; })());
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

function assertTabletRailStacked(raw) {
  assert.ok(raw, 'no tablet rail observations returned');
  assert.strictEqual(raw.innerWidth, 860, `Emulation override not applied: innerWidth=${raw.innerWidth}, expected 860`);
  assert.strictEqual(raw.railInitialOpen, 'true', 'the stacked rail starts open at 860px');
  [['railRectOpen', 'canvasRectOpen'], ['railRectAfterClose', 'canvasRectAfterClose']].forEach(([rail, canvas]) => {
    assert.ok(!rectsOverlap(raw[rail], raw[canvas]), `${rail} overlaps the canvas`);
    assert.ok(raw[rail].y >= raw[canvas].y + raw[canvas].height - 1, `${rail} is not below the canvas`);
  });
  assert.strictEqual(raw.railOpenAfterClose, 'true', 'the stacked rail stays open');
  assert.ok(Math.abs(raw.canvasWidthAfterClose - raw.canvasWidthInitial) <= 1 && Math.abs(raw.canvasWidthInitial - raw.innerWidth) <= 1,
    'the stacked canvas spans the page and keeps its width');
  assert.ok(
    raw.docScrollWidthInitial <= raw.innerWidth + 1 && raw.docScrollWidthOpen <= raw.innerWidth + 1 &&
      raw.docScrollWidthAfterClose <= raw.innerWidth + 1,
    `horizontal page overflow (initial=${raw.docScrollWidthInitial}, open=${raw.docScrollWidthOpen}, after=${raw.docScrollWidthAfterClose}, viewport=${raw.innerWidth})`
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
    const expectedRailWidth = width >= 1280 ? 400 : width >= 1100 ? 340 : 360;
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
  } else if (raw.rects.rail) {
    // Stacked: the rail is a page section under the canvas, as wide as the page.
    assert.ok(raw.rects.rail.y >= raw.rects.canvas.y + raw.rects.canvas.height - 1, `rail should sit below the canvas at ${width}px`);
    assert.ok(Math.abs(raw.rects.rail.width - width) <= 1, `stacked rail should span the page at ${width}px`);
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

function assertStackedRail(raw) {
  assert.ok(raw, 'no stacked rail observations returned');
  assert.strictEqual(raw.railInitialOpen, 'true', 'the stacked rail is open from the start at 320px');
  assert.strictEqual(raw.toggleShown, false, 'a stacked rail has nothing to toggle');
  assert.strictEqual(raw.closeShown, false, 'a stacked rail has nothing to close');
  assert.strictEqual(raw.backdropPresent, false, 'no drawer backdrop exists any more');
  assert.ok(raw.railBelowCanvas, 'the rail sits below the canvas');
  assert.ok(raw.railFullWidth, 'the stacked rail spans the page');
  assert.ok(raw.scrollAfterSelect > raw.scrollBefore, 'selecting a component scrolls its details into view');
  assert.ok(raw.sheetInView, 'the component sheet is on screen after selecting');
  assert.ok(raw.sheetBackPresent, 'missing [data-action="sheet-back"] when the sheet is open');
  assert.strictEqual(raw.railAfterCloseRequest, 'true', 'a stacked rail stays open');
  assert.ok(raw.docScrollWidth <= 321, `horizontal page overflow ${raw.docScrollWidth}`);
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
  // The camera brings the selection into view; when it already is (a small diagram), it may stay.
  assert.ok(raw.selectionInView, `palette result for ${modelId} is not in view after activating it`);
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
  ['p4: polish fit refines a narrow feasible zoom interval without losing overlay clearance', () => {
    const vm = require('node:vm');
    let camera;
    const context = vm.createContext({
      LAYOUT_DATA: { nodes: [{ x: 0, y: 0, width: 1000, height: 1000 }], boundaries: [], edges: [] },
      state: { collapsedBoundaries: new Set() },
      ArchVizGeometry: geometry,
      svg: { getBoundingClientRect: () => ({ width: 1000, height: 1000 }) },
      isNodeHidden: () => false,
      clampZoom: zoom => Math.max(0.15, Math.min(2, zoom)),
      actions: { setCamera: value => { camera = value; } },
      updateTransform: () => {},
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/fit.js'), 'utf8'), context);
    context.canvasOverlayRects = () => [{ left: -8, right: 1008, top: 768, bottom: 1008 }];
    context.fitToScreen();
    assert.ok(camera.zoom >= 0.752, `coarse search missed the feasible scale: ${camera.zoom}`);
    assert.ok(camera.panY >= 16 - 0.01, 'drawing leaves the top inset');
    assert.ok(camera.panY + 1000 * camera.zoom <= 768 + 0.01, 'drawing crosses overlay clearance');
    assert.ok(camera.panX >= 16 - 0.01 && camera.panX + 1000 * camera.zoom <= 984 + 0.01,
      'drawing leaves the horizontal insets');
  }],
  ['lanes render equal bands, wrapped gutter titles and counts without page overflow', () => {
    const spec = fixtures.clone(fixtures.VALID_SPEC);
    spec.boundaries[0].label = 'A boundary title long enough to wrap into two lines';
    const probe = riskRender(spec, `JSON.stringify((function () {
      const bands = [...document.querySelectorAll('.boundary-rect')];
      return { widths: bands.map(b => Number(b.getAttribute('width'))),
        titles: document.querySelectorAll('.boundary-header').length,
        lines: [...document.querySelectorAll('.boundary-header')].map(t => t.querySelectorAll('tspan').length),
        counts: [...document.querySelectorAll('.boundary-count')].map(t => t.textContent),
        expected: LAYOUT_DATA.boundaries.map(b => { const n = LAYOUT_DATA.nodes.filter(n => n.boundary === b.id).length; return n + ' component' + (n === 1 ? '' : 's'); }),
        overflow: document.documentElement.scrollWidth > innerWidth };
    })())`);
    assert(probe.widths.length > 0 && probe.widths.every(w => w === probe.widths[0]));
    assert.equal(probe.titles, probe.widths.length);
    assert(probe.lines.every(n => n >= 1 && n <= 3));
    assert(probe.lines.some(n => n >= 2));
    assert.deepStrictEqual(probe.counts, probe.expected);
    assert.equal(probe.overflow, false);
  }],
  ['viewer: the minimap hides while the whole diagram is in view and returns once part of it is not', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [
      ev(`document.querySelector('.workbench-minimap').getAttribute('data-idle') + ' ' + getComputedStyle(document.querySelector('.workbench-minimap')).visibility`),
      mouse({ action: 'click', selector: '#btn-zoom-in', fx: 0.5, fy: 0.5 }),
      mouse({ action: 'click', selector: '#btn-zoom-in', fx: 0.5, fy: 0.5 }),
      ev(`new Promise(r => setTimeout(() => r(document.querySelector('.workbench-minimap').getAttribute('data-idle') + ' ' + getComputedStyle(document.querySelector('.workbench-minimap')).visibility), 250))`)] }]);
    const values = phase.filter(step => step && step.kind === 'eval').map(step => step.value);
    assert.strictEqual(values[0], 'true hidden');
    assert.strictEqual(values[values.length - 1], 'false visible');
  }],
  ['viewer: data flow mode adds no floating banner over the canvas and announces itself', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [
      ev(`new Promise(r => { switchView(VIEWS.DATA_FLOW); setTimeout(() => r(JSON.stringify({ hint: !!document.getElementById('flow-hint'),
        view: state.currentView, status: document.getElementById('workbench-status').textContent })), 150); })`)] }]);
    const m = JSON.parse(lastEvalValue(phase));
    assert.strictEqual(m.hint, false);
    assert.strictEqual(m.view, 'data_flow');
    assert.ok(/Data flow/i.test(m.status), m.status);
  }],
  ['viewer: moving flow dots and walkthrough packets pass behind connection labels, never over their text', () => {
    const overLabel = `(x, y) => LAYOUT_DATA.edges.some(e => e.labelBounds && x > e.labelBounds.left && x < e.labelBounds.left + e.labelBounds.width && y > e.labelBounds.top && y < e.labelBounds.top + e.labelBounds.height)`;
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [
      ev(`new Promise(r => { switchView(VIEWS.DATA_FLOW); const over = ${overLabel}; let seen = 0, bad = 0;
        const t = setInterval(() => document.querySelectorAll('.flow-particle').forEach(c => { seen++; if (c.style.opacity !== '0' && over(+c.getAttribute('cx'), +c.getAttribute('cy'))) bad++; }), 25);
        setTimeout(() => { clearInterval(t); r(JSON.stringify({ seen, bad })); }, 1500); })`),
      ev(`new Promise(r => { switchView(VIEWS.ARCHITECTURE); startWalkthrough(); if (walkEntries()[state.walkCursor]?.kind !== "step") walkNext(); const over = ${overLabel}; let seen = 0, bad = 0;
        const t = setInterval(() => document.querySelectorAll('.walk-packet').forEach(g => { const m = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || ''); if (!m) return; seen++;
          if (g.style.opacity === '1' && over(+m[1], +m[2])) bad++; }), 25);
        setTimeout(() => { clearInterval(t); r(JSON.stringify({ seen, bad })); }, 1500); })`)] }]);
    const values = phase.filter(step => step && step.kind === 'eval').map(step => JSON.parse(step.value));
    values.forEach(v => { assert.ok(v.seen > 20, JSON.stringify(v)); assert.strictEqual(v.bad, 0, JSON.stringify(v)); });
  }],
  ['share: a keyboard-only reader walks every step of example 3 from the first to the outcome end', () => {
    const J = () => key('j', { code: 'KeyJ', windowsVirtualKeyCode: 74 });
    const steps = [ev(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), window.__visited = [], 0)`), J(),
      ev(`(window.__visited.push(state.walkCursor), walkEntries().length)`)];
    for (let i = 0; i < 16; i++) steps.push(J(), ev(`(window.__visited.push(state.walkCursor), 0)`));
    steps.push(ev(`JSON.stringify({ visited: [...new Set(window.__visited)], path: walkEntries().map(e => e.id), active: walkIsActive() })`));
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps }]);
    const m = JSON.parse(lastEvalValue(phase));
    assert.strictEqual(m.active, true);
    assert.ok(m.path.length >= 8, `path has ${m.path.length} entries`);
    assert.deepStrictEqual(m.visited, m.path, 'J did not visit every entry of the default path in order');
  }],
  ['share: example 3 makes no network request and logs no error through every lens, step and outcome', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(async function () {
      const problems = [];
      const origError = console.error;
      console.error = (...args) => { problems.push('console.error: ' + args.join(' ')); origError.apply(console, args); };
      window.addEventListener('unhandledrejection', e => problems.push('unhandled rejection: ' + String(e.reason)));
      const pause = ms => new Promise(r => setTimeout(r, ms));
      const scenario = (ARCH_SPEC.scenarios || [])[0];
      startWalkthrough(scenario.id);
      const decisions = walkEntries().filter(e => e.kind === 'decision');
      const outcomes = decisions.length ? (decisions[0].outcomes || decisions[0].branches || [0, 1]).length : 1;
      let visited = 0;
      for (let choice = 0; choice < Math.max(1, outcomes); choice++) {
        startWalkthrough(scenario.id, decisions.length ? { [decisions[0].id]: choice } : {});
        for (const entry of walkEntries()) { walkTo(entry.id); visited++; await pause(5); }
      }
      for (const lens of ['structure', 'evidence', 'change', 'risk']) { selectLens(lens); await pause(20); }
      toggleTheme(); await pause(20); toggleTheme();
      ['overview', 'walkthrough', 'changes', 'review', 'evidence'].forEach(id => openChapter(id));
      await pause(100);
      console.error = origError;
      const resources = performance.getEntriesByType('resource').map(r => r.name);
      return JSON.stringify({ problems: problems.concat((window.__errors || []).map(e => 'error: ' + e.msg)), resources, visited });
    })()`)] }]);
    const m = JSON.parse(lastEvalValue(phase));
    assert.ok(m.visited >= 10, `visited only ${m.visited} entries`);
    assert.deepStrictEqual(m.problems, []);
    assert.deepStrictEqual(m.resources, [], 'the page fetched something; it must be fully self-contained');
  }],
  ['share: a copied link opens in a fresh browser on the same lens, walkthrough step, outcome and camera', () => {
    const SAGA = 'examples/3-async-event-driven-workflow/architecture.json';
    const SNAP = `({ lens: state.lens, cursor: state.walkCursor, choices: state.walkChoices, chapter: document.querySelector('.rail-tab[aria-selected="true"]')?.dataset.chapter || null, world: canvasCameraWorld() })`;
    const [written] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [ev(`(function () {
      const scenario = ARCH_SPEC.scenarios[0];
      const decision = (startWalkthrough(scenario.id), walkEntries().find(e => e.kind === 'decision'));
      chooseOutcome(decision.id, 1);
      const entries = walkEntries();
      walkTo(entries[entries.length - 2].id);
      selectLens('risk');
      zoomAround(state.zoom * 1.25, 500, 300);
      updateUrlState();
      return JSON.stringify({ hash: location.hash, snap: ${SNAP} });
    })()`)] }]);
    const before = JSON.parse(lastEvalValue(written));
    const [restored] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [ev(`JSON.stringify(${SNAP})`)] }], undefined, { hash: before.hash.slice(1) });
    const after = JSON.parse(lastEvalValue(restored));
    const { world: wb, ...restBefore } = before.snap;
    const { world: wa, ...restAfter } = after;
    assert.deepStrictEqual(restAfter, restBefore, before.hash);
    ['x', 'y', 'w'].forEach(axis => assert.ok(Math.abs(wa[axis] - wb[axis]) <= 0.1, `camera ${axis}: ${wb[axis]} -> ${wa[axis]}`));
  }],
  ['viewer: inside an embedded frame Copy link hides and exports copy text instead of a blocked download', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(function () {
      const top = isFramedWindow(window);
      const framed = isFramedWindow({ get self() { return 1; }, get top() { return 2; } });
      const blocked = isFramedWindow({ self: 1, get top() { throw new Error('cross-origin'); } });
      const before = getComputedStyle(document.getElementById('btn-copy-link')).display;
      applyEmbeddedMode(true);
      const after = getComputedStyle(document.getElementById('btn-copy-link')).display;
      const palette = paletteBuildAllItems().some(item => item.id === 'cmd-copy-link');
      runExport('markdown');
      const md = [document.getElementById('modal').classList.contains('open'), document.getElementById('modal-content').textContent.startsWith('# ')];
      closeModal(); runExport('png');
      const png = document.getElementById('modal-content').textContent;
      closeModal(); runExport('svg');
      const svgText = document.getElementById('modal-content').textContent.trim().startsWith('<svg');
      closeModal();
      return JSON.stringify({ top, framed, blocked, before, after, palette, md, png, svgText });
    })()`)] }]);
    const m = JSON.parse(lastEvalValue(phase));
    assert.deepStrictEqual([m.top, m.framed, m.blocked], [false, true, true]);
    assert.notStrictEqual(m.before, 'none');
    assert.strictEqual(m.after, 'none');
    assert.strictEqual(m.palette, false);
    assert.deepStrictEqual(m.md, [true, true]);
    assert.ok(/blocks downloads/.test(m.png), m.png);
    assert.strictEqual(m.svgText, true);
  }],
  ['viewer: saved card positions from another layout or that no longer route are ignored, and connections always follow their cards', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(function () {
      const built = LAYOUT_DATA.nodes.map(n => [n.id, n.x, n.y]);
      const scattered = { nodes: Object.fromEntries(LAYOUT_DATA.nodes.map((n, i) => [n.id, { x: 300 + (i % 4) * 350, y: 60 + Math.floor(i / 4) * 120 }])), boundaries: {} };
      localStorage.setItem('arch-viz-layout:' + modelIdentity(), JSON.stringify(scattered));
      const staleKeyIgnored = (restorePersistedLayout(), LAYOUT_DATA.nodes.every((n, i) => n.x === built[i][1] && n.y === built[i][2]));
      localStorage.setItem(layoutStorageKey(), JSON.stringify(scattered));
      restorePersistedLayout();
      const unroutableReverted = LAYOUT_DATA.nodes.every((n, i) => n.x === built[i][1] && n.y === built[i][2]);
      const unroutableCleared = localStorage.getItem(layoutStorageKey()) === null;
      LAYOUT_DATA.nodes.forEach((n, i) => { n.x = scattered.nodes[n.id].x; n.y = scattered.nodes[n.id].y; });
      const router = recomputeAllEdges();
      const near = (p, n) => p.x >= n.x - 14 && p.x <= n.x + n.width + 14 && p.y >= n.y - 14 && p.y <= n.y + n.height + 14;
      const follow = LAYOUT_DATA.edges.every(e => { const path = document.getElementById('path-' + e.id); const len = path.getTotalLength();
        return near(path.getPointAtLength(0), nodeById.get(e.source)) && near(path.getPointAtLength(len), nodeById.get(e.target)); });
      return JSON.stringify({ staleKeyIgnored, unroutableReverted, unroutableCleared, router, follow });
    })()`)] }]);
    const m = JSON.parse(lastEvalValue(phase));
    assert.deepStrictEqual({ ...m, router: undefined }, { staleKeyIgnored: true, unroutableReverted: true, unroutableCleared: true, router: undefined, follow: true });
    assert.notStrictEqual(m.router, 'lanes', 'scattered cards cannot route as lanes');
  }],
  ['viewer: hovering a card darkens exactly its connections, and a selection or walkthrough takes precedence', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [
      mouse({ action: 'move', selector: '#node-outbox_poller', fx: 0.5, fy: 0.5 }),
      ev(`JSON.stringify({ focused: [...document.querySelectorAll('.edge-group.hover-focus')].map(g => g.id).sort(),
        expected: LAYOUT_DATA.edges.filter(e => e.source === 'outbox_poller' || e.target === 'outbox_poller').map(e => 'edge-' + e.id).sort() })`),
      ev(`(setHoverFocus(null), openInspectorForNode('saga_orchestrator'), setHoverFocus('outbox_poller'), document.querySelectorAll('.edge-group.hover-focus').length)`)] }]);
    const values = phase.filter(step => step && step.kind === 'eval').map(step => step.value);
    const first = JSON.parse(values[0]);
    assert.ok(first.expected.length > 0);
    assert.deepStrictEqual(first.focused, first.expected);
    assert.strictEqual(values[1], 0, 'an open component sheet keeps its own spotlight');
  }],
  ['viewer: a real click on a card opens its sheet and spotlight, and a real click on a connection opens the connection', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [
      mouse({ action: 'click', selector: '#node-outbox_poller', fx: 0.5, fy: 0.5 }),
      ev(`new Promise(r => setTimeout(() => r(JSON.stringify({ sheet: document.getElementById('component-sheet').hidden, kind: document.getElementById('rail').dataset.sheet,
        title: document.getElementById('ins-title').textContent, dimmed: document.querySelectorAll('.node-group.context-dim').length,
        connections: document.querySelectorAll('#ins-connections button').length })), 600))`),
      ev(`(closeInspector(), 0)`),
      mouse({ action: 'click', selector: '#label-e_saga_outbox rect', fx: 0.5, fy: 0.5 }),
      ev(`new Promise(r => setTimeout(() => r(JSON.stringify({ sheet: document.getElementById('component-sheet').hidden, kind: document.getElementById('rail').dataset.sheet, edge: state.selectedEdgeId })), 400))`)] }]);
    const values = phase.filter(step => step && step.kind === 'eval').map(step => step.value);
    const card = JSON.parse(values[0]);
    assert.deepStrictEqual({ ...card, dimmed: card.dimmed > 0, connections: card.connections > 0 }, { sheet: false, kind: 'node', title: 'Outbox Relay Worker', dimmed: true, connections: true });
    const edge = JSON.parse(values[2]);
    assert.strictEqual(edge.sheet, false);
    assert.strictEqual(edge.kind, 'edge');
  }],
  ['viewer: a jittery real click selects a card without moving it, and empty canvas, Escape, Back and close all clear it', () => {
    const SNAP = `JSON.stringify({ sel: state.selectedNodeId, sheet: document.getElementById('component-sheet').hidden, dim: document.querySelectorAll('.context-dim').length,
      selected: document.querySelectorAll('.node-group.selected, [data-selected="true"]').length, x: LAYOUT_DATA.nodes.find(n => n.id === 'outbox_poller').x })`;
    const steps = [ev(SNAP), mouse({ action: 'jitter-click', selector: '#node-outbox_poller', fx: 0.5, fy: 0.5 }), ev(`new Promise(r => setTimeout(() => r(${SNAP}), 500))`),
      mouse({ action: 'jitter-click', selector: '#canvas-container', fx: 0.02, fy: 0.5 }), ev(`new Promise(r => setTimeout(() => r(${SNAP}), 300))`)];
    ['escape', '[data-action="sheet-back"]', '[data-action="inspector-close"]'].forEach(way => {
      steps.push(mouse({ action: 'click', selector: '#node-outbox_poller', fx: 0.5, fy: 0.5 }), ev(`new Promise(r => setTimeout(() => r(0), 400))`));
      if (way === 'escape') steps.push(ev(`(document.activeElement && document.activeElement.blur(), 0)`), key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 }));
      else steps.push(mouse({ action: 'click', selector: way, fx: 0.5, fy: 0.5 }));
      steps.push(ev(`new Promise(r => setTimeout(() => r(${SNAP}), 300))`));
    });
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps }]);
    const values = phase.filter(step => step && step.kind === 'eval').map(step => step.value).filter(v => v !== 0).map(v => JSON.parse(v));
    const [start, opened, cleared, ...ways] = values;
    assert.strictEqual(opened.sel, 'outbox_poller');
    assert.strictEqual(opened.sheet, false, 'a jittery click opens the sheet');
    assert.strictEqual(opened.x, start.x, 'a click does not drag the card');
    assert.ok(opened.dim > 0);
    [cleared, ...ways].forEach((state, i) => assert.deepStrictEqual({ sel: state.sel, sheet: state.sheet, dim: state.dim, selected: state.selected },
      { sel: null, sheet: true, dim: 0, selected: 0 }, ['empty canvas', 'Escape', 'Back', 'close'][i]));
  }],
  ['viewer: clicking a step card in the Walkthrough chapter goes to that step, and Enter on a card does too', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [
      ev(`(openChapter('walkthrough'), 0)`),
      mouse({ action: 'click', selector: '[data-walk-list] [data-walk-entry="stage_relay_outbox_event"] .walk-item-name', fx: 0.5, fy: 0.5 }),
      ev(`new Promise(r => setTimeout(() => r(JSON.stringify([state.scenarioActive, state.walkCursor])), 300))`),
      ev(`(document.querySelector('[data-walk-list] [data-walk-entry="stage_publish_order_created"]').focus(), 0)`),
      key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 }),
      ev(`new Promise(r => setTimeout(() => r(state.walkCursor), 300))`)] }]);
    const values = phase.filter(step => step && step.kind === 'eval').map(step => step.value);
    assert.deepStrictEqual(JSON.parse(values[1]), [true, 'stage_relay_outbox_event']);
    assert.strictEqual(values[3], 'stage_publish_order_created');
  }],
  ['viewer: a running walkthrough ends from its End button, an empty-canvas click, or choosing a card, and nothing stays lit', () => {
    const LIT = `JSON.stringify({ active: walkIsActive(), lit: document.querySelectorAll('.node-group.walk-active, .node-group.out-of-focus, .edge-path.highlighted').length, sheet: document.getElementById('component-sheet').hidden })`;
    const START = ev(`(startWalkthrough(ARCH_SPEC.scenarios[0].id), walkNext(), walkNext(), 0)`);
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [
      START, mouse({ action: 'click', selector: '.walk-end', fx: 0.5, fy: 0.5 }), ev(`new Promise(r => setTimeout(() => r(${LIT}), 300))`),
      START, mouse({ action: 'jitter-click', selector: '#canvas-container', fx: 0.02, fy: 0.5 }), ev(`new Promise(r => setTimeout(() => r(${LIT}), 300))`),
      START, mouse({ action: 'click', selector: '#node-warehouse_service', fx: 0.5, fy: 0.5 }), ev(`new Promise(r => setTimeout(() => r(${LIT}), 400))`)] }]);
    const [endButton, emptyCanvas, card] = phase.filter(step => step && step.kind === 'eval' && step.value !== 0).map(step => JSON.parse(step.value));
    assert.deepStrictEqual(endButton, { active: false, lit: 0, sheet: true });
    assert.deepStrictEqual(emptyCanvas, { active: false, lit: 0, sheet: true });
    assert.deepStrictEqual({ active: card.active, sheet: card.sheet }, { active: false, sheet: false }, 'choosing a card leaves the walkthrough and opens the card');
  }],
  ['viewer: the rail docks beside the canvas from 900px and example lane titles are not truncated', () => {
    const [phase] = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 980, height: 720, steps: [ev(`JSON.stringify({
      rail: document.querySelector('[data-region="rail"]').getAttribute('data-open'),
      canvasRight: document.getElementById('canvas-container').getBoundingClientRect().right,
      railLeft: document.querySelector('[data-region="rail"]').getBoundingClientRect().left,
      overflow: document.documentElement.scrollWidth > innerWidth,
      titles: [...document.querySelectorAll('.boundary-header')].map(t => t.textContent) })`)] }]);
    const m = JSON.parse(lastEvalValue(phase));
    assert.strictEqual(m.rail, 'true');
    assert.ok(m.canvasRight <= m.railLeft + 1, `canvas ${m.canvasRight} runs under the rail at ${m.railLeft}`);
    assert.strictEqual(m.overflow, false);
    assert.ok(m.titles.length > 0 && m.titles.every(t => !t.includes('\u2026')), JSON.stringify(m.titles));
  }],
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
    '1e: lens keys 1–4 select explicitly and Change alone shows the mode control',
    () => {
      const steps = [ev('window.__visits = []; document.activeElement.blur(); 0')];
      [3, 1, 3, 2, 3, 4].forEach(number => {
        steps.push(key(String(number), { code: `Digit${number}`, windowsVirtualKeyCode: 48 + number }));
        steps.push(ev(`window.__visits.push([state.lens, state.lensExplicit, state.currentView, !!document.querySelector('.lens-key [data-delta-mode]'), document.body.dataset.lens, document.querySelector('.lens-select').value]); 0`));
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
      const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 390, height: 844, steps: [ev(`const select = document.querySelector('.lens-select'); const visible = select.getBoundingClientRect().width > 0; const radiosHidden = document.querySelector('.lens-switcher').getBoundingClientRect().width === 0; select.value = 'change'; select.dispatchEvent(new Event('change', { bubbles: true })); JSON.stringify([visible, radiosHidden, state.lens, state.lensExplicit, document.querySelector('.lens-switcher [data-lens="change"]').getAttribute('aria-checked'), !!document.querySelector('.lens-key [data-delta-mode]')])`)] }])[0]));
      assert.deepStrictEqual(obs, [true, true, 'change', true, 'true', true]);
    },
  ],
  [
    '1e: lens remains selected in playback views and text fields ignore numeric shortcuts',
    () => {
      const steps = [
        ev(`selectLens('risk'); switchView(VIEWS.DATA_FLOW); window.__flowLens = state.lens; switchView(VIEWS.SEQUENCE); window.__sequenceLens = state.lens; openPalette(); document.getElementById('palette-input').focus(); 0`),
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
    '1e: lens canvas composes scenario opacity through every lens and Structure toggles Data Flow',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(async function () {
        startWalkthrough('scenario_fulfillment_saga_dlq'); walkTo('stage_publish_order_created');
        // Focus changes fade over 0.3s; sample after they settle.
        await new Promise(resolve => setTimeout(resolve, 450));
        const snapshot = () => [...document.querySelectorAll('.node-group, .edge-path:not(.ghost)')].map(item => ({
          id: item.id, opacity: Number(getComputedStyle(item).opacity),
          spotlight: ['dimmed', 'out-of-focus', 'context-dim'].filter(name => item.classList.contains(name)),
          parentSpotlight: ['dimmed', 'out-of-focus', 'context-dim'].filter(name => item.parentNode.classList.contains(name)),
          context: (item.classList.contains('edge-path') ? item.parentNode : item).hasAttribute('data-lens-context'),
          unchanged: item.classList.contains('node-group') && !['ADDED', 'CHANGED', 'REMOVED'].includes(ARCH_SPEC.nodes.find(node => 'node-' + node.id === item.id)?.delta),
          effectiveOpacity: Number(getComputedStyle(item).opacity) * (item.classList.contains('edge-path') ? Number(getComputedStyle(item.parentNode).opacity) : 1),
        }));
        const before = snapshot();
        const visits = [];
        for (const lens of LENSES) {
          selectLens(lens);
          await new Promise(resolve => setTimeout(resolve, 450));
          visits.push({lens, marks: snapshot()});
        }
        deactivateScenario();
        selectLens('structure');
        const toggle = () => document.querySelector('.lens-key [data-action="data-flow-toggle"]');
        toggle().click();
        const flow = [state.currentView, toggle().getAttribute('aria-pressed')];
        toggle().click();
        return JSON.stringify({before, visits, flow, architecture: [state.currentView, toggle().getAttribute('aria-pressed')]});
      })()`)] }])[0]));
      obs.visits.forEach(({lens, marks}) => {
        marks.forEach((mark, index) => {
          const before = obs.before[index];
          assert.strictEqual(mark.id, before.id);
          assert.deepStrictEqual(mark.spotlight, before.spotlight, lens + ': preserves scenario spotlight');
          assert.deepStrictEqual(mark.parentSpotlight, before.parentSpotlight, lens + ': preserves connection spotlight');
          if (lens === 'change' || lens === 'risk') {
            const expected = mark.id.startsWith('node-') && (before.opacity < 1 || (lens === 'change' && mark.unchanged)) ? 0.35 : 1;
            assert.strictEqual(mark.opacity, expected, lens + ': ' + mark.id);
            const effective = before.effectiveOpacity < 1 || mark.context ? 0.35 : 1;
            assert.strictEqual(mark.effectiveOpacity, effective, lens + ': avoids multiplying spotlight and lens fades');
          } else {
            assert.strictEqual(mark.opacity, before.opacity, lens + ': restores scenario opacity');
            assert.strictEqual(mark.effectiveOpacity, before.effectiveOpacity);
          }
        });
      });
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
      const obs = JSON.parse(lastEvalValue(runPhases(spec, [{ width: 1440, height: 900, steps: [ev(`selectLens('risk'); const ghosts = [...document.querySelectorAll('#ghost-layer .policy-ghost')].map(group => [group.querySelector('text').textContent, group.querySelector('.policy-ghost-line').dataset.lensStroke, getComputedStyle(group.querySelector('.policy-ghost-line')).strokeDasharray]); selectLens('structure'); JSON.stringify([ghosts, document.querySelectorAll('#ghost-layer .policy-ghost').length])`)] }])[0]));
      assert.deepStrictEqual(obs, [[['Forbidden · absent', 'risk', '2px, 4px']], 0]);
    },
  ],

  [
    'p3: risk lens required_dependency draws a Required · missing ghost',
    () => {
      const spec = riskFixture({ nodes: [riskNode('a'), riskNode('b')], policies: [{ id: 'pol_req', kind: 'required_dependency', from: 'a', to: 'b' }] });
      const obs = riskRender(spec, `selectLens('risk'); JSON.stringify([...document.querySelectorAll('#ghost-layer .policy-ghost')].map(group => [group.querySelector('text').textContent, group.querySelector('.policy-ghost-line').dataset.lensStroke]))`);
      assert.deepStrictEqual(obs, [['Required · missing', 'risk']]);
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
    'Rendered launch failures are retried while assertions and page errors are not',
    () => {
      const launches = [
        new Error('invalid DevToolsActivePort contents: ""'),
        new Error('Error: timed out waiting for /var/folders/xyz/arch-viz-chrome-1/DevToolsActivePort\n    at main'),
        new Error('connect ECONNREFUSED 127.0.0.1:9222'),
        new Error('connect ECONNREFUSED ::1:9222'),
        new Error('no debuggable page target appeared'),
        new Error('failed to open DevTools websocket'),
      ];
      launches.forEach((error) => {
        assert.strictEqual(isLaunchFailure(error), true, `should retry launch failure: ${error.message}`);
      });

      const assertion = new assert.AssertionError({
        message: 'expected true',
        actual: false,
        expected: true,
        operator: '==',
      });
      assert.strictEqual(assertion.name, 'AssertionError');
      assert.strictEqual(isLaunchFailure(assertion), false, 'assertions must never be retried');
      assert.strictEqual(
        isLaunchFailure(new Error('AssertionError [ERR_ASSERTION]: rendered gap out of range')),
        false,
        'wrapped assertion messages must never be retried'
      );

      assert.strictEqual(
        isLaunchFailure(new Error('page script failed: ReferenceError: missingFn is not defined')),
        false,
        'page script errors must never be retried'
      );
      assert.strictEqual(isLaunchFailure(new Error('unknown step kind: nope')), false, 'other errors must propagate');
      assert.strictEqual(isLaunchFailure('timed out waiting for browser websocket'), true, 'pre-connect timeouts are launch failures');
      assert.strictEqual(isLaunchFailure(new Error('timed out waiting for the DevTools port')), true);
      assert.strictEqual(
        isLaunchFailure(new Error('timed out waiting for Page.loadEventFired')),
        false,
        'timeouts after the first CDP response must propagate unchanged'
      );

      assert.strictEqual(
        launchFailureReason(new Error('Error: invalid DevToolsActivePort contents: ""\n    at main')),
        'Error: invalid DevToolsActivePort contents: ""'
      );
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
    'B2b: at 860 the rail stacks below the canvas, stays open and never overlaps or narrows it',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 860, height: 900, mobile: false, steps: tabletRailOverlaySteps() }]);
      assertTabletRailStacked(lastEvalValue(results[0]));
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
    'B2a: at 320 the rail is a page section under the canvas and selecting a component scrolls to its details',
    () => {
      const results = runPhases(fixtures.VALID_SPEC, [{ width: 320, height: 800, mobile: false, steps: stackedRailSteps() }]);
      assertStackedRail(lastEvalValue(results[0]));
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
      assert.strictEqual(probe.beforeHidden, false, 'the idle track is visible');
      assert.strictEqual(probe.trackHidden, false, 'starting shows the track');
      assert.ok(probe.beadCount >= probe.entryCount, 'the track includes the active path and alternate outcomes');
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
      assert.strictEqual(after.trackHidden, false, 'Esc restores the idle track');
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
        present: state.presentation, seq: state.sequenceIndex, world: canvasCameraWorld() })`;
      const [written] = runPhases(SAGA, [{ width: 1440, height: 900, steps: [ev(`(function () {
        switchView('sequence');
        goToSequenceStep(4);
        openInspectorForNode('saga_orchestrator');
        paletteBuildAllItems().find(item => item.id === 'layer-backend').run();
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
      // Sample once the track and rail have settled; a linked camera re-applies on each resize.
      const WORLD = ev('new Promise(r => setTimeout(() => r(JSON.stringify(canvasCameraWorld())), 300))');
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
    'Phase 0: canvas and playback overlays never sit under each other or a docked panel at 1440 and 1600',
    () => {
      const OVERLAPS = ev(`(function () {
        const sel = ['.lens-key', '.workbench-minimap', '.viewport-controls', '.walk-track', '#rail'];
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
        ev("startWalkthrough(ARCH_SPEC.scenarios[0].id); 0"), settle, OVERLAPS,
      ];
      const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [
        { width: 1440, height: 900, steps },
        { width: 1600, height: 960, steps },
      ]);
      results.forEach((phase, index) => {
        const checks = phase.filter((step) => step.kind === 'eval' && Array.isArray(step.value)).map((step) => step.value);
        assert.strictEqual(checks.length, 5);
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
      }], undefined, { compileOptions: { layoutOverrides: { router: 'curved', layout: 'columns' } } });
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
          await __sleep(500);
          __record('nodeInView', (function () { var t = __q('#node-api'); var c = __region('canvas'); if (!t || !c) return false; var a = t.getBoundingClientRect(), b = c.getBoundingClientRect(); return (a.width > 0 || a.height > 0) && a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; })());
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
          await __sleep(500);
          __record('edgeInView', (function () { var t = __q('#path-e1'); var c = __region('canvas'); if (!t || !c) return false; var a = t.getBoundingClientRect(), b = c.getBoundingClientRect(); return (a.width > 0 || a.height > 0) && a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; })());
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
      assert.strictEqual(obs.nodeInView, true, 'The selected component should be in view');
      assert.strictEqual(obs.paletteClosedAfterNode, 'false', 'Palette should close after running node item');

      assert.strictEqual(obs.edgeRowModelId, 'e1', 'Typing "SQL Write" should put e1 connection first');
      assert.strictEqual(obs.edgeSelected, 'true', 'Enter should mark #path-e1 data-selected="true"');
      assert.strictEqual(obs.railOpenEdge, 'true', 'Selecting edge should open rail');
      assert.strictEqual(obs.railSheetEdge, 'edge', 'Rail should be in edge sheet state');
      assert.strictEqual(obs.edgeInView, true, 'The selected connection should be in view');
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
    '1c: rail sheet Back returns to the chapter and clears the selection, as in the prototype',
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
      assert.strictEqual(obs.nodeSelectedAfter, null, 'Back clears the selection, so nothing stays highlighted');
      assert.notStrictEqual(obs.nodeAttrSelected, 'true', '#node-api is no longer marked selected after Back');
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
    '1c: chapters Overview shows the five trust rows and its evidence row selects Evidence',
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
              chapter: row.getAttribute('data-trust-chapter'),
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
      assert.strictEqual(obs.facts, 3, `Overview should show three stats, found ${obs.facts}`);
      assert.ok(obs.evidenceButtonText.length > 0, 'the whole evidence row is a labelled button');
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
      assert.ok(obs.names.some(name => name.includes('Publish to Kafka Event Bus')), `top-level stage names missing: ${JSON.stringify(obs.names)}`);
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
    '1c: chapters Evidence lists up to four locators of a component',
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
          __record('expectedLocators', Math.min(4, evidence.locators.length));
          __record('chipState', row && row.querySelector('.evidence-chip') ? row.querySelector('.evidence-chip').getAttribute('data-evidence-state') : null);
          __record('expectedState', evidence.state);
          __record('firstLocatorText', row && row.querySelector('.evidence-locator') ? row.querySelector('.evidence-locator').textContent : null);
          return __observed();
        })()`),
      ];
      const results = runPhases(SAGA, [{ width: 1440, height: 900, mobile: false, steps }]);
      const obs = lastEvalValue(results[0]);
      assert.ok(obs.expectedLocators >= 1, 'saga_orchestrator should have at least one locator');
      assert.strictEqual(obs.locatorCount, obs.expectedLocators, 'Evidence must render up to four locators of saga_orchestrator');
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
          model: (function () { const t = trustSummary(ARCH_SPEC, QUALITY_GATE); return ['grounding', 'evidence', 'rules', 'openItems'].map((k) => [k, t[k].state, t[k].label === 'Illustrative' ? 'Illustrative example' : t[k].label]); })(),
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
  [
    'p4: canvas overlays move layer and Change controls into the lens key',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`
        selectLens('structure');
        const absent = !document.querySelector('.filter-bar, #delta-bar, .legend-box');
        document.querySelector('.lens-key [data-action="lens-filters"]').click();
        document.querySelector('.lens-key [data-filter="backend"]').click();
        const backend = state.activeFilter === 'backend' && LAYOUT_DATA.nodes.every(node =>
          document.getElementById('node-' + node.id).classList.contains('dimmed') === !matchesLayerFilter(node));
        const pressed = document.querySelector('.lens-key [data-filter="backend"]').getAttribute('aria-pressed');
        const filterLink = parseViewHash(location.hash).filter;
        selectLens('change');
        document.querySelector('.lens-key [data-delta-mode="current"]').click();
        const added = LAYOUT_DATA.nodes.filter(node => node.delta === DELTA.ADDED);
        JSON.stringify({ absent, backend, pressed, filterLink, mode: state.deltaMode,
          added: added.length, hidden: added.every(node => document.getElementById('node-' + node.id).classList.contains('hidden')) });
      `)] }])[0]));
      assert.ok(obs.absent && obs.backend && obs.hidden);
      assert.ok(obs.added > 0);
      assert.deepStrictEqual([obs.pressed, obs.filterLink, obs.mode], ['true', 'backend', 'current']);
    },
  ],
  [
    'p4: canvas overlays keep palette search independent and layer links valid in every lens',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases(fixtures.VALID_SPEC, [{ width: 1024, height: 768, steps: [ev(`
        const before = [...document.querySelectorAll('.node-group')].map(node => node.classList.contains('dimmed'));
        openPalette(); const input = document.getElementById('palette-input');
        input.value = 'no matching component'; input.dispatchEvent(new Event('input'));
        actions.setSearchQuery('legacy query'); applyVisibility();
        const after = [...document.querySelectorAll('.node-group')].map(node => node.classList.contains('dimmed'));
        const commands = paletteBuildAllItems().filter(item => item.id.startsWith('layer-'));
        commands.find(item => item.id === 'layer-data').run();
        const selected = state.activeFilter;
        closePalette(); location.hash = 'v=2&l=risk&filter=backend'; restoreUrlState();
        JSON.stringify({ before, after, labels: commands.map(item => item.label), selected, lens: state.lens, filter: state.activeFilter });
      `)] }])[0]));
      assert.deepStrictEqual(obs.after, obs.before);
      assert.deepStrictEqual(obs.labels, ['All', 'Frontend', 'Backend', 'Data', 'External'].map(layer => 'Show layer: ' + layer));
      assert.deepStrictEqual([obs.selected, obs.lens, obs.filter], ['data', 'risk', 'backend']);
    },
  ],
  [
    'p4: canvas overlays leave every example card clear after load and fit at 1440 and 1024',
    () => {
      const probe = ev(`JSON.stringify({ zoom: state.zoom, hits: (() => {
        const overlays = ['.lens-key', '.workbench-minimap', '.viewport-controls', '.walk-track']
          .map(selector => [selector, document.querySelector(selector)])
          .filter(([, element]) => element && !element.hidden && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden')
          .map(([selector, element]) => [selector, element.getBoundingClientRect()]);
        return [...document.querySelectorAll('.node-group .node-rect, .edge-label-bg')].filter(node => node.getBoundingClientRect().width > 0).flatMap(node => {
          const a = node.getBoundingClientRect();
          return overlays.filter(([, b]) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)
            .map(([selector]) => node.parentNode.id + ' x ' + selector);
        });
      })() })`);
      for (const name of fs.readdirSync(path.join(__dirname, '../examples'))) {
        const results = runPhases('examples/' + name + '/architecture.json', [
          { width: 1440, height: 900, steps: [probe, ev('fitFromButton(); 0'), probe] },
          { width: 1024, height: 768, steps: [probe, ev('fitFromButton(); 0'), probe] },
        ]);
        results.forEach((phase, index) => phase.filter(step => step.kind === 'eval' && typeof step.value === 'string')
          .map(step => JSON.parse(step.value)).forEach(obs => {
            assert.deepStrictEqual(obs.hits, [], name + ' at viewport ' + index);
            if (index === 0) assert.ok(obs.zoom >= 0.75, name + ': fit zoom ' + obs.zoom);
          }));
      }
    },
  ],

  [
    'p4: polish Overview, trust, chapter counts and outcome lanes follow the model',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`
        const defaults = linearizeScenario(ARCH_SPEC.scenarios[0], {});
        const decision = defaults.find(entry => entry.kind === 'decision');
        const main = defaults.slice(0, defaults.indexOf(decision) + 1);
        const idle = !document.querySelector('.walk-track').hidden && document.querySelector('.walk-count').textContent === 'Start';
        const stats = [...document.querySelectorAll('.overview-fact dd')].map(el => Number(el.textContent));
        const tabs = ['walkthrough', 'changes', 'review'].map(id => Number(document.querySelector('#chapter-tab-' + id + ' .rail-tab-count').textContent));
        const expectedTabs = [walkAllStepsTotal(ARCH_SPEC.scenarios[0]), (ARCH_SPEC.review?.changedComponents?.length || ARCH_SPEC.nodes.filter(node => node.delta && node.delta !== 'UNCHANGED').length), ARCH_SPEC.policies.length + (ARCH_SPEC.findings || []).length + (ARCH_SPEC.review?.policyFindings || []).length + (ARCH_SPEC.review?.unresolvedQuestions ?? ARCH_SPEC.meta?.unresolvedQuestions ?? []).length];
        const overview = document.querySelector('.overview-eyebrow').textContent === 'SYSTEM' && document.querySelectorAll('#overview-stages li').length === main.length;
        const pills = [...document.querySelectorAll('.trust-pill')].every(pill => !!pill.querySelector('strong'));
        document.querySelector('[data-start-walkthrough]').click();
        const started = state.scenarioActive && state.chapter === 'walkthrough';
        const highlight = document.querySelector('.walk-item.current').dataset.walkEntry === state.walkCursor;
        const lanes = document.querySelectorAll('[data-walk-outcome-lane]').length;
        document.querySelector('[data-walk-outcome-lane="1"] .walk-bead').click();
        const chosen = state.walkChoices[decision.id] === 1 && document.querySelector('[data-walk-outcome-lane="1"]').dataset.chosen === 'true';
        JSON.stringify({ idle, overview, pills, stats, expectedStats: [ARCH_SPEC.nodes.length, ARCH_SPEC.boundaries.length, ARCH_SPEC.edges.length], tabs, expectedTabs, started, highlight, lanes, expectedLanes: decision.branches.length, chosen });
      `)] }])[0]));
      assert.ok(obs.idle && obs.overview && obs.pills && obs.started && obs.highlight && obs.chosen);
      assert.deepStrictEqual(obs.stats, obs.expectedStats);
      assert.deepStrictEqual(obs.tabs, obs.expectedTabs);
      assert.strictEqual(obs.lanes, obs.expectedLanes);
    },
  ],
  [
    'p4: polish the Overview counts read correctly for one of anything and count the lane a model without boundaries gets',
    () => {
      const spec = { schemaVersion: 2, meta: { title: 'One service', status: 'PROPOSED', grounding: 'illustrative' }, boundaries: [],
        nodes: [{ id: 'only', label: 'Only Service', type: 'service' }], edges: [], evidence: [], policies: [], scenarios: [] };
      const facts = JSON.parse(lastEvalValue(runPhases(spec, [{ width: 1440, height: 900, steps: [ev(`
        JSON.stringify([...document.querySelectorAll('#overview-facts .overview-fact')].map(item => item.querySelector('dd').textContent + ' ' + item.querySelector('dt').textContent))
      `)] }])[0]));
      assert.deepStrictEqual(facts, ['1 component', '1 layer', '0 connections']);
    },
  ],
  [
    'p4: polish lens pill stays slim and Filters closes with focus return',
    () => {
      const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`
        const heights = LENSES.map(lens => { selectLens(lens); return document.querySelector('.lens-key').getBoundingClientRect().height; });
        selectLens('structure');
        const safe = canvasSafeArea();
        const canvas = svg.getBoundingClientRect();
        const keyRect = document.querySelector('.lens-key').getBoundingClientRect();
        const pillClearance = safe.top >= keyRect.bottom - canvas.top && safe.width === canvas.width - 32;
        const button = () => document.querySelector('[data-action="lens-filters"]');
        button().click();
        const opened = !document.querySelector('.lens-filters').hidden;
        document.querySelector('.lens-filters [data-filter="backend"]').click();
        const filtered = state.activeFilter === 'backend' && !document.querySelector('.lens-filters').hidden;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const escaped = document.querySelector('.lens-filters').hidden && document.activeElement === button();
        button().click();
        document.body.click();
        const outside = document.querySelector('.lens-filters').hidden && document.activeElement === button();
        JSON.stringify({ heights, pillClearance, opened, filtered, escaped, outside });
      `)] }])[0]));
      assert.ok(obs.heights.every(height => height <= 40));
      assert.ok(obs.pillClearance, 'Fit reserves the horizontal pill band without losing a full canvas column');
      assert.ok(obs.opened, 'Filters opens the popover');
      assert.ok(obs.filtered, 'Backend filters the canvas and keeps the popover open');
      assert.ok(obs.escaped, 'Escape closes Filters and returns focus');
      assert.ok(obs.outside, 'An outside click closes Filters and returns focus');
    },
  ],

  [
    'p4: polish chrome avoids page overflow at 320, 768, 1024 and 1440',
    () => {
      const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [320, 768, 1024, 1440].map(width => ({ width, height: 900, steps: [ev(`(function () {
        const overflow = () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth;
        const idle = overflow();
        startWalkthrough(ARCH_SPEC.scenarios[0].id);
        const visits = LENSES.map(lens => { selectLens(lens); return overflow(); });
        return JSON.stringify([idle, ...visits]);
      })()`)] })));
      results.forEach((phase, index) => assert.deepStrictEqual(JSON.parse(lastEvalValue(phase)), [false, false, false, false, false], 'viewport ' + index));
    },
  ],

];

cases.push(['swimlane example labels render in full and retain desktop fit', () => {
  for (const name of fs.readdirSync(path.join(__dirname, '../examples')).sort()) {
    const probe = ev(`JSON.stringify({ zoom: state.zoom, labels: LAYOUT_DATA.edges.map(edge => ({
      id: edge.id, expected: edge.label || edge.packetLabel || '',
      actual: [...document.querySelectorAll('#label-' + edge.id + ' text')].map(text => text.textContent).join('')
    })) })`);
    const results = runPhases('examples/' + name + '/architecture.json', [{ width: 1440, height: 900, steps: [probe] }]);
    const obs = JSON.parse(lastEvalValue(results[0]));
    assert(obs.zoom >= 0.75, `${name}: fit zoom ${obs.zoom}`);
    obs.labels.forEach(label => assert.strictEqual(label.actual, label.expected, `${name}/${label.id}`));
  }
}]);

cases.push(['p8: chapters Changes, Review and Evidence connect model rows to the canvas', () => {
  const obs = JSON.parse(lastEvalValue(runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(async function () {
    openChapter('changes');
    const changesTitle = document.querySelector('#chapter-changes h2').textContent;
    const added = document.querySelector('[data-change-delta="ADDED"] button');
    added.click();
    const addedOpened = state.selectedNodeId === added.dataset.changeComponent && document.querySelector('[data-region="rail"]').getAttribute('data-sheet') === 'node';
    hideSheetKeepSelection();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const connection = document.querySelector('[data-change-edge]');
    connection.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    const edge = ARCH_SPEC.edges.find(edge => edge.id === connection.dataset.changeEdge);
    const canvas = svg.getBoundingClientRect();
    const endsVisible = [edge.source, edge.target].every(id => {
      const card = document.getElementById('node-' + id).getBoundingClientRect();
      return card.left >= canvas.left && card.right <= canvas.right && card.top >= canvas.top && card.bottom <= canvas.bottom;
    });
    const edgeEmphasised = document.getElementById('edge-' + edge.id).classList.contains('chapter-edge-focus');
    openChapter('review');
    const reviewTitle = document.querySelector('#chapter-review h2').textContent;
    const firstSection = document.querySelector('#chapter-review section').id;
    const rules = [...document.querySelectorAll('#review-rules button[data-policy-id]')];
    selectLens('structure');
    rules[0].click();
    const riskSelected = state.lens === 'risk';
    const gateClosed = document.querySelector('details#gate').open === false;
    document.querySelector('.trust-pill[data-trust="rules"]').click();
    const gateOpened = document.querySelector('details#gate').open;
    document.querySelector('details#gate').open = false;
    toggleGatePanel();
    const paletteGateOpened = document.querySelector('details#gate').open;
    openChapter('evidence');
    const evidenceRows = [...document.querySelectorAll('button[data-evidence-node]')];
    const evidenceLabels = evidenceRows.every(row => row.querySelector('.evidence-chip').textContent === nodeEvidence(ARCH_SPEC, row.dataset.evidenceNode).label);
    const locatorCap = evidenceRows.every(row => row.querySelectorAll('.evidence-locator').length <= 4);
    evidenceRows[0].click();
    const evidenceOpened = state.selectedNodeId === evidenceRows[0].dataset.evidenceNode && document.querySelector('[data-region="rail"]').getAttribute('data-sheet') === 'node';
    return JSON.stringify({ changesTitle, addedOpened, endsVisible, edgeEmphasised, reviewTitle, firstSection, ruleCount: rules.length, policies: ARCH_SPEC.policies.length,
      riskSelected, gateClosed, gateOpened, paletteGateOpened, evidenceCount: evidenceRows.length, nodes: LAYOUT_DATA.nodes.length, evidenceLabels, locatorCap, evidenceOpened });
  })()`)] }])[0]));
  assert.strictEqual(obs.changesTitle, '4 added, 2 changed, 2 new connections');
  assert.ok(obs.addedOpened, 'Added rows open the component sheet');
  assert.ok(obs.endsVisible, 'New connections frame both cards within the canvas');
  assert.ok(obs.edgeEmphasised, 'New connections briefly emphasise their edge');
  assert.strictEqual(obs.reviewTitle, 'All rules pass, 2 known failure modes');
  assert.strictEqual(obs.firstSection, 'section-rules');
  assert.strictEqual(obs.ruleCount, obs.policies);
  assert.ok(obs.riskSelected);
  assert.ok(obs.gateClosed);
  assert.ok(obs.gateOpened, 'Rules trust pill reveals the collapsed gate');
  assert.ok(obs.paletteGateOpened, 'Quality gate palette action reveals the collapsed gate');
  assert.strictEqual(obs.evidenceCount, obs.nodes);
  assert.ok(obs.evidenceLabels);
  assert.ok(obs.locatorCap);
  assert.ok(obs.evidenceOpened);
}]);

cases.push(['p8: chapters render all examples without overflow at 320, 768, 1024 and 1440', () => {
  for (const name of ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow']) {
    const results = runPhases('examples/' + name + '/architecture.json', [320, 768, 1024, 1440].map(width => ({ width, height: 900, steps: [ev(`JSON.stringify(['changes', 'review', 'evidence'].map(chapter => {
      openChapter(chapter);
      const panel = document.getElementById('chapter-' + chapter);
      return { intro: !!panel.querySelector('.chapter-eyebrow') && !!panel.querySelector('.chapter-context'), overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth };
    }))`)] })));
    results.forEach(result => JSON.parse(lastEvalValue(result)).forEach(chapter => {
      assert.ok(chapter.intro, name + ': chapter has its introduction');
      assert.strictEqual(chapter.overflow, false, name + ': chapter fits the page');
    }));
  }
}]);

cases.push(['p8: lens fit measures badge ink and policy ghosts while supporting geometry-only callers', () => {
  const vm = require('node:vm');
  const context = vm.createContext({
    LAYOUT_DATA: { nodes: [{ id: 'card', x: 100, y: 100, width: 220, height: 72 }], edges: [] },
    state: { collapsedBoundaries: new Set() }, ArchVizGeometry: geometry,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/fit.js'), 'utf8'), context);
  const bounds = () => JSON.parse(JSON.stringify(context.computeTotalVisualBounds()));
  assert.deepStrictEqual(bounds(), { minX: 100, minY: 100, maxX: 320, maxY: 172, width: 220, height: 72 });
  context.document = { querySelector: selector => {
    assert.strictEqual(selector, '#node-card .node-badge');
    return { getBBox: () => ({ x: -2, y: -1, width: 100, height: 18 }),
      transform: { baseVal: { consolidate: () => ({ matrix: { e: 108, f: -8 } }) } } };
  } };
  assert.deepStrictEqual(bounds(), { minX: 100, minY: 91, maxX: 320, maxY: 172, width: 220, height: 81 });
  context.ghostLayer = { querySelectorAll: selector => {
    assert.strictEqual(selector, '.policy-ghost');
    return [{ getBBox: () => ({ x: 400, y: 50, width: 100, height: 30 }) }];
  } };
  assert.deepStrictEqual(bounds(), { minX: 100, minY: 50, maxX: 500, maxY: 172, width: 400, height: 122 });
}]);

cases.push(['p8: lenses keep card tags above text and recede only context on example 3', () => {
  const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(() => {
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    selectLens('structure');
    const original = [...document.querySelectorAll('.node-tech')].map(text => text.textContent);
    const visits = ['change', 'risk', 'evidence', 'structure', 'change'].map(lens => {
      selectLens(lens);
      // Finish opacity transitions before inspecting the lens alone.
      document.querySelectorAll('.node-group, .edge-group').forEach(group => group.style.transition = 'none');
      return { lens, tech: [...document.querySelectorAll('.node-tech')].map(text => text.textContent),
        badges: [...document.querySelectorAll('.node-badge')].map(badge => {
          const card = badge.parentNode;
          const box = badge.getBoundingClientRect(), rect = card.querySelector('.node-rect').getBoundingClientRect();
          return { overlaps: ['.node-name', '.node-tech'].some(selector => overlaps(box, card.querySelector(selector).getBoundingClientRect())),
            above: box.top < rect.top && box.bottom > rect.top };
        }),
        nodes: LAYOUT_DATA.nodes.map(node => [node.delta || 'UNCHANGED', Number(getComputedStyle(document.getElementById('node-' + node.id)).opacity)]),
        edges: LAYOUT_DATA.edges.map(edge => [edge.delta || 'UNCHANGED', document.getElementById('path-' + edge.id).dataset.lensStroke,
          Number(getComputedStyle(document.getElementById('edge-' + edge.id)).opacity)]),
        ghostCount: document.querySelectorAll('.policy-ghost').length,
      };
    });
    return JSON.stringify({ original, visits });
  })()`)] }]);
  const obs = JSON.parse(lastEvalValue(results[0]));
  obs.visits.forEach(visit => {
    assert.deepStrictEqual(visit.tech, obs.original, visit.lens + ': badges must not narrow technology');
    visit.badges.forEach(badge => { assert(!badge.overlaps, visit.lens + ': badge overlaps text'); assert(badge.above); });
    if (visit.lens === 'change') {
      visit.nodes.forEach(([delta, opacity]) => assert.strictEqual(opacity, delta === 'UNCHANGED' ? 0.35 : 1));
      visit.edges.forEach(([delta, stroke, opacity]) => {
        if (delta === 'UNCHANGED') assert(opacity < 0.6);
        if (delta === 'ADDED') assert.strictEqual(stroke, 'ok');
      });
    }
    if (visit.lens === 'structure') {
      visit.nodes.forEach(([, opacity]) => assert.strictEqual(opacity, 1));
      visit.edges.forEach(([, stroke, opacity]) => { assert.strictEqual(stroke, 'edge'); assert.strictEqual(opacity, 1); });
      assert.strictEqual(visit.ghostCount, 0);
    }
  });
}]);

cases.push(['p8: lenses route Risk ghosts orthogonally around cards with separate labels', () => {
  const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [{ width: 1440, height: 900, steps: [ev(`(() => {
    selectLens('risk');
    const cards = LAYOUT_DATA.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height }));
    const ghosts = [...document.querySelectorAll('.policy-ghost')].map(group => {
      const numbers = group.querySelector('.policy-ghost-line').getAttribute('d').match(/-?[0-9.]+/g).map(Number);
      const policy = ARCH_SPEC.policies.find(policy => policy.id === group.dataset.policyId);
      return { from: policy.from, to: policy.to, points: numbers.reduce((out, n, i) => { if (i % 2 === 0) out.push({ x: n, y: numbers[i + 1] }); return out; }, []) };
    });
    const labels = [...document.querySelectorAll('.edge-label-bg, .node-badge')].map(label => {
      const r = label.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, ghost: !!label.closest('.policy-ghost') };
    });
    return JSON.stringify({ cards, ghosts, labels });
  })()`)] }]);
  const obs = JSON.parse(lastEvalValue(results[0]));
  assert(obs.ghosts.length > 0);
  obs.ghosts.forEach(ghost => ghost.points.slice(1).forEach((b, i) => {
    const a = ghost.points[i];
    assert(a.x === b.x || a.y === b.y, 'ghost segment must be orthogonal');
    obs.cards.filter(card => card.id !== ghost.from && card.id !== ghost.to).forEach(card => {
      const crosses = a.x === b.x
        ? a.x > card.x && a.x < card.x + card.width && Math.max(a.y, b.y) > card.y && Math.min(a.y, b.y) < card.y + card.height
        : a.y > card.y && a.y < card.y + card.height && Math.max(a.x, b.x) > card.x && Math.min(a.x, b.x) < card.x + card.width;
      assert(!crosses, 'ghost crosses ' + card.id);
    });
  }));
  obs.labels.forEach((a, i) => obs.labels.slice(i + 1).forEach(b => {
    if (a.ghost || b.ghost) assert(!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top), 'policy label overlaps another label');
  }));
}]);

cases.push(['p8: lenses and top-edge tags keep the page inside every viewport', () => {
  const results = runPhases('examples/3-async-event-driven-workflow/architecture.json', [320, 768, 1024, 1440].map(width => ({ width, height: 900, steps: [ev(`JSON.stringify(['change', 'risk', 'evidence', 'structure'].map(lens => {
    selectLens(lens); fitToScreen();
    const canvas = document.getElementById('arch-svg').getBoundingClientRect();
    return { lens, overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll('.node-group:not(.hidden) .node-badge')].some(badge => {
        const box = badge.getBoundingClientRect(); return box.top < canvas.top || box.left < canvas.left || box.right > canvas.right || box.bottom > canvas.bottom;
      }) };
  }))`)] })));
  results.forEach(result => JSON.parse(lastEvalValue(result)).forEach(visit => { assert(!visit.overflow, visit.lens); assert(!visit.clipped, visit.lens); }));
}]);


// Any model: generated specs of every shape get the same real-interaction sweep the examples get.
cases.push(['generated: fourteen generated specs survive a full interaction sweep with no errors, overlaps or overflow', () => {
  const { generateSpec } = require('./spec-generator.js');
  const SWEEP = ev(`(async function () {
    const problems = [];
    const origError = console.error;
    console.error = (...args) => { problems.push('console.error: ' + args.join(' ')); };
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const rects = selector => [...document.querySelectorAll(selector)].map(el => el.getBoundingClientRect()).filter(r => r.width > 0);
    const overlaps = list => list.some((a, i) => list.slice(i + 1).some(b => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1));
    const sheetOpenAfterClick = !document.getElementById('component-sheet').hidden && state.selectedNodeId === 'n0';
    if (!sheetOpenAfterClick) problems.push('a real click on a card did not open its sheet');
    closeInspector(); await pause(50); fitToScreen(); await pause(50);
    if (overlaps(rects('.node-group .node-rect'))) problems.push('cards overlap on screen');
    if (overlaps(rects('.edge-label-bg'))) problems.push('label pills overlap on screen');
    const cards = rects('.node-group .node-rect');
    if (rects('.edge-label-bg').some(a => cards.some(b => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1))) problems.push('a label pill covers a card');
    for (const edge of LAYOUT_DATA.edges) if ((edge.label || edge.packetLabel) && !edge.labelBounds && document.getElementById('label-' + edge.id)?.getBoundingClientRect().width) problems.push('label ' + edge.id + ' has no room but is drawn');
    for (const node of LAYOUT_DATA.nodes) { openInspectorForNode(node.id); await pause(5); }
    for (const edge of LAYOUT_DATA.edges) { openInspectorForEdge(edge.id); await pause(2); }
    closeInspector();
    for (const scenario of ARCH_SPEC.scenarios || []) {
      startWalkthrough(scenario.id);
      const decision = walkEntries().find(entry => entry.kind === 'decision');
      const outcomes = decision ? decision.branches.length : 1;
      for (let choice = 0; choice < outcomes; choice++) {
        startWalkthrough(scenario.id, decision ? { [decision.id]: choice } : {});
        for (const entry of walkEntries()) { walkTo(entry.id); await pause(2); }
      }
      endWalkthrough();
    }
    for (const lens of LENSES) { selectLens(lens); await pause(20); if (overlaps(rects('.edge-label-bg'))) problems.push('label pills overlap in ' + lens); }
    selectLens('structure');
    for (const chapter of availableChapters()) { openChapter(chapter.id); await pause(10); }
    console.error = origError;
    if (Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1) problems.push('horizontal page overflow');
    if (/undefined|NaN|\\[object Object\\]/.test(document.getElementById('rail').innerText)) problems.push('the rail prints undefined, NaN or [object Object]');
    return JSON.stringify(problems.concat((window.__errors || []).map(e => 'error: ' + e.msg)));
  })()`);
  // Seeds 20 and 30 each have a label the router finds no room for.
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 30]) {
    const width = seed % 4 === 0 ? 390 : 1440;
    const [phase] = runPhases(generateSpec(seed), [{ width, height: 900, steps: [mouse({ action: 'jitter-click', selector: '#node-n0', fx: 0.5, fy: 0.5 }), ev('new Promise(r => setTimeout(() => r(0), 500))'), SWEEP] }]);
    assert.deepStrictEqual(JSON.parse(lastEvalValue(phase)), [], `seed ${seed} at ${width}px`);
  }
}]);

module.exports = { name: 'Rendered DOM Verification', cases };
