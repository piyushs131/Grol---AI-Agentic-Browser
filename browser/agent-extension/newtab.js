const $ = (id) => document.getElementById(id);
const q = $('q'), log = $('log'), hint = $('hint');

// Cards per mode; Search mode shows none because a card there would just be a web search.
const SUGGESTIONS = {
  action: {
    Inspiration: [
      'Show me a quote of the day',
      'Find a fun fact about cats',
      'Show the top 3 stories on Hacker News'
    ],
    Coding: [
      'Open GitHub and show trending repositories',
      'Explain what an API is in simple words',
      'Find a 5-minute video that explains Python'
    ],
    Shopping: [
      'Find wireless earbuds under ₹2,000 on Amazon',
      'Show the price of iPhone 16 on Flipkart',
      'Find a coffee mug under ₹500 on Amazon'
    ],
    Travel: [
      "What's the weather in Goa today?",
      'Show top places to visit in Jaipur',
      'How far is Mumbai from Pune?'
    ],
    Entertainment: [
      'Play lo-fi music on YouTube',
      'Show trending videos on YouTube',
      'Find a funny cat video'
    ],
    Learning: [
      'Teach me one new English word',
      'Show today\'s top news headlines',
      'Explain how rainbows form'
    ]
  },
  os: {
    Inspiration: [
      'Open Notes and write 3 goals for today',
      'Take a screenshot and save it to my Desktop',
      'Open Calendar and show today'
    ],
    Coding: [
      'Create a folder named my-project on my Desktop',
      'Open VS Code',
      'Open Terminal'
    ],
    Shopping: [
      'Open Notes and write a shopping list: milk, eggs, bread',
      'Open Calculator',
      'Create a note called Wishlist'
    ],
    Travel: [
      'Open Maps and show Goa',
      'Write a packing list for a weekend trip in Notes',
      'Open the Weather app'
    ],
    Entertainment: [
      'Open Music',
      'Open Photo Booth',
      'Open my Pictures folder'
    ],
    Learning: [
      'Open Dictionary and look up "happy"',
      'Open my Downloads folder',
      'Write today\'s to-do list in Notes'
    ]
  }
};

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
  Object.keys(SUGGESTIONS[mode] || {}).forEach((c) => {
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
  ((SUGGESTIONS[mode] || {})[category] || []).forEach((t) => {
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
  document.querySelector('.catlabel').hidden = !SUGGESTIONS[m];
  renderCats();
  renderCards();
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
  } catch (err) {
    $('osdot').classList.remove('up');
    $('osText').textContent = err && err.name === 'TimeoutError'
      ? 'OS Control: waiting - answer any macOS password prompt for Grol'
      : 'OS Control: helper not running';
  }
}

async function openPanel() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (_) {  }
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

  starting = true;
  $('go').disabled = true;
  try {
    await openPanel();
    const settings = await chrome.runtime.sendMessage({ type: 'settings:get' }).catch(() => null);
    if (mode === 'action' && settings && settings.ok && !settings.hasKey) {
      chrome.runtime.sendMessage({ type: 'settings:needed', goal: text }).catch(() => {});
      line('agent', 'Add your AI API key (Gemini, Claude, OpenAI, Grok, …) in the side panel on the right, then run the task again.', 'err');
      return;
    }
    const res = await chrome.runtime.sendMessage(mode === 'os'
      ? { type: 'os:run', text }
      : { type: 'agent:start', goal: text }).catch((e) => ({ ok: false, error: e.message }));
    if (!res || !res.ok) {
      if (res && res.needsKey) chrome.runtime.sendMessage({ type: 'settings:needed', goal: text }).catch(() => {});
      line(mode === 'os' ? 'os' : 'agent', (res && res.error) || 'could not start', 'err');
      return;
    }
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
osHealth();
setInterval(osHealth, 8000);
