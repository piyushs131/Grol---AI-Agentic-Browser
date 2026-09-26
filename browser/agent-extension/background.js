// Service worker: hosts the browser agent (vision-agent.js over CDP) and the
// OS Control task, and answers messages from the side panel and new-tab page.
import './build.js';
import VisionAgent from './vision-agent.js';
import { CdpPageTarget } from './cdp-page-target.js';
import { OsTaskController } from './os-task.js';
import { createMessageListener } from './message-router.js';
import { resetGeminiLadder, checkApiKey } from './gemini-models.js';
import { getApiKey, saveApiKey, apiKeyProblem } from './settings.js';

const MAX_GOAL_CHARS = 4000;

// The browser keeps the service worker it registered earlier, even across
// restarts, so edited background code can silently never run. run.sh clears
// the cached registration whenever the extension's code changes; this only
// reports a mismatch if that was bypassed. Never chrome.runtime.reload() here:
// for a --load-extension extension that leaves it unloaded until a restart.
(async function checkFreshWorker() {
  try {
    const text = await (await fetch(chrome.runtime.getURL('build.js'), { cache: 'no-store' })).text();
    const onDisk = (text.match(/GROL_BUILD = '([^']*)'/) || [])[1];
    if (onDisk && onDisk !== self.GROL_BUILD) {
      console.warn(`[grol] stale service worker (${self.GROL_BUILD} vs ${onDisk}) - launch with browser/scripts/run.sh`);
    }
  } catch (_) {}
})();

const logger = {
  info:  (m) => console.log(String(m)),
  warn:  (m) => console.warn(String(m)),
  error: (m) => console.error(String(m))
};

let agent = null;

function getAgent() {
  if (!agent) agent = new VisionAgent({ logger, target: new CdpPageTarget({ logger }) });
  return agent;
}

// The browser drops the debugger on cross-process navigation or tab close. Without
// this the target goes stale silently and every later command throws.
chrome.debugger.onDetach.addListener((source) => {
  const t = agent && agent.target;
  if (t && source.tabId === t.tabId) {
    t._attached = false;
    logger.warn(`[PageTarget] debugger detached from tab ${source.tabId}`);
  }
});

// The built-in startup tab (chrome://new-tab-page) bypasses the newtab override,
// and passing the extension URL on the command line races registration, so
// open the Grol page from here once the extension can serve it.
async function openHome() {
  const url = chrome.runtime.getURL('newtab.html');
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const blank = tabs.find((x) => /^chrome:\/\/(newtab|new-tab-page)/.test(x.url || '') ||
                                 /^chrome-error:/.test(x.url || ''));
  if (blank) await chrome.tabs.update(blank.id, { url });
  else await chrome.tabs.create({ url, active: true });
}
const openHomeQuietly = () => openHome().catch((e) => logger.warn('[background] openHome: ' + e.message));
chrome.runtime.onStartup.addListener(openHomeQuietly);
chrome.runtime.onInstalled.addListener(openHomeQuietly);

// Those two events are not reliable with --load-extension: the worker can spin
// up without either firing, and the startup tab then sits on Chrome's own
// chrome://new-tab-page. Claim it on first worker start instead, guarded so
// waking later (to answer a message) never steals a tab the user is using.
chrome.storage.session.get(['homeOpened']).then(async (st) => {
  if (st.homeOpened) return;
  await chrome.storage.session.set({ homeOpened: true });
  await openHomeQuietly();
}).catch(() => {});

// Clicking the toolbar icon opens the panel on every page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const osTasks = new OsTaskController({
  logger,
  send: (msg) => chrome.runtime.sendMessage(msg),
  storage: {
    get: async (key) => (await chrome.storage.session.get([key]))[key],
    set: (key, value) => chrome.storage.session.set({ [key]: value })
  },
  // Any extension API call resets the worker's idle timer.
  keepAlive: () => {
    const timer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    return () => clearInterval(timer);
  }
});
osTasks.restore().catch(() => {});

function agentSnapshot(a) {
  const task = a.task || null;
  return {
    ok: true,
    state: a.getStatus().state || 'idle',
    goal: (task && task.goal) || '',
    planIndex: (task && task.planIndex) || 0,
    plan: (task && task.plan) || [],
    log: ((task && task.steps) || []).map((x) => ({ tag: 'step', text: `${x.summary || ''} — ${x.outcome || ''}` }))
  };
}

const goalOf = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_GOAL_CHARS) : '');
const asReply = (res) => ({ ok: !!(res && res.success), ...(res || {}) });

// Starts are serialised so a second click cannot race the first one's setup.
let agentStartQueue = Promise.resolve();

// The side panel is opened by the page that starts a task: sidePanel.open()
// needs a user gesture, which does not survive the message hop to here.
export const handlers = {
  'agent:start': async (msg) => {
    const goal = goalOf(msg.goal);
    if (!goal) return { ok: false, error: 'Give the agent something to do' };
    const run = agentStartQueue.then(() => getAgent().startTask(goal));
    agentStartQueue = run.catch(() => {});
    return asReply(await run);
  },
  'agent:pause': () => asReply(getAgent().pauseTask()),
  'agent:resume': () => asReply(getAgent().resumeTask()),
  // The user finished what the agent handed over (sign-in, OTP, captcha).
  'agent:user-done': () => asReply(getAgent().resumeAfterUserAction()),
  'agent:stop': () => asReply(getAgent().abortTask()),
  'agent:snapshot': () => agentSnapshot(getAgent()),
  'settings:get': async () => ({ ok: true, hasKey: !!(await getApiKey()) }),
  'settings:save': async (msg) => {
    const apiKey = typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '';
    const problem = apiKeyProblem(apiKey);
    if (problem) return { ok: false, error: problem };
    // Checked before saving, so a typo shows up here rather than as a failed task.
    const check = await checkApiKey(apiKey);
    if (check === 'invalid') return { ok: false, error: 'Google rejected this key. Copy it again from AI Studio.' };
    await saveApiKey(apiKey);
    resetGeminiLadder();   // the new key may see different models
    return { ok: true, verified: check === 'valid' };
  },
  'os:run': async (msg) => {
    const text = goalOf(msg.text);
    if (!text) return { ok: false, error: 'Say what to do on the computer' };
    return { ok: true, taskId: await osTasks.start(text, await getApiKey()) };
  },
  'os:stop': () => ({ ok: osTasks.stop() }),
  'os:pause': () => ({ ok: osTasks.pause() }),
  'os:resume': () => ({ ok: osTasks.resume() }),
  'os:snapshot': () => ({ ok: true, task: osTasks.snapshot() }),
  'os:confirm-answer': (msg) => ({ ok: osTasks.answerConfirm(msg.id, msg.allow === true) })
};

chrome.runtime.onMessage.addListener(createMessageListener(handlers, {
  id: chrome.runtime.id,
  origin: chrome.runtime.getURL(''),
  logger
}));
