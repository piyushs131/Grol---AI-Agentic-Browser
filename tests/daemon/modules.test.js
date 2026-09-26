// Capability modules: input validation, injection safety and filesystem policy.
// Nothing here clicks, types, opens/closes apps or runs arbitrary commands:
// OS calls are stubbed, or are read-only (screen size, frontmost window, ps).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULES = path.join(__dirname, '..', '..', 'ai-agent-os', 'modules');
const macInput = require(path.join(MODULES, 'desktop', 'mac-input'));
const DesktopModule = require(path.join(MODULES, 'desktop'));
const ProcessModule = require(path.join(MODULES, 'process'));
const windowsApps = require(path.join(MODULES, 'process', 'windows-apps'));
const ScreenModule = require(path.join(MODULES, 'screen'));
const FilesystemModule = require(path.join(MODULES, 'filesystem'));
const BrowserModule = require(path.join(MODULES, 'browser'));

const isMac = process.platform === 'darwin';
const EVIL = [
  'a"b', "a'b", 'a\\b', 'a`id`b', 'a$(id)b', '${process.exit()}', 'line1\nline2', '  ',
  '’; Start-Process calc; ‘', '"; rm -rf ~; echo "', '😀 emoji ☃ 日本語', '%^+{}[]()~'
];

// Replaces obj[name] for the duration of fn, always restoring it.
async function withStub(obj, name, impl, fn) {
  const original = obj[name];
  obj[name] = impl;
  try { return await fn(); } finally { obj[name] = original; }
}

// Records execFile calls and answers each via respond(file, args, opts) -> stdout.
function execFileRecorder(respond = () => '') {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    calls.push({ file, args, opts });
    let out;
    try { out = respond(file, args, opts); } catch (err) { setImmediate(() => cb(err, '', err.message)); return {}; }
    setImmediate(() => cb(null, out, ''));
    return {};
  };
  return { calls, execFile };
}

const noOsCalls = () => execFileRecorder(() => { throw new Error('unexpected OS call'); });

async function initialized(Module, context = {}) {
  const m = new Module();
  await m.initialize(context);
  return m;
}

describe('mac-input: JXA data passing', () => {
  const { jxa, jxaScript } = macInput.__test;

  test('arguments travel in argv as JSON, never inside the script source', async () => {
    const rec = execFileRecorder(() => '1');
    await withStub(cp, 'execFile', rec.execFile, () => jxa('return args.s;', { s: EVIL.join('|') }));
    const [{ file, args }] = rec.calls;
    assert.equal(file, 'osascript');
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    assert.equal(args[4], '--');
    assert.equal(args[3], jxaScript('return args.s;'));
    for (const s of EVIL) assert.ok(!args[3].includes(s), `script must not contain ${s}`);
    assert.deepEqual(JSON.parse(args[5]), { s: EVIL.join('|') });
  });

  test('hostile strings round-trip unchanged through real osascript', { skip: !isMac }, async () => {
    for (const s of EVIL) assert.equal(await jxa('return args.s;', { s }), s);
  });

  test('quit passes the app name as data and matches strictly', async () => {
    const rec = execFileRecorder(() => '[]');
    const name = 'Evil"); $.NSWorkspace.sharedWorkspace; ("';
    const r = await withStub(cp, 'execFile', rec.execFile, () => macInput.quit(name));
    assert.deepEqual(r, { closed: false, reason: `'${name}' is not running` });
    assert.equal(rec.calls.length, 1);
    assert.ok(!rec.calls[0].args[3].includes('Evil'));
    assert.equal(JSON.parse(rec.calls[0].args[5]).q, name);
  });

  test('quit refuses a fuzzy short match (e.g. "o" must not quit Chrome)', async () => {
    const rec = execFileRecorder(() => JSON.stringify([{ name: 'Google Chrome', pid: 42, score: 1 }]));
    const r = await withStub(cp, 'execFile', rec.execFile, () => macInput.quit('o'));
    assert.equal(r.closed, false);
    assert.equal(rec.calls.length, 1, 'no terminate call');
  });

  test('empty or degenerate app names are rejected before any OS call', async () => {
    const rec = noOsCalls();
    await withStub(cp, 'execFile', rec.execFile, async () => {
      for (const bad of ['', '   ', '.app', 'a\nb', 'x'.repeat(300), null, 42]) {
        await assert.rejects(macInput.quit(bad), /Application name/);
        await assert.rejects(macInput.openApp(bad), /Application name/);
      }
      await assert.rejects(macInput.openApp('Safari', 'not-an-array'), /args must be an array/);
    });
    assert.equal(rec.calls.length, 0);
  });

  test('openApp hands the name to `open -a` as one argv element', async () => {
    const name = 'My App"; touch /tmp/pwned; echo "';
    const rec = execFileRecorder((file) => (file === 'open' ? ''
      : JSON.stringify({ app: name, bundleId: 'x.y', pid: 1, title: '' })));
    const r = await withStub(cp, 'execFile', rec.execFile, () => macInput.openApp(name, ['--flag']));
    assert.deepEqual(rec.calls[0], { file: 'open', args: ['-a', name, '--args', '--flag'], opts: rec.calls[0].opts });
    assert.equal(r.focused, true);
    assert.equal(r.frontmost.app, name);
  });

  test('keyCode / flagsFor reject unknown names and inherited keys', () => {
    const { keyCode, flagsFor } = macInput.__test;
    assert.equal(keyCode('Enter'), 36);
    assert.equal(keyCode('A'), 0);
    assert.throws(() => keyCode('nokey'), /Unknown key/);
    assert.throws(() => keyCode('constructor'), /Unknown key/);
    assert.throws(() => keyCode('__proto__'), /Unknown key/);
    assert.equal(flagsFor(['cmd', 'shift']), 0x120000);
    assert.throws(() => flagsFor(['hyper']), /Unknown modifier/);
    assert.throws(() => flagsFor(['toString']), /Unknown modifier/);
    assert.throws(() => flagsFor('cmd'), /must be an array/);
  });

  test('scroll deltas: sign and axis per direction', () => {
    const { scrollDeltas } = macInput.__test;
    assert.deepEqual(scrollDeltas(3, 'up'), { count: 1, v: 3, h: 0 });
    assert.deepEqual(scrollDeltas(3, 'down'), { count: 1, v: -3, h: 0 });
    assert.deepEqual(scrollDeltas(2, 'left'), { count: 2, v: 0, h: 2 });
    assert.deepEqual(scrollDeltas(2, 'right'), { count: 2, v: 0, h: -2 });
  });

  test('appMatches is loose for real names but not for tiny queries', () => {
    const { appMatches } = macInput.__test;
    const code = { app: 'Code', bundleId: 'com.microsoft.VSCode' };
    assert.ok(appMatches(code, 'Visual Studio Code'));
    assert.ok(appMatches(code, 'vscode'));
    assert.ok(appMatches({ app: 'Google Chrome' }, 'chrome'));
    assert.ok(appMatches({ app: 'Safari' }, 'Safari.app'));
    assert.ok(!appMatches({ app: 'Google Chrome' }, 'o'));
    assert.ok(!appMatches({ app: 'Finder', bundleId: 'com.apple.finder' }, 'com'));
    assert.ok(!appMatches(null, 'Safari'));
  });

  test('pickApp resolves aliases, exact names, prefixes and initials', () => {
    const { pickApp } = macInput.__test;
    const apps = [
      { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app' },
      { name: 'Slack', path: '/Applications/Slack.app' },
      { name: 'Slack Helper', path: '/Applications/Slack Helper.app' }
    ];
    assert.equal(pickApp(apps, 'chrome'), 'Google Chrome');
    assert.equal(pickApp(apps, 'slack app'), '/Applications/Slack.app');
    assert.equal(pickApp(apps, 'sla'), '/Applications/Slack.app');
    assert.equal(pickApp(apps, 'vsc'), '/Applications/Visual Studio Code.app');
    assert.equal(pickApp(apps, 'Unknown Thing'), 'Unknown Thing');
  });

  test('typeText refuses empty and over-long text before any OS call', async () => {
    const rec = noOsCalls();
    await withStub(cp, 'execFile', rec.execFile, async () => {
      await assert.rejects(macInput.typeText(''), /Text is required/);
      await assert.rejects(macInput.typeText('x'.repeat(macInput.__test.MAX_TYPE_LENGTH + 1)), /longer than/);
      await assert.rejects(macInput.pressKey('nokey'), /Unknown key/);
      await assert.rejects(macInput.click(1, 1, 'side'), /Unknown mouse button/);
      await assert.rejects(macInput.scroll(3, 'sideways'), /Unknown scroll direction/);
    });
    assert.equal(rec.calls.length, 0);
  });
});

describe('desktop: parameter validation', () => {
  const t = DesktopModule.__test;

  test('coordinates', () => {
    assert.equal(t.toCoordinate(10, 'x'), 10);
    assert.equal(t.toCoordinate(-200.5, 'x'), -200.5, 'secondary displays can be negative');
    assert.equal(t.toCoordinate(' 42 ', 'x'), 42);
    for (const bad of [NaN, Infinity, -Infinity, '', ' ', 'abc', null, undefined, true, [], {}, 1e9]) {
      assert.throws(() => t.toCoordinate(bad, 'x'), /x must be a finite number/, String(bad));
    }
    assert.deepEqual(t.toOptionalPoint(undefined, undefined), { x: undefined, y: undefined });
    assert.throws(() => t.toOptionalPoint(5, undefined), /both x and y/);
  });

  test('button, direction, amount, delay, text', () => {
    assert.equal(t.toButton('RIGHT'), 'right');
    assert.throws(() => t.toButton('side'), /button must be/);
    assert.equal(t.toDirection('Up'), 'up');
    assert.throws(() => t.toDirection('diagonal'), /direction must be/);
    assert.equal(t.toScrollAmount(2.6), 3);
    assert.equal(t.toScrollAmount('4'), 4);
    assert.equal(t.toScrollAmount(0.2), 1);
    assert.equal(t.toScrollAmount(1e6), 100);
    for (const bad of [0, -3, NaN, 'x', null, Infinity]) assert.throws(() => t.toScrollAmount(bad), /positive number/);
    assert.equal(t.toDelay(undefined), undefined);
    assert.equal(t.toDelay(5000), 1000);
    assert.throws(() => t.toDelay(-1), /delay/);
    assert.equal(t.toText(12), '12');
    assert.throws(() => t.toText(''), /Text is required/);
    assert.throws(() => t.toText({}), /Text is required/);
    assert.throws(() => t.toText('x'.repeat(20001)), /longer than/);
  });

  test('key combos and hotkeys normalise', () => {
    assert.deepEqual(t.normalizeKeyCombo('cmd+shift+N'), { key: 'n', modifiers: ['cmd', 'shift'] });
    assert.deepEqual(t.normalizeKeyCombo('Return', 'Command, Option'), { key: 'enter', modifiers: ['cmd', 'alt'] });
    assert.deepEqual(t.normalizeKeyCombo('a', null), { key: 'a', modifiers: [] });
    assert.deepEqual(t.normalizeKeyCombo('+'), { key: '+', modifiers: [] });
    assert.deepEqual(t.normalizeKeyCombo('cmd++'), { key: '+', modifiers: ['cmd'] });
    assert.deepEqual(t.normalizeKeyCombo('ArrowUp', ['meta', 'cmd']), { key: 'up', modifiers: ['cmd'] });
    assert.throws(() => t.normalizeKeyCombo(''), /Key is required/);
    assert.throws(() => t.normalizeKeyCombo(undefined), /Key is required/);
    assert.throws(() => t.normalizeKeyCombo('a', ['hyper']), /Unknown modifier/);
    assert.throws(() => t.normalizeKeyCombo('a', { cmd: true }), /modifiers must be/);
    assert.deepEqual(t.normalizeHotkey('cmd+n'), ['cmd', 'n']);
    assert.deepEqual(t.normalizeHotkey(['ctrl', 'shift', 'T']), ['ctrl', 'shift', 't']);
    assert.deepEqual(t.normalizeHotkey(['cmd+shift', 'n']), ['cmd', 'shift', 'n']);
    for (const bad of [[], '', null, undefined, [1], ['']]) assert.throws(() => t.normalizeHotkey(bad), /keys must be/);
  });

  test('Windows SendKeys escaping', () => {
    assert.equal(t.toSendKeys('c', ['ctrl']), '^c');
    assert.equal(t.toSendKeys('c', ['cmd']), '^c');
    assert.equal(t.toSendKeys('enter', ['shift', 'alt']), '+%{ENTER}');
    assert.equal(t.toSendKeys('+'), '{+}');
    assert.throws(() => t.toSendKeys('nokey'), /Unknown key/);
    assert.throws(() => t.toSendKeys('a', ['super']), /not supported/);
    assert.equal(t.sendKeysText('a+b^c%(x){y}[z]~'), 'a{+}b{^}c{%}{(}x{)}{{}y{}}{[}z{]}{~}');
    assert.equal(t.sendKeysText('l1\r\nl2\nl3\tend'), 'l1{ENTER}l2{ENTER}l3{TAB}end');
  });

  test('bad input is refused before any OS call', async () => {
    const desktop = await initialized(DesktopModule);
    const rec = noOsCalls();
    const cases = [
      ['clickMouse', { x: 'abc', y: 1 }, /x must be a finite number/],
      ['clickMouse', { x: NaN, y: 1 }, /x must be a finite number/],
      ['clickMouse', { x: 1 }, /both x and y/],
      ['clickMouse', { x: 1, y: 1, button: 'side' }, /button must be/],
      ['rightClick', { x: 1e12, y: 1 }, /x must be a finite number/],
      ['moveMouse', { x: 1 }, /coordinates are required/],
      ['dragMouse', { fromX: 0, fromY: 0, toX: 'far', toY: 0 }, /toX must be a finite number/],
      ['scrollMouse', { amount: NaN }, /positive number/],
      ['scrollMouse', { direction: 'sideways' }, /direction must be/],
      ['typeText', {}, /Text is required/],
      ['typeText', { text: 'x'.repeat(20001) }, /longer than/],
      ['pressKey', {}, /Key is required/],
      ['pressKey', { key: 'a', modifiers: ['hyper'] }, /Unknown modifier/],
      ['hotkey', { keys: [] }, /keys must be/],
      ['hotkey', { keys: '' }, /keys must be/],
      ['focusWindow', { title: '  ' }, /title is required/]
    ];
    await withStub(cp, 'execFile', rec.execFile, async () => {
      for (const [action, params, re] of cases) {
        await assert.rejects(desktop.execute(action, params), re, `${action} ${JSON.stringify(params)}`);
      }
      if (isMac) await assert.rejects(desktop.execute('pressKey', { key: 'nokey' }), /Unknown key/);
    });
    assert.equal(rec.calls.length, 0);
  });

  test('macOS never uses nut-js (it would skip the Accessibility check)', () => {
    assert.equal(t.pickBackend('darwin'), macInput);
  });

  test('Windows backend passes text via the environment, not the script', { skip: new DesktopModule().hasNutJs }, async () => {
    const backend = t.pickBackend('win32');
    const rec = execFileRecorder(() => '');
    const text = '$(Start-Process calc) "`n\' ’; calc; ‘ +^%';
    await withStub(cp, 'execFile', rec.execFile, () => backend.typeText(text));
    const [{ file, args, opts }] = rec.calls;
    assert.equal(file, 'powershell');
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.ok(!script.includes('calc'), 'data must not be spliced into the script');
    assert.match(script, /\$env:GROL_KEYS/);
    assert.equal(opts.env.GROL_KEYS, t.sendKeysText(text));
  });

  test('registered actions and risk levels are not weakened', async () => {
    const desktop = await initialized(DesktopModule);
    const actions = desktop.getManifest().actions;
    const expected = {
      moveMouse: 'medium', clickMouse: 'medium', dragMouse: 'medium', pressKey: 'high', typeText: 'medium',
      hotkey: 'high', getMousePosition: 'low', getScreenSize: 'low', scrollMouse: 'low', rightClick: 'medium',
      getActiveWindow: 'low', focusWindow: 'medium', openApplication: 'medium', closeApplication: 'high',
      listProcesses: 'low', getSystemInfo: 'low', executeCommand: 'high', isRunning: 'low', screenshot: 'low'
    };
    if (isMac) Object.assign(expected, { getPermissions: 'low', requestPermissions: 'low' });
    for (const [name, risk] of Object.entries(expected)) assert.equal(actions[name]?.riskLevel, risk, name);
  });
});

describe('desktop: live read-only calls', { skip: !isMac }, () => {
  let desktop;
  before(async () => { desktop = await initialized(DesktopModule); });

  test('getScreenSize returns the real size in points', async () => {
    const s = await desktop.execute('getScreenSize');
    assert.ok(s.width > 0 && s.height > 0 && s.scaleFactor >= 1);
    assert.equal(s.note, undefined);
  });

  test('getActiveWindow reports app, title and bounds', async () => {
    const w = await desktop.execute('getActiveWindow');
    assert.equal(typeof w.title, 'string');
    if (w.app) assert.equal(typeof w.pid, 'number');
    if (w.bounds) for (const k of ['x', 'y', 'width', 'height']) assert.equal(typeof w.bounds[k], 'number');
  });

  test('getPermissions has the contract shape', async () => {
    const p = await desktop.execute('getPermissions');
    assert.equal(typeof p.accessibility, 'boolean');
    assert.equal(typeof p.screenRecording, 'boolean');
    assert.equal(p.binary, process.execPath);
  });
});

describe('windows-apps: PowerShell quoting', () => {
  const { powerShellArgs, cleanQuery } = windowsApps.__test;

  test('scripts are base64 UTF-16LE encoded commands', () => {
    const args = powerShellArgs('Write-Output "hi ☃"');
    assert.equal(args[args.length - 2], '-EncodedCommand');
    assert.equal(Buffer.from(args[args.length - 1], 'base64').toString('utf16le'), 'Write-Output "hi ☃"');
  });

  test('queries travel via env; where.exe gets argv; wildcards are refused', async () => {
    const calls = [];
    const query = "Evil’; Start-Process calc; ‘x";
    await withStub(cp, 'execFileSync', (file, args, opts) => { calls.push({ file, args, opts }); return ''; }, () => {
      windowsApps.searchInstalledApplications(query);
    });
    const ps = calls.filter((c) => c.file === 'powershell');
    assert.equal(ps.length, 2);
    for (const c of ps) {
      const script = Buffer.from(c.args[c.args.length - 1], 'base64').toString('utf16le');
      assert.ok(!script.includes('calc'));
      assert.equal(c.opts.env.GROL_Q, query);
    }
    const where = calls.filter((c) => c.file === 'where.exe');
    assert.deepEqual(where.map((c) => c.args), [[query], [`${query}.exe`]]);
    assert.equal(cleanQuery('*'), '');
    assert.equal(cleanQuery('a?b'), '');
    assert.equal(cleanQuery('x"y'), '');
    assert.equal(cleanQuery(' Notepad '), 'Notepad');
  });

  test('openApplication rejects wildcard names', async () => {
    await assert.rejects(windowsApps.openApplication('*'), /plain, non-empty name/);
  });
});

describe('process module', () => {
  const t = ProcessModule.__test;

  test('blocked command patterns', () => {
    const blocked = [
      'rm -rf /', 'rm -rf / ', 'rm -fr /*', 'rm -rf ~', 'rm -rf ~/', 'rm -r -f $HOME',
      'sudo rm -rf --no-preserve-root /', ':(){ :|:& };:', 'dd if=/dev/zero of=/dev/disk0',
      'mkfs.ext4 /dev/sda1', 'diskutil eraseDisk JHFS+ X disk2', 'format C:', 'cat x > /dev/sda'
    ];
    const allowed = ['rm -rf /tmp/build', 'rm -rf ./dist', 'ls -la /', 'echo hi', 'rm -rf ~/project/tmp', 'dd --help'];
    for (const c of blocked) assert.throws(() => t.assertAllowedCommand(c), /blocked/, c);
    for (const c of allowed) assert.doesNotThrow(() => t.assertAllowedCommand(c), c);
    for (const bad of ['', '   ', null, 42, 'a\0b', 'x'.repeat(20000)]) assert.throws(() => t.assertAllowedCommand(bad));
  });

  test('timeout, cwd, pid and args validation', () => {
    assert.equal(t.toTimeout(undefined), 30000);
    assert.equal(t.toTimeout(5), 100);
    assert.equal(t.toTimeout(1e12), 600000);
    for (const bad of [0, -1, NaN, 'abc']) assert.throws(() => t.toTimeout(bad), /timeout/);
    assert.equal(t.toCwd(undefined), os.homedir());
    assert.equal(t.toCwd('~'), os.homedir());
    assert.equal(t.toCwd(os.tmpdir()), path.resolve(os.tmpdir()));
    assert.throws(() => t.toCwd('/definitely/not/here'), /does not exist/);
    assert.throws(() => t.toCwd(__filename), /not a directory/);
    assert.throws(() => t.toCwd(5), /must be a string/);
    assert.equal(t.toPid('1234'), 1234);
    for (const bad of ['0', '1', '-5', '12abc', '1; rm -rf ~', 1.5, '', null, '99999999999']) {
      assert.throws(() => t.toPid(bad), /PID|Refusing/, String(bad));
    }
    assert.throws(() => t.toPid(process.pid), /helper itself/);
    assert.deepEqual(t.toArgs(undefined), []);
    assert.deepEqual(t.toArgs('--new'), ['--new']);
    assert.throws(() => t.toArgs([{}]), /args must be/);
  });

  test('process filters match names; a PID filter must be exact', () => {
    const list = [{ name: '/Applications/Safari.app', pid: 123 }, { name: 'node server.js', pid: 4123 }];
    assert.deepEqual(t.filterProcesses(list, 'safari').map((p) => p.pid), [123]);
    assert.deepEqual(t.filterProcesses(list, '123').map((p) => p.pid), [123]);
    assert.deepEqual(t.filterProcesses(list, '123', { byPid: false }), []);
    assert.equal(t.filterProcesses(list, '').length, 2);
  });

  test('ps / tasklist parsing', () => {
    const ps = 'USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND\n' +
      'me 42 1.5 0.3 1 2 ?? S 9:00 0:01 /usr/bin/thing --flag value\n';
    assert.deepEqual(t.parsePs(ps), [{ user: 'me', pid: 42, cpu: 1.5, mem: 0.3, name: '/usr/bin/thing --flag value' }]);
    const tl = '"chrome.exe","1234","Console","1","120,000 K"\r\n';
    assert.equal(t.parseTasklist(tl)[0].pid, 1234);
    assert.equal(t.parseTasklist(tl)[0].memory, '120,000 K');
  });

  test('executeCommand spawns /bin/sh in its own process group', { skip: process.platform === 'win32' }, async () => {
    const proc = await initialized(ProcessModule);
    const spawned = [];
    const fakeSpawn = (file, args, opts) => {
      spawned.push({ file, args, opts });
      const child = new EventEmitter();
      child.pid = 999999;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('out\n'));
        child.stderr.emit('data', Buffer.from('warn\n'));
        child.emit('close', 3, null);
      });
      return child;
    };
    const cmd = 'echo "$(whoami)" `id` \'quoted\'';
    const r = await withStub(cp, 'spawn', fakeSpawn, () => proc.execute('executeCommand', { command: cmd, cwd: os.tmpdir() }));
    assert.deepEqual(spawned[0].args, ['-c', cmd]);
    assert.equal(spawned[0].file, '/bin/sh');
    assert.equal(spawned[0].opts.detached, true);
    assert.equal(spawned[0].opts.cwd, path.resolve(os.tmpdir()));
    assert.deepEqual({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, success: r.success },
      { exitCode: 3, stdout: 'out', stderr: 'warn', success: false });
  });

  test('executeCommand timeout kills the process group', { skip: process.platform === 'win32' }, async () => {
    const proc = await initialized(ProcessModule);
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const kills = [];
    await withStub(cp, 'spawn', () => child, () => withStub(process, 'kill', (pid, sig) => {
      kills.push([pid, sig]);
      setImmediate(() => child.emit('close', null, sig));
    }, async () => {
      await assert.rejects(proc.execute('executeCommand', { command: 'sleep 100 | cat', timeout: 150 }), /timed out after 150ms/);
    }));
    assert.deepEqual(kills, [[-424242, 'SIGKILL']]);
  });

  test('executeCommand output is capped without killing the command', async () => {
    const { capture } = t;
    const c = capture(10);
    c.push(Buffer.from('12345'));
    c.push(Buffer.from('67890abc'));
    c.push(Buffer.from('more'));
    assert.equal(c.text(), '1234567890');
    assert.equal(c.truncated, true);
  });

  test('executeCommand refuses bad cwd/timeout before spawning', async () => {
    const proc = await initialized(ProcessModule);
    let spawnedCount = 0;
    await withStub(cp, 'spawn', () => { spawnedCount++; throw new Error('should not spawn'); }, async () => {
      await assert.rejects(proc.execute('executeCommand', { command: 'ls', cwd: '/no/such/dir' }), /cwd does not exist/);
      await assert.rejects(proc.execute('executeCommand', { command: 'ls', timeout: 0 }), /timeout/);
      await assert.rejects(proc.execute('executeCommand', { command: 'rm -rf /' }), /blocked/);
      await assert.rejects(proc.execute('executeCommand', {}), /command is required/);
    });
    assert.equal(spawnedCount, 0);
  });

  test('killProcess validates before signalling', async () => {
    const proc = await initialized(ProcessModule);
    await withStub(process, 'kill', () => { throw new Error('should not signal'); }, async () => {
      await assert.rejects(proc.execute('killProcess', { pid: '1 && reboot' }), /PID must be/);
      await assert.rejects(proc.execute('killProcess', { pid: 0 }), /Refusing/);
      await assert.rejects(proc.execute('killProcess', { pid: process.pid }), /helper itself/);
    });
  });

  test('closeApplication (Linux/Windows) uses exact names and refuses wildcards', async () => {
    const linux = await initialized(ProcessModule, { platform: 'linux' });
    const rec = execFileRecorder(() => '');
    await withStub(cp, 'execFile', rec.execFile, async () => {
      const r = await linux.execute('closeApplication', { name: 'my.app (beta)' });
      assert.equal(r.closed, true);
      await assert.rejects(linux.execute('closeApplication', { name: '*' }), /wildcards/);
      await assert.rejects(linux.execute('closeApplication', { name: '' }), /Application name/);
    });
    assert.deepEqual(rec.calls.map((c) => [c.file, c.args]), [['pkill', ['-x', '--', 'my\\.app \\(beta\\)']]]);

    const win = await initialized(ProcessModule, { platform: 'win32' });
    const recWin = execFileRecorder(() => '');
    await withStub(cp, 'execFile', recWin.execFile, async () => {
      await win.execute('closeApplication', { name: 'notepad' });
      await assert.rejects(win.execute('closeApplication', { name: 'note*' }), /wildcards/);
    });
    assert.deepEqual(recWin.calls[0].args, ['/IM', 'notepad.exe', '/F']);
  });

  test('isRunning / listProcesses / getSystemInfo (live, read-only)', { skip: process.platform === 'win32' }, async () => {
    const proc = await initialized(ProcessModule);
    const list = await proc.execute('listProcesses', { filter: 'node' });
    assert.ok(list.count >= 1);
    assert.ok(list.processes.some((p) => p.pid === process.pid));
    const running = await proc.execute('isRunning', { name: path.basename(process.execPath) });
    assert.equal(running.running, true);
    const missing = await proc.execute('isRunning', { name: 'definitely-not-a-process-xyz' });
    assert.equal(missing.running, false);
    await assert.rejects(proc.execute('isRunning', { name: '' }), /Application name/);
    const info = await proc.execute('getSystemInfo');
    assert.equal(info.platform, process.platform);
    assert.ok(info.cpu.cores > 0);
  });
});

describe('screen module', () => {
  const t = ScreenModule.__test;
  let dataDir;
  let screen;
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grol-screen-'));
    screen = await initialized(ScreenModule, { dataDir });
  });
  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  test('parameter validation', () => {
    assert.deepEqual(t.toRegion({ x: '1', y: 2.4, width: 10, height: 20 }), { x: 1, y: 2, width: 10, height: 20 });
    for (const bad of [{ x: 0, y: 0, width: 0, height: 5 }, { x: 'a', y: 0, width: 5, height: 5 },
      { x: null, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 5, height: Infinity }]) {
      assert.throws(() => t.toRegion(bad), /must be numbers/);
    }
    assert.equal(t.toAnalyzeWidth(undefined), undefined);
    assert.equal(t.toAnalyzeWidth(1439.6), 1440);
    for (const bad of [0, -5, NaN, 'wide', 1e6]) assert.throws(() => t.toAnalyzeWidth(bad), /width must be/);
    assert.equal(t.toQuality(undefined), 60);
    assert.equal(t.toQuality(500), 100);
    assert.equal(t.toQuality(-3), 1);
    assert.equal(t.toQuality('abc'), 60);
    assert.equal(t.toFormat('JPEG'), 'jpg');
    assert.throws(() => t.toFormat('../../x'), /format must be/);
    assert.equal(t.safeFilename('../../etc/passwd', 'fb'), 'passwd');
    assert.equal(t.safeFilename('a b"; rm', 'fb'), 'fb');
    assert.equal(t.safeFilename('.hidden', 'fb'), 'fb');
  });

  test('bad input is refused before capturing', async () => {
    const rec = noOsCalls();
    await withStub(cp, 'execFile', rec.execFile, async () => {
      await assert.rejects(screen.execute('analyzeScreen', { width: -1 }), /width must be/);
      await assert.rejects(screen.execute('takeScreenshot', { format: '"; rm -rf ~; "' }), /format must be/);
      await assert.rejects(screen.execute('takeRegionScreenshot', { x: 0, y: 0, width: 'x', height: 1 }), /must be numbers/);
    });
    assert.equal(rec.calls.length, 0);
  });

  test('screencapture gets the file path as one argv element', { skip: !isMac }, async () => {
    const rec = execFileRecorder(() => '');
    await withStub(cp, 'execFile', rec.execFile, () =>
      ScreenModule.captureScreen('darwin', '/tmp/a "b" $(id).png').catch(() => {}));
    assert.deepEqual(rec.calls[0].args, ['-x', '/tmp/a "b" $(id).png']);
  });

  test('analyzeScreen returns a JPEG at the requested width and cleans up (live)', { skip: !isMac }, async () => {
    const r = await screen.execute('analyzeScreen', { width: 800, quality: 40 });
    assert.equal(r.format, 'jpeg');
    assert.equal(r.width, 800);
    const img = Buffer.from(r.base64, 'base64');
    assert.equal(img.length, r.size);
    assert.deepEqual([...img.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'screenshots')), []);
  });

  test('getScreenInfo reports real displays on macOS', { skip: !isMac }, async () => {
    const info = await screen.execute('getScreenInfo');
    assert.ok(info.count >= 1);
    assert.equal(info.displays[0].primary, true);
    assert.ok(info.displays[0].width > 0);
    assert.equal(info.displays[0].note, undefined);
  });
});

describe('filesystem module', () => {
  let root;
  let home;
  let outside;
  let fsm;
  const run = (action, params) => fsm.execute(action, params);

  before(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grol-fs-')));
    home = path.join(root, 'home');
    outside = path.join(root, 'outside');
    for (const d of ['Desktop', 'Documents', 'Downloads', '.ssh']) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.mkdirSync(outside);
    fsm = await initialized(FilesystemModule, { homeDir: home });
  });
  after(() => {
    try { fs.chmodSync(path.join(home, 'Documents', 'locked'), 0o755); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('alias and relative path resolution', () => {
    const r = (p) => fsm._validatePath(p);
    assert.equal(r('desktop'), path.join(home, 'Desktop'));
    assert.equal(r('Desktop'), path.join(home, 'Desktop'));
    assert.equal(r('DESKTOP/'), path.join(home, 'Desktop'));
    assert.equal(r('desktop/notes/a.txt'), path.join(home, 'Desktop', 'notes', 'a.txt'));
    assert.equal(r('downloads\\x.txt'), path.join(home, 'Downloads', 'x.txt'));
    assert.equal(r('desktop/sub/../a.txt'), path.join(home, 'Desktop', 'a.txt'));
    assert.equal(r('~'), home);
    assert.equal(r('~/notes.txt'), path.join(home, 'notes.txt'));
    assert.equal(r('notes.txt'), path.join(home, 'notes.txt'), 'relative paths are relative to home');
    assert.equal(r(outside), outside);
    for (const bad of ['desktop/..', 'desktop/../..', 'Documents/../../etc', '~/..', 'desktop//etc/passwd']) {
      assert.throws(() => r(bad), /escapes/, bad);
    }
    for (const bad of [undefined, null, '', '   ', 5, {}, 'a\0b']) assert.throws(() => r(bad), /path/, String(bad));
  });

  test('system and credential locations are refused', () => {
    const r = (p) => fsm._validatePath(p);
    for (const p of ['/etc/hosts', '/private/etc/hosts', '/usr/bin/env', '/System', '/var/log', '/dev/null',
      '/Library/LaunchDaemons/x.plist', '~/.ssh/id_rsa', '~/.ssh', '.zshrc', '~/Library/LaunchAgents/x.plist',
      '~/.aws/credentials', path.join(outside, '..', 'home', '.ssh', 'authorized_keys')]) {
      assert.throws(() => r(p), /Access denied/, p);
    }
    assert.doesNotThrow(() => r(path.join(os.tmpdir(), 'x')), 'per-user temp under /var/folders stays usable');
  });

  test('symlinks cannot reach protected places, even dangling ones', { skip: process.platform === 'win32' }, async () => {
    fs.symlinkSync('/etc', path.join(home, 'Desktop', 'etc-link'));
    fs.symlinkSync('/etc/grol-should-not-exist', path.join(home, 'Desktop', 'dangling'));
    fs.symlinkSync(path.join(home, '.ssh', 'authorized_keys'), path.join(home, 'Desktop', 'keys'));
    fs.symlinkSync(path.join(home, 'Desktop', 'hop2'), path.join(home, 'Desktop', 'hop1'));
    fs.symlinkSync('/etc/grol-nope', path.join(home, 'Desktop', 'hop2'));
    await assert.rejects(run('readFile', { path: 'desktop/etc-link/hosts' }), /Access denied/);
    await assert.rejects(run('writeFile', { path: 'desktop/dangling', content: 'x' }), /Access denied/);
    await assert.rejects(run('writeFile', { path: 'desktop/keys', content: 'ssh-rsa AAA' }), /Access denied/);
    await assert.rejects(run('writeFile', { path: 'desktop/hop1', content: 'x' }), /Access denied/);
    assert.ok(!fs.existsSync(path.join(home, '.ssh', 'authorized_keys')));
    await assert.rejects(run('listDirectory', { path: 'desktop/etc-link' }), /Access denied/);
  });

  test('create / write / read / append / info / exists', async () => {
    assert.deepEqual(await run('createDirectory', { path: 'documents/proj' }),
      { path: path.join(home, 'Documents', 'proj'), created: true });
    const w = await run('writeFile', { path: 'documents/proj/a.txt', content: 'héllo 😀\n' });
    assert.equal(w.written, true);
    assert.equal(w.size, Buffer.byteLength('héllo 😀\n'));
    await run('appendFile', { path: 'documents/proj/a.txt', content: 'more' });
    const r = await run('readFile', { path: 'Documents/proj/a.txt' });
    assert.equal(r.content, 'héllo 😀\nmore');
    assert.equal(r.encoding, 'utf8');
    await run('writeFile', { path: 'documents/proj/deep/new/b.txt', content: 7 });
    assert.equal((await run('readFile', { path: 'documents/proj/deep/new/b.txt' })).content, '7');
    const info = await run('getFileInfo', { path: 'documents/proj/a.txt' });
    assert.equal(info.isFile, true);
    assert.equal(info.extension, '.txt');
    assert.deepEqual(await run('exists', { path: 'documents/proj' }),
      { path: path.join(home, 'Documents', 'proj'), exists: true, type: 'directory' });
    assert.equal((await run('exists', { path: 'documents/nope' })).exists, false);
    await assert.rejects(run('writeFile', { path: 'documents/proj/c.txt' }), /content must be a string/);
    await assert.rejects(run('writeFile', { path: 'documents/proj/c.txt', content: { a: 1 } }), /content must be a string/);
  });

  test('binary encodings, read limits and non-regular files', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13]);
    await run('writeFile', { path: 'documents/bin.dat', content: bytes.toString('base64'), encoding: 'base64' });
    assert.deepEqual(fs.readFileSync(path.join(home, 'Documents', 'bin.dat')), bytes);
    assert.equal((await run('readFile', { path: 'documents/bin.dat', encoding: 'base64' })).content, bytes.toString('base64'));
    await assert.rejects(run('readFile', { path: 'documents/bin.dat', encoding: 'klingon' }), /Unsupported encoding/);
    const big = path.join(home, 'Documents', 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, FilesystemModule.__test.MAX_READ_BYTES + 1);
    await assert.rejects(run('readFile', { path: 'documents/big.bin' }), /read limit/);
    await assert.rejects(run('readFile', { path: 'documents' }), /Not a regular file/);
    await assert.rejects(run('readFile', { path: 'documents/missing.txt' }), /ENOENT/);
  });

  test('copy and move, including into folders and refusals', async () => {
    await run('writeFile', { path: 'desktop/src.txt', content: 'data' });
    const c = await run('copyFile', { source: 'desktop/src.txt', destination: 'downloads' });
    assert.equal(c.destination, path.join(home, 'Downloads', 'src.txt'));
    assert.equal(fs.readFileSync(c.destination, 'utf8'), 'data');
    await assert.rejects(run('copyFile', { source: 'desktop/src.txt', destination: 'desktop/src.txt' }), /same file/);
    await assert.rejects(run('copyFile', { source: 'desktop/src.txt', destination: '/etc/grol.txt' }), /Access denied/);
    await assert.rejects(run('copyFile', { source: 'desktop/src.txt', destination: '~/.ssh/authorized_keys' }), /Access denied/);
    await assert.rejects(run('copyFile', { source: '/etc/hosts', destination: 'desktop/hosts' }), /Access denied/);
    await assert.rejects(run('copyFile', { source: 'desktop', destination: 'downloads/d' }), /Only files/);

    const m = await run('moveFile', { source: 'desktop/src.txt', destination: 'documents/renamed.txt' });
    assert.equal(m.moved, true);
    assert.ok(!fs.existsSync(path.join(home, 'Desktop', 'src.txt')));
    assert.equal(fs.readFileSync(path.join(home, 'Documents', 'renamed.txt'), 'utf8'), 'data');
    await run('createDirectory', { path: 'documents/box' });
    await assert.rejects(run('moveFile', { source: 'documents/box', destination: 'documents/box/inner' }), /into itself/);
    await assert.rejects(run('moveFile', { source: 'desktop', destination: outside }), /protected folder/);
    await assert.rejects(run('moveFile', { source: '~', destination: outside }), /protected folder/);
    await assert.rejects(run('moveFile', { source: 'documents/renamed.txt', destination: '/usr/local/x' }), /Access denied/);
  });

  test('delete refuses home, alias roots and ancestors of home', async () => {
    // '/' and the real home are only checked against the policy below, never via a live delete.
    for (const p of ['desktop', 'Desktop/', 'documents', 'downloads', '~', home, root]) {
      await assert.rejects(run('deleteDirectory', { path: p }), /protected folder/, p);
    }
    await assert.rejects(run('deleteDirectory', {}), /path is required/);
    await assert.rejects(run('deleteFile', { path: '' }), /path is required/);
    await assert.rejects(run('deleteDirectory', { path: '~/.ssh' }), /Access denied/);
    for (const d of ['Desktop', 'Documents', 'Downloads']) assert.ok(fs.existsSync(path.join(home, d)), d);

    const policy = fsm.policy;
    for (const p of ['/', os.tmpdir(), path.dirname(home), os.homedir()]) {
      assert.throws(() => policy.assertRemovable(p), /protected folder/, p);
    }
    const realHome = new FilesystemModule.PathPolicy({ platform: process.platform });
    for (const d of ['Desktop', 'Documents', 'Downloads', 'Library']) {
      assert.throws(() => realHome.assertRemovable(path.join(os.homedir(), d)), /protected folder/, d);
    }
  });

  test('deleteFile / deleteDirectory on ordinary targets', async () => {
    await run('writeFile', { path: 'documents/trash/x.txt', content: 'x' });
    await assert.rejects(run('deleteFile', { path: 'documents/trash' }), /use deleteDirectory/);
    await assert.rejects(run('deleteDirectory', { path: 'documents/trash/x.txt' }), /use deleteFile/);
    assert.deepEqual(await run('deleteFile', { path: 'documents/trash/x.txt' }),
      { path: path.join(home, 'Documents', 'trash', 'x.txt'), deleted: true });
    await run('deleteDirectory', { path: 'documents/trash' });
    assert.ok(!fs.existsSync(path.join(home, 'Documents', 'trash')));
    await assert.rejects(run('deleteDirectory', { path: 'documents/trash' }), /ENOENT/);
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.join(outside, 'keep'));
      fs.writeFileSync(path.join(outside, 'keep', 'k.txt'), 'k');
      fs.symlinkSync(path.join(outside, 'keep'), path.join(home, 'Documents', 'link-to-keep'));
      await run('deleteDirectory', { path: 'documents/link-to-keep' });
      assert.ok(fs.existsSync(path.join(outside, 'keep', 'k.txt')), 'deleting a link keeps its target');
    }
  });

  test('list and search: limits, hidden files, unreadable folders', async () => {
    const docs = path.join(home, 'Documents');
    fs.mkdirSync(path.join(docs, 'find', 'a', 'b'), { recursive: true });
    for (const f of ['report1.txt', 'report2.txt', 'a/report3.txt', 'a/b/notes.md', '.hidden-report.txt']) {
      fs.writeFileSync(path.join(docs, 'find', f), f);
    }
    fs.mkdirSync(path.join(docs, 'find', 'node_modules'));
    fs.writeFileSync(path.join(docs, 'find', 'node_modules', 'report-dep.txt'), '');
    if (process.platform !== 'win32') {
      fs.mkdirSync(path.join(docs, 'locked'));
      fs.chmodSync(path.join(docs, 'locked'), 0o000);
      fs.symlinkSync('/etc', path.join(docs, 'find', 'etc-link'));
    }

    const all = await run('searchFiles', { query: 'report*.txt', directory: 'documents' });
    assert.deepEqual(all.results.map((x) => x.name).sort(), ['report1.txt', 'report2.txt', 'report3.txt']);
    const limited = await run('searchFiles', { query: 'report', directory: 'documents/find', maxResults: 2 });
    assert.equal(limited.count, 2);
    assert.equal(limited.truncated, true);
    const junkLimit = await run('searchFiles', { query: 'notes', directory: 'documents', maxResults: 'lots' });
    assert.deepEqual(junkLimit.results.map((x) => x.name), ['notes.md']);
    await assert.rejects(run('searchFiles', { query: 'x', directory: '/etc' }), /Access denied/);

    const flat = await run('listDirectory', { path: 'documents/find' });
    assert.ok(flat.items.some((i) => i.name === 'a' && i.type === 'directory'));
    if (process.platform !== 'win32') assert.ok(flat.items.some((i) => i.name === 'etc-link' && i.type === 'symlink'));
    const deep = await run('listDirectory', { path: 'documents', recursive: true });
    const find = deep.items.find((i) => i.name === 'find');
    assert.ok(find.children.find((i) => i.name === 'a').children.some((i) => i.name === 'b'));
    const listedHome = await run('listDirectory', {});
    assert.equal(listedHome.path, home);
  });
});

describe('browser module', () => {
  const t = BrowserModule.__test;

  test('URL and option validation', () => {
    assert.equal(t.toUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(t.toUrl('about:blank'), 'about:blank');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'not a url', '', null]) {
      assert.throws(() => t.toUrl(bad), /URL/, String(bad));
    }
    assert.equal(t.toBrowserType('Firefox'), 'firefox');
    assert.throws(() => t.toBrowserType('__proto__'), /browserType/);
    assert.equal(t.toMs(-1, 10), 10);
    assert.equal(t.toMs(1e9, 10), 120000);
  });

  test('without Playwright every action fails cleanly', { skip: t.hasPlaywright() }, async () => {
    const b = await initialized(BrowserModule);
    await assert.rejects(b.execute('launch', {}), /Playwright is not installed/);
    await assert.rejects(b.execute('openURL', { url: 'https://example.com' }), /Playwright is not installed/);
    await assert.rejects(b.execute('click', { selector: '#a', pageId: 'page_1' }), /Playwright is not installed/);
    await assert.rejects(b.execute('openURL', { url: 'file:///etc/passwd' }), /Only http/);
    assert.deepEqual(await b.execute('getPages'), { pages: [], count: 0 });
    assert.deepEqual(await b.execute('close'), { closed: true });
    await b.shutdown();
  });

  test('uploadFile and screenshot paths obey the filesystem policy', async () => {
    const b = await initialized(BrowserModule);
    await assert.rejects(b.execute('uploadFile', { selector: 'input', filePath: '~/.ssh/id_rsa', pageId: 'p' }), /Access denied/);
    await assert.rejects(b.execute('uploadFile', { selector: 'input', filePath: '/etc/passwd', pageId: 'p' }), /Access denied/);
    b.pages.set('p', { screenshot: async () => { throw new Error('should not capture'); } });
    await assert.rejects(b.execute('screenshot', { pageId: 'p', path: '/usr/local/shot.png' }), /Access denied|Playwright/);
    b.pages.clear();
  });
});
