#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.nyc_output']);
const SCAN_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.html',
  '.txt'
]);
const SELF = path.relative(ROOT, __filename);

// Paths git already ignores are not part of the repository, so they are not
// this checker's business. Without this, a tool's local state directory --
// delegate-fleet's .delegate-fleet/, for example -- fails the personal-path
// rule on the machine that created it even though it can never be committed.
const IGNORED = (() => {
  const set = new Set();
  const res = spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--ignored=matching', '-z', '-uall'], {
    encoding: 'utf8'
  });
  if (res.status !== 0 || !res.stdout) return set;
  for (const record of res.stdout.split('\0')) {
    if (record.startsWith('!! ')) set.add(record.slice(3).replace(/\/$/, ''));
  }
  return set;
})();

function isIgnored(full) {
  return IGNORED.has(path.relative(ROOT, full));
}

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function walk(dir, onFile, onDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnored(full)) continue;
      if (SKIP_DIRS.has(entry.name)) {
        if (entry.name === 'node_modules') {
          warn(`node_modules present at ${path.relative(ROOT, full)} (not committed; ignored)`);
        }
        continue;
      }
      if (onDir) onDir(full);
      walk(full, onFile, onDir);
    } else if (entry.isFile()) {
      if (isIgnored(full)) continue;
      onFile(full);
    }
  }
}

const REQUIRED_FILES = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'AGENTS.md',
  '.gitignore',
  '.editorconfig',
  '.gitattributes',
  'package.json',
  'scripts/validate-repo.js',
  'scripts/test-all.js',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/new_skill.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'docs/INSTALL.md',
  'docs/ARCHITECTURE.md',
  'docs/MAINTAINERS.md'
];

for (const relative of REQUIRED_FILES) {
  if (!exists(relative)) fail(`missing required file: ${relative}`);
}

const FORBIDDEN = [
  { re: /\/Users\/[A-Za-z0-9._-]+\//, label: 'absolute macOS user path' },
  { re: /\/home\/[A-Za-z0-9._-]+\//, label: 'absolute Linux user path' },
  { re: /\bmelshiaty\b/i, label: 'personal identifier' },
  { re: /\bbappzaar\b/i, label: 'private project name' },
  { re: /\bfastfishio\b/i, label: 'unverified remote' },
  { re: /features\/o2d|marketplaces\/noon|@o2d\/|@noon\//, label: 'private project path' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key material' }
];

const skillDirs = [];
walk(ROOT, (file) => {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  const base = path.basename(file);

  if (base === '.DS_Store') {
    fail(`stray OS file: ${relative}`);
    return;
  }

  const ext = path.extname(file).toLowerCase();
  if (!SCAN_EXTENSIONS.has(ext)) return;

  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  if (relative !== SELF) {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(contents)) {
        fail(`${relative}: contains ${rule.label}`);
      }
    }
  }

  if (ext === '.json') {
    try {
      JSON.parse(contents);
    } catch (error) {
      fail(`${relative}: invalid JSON (${error.message})`);
    }
  }

  if (ext === '.yml' || ext === '.yaml') {
    if (relative.startsWith('.github/ISSUE_TEMPLATE/') && base !== 'config.yml') {
      if (!/^name:/m.test(contents)) fail(`${relative}: issue template needs a top-level "name:"`);
      if (!/^description:/m.test(contents)) fail(`${relative}: issue template needs a top-level "description:"`);
      if (!/^body:/m.test(contents)) fail(`${relative}: issue template needs a top-level "body:"`);
    }
    if (relative.startsWith('.github/workflows/')) {
      if (!/^on:/m.test(contents)) fail(`${relative}: workflow needs a top-level "on:"`);
      if (!/^jobs:/m.test(contents)) fail(`${relative}: workflow needs a top-level "jobs:"`);
    }
  }
}, (dir) => {
  const relative = path.relative(ROOT, dir).split(path.sep).join('/');
  if (relative === 'skills') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) skillDirs.push(path.join(dir, entry.name));
    }
  }
});

if (skillDirs.length === 0) fail('no skills found under skills/');

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function readFrontmatter(file) {
  const contents = fs.readFileSync(file, 'utf8');
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].replace(/^["']|["']$/g, '').trim();
  }
  return fields;
}

for (const dir of skillDirs) {
  const name = path.basename(dir);
  const relative = path.relative(ROOT, dir).split(path.sep).join('/');
  const skillFile = path.join(dir, 'SKILL.md');

  if (!fs.existsSync(skillFile)) {
    fail(`${relative}: missing SKILL.md`);
    continue;
  }

  const fields = readFrontmatter(skillFile);
  if (!fields) {
    fail(`${relative}/SKILL.md: missing YAML frontmatter`);
    continue;
  }
  if (!fields.name) fail(`${relative}/SKILL.md: frontmatter is missing "name"`);
  if (!fields.description) fail(`${relative}/SKILL.md: frontmatter is missing "description"`);
  if (fields.name && fields.name !== name) {
    fail(`${relative}/SKILL.md: name "${fields.name}" does not match folder "${name}"`);
  }
  if (fields.name && !NAME_PATTERN.test(fields.name)) {
    fail(`${relative}/SKILL.md: name "${fields.name}" must be lowercase words separated by single hyphens`);
  }
  if (fields.name && fields.name.length > 64) {
    fail(`${relative}/SKILL.md: name is longer than 64 characters`);
  }
  if (fields.description && (fields.description.length < 1 || fields.description.length > 1024)) {
    fail(`${relative}/SKILL.md: description must be 1-1024 characters`);
  }
}

const LINK_SCAN = ['README.md', 'CONTRIBUTING.md', 'SUPPORT.md', 'SECURITY.md', 'AGENTS.md'];
for (const relative of LINK_SCAN) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) continue;
  const contents = fs.readFileSync(file, 'utf8');
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(contents)) !== null) {
    const target = match[1].trim().split('#')[0];
    if (!target || target.startsWith('http') || target.startsWith('mailto:')) continue;
    if (target.includes('<') || target.includes('>')) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      fail(`${relative}: broken relative link -> ${target}`);
    }
  }
}

const summary = `validate-repo: ${errors.length} error(s), ${warnings.length} warning(s).`;
if (warnings.length > 0) {
  console.log('Warnings:');
  for (const message of warnings) console.log(`  - ${message}`);
}
if (errors.length > 0) {
  console.error('Errors:');
  for (const message of errors) console.error(`  - ${message}`);
  console.error(summary);
  process.exit(1);
}
console.log(summary);
