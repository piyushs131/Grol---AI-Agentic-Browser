
export const GENERIC_KEY = '*';
const HIDE = '{display:none!important}';
const CHUNK = 100;

function entry(map, host) {
  if (!map[host]) map[host] = { hide: new Set(), unhide: new Set() };
  return map[host];
}

export function buildCosmetic(filters, hosts = {}) {
  const generic = new Set();
  const globalUnhide = new Set();
  const unhidden = new Set();
  const map = {};
  for (const { selector, exception, include, exclude } of filters) {
    if (exception) {
      if (!include.length) { if (!exclude.length) globalUnhide.add(selector); continue; }
      for (const host of include) entry(map, host).unhide.add(selector);
      unhidden.add(selector);
      continue;
    }
    if (include.length) for (const host of include) entry(map, host).hide.add(selector);
    else generic.add(selector);
    for (const host of exclude) entry(map, host).unhide.add(selector);
    if (exclude.length) unhidden.add(selector);
  }

  const staticGeneric = [];
  const runtimeGeneric = [];
  let costly = 0;
  for (const selector of generic) {
    if (globalUnhide.has(selector)) continue;
    if (selector.includes(':has(')) costly++;
    else (unhidden.has(selector) ? runtimeGeneric : staticGeneric).push(selector);
  }
  const specific = {};
  if (runtimeGeneric.length) specific[GENERIC_KEY] = { hide: runtimeGeneric.sort() };
  for (const host of Object.keys(map).sort()) {
    const hide = [...map[host].hide].filter((s) => !globalUnhide.has(s)).sort();
    const unhide = [...map[host].unhide].sort();
    if (hide.length || unhide.length) specific[host] = { ...(hide.length && { hide }), ...(unhide.length && { unhide }) };
  }
  return {
    generic: staticGeneric.sort(),
    cosmetic: {
      specific,
      elemhide: [...new Set(hosts.elemhide || [])].sort(),
      generichide: [...new Set(hosts.generichide || [])].sort()
    },
    skipped: costly ? { 'generic-has': costly } : {}
  };
}

export function genericCss(selectors) {
  const chunks = [];
  for (let i = 0; i < selectors.length; i += CHUNK) chunks.push(selectors.slice(i, i + CHUNK).join(',\n') + HIDE);
  return chunks.join('\n') + '\n';
}

export function parseGenericCss(css) {
  return css.split(HIDE).flatMap((chunk) => chunk.split(',\n')).map((s) => s.trim()).filter(Boolean);
}

export function hostChain(hostname) {
  const chain = [];
  for (let h = hostname.toLowerCase().replace(/\.$/, ''); h; h = h.slice(h.indexOf('.') + 1)) {
    chain.push(h);
    if (!h.includes('.')) break;
  }
  return chain;
}

function entityKeys(chain) {
  const keys = [];
  for (const host of chain) {
    const labels = host.split('.');
    for (const suffix of [1, 2]) if (labels.length > suffix) keys.push(labels.slice(0, -suffix).join('.') + '.*');
  }
  return keys;
}

export function createCosmeticLookup(cosmetic) {
  const specific = cosmetic.specific || {};
  const elemhide = new Set(cosmetic.elemhide || []);
  const generichide = new Set(cosmetic.generichide || []);
  return (hostname) => {
    const chain = hostChain(hostname);
    if (chain.some((h) => elemhide.has(h))) return [];
    const hide = new Set();
    const unhide = new Set();
    const sources = [...chain, ...entityKeys(chain)];
    if (!chain.some((h) => generichide.has(h))) sources.push(GENERIC_KEY);
    for (const host of sources) {
      const e = specific[host];
      if (!e) continue;
      for (const s of e.hide || []) hide.add(s);
      for (const s of e.unhide || []) unhide.add(s);
    }
    return [...hide].filter((s) => !unhide.has(s));
  };
}

export const hidingCss = (selectors) => selectors.map((s) => s + HIDE).join('\n');

export const excludeMatchesFor = (hosts) => hosts.map((h) => `*://*.${h}/*`);

export function withRuntimeGeneric(cosmetic, fresh, bundled) {
  const known = new Set(bundled);
  const added = fresh.filter((s) => !known.has(s));
  if (!added.length) return cosmetic;
  const hide = [...new Set([...(cosmetic.specific[GENERIC_KEY]?.hide || []), ...added])].sort();
  return { ...cosmetic, specific: { ...cosmetic.specific, [GENERIC_KEY]: { hide } } };
}
