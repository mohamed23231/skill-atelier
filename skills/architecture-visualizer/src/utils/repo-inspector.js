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
  const realCandidate = exists ? realPathOr(candidate) : candidate;
  const inside = exists ? isWithin(realRoot, realCandidate) : lexicallyInside;
  if (!inside) {
    return { absolutePath: candidate, relativePath: null, inside: false };
  }
  const relativePath = (lexicallyInside ? path.relative(root, candidate) : path.relative(realRoot, realCandidate)).split(path.sep).join('/');
  return { absolutePath: candidate, relativePath, inside: true, exists };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsSymbol(content, symbol) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}($|[^A-Za-z0-9_$])`);
  return pattern.test(content);
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

    if (result.type === EVIDENCE_TYPE.API || result.type === EVIDENCE_TYPE.TABLE) {
      const filePath = result.locator.path;
      if (!filePath) {
        result.verification = EVIDENCE_VERIFICATION.COMPATIBILITY;
        result.exists = false;
        return result;
      }
    }

    const relativePath = result.locator.path || result.locator.document;
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
  EVIDENCE_TYPE,
  EVIDENCE_VERIFICATION,
  EVIDENCE_ORIGIN,
};
