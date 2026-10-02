import { convertLists, domainsToFilters } from './convert.js';
import { PRIORITY } from './dnr-rules.js';
import { parseGenericCss } from './cosmetic-filters.js';
import { createCosmeticInjector } from './cosmetic-inject.js';
import { createListStore, refreshLists, isStale } from './updater.js';
import { NEVER_BLOCK } from './sources.js';
import { neuterRules } from './neuter.js';

const ALARM = 'grol-adblock-refresh';
const INSTALLED_KEY = 'adblock.installed';
const MAX_INVALID_RULE_RETRIES = 50;

const hash = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export function neverBlockRules(extensionId) {
  const allow = (condition) => ({ priority: PRIORITY.neverBlock, action: { type: 'allow' }, condition });
  return [allow({ requestDomains: NEVER_BLOCK }), ...(extensionId ? [allow({ initiatorDomains: [extensionId] })] : [])];
}

export function composeRules({ lists, curated = [], neuter = [], extensionId, maxRules = 30000, maxRegexRules = 1000 }) {
  let regex = 0;
  const all = [...neverBlockRules(extensionId), ...neuter, ...curated, ...lists].filter((r) => !r.condition.regexFilter || ++regex <= maxRegexRules);
  return all.slice(0, maxRules).map((rule, i) => ({ ...rule, id: i + 1 }));
}

export async function replaceDynamicRules(dnr, rules, protectedCount = 0) {
  let addRules = rules;
  if (dnr.isRegexSupported) {
    const checks = await Promise.all(addRules.map((r) => (r.condition.regexFilter
      ? dnr.isRegexSupported({ regex: r.condition.regexFilter, isCaseSensitive: !!r.condition.isUrlFilterCaseSensitive }).then((x) => x.isSupported, () => false)
      : true)));
    addRules = addRules.filter((_, i) => checks[i]);
  }
  const removeRuleIds = (await dnr.getDynamicRules()).map((r) => r.id);
  for (let attempt = 0; ; attempt++) {
    try {
      await dnr.updateDynamicRules({ removeRuleIds, addRules });
      return addRules.length;
    } catch (err) {
      const bad = Number((/rule with id (\d+)/i.exec(String(err && err.message)) || [])[1]);
      if (!bad || bad <= protectedCount || attempt >= MAX_INVALID_RULE_RETRIES) throw err;
      addRules = addRules.filter((r) => r.id !== bad);
    }
  }
}

function bundleFrom(getURL) {
  const get = (path) => fetch(getURL(path)).then((res) => {
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  });
  return {
    meta: () => get('adblock/lists/meta.json').then((r) => r.json()),
    rules: () => get('adblock/lists/rules.json').then((r) => r.json()),
    cosmetic: () => get('adblock/lists/cosmetic.json').then((r) => r.json()),
    generic: () => get('adblock/lists/generic.css').then((r) => r.text()).then(parseGenericCss),
    curated: () => Promise.all([get('adblock/domains.txt'), get('adblock/exceptions.txt')].map((p) => p.then((r) => r.text())))
      .then(([domains, exceptions]) => `${exceptions}\n${domainsToFilters(domains)}`)
  };
}

export function createAdblocker({
  dnr = chrome.declarativeNetRequest,
  storage = chrome.storage.local,
  alarms = chrome.alarms,
  onMessage = chrome.runtime.onMessage,
  insertCSS = (details) => chrome.scripting.insertCSS(details),
  extensionId = chrome.runtime.id,
  bundle = bundleFrom((p) => chrome.runtime.getURL(p)),
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  logger = console
} = {}) {
  const store = createListStore({ storage, bundle });
  const limits = { maxRules: dnr.MAX_NUMBER_OF_DYNAMIC_RULES || 30000, maxRegexRules: dnr.MAX_NUMBER_OF_REGEX_RULES || 1000 };
  let lists = store.current();
  let curated = null;
  let refreshing = null;
  let started = null;
  const injector = createCosmeticInjector({ loadCosmetic: () => lists.then((l) => l.cosmetic()), insertCSS, extensionId });

  async function install(meta, loadRules) {
    curated ||= bundle.curated().then((text) => ({ hash: hash(text), rules: convertLists([{ id: 'grol', text }]).rules }));
    const { hash: curatedHash, rules: curatedRules } = await curated;
    const signature = `${meta.version}|${curatedHash}|${hash(JSON.stringify(neuterRules()))}|${limits.maxRules}|${extensionId}`;
    const { [INSTALLED_KEY]: installed } = await storage.get(INSTALLED_KEY);
    if (installed && installed.signature === signature) {
      const probe = await dnr.getDynamicRules({ ruleIds: [1, installed.count] });
      if (probe.length === (installed.count > 1 ? 2 : 1)) return installed.count;
    }
    const rules = composeRules({ lists: await loadRules(), curated: curatedRules, neuter: neuterRules(), extensionId, ...limits });
    const count = await replaceDynamicRules(dnr, rules, neverBlockRules(extensionId).length);
    await storage.set({ [INSTALLED_KEY]: { signature, count } });
    return count;
  }

  function refresh() {
    refreshing ||= Promise.resolve(started).catch(() => {}).then(() => refreshLists({
      store, fetchImpl, now, limits,
      apply: (data) => install(data.meta, async () => data.rules)
    })).then((data) => {
      lists = store.current();
      injector.reset();
      logger.log(`[grol] ad blocking: filter lists updated (${data.rules.length} rules)`);
    }, (err) => logger.warn(`[grol] ad blocking: list update failed, keeping the last good lists: ${err.message}`))
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    start() {
      onMessage.addListener(injector.listener);
      if (alarms) {
        alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) refresh(); });
        alarms.get(ALARM).then((a) => a || alarms.create(ALARM, { periodInMinutes: 24 * 60 })).catch(() => {});
      }
      started = lists.then((current) => install(current.meta, current.rules).then((count) => {
        if (isStale(current.meta, now())) refresh();
        return count;
      }));
      return started;
    },
    refresh,
    injector
  };
}

export async function installAdblockRules(deps) {
  return createAdblocker(deps).start();
}
