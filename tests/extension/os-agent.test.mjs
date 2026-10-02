import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

installChromeStub();

const EXT = '../../browser/agent-extension/';
const { runOsTask, normalizeOsAction, parseOsPlan, fromGrid, gmailComposeUrl, DEFAULT_DAEMON_URL } = await import(EXT + 'os-agent.js');
const { matchIntent } = await import(EXT + 'intent-engine.js');
const { OsTaskController, INTERRUPTED } = await import(EXT + 'os-task.js');
const { resetGeminiLadder } = await import(EXT + 'gemini-models.js');
const { API_ROOT } = await import(EXT + 'gemini-fetch-client.js');

const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklm';
const realFetch = globalThis.fetch;
const FAST = { settleMs: 0, roundBackoffMs: [0, 10, 10], daemonTimeoutMs: 2000, modelTimeoutMs: 2000, helperRetryMs: 5 };


let server;
let daemonUrl;
let daemon;

function resetDaemon() {
  daemon = {
    executed: [],
    confirms: [],
    permissions: { accessibility: true, screenRecording: true, binary: '/x/node' },
    handle: () => undefined
  };
}

const DEFAULT_RESULTS = {
  'desktop.getScreenSize': { width: 1000, height: 800 },
  'screen.analyzeScreen': { base64: 'QUJD', format: 'jpeg' },
  'desktop.getActiveWindow': { app: 'Finder', title: '' }
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      const data = body ? JSON.parse(body) : {};
      if (req.url === '/health') return send({ status: 'healthy', modules: ['desktop'] });
      if (req.url === '/capabilities') {
        return send({ capabilities: { filesystem: { actions: { readFile: { parameters: ['path'], description: 'Read a file' } } } } });
      }
      if (req.url === '/confirm') {
        daemon.confirms.push(data);
        return send(data.approved === false ? { status: 'error', error: 'denied' } : { status: 'success', result: { ran: true } });
      }
      if (req.url === '/execute') {
        const { module, action, parameters } = data;
        daemon.executed.push({ module, action, parameters });
        const custom = daemon.handle(module, action, parameters, req, res);
        if (custom === 'handled') return;
        if (custom) return send(custom);
        if (`${module}.${action}` === 'desktop.getPermissions') return send({ status: 'success', result: daemon.permissions });
        return send({ status: 'success', result: DEFAULT_RESULTS[`${module}.${action}`] || { ok: true } });
      }
      res.statusCode = 404;
      send({ status: 'error', error: 'no route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  daemonUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));


let geminiRequests;
let verifyRequests;
let verdictReply;
let geminiReply;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const plan = (obj) => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const busy = () => jsonResponse({ error: { code: 503, message: 'The model is overloaded.' } }, 503);

beforeEach(() => {
  resetDaemon();
  resetGeminiLadder();
  geminiRequests = [];
  verifyRequests = [];
  verdictReply = () => plan({ requirements: [], complete: true, evidence: 'visible on screen' });
  geminiReply = () => plan({ done: true, actions: [], result: 'nothing to do' });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(API_ROOT)) return realFetch(url, init);
    if (/\/models\?/.test(u)) {
      return jsonResponse({ models: ['gemini-3.6-flash', 'gemini-3.5-flash-lite']
        .map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) });
    }
    const body = JSON.parse(init.body);
    const prompt = body.contents[0].parts[0].text;
    if (prompt.startsWith('You are auditing another agent')) {
      const check = { n: verifyRequests.length, prompt, body };
      verifyRequests.push(check);
      return verdictReply(check);
    }
    const req = { n: geminiRequests.length, url: u, prompt, body };
    geminiRequests.push(req);
    return geminiReply(req);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const replies = (...list) => ({ n }) => plan(list[Math.min(n, list.length - 1)]);

function run(goal, opts = {}) {
  const events = [];
  const out = runOsTask(goal, {
    apiKey: KEY, daemonUrl, config: FAST,
    emit: (tag, text, tone, detail) => events.push({ tag, text, tone, detail }),
    askConfirm: async () => true,
    ...opts
  });
  return { events, out };
}
const executed = (action) => daemon.executed.filter((c) => c.action === action);


describe('runOsTask', () => {
  test('production daemon URL is unchanged', () => assert.equal(DEFAULT_DAEMON_URL, 'http://127.0.0.1:7777'));

  test('happy path: acts, remembers the target app, then finishes', async () => {
    geminiReply = replies(
      { step: 'Open Notes', thought: 'open it', actions: [
        { module: 'process', action: 'openApplication', parameters: { name: 'Notes' } },
        { action: 'desktop.typeText', parameters: { text: 'hello' } }
      ], done: false },
      { step: 'Check', thought: 'done', actions: [], done: true, result: 'Wrote hello in Notes.' }
    );
    const { events, out } = run('write hello in a new note');
    assert.deepEqual(await out, { success: true, result: 'Wrote hello in Notes.' });
    assert.deepEqual(executed('typeText')[0].parameters, { text: 'hello', app: 'Notes' });
    assert.ok(events.some((e) => e.tag === '1' && e.text === 'Open Notes'));
    assert.ok(events.some((e) => e.tag === 'type' && /hello/.test(e.text)));
    assert.match(geminiRequests[1].prompt, /openApplication.*-> ok/);
    assert.equal(geminiRequests[0].body.contents[0].parts[1].inlineData.data, 'QUJD');
  });

  test('done=true with actions runs them and asks again before finishing', async () => {
    geminiReply = replies(
      { actions: [{ action: 'pressKey', parameters: { key: 'enter' } }], done: true, result: 'sent' },
      { actions: [], done: true, result: 'Sent.' }
    );
    const { out } = run('send it');
    assert.deepEqual(await out, { success: true, result: 'Sent.' });
    assert.equal(executed('pressKey').length, 1);
    assert.match(geminiRequests[1].prompt, /You said the goal was done/);
  });

  test('confirmation approved runs the action through /confirm', async () => {
    daemon.handle = (m, a) => (a === 'executeCommand'
      ? { status: 'requires_confirmation', result: { confirmation_id: 'c1', risk_level: 'high' } } : undefined);
    geminiReply = replies({ actions: [{ action: 'executeCommand', parameters: { command: 'ls' } }] }, { actions: [], done: true, result: 'ok' });
    const asked = [];
    const { events, out } = run('list files with ls', { askConfirm: async (req) => { asked.push(req); return true; } });
    assert.equal((await out).success, true);
    assert.equal(asked[0].module, 'process');
    assert.equal(asked[0].risk, 'high');
    assert.deepEqual(daemon.confirms, [{ confirmation_id: 'c1', approved: true }]);
    assert.ok(events.some((e) => e.text === 'You approved this'));
  });

  test('confirmation denied stops the task and tells the helper', async () => {
    daemon.handle = (m, a) => (a === 'executeCommand'
      ? { status: 'requires_confirmation', result: { confirmation_id: 'c2', risk_level: 'high' } } : undefined);
    geminiReply = replies({ actions: [{ action: 'executeCommand', parameters: { command: 'rm x' } }] });
    const { out } = run('remove x with a command', { askConfirm: async () => false });
    assert.deepEqual(await out, { success: false, result: 'Stopped: you declined process.executeCommand.' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(daemon.confirms, [{ confirmation_id: 'c2', approved: false }]);
  });

  test('stopping during the model backoff returns promptly', async () => {
    geminiReply = busy;
    let stop = false;
    let stoppedAt = 0;
    const watcher = setInterval(() => {
      if (geminiRequests.length >= 2 && !stop) setTimeout(() => { stop = true; stoppedAt = Date.now(); }, 30);
    }, 10);
    const { out } = run('do a multi step thing', {
      config: { ...FAST, roundBackoffMs: [0, 20000, 20000] },
      isAborted: () => stop
    });
    out.finally(() => clearInterval(watcher));
    assert.deepEqual(await out, { success: false, result: 'Stopped.' });
    assert.ok(stoppedAt > 0, 'backoff was reached');
    assert.ok(Date.now() - stoppedAt < 1000, `took ${Date.now() - stoppedAt}ms after stop`);
  });

  test('an abort signal cancels a slow model request', async () => {
    geminiReply = ({ body }) => new Promise(() => {});
    const ctl = new AbortController();
    const { out } = run('do a multi step thing', { signal: ctl.signal, config: { ...FAST, modelTimeoutMs: 60000 } });
    setTimeout(() => ctl.abort(), 100);
    const t0 = Date.now();
    assert.deepEqual(await out, { success: false, result: 'Stopped.' });
    assert.ok(Date.now() - t0 < 1000);
  });

  test('a pause while thinking discards that plan and looks again', async () => {
    let paused = false;
    let release;
    geminiReply = ({ n }) => {
      if (n === 0) { paused = true; setTimeout(() => { paused = false; release(); }, 30); }
      return plan(n === 0
        ? { actions: [{ action: 'openApplication', parameters: { name: 'Mail' } }] }
        : n === 1 ? { actions: [{ action: 'openApplication', parameters: { name: 'Notes' } }] }
          : { actions: [], done: true, result: 'ok' });
    };
    const { out } = run('open notes then write', {
      waitIfPaused: async () => {
        if (!paused) return false;
        await new Promise((r) => { release = r; });
        return true;
      }
    });
    assert.equal((await out).success, true);
    assert.deepEqual(executed('openApplication').map((c) => c.parameters.name), ['Notes']);
    assert.equal(executed('analyzeScreen').length, 3);
  });

  test('helper not running', async () => {
    const { out } = run('anything at all', { daemonUrl: 'http://127.0.0.1:9' });
    assert.match((await out).result, /OS Control helper is not running/);
    assert.equal(geminiRequests.length, 0);
  });

  test('a helper that is slow right after the browser starts is waited for, not reported missing', async () => {
    const { DaemonClient } = await import(EXT + 'os-daemon.js');
    const realProbe = DaemonClient.prototype.probe;
    let calls = 0;
    DaemonClient.prototype.probe = async function () { calls++; return calls >= 3 ? realProbe.call(this) : 'slow'; };
    try {
      geminiReply = replies({ actions: [], done: true, result: 'ok' });
      const r = await run('open notes and write hello').out;
      assert.ok(calls >= 3);
      assert.doesNotMatch(r.result, /helper/);
    } finally {
      DaemonClient.prototype.probe = realProbe;
    }
  });

  test('a helper that stays unreachable without refusing points at the keychain prompt', async () => {
    const { DaemonClient } = await import(EXT + 'os-daemon.js');
    const realProbe = DaemonClient.prototype.probe;
    DaemonClient.prototype.probe = async () => 'slow';
    try {
      const r = await run('open notes and write hello').out;
      assert.match(r.result, /running but the browser can't reach it.*Always Allow/);
    } finally {
      DaemonClient.prototype.probe = realProbe;
    }
  });

  test('helper dying mid-task is reported, not retried blind', async () => {
    daemon.handle = (m, a, p, req, res) => {
      if (a === 'typeText') { res.socket.destroy(); return 'handled'; }
      return undefined;
    };
    geminiReply = replies({ actions: [{ action: 'typeText', parameters: { text: 'x' } }] });
    const { out } = run('type x then save');
    assert.match((await out).result, /stopped responding/);
    assert.equal(geminiRequests.length, 1);
  });

  test('missing macOS permissions are explained and requested', async () => {
    daemon.permissions = { accessibility: false, screenRecording: true, binary: '/opt/node' };
    const { out } = run('click the red button then type');
    const r = await out;
    assert.equal(r.success, false);
    assert.match(r.result, /has not granted Accessibility .*\/opt\/node/);
    assert.equal(executed('requestPermissions').length, 1);
    assert.equal(geminiRequests.length, 0);
  });

  test('an Accessibility error from an action ends the task', async () => {
    daemon.handle = (m, a) => (a === 'clickMouse'
      ? { status: 'error', error: 'macOS Accessibility permission is missing for the OS Control helper' } : undefined);
    geminiReply = replies({ actions: [{ action: 'clickMouse', parameters: { x: 10, y: 10 } }] });
    const { out } = run('click then type');
    assert.match((await out).result, /Accessibility permission/);
  });

  test('"Refusing to send input" brings the app back and retries once', async () => {
    let refused = 0;
    daemon.handle = (m, a) => {
      if (a === 'typeText' && refused++ === 0) return { status: 'error', error: "Refusing to send input: 'Notes' is not in front ('Finder' is)." };
      return undefined;
    };
    geminiReply = replies(
      { actions: [{ action: 'openApplication', parameters: { name: 'Notes' } }, { action: 'typeText', parameters: { text: 'hi' } }] },
      { actions: [], done: true, result: 'ok' }
    );
    const { out } = run('open notes and type hi');
    assert.equal((await out).success, true);
    assert.deepEqual(executed('focusWindow')[0].parameters, { title: 'Notes' });
    assert.equal(executed('typeText').length, 2);
  });

  test('every model busy gives a clear message after the rounds', async () => {
    geminiReply = busy;
    const { events, out } = run('do a multi step thing');
    assert.match((await out).result, /AI model is busy right now — every model failed/);
    assert.equal(geminiRequests.length, 2 * 3);
    assert.ok(!events.some((e) => /busy|retrying in/i.test(e.text)), 'model switching stays out of the activity log');
  });

  test('a rejected API key fails fast with a clear message', async () => {
    geminiReply = () => jsonResponse({ error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
    const { out } = run('do a multi step thing');
    const r = await out;
    assert.match(r.result, /Google rejected the Gemini API key/);
    assert.ok(!r.result.includes(KEY));
    assert.equal(geminiRequests.length, 1);
  });

  test('no API key: multi-step goals need one, simple ones do not', async () => {
    assert.match((await run('open notes and write', { apiKey: '  ' }).out).result, /Add an AI API key/);
    assert.deepEqual(await run('take a screenshot', { apiKey: '' }).out, { success: true, result: 'Done.' });
  });

  test('junk actions are dropped and the model is told', async () => {
    geminiReply = replies(
      { actions: [null, 'click', { action: 'clickMouse', parameters: { x: 5000, y: 10 } }, { action: 'typeText', parameters: { text: '' } }, { module: 'evil', action: 'x' }] },
      { actions: [], done: true, result: 'ok' }
    );
    const { out } = run('click the thing then save');
    assert.equal((await out).success, true);
    assert.equal(executed('clickMouse').length, 0);
    assert.equal(executed('typeText').length, 0);
    assert.match(geminiRequests[1].prompt, /INVALID/);
  });

  test('a reply that is not an object moves on to the next model', async () => {
    geminiReply = ({ n }) => (n === 0
      ? jsonResponse({ candidates: [{ content: { parts: [{ text: '"just a string"' }] } }] })
      : plan({ actions: [], done: true, result: 'ok' }));
    assert.equal((await run('do a multi step thing').out).success, true);
    assert.notEqual(geminiRequests[0].url, geminiRequests[1].url);
  });

  test('stops after maxSteps', async () => {
    geminiReply = replies({ actions: [{ module: 'agent', action: 'wait', parameters: { ms: 1 } }] });
    const { out } = run('keep waiting then stop', { config: { ...FAST, maxSteps: 3 } });
    assert.deepEqual(await out, { success: false, result: 'Stopped after 3 steps without finishing.' });
    assert.equal(geminiRequests.length, 3);
  });

  test('gives up after repeated failures', async () => {
    daemon.handle = (m, a) => (a === 'pressKey' ? { status: 'error', error: 'no such key' } : undefined);
    geminiReply = replies({ actions: [{ action: 'pressKey', parameters: { key: 'f99' } }] });
    const { out } = run('press it then go');
    assert.match((await out).result, /^Kept failing: /);
    assert.equal(geminiRequests.length, 4);
    assert.equal(executed('pressKey').length, 2);
    assert.match(geminiRequests[1].prompt, /no such key/);
  });

  test('the same missed click is refused after two tries and the model told to change route', async () => {
    geminiReply = replies(
      { actions: [{ action: 'clickMouse', parameters: { x: 100, y: 200 } }] },
      { actions: [{ action: 'clickMouse', parameters: { x: 103, y: 198 } }] },
      { actions: [{ action: 'clickMouse', parameters: { x: 101, y: 201 } }] },
      { actions: [], done: true, result: 'ok' }
    );
    const { out } = run('click desktop in sidebar');
    assert.equal((await out).success, true);
    assert.equal(executed('clickMouse').length, 2);
    assert.match(geminiRequests[3].prompt, /REPEATED: .*NOT working/);
  });

  test('a GUI turn that leaves the screen identical is reported as having no effect', async () => {
    geminiReply = replies(
      { actions: [{ action: 'clickMouse', parameters: { x: 10, y: 10 } }] },
      { actions: [], done: true, result: 'ok' }
    );
    await run('click it').out;
    assert.doesNotMatch(geminiRequests[0].prompt, /SCREEN UNCHANGED: the screenshot is identical/);
    assert.match(geminiRequests[1].prompt, /SCREEN UNCHANGED: the screenshot is identical/);
  });

  test('a command that exits non-zero is a failure, not ok', async () => {
    daemon.handle = (m, a) => (a === 'executeCommand'
      ? { status: 'success', result: { exitCode: 127, stderr: 'sh: code: command not found', success: false } } : undefined);
    geminiReply = replies(
      { actions: [{ action: 'executeCommand', parameters: { command: 'code ~/Desktop/x' } }] },
      { actions: [], done: true, result: 'ok' }
    );
    await run('open x in code').out;
    assert.match(geminiRequests[1].prompt, /-> FAILED: exit code 127: sh: code: command not found/);
  });

  test('never clicks or focuses its own browser window', async () => {
    daemon.handle = (m, a) => (a === 'getActiveWindow' ? { status: 'success', result: { app: 'Grol', title: '' } } : undefined);
    geminiReply = replies(
      { actions: [{ action: 'clickMouse', parameters: { x: 10, y: 10 } }] },
      { actions: [{ action: 'focusWindow', parameters: { title: 'Grol' } }] },
      { actions: [], done: true, result: 'ok' }
    );
    await run('make a folder').out;
    assert.equal(executed('clickMouse').length, 0);
    assert.equal(executed('focusWindow').length, 0);
    assert.match(geminiRequests[0].prompt, /"Grol" is YOUR OWN window/);
    assert.match(geminiRequests[1].prompt, /REFUSED: that is your own window/);
  });

  test('a RECITATION refusal is retried with a request for original code, not fatal', async () => {
    const recite = () => jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }] });
    geminiReply = ({ prompt }) => (/WITHHELD by Gemini/.test(prompt)
      ? plan({ actions: [], done: true, result: 'Made the site.' }) : recite());
    const { events, out } = run('make a website');
    assert.deepEqual(await out, { success: true, result: 'Made the site.' });
    assert.ok(events.some((e) => /original code/.test(e.text)));
  });

  test('RECITATION every time ends with a clear message', async () => {
    geminiReply = () => jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }] });
    const { out } = run('make a website', { config: { ...FAST, recitationRetries: 1 } });
    assert.match((await out).result, /recitation/i);
  });

  test('click coordinates are read on a 0-1000 grid and mapped to screen points', async () => {
    geminiReply = replies(
      { actions: [{ action: 'clickMouse', parameters: { x: 500, y: 1000 } }, { action: 'clickMouse', parameters: { x: 1200, y: 5 } }] },
      { actions: [], done: true, result: 'ok' }
    );
    await run('click the middle').out;
    assert.deepEqual(executed('clickMouse').map((c) => [c.parameters.x, c.parameters.y]), [[500, 799]]);
    assert.deepEqual(fromGrid({ action: 'dragMouse', parameters: { fromX: 0, fromY: 0, toX: 1000, toY: 500 } }, { width: 1501, height: 901 }).parameters,
      { fromX: 0, fromY: 0, toX: 1500, toY: 450 });
  });

  test('an email is sent through a pre-filled Gmail compose window, never typed field by field', async () => {
    geminiReply = replies(
      { actions: [{ module: 'agent', action: 'composeGmail', parameters: { to: 'p@example.com', subject: 'Leave request', body: 'Hi,\nMay I take leave today?\nThanks' } }] },
      { actions: [], done: true, result: 'sent' }
    );
    await run('send an email to p@example.com asking for leave').out;
    const open = executed('openApplication')[0];
    assert.equal(open.parameters.name, 'Google Chrome');
    const u = new URL(open.parameters.path);
    assert.equal(u.host, 'mail.google.com');
    assert.equal(u.searchParams.get('to'), 'p@example.com');
    assert.equal(u.searchParams.get('su'), 'Leave request');
    assert.equal(u.searchParams.get('body'), 'Hi,\nMay I take leave today?\nThanks');
    assert.doesNotMatch(open.parameters.path, /\+/);
    assert.equal(normalizeOsAction({ action: 'agent.composeGmail', parameters: { subject: 'no recipient' } }), null);
    assert.match(gmailComposeUrl({ to: ['a@x.com', ' b@x.com'] }), /to=a%40x\.com%2Cb%40x\.com/);
  });

  test('reading a PDF uses readDocument and the model gets the text, not a preview', async () => {
    daemon.handle = (m, a) => (a === 'readDocument'
      ? { status: 'success', result: { path: '/x/nda.pdf', via: 'PDFKit', pages: 2, text: 'NDA between GoKiwi and Piyush. Term: 2 years. ' + 'x'.repeat(5000) } } : undefined);
    geminiReply = replies(
      { actions: [{ module: 'filesystem', action: 'readFile', parameters: { path: 'desktop/nda.pdf' } }] },
      { actions: [], done: true, result: 'Summary: a 2-year NDA between GoKiwi and Piyush.' }
    );
    await run('summarise my gokiwi agreement').out;
    assert.equal(executed('readFile').length, 0);
    assert.equal(executed('readDocument').length, 1);
    assert.match(geminiRequests[1].prompt, /\(2 pages\) TEXT:\nNDA between GoKiwi and Piyush\. Term: 2 years\./);
    assert.ok(geminiRequests[1].prompt.includes('x'.repeat(4000)), 'far more than a 160-character preview');
  });

  test('installing software to work around a missing tool is refused unless the goal asks for it', async () => {
    geminiReply = replies(
      { actions: [{ action: 'executeCommand', parameters: { command: 'python3 -m pip install pypdf && python3 x.py' } }] },
      { actions: [], done: true, result: 'ok' }
    );
    await run('summarise the agreement pdf').out;
    assert.equal(executed('executeCommand').length, 0);
    assert.match(geminiRequests[1].prompt, /REFUSED: do not install software.*readDocument/);
  });

  test('the model plan is carried into later turns', async () => {
    geminiReply = replies(
      { plan: ['Create folder', 'Write files', 'Open in VS Code'], actions: [{ action: 'agent.wait', parameters: { ms: 1 } }] },
      { actions: [], done: true, result: 'ok' }
    );
    await run('build it').out;
    assert.match(geminiRequests[0].prompt, /no plan yet/);
    assert.match(geminiRequests[1].prompt, /YOUR PLAN[\s\S]*3\. Open in VS Code/);
  });

  test('model gives up without actions or done', async () => {
    geminiReply = replies({ actions: [], done: false, result: 'I need a login.' });
    assert.deepEqual(await run('log in then post').out, { success: false, result: 'I need a login.' });
  });

  test('quick path runs without the model; multi-step goals go to the model', async () => {
    assert.deepEqual(await run('take a screenshot').out, { success: true, result: 'Done.' });
    assert.equal(executed('takeScreenshot').length, 1);
    assert.equal(geminiRequests.length, 0);
    await run('open chrome and search for cats').out;
    assert.equal(geminiRequests.length, 1);
    assert.equal(executed('openApplication').length, 0);
  });

  test('quick info actions include their result', async () => {
    daemon.handle = (m, a) => (a === 'getTime' ? { status: 'success', result: { time: '10:00' } } : undefined);
    assert.deepEqual(await run('what time is it?').out, { success: true, result: 'Done. {"time":"10:00"}' });
  });
});


describe('normalizeOsAction', () => {
  const screen = { width: 1000, height: 800 };
  const cases = [
    ['dotted action', { action: 'desktop.typeText', parameters: { text: 'x' } }, { module: 'desktop', action: 'typeText', parameters: { text: 'x' } }],
    ['dotted module', { module: 'process.openApplication', params: { name: 'Notes' } }, { module: 'process', action: 'openApplication', parameters: { name: 'Notes' } }],
    ['missing module (process)', { action: 'closeApplication', args: { name: 'Notes' } }, { module: 'process', action: 'closeApplication', parameters: { name: 'Notes' } }],
    ['missing module (desktop)', { action: 'hotkey', parameters: { keys: ['cmd', 'n'] } }, { module: 'desktop', action: 'hotkey', parameters: { keys: ['cmd', 'n'] } }],
    ['wait with ms outside', { action: 'wait', ms: '500' }, { module: 'agent', action: 'wait', parameters: { ms: 500 } }],
    ['wait clamps', { module: 'agent', parameters: { ms: 999999 } }, { module: 'agent', action: 'wait', parameters: { ms: 10000 } }],
    ['string coordinates rounded', { action: 'clickMouse', parameters: { x: '10.6', y: 20 } }, { module: 'desktop', action: 'clickMouse', parameters: { x: 11, y: 20 } }],
    ['number text', { action: 'typeText', parameters: { text: 42 } }, { module: 'desktop', action: 'typeText', parameters: { text: '42' } }]
  ];
  for (const [name, raw, expected] of cases) test(name, () => assert.deepEqual(normalizeOsAction(raw, screen), expected));
  const dropped = [
    ['null', null], ['array', []], ['string', 'desktop.typeText'], ['no action', { module: 'desktop' }],
    ['unknown module', { module: 'kernel', action: 'panic' }], ['weird action name', { module: 'desktop', action: '../x' }],
    ['empty text', { action: 'typeText', parameters: { text: '' } }], ['no text', { action: 'typeText' }],
    ['click without y', { action: 'clickMouse', parameters: { x: 1 } }], ['click off screen', { action: 'clickMouse', parameters: { x: 1000, y: 5 } }],
    ['negative click', { action: 'rightClick', parameters: { x: -1, y: 5 } }], ['NaN click', { action: 'moveMouse', parameters: { x: 'abc', y: 5 } }],
    ['drag off screen', { action: 'dragMouse', parameters: { fromX: 1, fromY: 1, toX: 2, toY: 900 } }],
    ['pressKey without key', { action: 'pressKey', parameters: {} }], ['hotkey without keys', { action: 'hotkey', parameters: { keys: [] } }]
  ];
  for (const [name, raw] of dropped) test(`drops ${name}`, () => assert.equal(normalizeOsAction(raw, screen), null));

  test('parseOsPlan', () => {
    assert.deepEqual(parseOsPlan('[{"done":true}]'), { done: true });
    assert.throws(() => parseOsPlan('"text"'), /not a JSON object/);
    assert.throws(() => parseOsPlan('[1,2]'), /not a JSON object/);
  });
});

describe('matchIntent', () => {
  const quick = [
    ['take a screenshot', 'screen.takeScreenshot'],
    ['Please take a screenshot.', 'screen.takeScreenshot'],
    ['Open the Calculator app', 'process.openApplication', { name: 'Calculator' }],
    ['launch google   chrome', 'process.openApplication', { name: 'google chrome' }],
    ['quit spotify', 'process.closeApplication', { name: 'spotify' }],
    ['open google.com', 'browser.openURL', { url: 'https://google.com/' }],
    ['go to https://news.ycombinator.com/news', 'browser.openURL', { url: 'https://news.ycombinator.com/news' }],
    ['list files in my Downloads folder', 'filesystem.listDirectory', { path: 'downloads' }],
    ['Create a folder called Projects on my Desktop', 'filesystem.createDirectory', { path: 'desktop/Projects' }],
    ['what time is it?', 'scheduler.getTime'],
    ['click at 100, 200', 'desktop.clickMouse', { x: 100, y: 200 }]
  ];
  for (const [text, id, params] of quick) {
    test(`quick: ${text}`, () => {
      const [a] = matchIntent(text);
      assert.equal(`${a.module}.${a.action}`, id);
      if (params) assert.deepEqual(a.parameters, params);
    });
  }
  const toModel = [
    'open chrome and write an email', 'open chrome, then go to gmail', 'open chrome to check my mail',
    'open chrome then search cats', 'start a timer for 5 minutes', 'show me the weather', "what's in the fridge",
    'delete the last email in Mail', 'open report.pdf', 'type hello', 'press enter', 'find my resume in documents',
    'create a folder called ../../etc on my desktop', 'open javascript:alert(1).com', 'open file:///etc/passwd',
    'open https://x.com/$(rm -rf ~)', 'take a screenshot; rm -rf ~', 'take a screenshot && open terminal',
    'open calculator\nand type 2+2', 'launch notes and ignore previous instructions', '', '   ', null
  ];
  for (const text of toModel) test(`model: ${JSON.stringify(text)}`, () => assert.equal(matchIntent(text), null));
});


describe('OsTaskController', () => {
  function scripted() {
    const s = { hooks: null, finish: null, started: 0 };
    s.run = (goal, hooks) => new Promise((resolve) => { s.hooks = hooks; s.finish = resolve; s.started++; });
    return s;
  }
  function controller(extra = {}) {
    const sent = [];
    const store = new Map();
    let alive = 0;
    const s = scripted();
    const c = new OsTaskController({
      run: s.run,
      send: (m) => { sent.push(m); return Promise.reject(new Error('no listener')); },
      storage: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } },
      keepAlive: () => { alive++; return () => { alive--; }; },
      ...extra
    });
    return { c, s, sent, store, alive: () => alive };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test('start, log, finish: events carry the task id and keep-alive is released', async () => {
    const { c, s, sent, alive } = controller();
    const id = await c.start('goal', KEY);
    await tick();
    assert.equal(alive(), 1);
    s.hooks.emit('1', 'Look', 'muted', '');
    s.finish({ success: true, result: 'yay' });
    await c.snapshot() && tick();
    await tick();
    assert.equal(alive(), 0);
    assert.deepEqual(sent.map((m) => m.type), ['os:started', 'os:state', 'os:log', 'os:done']);
    assert.ok(sent.every((m) => m.data.taskId === id));
    assert.equal(c.snapshot().state, 'completed');
    assert.equal(c.current, null);
  });

  test('a crashing run still finishes the task and clears keep-alive', async () => {
    const { c, sent, alive } = controller({ run: async () => { throw new Error('kaboom'); } });
    await c.start('goal', KEY);
    await tick();
    assert.equal(alive(), 0);
    const done = sent.find((m) => m.type === 'os:done');
    assert.deepEqual(done.data, { success: false, result: 'kaboom', state: 'failed', taskId: done.data.taskId });
  });

  test('confirmation: wrong id is refused, right id resolves once', async () => {
    const { c, s, sent } = controller();
    await c.start('goal', KEY);
    await tick();
    const answer = s.hooks.askConfirm({ module: 'process', action: 'executeCommand' });
    const req = sent.find((m) => m.type === 'os:confirm-request');
    assert.equal(c.snapshot().state, 'waiting_for_user');
    assert.equal(c.snapshot().pendingConfirm.id, req.data.id);
    assert.equal(c.answerConfirm('c-bogus', true), false);
    assert.equal(c.answerConfirm({ id: req.data.id }, true), false);
    assert.equal(c.answerConfirm(req.data.id, true), true);
    assert.equal(await answer, true);
    assert.equal(c.answerConfirm(req.data.id, true), false);
    assert.equal(c.snapshot().pendingConfirm, null);
  });

  test('stop releases a pending confirmation, a pause, and aborts the signal', async () => {
    const { c, s } = controller();
    await c.start('goal', KEY);
    await tick();
    assert.equal(c.pause(), true);
    assert.equal(c.pause(), false);
    const paused = s.hooks.waitIfPaused();
    const answer = s.hooks.askConfirm({});
    assert.equal(c.stop(), true);
    assert.equal(c.stop(), false);
    assert.equal(await paused, true);
    assert.equal(await answer, false);
    assert.equal(s.hooks.signal.aborted, true);
    assert.equal(s.hooks.isAborted(), true);
    assert.equal(await s.hooks.askConfirm({}), false);
    s.finish({ success: false, result: 'Stopped.' });
    await tick();
    assert.equal(c.snapshot().state, 'aborted');
  });

  test('pause and resume', async () => {
    const { c, s } = controller();
    assert.equal(c.pause(), false);
    await c.start('goal', KEY);
    await tick();
    assert.equal(await s.hooks.waitIfPaused(), false);
    c.pause();
    let resumed = false;
    s.hooks.waitIfPaused().then(() => { resumed = true; });
    await tick();
    assert.equal(resumed, false);
    assert.equal(c.resume(), true);
    await tick();
    assert.equal(resumed, true);
    assert.equal(c.snapshot().state, 'executing');
    assert.equal(c.resume(), false);
  });

  test('starting a new task stops the old one first', async () => {
    const { c, s, sent } = controller();
    const first = await c.start('one', KEY);
    await tick();
    const firstHooks = s.hooks;
    const second = c.start('two', KEY);
    await tick();
    assert.equal(firstHooks.isAborted(), true);
    s.finish({ success: false, result: 'Stopped.' });
    const secondId = await second;
    assert.notEqual(secondId, first);
    assert.equal(c.current.id, secondId);
    const firstDone = sent.find((m) => m.type === 'os:done' && m.data.taskId === first);
    assert.equal(firstDone.data.state, 'aborted');
  });

  test('a worker restart mid-task reports the task as interrupted', async () => {
    const a = controller();
    await a.c.start('goal', KEY);
    await tick();
    const saved = a.store.get('osTask');
    assert.equal(saved.state, 'thinking');

    const b = controller();
    b.store.set('osTask', saved);
    await b.c.restore();
    const done = b.sent.find((m) => m.type === 'os:done');
    assert.equal(done.data.result, INTERRUPTED);
    assert.equal(b.c.snapshot().state, 'failed');
    assert.equal(b.store.get('osTask').state, 'failed');
  });

  test('restore ignores junk in storage', async () => {
    const b = controller();
    b.store.set('osTask', 'garbage');
    await b.c.restore();
    assert.equal(b.c.snapshot(), null);
    assert.equal(b.sent.length, 0);
  });
});

describe('completion check', () => {
  test('a done claim is only a success after an independent check sees it finished', async () => {
    geminiReply = replies({ actions: [], done: true, result: 'Folder created' });
    const r = await run('create a folder called X on my desktop and open it').out;
    assert.deepEqual(r, { success: true, result: 'Folder created' });
    assert.equal(verifyRequests.length, 1);
    assert.match(verifyRequests[0].prompt, /GOAL:  create a folder called X/);
    assert.ok(verifyRequests[0].body.contents[0].parts[1].inlineData, 'the check sees a screenshot');
  });

  test('a rejected claim sends the agent back with what is missing, then it finishes', async () => {
    geminiReply = replies(
      { actions: [], done: true, result: 'Sent' },
      { actions: [{ action: 'typeText', parameters: { text: 'hi\n' } }] },
      { actions: [], done: true, result: 'Sent' }
    );
    verdictReply = ({ n }) => plan(n === 0
      ? { requirements: [{ need: 'message sent', met: false }], complete: false, missing: 'the message is still in the input box', next: 'press Return' }
      : { requirements: [{ need: 'message sent', met: true }], complete: true, evidence: 'message in the chat' });
    const r = await run('open whatsapp and send hi to rahul').out;
    assert.equal(r.success, true);
    assert.equal(verifyRequests.length, 2);
    assert.ok(geminiRequests.some((g) => /REJECTED.*still in the input box.*press Return/s.test(g.prompt)));
  });

  test('repeated rejection ends as not finished, never as success', async () => {
    geminiReply = replies({ actions: [], done: true, result: 'Done' });
    verdictReply = () => plan({ complete: false, missing: 'the document is empty' });
    const r = await run('open notes and write a shopping list').out;
    assert.deepEqual(r, { success: false, result: 'Not finished: the document is empty' });
  });

  test('a check that cannot run, or an unreadable verdict, is never a success', async () => {
    geminiReply = replies({ actions: [], done: true, result: 'Done' });
    verdictReply = () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'looks good to me' }] } }] });
    const r = await run('open notes and write a list', { config: { ...FAST, verifyAttempts: 2, verifyRetryMs: 1 } }).out;
    assert.equal(r.success, false);
    assert.match(r.result, /Couldn't confirm the task was finished/);
  });

  test('a "complete" verdict with an unmet requirement is not complete', async () => {
    geminiReply = replies({ actions: [], done: true, result: 'Done' });
    verdictReply = () => plan({ requirements: [{ need: 'saved', met: false }], complete: true });
    const r = await run('open notes and write a list').out;
    assert.equal(r.success, false);
  });
});

