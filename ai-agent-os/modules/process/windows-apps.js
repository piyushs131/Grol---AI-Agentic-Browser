const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const PROTOCOL_APPS = {
  settings: 'ms-settings:', 'windows settings': 'ms-settings:',
  'snip & sketch': 'ms-screensketch:', photos: 'ms-photos:',
  store: 'ms-windows-store:', 'microsoft store': 'ms-windows-store:',
  mail: 'outlookmail:', calendar: 'outlookcal:', camera: 'microsoft.windows.camera:',
  clock: 'ms-clock:', alarms: 'ms-clock:', maps: 'bingmaps:', weather: 'bingweather:'
};

function powerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function powerShellEnv(vars = {}) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(vars)) env[`GROL_${k}`] = String(v);
  return env;
}

function runPowerShell(script, timeoutMs = 10000, vars = {}) {
  try {
    return String(cp.execFileSync('powershell', powerShellArgs(script),
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, env: powerShellEnv(vars),
        stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20 })).trim();
  } catch (_) {
    return '';
  }
}

function runPowerShellAsync(script, { timeoutMs = 15000, vars = {} } = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile('powershell', powerShellArgs(script),
      { timeout: timeoutMs, windowsHide: true, env: powerShellEnv(vars), maxBuffer: 8 << 20 },
      (err, stdout, stderr) => err
        ? reject(new Error(`PowerShell error: ${String(stderr || err.message).trim()}`))
        : resolve(String(stdout)));
  });
}

function launchDetached(target, args = []) {
  const child = cp.spawn(target, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

function cleanQuery(query) {
  const q = String(query || '').trim();
  return q && q.length <= 256 && !/[*?\0\r\n"<>|]/.test(q) ? q : '';
}

function searchStartApps(query) {
  const out = runPowerShell(`
$q = $env:GROL_Q.ToLower()
Get-StartApps -ErrorAction SilentlyContinue |
  Where-Object { $_.Name.ToLower().Contains($q) -or $_.AppID.ToLower().Contains($q) } |
  Sort-Object { $n = $_.Name.ToLower(); if ($n -eq $q) { 2 } elseif ($n.StartsWith($q)) { 1 } else { 0 } } -Descending |
  Select-Object -First 5 | ForEach-Object { Write-Output "$($_.Name)|$($_.AppID)" }`, 12000, { Q: query });
  return out.split('\n').map((l) => l.trim()).filter((l) => l.includes('|'))
    .map((l) => { const i = l.indexOf('|'); return { name: l.slice(0, i), appID: l.slice(i + 1) }; });
}

function searchRegistry(query) {
  const out = runPowerShell(`
$q = $env:GROL_Q.ToLower()
$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.DisplayName.ToLower().Contains($q) -and $_.InstallLocation } |
  Select-Object -First 3 | ForEach-Object {
    $icon = if ($_.DisplayIcon) { $_.DisplayIcon.Split(',')[0].Trim('"') } else { '' }
    Write-Output "$($_.DisplayName)|$($_.InstallLocation.TrimEnd('\\'))|$icon"
  }`, 10000, { Q: query });
  return out.split('\n').map((l) => l.trim().split('|')).filter((p) => p.length >= 2)
    .map(([displayName, installLocation, icon]) => ({ displayName, installLocation, icon: icon || '' }));
}

function searchPath(query) {
  for (const name of [query, `${query}.exe`]) {
    try {
      const first = String(cp.execFileSync('where.exe', [name],
        { timeout: 3000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
        .split('\n')[0].trim();
      if (first && fs.existsSync(first)) return first;
    } catch (_) {}
  }
  return null;
}

function findFiles(baseDir, query, extensions, maxDepth) {
  const q = query.toLowerCase();
  const found = [];
  const scan = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') scan(full, depth + 1);
        continue;
      }
      const { name, ext } = path.parse(e.name);
      const base = name.toLowerCase();
      if (!extensions.includes(ext.toLowerCase()) || !base.includes(q)) continue;
      found.push({ path: full, name, score: base === q ? 2 : base.startsWith(q) ? 1 : 0 });
    }
  };
  if (baseDir) scan(baseDir, 0);
  return found.sort((a, b) => b.score - a.score);
}

function searchInstalledApplications(query) {
  const q = cleanQuery(query);
  if (!q) return { query: String(query || '').trim(), startApps: [], registryApps: [], pathMatch: null };
  return { query: q, startApps: searchStartApps(q), registryApps: searchRegistry(q), pathMatch: searchPath(q) };
}

const shortcutDirs = () => [
  path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu'),
  path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu'),
  path.join(process.env.USERPROFILE || '', 'Desktop'),
  path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')
].filter((d) => fs.existsSync(d));

async function openApplication(target) {
  const name = cleanQuery(target);
  if (!name) throw new Error('Application name must be a plain, non-empty name');
  const ok = (method, output) => ({ success: true, method, output });

  const protocol = PROTOCOL_APPS[name.toLowerCase()];
  if (protocol) { launchDetached('explorer.exe', [protocol]); return ok('protocol', `Opened ${protocol}`); }

  const [start] = searchStartApps(name);
  if (start) {
    const id = start.appID.trim();
    if (fs.existsSync(id)) launchDetached(id);
    else launchDetached('explorer.exe', [`shell:AppsFolder\\${id}`]);
    return { ...ok('start_apps', `Opened ${start.name}`), appFound: start.name };
  }

  const exe = searchPath(name);
  if (exe) { launchDetached(exe); return ok('path', `Opened ${exe}`); }

  for (const app of searchRegistry(name)) {
    const candidate = app.icon.toLowerCase().endsWith('.exe') && fs.existsSync(app.icon)
      ? app.icon : (findFiles(app.installLocation, name, ['.exe'], 2)[0] || {}).path;
    if (candidate) { launchDetached(candidate); return ok('registry', `Opened ${app.displayName}`); }
  }

  const shortcut = shortcutDirs().flatMap((d) => findFiles(d, name, ['.lnk', '.url'], 6))
    .sort((a, b) => b.score - a.score)[0];
  if (shortcut) { launchDetached('explorer.exe', [shortcut.path]); return ok('shortcut', `Opened ${shortcut.name}`); }

  return { success: false, output: `Could not find "${name}" on this system.` };
}

module.exports = {
  openApplication, searchInstalledApplications, runPowerShell, runPowerShellAsync,
  __test: { powerShellArgs, powerShellEnv, cleanQuery, findFiles }
};
