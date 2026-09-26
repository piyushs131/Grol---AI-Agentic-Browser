// OS Control agent: a look -> think -> act loop over the local helper daemon.
// Each turn screenshots the screen (1 image px = 1 screen point), asks the model
// for the next few actions, and runs them in order. Actions go through the
// daemon's executor, so its confirmation policy still applies via askConfirm.
import { matchIntent } from './intent-engine.js';
import { GeminiLadder } from './gemini-ladder.js';
import { parseModelJSON } from './gemini-json.js';
import { DaemonClient, DEFAULT_DAEMON_URL } from './os-daemon.js';
import { describe, friendlyError } from './os-describe.js';
import { sleep } from './sleep.js';

export { DEFAULT_DAEMON_URL };

export const DEFAULTS = Object.freeze({
  maxSteps: 25,
  maxActionsPerTurn: 4,
  maxFailuresInRow: 4,
  settleMs: 700,
  daemonTimeoutMs: 45000,
  modelTimeoutMs: 45000,
  // Gemini answers 503 "high demand" for minutes at a time. Walk the whole
  // model ladder, wait, and walk it again before giving up.
  modelRounds: 3,
  roundBackoffMs: [0, 8000, 20000]
});

const STOPPED = { success: false, result: 'Stopped.' };
const MODULES = new Set(['desktop', 'process', 'filesystem', 'screen', 'browser', 'scheduler']);
const PROCESS_ACTIONS = new Set(['openApplication', 'closeApplication', 'executeCommand']);
const POINTER = new Set(['clickMouse', 'rightClick', 'moveMouse']);
// Input actions carry the app being worked in, so the daemon brings it forward
// first and refuses to type anywhere else.
const INPUT = new Set(['clickMouse', 'rightClick', 'dragMouse', 'scrollMouse', 'moveMouse',
  'typeText', 'pressKey', 'hotkey']);
const INFO_ACTIONS = new Set(['listDirectory', 'listProcesses', 'getSystemInfo', 'getTime']);

// Shared across tasks: the model that answered last is asked first next time.
// No cooldowns - a busy model is simply asked again on the next round.
const ladder = new GeminiLadder({ stickToLastGood: true, cooldowns: false });

const toNumber = (v) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s || '').slice(0, 160);
}

// Tidy what the model returns ("desktop.typeText" as one string, a missing
// module, agent.wait with no action, "120" as a coordinate) and drop anything
// the daemon would reject or that points off the screen.
export function normalizeOsAction(a, screen = null) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  let module = typeof a.module === 'string' ? a.module.trim() : '';
  let action = typeof a.action === 'string' ? a.action.trim() : '';
  const rawParams = a.parameters || a.params || a.args;
  const parameters = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? { ...rawParams } : {};
  if (action.includes('.')) [module, action] = action.split('.', 2);
  else if (!action && module.includes('.')) [module, action] = module.split('.', 2);
  if (module === 'agent' || action === 'wait') {
    const ms = toNumber(parameters.ms ?? a.ms) ?? 1000;
    return { module: 'agent', action: 'wait', parameters: { ms: Math.min(Math.max(ms, 0), 10000) } };
  }
  if (!module && action) module = PROCESS_ACTIONS.has(action) ? 'process' : 'desktop';
  if (!MODULES.has(module) || !/^[A-Za-z]\w*$/.test(action)) return null;

  // Would only fail in the daemon and cost a whole turn ("Text is required").
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

// The model's reply as a plan object; anything else counts as a bad reply so
// the ladder asks the next model.
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

function buildPrompt({ goal, front, screen, history, files }) {
  return [
    'You control a macOS computer on the user\'s behalf by choosing GUI and OS actions.',
    `GOAL: ${goal}`,
    '',
    `Screen: ${screen.width}x${screen.height} points. The attached screenshot is exactly that size,`,
    'so a pixel (x, y) in the image is the point (x, y) to click. Origin is top-left.',
    `Frontmost app right now: ${front ? `${front.app}${front.title ? ` — "${front.title}"` : ''}` : 'unknown'}`,
    '',
    'ACTIONS (module.action {parameters}):',
    '  process.openApplication {name}      launch or switch to an app; waits until it is in front',
    '  desktop.focusWindow {title}         bring a running app to the front by app name',
    '  desktop.clickMouse {x, y, button?, doubleClick?}',
    '  desktop.rightClick {x, y}',
    '  desktop.dragMouse {fromX, fromY, toX, toY}',
    '  desktop.scrollMouse {amount, direction}   direction: up|down|left|right',
    '  desktop.typeText {text}             types into the focused field ("\\n" presses Return)',
    '  desktop.pressKey {key, modifiers?}  key: enter, tab, escape, backspace, up, down, left, right, space, a-z, 0-9, f1-f12; modifiers: cmd, shift, alt, ctrl',
    '  desktop.hotkey {keys}               e.g. ["cmd","n"], ["cmd","shift","g"]',
    '  process.closeApplication {name}',
    '  process.executeCommand {command}    shell command; the user is asked to approve',
    '  agent.wait {ms}                     let a slow app or page load',
    ...files.map((f) => '  ' + f),
    '  File paths must be alias-relative: desktop/<name>, documents/<name>, downloads/<name>. Never absolute.',
    '',
    'HOW TO WORK:',
    '- Open or focus the app first. Input actions accept {app}: pass the app name you are working in',
    '  and the daemon brings it forward (and refuses to type anywhere else).',
    '- Prefer keyboard shortcuts and search boxes over hunting for small buttons (cmd+n new, cmd+f find,',
    '  cmd+l address bar, cmd+k / cmd+f search in chat apps, Return to send).',
    '- Click a text field before typing into it unless it is clearly already focused.',
    '- Base coordinates on THIS screenshot, never on memory; the screen changes after every action.',
    '- Return at most 4 actions per turn. When the next move depends on what appears, return fewer.',
    '- If an app shows a login, captcha or permission dialog you cannot answer, stop and say so.',
    '- Set done=true only when the screenshot shows the goal achieved (or it is impossible). Put a',
    '  one-sentence outcome for the user in "result".',
    '',
    history.length ? 'WHAT HAS HAPPENED SO FAR:\n' + history.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'Nothing has been done yet.',
    '',
    'Reply with JSON only:',
    '{"step":"short title for this turn, imperative, max 6 words (e.g. Search for Kirtika)","thought":"what you see and plan, one sentence","actions":[{"module":"..","action":"..","parameters":{}}],"done":false,"result":""}'
  ].join('\n');
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
      daemon.confirm(id, false);     // let the helper drop the pending request
      return { ok: false, denied: true, error: 'The user declined this action.' };
    }
    emit('ok', 'You approved this', 'ok');
    r = await daemon.confirm(id, true);
  }
  if (r.status === 'success') return { ok: true, result: r.result };
  return { ok: false, error: String(r.error || `failed (${r.status})`), unreachable: !!r.unreachable, aborted: !!r.aborted };
}

async function think(apiKey, prompt, shot, { emit, isAborted, signal, config }) {
  const parts = [{ text: prompt }];
  if (shot) parts.push({ inlineData: { mimeType: shot.mime, data: shot.data } });
  let told = false;
  return ladder.ask(apiKey, parts, {
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    parse: parseOsPlan,
    timeoutMs: config.modelTimeoutMs,
    rounds: config.modelRounds,
    roundBackoffMs: config.roundBackoffMs,
    signal,
    isAborted,
    // Otherwise a busy model looks exactly like a frozen task.
    onModelError: (model, err) => {
      if (told) return;
      told = true;
      emit('retry', 'Model busy — trying another', 'muted', `${model.replace(/^models\//, '')}: ${String(err.message).slice(0, 160)}`);
    },
    onRound: ({ waitMs, error }) =>
      emit('retry', `Gemini is busy — retrying in ${Math.round(waitMs / 1000)}s`, 'muted', error ? String(error.message) : '')
  });
}

function modelFailure(err) {
  const kind = err && err.kind;
  if (kind === 'auth' || kind === 'blocked' || kind === 'network') return err.message;
  return 'Gemini is busy right now — every model failed. Try again in a minute. (' +
    String((err && err.message) || 'unknown').slice(0, 160) + ')';
}

// Without Accessibility and Screen Recording macOS drops input silently and
// screenshots show only the wallpaper, so check up front and say what to enable.
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

// Runs one action, bringing the target app back to the front once if the
// helper refused to type into a different app.
async function runWithRefocus(a, ctx) {
  const r = await runAction(a, ctx);
  if (r.ok || !/Refusing to send input/i.test(r.error) || !a.parameters.app || ctx.isAborted()) return r;
  const fe = friendlyError(r.error);
  ctx.emit(fe.kind, fe.text, 'muted', r.error);
  const focus = await ctx.daemon.call('desktop', 'focusWindow', { title: a.parameters.app });
  return focus.status === 'success' ? runAction(a, ctx) : r;
}

// waitIfPaused() resolves true once a pause ends, false if there was none.
// daemonUrl and config exist for tests; production uses the defaults.
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

  if (!(await daemon.isUp())) {
    if (isAborted()) return STOPPED;
    return { success: false, result: 'The OS Control helper is not running. Install it with browser/companion/install-autostart.sh' };
  }

  // A single simple instruction the pattern engine knows needs no model and no looking.
  const quick = matchIntent(goal);
  if (quick) return runQuick(quick, ctx);

  if (!String(apiKey || '').trim()) return { success: false, result: 'Add a Gemini API key in settings — multi-step OS tasks need the model.' };

  const blocked = await missingPermissions(daemon);
  if (blocked) return { success: false, result: blocked };

  const screen = await screenSize(daemon);
  const files = await daemon.fileActions();
  const history = [];
  let targetApp = null;
  let failuresInRow = 0;
  let claimedDone = false;

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

    let plan;
    const hist = claimedDone
      ? [...history, 'You said the goal was done after those actions. Check the screenshot: if it is, reply done=true with NO actions.']
      : history;
    try {
      plan = await think(apiKey, buildPrompt({ goal, front, screen, history: hist, files }), shot,
        { emit, isAborted, signal, config });
    } catch (e) {
      return isAborted() ? STOPPED : { success: false, result: modelFailure(e) };
    }
    if (isAborted()) return STOPPED;
    // Paused while the model was thinking: the user may have changed the screen
    // meanwhile, so throw this plan away and look again after resuming.
    if (await waitIfPaused()) { step--; continue; }
    if (isAborted()) return STOPPED;

    // The plan list shows a short title; the full thought stays in the tooltip.
    const thought = typeof plan.thought === 'string' ? plan.thought : '';
    const title = String((typeof plan.step === 'string' && plan.step) || thought).replace(/\.$/, '').slice(0, 80);
    if (title) emit(`${step}`, title, 'muted', thought);
    const proposed = Array.isArray(plan.actions) ? plan.actions : [];
    const actions = proposed.map((a) => normalizeOsAction(a, screen)).filter(Boolean).slice(0, config.maxActionsPerTurn);
    const done = plan.done === true || plan.done === 'true';
    const result = typeof plan.result === 'string' ? plan.result : '';

    if (!actions.length && proposed.length) {
      // Every action was malformed or off-screen: say so and let the model retry.
      emit('retry', "The model's actions were not usable — asking again", 'muted', brief(proposed));
      history.push(`${thought} => INVALID: none of ${brief(proposed)} is a valid action on a ${screen.width}x${screen.height} screen.`);
      if (++failuresInRow >= config.maxFailuresInRow) return { success: false, result: 'The model kept proposing actions that cannot be run.' };
      continue;
    }
    if (!actions.length) {
      return done
        ? { success: true, result: result || 'Done.' }
        : { success: false, result: result || 'The model stopped without finishing the task.' };
    }
    // Models often return the last action AND done:true together. Run the
    // actions and let the next screenshot confirm, rather than stopping early.
    claimedDone = done;

    const outcomes = [];
    let interrupted = false;
    for (const a of actions) {
      if (await waitIfPaused()) { interrupted = true; break; }   // re-look after a pause
      if (isAborted()) return STOPPED;
      if (a.module === 'desktop' && INPUT.has(a.action) && !a.parameters.app && targetApp) {
        a.parameters.app = targetApp;
      }
      logAction(emit, a);
      const r = await runWithRefocus(a, ctx);
      if (isAborted()) return STOPPED;
      if (r.ok) {
        if (/^(openApplication|focusWindow)$/.test(a.action)) {
          const fm = r.result && r.result.frontmost;
          targetApp = (fm && fm.app) || a.parameters.name || a.parameters.title || targetApp;
        }
        outcomes.push(`${a.module}.${a.action}(${brief(a.parameters)}) -> ok ${brief(r.result)}`);
        continue;
      }
      if (r.unreachable) return helperGone(r.error);
      const fe = friendlyError(r.error);
      emit(fe.kind, fe.text, fe.kind === 'error' ? 'err' : 'muted', r.error);
      // Missing permission is not something the model can work around.
      if (/Accessibility permission/i.test(r.error)) return { success: false, result: r.error };
      if (r.denied) return { success: false, result: `Stopped: you declined ${a.module}.${a.action}.` };
      outcomes.push(`${a.module}.${a.action}(${brief(a.parameters)}) -> FAILED: ${r.error}`);
      break;   // the rest of this turn was planned assuming this worked
    }
    if (interrupted) outcomes.push('(paused by the user; the rest of this turn was not run)');
    history.push(`${thought} => ${outcomes.join('; ')}`);
    failuresInRow = outcomes.some((o) => o.includes('FAILED')) ? failuresInRow + 1 : 0;
    if (failuresInRow >= config.maxFailuresInRow) return { success: false, result: 'Kept failing: ' + outcomes[outcomes.length - 1] };

    await sleep(config.settleMs, { signal, isAborted });
  }
  return { success: false, result: `Stopped after ${config.maxSteps} steps without finishing.` };
}
