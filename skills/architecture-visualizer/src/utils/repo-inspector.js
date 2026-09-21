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

function resolveRepoPath(repoRoot, targetPath) {
  if (!targetPath) return null;
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
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
    const target = resolveRepoPath(this.repoRoot, relativePath);
    return fs.existsSync(target);
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

    const absolutePath = resolveRepoPath(this.repoRoot, relativePath);
    result.absolutePath = absolutePath;
    result.exists = fs.existsSync(absolutePath);
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
      result.symbolFound = content.includes(symbol);
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
      const target = path.isAbsolute(filePath) ? filePath : path.resolve(this.repoRoot, filePath);
      const exists = fs.existsSync(target);
      return {
        path: filePath,
        exists,
        absolutePath: target,
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
  EVIDENCE_TYPE,
  EVIDENCE_VERIFICATION,
  EVIDENCE_ORIGIN,
};
