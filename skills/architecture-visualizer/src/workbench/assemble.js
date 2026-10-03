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
  const resolved = path.resolve(dir, relPath);
  if (!resolved.startsWith(dir + path.sep)) {
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

function loadTemplate(dir = WORKBENCH_DIR) {
  return assembleWorkbench(dir).html;
}

module.exports = { assembleWorkbench, loadTemplate, WORKBENCH_DIR };
