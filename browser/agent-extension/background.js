import './build.js';
import VisionAgent from './vision-agent.js';
import { CdpPageTarget } from './cdp-page-target.js';
import { OsTaskController } from './os-task.js';
import { createMessageListener } from './message-router.js';
import { resetGeminiLadder } from './gemini-models.js';
import { getApiKey, getAiSettings, saveApiKey, apiKeyProblem } from './settings.js';
import { checkCredential, resolveProvider, registerCredential, resetProviders, PROVIDERS } from './llm-providers.js';
import { installAdblockRules } from './adblock/network.js';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const MAX_GOAL_CHARS = 4000;

(async function checkFreshWorker() {
  try {
    const text = await (await fetch(chrome.runtime.getURL('build.js'), { cache: 'no-store' })).text();
    const onDisk = (text.match(/GROL_BUILD = '([^']*)'/) || [])[1];
    if (onDisk && onDisk !== self.GROL_BUILD) {
      console.warn(`[grol] stale service worker (${self.GROL_BUILD} vs ${onDisk}) - launch with browser/scripts/run.sh`);
    }
  } catch (_) {}
})();

installAdblockRules()
  .then((n) => console.log(`[grol] ad blocking: ${n} rule(s) active`))
  .catch((err) => console.warn('[grol] ad blocking unavailable: ' + err.message));

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

chrome.debugger.onDetach.addListener((source) => {
  const t = agent && agent.target;
  if (t && source.tabId === t.tabId) {
    t._attached = false;
    logger.warn(`[PageTarget] debugger detached from tab ${source.tabId}`);
  }
});

const HOME = 'chrome://newtab/';
async function openHome() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.some((x) => /^chrome:\/\/newtab\/?$/.test(x.url || ''))) return;
  const blank = tabs.find((x) => /^chrome:\/\/new-tab-page/.test(x.url || '') || /^chrome-error:/.test(x.url || ''));
  if (blank) await chrome.tabs.update(blank.id, { url: HOME });
  else await chrome.tabs.create({ url: HOME, active: true });
}
const openHomeQuietly = () => openHome().catch((e) => logger.warn('[background] openHome: ' + e.message));
chrome.runtime.onStartup.addListener(openHomeQuietly);
chrome.runtime.onInstalled.addListener(openHomeQuietly);

chrome.storage.session.get(['homeOpened']).then(async (st) => {
  if (st.homeOpened) return;
  await chrome.storage.session.set({ homeOpened: true });
  await openHomeQuietly();
}).catch(() => {});

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'open-agent') return;
  const open = (windowId) => chrome.sidePanel.open({ windowId }).catch(() => {});
  if (tab && tab.windowId != null) open(tab.windowId);
  else chrome.windows.getLastFocused().then((w) => w && open(w.id)).catch(() => {});
});

const osTasks = new OsTaskController({
  logger,
  send: (msg) => chrome.runtime.sendMessage(msg),
  storage: {
    get: async (key) => (await chrome.storage.session.get([key]))[key],
    set: (key, value) => chrome.storage.session.set({ [key]: value })
  },
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

let agentStartQueue = Promise.resolve();

export const handlers = {
  'agent:start': async (msg) => {
    const goal = goalOf(msg.goal);
    if (!goal) return { ok: false, error: 'Give the agent something to do' };
    const keyProblem = apiKeyProblem(await getApiKey());
    if (keyProblem) return { ok: false, needsKey: true, error: keyProblem };
    const run = agentStartQueue.then(() => getAgent().startTask(goal));
    agentStartQueue = run.catch(() => {});
    return asReply(await run);
  },
  'agent:pause': () => asReply(getAgent().pauseTask()),
  'agent:resume': () => asReply(getAgent().resumeTask()),
  'agent:user-done': () => asReply(getAgent().resumeAfterUserAction()),
  'agent:stop': () => asReply(getAgent().abortTask()),
  'agent:snapshot': () => agentSnapshot(getAgent()),
  'settings:get': async () => ({ ok: true, ...(await getAiSettings()),
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, local: !!p.local, keyUrl: p.keyUrl || '',
      baseUrl: p.baseUrl || '', models: p.models || [] })) }),
  'settings:needed': () => ({ ok: true }),
  'settings:save': async (msg) => {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const apiKey = str(msg.apiKey);
    const opts = { provider: str(msg.provider) || 'auto', baseUrl: str(msg.baseUrl), model: str(msg.model) };
    if (opts.provider !== 'auto' && !PROVIDERS[opts.provider]) return { ok: false, error: 'Unknown AI provider.' };
    const problem = apiKeyProblem(apiKey, opts);
    if (problem) return { ok: false, error: problem };
    const local = PROVIDERS[opts.provider] && PROVIDERS[opts.provider].local;
    const probeKey = apiKey || (local || opts.provider === 'custom' ? `local:${opts.provider}` : '');
    registerCredential(probeKey, { provider: opts.provider === 'auto' ? '' : opts.provider, baseUrl: opts.baseUrl, model: opts.model });
    const label = resolveProvider(probeKey).label;
    const check = await checkCredential(probeKey);
    if (check === 'invalid') return { ok: false, error: `${label} rejected this key. Copy it again from your ${label} account.` };
    await saveApiKey(apiKey, opts);
    resetGeminiLadder();
    resetProviders();
    return { ok: true, verified: check === 'valid', provider: label };
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
