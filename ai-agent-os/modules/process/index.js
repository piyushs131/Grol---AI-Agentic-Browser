const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CapabilityModule } = require('../../shared/schemas/capability-schema');
const macInput = require('../desktop/mac-input');
const windowsApps = require('./windows-apps');

const BLOCKED_COMMANDS = [
  /\brm\s+(?:-\S+\s+)*(?:--no-preserve-root\s+)?(?:\/|~\/?|\$HOME\/?)(?:\*|\s|$)/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i,
  /\bmkfs(?:\.|\s)/i,
  /\bdd\s+[^|;&]*\bof=\/dev\//i,
  /\bdiskutil\s+(?:erase|zero|secureErase|partitionDisk)/i,
  />\s*\/dev\/(?:sd|disk|nvme)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
];

const WINDOW_ALIASES = [
  ['chrome', 'google chrome'],
  ['edge', 'microsoft edge'],
  ['code', 'vscode', 'visual studio code']
];

const MAX_COMMAND_LENGTH = 16 * 1024;
const MAX_STDOUT = 10000;
const MAX_STDERR = 5000;
const MAX_CAPTURE = 5 * 1024 * 1024;
const MIN_TIMEOUT = 100;
const MAX_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_TIMEOUT = 30000;

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    cp.execFile(file, args, { maxBuffer: 16 << 20, windowsHide: true, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function appName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 256 || /[\0\r\n]/.test(n)) {
    throw new Error('Application name must be a non-empty single-line string');
  }
  return n;
}

function toArgs(args) {
  if (args === undefined || args === null) return [];
  const list = typeof args === 'string' ? [args] : args;
  if (!Array.isArray(list) || list.some((a) => typeof a !== 'string' && typeof a !== 'number')) {
    throw new Error('args must be an array of strings');
  }
  return list.map(String);
}

function toTimeout(timeout) {
  if (timeout === undefined || timeout === null) return DEFAULT_TIMEOUT;
  const n = Number(timeout);
  if (!Number.isFinite(n) || n <= 0) throw new Error('timeout must be a positive number of milliseconds');
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(n)));
}

function toCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return os.homedir();
  if (typeof cwd !== 'string') throw new Error('cwd must be a string');
  const home = os.homedir();
  const expanded = cwd === '~' ? home : /^~[/\\]/.test(cwd) ? path.join(home, cwd.slice(2)) : cwd;
  const dir = path.resolve(home, expanded);
  let stat;
  try { stat = fs.statSync(dir); } catch (_) { throw new Error(`cwd does not exist: ${dir}`); }
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${dir}`);
  return dir;
}

const OPEN_ALIASES = { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures',
  music: 'Music', movies: 'Movies', videos: 'Videos' };

function toOpenPath(p) {
  if (p === undefined || p === null || p === '') return null;
  if (typeof p !== 'string' || /[\0\r\n]/.test(p)) throw new Error('path must be a single-line string');
  const home = os.homedir();
  const s = p.trim();
  if (/^(https?|mailto):/i.test(s)) {
    try { return new URL(s).href; } catch (_) { throw new Error(`not a valid URL: ${s.slice(0, 120)}`); }
  }
  const m = /^([^/\\]+)(?:[/\\](.*))?$/s.exec(s);
  const alias = m && Object.prototype.hasOwnProperty.call(OPEN_ALIASES, m[1].toLowerCase()) ? OPEN_ALIASES[m[1].toLowerCase()] : null;
  const full = s === '~' ? home
    : /^~[/\\]/.test(s) ? path.join(home, s.slice(2))
      : alias ? path.join(home, alias, m[2] || '')
        : path.resolve(home, s);
  if (!fs.existsSync(full)) throw new Error(`path does not exist: ${full}`);
  return full;
}

function toPid(pid) {
  const s = String(pid ?? '').trim();
  if (!/^\d+$/.test(s)) throw new Error('PID must be a positive integer');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 1 || n > 0x7fffffff) throw new Error(`Refusing to kill PID ${s}`);
  if (n === process.pid || n === process.ppid) throw new Error('Refusing to kill the OS Control helper itself');
  return n;
}

function assertAllowedCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`command is longer than ${MAX_COMMAND_LENGTH} characters`);
  if (command.includes('\0')) throw new Error('command contains a NUL byte');
  if (BLOCKED_COMMANDS.some((re) => re.test(command))) throw new Error('Command blocked: matches a dangerous pattern');
}

function capture(limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (size >= limit) { truncated = true; return; }
      const part = chunk.length > limit - size ? chunk.subarray(0, limit - size) : chunk;
      truncated = truncated || part.length < chunk.length;
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    get truncated() { return truncated; }
  };
}

const MAC_APP_CLIS = [
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin',
  '/Applications/Cursor.app/Contents/Resources/app/bin'
];
let shellPathCache = null;

function loginShellPath() {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = cp.execFileSync(shell, ['-l', '-c', 'printf "__P__%s__P__" "$PATH"'],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /__P__(.*?)__P__/s.exec(out);
    return m ? m[1].split(':') : [];
  } catch (_) {
    return [];
  }
}

function etcPaths() {
  const files = ['/etc/paths'];
  try { for (const f of fs.readdirSync('/etc/paths.d')) files.push(path.join('/etc/paths.d', f)); } catch (_) {}
  return files.flatMap((f) => { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch (_) { return []; } });
}

function shellPath(platform = process.platform) {
  if (platform === 'win32') return process.env.PATH || '';
  if (shellPathCache === null) {
    const home = os.homedir();
    const dirs = [
      ...loginShellPath(),
      '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
      path.join(home, '.local/bin'), path.join(home, '.volta/bin'), path.join(home, '.bun/bin'),
      path.join(home, '.cargo/bin'), path.join(home, '.deno/bin'),
      ...(platform === 'darwin' ? MAC_APP_CLIS : []),
      ...(process.env.PATH || '').split(':'),
      ...etcPaths()
    ].map((d) => d.trim()).filter((d) => d && path.isAbsolute(d));
    shellPathCache = [...new Set(dirs)].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } }).join(':');
  }
  return shellPathCache;
}

function runShell(command, { cwd, timeout, platform = process.platform }) {
  return new Promise((resolve) => {
    const win = platform === 'win32';
    const child = win
      ? cp.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`],
        { cwd, windowsHide: true, windowsVerbatimArguments: true })
      : cp.spawn('/bin/sh', ['-c', command], { cwd, detached: true, env: { ...process.env, PATH: shellPath(platform) } });
    const out = capture(MAX_CAPTURE);
    const err = capture(MAX_CAPTURE);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (win) cp.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
        else process.kill(-child.pid, 'SIGKILL');
      } catch (_) {}
    }, timeout);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const finish = (exitCode, signal, spawnError) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, spawnError, stdout: out.text(), stderr: err.text(),
        truncated: out.truncated || err.truncated });
    };
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

function parseTasklist(output) {
  return output.trim().split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.split('","').map((s) => s.replace(/"/g, ''));
      return {
        name: parts[0] || '',
        pid: parseInt(parts[1], 10) || 0,
        sessionName: parts[2] || '',
        sessionNumber: parseInt(parts[3], 10) || 0,
        memory: (parts[4] || '').trim()
      };
    })
    .filter((p) => p.pid > 0);
}

function parsePs(output) {
  return output.trim().split('\n').slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      user: parts[0],
      pid: parseInt(parts[1], 10) || 0,
      cpu: parseFloat(parts[2]) || 0,
      mem: parseFloat(parts[3]) || 0,
      name: parts.slice(10).join(' ')
    };
  }).filter((p) => p.pid > 0);
}

function filterProcesses(processes, filter, { byPid = true } = {}) {
  const f = String(filter ?? '').trim().toLowerCase();
  if (!f) return processes;
  const pid = /^\d+$/.test(f) ? Number(f) : null;
  return processes.filter((p) => String(p.name).toLowerCase().includes(f) || (byPid && p.pid === pid));
}

function windowMatches(title, target) {
  if (!title || !target) return false;
  const active = String(title).toLowerCase();
  const t = String(target).toLowerCase();
  const names = WINDOW_ALIASES.find((group) => group.includes(t)) || [t];
  return names.some((n) => active.includes(n));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function activeWindowTitleWin() {
  return windowsApps.runPowerShellAsync(`
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
'@
$sb = New-Object System.Text.StringBuilder 256
[W]::GetWindowText([W]::GetForegroundWindow(), $sb, 256) | Out-Null
Write-Output $sb.ToString()`, { timeoutMs: 3000 }).then((s) => s.trim(), () => '');
}

function spawnDetached(name, args, platform) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(name, args, { detached: true, stdio: 'ignore', windowsHide: false });
    let failed = false;
    child.on('error', (err) => { failed = true; reject(new Error(`Failed to open '${name}': ${err.message}`)); });
    child.unref();
    setTimeout(() => { if (!failed) resolve({ application: name, pid: child.pid, launched: true, platform }); }, 500);
  });
}

function macApplications() {
  const dirs = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
  const names = new Set();
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) {}
    for (const e of entries) if (e.endsWith('.app')) names.add(e.slice(0, -4));
  }
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
}

class ProcessModule extends CapabilityModule {
  constructor() {
    super('process', 'Application and process management');
  }

  async initialize(context = {}) {
    await super.initialize(context);
    this.platform = context.platform || process.platform;

    this.registerAction('openApplication', this.openApplication, {
      description: 'Open an application by name, optionally opening a file or folder (path) in it',
      parameters: ['name', 'path', 'args'],
      riskLevel: 'medium'
    });

    this.registerAction('closeApplication', this.closeApplication, {
      description: 'Close an application by name',
      parameters: ['name'],
      riskLevel: 'high'
    });

    this.registerAction('listProcesses', this.listProcesses, {
      description: 'List running processes',
      parameters: ['filter'],
      riskLevel: 'low'
    });

    this.registerAction('killProcess', this.killProcess, {
      description: 'Kill a process by PID',
      parameters: ['pid', 'force'],
      riskLevel: 'critical',
      requiresConfirmation: true
    });

    this.registerAction('getSystemInfo', this.getSystemInfo, {
      description: 'Get system information (CPU, memory, etc.)',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('executeCommand', this.executeCommand, {
      description: 'Execute a shell command',
      parameters: ['command', 'cwd', 'timeout'],
      riskLevel: 'high'
    });

    this.registerAction('isRunning', this.isRunning, {
      description: 'Check if an application is currently running',
      parameters: ['name'],
      riskLevel: 'low'
    });

    this.registerAction('getInstalledApps', this.getInstalledApps, {
      description: 'List installed applications',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('searchInstalledApps', this.searchInstalledApps, {
      description: 'Search installed applications by name with Windows discovery fallbacks',
      parameters: ['query', 'limit'],
      riskLevel: 'low'
    });
  }

  async openApplication({ name, args, path: target, waitForWindow = false, timeoutMs = 7000 } = {}) {
    const app = appName(name);
    const argv = toArgs(args);
    const file = toOpenPath(target);
    if (this.platform === 'darwin') return macInput.openApp(app, argv, file);
    if (this.platform === 'win32') return this._openWindowsApp(app, file ? [file, ...argv] : argv, waitForWindow, timeoutMs);
    if (this.platform === 'linux') return spawnDetached(app, file ? [file, ...argv] : argv, this.platform);
    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  async _openWindowsApp(name, args, waitForWindow, timeoutMs) {
    let result;
    try {
      result = await windowsApps.openApplication(name);
    } catch (_) {
      return spawnDetached(name, args, 'win32');
    }
    if (!waitForWindow || !result.success) return result;
    const wait = await this._waitForWindowByName(name, timeoutMs);
    return { ...result, windowReady: wait.ready, activeWindow: wait.activeWindow, waitedMs: wait.waitedMs };
  }

  async closeApplication({ name } = {}) {
    const app = appName(name);
    if (this.platform === 'darwin') return macInput.quit(app);
    if (/[*?]/.test(app)) throw new Error('Application name must not contain wildcards');
    const attempts = this.platform === 'win32'
      ? [['taskkill', ['/IM', /\.exe$/i.test(app) ? app : `${app}.exe`, '/F']],
        ['taskkill', ['/FI', `WINDOWTITLE eq ${app}*`, '/F']]]
      : [['pkill', ['-x', '--', escapeRegex(app)]], ['killall', ['--', app]]];
    let result;
    for (const [file, args] of attempts) {
      result = await run(file, args, { timeout: 10000 });
      if (!result.err) break;
    }
    const { err, stdout, stderr } = result;
    return { application: app, closed: !err, output: stdout.trim() || stderr.trim() };
  }

  async _processes() {
    const win = this.platform === 'win32';
    const { err, stdout } = win
      ? await run('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 15000 })
      : await run('ps', ['aux'], { timeout: 15000 });
    if (err) throw new Error(`Could not list processes: ${err.message}`);
    return win ? parseTasklist(stdout) : parsePs(stdout);
  }

  async listProcesses({ filter = '' } = {}) {
    const processes = filterProcesses(await this._processes(), filter);
    return { processes, count: processes.length, platform: this.platform };
  }

  async killProcess({ pid, force = false } = {}) {
    const n = toPid(pid);
    const hard = force === true || force === 'true';
    if (this.platform === 'win32') {
      const { err, stderr } = await run('taskkill', ['/PID', String(n), ...(hard ? ['/F'] : [])], { timeout: 10000 });
      if (err) throw new Error(`Failed to kill PID ${n}: ${stderr.trim() || err.message}`);
    } else {
      try { process.kill(n, hard ? 'SIGKILL' : 'SIGTERM'); }
      catch (err) { throw new Error(`Failed to kill PID ${n}: ${err.code === 'ESRCH' ? 'no such process' : err.message}`); }
    }
    return { pid: n, killed: true, force: hard };
  }

  async getSystemInfo() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      platform: this.platform,
      arch: os.arch(),
      hostname: os.hostname(),
      username: os.userInfo().username,
      homeDir: os.homedir(),
      tempDir: os.tmpdir(),
      cpu: {
        model: cpus[0]?.model,
        cores: cpus.length,
        speed: cpus[0]?.speed
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        usagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100)
      },
      uptime: os.uptime(),
      nodeVersion: process.version
    };
  }

  async executeCommand({ command, cwd, timeout } = {}) {
    assertAllowedCommand(command);
    const ms = toTimeout(timeout);
    const dir = toCwd(cwd);
    const r = await runShell(command, { cwd: dir, timeout: ms, platform: this.platform });
    if (r.spawnError) throw new Error(`Could not start the shell: ${r.spawnError.message}`);
    if (r.timedOut) throw new Error(`Command timed out after ${ms}ms`);
    const stdout = r.stdout.trim();
    const stderr = r.stderr.trim();
    return {
      command,
      cwd: dir,
      exitCode: r.exitCode,
      signal: r.signal || undefined,
      stdout: stdout.substring(0, MAX_STDOUT),
      stderr: stderr.substring(0, MAX_STDERR),
      truncated: r.truncated || stdout.length > MAX_STDOUT || stderr.length > MAX_STDERR,
      success: r.exitCode === 0
    };
  }

  async isRunning({ name } = {}) {
    const app = appName(name);
    const processes = filterProcesses(await this._processes(), app, { byPid: false });
    return {
      name: app,
      running: processes.length > 0,
      instances: processes.length,
      processes: processes.slice(0, 5)
    };
  }

  async getInstalledApps() {
    if (this.platform === 'darwin') {
      const apps = macApplications();
      return { apps, count: apps.length };
    }
    if (this.platform === 'win32') {
      let apps = [];
      try {
        const out = await windowsApps.runPowerShellAsync(
          'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | ' +
          'Where-Object { $_.DisplayName } | Select-Object DisplayName, DisplayVersion, Publisher | ConvertTo-Json',
          { timeoutMs: 15000 });
        const parsed = JSON.parse(out || '[]');
        apps = (Array.isArray(parsed) ? parsed : [parsed])
          .map((a) => ({ name: a.DisplayName, version: a.DisplayVersion, publisher: a.Publisher }))
          .filter((a) => a.name);
      } catch (err) {
        return { apps: [], count: 0, error: err.message };
      }
      return { apps, count: apps.length };
    }
    if (this.platform === 'linux') {
      let entries = [];
      try { entries = fs.readdirSync('/usr/share/applications'); } catch (err) { return { apps: [], count: 0, error: err.message }; }
      const apps = entries.filter((e) => e.endsWith('.desktop')).map((e) => ({ name: e.slice(0, -8) }));
      return { apps, count: apps.length };
    }
    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  async searchInstalledApps({ query, limit = 10 } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('query is required');
    const max = Math.min(100, Math.max(1, Math.round(Number(limit)) || 10));

    if (this.platform !== 'win32') {
      const installed = await this.getInstalledApps();
      const results = (installed.apps || [])
        .filter((app) => String(app.name || '').toLowerCase().includes(q.toLowerCase()))
        .slice(0, max)
        .map((app) => ({ source: 'installed_apps', name: app.name, version: app.version || null }));
      return { query: q, results, count: results.length, platform: this.platform };
    }

    const discovered = windowsApps.searchInstalledApplications(q);
    const merged = [];
    const seen = new Set();
    const addOnce = (key, entry) => {
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(entry);
    };

    for (const app of discovered.startApps || []) {
      addOnce(`start:${String(app.name || '').toLowerCase()}`,
        { source: 'start_apps', name: app.name, appID: app.appID });
    }
    for (const app of discovered.registryApps || []) {
      addOnce(`reg:${String(app.displayName || '').toLowerCase()}`, {
        source: 'registry',
        name: app.displayName,
        installLocation: app.installLocation || null,
        icon: app.icon || null
      });
    }
    if (discovered.pathMatch) {
      merged.push({ source: 'path', name: path.basename(discovered.pathMatch), path: discovered.pathMatch });
    }

    return { query: q, results: merged.slice(0, max), count: merged.length, platform: this.platform };
  }

  async _waitForWindowByName(name, timeoutMs = 7000) {
    const started = Date.now();
    const deadline = started + Math.min(60000, Math.max(1000, Number(timeoutMs) || 7000));
    let activeWindow = '';
    while (Date.now() < deadline) {
      activeWindow = await activeWindowTitleWin();
      if (windowMatches(activeWindow, name)) return { ready: true, activeWindow, waitedMs: Date.now() - started };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ready: false, activeWindow, waitedMs: Date.now() - started };
  }
}

module.exports = ProcessModule;
module.exports.__test = {
  BLOCKED_COMMANDS, assertAllowedCommand, toTimeout, toCwd, toPid, toArgs, appName, toOpenPath, shellPath,
  parsePs, parseTasklist, filterProcesses, windowMatches, escapeRegex, runShell, capture
};
