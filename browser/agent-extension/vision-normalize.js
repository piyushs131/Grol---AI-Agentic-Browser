
const NAME_KEYS = ['action', 'action_type', 'actionType', 'type', 'name', 'tool', 'command', 'operation'];
const PARAM_KEYS = ['params', 'parameters', 'args', 'arguments', 'input', 'value', 'payload', 'options', 'details'];

const ALIAS = {
  click_element: 'click', click_coords: 'click', click_at: 'click', tap: 'click',
  press_button: 'click', select: 'click', choose: 'click',
  click_label: 'click_text', click_on_text: 'click_text', click_by_text: 'click_text',
  open_url: 'navigate', goto: 'navigate', go_to: 'navigate', navigate_to: 'navigate',
  open: 'navigate', visit: 'navigate', load: 'navigate',
  input: 'type', fill: 'type', enter_text: 'type', type_text: 'type', write: 'type',
  press: 'key', keypress: 'key', press_key: 'key', send_keys: 'key',
  scroll_to: 'find_text', find: 'find_text', search_text: 'find_text',
  go_back: 'back', navigate_back: 'back', history_back: 'back',
  select_dropdown: 'select_option', choose_option: 'select_option',
  set_select: 'select_option', dropdown: 'select_option',
  slider: 'set_range', set_slider: 'set_range', drag_slider: 'set_range', range: 'set_range',
  note: 'remember', save: 'remember', store: 'remember', record: 'remember',
  memorize: 'remember', extract: 'remember', save_data: 'remember',
  new_tab: 'open_tab', open_new_tab: 'open_tab', create_tab: 'open_tab',
  select_tab: 'switch_tab', focus_tab: 'switch_tab', goto_tab: 'switch_tab',
  finish: 'done', complete: 'done', success: 'done', stop: 'done',
  human: 'ask_user', handoff: 'ask_user', ask: 'ask_user', request_user: 'ask_user',
  pause: 'wait', sleep: 'wait'
};

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
  return undefined;
}

function markNumber(v) {
  const n = num(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function coord(v) {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

export function webUrl(value) {
  const s = String(value ?? '').trim();
  if (!s || /\s/.test(s)) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|file|blob|about|chrome|view-source|vbscript):/i.test(s);
  const candidate = hasScheme ? s : 'https://' + s.replace(/^\/\//, '');
  try {
    const u = new URL(candidate);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return '';
    if (!hasScheme && !/\.|^localhost$/i.test(u.hostname)) return '';
    return u.href;
  } catch (_) {
    return '';
  }
}

function str(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function findActionName(raw) {
  let node = raw;
  let params = {};
  let name = null;
  for (let depth = 0; depth < 3 && node && typeof node === 'object'; depth++) {
    for (const pk of PARAM_KEYS) {
      if (node[pk] && typeof node[pk] === 'object' && !Array.isArray(node[pk])) {
        params = { ...node[pk], ...params };
      }
    }
    let descended = false;
    for (const nk of NAME_KEYS) {
      const v = node[nk];
      if (typeof v === 'string' && v.trim()) { name = v; break; }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        params = { ...params, ...v };
        node = v;
        descended = true;
        break;
      }
    }
    if (name || !descended) break;
  }
  return { name, params };
}

export function readObservation(raw) {
  const o = (raw && typeof raw.observation === 'object' && raw.observation) ||
            (raw && typeof raw.page === 'object' && raw.page) || {};
  const line = (v) => (typeof v === 'string' ? v.trim().slice(0, 240) : '');
  const pageLine = line(o.page ?? o.summary ?? o.description) ||
                   (typeof raw?.page === 'string' ? line(raw.page) : '');
  const rawState = String(o.state ?? o.page_state ?? o.status ?? '').toLowerCase().trim();
  const STATES = ['ok', 'blocked', 'unavailable', 'error', 'login', 'captcha', 'loading', 'empty'];
  const state = STATES.find(s => rawState === s) ||
                STATES.find(s => rawState.includes(s)) || 'ok';
  const blocker = line(o.blocker ?? o.blockers ?? o.blocked_by);
  return {
    page: pageLine,
    state,
    blocker: blocker && !/^(none|null|no|n\/a|nothing)$/i.test(blocker) ? blocker : '',
    progress: line(o.progress ?? o.goal_progress ?? o.next),
    planStep: (() => {
      const n = parseInt(o.plan_step ?? o.planStep ?? o.step, 10);
      return Number.isInteger(n) && n > 0 ? n : 0;
    })()
  };
}

const KNOWN_ACTIONS = new Set(['click', 'click_text', 'type', 'select_option', 'set_range', 'scroll', 'navigate',
  'back', 'key', 'find_text', 'wait', 'remember', 'open_tab', 'switch_tab', 'done', 'ask_user']);

const GUESSES = [
  [/scroll/, 'scroll'],
  [/(^|_)(type|input|enter_text|fill|write)|^search|search_(bar|box|field)|into_/, 'type'],
  [/navigat|go_?to|open_(url|page|site|website)|visit|load_url/, 'navigate'],
  [/new_tab/, 'open_tab'],
  [/(^|_)back($|_)/, 'back'],
  [/click|press_(button|link)|tap|choose|select_(link|button|item|result)/, 'click'],
  [/select|dropdown|option/, 'select_option'],
  [/press|key/, 'key'],
  [/wait|sleep|pause/, 'wait'],
  [/remember|note|save_fact/, 'remember'],
  [/(^|_)(done|finish|complete|answer)/, 'done']
];

export function guessAction(name) {
  const n = String(name || '').toLowerCase();
  const hit = GUESSES.find(([re]) => re.test(n));
  return hit ? hit[1] : null;
}

export function normalizeAction(raw) {
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw || typeof raw !== 'object') throw new Error('AI response was not an object');

  const observation = readObservation(raw);

  if (!findActionName(raw).name) {
    for (const listKey of ['actions', 'steps', 'plan']) {
      const first = Array.isArray(raw[listKey]) ? raw[listKey][0] : undefined;
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        raw = { ...first, reasoning: raw.reasoning || first.reasoning };
        break;
      }
      if (typeof first === 'string' && first.trim()) {
        raw = { action: first, reasoning: raw.reasoning };
        break;
      }
    }
  }

  const { name, params } = findActionName(raw);
  if (!name) throw new Error('AI response has no action name: ' + JSON.stringify(raw).slice(0, 160));

  const src = { ...params, ...raw };

  const action = {
    action: String(name).toLowerCase().trim().replace(/[\s-]+/g, '_'),
    observation,
    page: observation.page,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 400)
             : (typeof src.reasoning === 'string' ? src.reasoning.slice(0, 400) : '')
  };

  if (ALIAS[action.action]) action.action = ALIAS[action.action];
  if (!KNOWN_ACTIONS.has(action.action)) {
    const invented = action.action;
    action.action = guessAction(invented) || invented;
    const word = /(enter|escape|tab|backspace)/.exec(invented);
    if (action.action === 'key' && word && src.key === undefined) src.key = word[1][0].toUpperCase() + word[1].slice(1);
    const dir = /(up|down|left|right)/.exec(invented);
    if (action.action === 'scroll' && dir && src.direction === undefined) src.direction = dir[1];
  }

  const mark = () => markNumber(src.mark ?? src.index ?? src.element ?? src.element_id ?? src.elementId ?? src.id ?? src.number);

  switch (action.action) {
    case 'click':
      action.mark = mark();
      action.x = coord(src.x ?? src.left);
      action.y = coord(src.y ?? src.top);
      action.text = str(src.text, src.label, src.element_text, src.target);
      if (action.mark === undefined && (action.x === undefined || action.y === undefined)) {
        if (action.text) { action.action = 'click_text'; break; }
        throw new Error('click needs a mark, x/y, or text');
      }
      break;
    case 'click_text':
      action.text = str(src.text, src.label, src.element_text, src.target, src.name);
      if (!action.text) throw new Error('click_text needs the label to click');
      break;
    case 'type':
      action.mark = mark();
      action.x = coord(src.x);
      action.y = coord(src.y);
      action.text = str(src.text, src.value, src.query, src.content, src.keys);
      action.submit = src.submit === true || src.press_enter === true ||
                      src.enter === true || /\n$/.test(action.text);
      action.text = action.text.replace(/\n+$/, '');
      if (!action.text) throw new Error('type needs text');
      break;
    case 'select_option':
      action.mark = mark();
      action.text = str(src.text, src.option, src.value, src.label, src.choice);
      if (action.mark === undefined) throw new Error('select_option needs a mark');
      if (!action.text) throw new Error('select_option needs the option text');
      break;
    case 'set_range': {
      action.mark = mark();
      const rawV = src.value ?? src.to ?? src.amount ?? src.price ?? src.text;
      const v = num(rawV) ?? num(String(rawV ?? '').replace(/[^0-9.]/g, ''));
      if (v === undefined || v === null || !isFinite(v)) throw new Error('set_range needs a numeric value');
      action.value = v;
      action.bound = /min|low|from/i.test(String(src.bound ?? src.which ?? src.handle ?? '')) ? 'min' : 'max';
      break;
    }
    case 'scroll':
      action.direction = ['up', 'down', 'left', 'right']
        .includes(String(src.direction).toLowerCase())
        ? String(src.direction).toLowerCase() : 'down';
      action.amount = Math.min(2000, Math.max(120, num(src.amount ?? src.pixels ?? src.distance) ?? 600));
      {
        const mark = num(src.mark ?? src.within ?? src.panel);
        if (mark !== undefined && Number.isInteger(mark) && mark > 0) action.mark = mark;
      }
      break;
    case 'navigate':
      action.url = webUrl(str(src.url, src.href, src.link, src.address));
      if (!action.url) throw new Error('navigate needs an http(s) url');
      break;
    case 'back':
      break;
    case 'key':
      action.key = str(src.key, src.keyCode, src.key_code) || 'Enter';
      break;
    case 'find_text':
      action.text = str(src.text, src.query, src.target).trim();
      if (!action.text) throw new Error('find_text needs text');
      break;
    case 'wait':
      action.ms = Math.min(8000, Math.max(300, num(src.ms ?? src.duration ?? src.timeout ?? src.seconds * 1000) ?? 1200));
      break;
    case 'remember':
      action.note = str(src.note, src.text, src.fact, src.data, src.value, src.content);
      if (!action.note) throw new Error('remember needs a note');
      action.note = action.note.slice(0, 1500);
      break;
    case 'open_tab':
      action.url = webUrl(str(src.url, src.href, src.link));
      if (!action.url) throw new Error('open_tab needs an http(s) url');
      break;
    case 'switch_tab':
      action.index = num(src.index ?? src.tab ?? src.tabIndex ?? src.n);
      if (action.index === undefined) throw new Error('switch_tab needs a tab index');
      break;
    case 'done':
      action.summary = str(src.summary, src.reason, src.result, src.message, action.reasoning, observation.progress) || 'Task complete';
      break;
    case 'ask_user':
      action.question = str(src.question, src.reason, src.message, src.prompt) ||
                        'Please complete this step manually.';
      break;
    default:
      throw new Error('Unknown action: ' + action.action);
  }
  return action;
}
