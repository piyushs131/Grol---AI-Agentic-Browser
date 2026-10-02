
export const PRIORITY = { block: 1, allow: 2, important: 3, neverBlock: 100 };
export const DEFAULT_LIMITS = { maxRules: 30000, maxRegexRules: 1000 };
const DOMAINS_PER_RULE = 5000;

function conditionFor(filter) {
  const condition = {};
  if (filter.party) condition.domainType = filter.party;
  if (filter.include.length) condition.initiatorDomains = [...new Set(filter.include)].sort();
  if (filter.exclude.length) condition.excludedInitiatorDomains = [...new Set(filter.exclude)].sort();
  if (filter.exception && filter.types.includes('main_frame')) {
    condition.resourceTypes = ['main_frame', 'sub_frame'];
  } else if (filter.types.length) {
    condition.resourceTypes = [...new Set(filter.types)].sort();
  } else if (filter.excludedTypes.length) {
    condition.excludedResourceTypes = [...new Set([...filter.excludedTypes, 'main_frame'])].sort();
  }
  if (filter.matchCase) condition.isUrlFilterCaseSensitive = true;
  return condition;
}

function actionFor(filter) {
  if (!filter.exception) return { type: 'block' };
  return { type: filter.types.includes('main_frame') ? 'allowAllRequests' : 'allow' };
}

function priorityFor(filter) {
  if (filter.exception) return PRIORITY.allow;
  return filter.important ? PRIORITY.important : PRIORITY.block;
}

function withoutSubdomains(domains) {
  const set = new Set(domains);
  return [...set].filter((d) => {
    for (let i = d.indexOf('.'); i >= 0; i = d.indexOf('.', i + 1)) {
      if (set.has(d.slice(i + 1))) return false;
    }
    return true;
  }).sort();
}

export function buildRules(filters, limits = {}) {
  const { maxRules, maxRegexRules } = { ...DEFAULT_LIMITS, ...limits };
  const groups = new Map();
  const singles = new Map();
  for (const f of filters) {
    const base = { priority: priorityFor(f), action: actionFor(f), condition: conditionFor(f) };
    if (f.domain && !f.matchCase) {
      const key = JSON.stringify(base);
      if (!groups.has(key)) groups.set(key, { base, domains: [], rank: f.rank });
      const group = groups.get(key);
      group.domains.push(f.domain);
      group.rank = Math.min(group.rank, f.rank);
      continue;
    }
    const condition = f.regex ? { regexFilter: f.regex, ...base.condition } : { ...(f.pattern ? { urlFilter: f.pattern } : {}), ...base.condition };
    const rule = { ...base, condition };
    const key = JSON.stringify(rule);
    const known = singles.get(key);
    const cost = (f.regex || f.pattern).length + (f.include.length ? 1000 : 0);
    if (!known || known.rank > f.rank) singles.set(key, { rule, key, rank: f.rank, exception: f.exception, regex: !!f.regex, cost });
  }

  const grouped = [];
  for (const { base, domains, rank } of groups.values()) {
    const kept = withoutSubdomains(domains);
    for (let i = 0; i < kept.length; i += DOMAINS_PER_RULE) {
      const rule = { ...base, condition: { requestDomains: kept.slice(i, i + DOMAINS_PER_RULE), ...base.condition } };
      grouped.push({ rule, key: JSON.stringify(rule), rank, exception: base.action.type !== 'block', cost: 0 });
    }
  }
  const byValue = (a, b) => (a.rank - b.rank) || (a.cost - b.cost) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const exceptions = [...grouped, ...singles.values()].filter((r) => r.exception).sort(byValue);
  const blocks = grouped.filter((r) => !r.exception).sort(byValue);
  const paths = [...singles.values()].filter((r) => !r.exception).sort(byValue);

  const kept = [];
  const dropped = { budget: 0, regex: 0 };
  let regexCount = 0;
  for (const entry of [...exceptions, ...blocks, ...paths]) {
    if (entry.regex && regexCount >= maxRegexRules) { dropped.regex++; continue; }
    if (kept.length >= maxRules) { dropped.budget++; continue; }
    if (entry.regex) regexCount++;
    kept.push(entry.rule);
  }
  return { rules: kept.map((rule, i) => ({ id: i + 1, ...rule })), dropped, regexCount };
}
