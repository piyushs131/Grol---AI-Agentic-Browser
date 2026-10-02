
const SITES = [
  [/\bamazon\b/, 'https://www.amazon.in'],
  [/\bflipkart\b/, 'https://www.flipkart.com'],
  [/\bmyntra\b/, 'https://www.myntra.com'],
  [/\bblinkit\b/, 'https://blinkit.com'],
  [/\bzepto\b/, 'https://www.zeptonow.com'],
  [/\bswiggy\b/, 'https://www.swiggy.com'],
  [/\bzomato\b/, 'https://www.zomato.com'],
  [/\byoutube\b/, 'https://www.youtube.com'],
  [/\bgmail\b|\bmy (e-?mails?|inbox)\b/, 'https://mail.google.com'],
  [/\bgoogle sheets?\b|\bspreadsheet\b/, 'https://sheets.new'],
  [/\bgoogle docs?\b/, 'https://docs.new'],
  [/\bhacker ?news\b/, 'https://news.ycombinator.com'],
  [/\blinkedin\b/, 'https://www.linkedin.com'],
  [/\bgithub\b/, 'https://github.com'],
  [/\bwikipedia\b/, 'https://en.wikipedia.org'],
  [/\bixigo\b/, 'https://www.ixigo.com/trains'],
  [/\birctc\b|\btrain\b/, 'https://www.ixigo.com/trains'],
  [/\bmakemytrip\b/, 'https://www.makemytrip.com'],
  [/\bflights?\b/, 'https://www.google.com/travel/flights']
];

const DOMAIN_RE = /\b([a-z0-9][a-z0-9-]*\.(?:com|in|org|net|co|io|app|dev))\b/i;

const searchUrl = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q);

const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
};

export function startUrlFor(goal, here) {
  const g = String(goal || '').toLowerCase();
  let dest = null, at = Infinity;
  for (const [re, url] of SITES) {
    const m = re.exec(g);
    if (m && m.index < at) { at = m.index; dest = url; }
  }
  if (!dest) {
    const d = DOMAIN_RE.exec(g);
    if (d) dest = 'https://' + d[1];
  }
  if (dest) return hostOf(dest) && hostOf(dest) === hostOf(here) ? null : dest;
  const blank = !here || here === 'about:blank' || !/^https?:/i.test(here);
  return blank ? searchUrl(String(goal).trim()) : null;
}

export function recoveryUrl({ plan = [], goal = '', lastGoodUrl = null } = {}) {
  for (const line of plan) {
    const m = /https?:\/\/[^\s)\]"'<>]+/i.exec(String(line));
    if (m) return m[0];
  }
  if (lastGoodUrl) return lastGoodUrl;
  const g = String(goal || '');
  const d = DOMAIN_RE.exec(g);
  if (d) return 'https://' + d[1];
  return g.trim() ? searchUrl(g.trim()) : null;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function scoreMarksByText(marks, text) {
  const want = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!want) return [];
  const wantSquashed = squash(want);

  const usable = (marks || []).filter(m => !m.disabled && !m.covered);
  const pool = usable.length ? usable : (marks || []);

  const scored = [];
  for (const m of pool) {
    const name = String(m.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const ns = squash(name);
    let base;
    if (name === want) base = 100;
    else if (wantSquashed && ns === wantSquashed) base = 95;
    else if (name.startsWith(want)) base = 80;
    else if (wantSquashed && ns.startsWith(wantSquashed)) base = 75;
    else if (name.includes(want)) base = 60;
    else if (wantSquashed && ns.includes(wantSquashed)) base = 55;
    else continue;
    const area = (m.rect?.w || 0) * (m.rect?.h || 0);
    const score = base
      - Math.min(20, name.length / Math.max(1, want.length))
      - Math.min(10, area / 40000);
    scored.push({ m, score, base });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function matchMarksByText(marks, text) {
  const all = scoreMarksByText(marks, text);
  if (!all.length) return [];
  const top = all[0].base;
  const tied = all.filter(s => s.base >= top).map(s => s.m);
  const distinct = new Set(tied.map(m => (m.name || '').trim()));
  return distinct.size > 1 ? tied : tied.slice(0, 1);
}

export function pageFlags(analysis) {
  if (!analysis) return '';
  const s = analysis.signals || {};
  const out = [];
  if (s.unavailable) out.push('unavailable — ' + s.unavailable.slice(0, 110));
  if (s.captcha) out.push('bot check — ' + s.captcha.slice(0, 80));
  if (s.loginWall) out.push('sign-in — ' + s.loginWall.slice(0, 80));
  if (analysis.dialogs && analysis.dialogs.length) {
    out.push('dialog on top — ' + analysis.dialogs[0].text.slice(0, 80));
  }
  return out.join(' · ');
}

export function describeView(url, title, view) {
  const marks = view.marks || [];
  const names = marks
    .filter(m => m.name && !m.disabled && !m.covered)
    .slice(0, 6)
    .map(m => `[${m.mark}] ${m.name.slice(0, 28)}`)
    .join(', ');
  const flags = pageFlags(view.analysis);
  return `${title || url} — ${marks.length} interactive elements` +
         (names ? `. e.g. ${names}` : '') +
         (flags ? `. ${flags}` : '');
}

export function describeAction(action, view) {
  const clip = (v, n) => String(v ?? '').slice(0, n);
  const named = (mark) => {
    const m = (view?.marks || []).find(x => x.mark === mark);
    return m && m.name ? `"${m.name.slice(0, 40)}"` : `element ${mark}`;
  };
  switch (action.action) {
    case 'navigate': return `Opening ${action.url}`;
    case 'click_text': return `Clicking "${action.text}"`;
    case 'click':
      return typeof action.mark === 'number'
        ? `Clicking ${named(action.mark)}`
        : `Clicking at (${action.x}, ${action.y})`;
    case 'type':
      return `Typing "${clip(action.text, 40)}"` +
             (typeof action.mark === 'number' ? ` into ${named(action.mark)}` : '') +
             (action.submit ? ' and pressing Enter' : '');
    case 'select_option': return `Choosing "${action.text}" in ${named(action.mark)}`;
    case 'set_range': return `Setting the ${action.bound === 'min' ? 'minimum' : 'maximum'} slider to ${action.value}`;
    case 'back': return 'Going back to the previous page';
    case 'remember': return `Noting: ${clip(action.note, 70)}`;
    case 'open_tab': return `Opening a new tab: ${action.url}`;
    case 'switch_tab': return `Switching to tab ${action.index}`;
    case 'scroll': return `Scrolling ${action.direction} ${typeof action.mark === 'number' ? `the panel at ${named(action.mark)}` : 'the page'}`;
    case 'key': return `Pressing ${action.key}`;
    case 'find_text': return `Looking for "${action.text}" on the page`;
    case 'wait': {
      const s = Math.round((Number(action.ms) || 1000) / 100) / 10;
      return `Waiting ${s} second${s === 1 ? '' : 's'} for the page`;
    }
    case 'done': return `Done: ${action.summary}`;
    default: return action.action;
  }
}

export function actionKey(url, action, scrollY) {
  const parts = [url, action.action];
  if (action.action === 'scroll' && typeof scrollY === 'number') parts.push('y' + Math.round(scrollY / 100));
  if (typeof action.mark === 'number') parts.push('m' + action.mark);
  if (typeof action.x === 'number') parts.push(`${Math.round(action.x / 25)},${Math.round(action.y / 25)}`);
  if (action.url) parts.push(action.url);
  if (action.text) parts.push(String(action.text).slice(0, 24));
  if (action.key) parts.push(String(action.key));
  if (action.direction) parts.push(action.direction);
  return parts.join('#');
}

export function stuckWarning(recentKeys) {
  if (recentKeys.length < 3) return null;
  const [a, b, c] = recentKeys.slice(-3);
  return a === b && b === c
    ? 'You have repeated the same action three times with no progress.'
    : null;
}

const KEY_NAMES = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape',
  tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End'
};

export function normalizeKey(key) {
  const k = String(key || 'Enter').trim();
  return KEY_NAMES[k.toLowerCase()] || k;
}

const MODIFIERS = {
  ctrl: 'control', control: 'control', ctl: 'control',
  cmd: 'meta', command: 'meta', meta: 'meta', super: 'meta', win: 'meta', os: 'meta',
  alt: 'alt', option: 'alt', opt: 'alt',
  shift: 'shift'
};

export function parseKeyChord(spec) {
  if (spec === ' ') return { key: 'Space', modifiers: [] };
  const raw = String(spec ?? '').trim() || 'Enter';
  const parts = raw.length > 1 ? raw.split(/\s*\+\s*/) : [raw];
  if (parts.length > 1 && parts[parts.length - 1] === '') { parts.pop(); parts[parts.length - 1] = '+'; }
  const modifiers = [];
  while (parts.length > 1 && MODIFIERS[parts[0].toLowerCase()]) {
    const m = MODIFIERS[parts.shift().toLowerCase()];
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  const key = parts.join('+');
  return { key: key.length === 1 ? key : normalizeKey(key), modifiers };
}

const NAV_SCHEME_RE = /^https?:/i;

export function normalizeNavUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  if (u === 'about:blank') return u;
  if (NAV_SCHEME_RE.test(u)) {
    try { return new URL(u).href; } catch (_) { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[^:/]+:\d+(\/|$)/.test(u)) return null;
  if (/^\/\//.test(u)) return normalizeNavUrl('https:' + u);
  if (!/^[^\s/]+\.[^\s/]+/.test(u) && !/^localhost(:\d+)?(\/|$)/i.test(u)) return null;
  try { return new URL('https://' + u).href; } catch (_) { return null; }
}

export function valueMatches(got, want) {
  const g = String(got ?? '');
  const w = String(want ?? '');
  if (g.includes(w)) return true;
  const ws = squash(w);
  return !!ws && squash(g).includes(ws);
}

export function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise(resolve => {
      timer = setTimeout(() => resolve({ success: false, timedOut: true, error: `${label} exceeded ${ms}ms` }), ms);
    })
  ]);
}

export function lookAlikeOfGoal(label, goal) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}.+]+/gu, ' ').trim();
  const name = norm(label);
  const g = norm(goal);
  if (name.length < 3 || !g) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^| )${esc} (\\S*\\d\\S*(?: (?:gb|tb|mp|hz|ghz|inch|cm|mm|kg|l|ml|ram|pro|max|plus|ultra))?)(?= |$)`, 'gu');
  const hit = re.exec(g);
  if (!hit) return null;
  if (new RegExp(`(?:^| )${esc}(?= |$)(?! \\S*\\d)`, 'u').test(g)) return null;
  return `${name} ${hit[1]}`;
}
