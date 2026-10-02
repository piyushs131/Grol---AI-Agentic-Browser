import { matchIntent } from './intent-engine.js';
import { GeminiLadder, storedLastModel } from './gemini-ladder.js';
import { resolveProvider } from './llm-providers.js';
import { parseModelJSON } from './gemini-json.js';
import { DaemonClient, DEFAULT_DAEMON_URL } from './os-daemon.js';
import { describe, friendlyError } from './os-describe.js';
import { sleep } from './sleep.js';
import { buildVerifyPrompt, parseVerdict } from './os-verify.js';

export { DEFAULT_DAEMON_URL };

export const DEFAULTS = Object.freeze({
  maxSteps: 40,
  maxActionsPerTurn: 8,
  maxSameAction: 2,
  helperRetries: 4,
  helperRetryMs: 2500,
  recitationRetries: 2,
  maxFailuresInRow: 4,
  maxDoneRejections: 3,
  verifyAttempts: 3,
  verifyRetryMs: 2500,
  settleMs: 700,
  daemonTimeoutMs: 45000,
  modelTimeoutMs: 45000,
  modelRounds: 3,
  hedgeMs: 8000,
  roundBackoffMs: [0, 8000, 20000]
});

const STOPPED = { success: false, result: 'Stopped.' };
const MODULES = new Set(['desktop', 'process', 'filesystem', 'screen', 'browser', 'scheduler']);
const PROCESS_ACTIONS = new Set(['openApplication', 'closeApplication', 'executeCommand']);
const POINTER = new Set(['clickMouse', 'rightClick', 'moveMouse']);
const INPUT = new Set(['clickMouse', 'rightClick', 'dragMouse', 'scrollMouse', 'moveMouse',
  'typeText', 'pressKey', 'hotkey']);
const INFO_ACTIONS = new Set(['listDirectory', 'listProcesses', 'getSystemInfo', 'getTime']);
const DOC_EXT = /\.(pdf|docx?|rtfd?|odt|pages|html?)$/i;
const READS = new Set(['readFile', 'readDocument']);
const LISTS = new Set(['listDirectory', 'searchFiles', 'listProcesses', 'getInstalledApps', 'searchInstalledApps']);
const INSTALL_RE = /(^|[;&|]\s*|\s)(sudo\s+)?(pip3?|python3?\s+-m\s+pip|brew|apt(-get)?|gem|port|conda)\s+install\b|npm\s+(i|install)\s+(-g|--global)\b/i;

function resultForModel(a, result) {
  if (a.action === 'executeCommand' && result) return String(result.stdout || '').slice(-400) || 'exit 0';
  if (READS.has(a.action) && result) {
    const text = String(result.text ?? result.content ?? '');
    const meta = [result.pages && `${result.pages} pages`, result.truncated && 'truncated', result.note].filter(Boolean).join(', ');
    return `${meta ? `(${meta}) ` : ''}TEXT:\n${text.slice(0, 15000)}${text.length > 15000 ? '\n[... cut ...]' : ''}`;
  }
  if (LISTS.has(a.action) && result) return JSON.stringify(result).slice(0, 3000);
  return brief(result);
}
const SELF_APP = /\b(grol|chromium|browseros)\b/i;

const ladder = new GeminiLadder({ stickToLastGood: true, cooldowns: false, memory: storedLastModel() });

const toNumber = (v) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s || '').slice(0, 160);
}

export function normalizeOsAction(a, screen = null) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  let module = typeof a.module === 'string' ? a.module.trim() : '';
  let action = typeof a.action === 'string' ? a.action.trim() : '';
  const rawParams = a.parameters || a.params || a.args;
  const parameters = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? { ...rawParams } : {};
  if (action.includes('.')) [module, action] = action.split('.', 2);
  else if (!action && module.includes('.')) [module, action] = module.split('.', 2);
  if (action === 'composeGmail') return composeGmail(parameters);
  if (action === 'readFile' && DOC_EXT.test(String(parameters.path || ''))) action = 'readDocument';
  if (module === 'agent' || action === 'wait') {
    const ms = toNumber(parameters.ms ?? a.ms) ?? 1000;
    return { module: 'agent', action: 'wait', parameters: { ms: Math.min(Math.max(ms, 0), 10000) } };
  }
  if (!module && action) module = PROCESS_ACTIONS.has(action) ? 'process' : 'desktop';
  if (!MODULES.has(module) || !/^[A-Za-z]\w*$/.test(action)) return null;

  if (action === 'typeText') {
    if (parameters.text == null || String(parameters.text) === '') return null;
    parameters.text = String(parameters.text);
  }
  const onScreen = (x, y) => x !== undefined && y !== undefined && x >= 0 && y >= 0 &&
    (!screen || (x < screen.width && y < screen.height));
  if (POINTER.has(action)) {
    const x = toNumber(parameters.x);
    const y = toNumber(parameters.y);
    if (!onScreen(x, y)) return null;
    Object.assign(parameters, { x: Math.round(x), y: Math.round(y) });
  }
  if (action === 'dragMouse') {
    const [fx, fy, tx, ty] = ['fromX', 'fromY', 'toX', 'toY'].map((k) => toNumber(parameters[k]));
    if (!onScreen(fx, fy) || !onScreen(tx, ty)) return null;
    Object.assign(parameters, { fromX: Math.round(fx), fromY: Math.round(fy), toX: Math.round(tx), toY: Math.round(ty) });
  }
  if (action === 'pressKey' && !String(parameters.key || '').trim()) return null;
  if (action === 'hotkey' && !(Array.isArray(parameters.keys) ? parameters.keys.length : String(parameters.keys || '').trim())) return null;
  return { module, action, parameters };
}

const GRID_KEYS = { clickMouse: [['x', 'width'], ['y', 'height']], rightClick: [['x', 'width'], ['y', 'height']],
  moveMouse: [['x', 'width'], ['y', 'height']],
  dragMouse: [['fromX', 'width'], ['fromY', 'height'], ['toX', 'width'], ['toY', 'height']] };

export function fromGrid(a, screen) {
  if (!a || typeof a !== 'object' || !screen) return a;
  const name = String(a.action || '').split('.').pop();
  const keys = GRID_KEYS[name];
  const raw = a.parameters || a.params || a.args;
  if (!keys || !raw || typeof raw !== 'object') return a;
  const parameters = { ...raw };
  for (const [k, dim] of keys) {
    const v = toNumber(parameters[k]);
    if (v === undefined) continue;
    parameters[k] = v >= 0 && v <= 1000 ? (v / 1000) * (screen[dim] - 1) : v * 1e6;
  }
  return { ...a, parameters };
}

export function gmailComposeUrl({ to, cc, bcc, subject, body } = {}) {
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean).join(',');
  const q = new URLSearchParams({ view: 'cm', fs: '1' });
  for (const [k, v] of [['to', list(to)], ['cc', list(cc)], ['bcc', list(bcc)], ['su', subject], ['body', body]]) {
    if (v !== undefined && v !== null && String(v) !== '') q.set(k, String(v));
  }
  return 'https://mail.google.com/mail/?' + q.toString().replace(/\+/g, '%20');
}

function composeGmail(p) {
  if (!String(p.to ?? '').trim()) return null;
  const name = typeof p.browser === 'string' && p.browser.trim() ? p.browser.trim() : 'Google Chrome';
  return { module: 'process', action: 'openApplication', parameters: { name, path: gmailComposeUrl(p) } };
}

export function parseOsPlan(text) {
  let plan = parseModelJSON(text);
  if (Array.isArray(plan)) plan = plan.find((p) => p && typeof p === 'object');
  if (!plan || typeof plan !== 'object') throw new Error('AI reply is not a JSON object');
  return plan;
}

function logAction(emit, a) {
  const d = describe(a);
  emit(d.kind, d.text, '', `${a.module}.${a.action} ${brief(a.parameters || {})}`);
}

function buildPrompt({ goal, front, screen, history, files, plan, selfApp, grid = true }) {
  return [
    'You control a macOS computer on the user\'s behalf by choosing GUI and OS actions.',
    `GOAL: ${goal}`,
    `NOW: ${new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (local time). Resolve "tomorrow", "5 October", "next Monday" from this.`,
    'The goal is typed quickly and may have typos or shorthand: act on what the user most likely meant',
    '(e.g. "merna pp" = "MERN app", "vs code" = Visual Studio Code) and say so in "thought".',
    '',
    ...(grid ? [
      'COORDINATES: every x / y you give is on a 0-1000 grid over the screenshot, NOT pixels:',
      'x=0 is the left edge, x=1000 the right edge, y=0 the top, y=1000 the bottom. Aim at the CENTRE',
      'of the button or field you mean.'
    ] : [
      `COORDINATES: the screenshot is ${screen.width}x${screen.height} pixels and one pixel is one screen point,`,
      'so give x / y as pixel positions in the image (origin top-left). Aim at the CENTRE of the button or field.'
    ]),
    `Frontmost app right now: ${front ? `${front.app}${front.title ? ` — "${front.title}"` : ''}` : 'unknown'}`,
    ...(selfApp ? [`"${selfApp}" is YOUR OWN window (where the user typed this task). Never click, type or`,
      `focus it, and never pass app:"${selfApp}". Ignore its side panel in the screenshot.`] : []),
    '',
    'ACTIONS (module.action {parameters}):',
    '  process.openApplication {name, path?}  launch or switch to an app; waits until it is in front.',
    '                                      path opens that file or folder IN the app, e.g.',
    '                                      {"name":"Visual Studio Code","path":"desktop/my_app"}',
    '  desktop.focusWindow {title}         bring a running app to the front by app name',
    '  desktop.clickMouse {x, y, button?, doubleClick?}',
    '  desktop.rightClick {x, y}',
    '  desktop.dragMouse {fromX, fromY, toX, toY}',
    '  desktop.scrollMouse {amount, direction}   direction: up|down|left|right',
    '  desktop.typeText {text}             types into the focused field ("\\n" presses Return)',
    '  desktop.pressKey {key, modifiers?}  key: enter, tab, escape, backspace, up, down, left, right, space, a-z, 0-9, f1-f12; modifiers: cmd, shift, alt, ctrl',
    '  desktop.hotkey {keys}               e.g. ["cmd","n"], ["cmd","shift","g"]',
    '  process.closeApplication {name}',
    '  scheduler.createAlarm {at, title?, minutesBefore?, notes?}  an alarm / reminder that rings at an exact',
    '                                      local date and time, e.g. {"at":"2026-10-05 09:00","title":"Alarm"}.',
    '                                      It opens Calendar with the event and a sound alert.',
    '  agent.composeGmail {to, subject, body, cc?, browser?}  opens Gmail\'s compose window with ALL',
    '                                      fields filled in (browser defaults to Google Chrome).',
    '  process.executeCommand {command, cwd?, timeout?}  shell command (login PATH: node, npm, npx, git,',
    '                                      brew, code). cwd may be "~/Desktop/my_app". The user approves it.',
    '  agent.wait {ms}                     let a slow app or page load',
    ...files.map((f) => '  ' + f),
    '  File paths must be alias-relative: desktop/<name>, documents/<name>, downloads/<name>. Never absolute.',
    '',
    'CHOOSE THE RELIABLE ROUTE (clicking pixels is the least reliable thing you can do):',
    '- Folders and files: filesystem.createDirectory / filesystem.writeFile. writeFile creates missing',
    '  parent folders. NEVER create folders or save files through Finder or Open/Save dialogs.',
    '- Writing code or any multi-line text: filesystem.writeFile with the COMPLETE file content. NEVER',
    '  type code into an editor - auto-indent and auto-closing brackets corrupt it.',
    '- Opening a folder or file in an app: process.openApplication {name, path}. NEVER navigate an Open',
    '  dialog. If a dialog is unavoidable: cmd+shift+g, type the full path, Return.',
    '- Reading a document (PDF, Word .doc/.docx, RTF, ODT, HTML, text): filesystem.readDocument {path}. It',
    '  needs no installed tools. NEVER use pdftotext, python/pypdf, or install anything to read a file.',
    '- Summaries and questions about a file: read it with readDocument, then put the answer itself (the',
    '  full summary, key points, dates, parties, obligations) in "result" with done=true.',
    '- Do not install software (pip, brew, apt) unless the user asked for it; a failed install is never',
    '  retried - switch to a built-in action.',
    '- Installing project packages, scaffolding, git, running scripts: process.executeCommand with cwd.',
    '- Use the GUI only for what has no file/command route (clicking in a web page, sending a message).',
    '- Alarms and reminders: ALWAYS scheduler.createAlarm with the exact date and time from the goal. The',
    '  Clock app cannot set a date, and its time picker is easy to fill wrongly - do not use it for a dated',
    '  alarm. The helper confirms Calendar\'s "Adding a new event" dialog itself; if it is still open, press',
    '  Return. Done only when the screenshot shows the event on the right day and time. If Calendar showed',
    '  a first-run welcome screen instead, click Continue and run scheduler.createAlarm once more.',
    '  Never create a second alarm to "fix" a first one that is visible.',
    '- Sending an email (Gmail): agent.composeGmail with to, a fitting subject and a complete polite',
    '  body you write yourself (greeting, request, sign-off; use "\\n" for new lines). Wait ~3s, then',
    '  send with desktop.hotkey ["cmd","enter"] in that browser and look for "Message sent". NEVER type the',
    '  recipient, subject and body yourself. For the Mail app use openApplication {name:"Mail", path:"mailto:..."}.',
    '- Forms in general: ONE field per typeText. Click the field (or press Tab) before each one; never put',
    '  several fields into one typeText - everything lands in the first field.',
    '- If Send or Submit seems to do nothing, look for an error (invalid address, empty field) and fix',
    '  that first instead of clicking again.',
    '- "Build/make an X app": write a small but REAL, working project for the stack the user named',
    '  (all files with real code, package.json with scripts, a README with how to run). A placeholder',
    '  such as a single console.log is NOT building the app. Then open the folder in the requested app.',
    '- Write ORIGINAL code in your own words: your own names, comments, colours and text. Never paste',
    '  a well-known template, starter or library file verbatim. Keep each file under ~80 lines and',
    '  write at most 3 files per turn; add more files in later turns.',
    '',
    'HOW TO WORK:',
    '- Open or focus the app first. Input actions accept {app}: pass the app name you are working in',
    '  and the daemon brings it forward (and refuses to type anywhere else).',
    '- Prefer keyboard shortcuts and search boxes over hunting for small buttons (cmd+n new, cmd+f find,',
    '  cmd+l address bar, cmd+k / cmd+f search in chat apps, Return to send).',
    '- Click a text field before typing into it unless it is clearly already focused.',
    '- Base coordinates on THIS screenshot, never on memory; the screen changes after every action.',
    '- At most 4 GUI actions per turn; when the next move depends on what appears, return fewer.',
    '  filesystem actions do not depend on the screen: send up to 8 of them in one turn.',
    '- If an action had no effect (SCREEN UNCHANGED or REPEATED below), do NOT try it again:',
    '  switch to a different route from the list above.',
    '- If an app shows a login, captcha or permission dialog you cannot answer, stop and say so.',
    '- Set done=true only when EVERY part of the goal is achieved (or it is impossible). Put a',
    '  one-sentence outcome for the user in "result".',
    '',
    plan.length ? 'YOUR PLAN (from an earlier turn; keep or revise it):\n' + plan.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
      : 'You have no plan yet: write one in "plan" covering EVERY part of the goal.',
    '',
    history.length ? 'WHAT HAS HAPPENED SO FAR:\n' + history.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'Nothing has been done yet.',
    '',
    'Reply with JSON only:',
    '{"step":"short title for this turn, imperative, max 6 words (e.g. Search for Kirtika)","thought":"what you see and plan, one sentence","plan":["every remaining step, short"],"actions":[{"module":"..","action":"..","parameters":{}}],"done":false,"result":""}'
  ].join('\n');
}

function shotHash(shot) {
  if (!shot || !shot.data) return null;
  const s = shot.data;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${h >>> 0}`;
}

function actionKey(a) {
  const p = a.parameters || {};
  const b = (v) => (v === undefined ? '' : Math.round(Number(v) / 24));
  if (POINTER.has(a.action)) return `${a.action}@${b(p.x)},${b(p.y)}${p.doubleClick ? ':dbl' : ''}`;
  if (a.action === 'dragMouse') return `drag@${b(p.fromX)},${b(p.fromY)}>${b(p.toX)},${b(p.toY)}`;
  if (a.action === 'typeText') return `type:${p.text}`;
  if (a.action === 'pressKey' || a.action === 'hotkey' || a.action === 'scrollMouse') return `${a.action}:${JSON.stringify(p)}`;
  return null;
}

function commandFailure(a, result) {
  if (a.action !== 'executeCommand' || !result || typeof result !== 'object') return null;
  if (result.success !== false && (result.exitCode === 0 || result.exitCode === undefined)) return null;
  const why = String(result.stderr || result.stdout || '').trim().slice(-300);
  return `exit code ${result.exitCode}${why ? `: ${why}` : ''}`;
}


async function runAction(a, { daemon, askConfirm, emit, isAborted, signal }) {
  if (a.module === 'agent' && a.action === 'wait') {
    await sleep(a.parameters.ms, { signal, isAborted });
    return { ok: true, result: 'waited' };
  }
  let r = await daemon.call(a.module, a.action, a.parameters);
  if (r.status === 'requires_confirmation') {
    const id = r.result && r.result.confirmation_id;
    if (!id) return { ok: false, error: 'The helper asked for approval without a confirmation id.' };
    const allowed = await askConfirm({
      module: a.module, action: a.action, parameters: a.parameters, risk: r.result.risk_level
    });
    if (!allowed || isAborted()) {
      daemon.confirm(id, false);
      return { ok: false, denied: true, error: 'The user declined this action.' };
    }
    emit('ok', 'You approved this', 'ok');
    r = await daemon.confirm(id, true);
  }
  if (r.status === 'success') return { ok: true, result: r.result };
  return { ok: false, error: String(r.error || `failed (${r.status})`), unreachable: !!r.unreachable, aborted: !!r.aborted };
}

async function verifyDone(apiKey, facts, shot, { isAborted, signal, config }) {
  const parts = [{ text: buildVerifyPrompt(facts) }];
  if (shot) parts.push({ inlineData: { mimeType: shot.mime, data: shot.data } });
  for (let attempt = 1; attempt <= config.verifyAttempts; attempt++) {
    try {
      return await ladder.ask(apiKey, parts, {
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        parse: parseVerdict,
        timeoutMs: config.modelTimeoutMs,
        signal,
        isAborted
      });
    } catch (err) {
      if (isAborted() || err.kind === 'auth') return null;
      if (attempt < config.verifyAttempts) await sleep(config.verifyRetryMs * attempt, { signal, isAborted });
    }
  }
  return null;
}

const RECITATION_NUDGE = [
  '',
  'IMPORTANT: your previous reply was WITHHELD by Gemini\'s recitation filter because it reproduced',
  'well-known text (usually boilerplate code) too closely. Reply again, but: write fully original code',
  'with unusual names, your own comments and your own wording; write at most ONE short file (under 50',
  'lines) this turn; or take a non-code step first (createDirectory, openApplication).'
].join('\n');

async function think(apiKey, prompt, shot, { emit, isAborted, signal, config }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await askPlan(apiKey, attempt ? prompt + RECITATION_NUDGE : prompt, shot, attempt, { isAborted, signal, config });
    } catch (err) {
      if (!err || err.kind !== 'recitation' || attempt >= config.recitationRetries || isAborted()) throw err;
      emit('retry', 'Gemini held back that answer — asking for original code', 'muted', err.message);
    }
  }
}

async function askPlan(apiKey, prompt, shot, attempt, { isAborted, signal, config }) {
  const parts = [{ text: prompt }];
  if (shot) parts.push({ inlineData: { mimeType: shot.mime, data: shot.data } });
  return ladder.ask(apiKey, parts, {
    generationConfig: { responseMimeType: 'application/json', temperature: attempt ? 0.8 : 0.2 },
    parse: parseOsPlan,
    timeoutMs: config.modelTimeoutMs,
    rounds: config.modelRounds,
    roundBackoffMs: config.roundBackoffMs,
    hedgeMs: config.hedgeMs,
    signal,
    isAborted
  });
}

function modelFailure(err) {
  const kind = err && err.kind;
  if (kind === 'auth' || kind === 'blocked' || kind === 'network') return err.message;
  if (kind === 'recitation') {
    return 'The model kept withholding its answer as "recitation" (too close to code it was trained on). ' +
      'Try again, or describe the website in more detail so the code is less generic.';
  }
  return 'The AI model is busy right now — every model failed. Try again in a minute. (' +
    String((err && err.message) || 'unknown').slice(0, 160) + ')';
}

async function missingPermissions(daemon) {
  const perms = await daemon.call('desktop', 'getPermissions');
  const p = perms.status === 'success' && perms.result && typeof perms.result === 'object' ? perms.result : null;
  if (!p || (p.accessibility && p.screenRecording)) return null;
  await daemon.call('desktop', 'requestPermissions');
  const missing = [!p.accessibility && 'Accessibility', !p.screenRecording && 'Screen Recording'].filter(Boolean);
  const binary = p.binary || 'the OS Control helper';
  return `macOS has not granted ${missing.join(' and ')} to the OS Control helper (${binary}). ` +
    'Open System Settings → Privacy & Security → ' + missing.join(' / ') +
    `, add ${binary} (press ⌘⇧G in the file picker and paste the path) and switch it on, ` +
    'then restart the helper: launchctl kickstart -k gui/$(id -u)/com.grol.os-companion';
}

async function screenSize(daemon) {
  const r = await daemon.call('desktop', 'getScreenSize');
  const w = r.status === 'success' && r.result ? Number(r.result.width) : 0;
  const h = r.status === 'success' && r.result ? Number(r.result.height) : 0;
  return w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : { width: 1440, height: 900 };
}

const helperGone = (why) => ({
  success: false,
  result: `The OS Control helper stopped responding (${why}). Restart it and try again.`
});

async function runQuick(actions, ctx) {
  let info = '';
  for (const a of actions) {
    logAction(ctx.emit, a);
    const r = await runAction(a, ctx);
    if (ctx.isAborted()) return STOPPED;
    if (!r.ok) return { success: false, result: r.denied ? `Stopped: you declined ${a.module}.${a.action}.` : r.error };
    if (INFO_ACTIONS.has(a.action)) info = brief(r.result);
  }
  return { success: true, result: info ? `Done. ${info}` : 'Done.' };
}

async function runWithRefocus(a, ctx) {
  const r = await runAction(a, ctx);
  if (r.ok || !/Refusing to send input/i.test(r.error) || !a.parameters.app || ctx.isAborted()) return r;
  const fe = friendlyError(r.error);
  ctx.emit(fe.kind, fe.text, 'muted', r.error);
  const focus = await ctx.daemon.call('desktop', 'focusWindow', { title: a.parameters.app });
  return focus.status === 'success' ? runAction(a, ctx) : r;
}

export async function runOsTask(goal, {
  apiKey, emit = () => {}, askConfirm = async () => false, isAborted: aborted = () => false,
  waitIfPaused = async () => false, signal, daemonUrl = DEFAULT_DAEMON_URL, config: overrides = {}
} = {}) {
  const config = { ...DEFAULTS, ...overrides };
  const isAborted = () => !!(signal?.aborted || aborted());
  const daemon = new DaemonClient({ baseUrl: daemonUrl, timeoutMs: config.daemonTimeoutMs, signal });
  const ctx = { daemon, askConfirm, emit, isAborted, signal };
  goal = String(goal ?? '').trim();
  if (!goal) return { success: false, result: 'Say what to do on the computer.' };

  let health = await daemon.probe();
  for (let i = 0; health === 'slow' && i < config.helperRetries && !isAborted(); i++) {
    await sleep(config.helperRetryMs, { signal, isAborted });
    health = await daemon.probe();
  }
  if (health !== 'up') {
    if (isAborted() || health === 'stopped') return STOPPED;
    if (health === 'down') return { success: false, result: 'The OS Control helper is not running. Install it with browser/companion/install-autostart.sh' };
    return { success: false, result: "The OS Control helper is running but the browser can't reach it yet. If macOS is asking for " +
      'your password to let Grol use its keychain, answer it with Always Allow - the browser waits for that answer.' };
  }

  const quick = matchIntent(goal);
  if (quick) return runQuick(quick, ctx);

  if (!String(apiKey || '').trim()) return { success: false, result: 'Add an AI API key in Settings (Gemini, Claude, OpenAI, Grok, …) — multi-step OS tasks need the model.' };

  const blocked = await missingPermissions(daemon);
  if (blocked) return { success: false, result: blocked };

  const screen = await screenSize(daemon);
  const grid = resolveProvider(apiKey).kind === 'gemini';
  const files = await daemon.fileActions();
  const history = [];
  let targetApp = null;
  let failuresInRow = 0;
  let doneRejections = 0;
  let claimedDone = false;
  let plan = [];
  let selfApp = null;
  let lastGuiHash = null;
  const seen = new Map();

  for (let step = 1; step <= config.maxSteps; step++) {
    await waitIfPaused();
    if (isAborted()) return STOPPED;

    const [shotR, frontR] = await Promise.all([
      daemon.call('screen', 'analyzeScreen', { width: screen.width, quality: 60 }),
      daemon.call('desktop', 'getActiveWindow')
    ]);
    if (isAborted()) return STOPPED;
    if (shotR.unreachable) return helperGone(shotR.error);
    const shot = shotR.status === 'success' && shotR.result && shotR.result.base64
      ? { mime: shotR.result.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: shotR.result.base64 } : null;
    const front = frontR.status === 'success' ? frontR.result : null;
    if (!shot) emit('retry', "Couldn't see the screen — trying again", 'muted', shotR.error || '');
    if (!selfApp && front && SELF_APP.test(String(front.app || '')) && !SELF_APP.test(goal)) selfApp = front.app;
    const hash = shotHash(shot);
    if (lastGuiHash && hash && hash === lastGuiHash) {
      history.push('SCREEN UNCHANGED: the screenshot is identical to before your last actions, so they had NO effect ' +
        '(a click missed or a key went nowhere). Do not repeat them; use a different route.');
    }
    lastGuiHash = null;

    let reply;
    const hist = claimedDone
      ? [...history, 'You said the goal was done after those actions. Check the screenshot: if it is, reply done=true with NO actions.']
      : history;
    try {
      reply = await think(apiKey, buildPrompt({ goal, front, screen, history: hist, files, plan, selfApp, grid }), shot,
        { emit, isAborted, signal, config });
    } catch (e) {
      return isAborted() ? STOPPED : { success: false, result: modelFailure(e) };
    }
    if (isAborted()) return STOPPED;
    if (await waitIfPaused()) { step--; continue; }
    if (isAborted()) return STOPPED;

    const thought = typeof reply.thought === 'string' ? reply.thought : '';
    const title = String((typeof reply.step === 'string' && reply.step) || thought).replace(/\.$/, '').slice(0, 80);
    if (title) emit(`${step}`, title, 'muted', thought);
    if (Array.isArray(reply.plan)) {
      const next = reply.plan.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().slice(0, 140)).slice(0, 20);
      if (next.length) plan = next;
    }
    const proposed = Array.isArray(reply.actions) ? reply.actions : [];
    const actions = proposed.map((a) => normalizeOsAction(grid ? fromGrid(a, screen) : a, screen)).filter(Boolean)
      .slice(0, config.maxActionsPerTurn);
    const done = reply.done === true || reply.done === 'true';
    const result = typeof reply.result === 'string' ? reply.result : '';

    if (!actions.length && proposed.length) {
      emit('retry', "The model's actions were not usable — asking again", 'muted', brief(proposed));
      history.push(`${thought} => INVALID: none of ${brief(proposed)} is a valid action ` +
        (grid ? '(coordinates must be 0-1000).' : `on a ${screen.width}x${screen.height} screen.`));
      if (++failuresInRow >= config.maxFailuresInRow) return { success: false, result: 'The model kept proposing actions that cannot be run.' };
      continue;
    }
    if (!actions.length) {
      if (!done) return { success: false, result: result || 'The model stopped without finishing the task.' };
      emit('look', 'Checking the task is really finished', 'muted');
      const verdict = await verifyDone(apiKey, { goal, claim: result, history, front }, shot, { isAborted, signal, config });
      if (isAborted()) return STOPPED;
      if (!verdict) {
        return { success: false, result: "Couldn't confirm the task was finished: the completion check could not run. Check the screen yourself." };
      }
      if (verdict.complete) return { success: true, result: result || verdict.evidence || 'Done.' };
      const missing = verdict.missing || 'the screen does not show the task finished';
      emit('retry', `Not finished yet: ${missing}`.slice(0, 140), 'muted', verdict.evidence);
      if (++doneRejections >= config.maxDoneRejections) return { success: false, result: `Not finished: ${missing}` };
      history.push(`A completion check REJECTED the claim "${result.slice(0, 120)}". Still missing: ${missing}.` +
        (verdict.next ? ` Do this next: ${verdict.next}` : ''));
      claimedDone = false;
      continue;
    }
    claimedDone = done;

    const outcomes = [];
    let interrupted = false;
    let ranGui = false;
    let ranOther = false;
    for (const a of actions) {
      if (await waitIfPaused()) { interrupted = true; break; }
      if (isAborted()) return STOPPED;
      const isInput = a.module === 'desktop' && INPUT.has(a.action);
      if (isInput && selfApp && a.parameters.app && SELF_APP.test(String(a.parameters.app))) delete a.parameters.app;
      if (isInput && !a.parameters.app && targetApp) a.parameters.app = targetApp;
      const label = `${a.module}.${a.action}(${brief(a.parameters)})`;
      const toSelf = selfApp && ((isInput && !a.parameters.app && front && front.app === selfApp) ||
        (/^(focusWindow|openApplication)$/.test(a.action) && SELF_APP.test(String(a.parameters.title || a.parameters.name || ''))));
      if (toSelf) {
        emit('retry', 'Skipped an action on Grol itself', 'muted', label);
        outcomes.push(`${label} -> REFUSED: that is your own window (${selfApp}). Open or focus the app you are working in.`);
        break;
      }
      if (a.action === 'executeCommand' && INSTALL_RE.test(String(a.parameters.command || '')) && !/\binstall/i.test(goal)) {
        emit('retry', 'Skipped installing software — using a built-in way instead', 'muted', label);
        outcomes.push(`${label} -> REFUSED: do not install software to get the task done (pip/brew are often blocked, e.g. PEP 668). ` +
          'Use the built-in actions: filesystem.readDocument reads PDF/Word/RTF/HTML text with no tools.');
        break;
      }
      const key = actionKey(a);
      if (key && (seen.get(key) || 0) >= config.maxSameAction) {
        emit('retry', 'Same action again — trying a different way', 'muted', label);
        outcomes.push(`${label} -> REPEATED: you already did exactly this ${seen.get(key)} times without reaching the goal. ` +
          'It is NOT working. Use another route (filesystem / openApplication with path / command / a shortcut).');
        break;
      }
      if (key) seen.set(key, (seen.get(key) || 0) + 1);
      logAction(emit, a);
      const r = await runWithRefocus(a, ctx);
      if (isAborted()) return STOPPED;
      const cmdFail = r.ok ? commandFailure(a, r.result) : null;
      if (cmdFail) {
        emit('retry', "That command failed — trying another way", 'muted', cmdFail);
        outcomes.push(`${label} -> FAILED: ${cmdFail}`);
        break;
      }
      if (r.ok) {
        if (/^(openApplication|focusWindow)$/.test(a.action)) {
          const fm = r.result && r.result.frontmost;
          const app = (fm && fm.app) || a.parameters.name || a.parameters.title;
          if (app && !(selfApp && SELF_APP.test(String(app)))) targetApp = app;
        }
        if (isInput) ranGui = true; else ranOther = true;
        outcomes.push(`${label} -> ok ${resultForModel(a, r.result)}`);
        continue;
      }
      if (r.unreachable) return helperGone(r.error);
      const fe = friendlyError(r.error);
      emit(fe.kind, fe.text, fe.kind === 'error' ? 'err' : 'muted', r.error);
      if (/Accessibility permission/i.test(r.error)) return { success: false, result: r.error };
      if (r.denied) return { success: false, result: `Stopped: you declined ${a.module}.${a.action}.` };
      outcomes.push(`${a.module}.${a.action}(${brief(a.parameters)}) -> FAILED: ${r.error}`);
      break;
    }
    if (interrupted) outcomes.push('(paused by the user; the rest of this turn was not run)');
    history.push(`${thought} => ${outcomes.join('; ')}`);
    if (ranGui && !ranOther) lastGuiHash = hash;
    failuresInRow = outcomes.some((o) => /-> (FAILED|REFUSED|REPEATED)/.test(o)) ? failuresInRow + 1 : 0;
    if (failuresInRow >= config.maxFailuresInRow) return { success: false, result: 'Kept failing: ' + outcomes[outcomes.length - 1] };

    await sleep(config.settleMs, { signal, isAborted });
  }
  return { success: false, result: `Stopped after ${config.maxSteps} steps without finishing.` };
}
