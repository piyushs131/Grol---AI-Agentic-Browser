const cp = require('child_process');

const KEYCODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21,
  '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40,
  ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 51,
  forwarddelete: 117, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126,
  arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111
};

const FLAGS = {
  cmd: 0x100000, command: 0x100000, meta: 0x100000, super: 0x100000, win: 0x100000,
  shift: 0x20000, ctrl: 0x40000, control: 0x40000,
  alt: 0x80000, option: 0x80000, opt: 0x80000, fn: 0x800000
};

const BUTTONS = { left: 0, right: 1, middle: 2 };
const MAX_TYPE_LENGTH = 10000;
const MAX_APP_NAME = 256;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function keyCode(key) {
  const k = String(key).toLowerCase();
  if (own(KEYCODES, k)) return KEYCODES[k];
  throw new Error(`Unknown key '${key}'`);
}

function flagsFor(modifiers = []) {
  if (!Array.isArray(modifiers)) throw new Error('modifiers must be an array');
  let f = 0;
  for (const m of modifiers) {
    const k = String(m).toLowerCase();
    if (!own(FLAGS, k)) throw new Error(`Unknown modifier '${m}'`);
    f |= FLAGS[k];
  }
  return f;
}

function appQuery(name) {
  const q = typeof name === 'string' ? name.trim().replace(/\.app$/i, '').trim() : '';
  if (!q || q.length > MAX_APP_NAME || /[\0\r\n]/.test(q)) {
    throw new Error('Application name must be a non-empty single-line string');
  }
  return q;
}

function jxaScript(body) {
  return [
    'ObjC.import("CoreGraphics"); ObjC.import("AppKit"); ObjC.import("ApplicationServices");',
    'function post(e) { $.CGEventPost(0, e); }',
    'function sleep(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }',
    'function run(argv) {',
    '  var args = JSON.parse(argv[0]);',
    `  return JSON.stringify((function () { ${body}\n  })());`,
    '}'
  ].join('\n');
}

function jxa(body, args = {}, timeout = 20000) {
  const argv = ['-l', 'JavaScript', '-e', jxaScript(body), '--', JSON.stringify(args)];
  return new Promise((resolve, reject) => {
    cp.execFile('osascript', argv, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      const out = String(stdout).trim();
      try { resolve(JSON.parse(out || 'null')); } catch (_) { resolve(out); }
    });
  });
}

async function requireAccessibility() {
  const ok = await jxa('return $.AXIsProcessTrusted();');
  if (!ok) {
    throw new Error(
      'macOS Accessibility permission is missing for the OS Control helper, so clicks and ' +
      'keystrokes are being discarded. Open System Settings → Privacy & Security → Accessibility, ' +
      `add ${process.execPath} and switch it on, then try again.`);
  }
}

async function permissions() {
  const p = await jxa(`
    ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
    return { accessibility: $.AXIsProcessTrusted(), screenRecording: $.CGPreflightScreenCaptureAccess() };`);
  return { accessibility: !!(p && p.accessibility), screenRecording: !!(p && p.screenRecording), binary: process.execPath };
}

async function requestPermissions() {
  await jxa(`
    ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);
    var opts = $.NSDictionary.dictionaryWithObjectForKey($.kCFBooleanTrue, "AXTrustedCheckOptionPrompt");
    $.AXIsProcessTrustedWithOptions(opts);
    $.CGRequestScreenCaptureAccess();
    return true;`);
  return permissions();
}

async function moveMouse(x, y) {
  await requireAccessibility();
  return jxa('post($.CGEventCreateMouseEvent(null, 5, {x: args.x, y: args.y}, 0)); return true;', { x, y });
}

async function click(x, y, button = 'left', doubleClick = false) {
  if (!own(BUTTONS, button)) throw new Error(`Unknown mouse button '${button}'`);
  await requireAccessibility();
  return jxa(`
    var btn = args.btn;
    var down = [1, 3, 25][btn], up = [2, 4, 26][btn];
    var p = args.x === null ? $.CGEventGetLocation($.CGEventCreate(null)) : {x: args.x, y: args.y};
    post($.CGEventCreateMouseEvent(null, 5, p, 0)); sleep(40);
    for (var i = 1; i <= args.clicks; i++) {
      var d = $.CGEventCreateMouseEvent(null, down, p, btn); $.CGEventSetIntegerValueField(d, 1, i); post(d);
      var u = $.CGEventCreateMouseEvent(null, up, p, btn); $.CGEventSetIntegerValueField(u, 1, i); post(u);
      sleep(60);
    }
    return true;`, { x: x === undefined ? null : x, y: y === undefined ? null : y,
    btn: BUTTONS[button], clicks: doubleClick ? 2 : 1 });
}

async function drag(fromX, fromY, toX, toY) {
  await requireAccessibility();
  return jxa(`
    post($.CGEventCreateMouseEvent(null, 5, {x: args.fx, y: args.fy}, 0)); sleep(40);
    post($.CGEventCreateMouseEvent(null, 1, {x: args.fx, y: args.fy}, 0)); sleep(60);
    for (var i = 1; i <= 15; i++) {
      var x = args.fx + (args.tx - args.fx) * i / 15, y = args.fy + (args.ty - args.fy) * i / 15;
      post($.CGEventCreateMouseEvent(null, 6, {x: x, y: y}, 0)); sleep(15);
    }
    post($.CGEventCreateMouseEvent(null, 2, {x: args.tx, y: args.ty}, 0));
    return true;`, { fx: fromX, fy: fromY, tx: toX, ty: toY });
}

function scrollDeltas(lines, direction) {
  const sign = direction === 'up' || direction === 'left' ? 1 : -1;
  const horizontal = direction === 'left' || direction === 'right';
  return { count: horizontal ? 2 : 1, v: horizontal ? 0 : sign * lines, h: horizontal ? sign * lines : 0 };
}

async function scroll(lines = 3, direction = 'down') {
  if (!['up', 'down', 'left', 'right'].includes(direction)) throw new Error(`Unknown scroll direction '${direction}'`);
  await requireAccessibility();
  return jxa(`
    ObjC.bindFunction("CGEventCreateScrollWheelEvent2", ["id", ["void*", "int", "unsigned int", "int", "int", "int"]]);
    post($.CGEventCreateScrollWheelEvent2(null, 1, args.count, args.v, args.h, 0)); return true;`,
  scrollDeltas(lines, direction));
}

async function pressKey(key, modifiers = []) {
  const args = { code: keyCode(key), flags: flagsFor(modifiers) };
  await requireAccessibility();
  return jxa(`
    var d = $.CGEventCreateKeyboardEvent(null, args.code, true);  $.CGEventSetFlags(d, args.flags); post(d);
    var u = $.CGEventCreateKeyboardEvent(null, args.code, false); $.CGEventSetFlags(u, args.flags); post(u);
    return true;`, args);
}

async function hotkey(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('keys must be a non-empty array');
  return pressKey(keys[keys.length - 1], keys.slice(0, -1));
}

async function typeText(text, delayMs = 15) {
  if (typeof text !== 'string' || !text) throw new Error('Text is required');
  if (text.length > MAX_TYPE_LENGTH) throw new Error(`Text is longer than ${MAX_TYPE_LENGTH} characters`);
  await requireAccessibility();
  return jxa(`
    function withText(e, units) {
      var r = Ref('unsigned short');
      for (var j = 0; j < units.length; j++) r[j] = units[j];
      $.CGEventSetFlags(e, 0); $.CGEventKeyboardSetUnicodeString(e, units.length, r); return e;
    }
    var s = args.text;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charCodeAt(i);
      if (ch === 10 || ch === 13 || ch === 9) {
        var code = ch === 9 ? 48 : 36;
        post($.CGEventCreateKeyboardEvent(null, code, true)); post($.CGEventCreateKeyboardEvent(null, code, false));
        if (ch === 13 && s.charCodeAt(i + 1) === 10) i++;
      } else {
        var units = (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < s.length) ? [ch, s.charCodeAt(++i)] : [ch];
        post(withText($.CGEventCreateKeyboardEvent(null, 0, true), units));
        post(withText($.CGEventCreateKeyboardEvent(null, 0, false), units));
      }
      sleep(args.delay);
    }
    return s.length;`, { text, delay: delayMs }, 20000 + text.length * (delayMs + 10));
}

async function mousePosition() {
  return jxa('var p = $.CGEventGetLocation($.CGEventCreate(null)); return {x: Math.round(p.x), y: Math.round(p.y)};');
}

const DISPLAYS_JXA = `
  var screens = $.NSScreen.screens, out = [];
  var primaryH = screens.count ? screens.objectAtIndex(0).frame.size.height : 0;
  for (var i = 0; i < screens.count; i++) {
    var s = screens.objectAtIndex(i), f = s.frame;
    out.push({ name: s.localizedName ? ObjC.unwrap(s.localizedName) : undefined,
      x: f.origin.x, y: primaryH - f.origin.y - f.size.height,
      width: f.size.width, height: f.size.height, scaleFactor: s.backingScaleFactor, primary: i === 0 });
  }
  return out;`;

async function displays() {
  const list = await jxa(DISPLAYS_JXA);
  return Array.isArray(list) ? list : [];
}

async function screenSize() {
  const primary = (await displays())[0];
  if (!primary) throw new Error('No display found');
  return { width: primary.width, height: primary.height, scaleFactor: primary.scaleFactor };
}

async function frontmostApp() {
  return jxa(`
    var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!a || a.isNil()) return { app: null, title: '' };
    var out = { app: ObjC.unwrap(a.localizedName) || null, bundleId: ObjC.unwrap(a.bundleIdentifier) || null,
      pid: a.processIdentifier, title: '' };
    var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i], b = w.kCGWindowBounds || {};
      if (w.kCGWindowOwnerPID !== out.pid || w.kCGWindowLayer !== 0 || !(w.kCGWindowAlpha > 0)) continue;
      if (b.Width < 50 || b.Height < 50) continue;
      out.title = w.kCGWindowName || '';
      out.bounds = { x: b.X, y: b.Y, width: b.Width, height: b.Height };
      break;
    }
    return out;`);
}

function findRunning(name, loose = false) {
  return jxa(`
    var q = args.q.toLowerCase();
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications, hits = [];
    for (var i = 0; i < apps.count; i++) {
      var a = apps.objectAtIndex(i); if (a.activationPolicy !== 0) continue;
      var n = ObjC.unwrap(a.localizedName) || '', lc = n.toLowerCase(), b = (ObjC.unwrap(a.bundleIdentifier) || '').toLowerCase();
      var score = lc === q ? 3 : lc.indexOf(q) === 0 ? 2 : (lc.indexOf(q) >= 0 || b.indexOf(q) >= 0) ? 1
        : (args.loose && lc.length >= 3 && q.indexOf(lc) >= 0) ? 1 : 0;
      if (score) hits.push({ name: n, pid: a.processIdentifier, score: score });
    }
    hits.sort(function (x, y) { return y.score - x.score; });
    return hits;`, { q: appQuery(name), loose: !!loose });
}

function appMatches(front, name) {
  const q = appQuery(name).toLowerCase();
  const n = String((front && front.app) || '').toLowerCase();
  if (!n) return false;
  if (n === q) return true;
  const shorter = Math.min(n.length, q.length);
  if (shorter >= 3 && (n.includes(q) || q.includes(n))) return true;
  const compact = q.replace(/\s+/g, '');
  const bundle = String((front && front.bundleId) || '').toLowerCase();
  return compact.length >= 3 && bundle.split('.').slice(1).some((part) => part === compact);
}

async function activate(name) {
  const hits = await findRunning(name, true);
  if (!hits.length) return { focused: false, reason: `'${name}' is not running` };
  await jxa(`
    var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(args.pid);
    if (!a || a.isNil()) return false;
    a.unhide; a.activateWithOptions(3); return true;`, { pid: hits[0].pid });
  return waitForFront(hits[0].name, 3000);
}

async function quit(name) {
  const q = appQuery(name);
  const hits = (await findRunning(q)).filter((h) => h.score >= 2 || q.length >= 3);
  if (!hits.length) return { closed: false, reason: `'${name}' is not running` };
  await jxa(`
    var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(args.pid);
    if (!a || a.isNil()) return false;
    a.terminate; return true;`, { pid: hits[0].pid });
  return { closed: true, application: hits[0].name };
}

async function waitForFront(name, timeoutMs = 8000) {
  appQuery(name);
  const start = Date.now();
  let front = null;
  for (;;) {
    front = await frontmostApp().catch(() => null);
    if (appMatches(front, name)) return { focused: true, frontmost: front };
    if (Date.now() - start >= timeoutMs) return { focused: false, frontmost: front };
    await new Promise((r) => setTimeout(r, 250));
  }
}

const ALIASES = {
  'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', code: 'Visual Studio Code',
  chrome: 'Google Chrome', 'google chrome': 'Google Chrome', 'file explorer': 'Finder',
  explorer: 'Finder', files: 'Finder', settings: 'System Settings', 'system preferences': 'System Settings',
  notepad: 'TextEdit', 'text edit': 'TextEdit', browser: 'Safari', mail: 'Mail', music: 'Music',
  whatsapp: 'WhatsApp', teams: 'Microsoft Teams', word: 'Microsoft Word', excel: 'Microsoft Excel',
  powerpoint: 'Microsoft PowerPoint', outlook: 'Microsoft Outlook', calculator: 'Calculator'
};

function installedApps() {
  return new Promise((resolve) => {
    cp.execFile('mdfind', ['kMDItemContentType == "com.apple.application-bundle"'], { timeout: 10000, maxBuffer: 8 << 20 },
      (err, out) => resolve(err ? [] : String(out).split('\n').filter(Boolean)
        .map((p) => ({ path: p, name: p.split('/').pop().replace(/\.app$/, '') }))));
  });
}

function pickApp(apps, name) {
  const q = appQuery(name).replace(/\s+app$/i, '');
  const lc = q.toLowerCase();
  if (own(ALIASES, lc)) return ALIASES[lc];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nq = norm(q);
  if (nq) {
    const exact = apps.find((a) => norm(a.name) === nq);
    if (exact) return exact.path;
  }
  const byLength = (list) => list.sort((a, b) => a.name.length - b.name.length ||
    (a.path.startsWith('/Applications') ? -1 : 1))[0];
  const starts = nq ? apps.filter((a) => norm(a.name).startsWith(nq)) : [];
  const has = nq ? apps.filter((a) => norm(a.name).includes(nq)) : [];
  const compact = lc.replace(/\s+/g, '');
  const init = compact.length >= 2
    ? apps.filter((a) => a.name.split(/\s+/).map((w) => w[0] || '').join('').toLowerCase() === compact) : [];
  const hit = byLength(starts) || byLength(has) || byLength(init);
  return hit ? hit.path : q;
}

async function resolveApp(name) {
  const lc = appQuery(name).replace(/\s+app$/i, '').toLowerCase();
  return pickApp(own(ALIASES, lc) ? [] : await installedApps(), name);
}

function openBundle(target, args, file = null) {
  return new Promise((resolve, reject) => {
    cp.execFile('open', ['-a', target, ...(file ? [file] : []), ...(args.length ? ['--args', ...args] : [])], { timeout: 15000 },
      (err, _out, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve());
  });
}

async function openApp(name, args = [], file = null) {
  const requested = appQuery(name);
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error('args must be an array of strings');
  if (file !== null && (typeof file !== 'string' || !(file.startsWith('/') || /^(https?|mailto):/i.test(file)))) {
    throw new Error('file must be an absolute path or a URL');
  }
  let target = requested;
  try { await openBundle(target, args, file); }
  catch (first) {
    target = await resolveApp(requested);
    if (target === requested) throw new Error(`Could not open '${requested}': ${first.message}`);
    try { await openBundle(target, args, file); }
    catch (e) { throw new Error(`Could not open '${requested}' (tried ${target}): ${e.message}`); }
  }
  const application = (target.startsWith('/') ? target.split('/').pop() : target).replace(/\.app$/i, '');
  const state = await waitForFront(application, 8000);
  const final = state.focused ? state : await activate(application);
  return { application, launched: true, platform: 'darwin', ...(file ? { opened: file } : {}),
    focused: !!final.focused, frontmost: final.frontmost || state.frontmost };
}

async function ensureFront(app) {
  if (!app) return null;
  let st = await waitForFront(app, 300);
  if (!st.focused) st = await activate(app);
  if (!st.focused) {
    const now = st.frontmost && st.frontmost.app;
    throw new Error(`Refusing to send input: '${app}' is not in front${now ? ` ('${now}' is)` : ''}. ` +
      'Open or focus it first.');
  }
  return st.frontmost;
}

module.exports = {
  __waitForFront: waitForFront,
  ensureFront, openApp, permissions, requestPermissions, moveMouse, click, drag, scroll,
  pressKey, hotkey, typeText, mousePosition, screenSize, displays, frontmostApp, activate, quit,
  __test: { jxa, jxaScript, keyCode, flagsFor, appQuery, appMatches, pickApp, scrollDeltas, MAX_TYPE_LENGTH }
};
