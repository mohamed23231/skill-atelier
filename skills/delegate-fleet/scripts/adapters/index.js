'use strict';

/**
 * The backend registry.
 *
 * Every adapter here is SUPPORTED BY THE FRAMEWORK on every machine. Whether a
 * backend is *available* is a separate, runtime question answered by
 * environment discovery, and what the *installed version* can really do is a
 * third question answered by local verification. An adapter is never removed
 * because its CLI is missing locally.
 *
 * Adding a backend is deliberately a single small file: define how to invoke
 * the CLI, declare what it can do and on what evidence, and say how to read
 * its --help. Nothing else in the framework changes.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CAPABILITY_NAMES, EVIDENCE_STATES } = require('../lib/capabilities.js');

const PROMPT_DELIVERY = ['argv', 'stdin', 'file'];

const BUILT_IN = [
  // Verified against the installed CLI during this project's own test runs.
  require('./claude.js'),
  require('./codex.js'),
  require('./cursor.js'),
  require('./opencode.js'),
  require('./gemini.js'),
  require('./agy.js'),
  // Supported, with capability claims from vendor docs or a cross-referenced
  // upstream project. `doctor` promotes or demotes these per machine.
  require('./copilot.js'),
  require('./aider.js'),
  require('./crush.js'),
  require('./qwen.js'),
  require('./grok.js'),
  require('./kimi.js'),
  require('./zcode.js'),
  require('./cline.js'),
  require('./pi.js'),
  require('./omp.js'),
  require('./vibe.js'),
  require('./warp.js'),
  require('./commandcode.js'),
  require('./qoder.js'),
];

/** Reject a malformed adapter at load time rather than at dispatch time. */
function assertShape(a, origin) {
  const where = `adapter "${a && a.id}"${origin ? ` from ${origin}` : ''}`;
  if (!a || !a.id || !a.cli) throw new Error(`${where}: must define id and cli`);
  if (typeof a.build !== 'function') throw new Error(`${where}: must define build()`);
  if (typeof a.probe !== 'function') throw new Error(`${where}: must define probe()`);
  if (!a.capabilities || typeof a.capabilities !== 'object') throw new Error(`${where}: must declare capabilities`);
  for (const name of CAPABILITY_NAMES) {
    const state = a.capabilities[name];
    if (!EVIDENCE_STATES.includes(state)) {
      throw new Error(`${where}: capability "${name}" is "${state}"; expected one of ${EVIDENCE_STATES.join('|')}`);
    }
  }
  const delivery = a.promptDelivery || 'argv';
  if (!PROMPT_DELIVERY.includes(delivery)) {
    throw new Error(`${where}: promptDelivery "${delivery}" must be one of ${PROMPT_DELIVERY.join('|')}`);
  }
}

function buildRegistry(extra = []) {
  const registry = new Map();
  for (const a of [...BUILT_IN, ...extra]) {
    assertShape(a, a.__origin);
    registry.set(a.id, Object.freeze(a)); // a local adapter may override a built-in
  }
  return registry;
}

/**
 * Third-party adapters: any `.js` file in `<workspace>/.delegate-fleet/adapters/`.
 * This is how a team supports a CLI the framework has never heard of without
 * forking it. They are ordinary modules with the same contract, and they are
 * validated exactly as strictly as the built-ins.
 */
function loadLocalAdapters(workspace) {
  const dir = path.join(workspace, '.delegate-fleet', 'adapters');
  const loaded = [];
  const errors = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch { return { loaded, errors }; }
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    try {
      const mod = require(file);
      assertShape(mod, file);
      mod.__origin = file;
      loaded.push(mod);
    } catch (err) {
      errors.push(`${file}: ${err && err.message ? err.message : err}`);
    }
  }
  return { loaded, errors };
}

const REGISTRY = buildRegistry();

function getAdapter(id, registry = REGISTRY) { return registry.get(id) || null; }
function adapterIds(registry = REGISTRY) { return [...registry.keys()]; }

module.exports = {
  REGISTRY, BUILT_IN, ADAPTERS: BUILT_IN,
  getAdapter, adapterIds, buildRegistry, loadLocalAdapters, assertShape, PROMPT_DELIVERY,
};
