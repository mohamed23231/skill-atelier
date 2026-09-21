#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { compileArchitecture, validateArchitecture, exportToMermaid, RepoInspector } = require('../src/index.js');
const { STARTER_SPEC } = require('../src/utils/starter-spec.js');
const { scaffoldFromDiff } = require('../src/utils/diff-scaffold.js');

const HELP = `
architecture-visualizer (arch-viz) CLI
Turn software ideas, migrations, and system designs into interactive architecture visualizations.

Usage:
  arch-viz build <spec.json> [options]     Compile architecture JSON into standalone interactive HTML
  arch-viz validate <spec.json> [options]  Run the 14-point Quality Gate on an architecture spec
  arch-viz mermaid <spec.json> [options]   Print Mermaid flowchart / sequence / ER source
  arch-viz scaffold [options]              Draft a spec from the git diff (fastest way to start)
  arch-viz inspect [dir]                   Report detected frameworks, databases and queues in a repo
  arch-viz init [output.json]              Generate a starter architecture JSON specification
  arch-viz help                            Show this help message

Options for 'build':
  -o, --output <file>      Output HTML file (default: ./architecture.html)
  --md <file>              Also write a Markdown architecture report
  --strict                 Fail the build if any quality warning is found
  --direction <LR|TB>      Layout flow direction (default: LR)
  --repo-root <dir>        Root used to resolve VERIFIED file paths (default: cwd)
  --no-open                Do not open the generated HTML in the default browser
                           (build opens it automatically unless this flag or ARCH_VIZ_NO_OPEN is set)

Options for 'scaffold':
  -o, --output <file>      Where to write the draft spec (default: ./architecture.json)
  --base <ref>             Diff against this git ref instead of the uncommitted working tree
  --repo-root <dir>        Repository to read the diff from (default: cwd)
  --title <text>           Title for the generated spec
  --ignore <prefix>        Skip changed paths starting with this prefix (repeatable)

Options for 'validate':
  --strict                 Exit non-zero on quality warnings, not just errors
  --repo-root <dir>        Root used to resolve VERIFIED file paths (default: cwd)
  --json                   Emit the raw validation result as JSON

Options for 'mermaid':
  --view <flowchart|sequence|er>   Which diagram to print (default: flowchart)

Examples:
  arch-viz scaffold -o draft.json --ignore node_modules/ && arch-viz build draft.json
  arch-viz build system-spec.json -o dist/index.html --md dist/architecture.md
  arch-viz validate system-spec.json --strict --repo-root .
  arch-viz mermaid system-spec.json --view sequence
  arch-viz init my-architecture.json
`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseOptions(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const needsValue = ['-o', '--output', '--md', '--direction', '--repo-root', '--view', '--base', '--title', '--ignore'];
    if (needsValue.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) fail(`Option ${arg} requires a value.`);
      i++;
      if (arg === '-o' || arg === '--output') opts.output = value;
      else if (arg === '--md') opts.markdown = value;
      else if (arg === '--direction') {
        if (value !== 'LR' && value !== 'TB') fail(`--direction must be LR or TB, received "${value}".`);
        opts.direction = value;
      } else if (arg === '--repo-root') opts.repoRoot = value;
      else if (arg === '--view') opts.view = value;
      else if (arg === '--base') opts.base = value;
      else if (arg === '--title') opts.title = value;
      else if (arg === '--ignore') (opts.ignore = opts.ignore || []).push(value);
    } else if (arg === '--strict') {
      opts.strict = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--no-open') {
      opts.noOpen = true;
    } else if (arg.startsWith('-')) {
      fail(`Unknown option "${arg}". Run "arch-viz help" for usage.`);
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function readSpec(specPath) {
  if (!specPath) fail('Missing path to specification JSON file.');
  const resolved = path.resolve(specPath);
  if (!fs.existsSync(resolved)) fail(`Specification not found: ${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    fail(`Could not parse ${resolved}: ${err.message}`);
  }
}

function openInBrowser(filePath, onResult) {
  const opener =
    process.platform === 'darwin'
      ? { command: 'open', args: [filePath] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', filePath] }
        : { command: 'xdg-open', args: [filePath] };

  let settled = false;
  const settle = (launched) => {
    if (settled) return;
    settled = true;
    onResult(launched);
  };

  try {
    const child = spawn(opener.command, opener.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => settle(false));
    child.on('spawn', () => {
      child.unref();
      settle(true);
    });
    setTimeout(() => settle(true), 400).unref();
  } catch {
    settle(false);
  }
}

function printGate(gate) {
  if (!gate || gate.length === 0) return;
  console.log('\n14-Point Quality Gate:');
  gate.forEach((g) => {
    const icon = g.status === 'PASS' ? '✅' : g.status === 'WARN' ? '⚠️ ' : '➖';
    console.log(`  ${icon} ${String(g.id).padStart(2, ' ')}. ${g.name.padEnd(28, ' ')} ${g.detail}`);
  });
}

function commandValidate(args) {
  const opts = parseOptions(args);
  const spec = readSpec(opts._[0]);
  const result = validateArchitecture(spec, { repoRoot: opts.repoRoot ? path.resolve(opts.repoRoot) : process.cwd() });

  const failed = !result.valid || (opts.strict && result.warnings.length > 0);

  if (opts.json) {
    const payload = `${JSON.stringify({ ...result, strict: Boolean(opts.strict), failed }, null, 2)}\n`;
    process.stdout.write(payload, () => {
      process.exit(failed ? 1 : 0);
    });
    return;
  }

  console.log('\n--- Architecture Quality Gate Report ---');
  console.log(`Title: ${spec.meta?.title || 'Untitled'}`);
  console.log(`Nodes: ${result.stats.totalNodes} | Edges: ${result.stats.totalEdges} | Boundaries: ${result.stats.totalBoundaries}`);
  console.log(`Verified: ${result.stats.verifiedCount} | Inferred: ${result.stats.inferredCount} | Assumed: ${result.stats.assumedCount} | Unknown: ${result.stats.unknownCount}`);
  console.log(`Grounding: ${result.stats.grounding}`);

  printGate(result.gate);

  if (result.warnings.length > 0) {
    console.log(`\nWarnings (${result.warnings.length}):`);
    result.warnings.forEach((w) => console.log(`  ⚠️  ${w}`));
  }

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    result.errors.forEach((e) => console.log(`  ❌ ${e}`));
    console.log('\nResult: FAILED ❌\n');
    process.exit(1);
  }

  if (failed) {
    console.log('\nResult: FAILED (strict mode — warnings are errors) ❌\n');
    process.exit(1);
  }

  console.log('\nResult: PASSED QUALITY GATE ✅\n');
  process.exit(0);
}

function commandBuild(args) {
  const opts = parseOptions(args);
  const specPath = opts._[0];
  const spec = readSpec(specPath);
  const outputHtml = opts.output || 'architecture.html';

  try {
    const result = compileArchitecture(spec, {
      outputHtml,
      outputMarkdown: opts.markdown || null,
      strict: Boolean(opts.strict),
      repoRoot: opts.repoRoot ? path.resolve(opts.repoRoot) : process.cwd(),
      layoutOverrides: opts.direction ? { direction: opts.direction } : {},
    });

    console.log('\n--- Architecture Visualization Generated ---');
    console.log(`Title:    ${spec.meta?.title || 'System Architecture'}`);
    console.log(`HTML:     ${path.resolve(outputHtml)}`);
    if (opts.markdown) console.log(`Markdown: ${path.resolve(opts.markdown)}`);

    const warnCount = result.validation.gate.filter((g) => g.status === 'WARN').length;
    console.log(`Quality:  ${warnCount === 0 ? 'ALL GATES PASSED ✅' : `${warnCount} gate warning(s) ⚠️`}`);
    printGate(result.validation.gate.filter((g) => g.status === 'WARN'));

    const suppressOpen = opts.noOpen || process.env.ARCH_VIZ_NO_OPEN === '1';
    if (suppressOpen) {
      console.log('\nDone! Open the HTML file in any browser to explore.\n');
    } else {
      openInBrowser(path.resolve(outputHtml), (launched) => {
        console.log(launched ? '\nDone! Opened in your default browser.\n' : '\nDone! Could not launch a browser — open the HTML file manually.\n');
      });
    }
  } catch (err) {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  }
}

function commandScaffold(args) {
  const opts = parseOptions(args);
  const targetPath = path.resolve(opts.output || opts._[0] || 'architecture.json');
  if (fs.existsSync(targetPath)) fail(`Refusing to overwrite existing file: ${targetPath}`);

  let result;
  try {
    result = scaffoldFromDiff({
      repoRoot: opts.repoRoot,
      base: opts.base,
      title: opts.title,
      ignore: opts.ignore,
    });
  } catch (err) {
    fail(err.message);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(result.spec, null, 2), 'utf8');

  console.log(`\nScaffolded draft specification: ${targetPath}`);
  console.log(`Files: ${result.stats.fileCount} | Boundaries: ${result.stats.boundaryCount} | Import edges: ${result.stats.edgeCount} | Isolated nodes: ${result.stats.isolatedCount}`);
  console.log('\nThis is a DRAFT, not an architecture. Before building:');
  console.log('  1. Merge or delete noise nodes (assets, lockfiles, generated output).');
  console.log('  2. Rename labels to describe behaviour, not filenames.');
  console.log('  3. Add the runtime edges that static imports cannot show.');
  console.log('  4. Connect or remove isolated nodes so quality gate 3 passes.\n');
}

function commandMermaid(args) {
  const opts = parseOptions(args);
  const spec = readSpec(opts._[0]);
  const mermaid = exportToMermaid(spec, { direction: opts.direction });
  const view = opts.view || 'flowchart';
  if (!(view in mermaid)) fail(`Unknown view "${view}". Expected flowchart, sequence, or er.`);
  if (!mermaid[view]) fail(`Spec has no "${view}" view to export.`);
  console.log(mermaid[view]);
}

function commandInspect(args) {
  const opts = parseOptions(args);
  const root = path.resolve(opts._[0] || process.cwd());
  const signatures = new RepoInspector(root).detectProjectSignatures();
  console.log(`\nRepository signatures for ${root}:`);
  console.log(JSON.stringify(signatures, null, 2));
  console.log('\nUse these as evidence when badging nodes VERIFIED vs INFERRED.\n');
}

function commandInit(args) {
  const opts = parseOptions(args);
  const targetPath = path.resolve(opts._[0] || 'architecture.json');
  if (fs.existsSync(targetPath)) fail(`Refusing to overwrite existing file: ${targetPath}`);
  const starter = { ...STARTER_SPEC, meta: { ...STARTER_SPEC.meta, date: new Date().toISOString().split('T')[0] } };
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(starter, null, 2), 'utf8');
  console.log(`Initialized starter architecture specification at: ${targetPath}`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  case 'validate':
    commandValidate(rest);
    break;
  case 'build':
    commandBuild(rest);
    break;
  case 'mermaid':
    commandMermaid(rest);
    break;
  case 'scaffold':
    commandScaffold(rest);
    break;
  case 'inspect':
    commandInspect(rest);
    break;
  case 'init':
    commandInit(rest);
    break;
  default:
    console.error(`Error: Unknown command "${command}".`);
    console.log(HELP);
    process.exit(1);
}
