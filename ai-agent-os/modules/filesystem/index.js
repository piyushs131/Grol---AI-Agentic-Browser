const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { CapabilityModule } = require('../../shared/schemas/capability-schema');

const PROTECTED_DIRS_WIN = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  'C:\\ProgramData', 'C:\\$Recycle.Bin', 'C:\\System Volume Information'
];
const PROTECTED_DIRS_UNIX = [
  '/bin', '/sbin', '/usr', '/etc', '/var', '/boot', '/proc', '/sys', '/dev', '/System', '/root',
  '/lib', '/lib64', '/private/etc', '/private/var', '/opt/homebrew',
  '/Library/LaunchAgents', '/Library/LaunchDaemons', '/Library/Keychains', '/Library/Security'
];
// Per-user temp lives under /var/folders on macOS.
const ALLOWED_UNDER_PROTECTED = ['/var/folders', '/private/var/folders'];
// Credentials and anything that runs code at login or in every new shell.
const PROTECTED_IN_HOME = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.netrc', '.git-credentials',
  '.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile',
  'Library/Keychains', 'Library/Cookies', 'Library/LaunchAgents', 'Library/Application Support/com.apple.TCC',
  'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup'
];
const ALIASES = {
  desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures',
  music: 'Music', videos: 'Videos', movies: 'Movies', onedrive: 'OneDrive'
};
// Folders that must never be deleted or moved away wholesale.
const UNREMOVABLE_IN_HOME = [...Object.values(ALIASES), 'Library', 'Applications', 'AppData'];

const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ITEMS = 5000;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_ENTRIES = 50000;
const SEARCH_DEPTH = 5;
const LIST_DEPTH = 3;

const isInside = (child, parent, caseless) => {
  const [c, p] = caseless ? [child.toLowerCase(), parent.toLowerCase()] : [child, parent];
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };

// Resolves symlinks through the deepest existing ancestor, so a link inside an
// allowed folder cannot point into a protected one. A dangling link is followed
// too: writing through it would create its target.
function realPath(target, hops = 0) {
  if (hops > 40) throw new Error(`Too many levels of symbolic links: ${target}`);
  let existing = target;
  const rest = [];
  while (!lexists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...rest);
  } catch (_) {
    let link;
    try { link = fs.readlinkSync(existing); } catch (_) { return target; }
    return realPath(path.join(path.resolve(path.dirname(existing), link), ...rest), hops + 1);
  }
}

// "*.txt" / "test-?" are globs; anything else is a case-insensitive substring match.
function globMatcher(pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    const plain = pattern.toLowerCase();
    return (name) => name.toLowerCase().includes(plain);
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return (name) => regex.test(name);
}

// Path policy: aliases (desktop/, ~/...) stay inside their folder, relative
// paths are relative to home, and system / credential locations are refused.
class PathPolicy {
  constructor({ platform = process.platform, home = os.homedir() } = {}) {
    this.platform = platform;
    this.home = path.resolve(home);
    this.caseless = platform === 'win32' || platform === 'darwin';
    this.systemDirs = platform === 'win32' ? PROTECTED_DIRS_WIN : PROTECTED_DIRS_UNIX;
    // Both spellings, so a symlinked home (/var -> /private/var) is matched either way;
    // the account's real home stays protected even when another home is configured.
    const homes = [...new Set([this.home, os.homedir()].flatMap((h) => [path.resolve(h), realPath(path.resolve(h))]))];
    const inHomes = (list) => homes.flatMap((h) => list.map((p) => path.join(h, ...p.split('/'))));
    this.homes = homes;
    this.homeDirs = inHomes(PROTECTED_IN_HOME);
    this.unremovable = [
      ...inHomes(UNREMOVABLE_IN_HOME),
      ...(process.env.APPDATA ? [process.env.APPDATA] : []),
      path.resolve(os.tmpdir()),
      realPath(path.resolve(os.tmpdir()))
    ];
  }

  aliasRoot(name) {
    if (name === '~') return this.home;
    if (name === 'appdata') return process.env.APPDATA || path.join(this.home, 'AppData', 'Roaming');
    return Object.prototype.hasOwnProperty.call(ALIASES, name) ? path.join(this.home, ALIASES[name]) : null;
  }

  expand(targetPath) {
    const p = targetPath.trim();
    const m = /^([^/\\]+)(?:[/\\](.*))?$/s.exec(p);
    const root = m && this.aliasRoot(m[1] === '~' ? '~' : m[1].toLowerCase());
    if (!root) return path.resolve(this.home, p);
    const full = path.resolve(root, m[2] || '');
    if (!isInside(full, root, this.caseless)) throw new Error(`Access denied: ${targetPath} escapes ${m[1]}`);
    return full;
  }

  isProtected(p) {
    const inSystem = this.systemDirs.some((dir) => isInside(p, dir, this.caseless)) &&
      !ALLOWED_UNDER_PROTECTED.some((ok) => isInside(p, ok, this.caseless));
    return inSystem || this.homeDirs.some((dir) => isInside(p, dir, this.caseless));
  }

  resolve(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('path is required');
    if (targetPath.includes('\0')) throw new Error('path contains a NUL byte');
    const resolved = this.expand(targetPath);
    if (this.isProtected(resolved) || this.isProtected(realPath(resolved))) {
      throw new Error(`Access denied: ${resolved} is in a protected system directory`);
    }
    return resolved;
  }

  same(a, b) {
    return this.caseless ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  // Home, its ancestors, filesystem roots and the standard user folders.
  assertRemovable(p) {
    for (const candidate of new Set([p, realPath(p)])) {
      if (path.parse(candidate).root === candidate ||
          this.homes.some((h) => isInside(h, candidate, this.caseless)) ||
          this.unremovable.some((dir) => this.same(candidate, dir))) {
        throw new Error(`Refusing to delete or move ${candidate}: it is a protected folder`);
      }
    }
  }
}

function toEncoding(encoding) {
  if (encoding === undefined || encoding === null) return 'utf8';
  if (typeof encoding !== 'string' || !Buffer.isEncoding(encoding)) throw new Error(`Unsupported encoding '${encoding}'`);
  return encoding;
}

function toContent(content) {
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  throw new Error('content must be a string');
}

const entryType = (entry) => (entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file');

class FilesystemModule extends CapabilityModule {
  constructor() {
    super('filesystem', 'File and directory operations with safety controls');
  }

  async initialize(context = {}) {
    await super.initialize(context);
    this.platform = context.platform || process.platform;
    this.policy = new PathPolicy({ platform: this.platform, home: context.homeDir || os.homedir() });

    this.registerAction('readFile', this.readFile, {
      description: 'Read the contents of a file',
      parameters: ['path', 'encoding'],
      riskLevel: 'low'
    });

    this.registerAction('writeFile', this.writeFile, {
      description: 'Write content to a file (creates or overwrites)',
      parameters: ['path', 'content', 'encoding'],
      riskLevel: 'high'
    });

    this.registerAction('appendFile', this.appendFile, {
      description: 'Append content to a file',
      parameters: ['path', 'content'],
      riskLevel: 'medium'
    });

    this.registerAction('listDirectory', this.listDirectory, {
      description: 'List contents of a directory',
      parameters: ['path', 'recursive'],
      riskLevel: 'low'
    });

    this.registerAction('searchFiles', this.searchFiles, {
      description: 'Search for files matching a pattern',
      parameters: ['query', 'directory', 'maxResults'],
      riskLevel: 'low'
    });

    this.registerAction('copyFile', this.copyFile, {
      description: 'Copy a file to a new location',
      parameters: ['source', 'destination'],
      riskLevel: 'medium'
    });

    this.registerAction('moveFile', this.moveFile, {
      description: 'Move or rename a file',
      parameters: ['source', 'destination'],
      riskLevel: 'high'
    });

    this.registerAction('deleteFile', this.deleteFile, {
      description: 'Delete a file',
      parameters: ['path'],
      riskLevel: 'critical',
      requiresConfirmation: true
    });

    this.registerAction('deleteDirectory', this.deleteDirectory, {
      description: 'Delete a directory and its contents',
      parameters: ['path'],
      riskLevel: 'critical',
      requiresConfirmation: true
    });

    this.registerAction('createDirectory', this.createDirectory, {
      description: 'Create a new directory',
      parameters: ['path'],
      riskLevel: 'medium'
    });

    this.registerAction('getFileInfo', this.getFileInfo, {
      description: 'Get metadata about a file',
      parameters: ['path'],
      riskLevel: 'low'
    });

    this.registerAction('exists', this.exists, {
      description: 'Check if a file or directory exists',
      parameters: ['path'],
      riskLevel: 'low'
    });

    this.registerAction('watchDirectory', this.watchDirectory, {
      description: 'Start watching a directory for changes',
      parameters: ['path'],
      riskLevel: 'low'
    });
  }

  _validatePath(targetPath) {
    return this.policy.resolve(targetPath);
  }

  // Copy/move into an existing folder keeps the source's file name.
  async _destination(source, destination) {
    const dest = this._validatePath(destination);
    const stat = await fsp.stat(dest).catch(() => null);
    return stat && stat.isDirectory() ? this._validatePath(path.join(dest, path.basename(source))) : dest;
  }

  async readFile({ path: filePath, encoding } = {}) {
    const safePath = this._validatePath(filePath);
    const enc = toEncoding(encoding);
    const stat = await fsp.stat(safePath);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${safePath}`);
    if (stat.size > MAX_READ_BYTES) throw new Error(`File exceeds the ${MAX_READ_BYTES / 1024 / 1024}MB read limit`);
    const content = await fsp.readFile(safePath, enc);
    return { path: safePath, content, size: stat.size, encoding: enc };
  }

  async writeFile({ path: filePath, content, encoding } = {}) {
    const safePath = this._validatePath(filePath);
    const data = toContent(content);
    const enc = toEncoding(encoding);
    await fsp.mkdir(path.dirname(safePath), { recursive: true });
    await fsp.writeFile(safePath, data, enc);
    const stat = await fsp.stat(safePath);
    return { path: safePath, size: stat.size, written: true };
  }

  async appendFile({ path: filePath, content } = {}) {
    const safePath = this._validatePath(filePath);
    await fsp.appendFile(safePath, toContent(content), 'utf8');
    return { path: safePath, appended: true };
  }

  async listDirectory({ path: dirPath, recursive = false } = {}) {
    const safePath = this._validatePath(dirPath || this.policy.home);
    if (recursive === true || recursive === 'true') {
      const budget = { left: MAX_LIST_ITEMS };
      const items = await this._listRecursive(safePath, LIST_DEPTH, 0, budget);
      return { path: safePath, items, count: items.length, truncated: budget.left <= 0 };
    }
    const entries = await fsp.readdir(safePath, { withFileTypes: true });
    const items = entries.slice(0, MAX_LIST_ITEMS).map((entry) => ({
      name: entry.name,
      type: entryType(entry),
      path: path.join(safePath, entry.name)
    }));
    return { path: safePath, items, count: items.length, truncated: entries.length > MAX_LIST_ITEMS };
  }

  async _listRecursive(dirPath, maxDepth, depth, budget) {
    if (depth >= maxDepth || budget.left <= 0) return [];
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (budget.left-- <= 0) break;
      const fullPath = path.join(dirPath, entry.name);
      const item = { name: entry.name, type: entryType(entry), path: fullPath };
      items.push(item);
      if (entry.isDirectory() && !entry.name.startsWith('.') && !this.policy.isProtected(fullPath)) {
        try { item.children = await this._listRecursive(fullPath, maxDepth, depth + 1, budget); } catch {}
      }
    }
    return items;
  }

  async searchFiles({ query, pattern, directory, maxResults = 50 } = {}) {
    const searchTerm = String(query ?? pattern ?? '');
    const searchDir = this._validatePath(directory || this.policy.home);
    const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.round(Number(maxResults)) || 50));
    const state = { results: [], limit, entriesLeft: MAX_SEARCH_ENTRIES };
    await this._searchRecursive(searchDir, globMatcher(searchTerm), state, 0);
    return { query: searchTerm, directory: searchDir, results: state.results, count: state.results.length,
      truncated: state.results.length >= limit || state.entriesLeft <= 0 };
  }

  async _searchRecursive(dirPath, matches, state, depth) {
    if (depth >= SEARCH_DEPTH || state.results.length >= state.limit || state.entriesLeft <= 0) return;
    let entries;
    try { entries = await fsp.readdir(dirPath, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (state.results.length >= state.limit || state.entriesLeft-- <= 0) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dirPath, entry.name);
      if (this.policy.isProtected(fullPath)) continue;
      if (matches(entry.name)) {
        try {
          const stat = await fsp.lstat(fullPath);
          state.results.push({
            name: entry.name,
            path: fullPath,
            type: entryType(entry),
            size: stat.size,
            modified: stat.mtime.toISOString()
          });
        } catch {}
      }
      if (entry.isDirectory()) await this._searchRecursive(fullPath, matches, state, depth + 1);
    }
  }

  async copyFile({ source, destination } = {}) {
    const safeSrc = this._validatePath(source);
    const stat = await fsp.stat(safeSrc);
    if (!stat.isFile()) throw new Error(`Only files can be copied: ${safeSrc}`);
    const safeDest = await this._destination(safeSrc, destination);
    if (this.policy.same(realPath(safeSrc), realPath(safeDest))) throw new Error('Source and destination are the same file');
    await fsp.mkdir(path.dirname(safeDest), { recursive: true });
    await fsp.copyFile(safeSrc, safeDest);
    return { source: safeSrc, destination: safeDest, copied: true };
  }

  async moveFile({ source, destination } = {}) {
    const safeSrc = this._validatePath(source);
    this.policy.assertRemovable(safeSrc);
    await fsp.lstat(safeSrc);
    const safeDest = await this._destination(safeSrc, destination);
    if (this.policy.same(realPath(safeSrc), realPath(safeDest))) throw new Error('Source and destination are the same');
    if (isInside(realPath(safeDest), realPath(safeSrc), this.policy.caseless)) {
      throw new Error('Cannot move a folder into itself');
    }
    await fsp.mkdir(path.dirname(safeDest), { recursive: true });
    try {
      await fsp.rename(safeSrc, safeDest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      await fsp.cp(safeSrc, safeDest, { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(safeSrc, { recursive: true });
    }
    return { source: safeSrc, destination: safeDest, moved: true };
  }

  async deleteFile({ path: filePath } = {}) {
    const safePath = this._validatePath(filePath);
    this.policy.assertRemovable(safePath);
    const stat = await fsp.lstat(safePath);
    if (stat.isDirectory()) throw new Error(`${safePath} is a directory; use deleteDirectory`);
    await fsp.unlink(safePath);
    return { path: safePath, deleted: true };
  }

  async deleteDirectory({ path: dirPath } = {}) {
    const safePath = this._validatePath(dirPath);
    this.policy.assertRemovable(safePath);
    const stat = await fsp.lstat(safePath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`${safePath} is not a directory; use deleteFile`);
    await fsp.rm(safePath, { recursive: true });
    return { path: safePath, deleted: true };
  }

  async createDirectory({ path: dirPath } = {}) {
    const safePath = this._validatePath(dirPath);
    await fsp.mkdir(safePath, { recursive: true });
    return { path: safePath, created: true };
  }

  async getFileInfo({ path: filePath } = {}) {
    const safePath = this._validatePath(filePath);
    const stat = await fsp.stat(safePath);
    return {
      path: safePath,
      name: path.basename(safePath),
      extension: path.extname(safePath),
      size: stat.size,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      accessed: stat.atime.toISOString(),
      permissions: stat.mode.toString(8)
    };
  }

  async exists({ path: filePath } = {}) {
    const safePath = this._validatePath(filePath);
    try {
      const stat = await fsp.stat(safePath);
      return { path: safePath, exists: true, type: stat.isDirectory() ? 'directory' : 'file' };
    } catch {
      return { path: safePath, exists: false };
    }
  }

  async watchDirectory({ path: dirPath } = {}) {
    const safePath = this._validatePath(dirPath);
    const entries = await fsp.readdir(safePath);
    return {
      path: safePath,
      watching: true,
      currentFiles: entries,
      note: 'Use the event trigger system to set up persistent file watching'
    };
  }
}

module.exports = FilesystemModule;
module.exports.PathPolicy = PathPolicy;
module.exports.__test = { realPath, globMatcher, isInside, toEncoding, toContent, MAX_READ_BYTES };
