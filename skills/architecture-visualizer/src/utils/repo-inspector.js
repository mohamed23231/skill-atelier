const fs = require('node:fs');
const path = require('node:path');

const EVIDENCE_TYPE = {
  FILE: 'file',
  SYMBOL: 'symbol',
  API: 'api',
  TABLE: 'table',
  COMMAND: 'command',
  DOCUMENT: 'document',
  ASSERTION: 'assertion',
};

const EVIDENCE_VERIFICATION = {
  VERIFIED: 'verified',
  UNRESOLVED: 'unresolved',
  STALE: 'stale',
  ASSERTED: 'asserted',
  COMPATIBILITY: 'compatibility',
};

const EVIDENCE_ORIGIN = {
  AUTHOR: 'author',
  LEGACY_FILES: 'legacy-files',
  LEGACY_APIS: 'legacy-apis',
  LEGACY_TABLES: 'legacy-tables',
  SCAFFOLD: 'scaffold',
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function realPathOr(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

// Real path of the nearest existing ancestor, with the missing tail re-appended,
// so a not-yet-created file under an outbound symlink still resolves outside.
function realPathOfNearest(target) {
  let current = target;
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return target;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realPathOr(current), ...tail);
}

// True only for a path strictly below root: the root itself grounds nothing.
function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolves a locator path against the repository root and reports whether it
 * stays strictly under it. Absolute paths, `../` escapes, symlinks that lead
 * out of the root, and the root itself all count as outside. Only the repo-relative path is returned, so no
 * machine-local absolute path reaches a generated artifact.
 */
function resolveRepoPath(repoRoot, targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(root, targetPath);
  const exists = fs.existsSync(candidate);
  const lexicallyInside = isWithin(root, candidate);
  // For a path that exists, where it really lives decides: a symlink out of the
  // repo is outside, an alias of the repo root (e.g. /var vs /private/var) is not.
  const realRoot = realPathOr(root);
  const realCandidate = realPathOfNearest(candidate);
  const inside = isWithin(realRoot, realCandidate);
  if (!inside) {
    return { absolutePath: candidate, relativePath: null, inside: false };
  }
  const relativePath = (lexicallyInside ? path.relative(root, candidate) : path.relative(realRoot, realCandidate)).split(path.sep).join('/');
  return { absolutePath: candidate, relativePath, inside: true, exists };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const IDENTIFIER_CHAR = '\\p{ID_Continue}$\\u200C\\u200D';

function containsSymbol(content, symbol) {
  const pattern = new RegExp(`(^|[^${IDENTIFIER_CHAR}])${escapeRegExp(symbol)}($|[^${IDENTIFIER_CHAR}])`, 'u');
  return pattern.test(content);
}

/**
 * The form of a locator path that is safe to publish in an artifact: an
 * absolute path under the root becomes repo-relative, and any path that
 * resolves outside the root (absolute or `../`) keeps only its file name, so no
 * machine-local directory leaks. Relative paths inside the root are kept.
 */
function displayRepoPath(repoRoot, targetPath) {
  if (typeof targetPath !== 'string' || targetPath === '') return targetPath;
  const resolved = resolveRepoPath(repoRoot, targetPath);
  if (resolved && resolved.inside) return path.isAbsolute(targetPath) ? resolved.relativePath : targetPath;
  return `<outside repository>/${path.basename(targetPath)}`;
}

function countLines(content) {
  return content.split(/\r?\n/).length;
}

/**
 * Inspects a local repository to discover architectural components,
 * verify file paths, and gather evidence for architectural modeling.
 */
class RepoInspector {
  constructor(repoRoot = process.cwd()) {
    this.repoRoot = path.resolve(repoRoot);
  }

  /**
   * Checks whether a file or directory exists relative to repoRoot.
   */
  exists(relativePath) {
    if (!relativePath) return false;
    const resolved = resolveRepoPath(this.repoRoot, relativePath);
    return Boolean(resolved && resolved.inside && resolved.exists);
  }

  inspectEvidence(record = {}) {
    const result = cloneJson(record);
    if (!result.locator || typeof result.locator !== 'object') {
      result.locator = {};
    }

    if (result.type === EVIDENCE_TYPE.ASSERTION) {
      result.verification = EVIDENCE_VERIFICATION.ASSERTED;
      result.exists = false;
      return result;
    }

    if (result.type === EVIDENCE_TYPE.COMMAND) {
      result.verification = EVIDENCE_VERIFICATION.ASSERTED;
      result.exists = false;
      return result;
    }

    // An API locator's `path` is the route (`/api/orders`), not a file, so only
    // an explicit `file` is checked against the repository.
    const fileField = result.type === EVIDENCE_TYPE.API ? 'file' : 'path';
    if (result.type === EVIDENCE_TYPE.API || result.type === EVIDENCE_TYPE.TABLE) {
      if (!result.locator[fileField]) {
        result.verification = EVIDENCE_VERIFICATION.COMPATIBILITY;
        result.exists = false;
        return result;
      }
    }

    const relativePath = result.locator[fileField] || result.locator.document;
    if (!relativePath) {
      result.verification = EVIDENCE_VERIFICATION.UNRESOLVED;
      result.exists = false;
      return result;
    }

    const resolved = resolveRepoPath(this.repoRoot, relativePath);
    if (!resolved || !resolved.inside) {
      result.verification = EVIDENCE_VERIFICATION.UNRESOLVED;
      result.exists = false;
      result.outsideRepo = true;
      return result;
    }
    const absolutePath = resolved.absolutePath;
    result.resolvedPath = resolved.relativePath;
    result.exists = resolved.exists;
    if (!result.exists) {
      result.verification = EVIDENCE_VERIFICATION.UNRESOLVED;
      return result;
    }

    const needsContent = result.locator.symbol || result.type === EVIDENCE_TYPE.SYMBOL || result.locator.startLine != null || result.locator.endLine != null;

    if (!needsContent) {
      result.verification = EVIDENCE_VERIFICATION.VERIFIED;
      return result;
    }

    let content;
    try {
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      result.verification = EVIDENCE_VERIFICATION.UNRESOLVED;
      return result;
    }

    result.lineCount = countLines(content);
    result.verification = EVIDENCE_VERIFICATION.VERIFIED;

    if (result.locator.startLine != null || result.locator.endLine != null) {
      const startLine = result.locator.startLine;
      const endLine = result.locator.endLine;
      const invalidStart = startLine != null && (startLine < 1 || startLine > result.lineCount);
      const invalidEnd = endLine != null && (endLine < 1 || endLine > result.lineCount);
      const inverted = startLine != null && endLine != null && endLine < startLine;
      if (invalidStart || invalidEnd || inverted) {
        result.verification = EVIDENCE_VERIFICATION.STALE;
      }
    }

    if (result.locator.symbol || result.type === EVIDENCE_TYPE.SYMBOL) {
      const symbol = result.locator.symbol;
      if (!symbol) {
        result.verification = EVIDENCE_VERIFICATION.UNRESOLVED;
        return result;
      }
      // Match the whole identifier, and only inside the cited line range when
      // one is given and valid, so "create" does not verify "createOrder".
      let scope = content;
      if (result.verification !== EVIDENCE_VERIFICATION.STALE && (result.locator.startLine != null || result.locator.endLine != null)) {
        const lines = content.split(/\r?\n/);
        scope = lines.slice((result.locator.startLine || 1) - 1, result.locator.endLine || lines.length).join('\n');
      }
      result.symbolFound = containsSymbol(scope, String(symbol));
      if (!result.symbolFound) {
        result.verification = EVIDENCE_VERIFICATION.STALE;
      }
    }

    return result;
  }

  /**
   * Verifies an array of files or file objects.
   * Returns verified files with actual existence flags.
   */
  verifyFiles(files = []) {
    return files.map((entry) => {
      const filePath = typeof entry === 'string' ? entry : entry?.path;
      const resolved = resolveRepoPath(this.repoRoot, filePath);
      const inside = Boolean(resolved && resolved.inside);
      return {
        path: filePath,
        exists: inside && Boolean(resolved.exists),
        insideRepo: inside,
        resolvedPath: inside ? resolved.relativePath : null,
      };
    });
  }

  /**
   * Scans project root for common architectural markers
   */
  detectProjectSignatures() {
    const signatures = {
      isMonorepo: false,
      frameworks: [],
      languages: [],
      services: [],
      databases: [],
      queues: [],
    };

    // Check package.json
    const pkgPath = path.join(this.repoRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        signatures.languages.push('JavaScript/TypeScript');

        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        if (deps['react-native']) signatures.frameworks.push('React Native');
        if (deps['next']) signatures.frameworks.push('Next.js');
        if (deps['express']) signatures.frameworks.push('Express');
        if (deps['@nestjs/core']) signatures.frameworks.push('NestJS');
        if (deps['fastify']) signatures.frameworks.push('Fastify');
        if (deps['pg'] || deps['typeorm'] || deps['prisma']) signatures.databases.push('PostgreSQL/SQL');
        if (deps['redis'] || deps['ioredis']) signatures.databases.push('Redis');
        if (deps['kafkajs']) signatures.queues.push('Kafka');
        if (deps['amqplib']) signatures.queues.push('RabbitMQ');

        if (pkg.workspaces || fs.existsSync(path.join(this.repoRoot, 'packages')) || fs.existsSync(path.join(this.repoRoot, 'marketplaces'))) {
          signatures.isMonorepo = true;
        }
      } catch {
        // ignore parse error
      }
    }

    // Check docker-compose
    if (fs.existsSync(path.join(this.repoRoot, 'docker-compose.yml')) || fs.existsSync(path.join(this.repoRoot, 'compose.yaml'))) {
      signatures.hasDockerCompose = true;
    }

    // Check Go
    if (fs.existsSync(path.join(this.repoRoot, 'go.mod'))) {
      signatures.languages.push('Go');
    }

    // Check Rust
    if (fs.existsSync(path.join(this.repoRoot, 'Cargo.toml'))) {
      signatures.languages.push('Rust');
    }

    // Check Python
    if (fs.existsSync(path.join(this.repoRoot, 'pyproject.toml')) || fs.existsSync(path.join(this.repoRoot, 'requirements.txt'))) {
      signatures.languages.push('Python');
    }

    return signatures;
  }
}

module.exports = {
  RepoInspector,
  resolveRepoPath,
  displayRepoPath,
  EVIDENCE_TYPE,
  EVIDENCE_VERIFICATION,
  EVIDENCE_ORIGIN,
};
