import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

const DIR = fileURLToPath(new URL('../../browser/agent-extension/', import.meta.url));
const read = (f) => readFileSync(DIR + f, 'utf8');

const PAGES = [['sidepanel.html', 'sidepanel.js'], ['newtab.html', 'newtab.js']];

describe('page ids', () => {
  for (const [html, js] of PAGES) {
    test(`every id ${js} looks up exists in ${html}`, () => {
      const ids = new Set([...read(html).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      const src = read(js);
      const used = new Set([...src.matchAll(/(?:\$|getElementById)\('([^']+)'\)/g)].map((m) => m[1]));
      assert.ok(used.size > 3, 'found the lookups');
      const missing = [...used].filter((id) => !ids.has(id));
      assert.deepEqual(missing, []);
    });
    test(`${html} loads ${js}`, () => assert.match(read(html), new RegExp(`<script src="${js}"></script>`)));
  }
});

const SAFE_INNER_HTML = {
  'sidepanel.js': ["state === 'paused' ? ICON_PLAY : ICON_PAUSE", 'ICON_CHECK', "RESULT_ICONS[kind] || RESULT_ICONS['']"],
  'newtab.js': ["MODE_HINT[m] || ''"]
};
const UI_AND_WORKER = ['sidepanel.js', 'newtab.js', 'background.js', 'os-agent.js', 'os-task.js', 'os-describe.js',
  'os-daemon.js', 'message-router.js', 'vision-planner.js', 'vision-prompts.js', 'vision-normalize.js', 'intent-engine.js',
  'gemini-fetch-client.js', 'gemini-ladder.js', 'gemini-models.js', 'gemini-json.js', 'settings.js', 'sleep.js'];

describe('XSS guard', () => {
  for (const file of UI_AND_WORKER) {
    test(`${file}: innerHTML only takes constant markup`, () => {
      const src = read(file);
      assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\beval\(|new Function\(/);
      const rhs = [...src.matchAll(/\.innerHTML\s*[+]?=\s*([^;\n]+);/g)].map((m) => m[1].trim());
      const allowed = SAFE_INNER_HTML[file] || [];
      assert.deepEqual(rhs.filter((r) => !allowed.includes(r)), [], 'unexpected innerHTML');
    });
  }

  test('the icon and hint constants are string literals', () => {
    const sp = read('sidepanel.js');
    for (const name of ['ICON_PLAY', 'ICON_PAUSE', 'ICON_CHECK']) {
      assert.match(sp, new RegExp(`const ${name} = '[^'$\`]*';`), name);
    }
    const icons = /const RESULT_ICONS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(sp)[1];
    for (const line of icons.split('\n').map((l) => l.trim()).filter(Boolean)) {
      assert.match(line, /^(\w+|''):\s*resultIcon\('[^'$`]*'\),$/, line);
    }
    assert.match(sp, /const resultIcon = \(paths\) => '<svg[^$`]*' \+\s*'[^$`]*' \+ paths \+ '<\/svg>';/);
    const hints = /const MODE_HINT = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(read('newtab.js'))[1];
    for (const line of hints.split('\n').map((l) => l.trim()).filter(Boolean)) {
      assert.match(line, /^\w+:\s*'[^'$`]*',?$/, line);
    }
  });
});


const EXT_ID = 'grolextensionid';
const ORIGIN = `chrome-extension://${EXT_ID}/`;
const PAGE = { id: EXT_ID, url: ORIGIN + 'sidepanel.html' };

function sentTypes() {
  const types = new Set();
  for (const [, js] of PAGES) {
    for (const line of read(js).split('\n')) {
      if (!/\b(send|sendMessage)\(/.test(line)) continue;
      for (const m of line.matchAll(/'((?:agent|os|settings):[a-z-]+)'/g)) types.add(m[1]);
    }
  }
  assert.match(read('sidepanel.js'), /type: `\$\{kind\}:\$\{resume \? 'resume' : 'pause'\}`/);
  for (const k of ['agent', 'os']) for (const v of ['pause', 'resume']) types.add(`${k}:${v}`);
  return types;
}

describe('background message router', () => {
  let listener = null;
  let bg;
  let store;
  const realFetch = globalThis.fetch;
  let googleStatus = 200;
  let broadcasts = [];

  before(async () => {
    const listeners = () => ({ addListener() {}, removeListener() {} });
    const session = {};
    store = installChromeStub({
      runtime: {
        id: EXT_ID,
        getURL: (p) => ORIGIN + p,
        sendMessage: async (m) => { broadcasts.push(m); },
        getPlatformInfo: (cb) => cb && cb({}),
        onMessage: { addListener: (fn) => { listener = fn; }, removeListener() {} },
        onInstalled: listeners(), onStartup: listeners(), lastError: null
      }
    });
    chrome.storage.session = {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in session).map((k) => [k, session[k]])),
      set: async (obj) => { Object.assign(session, obj); }
    };
    session.homeOpened = true;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith(ORIGIN)) return new Response("self.GROL_BUILD = 'test';");
      if (u.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify(googleStatus === 200 ? { models: [] } : { error: { code: googleStatus, message: 'API key not valid' } }), { status: googleStatus });
      }
      throw new TypeError('Failed to fetch');
    };
    bg = await import('../../browser/agent-extension/background.js');
  });
  after(() => { globalThis.fetch = realFetch; });

  function ask(msg, sender = PAGE) {
    return new Promise((resolve) => {
      const keepOpen = listener(msg, sender, resolve);
      assert.equal(typeof keepOpen, 'boolean');
    });
  }

  test('registers a listener and exports its handlers', () => {
    assert.equal(typeof listener, 'function');
    assert.equal(typeof bg.handlers, 'object');
  });

  test('every message type the pages send has a handler', () => {
    const types = sentTypes();
    assert.ok(types.size >= 10, `found ${[...types]}`);
    const missing = [...types].filter((t) => !Object.hasOwn(bg.handlers, t));
    assert.deepEqual(missing, []);
  });

  test('unknown and malformed messages get { ok: false }', async () => {
    for (const msg of [{ type: 'nope' }, { type: 'toString' }, { type: '__proto__' }, { type: 'constructor' },
      { type: 5 }, {}, null, 'agent:start', ['agent:start']]) {
      const r = await ask(msg);
      assert.equal(r.ok, false, JSON.stringify(msg));
    }
  });

  test('foreign senders are refused', async () => {
    for (const sender of [
      { id: EXT_ID, url: 'https://evil.example/page', tab: { id: 3 } },
      { id: 'otherextension', url: 'chrome-extension://otherextension/x.html' },
      { id: EXT_ID },
      {},
      null
    ]) {
      const r = await ask({ type: 'settings:get' }, sender);
      assert.deepEqual(r, { ok: false, error: 'Not allowed' });
    }
  });

  test('a browser task without a key is refused before it starts, flagged needsKey', async () => {
    const r = await ask({ type: 'agent:start', goal: 'find a tv on amazon' });
    assert.equal(r.ok, false);
    assert.equal(r.needsKey, true);
    assert.match(r.error, /AI API key/);
    assert.deepEqual(await ask({ type: 'settings:needed' }), { ok: true });
  });

  test('settings: blank, malformed, rejected and accepted keys', async () => {
    assert.equal((await ask({ type: 'settings:get' })).hasKey, false);
    assert.match((await ask({ type: 'settings:save', apiKey: '   ' })).error, /Add an AI API key/);
    assert.match((await ask({ type: 'settings:save', apiKey: { evil: 1 } })).error, /Add an AI API key/);
    assert.match((await ask({ type: 'settings:save', apiKey: 'not a key at all, clearly' })).error, /does not look like/);
    googleStatus = 400;
    assert.match((await ask({ type: 'settings:save', apiKey: 'AIzaSyREJECTED000000000000000000000' })).error, /Google Gemini rejected/);
    assert.equal(store.ai, undefined);
    googleStatus = 200;
    assert.deepEqual(await ask({ type: 'settings:save', apiKey: '  AIzaSyGOODKEY00000000000000000000000 \n' }), { ok: true, verified: true, provider: 'Google Gemini' });
    assert.deepEqual(store.ai, { apiKey: 'AIzaSyGOODKEY00000000000000000000000', provider: 'auto', baseUrl: '', model: '' });
    const got = await ask({ type: 'settings:get' });
    assert.equal(got.hasKey, true);
    assert.equal(got.activeProvider, 'gemini');
    assert.ok(got.providers.some((p) => p.id === 'anthropic') && got.providers.some((p) => p.id === 'ollama'));
    assert.match((await ask({ type: 'settings:save', apiKey: 'abcdefghijklmnopqrstuvwxyz123456' })).error, /Pick the provider/);
  });

  test('empty goals are refused before anything starts', async () => {
    assert.equal((await ask({ type: 'agent:start', goal: '  ' })).ok, false);
    assert.equal((await ask({ type: 'agent:start', goal: { toString: () => 'x' } })).ok, false);
    assert.equal((await ask({ type: 'os:run', text: '' })).ok, false);
  });

  test('OS controls with no task running', async () => {
    assert.deepEqual(await ask({ type: 'os:snapshot' }), { ok: true, task: null });
    assert.deepEqual(await ask({ type: 'os:pause' }), { ok: false });
    assert.deepEqual(await ask({ type: 'os:resume' }), { ok: false });
    assert.deepEqual(await ask({ type: 'os:stop' }), { ok: false });
    assert.deepEqual(await ask({ type: 'os:confirm-answer', id: 'c-123', allow: true }), { ok: false });
    assert.deepEqual(await ask({ type: 'os:confirm-answer' }), { ok: false });
  });

  test('os:run starts a task whose events reach the pages', async () => {
    broadcasts = [];
    const r = await ask({ type: 'os:run', text: 'take a screenshot' });
    assert.equal(r.ok, true);
    assert.match(r.taskId, /^os-/);
    for (let i = 0; i < 50 && !broadcasts.some((m) => m.type === 'os:done'); i++) await new Promise((res) => setTimeout(res, 10));
    const done = broadcasts.find((m) => m.type === 'os:done');
    assert.equal(done.data.taskId, r.taskId);
    assert.match(done.data.result, /helper is not running/);
    assert.equal((await ask({ type: 'os:snapshot' })).task.state, 'failed');
  });
});

describe('API key onboarding in the pages', () => {
  const panel = readFileSync(new URL('../../browser/agent-extension/sidepanel.js', import.meta.url), 'utf8');
  const newtab = readFileSync(new URL('../../browser/agent-extension/newtab.js', import.meta.url), 'utf8');

  test('the side panel checks for a key before starting and keeps the typed task', () => {
    assert.match(panel, /if \(!\(await refreshKeyState\(\)\)\) \{ pendingGoal = goal; return showKeyCard\(\); \}/);
    assert.match(panel, /msg\.type === 'settings:needed'/);
    assert.match(panel, /'Add API key'/);
  });

  test('the new-tab page asks the panel for a key instead of starting a task without one', () => {
    assert.match(newtab, /type: 'settings:get'/);
    assert.match(newtab, /type: 'settings:needed', goal: text/);
  });
});
