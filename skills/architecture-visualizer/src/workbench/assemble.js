/**
 * Assembles the workbench template from shell.html and its style and script modules.
 *
 * A line in shell.html of the form `<indent><!-- include: styles/canvas.css -->` is replaced by that file,
 * every non-empty line indented to match. The modules are slices of one page: all scripts share a single
 * <script> scope, so their order in shell.html is their execution order. The result is the template the
 * compiler fills in; it stays one offline HTML file with no external references.
 */

const fs = require('node:fs');
const path = require('node:path');

const WORKBENCH_DIR = __dirname;
const INCLUDE_LINE = /^( *)<!-- include: ([^\s]+) -->$/gm;

function readModule(dir, relPath) {
  // A relative or trailing-slash dir must still contain its own includes.
  const root = path.resolve(dir);
  const resolved = path.resolve(root, relPath);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Workbench include escapes the workbench directory: ${relPath}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Workbench include not found: ${relPath}`);
  }
  const source = fs.readFileSync(resolved, 'utf8');
  if (/<!-- include: /.test(source)) {
    throw new Error(`Workbench modules may not include other modules: ${relPath}`);
  }
  return source.endsWith('\n') ? source.slice(0, -1) : source;
}

function indentBlock(text, indent) {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : indent + line))
    .join('\n');
}

/**
 * @param {string} [dir] workbench directory (defaults to this module's directory)
 * @returns {{ html: string, modules: string[] }} the template and the modules it includes, in order
 */
function assembleWorkbench(dir = WORKBENCH_DIR) {
  const shell = fs.readFileSync(path.join(dir, 'shell.html'), 'utf8');
  const modules = [];
  const html = shell.replace(INCLUDE_LINE, (_, indent, relPath) => {
    if (modules.includes(relPath)) throw new Error(`Workbench module included twice: ${relPath}`);
    modules.push(relPath);
    return indentBlock(readModule(dir, relPath), indent);
  });
  return { html, modules };
}

// The built page drops each line's leading indentation (about 30 KB). This is safe because no
// whitespace-sensitive text is authored in the workbench: multi-line template literals only build
// HTML for innerHTML, and the shell has no <pre> or <textarea> content. A test guards both.
function loadTemplate(dir = WORKBENCH_DIR) {
  return compactSource(assembleWorkbench(dir).html);
}

// Drops leading indentation, lines that are only a `//` comment, and lines that are only a one-line
// `/* ... */` comment. Only whole lines go, so code, strings and markup on a line are never cut.
function compactSource(text) {
  return text
    .replace(/^[ \t]+/gm, '')
    .replace(/^\/\/[^\n]*\n/gm, '')
    // Build placeholders such as /* __GEOMETRY_RUNTIME__ */ are comments too, and must survive.
    .replace(/^\/\*(?![^\n]*__[A-Z_]+__)[^\n]*?\*\/[ \t]*\n/gm, '');
}

module.exports = { assembleWorkbench, loadTemplate, compactSource, WORKBENCH_DIR };
