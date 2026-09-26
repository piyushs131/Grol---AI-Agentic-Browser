const path = require('path');
const os = require('os');
const { CapabilityModule } = require('../../shared/schemas/capability-schema');
const ProcessModule = require('../process');
const ScreenModule = require('../screen');
const { runPowerShellAsync } = require('../process/windows-apps');
const macInput = require('./mac-input');

let nutjs = null;
try {
  nutjs = require('@nut-tree-fork/nut-js');
} catch {}

// App/process actions are also exposed on `desktop` for older callers; they
// delegate to the process module so there is a single implementation.
const PROCESS_ACTIONS = [
  ['openApplication', 'Open / launch an application by name', ['name', 'args'], 'medium'],
  ['closeApplication', 'Close / quit an application by name', ['name'], 'high'],
  ['listProcesses', 'List running processes', ['filter'], 'low'],
  ['getSystemInfo', 'Get system information (CPU, memory, OS, etc.)', [], 'low'],
  ['executeCommand', 'Execute a shell / console command', ['command', 'cwd', 'timeout'], 'high'],
  ['isRunning', 'Check whether an application is currently running', ['name'], 'low']
];

// ---- Parameter validation (runs before any OS call) ----

const MAX_COORD = 100000;
const MAX_SCROLL = 100;
const MAX_TEXT = macInput.__test.MAX_TYPE_LENGTH;
const BUTTONS = ['left', 'right', 'middle'];
const DIRECTIONS = ['up', 'down', 'left', 'right'];
const KEY_ALIASES = {
  return: 'enter', esc: 'escape', arrowup: 'up', arrowdown: 'down', arrowleft: 'left',
  arrowright: 'right', spacebar: 'space', ' ': 'space'
};
// `cmd` is the macOS Command key; elsewhere it means Ctrl ("cmd+c" = copy).
// `super` is the Windows / Super key itself.
const MODIFIER_ALIASES = {
  cmd: 'cmd', command: 'cmd', meta: 'cmd', ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift', super: 'super', win: 'super', fn: 'fn'
};
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function toCoordinate(value, name) {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > MAX_COORD) {
    throw new Error(`${name} must be a finite number between -${MAX_COORD} and ${MAX_COORD}`);
  }
  return n;
}

// Both coordinates, or neither (= current pointer position).
function toOptionalPoint(x, y) {
  const has = (v) => v !== undefined && v !== null;
  if (!has(x) && !has(y)) return { x: undefined, y: undefined };
  if (!has(x) || !has(y)) throw new Error('Pass both x and y, or neither');
  return { x: toCoordinate(x, 'x'), y: toCoordinate(y, 'y') };
}

function toButton(button = 'left') {
  const b = String(button).toLowerCase();
  if (!BUTTONS.includes(b)) throw new Error(`button must be one of ${BUTTONS.join(', ')}`);
  return b;
}

function toDirection(direction = 'down') {
  const d = String(direction).toLowerCase();
  if (!DIRECTIONS.includes(d)) throw new Error(`direction must be one of ${DIRECTIONS.join(', ')}`);
  return d;
}

function toScrollAmount(amount = 3) {
  const n = typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : amount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number');
  return Math.min(MAX_SCROLL, Math.max(1, Math.round(n)));
}

function toText(text) {
  if (typeof text === 'number' && Number.isFinite(text)) text = String(text);
  if (typeof text !== 'string' || !text) throw new Error('Text is required');
  if (text.length > MAX_TEXT) throw new Error(`Text is longer than ${MAX_TEXT} characters; send it in parts`);
  return text;
}

function toDelay(delay) {
  if (delay === undefined || delay === null) return undefined;
  const n = Number(delay);
  if (!Number.isFinite(n) || n < 0) throw new Error('delay must be a non-negative number of milliseconds');
  return Math.min(1000, Math.round(n));
}

function canonicalKey(key) {
  const lc = typeof key === 'string' ? (key === ' ' ? key : key.trim()).toLowerCase() : '';
  if (!lc) throw new Error('Key is required');
  return own(KEY_ALIASES, lc) ? KEY_ALIASES[lc] : lc;
}

function canonicalModifier(mod) {
  const m = String(mod).trim().toLowerCase();
  if (!own(MODIFIER_ALIASES, m)) throw new Error(`Unknown modifier '${mod}'`);
  return MODIFIER_ALIASES[m];
}

// "cmd+shift+n" -> ['cmd', 'shift', 'n']; a trailing '+' is the plus key ("cmd++").
function splitCombo(combo) {
  return String(combo).split(/\+(?!$)/).map((s) => s.trim()).filter(Boolean);
}

// Accepts "cmd+n" as well as { key: 'n', modifiers: ['cmd'] } / 'cmd,shift'.
function normalizeKeyCombo(key, modifiers = []) {
  if (typeof key !== 'string' || !key) throw new Error('Key is required');
  let mods = modifiers === undefined || modifiers === null ? []
    : typeof modifiers === 'string' ? modifiers.split(/[+,\s]+/).filter(Boolean) : modifiers;
  if (!Array.isArray(mods)) throw new Error('modifiers must be an array or a string like "cmd+shift"');
  let main = key;
  if (key.length > 1 && key.includes('+')) {
    const parts = splitCombo(key);
    if (!parts.length) throw new Error('Key is required');
    main = parts.pop();
    mods = [...mods, ...parts];
  }
  return { key: canonicalKey(main), modifiers: [...new Set(mods.map(canonicalModifier))] };
}

function normalizeHotkey(keys) {
  const list = typeof keys === 'string' ? splitCombo(keys)
    : Array.isArray(keys) ? keys.flatMap((k) => (typeof k === 'string' && k.length > 1 ? splitCombo(k) : [k])) : null;
  if (!list || !list.length || list.some((k) => typeof k !== 'string' || !k)) {
    throw new Error('keys must be a non-empty array of key names or a string like "cmd+n"');
  }
  const { key, modifiers } = normalizeKeyCombo(list[list.length - 1], list.slice(0, -1));
  return [...modifiers, key];
}

// ---- Windows backend (PowerShell; data via environment, never spliced in) ----

const SENDKEYS_MODIFIERS = { ctrl: '^', cmd: '^', alt: '%', shift: '+' };
const SENDKEYS_KEYS = {
  enter: '{ENTER}', tab: '{TAB}', escape: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}',
  forwarddelete: '{DELETE}', space: ' ', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}'
};
const SENDKEYS_SPECIAL = /[+^%~(){}[\]]/g;

function toSendKeys(key, modifiers = []) {
  const prefix = modifiers.map((m) => {
    if (!own(SENDKEYS_MODIFIERS, m)) throw new Error(`Modifier '${m}' is not supported on Windows`);
    return SENDKEYS_MODIFIERS[m];
  }).join('');
  if (own(SENDKEYS_KEYS, key)) return prefix + SENDKEYS_KEYS[key];
  if ([...key].length === 1) return prefix + key.replace(SENDKEYS_SPECIAL, '{$&}');
  throw new Error(`Unknown key '${key}'`);
}

function sendKeysText(text) {
  return text.replace(SENDKEYS_SPECIAL, '{$&}').replace(/\r\n|\r|\n/g, '{ENTER}').replace(/\t/g, '{TAB}');
}

const ps = (script, vars) => runPowerShellAsync(script, { timeoutMs: 15000, vars });
const PS_FORMS = 'Add-Type -AssemblyName System.Windows.Forms';
const PS_SENDKEYS = `${PS_FORMS}; [System.Windows.Forms.SendKeys]::SendWait($env:GROL_KEYS)`;
const PS_MOUSE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseOps {
    [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
}
"@
function Move-To($x, $y) { [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$x, [int]$y) }
function Mouse($flags, $data) { [MouseOps]::mouse_event([int]$flags, 0, 0, [int]$data, 0) }`;
const WIN_BUTTON_FLAGS = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] };

const WIN_FOCUS_ALIASES = {
  chrome: ['chrome', 'google chrome'],
  'google chrome': ['chrome', 'google chrome'],
  'visual studio code': ['visual studio code', 'vscode', 'code'],
  vscode: ['visual studio code', 'vscode', 'code'],
  code: ['visual studio code', 'vscode', 'code'],
  explorer: ['explorer', 'file explorer', 'this pc', 'home'],
  'file explorer': ['explorer', 'file explorer', 'this pc', 'home'],
  'microsoft store': ['microsoft store', 'store']
};

const winInput = {
  moveMouse(x, y) {
    return ps(`${PS_MOUSE}\nMove-To $env:GROL_X $env:GROL_Y`, { X: Math.round(x), Y: Math.round(y) });
  },

  click(x, y, button, doubleClick) {
    const [down, up] = WIN_BUTTON_FLAGS[button];
    return ps(`${PS_MOUSE}
if ($env:GROL_AT -eq '1') { Move-To $env:GROL_X $env:GROL_Y }
for ($i = 0; $i -lt [int]$env:GROL_CLICKS; $i++) { Mouse ${down} 0; Mouse ${up} 0 }`,
    { AT: x === undefined ? 0 : 1, X: Math.round(x || 0), Y: Math.round(y || 0), CLICKS: doubleClick ? 2 : 1 });
  },

  drag(fromX, fromY, toX, toY) {
    return ps(`${PS_MOUSE}
Move-To $env:GROL_FX $env:GROL_FY; Mouse 0x0002 0; Start-Sleep -Milliseconds 60
Move-To $env:GROL_TX $env:GROL_TY; Start-Sleep -Milliseconds 60; Mouse 0x0004 0`,
    { FX: Math.round(fromX), FY: Math.round(fromY), TX: Math.round(toX), TY: Math.round(toY) });
  },

  scroll(amount, direction) {
    const horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'up' || direction === 'right' ? 1 : -1;
    return ps(`${PS_MOUSE}\nMouse ${horizontal ? 0x01000 : 0x0800} $env:GROL_DELTA`, { DELTA: sign * amount * 120 });
  },

  pressKey(key, modifiers) {
    return ps(PS_SENDKEYS, { KEYS: toSendKeys(key, modifiers) });
  },

  hotkey(keys) {
    return winInput.pressKey(keys[keys.length - 1], keys.slice(0, -1));
  },

  typeText(text) {
    return ps(PS_SENDKEYS, { KEYS: sendKeysText(text) });
  },

  async mousePosition() {
    const out = await ps(`${PS_FORMS}; $p = [System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"`);
    const [x, y] = out.trim().split(',').map(Number);
    return { x, y };
  },

  async screenSize() {
    const out = await ps(`${PS_FORMS}; $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($s.Width),$($s.Height)"`);
    const [width, height] = out.trim().split(',').map(Number);
    return { width, height };
  },

  async frontmostApp() {
    const out = await ps(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$sb = New-Object System.Text.StringBuilder 256
[WinAPI]::GetWindowText([WinAPI]::GetForegroundWindow(), $sb, 256) | Out-Null
$sb.ToString()`);
    return { title: out.trim(), platform: 'win32' };
  },

  async activate(title) {
    const normalized = title.toLowerCase().trim();
    const aliases = [...new Set([normalized, ...(WIN_FOCUS_ALIASES[normalized] || [])])];
    const out = await ps(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$aliases = $env:GROL_ALIASES -split "\`n" | Where-Object { $_ -and $_.Trim().Length -gt 0 }
$title = $env:GROL_TITLE.ToLower()
$candidates = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Where-Object {
  $proc = $_
  foreach ($alias in $aliases) {
    if (
      ($proc.MainWindowTitle -and $proc.MainWindowTitle.ToLower().Contains($alias)) -or
      ($proc.ProcessName -and $proc.ProcessName.ToLower().Contains($alias))
    ) {
      return $true
    }
  }
  return $false
}
if (-not $candidates) {
  $candidates = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($title) }
}
$proc = $candidates | Select-Object -First 1
if ($proc) {
  [WinFocus]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
  Start-Sleep -Milliseconds 100
  $wshell = New-Object -ComObject WScript.Shell
  $wshell.AppActivate($proc.Id) | Out-Null
  Start-Sleep -Milliseconds 150
  [WinFocus]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 150
  $active = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Where-Object {
    $_.Id -eq $proc.Id -or $_.MainWindowTitle -eq $proc.MainWindowTitle
  } | Select-Object -First 1
  if ($active) { "focused" } else { "not_focused" }
} else { "not_found" }`, { ALIASES: aliases.join('\n'), TITLE: title });
    const state = out.trim();
    return { focused: state === 'focused', title, state };
  }
};

// Linux without nut-js has no input backend; only these read-only answers.
const otherInput = {
  mousePosition: async () => ({ x: 0, y: 0, note: 'Requires @nut-tree-fork/nut-js for accurate position' }),
  screenSize: async () => ({ width: 1920, height: 1080, note: 'Default values - install @nut-tree-fork/nut-js for accuracy' }),
  frontmostApp: async () => ({ title: 'unknown', note: 'Requires @nut-tree-fork/nut-js' })
};

// ---- nut-js backend (Windows / Linux only: on macOS it would bypass the
// Accessibility check and its events are dropped silently without it) ----

const NUT_KEYS = {
  enter: 'Enter', tab: 'Tab', escape: 'Escape', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', forwarddelete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12'
};
const NUT_MODIFIERS = { ctrl: 'LeftControl', cmd: 'LeftControl', alt: 'LeftAlt', shift: 'LeftShift', super: 'LeftSuper' };

function nutKey(key) {
  const name = own(NUT_KEYS, key) ? NUT_KEYS[key] : key.length === 1 ? key.toUpperCase() : null;
  if (!name || nutjs.Key[name] === undefined) throw new Error(`Unknown key '${key}'`);
  return nutjs.Key[name];
}

function nutModifier(mod) {
  if (!own(NUT_MODIFIERS, mod)) throw new Error(`Modifier '${mod}' is not supported on this platform`);
  return nutjs.Key[NUT_MODIFIERS[mod]];
}

const nutButton = (button) => (button === 'right' ? nutjs.Button.RIGHT
  : button === 'middle' ? nutjs.Button.MIDDLE : nutjs.Button.LEFT);

const nutInput = {
  async moveMouse(x, y) { await nutjs.mouse.setPosition(new nutjs.Point(Math.round(x), Math.round(y))); },
  async click(x, y, button, doubleClick) {
    if (x !== undefined) await nutjs.mouse.setPosition(new nutjs.Point(Math.round(x), Math.round(y)));
    if (doubleClick) await nutjs.mouse.doubleClick(nutButton(button));
    else await nutjs.mouse.click(nutButton(button));
  },
  async drag(fromX, fromY, toX, toY) {
    await nutjs.mouse.setPosition(new nutjs.Point(Math.round(fromX), Math.round(fromY)));
    await nutjs.mouse.pressButton(nutjs.Button.LEFT);
    try { await nutjs.mouse.setPosition(new nutjs.Point(Math.round(toX), Math.round(toY))); }
    finally { await nutjs.mouse.releaseButton(nutjs.Button.LEFT); }
  },
  async scroll(amount, direction) {
    const fn = { up: 'scrollUp', down: 'scrollDown', left: 'scrollLeft', right: 'scrollRight' }[direction];
    await nutjs.mouse[fn](amount);
  },
  async pressKey(key, modifiers) {
    const main = nutKey(key);
    const mods = modifiers.map(nutModifier);
    if (mods.length) await nutjs.keyboard.pressKey(...mods);
    try {
      await nutjs.keyboard.pressKey(main);
      await nutjs.keyboard.releaseKey(main);
    } finally {
      if (mods.length) await nutjs.keyboard.releaseKey(...mods);
    }
  },
  hotkey(keys) { return nutInput.pressKey(keys[keys.length - 1], keys.slice(0, -1)); },
  async typeText(text, delay) {
    if (delay !== undefined) nutjs.keyboard.config.autoDelayMs = delay;
    await nutjs.keyboard.type(text);
  },
  async mousePosition() {
    const pos = await nutjs.mouse.getPosition();
    return { x: pos.x, y: pos.y };
  },
  async screenSize() {
    return { width: await nutjs.screen.width(), height: await nutjs.screen.height() };
  }
};

function pickBackend(platform) {
  if (platform === 'darwin') return macInput;
  const base = platform === 'win32' ? winInput : otherInput;
  return nutjs ? { ...base, ...nutInput } : base;
}

class DesktopModule extends CapabilityModule {
  constructor() {
    super('desktop', 'Desktop GUI automation - mouse, keyboard, and screen control');
    this.hasNutJs = !!nutjs;
  }

  async initialize(context = {}) {
    await super.initialize(context);
    this.platform = context.platform || process.platform;
    this.native = pickBackend(this.platform);

    if (nutjs && this.platform !== 'darwin') {
      nutjs.keyboard.config.autoDelayMs = 50;
      nutjs.mouse.config.autoDelayMs = 100;
      nutjs.mouse.config.mouseSpeed = 1000;
    }

    if (this.platform === 'darwin') {
      this.registerAction('getPermissions', () => macInput.permissions(), {
        description: 'Report whether macOS Accessibility and Screen Recording are granted',
        parameters: [],
        riskLevel: 'low'
      });
      this.registerAction('requestPermissions', () => macInput.requestPermissions(), {
        description: 'Show the macOS Accessibility and Screen Recording permission prompts',
        parameters: [],
        riskLevel: 'low'
      });
    }

    this.registerAction('moveMouse', this.moveMouse, {
      description: 'Move mouse cursor to coordinates',
      parameters: ['x', 'y'],
      riskLevel: 'medium'
    });

    this.registerAction('clickMouse', this.clickMouse, {
      description: 'Click mouse at current or specified position',
      parameters: ['x', 'y', 'button', 'doubleClick'],
      riskLevel: 'medium'
    });

    this.registerAction('dragMouse', this.dragMouse, {
      description: 'Drag from one position to another',
      parameters: ['fromX', 'fromY', 'toX', 'toY'],
      riskLevel: 'medium'
    });

    this.registerAction('pressKey', this.pressKey, {
      description: 'Press a keyboard key or key combination',
      parameters: ['key', 'modifiers'],
      riskLevel: 'high'
    });

    this.registerAction('typeText', this.typeText, {
      description: 'Type a string of text',
      parameters: ['text', 'delay'],
      riskLevel: 'medium'
    });

    this.registerAction('hotkey', this.hotkey, {
      description: 'Press a keyboard shortcut',
      parameters: ['keys'],
      riskLevel: 'high'
    });

    this.registerAction('getMousePosition', this.getMousePosition, {
      description: 'Get current mouse cursor position',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('getScreenSize', this.getScreenSize, {
      description: 'Get screen dimensions',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('scrollMouse', this.scrollMouse, {
      description: 'Scroll the mouse wheel',
      parameters: ['amount', 'direction'],
      riskLevel: 'low'
    });

    this.registerAction('rightClick', this.rightClick, {
      description: 'Right-click at position',
      parameters: ['x', 'y'],
      riskLevel: 'medium'
    });

    this.registerAction('getActiveWindow', this.getActiveWindow, {
      description: 'Get info about the currently active window',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('focusWindow', this.focusWindow, {
      description: 'Bring a window to focus by title',
      parameters: ['title'],
      riskLevel: 'medium'
    });

    const processModule = new ProcessModule();
    await processModule.initialize(context);
    for (const [name, description, parameters, riskLevel] of PROCESS_ACTIONS) {
      this.registerAction(name, (params) => processModule.execute(name, params), { description, parameters, riskLevel });
    }

    this.registerAction('screenshot', this.takeScreenshot, {
      description: 'Alias for takeScreenshot',
      parameters: [],
      riskLevel: 'low'
    });
  }

  // Input must never land in whatever else happens to be in front.
  async _bringToFront(app) {
    if (app && this.platform === 'darwin') await macInput.ensureFront(app);
  }

  _nativeCall(op, ...args) {
    const fn = this.native[op];
    if (!fn) throw new Error(`${op} requires @nut-tree-fork/nut-js on this platform`);
    return fn(...args);
  }

  async moveMouse({ app, x, y } = {}) {
    if (x === undefined || y === undefined) throw new Error('x and y coordinates are required');
    const px = toCoordinate(x, 'x');
    const py = toCoordinate(y, 'y');
    await this._bringToFront(app);
    await this._nativeCall('moveMouse', px, py);
    return { moved: true, x: px, y: py };
  }

  async clickMouse({ app, x, y, button = 'left', doubleClick = false } = {}) {
    const point = toOptionalPoint(x, y);
    const btn = toButton(button);
    const dbl = doubleClick === true || doubleClick === 'true';
    await this._bringToFront(app);
    await this._nativeCall('click', point.x, point.y, btn, dbl);
    return { clicked: true, x: point.x, y: point.y, button: btn, doubleClick: dbl };
  }

  async rightClick({ app, x, y } = {}) {
    return this.clickMouse({ app, x, y, button: 'right' });
  }

  async dragMouse({ app, fromX, fromY, toX, toY } = {}) {
    const from = { x: toCoordinate(fromX, 'fromX'), y: toCoordinate(fromY, 'fromY') };
    const to = { x: toCoordinate(toX, 'toX'), y: toCoordinate(toY, 'toY') };
    await this._bringToFront(app);
    await this._nativeCall('drag', from.x, from.y, to.x, to.y);
    return { dragged: true, from, to };
  }

  async scrollMouse({ app, amount = 3, direction = 'down' } = {}) {
    const lines = toScrollAmount(amount);
    const dir = toDirection(direction);
    await this._bringToFront(app);
    await this._nativeCall('scroll', lines, dir);
    return { scrolled: true, amount: lines, direction: dir };
  }

  async pressKey({ app, key, modifiers = [] } = {}) {
    const combo = normalizeKeyCombo(key, modifiers);
    await this._bringToFront(app);
    await this._nativeCall('pressKey', combo.key, combo.modifiers);
    return { pressed: true, key: combo.key, modifiers: combo.modifiers };
  }

  async hotkey({ app, keys } = {}) {
    const combo = normalizeHotkey(keys);
    await this._bringToFront(app);
    await this._nativeCall('hotkey', combo);
    return { pressed: true, keys: combo };
  }

  async typeText({ app, text, delay } = {}) {
    const value = toText(text);
    const ms = toDelay(delay);
    await this._bringToFront(app);
    await this._nativeCall('typeText', value, ms);
    return { typed: true, length: value.length };
  }

  async getMousePosition() {
    return this._nativeCall('mousePosition');
  }

  async getScreenSize() {
    return this._nativeCall('screenSize');
  }

  async getActiveWindow() {
    if (nutjs && this.platform !== 'darwin') {
      try {
        const win = await nutjs.getActiveWindow();
        return { title: await win.title, region: await win.region };
      } catch {}
    }
    return this._nativeCall('frontmostApp');
  }

  async focusWindow({ title } = {}) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('Window title is required');
    return this._nativeCall('activate', title.trim());
  }

  async takeScreenshot() {
    const timestamp = Date.now();
    const screenshotPath = path.join(os.tmpdir(), `screenshot_${timestamp}_${process.pid}.png`);
    try {
      await ScreenModule.captureScreen(this.platform, screenshotPath);
    } catch (err) {
      throw new Error(`Screenshot failed: ${err.message}`);
    }
    return { path: screenshotPath, timestamp, platform: this.platform };
  }
}

module.exports = DesktopModule;
module.exports.__test = {
  toCoordinate, toOptionalPoint, toButton, toDirection, toScrollAmount, toText, toDelay,
  normalizeKeyCombo, normalizeHotkey, splitCombo, toSendKeys, sendKeysText, pickBackend
};
