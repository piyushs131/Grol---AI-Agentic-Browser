const $ = (id) => document.getElementById(id);

let tab = 'browser';
let planSteps = [];
let stepIndex = 0;
let currentTask = null;
let runState = 'idle';
let runKind = 'browser';

const SUGGESTIONS = {
  browser: [
    'Find the top 3 stories on Hacker News and summarise them',
    'Search Amazon for noise-cancelling headphones under ₹5,000',
    'Open YouTube and play lo-fi music',
  ],
  os: [
    'Create a folder called Projects on my Desktop',
    'Open the Calculator app',
    'Take a screenshot',
  ],
};

const STATES = {
  idle:             ['Ready', ''],
  starting:         ['Starting…', 'run'],
  planning:         ['Planning…', 'run'],
  observing:        ['Looking at the page…', 'run'],
  thinking:         ['Thinking…', 'run'],
  executing:        ['Working…', 'run'],
  waiting_for_user: ['Needs your input', 'wait'],
  paused:           ['Paused', 'wait'],
  completed:        ['Completed', 'ok'],
  failed:           ['Failed', 'err'],
  aborted:          ['Stopped', ''],
};
const FINISHED = new Set(['idle', 'completed', 'failed', 'aborted']);

const VERBS = { navigate: 'Open', click: 'Click', click_text: 'Click', type: 'Type', scroll: 'Scroll',
  wait: 'Wait', press: 'Key', key: 'Key', extract: 'Read', select: 'Select', hover: 'Hover', os: 'OS',
  open: 'Open', switch: 'Switch', close: 'Close', dblclick: 'Double-click', rclick: 'Right-click',
  point: 'Point', drag: 'Drag', run: 'Run', file: 'File', look: 'Look', step: 'Step',
  retry: 'Retry', error: 'Error', ok: 'OK' };
const verb = (t) => VERBS[t] || String(t || 'Step').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const ICON_PLAY = '<path d="M7 5v14l12-7z"/>';
const ICON_PAUSE = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
const ICON_CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>';
const resultIcon = (paths) => '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
const RESULT_ICONS = Object.freeze({
  ok: resultIcon('<path d="M5 12l5 5 9-10"/>'),
  err: resultIcon('<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>'),
  warn: resultIcon('<path d="M12 9v4M12 16.5v.5"/><path d="M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/>'),
  '': resultIcon('<rect x="7" y="7" width="10" height="10" rx="1.5"/>'),
});

async function send(msg) {
  try { return await chrome.runtime.sendMessage(msg); } catch (_) { return null; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function showRun(on) {
  $('empty').hidden = on;
  $('run').hidden = !on;
  $('newagent').disabled = !on;
}

function setState(state, label) {
  runState = state;
  const [text, cls] = STATES[state] || [label || state, 'run'];
  $('state').textContent = label || text;
  $('pill').className = 'pill' + (cls ? ' ' + cls : '');
  const live = !FINISHED.has(state);
  $('controls').classList.toggle('show', live);
  if (planSteps.length) renderPlan();
  $('pauseLbl').textContent = state === 'paused' ? 'Resume' : 'Pause';
  $('pauseIc').innerHTML = state === 'paused' ? ICON_PLAY : ICON_PAUSE;
}

function renderPlan() {
  $('planSect').hidden = !planSteps.length;
  $('plan').replaceChildren();
  planSteps.forEach((s, i) => {
    const done = i < stepIndex;
    const now = i === stepIndex && !FINISHED.has(runState);
    const li = el('li', 'step' + (done ? ' done' : now ? ' now' : ''));
    const mk = el('span', 'mk');
    if (done) mk.innerHTML = ICON_CHECK;
    else mk.textContent = i + 1;
    li.append(mk, el('span', 'tx', String(s ?? '').replace(/^Step \d+:\s*/i, '')));
    $('plan').appendChild(li);
  });
  $('planCount').textContent = planSteps.length ? `${Math.min(stepIndex, planSteps.length)} of ${planSteps.length}` : '';
}

function act(tag, text, cls, detail) {
  const row = el('div', 'act' + (tag === 'retry' ? ' quiet' : ''));
  const tone = /^(ok|err|muted|warn)$/.test(cls || '') ? ' ' + cls : '';
  row.append(el('span', 'verb' + tone, verb(tag)), el('span', 'what', String(text ?? '')));
  if (detail) row.title = String(detail).slice(0, 1000);
  $('log').appendChild(row);
  $('logSect').hidden = false;
  $('logCount').textContent = $('log').children.length;
  scrollDown();
}

const needsKey = (text) => /API key|rejected the|rejected this key|No model is set|base URL/i.test(String(text || ''));

function result(kind, title, msg) {
  const box = el('div', 'result' + (kind ? ' ' + kind : ''));
  const ic = el('span', 'ic');
  ic.innerHTML = RESULT_ICONS[kind] || RESULT_ICONS[''];
  const body = el('div');
  body.append(el('b', '', title));
  if (msg) body.append(el('div', 'msg', msg));
  if (kind === 'err' && needsKey(msg)) {
    const add = el('button', 'keyfix', 'Add API key');
    add.type = 'button';
    add.onclick = () => showKeyCard();
    body.append(add);
  }
  box.append(ic, body);
  $('tail').replaceChildren(box);
  scrollDown();
}

function scrollDown() { const m = $('main'); m.scrollTop = m.scrollHeight; }

function reset(goal) {
  $('log').replaceChildren(); $('tail').replaceChildren();
  $('logSect').hidden = true;
  planSteps = []; stepIndex = 0; renderPlan();
  $('goalText').textContent = goal || '';
}

function renderChips() {
  $('chips').replaceChildren(...SUGGESTIONS[tab].map((s) => {
    const b = el('button', 'chip', s);
    b.onclick = () => { $('goal').value = s; autosize(); $('goal').focus(); };
    return b;
  }));
  $('emptyTitle').textContent = tab === 'os' ? 'What should I do on your Mac?' : 'What should I do?';
  $('emptySub').textContent = tab === 'os'
    ? 'Files, apps and screenshots, through the local OS Control helper. Risky actions ask first.'
    : "Describe a task and I'll drive the browser: clicking, typing and checking as I go.";
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
  $('goal').placeholder = tab === 'os'
    ? 'Open an app and do something in it, create a folder, take a screenshot…'
    : 'Tell me what you want to do…';
  renderChips();
  setState(runState);
  osHealth();
}
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

let osTaskId = null;

function removeBox(id) {
  const old = $(id);
  if (old) old.remove();
}

function askBox(id, lead, parts, [yesLabel, onYes], [noLabel, onNo]) {
  removeBox(id);
  const box = el('div', 'confirm');
  box.id = id;
  const q = el('div');
  q.append(el('b', '', lead), ...parts);
  const yes = el('button', 'approve', yesLabel);
  const no = el('button', 'deny', noLabel);
  const btns = el('div', 'btns');
  btns.append(yes, no);
  box.append(q, btns);
  yes.onclick = () => { box.remove(); onYes(); };
  no.onclick = () => { box.remove(); onNo(); };
  $('tail').appendChild(box);
  scrollDown();
}

function showOsConfirm(d) {
  const answer = (allow) => send({ type: 'os:confirm-answer', id: d.id, allow });
  askBox('osconfirm', 'Allow this? ', [
    document.createTextNode(`${d.module}.${d.action} ${JSON.stringify(d.parameters || {}).slice(0, 140)} `),
    el('span', 'risk', `(risk: ${d.risk || '?'})`)
  ], ['Allow', () => answer(true)], ['Cancel', () => answer(false)]);
  setState('waiting_for_user');
}

function followOs(taskId, goal) {
  if (osTaskId === taskId) return;
  osTaskId = taskId; runKind = 'os'; currentTask = null;
  if (tab !== 'os') setTab('os');
  reset(goal || ''); showRun(true);
}

function applyOsEvent(msg) {
  const d = msg.data || {};
  switch (msg.type) {
    case 'os:started':
      followOs(d.taskId, d.goal);
      setState('thinking');
      break;
    case 'os:state':
      setState(d.state);
      break;
    case 'os:log':
      if (/^\d+$/.test(d.tag || '')) {
        planSteps.push(d.text); stepIndex = planSteps.length - 1; renderPlan();
      } else act(d.tag || 'os', d.text || '', d.tone, d.detail);
      break;
    case 'os:confirm-request':
      showOsConfirm(d);
      break;
    case 'os:done': {
      stepIndex = planSteps.length; renderPlan();
      removeBox('osconfirm');
      if (d.state === 'aborted') { result('', 'Stopped', 'You stopped this task.'); setState('aborted'); }
      else if (d.success) { result('ok', 'Done', d.result || ''); setState('completed'); }
      else { result('err', "Couldn't finish", d.result || ''); setState('failed'); }
      break;
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type || !msg.type.startsWith('os:')) return;
  const d = msg.data || {};
  if (msg.type === 'os:started') { applyOsEvent(msg); return; }
  if (!osTaskId || d.taskId !== osTaskId) return;
  applyOsEvent(msg);
});

async function runOs(text) {
  setState('thinking');
  runKind = 'os';
  const r = await send({ type: 'os:run', text });
  if (!r || !r.ok) {
    result('err', "Couldn't start", (r && r.error) || 'The OS task did not start.');
    setState('failed');
    return;
  }
  osTaskId = r.taskId;
}

function helperPill(ok, label) {
  const pill = el('span', 'pill ' + (ok ? 'ok' : 'err'));
  pill.append(el('span', 'dot'), label);
  return pill;
}

async function osHealth() {
  const hint = $('oshint');
  hint.hidden = tab !== 'os';
  if (hint.hidden) return;
  try {
    const r = await fetch('http://127.0.0.1:7777/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    const n = Array.isArray(d && d.modules) ? d.modules.length : 0;
    hint.replaceChildren(helperPill(true, 'Helper ready'), ` ${n} modules`);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      hint.replaceChildren(helperPill(false, 'Waiting'), ' answer any macOS password prompt for Grol (Always Allow)');
    } else {
      hint.replaceChildren(helperPill(false, 'Helper offline'), ' run ', el('code', '', 'companion/install-autostart.sh'));
    }
  }
}

function autosize() {
  const g = $('goal');
  g.style.height = 'auto';
  g.style.height = Math.min(g.scrollHeight, 140) + 'px';
  $('runBtn').disabled = !g.value.trim();
}
$('goal').addEventListener('input', autosize);
$('goal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); start(); }
});

async function start() {
  const goal = $('goal').value.trim();
  if (!goal) return;
  if (!(await refreshKeyState())) { pendingGoal = goal; return showKeyCard(); }
  reset(goal); showRun(true);
  $('goal').value = ''; autosize();
  currentTask = 'pending';

  if (tab === 'os') { osTaskId = null; return runOs(goal); }

  runKind = 'browser'; osTaskId = null;
  setState('starting');
  const r = await send({ type: 'agent:start', goal });
  if (!r || !r.ok) {
    result('err', "Couldn't start", (r && r.error) || 'The agent did not start.');
    setState('failed');
    return;
  }
  currentTask = r.taskId || null;
}

$('runBtn').onclick = start;
$('stop').onclick = async () => {
  $('stop').disabled = true;
  await send({ type: runKind === 'os' ? 'os:stop' : 'agent:stop' });
  $('stop').disabled = false;
  removeBox('handoff');
  if (runKind !== 'os') setState('aborted');
};
$('pause').onclick = async () => {
  const resume = runState === 'paused';
  const kind = runKind === 'os' ? 'os' : 'agent';
  $('pause').disabled = true;
  const r = await send({ type: `${kind}:${resume ? 'resume' : 'pause'}` });
  $('pause').disabled = false;
  const ok = r && (r.ok || r.success);
  if (!ok) { act('os', resume ? 'Could not resume — the task already ended.' : 'Could not pause — no task is running.', 'err'); return; }
  if (kind === 'agent') setState(resume ? 'observing' : 'paused');
};
$('newagent').onclick = () => {
  if (!FINISHED.has(runState)) send({ type: runKind === 'os' ? 'os:stop' : 'agent:stop' });
  osTaskId = null;
  reset(''); showRun(false); currentTask = null; setState('idle');
  $('goal').value = ''; autosize(); $('goal').focus();
};

function followRun(d) {
  const goal = (d.task && d.task.goal) || d.goal;
  if ($('run').hidden) { reset(goal); showRun(true); }
  else if ((goal && goal !== $('goalText').textContent)
    || (FINISHED.has(runState) && d.newState && !FINISHED.has(d.newState))) {
    reset(goal || $('goalText').textContent);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  const d = msg.data || {};
  const runEvent = ['agent:plan-steps', 'agent:action-log', 'agent:task-complete'].includes(msg.type)
    || (msg.type === 'agent:status-change' && d.newState && d.newState !== 'idle');
  if (runEvent && !(msg.type === 'agent:task-complete' && currentTask === 'pending')) {
    if (runKind === 'os' && osTaskId && !FINISHED.has(runState)) return;
    runKind = 'browser'; osTaskId = null;
    if (tab !== 'browser') setTab('browser');
    followRun(d);
  }
  switch (msg.type) {
    case 'agent:plan-steps':
      planSteps = Array.isArray(d.steps) ? d.steps : []; stepIndex = 0; renderPlan();
      break;
    case 'agent:status-change':
      if (d.newState) setState(d.newState);
      break;
    case 'agent:require-user-action':
      askBox('handoff', 'Needs you: ', [document.createTextNode(d.message || 'Finish this step on the page yourself.')],
        ["I'm done — continue", () => send({ type: 'agent:user-done' })],
        ['Stop task', () => { send({ type: 'agent:stop' }); setState('aborted'); }]);
      break;
    case 'agent:user-action-complete':
      removeBox('handoff');
      break;
    case 'agent:plan-progress':
      stepIndex = Math.max(0, Math.min(d.index || 0, planSteps.length - 1)); renderPlan();
      break;
    case 'agent:action-log':
      act(d.actionType || 'step', d.description || '');
      break;
    case 'agent:task-complete': {
      if (currentTask === 'pending') break;
      if (currentTask && d.taskId && d.taskId !== currentTask) break;
      const text = d.result || '';
      if (d.success) {
        stepIndex = planSteps.length; renderPlan();
        result('ok', 'Done', text); setState('completed');
      } else if (/stopped by user/i.test(text)) {
        result('', 'Stopped', 'You stopped this task.'); setState('aborted');
      } else {
        result('err', 'Something went wrong', text); setState('failed');
      }
      break;
    }
  }
});

function replayOs(t) {
  followOs(t.taskId, t.goal);
  t.events.forEach(applyOsEvent);
  if (!FINISHED.has(t.state)) setState(t.state);
  if (t.pendingConfirm) showOsConfirm(t.pendingConfirm);
}

async function catchUp() {
  const o = await send({ type: 'os:snapshot' });
  const t = o && o.ok && o.task && Array.isArray(o.task.events) ? o.task : null;
  if (t && !FINISHED.has(t.state)) return replayOs(t);
  await catchUpAgent();
}

async function catchUpAgent() {
  const s = await send({ type: 'agent:snapshot' });
  if (!s || !s.ok) return false;
  const plan = Array.isArray(s.plan) ? s.plan : [];
  const log = Array.isArray(s.log) ? s.log : [];
  if (!plan.length && !log.length && (!s.state || s.state === 'idle')) return false;
  showRun(true);
  if (s.goal) $('goalText').textContent = s.goal;
  if (plan.length) { planSteps = plan; stepIndex = Math.min(s.planIndex || 0, plan.length - 1); renderPlan(); }
  log.forEach((e) => act(e.tag, e.text, ''));
  if (s.state) setState(s.state);
  runKind = 'browser';
  return true;
}

async function checkRunAlive() {
  if ($('run').hidden || FINISHED.has(runState) || currentTask === 'pending') return;
  const lost = () => {
    result('err', "Couldn't finish", 'The background worker restarted and the task was lost. Run it again.');
    setState('failed');
  };
  if (runKind === 'os') {
    if (!osTaskId) return;
    const o = await send({ type: 'os:snapshot' });
    if (!o || !o.ok || runKind !== 'os' || FINISHED.has(runState)) return;
    const t = o.task;
    if (!t || !Array.isArray(t.events)) return lost();
    if (t.taskId !== osTaskId) return FINISHED.has(t.state) ? lost() : replayOs(t);
    if (FINISHED.has(t.state)) {
      const done = t.events.filter((e) => e && e.type === 'os:done').pop();
      return done ? applyOsEvent(done) : lost();
    }
    return;
  }
  const s = await send({ type: 'agent:snapshot' });
  if (s && s.ok && s.state === 'idle' && runKind === 'browser' && !FINISHED.has(runState)) lost();
}


let pendingGoal = '';

function showKeyCard() {
  showRun(false);
  $('keycard').hidden = false;
  $('keyinput').focus();
}

let providers = [];

function syncProviderFields() {
  const id = $('keyprovider').value;
  const p = providers.find((x) => x.id === id);
  const local = !!(p && p.local);
  $('keybaserow').hidden = !(id === 'custom' || local);
  if (p && p.baseUrl && !$('keybase').value) $('keybase').placeholder = p.baseUrl;
  $('keyinput').placeholder = local ? 'API key (not needed for a local server)'
    : id === 'custom' ? 'API key (if your server needs one)' : 'Paste your API key';
  $('keymodel').placeholder = p && p.models && p.models.length
    ? `Leave empty for ${p.models[0]}` : (local || id === 'custom' ? 'e.g. llama3.2-vision, qwen2.5-vl' : 'Leave empty for the recommended model');
  const link = $('keylink');
  link.hidden = !(p && p.keyUrl) && id !== 'auto';
  if (p && p.keyUrl) link.href = p.keyUrl;
}

async function refreshKeyState() {
  const r = await send({ type: 'settings:get' });
  const has = !!(r && r.hasKey);
  if (r && Array.isArray(r.providers) && !providers.length) {
    providers = r.providers;
    const sel = $('keyprovider');
    for (const p of providers) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      sel.append(o);
    }
  }
  if (r) {
    $('keyprovider').value = r.provider || 'auto';
    if (r.baseUrl) $('keybase').value = r.baseUrl;
    if (r.model) $('keymodel').value = r.model;
    $('keynow').hidden = !has;
    $('keynow').textContent = has ? `Using ${r.providerLabel}${r.model ? ` · ${r.model}` : ''}. Save a new key to switch.` : '';
    syncProviderFields();
  }
  $('keybtn').classList.toggle('warn', !has);
  if (!has && $('run').hidden) $('keycard').hidden = false;
  return has;
}

$('keybtn').onclick = () => {
  if (!$('run').hidden) return showKeyCard();
  $('keycard').hidden = !$('keycard').hidden;
  if (!$('keycard').hidden) $('keyinput').focus();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'settings:needed') {
    if (msg.goal) pendingGoal = String(msg.goal);
    refreshKeyState().then((has) => { if (!has) showKeyCard(); });
  }
});

$('keycard').onsubmit = async (e) => {
  e.preventDefault();
  const apiKey = $('keyinput').value.trim();
  const msg = $('keymsg');
  const say = (cls, text) => { msg.className = 'keymsg' + (cls ? ' ' + cls : ''); msg.textContent = text; };
  const provider = $('keyprovider').value;
  const p = providers.find((x) => x.id === provider);
  const keyless = (p && p.local) || provider === 'custom';
  if (!apiKey && !keyless) return say('err', 'Paste your API key first.');
  const save = $('keycard').querySelector('button[type=submit]');
  save.disabled = true;
  say('', 'Checking the key…');
  const r = await send({ type: 'settings:save', apiKey, provider,
    baseUrl: $('keybase').value.trim(), model: $('keymodel').value.trim() });
  save.disabled = false;
  if (!r || !r.ok) return say('err', (r && r.error) || 'Could not save the key. Try again.');
  $('keyinput').value = '';
  say('ok', r.verified ? `Saved — using ${r.provider}. You can start a task.` : `Saved, but ${r.provider} couldn't be reached to check it.`);
  refreshKeyState();
  $('keybtn').classList.remove('warn');
  if (pendingGoal) { $('goal').value = pendingGoal; pendingGoal = ''; autosize(); $('goal').focus(); }
  setTimeout(() => { $('keycard').hidden = true; msg.textContent = ''; }, 1500);
};

$('keyprovider').onchange = syncProviderFields;

renderChips();
setState('idle');
refreshKeyState();
catchUp();
osHealth();
setInterval(() => { osHealth(); checkRunAlive(); }, 8000);
