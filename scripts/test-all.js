#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

if (!fs.existsSync(SKILLS_DIR)) {
  console.error('test-all: no skills/ directory found');
  process.exit(1);
}

const suites = [];
for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const runner = path.join(SKILLS_DIR, entry.name, 'tests', 'run-tests.js');
  if (fs.existsSync(runner)) suites.push({ name: entry.name, runner });
}

if (suites.length === 0) {
  console.error('test-all: no skill test suites found');
  process.exit(1);
}

const failures = [];
for (const suite of suites) {
  console.log(`\n=== ${suite.name} ===`);
  const result = spawnSync(process.execPath, [suite.runner], {
    cwd: path.dirname(suite.runner),
    stdio: 'inherit'
  });
  if (result.status !== 0) failures.push(suite.name);
}

console.log('\n----------------------------------------------------');
if (failures.length > 0) {
  console.log(`test-all: FAILED (${failures.join(', ')})`);
  process.exit(1);
}
console.log(`test-all: PASSED (${suites.length} skill suite(s))`);
