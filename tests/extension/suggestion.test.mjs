import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

installChromeStub();
const { findSuggestion, ActionExecutor } = await import('../../browser/agent-extension/vision-actions.js');
const { GeminiLadder } = await import('../../browser/agent-extension/gemini-ladder.js');
const { GeminiError } = await import('../../browser/agent-extension/gemini-fetch-client.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);

const PAGE = `<!doctype html><body>
<input id="from" role="combobox" aria-controls="list" aria-autocomplete="list" value="">
<ul id="list" role="listbox" style="display:none">
  <li role="option">Bengaluru, Karnataka</li>
  <li role="option">New Delhi, Delhi (DEL) Indira Gandhi International</li>
  <li role="option">Delhi Cantonment</li>
</ul>
<input id="plain" value="">
<input id="nomatch" role="combobox" aria-controls="list2">
<ul id="list2" role="listbox"><li role="option">Tokyo</li></ul>
<script>
  const from = document.getElementById('from'), list = document.getElementById('list');
  from.addEventListener('input', () => { setTimeout(() => { list.style.display = from.value ? 'block' : 'none'; }, 200); });
</script></body>`;

describe('findSuggestion in a real page', { skip: CHROME ? false : 'Google Chrome not found' }, () => {
  let proc, profile, send;
  after(async () => {
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      try { process.kill(-proc.pid); } catch (_) {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function open() {
    profile = mkdtempSync(join(tmpdir(), 'grol-suggest-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
    let targets;
    for (let i = 0; i < 50 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 200));
      targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
    }
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(PAGE) });
    await new Promise((r) => setTimeout(r, 500));
  }
  const run = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
  const probe = (text) => run(`(${findSuggestion.toString()})(${JSON.stringify(text)})`);

  test('waits for the list, then picks the option matching the typed city', async () => {
    await open();
    await run(`(() => { const f = document.getElementById('from'); f.focus(); f.value = 'Delhi (DEL)'; f.dispatchEvent(new Event('input')); })()`);
    assert.equal(await probe('Delhi (DEL)'), null, 'list not shown yet');
    await new Promise((r) => setTimeout(r, 300));
    const pick = await probe('Delhi (DEL)');
    assert.match(pick.label, /New Delhi, Delhi \(DEL\)/);
    assert.ok(pick.x > 0 && pick.y > 0);
  });

  test('plain inputs are not autocomplete fields', async () => {
    await run(`document.getElementById('plain').focus()`);
    assert.equal(await probe('anything'), 'not-autocomplete');
  });

  test('no option matching the text means no click', async () => {
    await run(`document.getElementById('nomatch').focus()`);
    assert.equal(await probe('Mumbai'), null);
  });
});

describe('typing into an autocomplete field', () => {
  function executor(found) {
    const clicks = [];
    const keys = [];
    const target = {
      click: async (x, y) => { clicks.push([x, y]); return { success: true }; },
      executeJS: async () => found,
      pressKey: async (k) => { keys.push(k); return { success: true }; }
    };
    const ex = Object.create(ActionExecutor.prototype);
    Object.assign(ex, { target, sleep: async () => {}, pointAt: async () => {}, logger: null });
    return { ex, clicks, keys };
  }

  test('clicks the suggestion and skips Enter', async () => {
    const { ex, clicks } = executor({ x: 10, y: 20, label: 'New Delhi (DEL)' });
    assert.equal(await ex._pickSuggestion('Delhi'), 'New Delhi (DEL)');
    assert.deepEqual(clicks, [[10, 20]]);
  });

  test('plain fields fall through to the normal Enter behaviour', async () => {
    const { ex, clicks } = executor('not-autocomplete');
    assert.equal(await ex._pickSuggestion('Delhi'), null);
    assert.deepEqual(clicks, []);
  });
});

describe('busy models', () => {
  test('an overloaded model is skipped for minutes and the last good model is asked first', async () => {
    const ladder = new GeminiLadder({ stickToLastGood: true });
    const busy = new GeminiError('overloaded', '503 high demand');
    ladder.onFailure('models/a', busy, 1);
    assert.equal(ladder.isSkipped('models/a'), true);
    assert.ok(ladder.coolingUntil.get('models/a') - Date.now() > 5 * 60 * 1000);
    ladder.lastModel = 'models/b';
    assert.deepEqual(ladder.order(['models/a', 'models/b', 'models/c']), ['models/b', 'models/a', 'models/c']);
  });

  test('the last model that answered is remembered across restarts and asked first', async () => {
    const saved = [];
    const memory = { load: async () => 'models/b', save: (m) => saved.push(m) };
    const ladder = new GeminiLadder({ stickToLastGood: true, memory });
    await ladder.memory.load().then((m) => { ladder.lastModel = m; });
    assert.deepEqual(ladder.order(['models/a', 'models/b']), ['models/b', 'models/a']);
  });

  test('the browser agent shows no "busy" notice in the activity log', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../browser/agent-extension/vision-agent.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Gemini is busy|backup model|_reportModelBusy/);
  });
});

