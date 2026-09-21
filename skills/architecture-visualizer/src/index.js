const { validateArchitecture, runQualityGate } = require('./engine/validator.js');
const { computeLayout, buildEdgeGeometry } = require('./engine/layout.js');
const { compileArchitecture, generateMarkdownReport } = require('./engine/compiler.js');
const { exportToMermaid } = require('./utils/mermaid-exporter.js');
const { RepoInspector } = require('./utils/repo-inspector.js');
const { STARTER_SPEC } = require('./utils/starter-spec.js');
const { scaffoldFromDiff } = require('./utils/diff-scaffold.js');

module.exports = {
  validateArchitecture,
  runQualityGate,
  computeLayout,
  buildEdgeGeometry,
  compileArchitecture,
  generateMarkdownReport,
  exportToMermaid,
  RepoInspector,
  STARTER_SPEC,
  scaffoldFromDiff
};
