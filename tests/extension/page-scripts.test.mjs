// Runs the injected page scripts (SOM_SCRIPT, CURSOR_SCRIPT) in a real
// headless Chrome. The extension's own CdpPageTarget drives it through a
// chrome.debugger shim over the DevTools WebSocket, so scripts are injected
// exactly as the agent injects them. Skipped when no Chrome is installed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

function findChrome() {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found) return found;
    } catch (_) {}
  }
  return null;
}

const CHROME = findChrome();
const skip = CHROME ? false : 'Google Chrome not found';

// ------------------------------------------------------------ test pages

const PAGES = {
  '/controls': `<!doctype html><html><head><title>Controls</title><style>
      body { margin: 0; font: 16px sans-serif; }
      .row { margin: 10px; }
      .card { cursor: pointer; width: 140px; height: 30px; background: #eee; }
    </style></head><body>
    <h1>Controls page</h1>
    <div class="row"><button id="btn" onclick="hits.push('btn')">Save</button>
      <a id="lnk" href="#frag">Read more</a></div>
    <div class="row"><input id="txt" placeholder="Your name"> <select id="sel"><option value="">Pick</option>
      <option value="s">Small</option><option value="m" disabled>Medium</option><option value="l">Large</option>
      <option value="hi">बड़ा आकार</option></select></div>
    <div class="row"><textarea id="ta" aria-label="Notes"></textarea>
      <div id="ce" contenteditable="true" style="width:200px;height:40px;border:1px solid">old text</div></div>
    <div class="row"><div id="rb" role="button" tabindex="0" style="width:120px;height:24px">Role button</div>
      <div id="card" class="card">Card action</div>
      <label for="txt" id="lbl">Name label</label></div>
    <div class="row"><button id="dis" disabled>Disabled</button>
      <fieldset disabled style="display:inline"><button id="fsdis">In fieldset</button></fieldset></div>
    <div class="row">
      <button id="hid1" style="display:none">Hidden display</button>
      <button id="hid2" style="visibility:hidden">Hidden visibility</button>
      <div style="opacity:0"><button id="hid3">Hidden by parent opacity</button></div>
      <button id="zero" style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero</button>
      <button id="aria" aria-hidden="true">Aria hidden</button>
      <div inert><button id="inert">Inert button</button></div>
    </div>
    <svg width="160" height="40" class="row"><a href="#svg" id="svglink"><rect width="150" height="30" fill="#ccd"/><text x="10" y="20">SVG link</text></a></svg>
    <div style="height:1400px"></div>
    <button id="below" onclick="hits.push('below')">Far below</button>
    <script>
      window.hits = [];
      document.getElementById('card').addEventListener('click', () => hits.push('card'));
      document.getElementById('lnk').addEventListener('click', () => hits.push('lnk'));
    </script></body></html>`,

  '/shadow': `<!doctype html><html><head><title>Shadow</title></head><body style="margin:0">
    <p>Shadow DOM page</p>
    <x-panel id="host"></x-panel>
    <script>
      window.hits = [];
      customElements.define('x-panel', class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<div style="padding:20px"><button id="inner" style="width:160px;height:40px">Shadow action</button>' +
            '<input id="sin" placeholder="Shadow field"></div>';
          root.getElementById('inner').addEventListener('click', () => hits.push('shadow'));
        }
      });
    </script></body></html>`,

  '/overlay': `<!doctype html><html><head><title>Overlay</title></head><body style="margin:0">
    <button id="under" style="margin:100px;width:160px;height:40px">Buy now</button>
    <div id="modal" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000">
      <div style="background:#fff;margin:200px auto;width:300px;padding:20px">We use cookies
        <button id="accept" onclick="document.getElementById('modal').remove()">Accept all</button></div>
    </div></body></html>`,

  '/nav-a': `<!doctype html><title>A</title><button id="go" style="margin:40px">Go</button>`,
  '/nav-b': `<!doctype html><title>B</title><p>second page</p>`,

  '/range': `<!doctype html><title>Range</title><body>
    <div id="p1"><input type="range" id="r1" min="0" max="100" value="10" aria-label="Volume"></div>
    <div id="p2"><input type="range" id="r2" min="0" max="100" value="90" aria-label="Brightness"></div></body>`,

  '/forms': `<!doctype html><title>Forms</title><body>
    <input id="date" type="date" style="width:200px">
    <input id="phone" style="width:200px" oninput="this.value=this.value.replace(/\\D/g,'').replace(/(\\d{5})(\\d+)/,'$1 $2')">
    <div id="rich" contenteditable="true" style="width:300px;height:60px;border:1px solid">first</div></body>`,

  '/frames': `<!doctype html><title>Frames</title><body><button id="top">Top button</button>
    <iframe srcdoc="<button>Inside frame</button>" style="width:300px;height:80px"></iframe></body>`,

  '/captcha': `<!doctype html><title>Check</title><body><h1>Security check</h1><p>Please verify you are a human to continue.</p></body>`,

  '/rtl': `<!doctype html><html dir="rtl" lang="ar"><title>RTL</title><body>
    <button id="r1" style="width:120px;height:30px">اشتري الآن</button>
    <button id="r2" style="width:120px;height:30px">إضافة</button></body></html>`
};

function hugePage(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(i % 50 === 0
      ? `<div class="r"><button>Item ${i}</button><span>price ${i}</span></div>`
      : `<div class="r"><span>row ${i}</span><span>detail</span></div>`);
  }
  return `<!doctype html><title>Huge</title><body>${rows.join('')}</body>`;
}

// --------------------------------------------------------- browser harness

let proc, profile, server, origin, ws;
let target, observer, executor;
const pending = new Map();
let seq = 0;

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grol-page-scripts-'));
  proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1000,700', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf);
      if (m) {
        clearTimeout(timer);
        // Chrome's helper processes inherit this pipe; holding it open would
        // keep the test process alive until they exit.
        proc.stderr.destroy();
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', (code) => reject(new Error('Chrome exited early: ' + code)));
  });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
}

const js = (expression) => target.executeJS(expression);
const som = (call) => js(`window.__grolSoM.${call}`);

async function open(pathname, { settle = true } = {}) {
  const res = await target.loadURL(origin + pathname);
  assert.equal(res.success, true, 'page loads');
  if (settle) await target.waitForSettle({ timeout: 3000, softCapMs: 200 });
  return js('window.__grolSoM ? "stale" : "fresh"');
}

async function inject() {
  return js((await import('../../browser/agent-extension/page-scripts.js')).SOM_SCRIPT);
}

async function markPage() {
  await inject();
  return som('mark()');
}

const byName = (marks, text) => marks.find((m) => (m.name || '').includes(text));

async function rectOf(selector, shadowHost) {
  const q = shadowHost
    ? `document.querySelector(${JSON.stringify(shadowHost)}).shadowRoot.querySelector(${JSON.stringify(selector)})`
    : `document.querySelector(${JSON.stringify(selector)})`;
  return js(`(() => { const r = ${q}.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
}

const inside = (m, r) => m.x >= r.left && m.x <= r.right && m.y >= r.top && m.y <= r.bottom;

describe('page scripts in a real browser', { skip }, () => {
  let scripts;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const body = url.pathname === '/huge' ? hugePage(Number(url.searchParams.get('n')) || 20000) : PAGES[url.pathname];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body || 'not found');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    await launch();

    const detachListeners = [];
    installChromeStub({
      debugger: {
        attach: async () => {},
        detach: async () => {},
        sendCommand: (_src, method, params) => cdp(method, params),
        onDetach: { addListener: (f) => detachListeners.push(f), removeListener() {} },
        onEvent: { addListener() {}, removeListener() {} }
      },
      tabs: {
        get: async (id) => {
          const { targetInfo } = await cdp('Target.getTargetInfo');
          return { id, url: targetInfo.url, title: targetInfo.title };
        },
        update: async () => ({}),
        query: async () => [],
        create: async () => { throw new Error('tabs.create is not available in this test'); }
      }
    });
    const quiet = { info() {}, warn() {}, error() {} };
    const { CdpPageTarget } = await import('../../browser/agent-extension/cdp-page-target.js');
    const { PageObserver } = await import('../../browser/agent-extension/vision-observer.js');
    const { ActionExecutor } = await import('../../browser/agent-extension/vision-actions.js');
    const { TaskRun } = await import('../../browser/agent-extension/vision-run.js');
    scripts = await import('../../browser/agent-extension/page-scripts.js');
    target = new CdpPageTarget({ logger: quiet, getTabId: async () => 1, mac: process.platform === 'darwin' });
    await target.resolve();
    observer = new PageObserver({ target, logger: quiet });
    executor = new ActionExecutor({ target, logger: quiet, run: new TaskRun('test') });
  });

  after(async () => {
    try { ws && ws.close(); } catch (_) {}
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      // The whole process group, so no renderer or GPU helper outlives the test.
      try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { proc.kill('SIGKILL'); }
      await exited;
    }
    if (server) await new Promise((r) => server.close(r));
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  });

  test('injection is idempotent and upgrades an older version', async () => {
    assert.equal(await open('/nav-a'), 'fresh');
    assert.equal(await inject(), 'installed');
    assert.equal(await inject(), 'already');
    const docId = await som('docId');
    await js('window.__grolSoM = { version: 1, mark: () => "old" }');
    assert.equal(await inject(), 'installed');
    assert.equal(await som('version'), scripts.SOM_VERSION);
    assert.notEqual(await som('docId'), docId);
    assert.ok(Array.isArray((await som('mark()')).marks));
  });

  test('marks buttons, links, fields, select, contenteditable, role=button, pointer cards, labels, SVG links', async () => {
    await open('/controls');
    const res = await markPage();
    const { marks } = res;
    for (const [text, role] of [
      ['Save', 'button'], ['Read more', 'link'], ['Your name', 'input:text'], ['Pick', 'select'],
      ['Notes', 'textbox'], ['old text', 'textbox'], ['Role button', 'button'], ['Card action', 'div'],
      ['Name label', 'label'], ['SVG link', 'link']
    ]) {
      const m = marks.find((x) => x.role === role && (x.name || '').includes(text));
      assert.ok(m, `mark for "${text}"`);
      assert.equal(m.role, role, `role of "${text}"`);
      assert.equal(m.covered, false, `"${text}" is not covered`);
    }
    assert.equal(byName(marks, 'Your name').typable, true);
    assert.equal(byName(marks, 'old text').typable, true);
    assert.deepEqual(byName(marks, 'Pick').options.slice(0, 3), ['Pick', 'Small', 'Medium']);
    assert.equal(res.docId, await som('docId'));
    assert.deepEqual(marks.map((m) => m.mark), marks.map((_, i) => i + 1));
  });

  test('hidden, zero-size, inert and aria-hidden elements get no mark; disabled ones are flagged', async () => {
    await open('/controls');
    const { marks, counts } = await markPage();
    for (const text of ['Hidden display', 'Hidden visibility', 'Hidden by parent opacity', 'Zero', 'Aria hidden', 'Inert button', 'Far below']) {
      assert.equal(byName(marks, text), undefined, `no mark for "${text}"`);
    }
    assert.equal(byName(marks, 'Disabled').disabled, true);
    assert.equal(byName(marks, 'In fieldset').disabled, true, 'fieldset[disabled] disables its controls');
    assert.equal(byName(marks, 'Save').disabled, false);
    assert.ok(counts.below >= 1, 'off-screen controls are counted');
  });

  test('mark centres lie inside the element and a real click there reaches it', async () => {
    await open('/controls');
    const { marks } = await markPage();
    for (const [text, sel] of [['Save', '#btn'], ['Read more', '#lnk'], ['Your name', '#txt'], ['Card action', '#card'], ['Role button', '#rb']]) {
      const m = byName(marks, text);
      const r = await rectOf(sel);
      assert.ok(inside(m, r), `"${text}" centre ${m.x},${m.y} inside its rect`);
      assert.equal(m.rect.x, Math.round(r.left));
      assert.equal(m.rect.y, Math.round(r.top));
    }
    await target.click(byName(marks, 'Save').x, byName(marks, 'Save').y);
    await target.click(byName(marks, 'Card action').x, byName(marks, 'Card action').y);
    assert.deepEqual(await js('hits'), ['btn', 'card']);
  });

  test('coordinates stay in CSS pixels at devicePixelRatio 2 while the screenshot doubles', async () => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 2, mobile: false });
    try {
      await open('/controls');
      const { marks } = await markPage();
      const shot = await target.capture();
      assert.equal(shot.cssWidth, 900);
      assert.equal(shot.imageWidth, 1800);
      assert.equal(shot.imageHeight, 1200);
      assert.equal(shot.scaleX, 0.5);
      const save = byName(marks, 'Save');
      assert.ok(inside(save, await rectOf('#btn')));
      await target.click(save.x, save.y);
      assert.deepEqual(await js('hits'), ['btn']);
      // A model reading the image clicks in image pixels: double the CSS point.
      const point = await executor.resolveTarget({ x: save.x * 2, y: save.y * 2 }, { shot, marks });
      assert.deepEqual([point.x, point.y], [save.x, save.y]);
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
    }
  });

  test('open shadow roots: marked, not "covered" by the host, clickable, focusable', async () => {
    await open('/shadow');
    const { marks } = await markPage();
    const m = byName(marks, 'Shadow action');
    assert.ok(m, 'shadow button is marked');
    assert.equal(m.covered, false);
    assert.ok(inside(m, await rectOf('#inner', '#host')));
    const live = await som(`resolveMark(${m.mark})`);
    assert.equal(live.hitsTarget, true);
    assert.equal(await som(`pointHits(${m.x}, ${m.y}, "Shadow action")`), true);
    await target.click(m.x, m.y);
    assert.deepEqual(await js('hits'), ['shadow']);
    const field = byName(marks, 'Shadow field');
    assert.equal(await som(`focusMark(${field.mark})`), true);
    await target.typeText('typed in shadow');
    assert.equal(await som('activeValue()'), 'typed in shadow');
    const found = await som('findActionable("Shadow action")');
    assert.equal(found.found, true);
    assert.equal((await som('activateText("Shadow action")')).success, true);
    assert.deepEqual(await js('hits'), ['shadow', 'shadow']);
  });

  test('a modal overlay covers what is under it and is reported', async () => {
    await open('/overlay');
    const res = await markPage();
    const under = byName(res.marks, 'Buy now');
    assert.ok(under, 'covered controls are still listed');
    assert.equal(under.covered, true);
    assert.equal(under.muted, true);
    assert.equal(byName(res.marks, 'Accept all').covered, false);
    assert.equal(byName(res.marks, 'Accept all').menu, 1, 'dialog contents are grouped');
    assert.ok(res.blockers.length >= 1);
    assert.equal(res.menus[0].kind, 'dialog');
    const analysis = await som('analyze()');
    assert.match(analysis.dialogs[0].text, /cookies/);
    const live = await som(`resolveMark(${under.mark})`);
    assert.equal(live.covered, true);
    assert.ok(live.blockerPct > 50);
  });

  test('resolveMark follows the element and fails for removed nodes; docId changes on navigation', async () => {
    await open('/controls');
    const { marks, docId } = await markPage();
    const save = byName(marks, 'Save');
    await js('window.scrollTo(0, 40)');
    const live = await som(`resolveMark(${save.mark})`);
    assert.equal(live.y, save.y - 40);
    assert.equal(live.tag, 'BUTTON');
    await js('document.getElementById("btn").remove()');
    assert.equal(await som(`resolveMark(${save.mark})`), null);
    assert.equal(await som('resolveMark(9999)'), null);
    await open('/nav-b');
    assert.equal(await js('window.__grolSoM ? window.__grolSoM.docId : null'), null, 'a new document has no helpers');
    await inject();
    assert.notEqual(await som('docId'), docId);
  });

  test('findActionable scrolls an off-screen control into view', async () => {
    await open('/controls');
    await inject();
    const found = await som('findActionable("Far below")');
    assert.equal(found.found, true);
    assert.equal(found.hitsTarget, true);
    assert.ok(found.scrolledBy > 500);
    assert.ok(inside(found, await rectOf('#below')));
    await target.click(found.x, found.y);
    assert.deepEqual(await js('hits'), ['below']);
    assert.deepEqual(await som('findActionable("No such label")'), { found: false });
    assert.deepEqual(await som('findActionable("")'), { found: false });
    assert.equal((await som('findActionable("Disabled")')).found, false, 'disabled controls are not offered');
  });

  test('activateMark fires a link once and navigates it', async () => {
    await open('/controls');
    const { marks } = await markPage();
    const link = byName(marks, 'Read more');
    const out = await som(`activateMark(${link.mark}, "Read more")`);
    assert.equal(out.success, true);
    assert.deepEqual(await js('hits'), ['lnk'], 'handler runs exactly once');
    assert.equal(await js('location.hash'), '#frag');
    assert.equal((await som('activateMark(9999, "")')).success, false);
  });

  test('selectOption fires change, skips disabled options, matches non-Latin labels', async () => {
    await open('/controls');
    const { marks } = await markPage();
    const sel = byName(marks, 'Pick');
    await js('window.changes = 0; document.getElementById("sel").addEventListener("change", () => changes++)');
    assert.deepEqual(await som(`selectOption(${sel.mark}, "large")`), { success: true, selected: 'Large' });
    assert.equal(await js('document.getElementById("sel").value'), 'l');
    assert.equal(await js('changes'), 1);
    const medium = await som(`selectOption(${sel.mark}, "Medium")`);
    assert.equal(medium.success, false, 'a disabled option is not chosen');
    assert.ok(medium.options.includes('Large'));
    assert.equal((await som(`selectOption(${sel.mark}, "बड़ा")`)).selected, 'बड़ा आकार');
    assert.equal((await som(`selectOption(${sel.mark}, "!!")`)).success, false, 'punctuation does not match everything');
    assert.match((await som(`selectOption(${byName(marks, 'Save').mark}, "x")`)).error, /not a dropdown/);
  });

  test('typeInto / fieldValue / clearField on inputs, formatted fields, date inputs and rich editors', async () => {
    await open('/forms');
    const { marks } = await markPage();
    const [date, phone, rich] = [marks[0], marks[1], byName(marks, 'first')];
    assert.equal(date.role, 'input:date');
    const bad = await som(`typeInto(${date.mark}, "05/01/2024", "")`);
    assert.equal(bad.success, false);
    assert.match(bad.error, /YYYY-MM-DD/);
    assert.equal((await som(`typeInto(${date.mark}, "2024-05-01", "")`)).success, true);
    assert.equal(await som(`fieldValue(${date.mark})`), '2024-05-01');

    const ph = await som(`typeInto(${phone.mark}, "9876543210", "")`);
    assert.equal(ph.success, true, 're-spaced value still counts');
    assert.equal(ph.value, '98765 43210');

    const r = await som(`typeInto(${rich.mark}, "héllo 🌍", "")`);
    assert.equal(r.success, true);
    assert.equal(await som(`fieldValue(${rich.mark})`), 'héllo 🌍');
    await som(`focusMark(${rich.mark})`);
    assert.deepEqual(await target.clearField(), { success: true });
    assert.equal((await som(`fieldValue(${rich.mark})`)).trim(), '');

    await som(`focusMark(${phone.mark})`);
    assert.deepEqual(await target.clearField(), { success: true });
    assert.equal(await som(`fieldValue(${phone.mark})`), '');
    await js('document.activeElement.blur()');
    assert.deepEqual(await target.clearField(), { success: false }, 'nothing focused, nothing cleared');
  });

  test('rangePlan picks the slider that was named, not the last one on the page', async () => {
    await open('/range');
    await inject();
    await js('window.__grolSoM._els = [document.getElementById("r1"), document.getElementById("r2")]');
    const plan = await som('rangePlan(1, 50, "max")');
    assert.equal(plan.success, true);
    assert.equal(plan.from, 10, 'the first slider (value 10) is the one planned');
    assert.equal(plan.to, 50);
    assert.equal(await js('document.getElementById("r1").value'), '10', 'the slider is restored after planning');
    assert.deepEqual(await som('rangeForce(50)'), { pos: 50, text: '50', num: 50 });
  });

  test('analyze reads text, headings and a bot check', async () => {
    await open('/captcha');
    await inject();
    const a = await som('analyze()');
    assert.deepEqual(a.headings, ['Security check']);
    assert.match(a.onScreenText, /verify you are a human/);
    assert.match(a.signals.captcha, /verify you are a human/i);
    assert.equal(a.signals.loginWall, null);
  });

  test('iframes and RTL pages do not break marking', async () => {
    await open('/frames');
    const framed = await markPage();
    assert.ok(byName(framed.marks, 'Top button'));
    await open('/rtl');
    const { marks } = await markPage();
    assert.equal(marks.length, 2);
    for (const m of marks) assert.ok(inside(m, { left: m.rect.x, top: m.rect.y, right: m.rect.x + m.rect.w, bottom: m.rect.y + m.rect.h }));
    assert.ok(byName(marks, 'اشتري'));
  });

  test('a huge DOM is marked well within the agent timeout', async () => {
    await open('/huge?n=30000');
    await inject();
    const t0 = Date.now();
    const res = await target.executeJS('window.__grolSoM.mark()', { timeout: 12000 });
    const markMs = Date.now() - t0;
    assert.ok(res.marks.length > 0 && res.marks.length <= 110);
    const t1 = Date.now();
    await target.executeJS('window.__grolSoM.analyze()', { timeout: 9000 });
    const found = await som('findActionable("Item 29950")');
    const restMs = Date.now() - t1;
    assert.equal(found.found, true);
    assert.ok(markMs < 4000, `mark() took ${markMs}ms`);
    assert.ok(restMs < 6000, `analyze + findActionable took ${restMs}ms`);
  });

  test('cursor: installs once, moves, hides, and is left out of the page signature', async () => {
    await open('/nav-a');
    const before = await target.signature();
    assert.equal(await js(scripts.CURSOR_SCRIPT), 'installed');
    assert.equal(await js(scripts.CURSOR_SCRIPT), 'already');
    const glide = await js('window.__grolCursor.moveTo(120, 80, 5000)');
    assert.deepEqual(glide, { x: 120, y: 80, duration: 900 });
    assert.match(await js('document.getElementById("__grol_cursor__").style.transform'), /translate3d\(120px, 80px, 0px\)/);
    assert.equal(await js('window.__grolCursor.pulse()'), true);
    const during = await target.signature();
    assert.equal(during.nodes, before.nodes, 'the cursor does not count as a page change');
    await inject();
    const marks = (await som('mark()')).marks;
    assert.equal(marks.length, 1, 'the cursor is never marked');
    assert.equal(await js('window.__grolCursor.hide()'), true);
    assert.equal(await js('document.getElementById("__grol_cursor__")'), null);
    await js('window.__grolCursor = { version: 0, hide() { window.oldHidden = true; } }');
    assert.equal(await js(scripts.CURSOR_SCRIPT), 'installed', 'an older cursor is replaced');
    assert.equal(await js('window.oldHidden'), true);
  });

  test('real input through CdpPageTarget: Backspace edits, wheel scrolls down, select-all chord', async () => {
    await open('/controls');
    await js('const t = document.getElementById("txt"); t.focus(); t.value = "hello"; t.setSelectionRange(5, 5)');
    await target.pressKey('Backspace');
    assert.equal(await js('document.getElementById("txt").value'), 'hell');
    await target.pressKey('Home');
    await target.pressKey('Delete');
    assert.equal(await js('document.getElementById("txt").value'), 'ell');
    await target.pressKey('a', ['control']);
    assert.equal(await js('(() => { const t = document.getElementById("txt"); return t.selectionEnd - t.selectionStart; })()'), 3);
    await target.pressKey('Tab');
    assert.notEqual(await js('document.activeElement.id'), 'txt');
    await target.wheel(300, 300, 0, 400);
    await target.waitForSettle({ timeout: 1500, softCapMs: 200 });
    assert.ok(await js('window.scrollY') > 0, 'positive deltaY scrolls down');
  });

  test('the observer and executor work end to end on a real page', async () => {
    await open('/controls');
    const view = await observer.observe();
    assert.ok(view, 'observation succeeds');
    assert.equal(view.docId, await som('docId'));
    assert.ok(view.marks.length > 5);
    assert.equal(view.shot.cssWidth, view.viewport.w);
    assert.match(view.analysis.onScreenText, /Controls page/);
    const save = byName(view.marks, 'Save');
    const res = await executor.start({ action: 'click', mark: save.mark }, view).promise;
    assert.equal(res.success, true);
    assert.equal(res.forcedActivation, undefined);
    assert.deepEqual(await js('hits'), ['btn'], 'a click that arrived is not repeated through the DOM');
    const typed = await executor.start({ action: 'type', mark: byName(view.marks, 'Your name').mark, text: 'Ada' }, view).promise;
    assert.equal(typed.success, true);
    assert.equal(await js('document.getElementById("txt").value'), 'Ada');
    const scrolled = await executor.start({ action: 'scroll', direction: 'down', amount: 300 }, view).promise;
    assert.equal(scrolled.success, true);
    assert.equal(await js('Math.round(scrollY)'), 300);
    assert.equal(await observer.detectSensitiveScreen(origin + '/controls'), null);
  });
});
