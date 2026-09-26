// OS Control: runOsTask against a fake helper daemon (a real HTTP server on a
// random port) with Gemini mocked, plus the intent engine, action
// normalisation and the service worker's task controller.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

installChromeStub();

const EXT = '../../browser/agent-extension/';
const { runOsTask, normalizeOsAction, parseOsPlan, DEFAULT_DAEMON_URL } = await import(EXT + 'os-agent.js');
const { matchIntent } = await import(EXT + 'intent-engine.js');
const { OsTaskController, INTERRUPTED } = await import(EXT + 'os-task.js');
const { resetGeminiLadder } = await import(EXT + 'gemini-models.js');
const { API_ROOT } = await import(EXT + 'gemini-fetch-client.js');

const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklm';
const realFetch = globalThis.fetch;
const FAST = { settleMs: 0, roundBackoffMs: [0, 10, 10], daemonTimeoutMs: 2000, modelTimeoutMs: 2000 };

// ---- fake daemon -----------------------------------------------------------

let server;
let daemonUrl;
let daemon;          // per-test behaviour and recorded calls

function resetDaemon() {
  daemon = {
    executed: [],
    confirms: [],
    permissions: { accessibility: true, screenRecording: true, binary: '/x/node' },
    // (module, action, parameters, req, res) => response object | undefined for the default
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

// ---- fake Gemini -----------------------------------------------------------

let geminiRequests;
let geminiReply;     // ({ n, prompt }) => Response | Promise<Response>

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const plan = (obj) => jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const busy = () => jsonResponse({ error: { code: 503, message: 'The model is overloaded.' } }, 503);

beforeEach(() => {
  resetDaemon();
  resetGeminiLadder();
  geminiRequests = [];
  geminiReply = () => plan({ done: true, actions: [], result: 'nothing to do' });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(API_ROOT)) return realFetch(url, init);
    if (/\/models\?/.test(u)) {
      return jsonResponse({ models: ['gemini-3.6-flash', 'gemini-3.5-flash-lite']
        .map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) });
    }
    const body = JSON.parse(init.body);
    const req = { n: geminiRequests.length, url: u, prompt: body.contents[0].parts[0].text, body };
    geminiRequests.push(req);
    return geminiReply(req);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

// Replies in order; the last one repeats.
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

// ---- runOsTask ---------------------------------------------------------------

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
    const { out } = run('do a multi step thing', {
      config: { ...FAST, roundBackoffMs: [0, 20000, 20000] },
      isAborted: () => stop,
      emit: (tag, text) => {
        if (/retrying in 20s/.test(text) && !stop) setTimeout(() => { stop = true; stoppedAt = Date.now(); }, 30);
      }
    });
    assert.deepEqual(await out, { success: false, result: 'Stopped.' });
    assert.ok(stoppedAt > 0, 'backoff was reached');
    assert.ok(Date.now() - stoppedAt < 1000, `took ${Date.now() - stoppedAt}ms after stop`);
  });

  test('an abort signal cancels a slow model request', async () => {
    geminiReply = ({ body }) => new Promise(() => {});      // never answers
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
    assert.match((await out).result, /Gemini is busy right now — every model failed/);
    assert.equal(geminiRequests.length, 2 * 3);   // 2 models x 3 rounds
    assert.ok(events.some((e) => /Model busy/.test(e.text)));
    assert.ok(events.some((e) => /retrying in/.test(e.text)));
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
    assert.match((await run('open notes and write', { apiKey: '  ' }).out).result, /Add a Gemini API key/);
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
    assert.match((await out).result, /^Kept failing: .*no such key/);
    assert.equal(geminiRequests.length, 4);
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

// ---- action normalisation and the intent engine ------------------------------

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

// ---- OsTaskController (the service worker's side) -----------------------------

describe('OsTaskController', () => {
  // A runOsTask stand-in the test drives through its hooks.
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
    s.finish({ success: false, result: 'Stopped.' });       // the first run exits
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
