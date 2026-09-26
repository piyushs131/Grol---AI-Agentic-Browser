// Grol home page. Search goes straight to the web; Action (browser agent) and
// OS Control hand the task to the service worker and show progress in the
// side panel. This page only reports a task that could not start.
const $ = (id) => document.getElementById(id);
const q = $('q'), log = $('log'), hint = $('hint');

const SUGGESTIONS = {
  Inspiration: [
    'Compare prices for iPhone 15 Pro across Amazon and Flipkart, then tell me the best deal',
    'Find and summarise the top 3 trending tech stories on HackerNews today'
  ],
  Coding: [
    'Open codechef.com/ide, write a C++ program that adds two numbers, and run it',
    'Create a folder named crud-app on my Desktop and open it in VS Code'
  ],
  Shopping: [
    'Find an LG TV under 25000 on amazon.in and add the cheapest one to the cart',
    'Order ice cream from blinkit'
  ],
  Travel:        ['Find a one-way flight from Delhi to Mumbai next Friday, cheapest option'],
  Entertainment: ['Find what is trending on YouTube today and summarise the top 3'],
  Learning:      ['Find a beginner tutorial for Rust and summarise what it covers']
};

// Constant markup: the only innerHTML on this page.
const MODE_HINT = Object.freeze({
  search: 'Goes straight to the web.',
  action: 'The agent drives the browser for you — clicking, typing, verifying.',
  os:     'Runs on <b>your machine</b> — files, apps, screenshots. Risky actions ask first.'
});

let mode = 'action';
let category = 'Inspiration';
let starting = false;

function line(tag, text, cls) {
  log.classList.add('on');
  const row = document.createElement('div');
  row.className = 'row';
  // textContent: model output and on-screen text flow through here.
  const t = document.createElement('span');
  t.className = `tag ${cls || ''}`;
  t.textContent = tag;
  const body = document.createElement('span');
  body.textContent = text;
  row.append(t, body);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function renderCats() {
  $('cats').replaceChildren();
  Object.keys(SUGGESTIONS).forEach((c) => {
    const b = document.createElement('button');
    b.className = 'cat' + (c === category ? ' active' : '');
    b.textContent = c;
    b.onclick = () => { category = c; renderCats(); renderCards(); };
    $('cats').appendChild(b);
  });
}

function renderCards() {
  const box = $('cards');
  box.replaceChildren();
  (SUGGESTIONS[category] || []).forEach((t) => {
    const d = document.createElement('div');
    d.className = 'card';
    const text = document.createElement('span');
    text.textContent = t;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    d.append(text, arrow);
    d.onclick = () => { q.value = t; run(); };
    box.appendChild(d);
  });
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('.mode').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === m));
  hint.innerHTML = MODE_HINT[m] || '';
}

document.querySelectorAll('.mode').forEach((b) => {
  b.onclick = () => setMode(b.dataset.mode);
});

async function osHealth() {
  try {
    const r = await fetch('http://127.0.0.1:7777/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    const n = Array.isArray(d && d.modules) ? d.modules.length : 0;
    $('osdot').classList.add('up');
    $('osText').textContent = `OS Control: ready (${n} modules)`;
  } catch (_) {
    $('osdot').classList.remove('up');
    $('osText').textContent = 'OS Control: helper not running';
  }
}

async function openPanel() {
  // sidePanel.open() needs a user gesture, so it must be called from this page.
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (_) { /* never block the task on the panel */ }
}

async function run() {
  const text = q.value.trim();
  if (!text || starting) return;
  log.replaceChildren();
  log.classList.remove('on');

  if (mode === 'search') {
    const isUrl = /^https?:\/\//i.test(text) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text);
    chrome.tabs.update({ url: isUrl ? (text.startsWith('http') ? text : 'https://' + text)
                                    : 'https://www.google.com/search?q=' + encodeURIComponent(text) });
    return;
  }

  // A second Enter while the first start is in flight would start a second task.
  starting = true;
  $('go').disabled = true;
  try {
    await openPanel();
    const res = await chrome.runtime.sendMessage(mode === 'os'
      ? { type: 'os:run', text }
      : { type: 'agent:start', goal: text }).catch((e) => ({ ok: false, error: e.message }));
    if (!res || !res.ok) { line(mode === 'os' ? 'os' : 'agent', (res && res.error) || 'could not start', 'err'); return; }
    if (q.value.trim() === text) q.value = '';
  } finally {
    starting = false;
    $('go').disabled = false;
  }
}

$('go').onclick = run;
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(); }
});

setMode('action');
renderCats();
renderCards();
osHealth();
setInterval(osHealth, 8000);
