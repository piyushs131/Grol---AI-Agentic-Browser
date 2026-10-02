import { parseFilter } from './filter-parser.js';
import { buildRules } from './dnr-rules.js';
import { buildCosmetic } from './cosmetic-filters.js';

const bump = (counts, key, n = 1) => { counts[key] = (counts[key] || 0) + n; };

export function domainsToFilters(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((d) => `||${d}^$third-party`).join('\n');
}

function cosmeticHosts(filter) {
  if (filter.include.length) return filter.include;
  const host = /^\|\|([a-z0-9.-]+)(?:[\^/]|$)/.exec(filter.pattern.toLowerCase());
  return host ? [host[1]] : [];
}

export function convertLists(lists, limits = {}) {
  const network = [];
  const cosmetic = [];
  const hosts = { elemhide: [], generichide: [] };
  const perList = {};
  lists.forEach(({ id, text }, rank) => {
    const stats = { network: 0, cosmetic: 0, skipped: {} };
    perList[id] = stats;
    for (const line of text.split('\n')) {
      const f = parseFilter(line);
      if (f.kind === 'comment') continue;
      if (f.kind === 'skip') { bump(stats.skipped, f.reason); continue; }
      if (f.kind === 'cosmetic') { stats.cosmetic++; cosmetic.push(f); continue; }
      if (f.cosmetic) {
        const named = cosmeticHosts(f);
        if (!named.length) { bump(stats.skipped, 'cosmetic-option'); continue; }
        hosts[f.cosmetic].push(...named);
        stats.cosmetic++;
        continue;
      }
      if (f.exception && f.types.includes('main_frame')) hosts.elemhide.push(...cosmeticHosts(f));
      stats.network++;
      network.push({ ...f, rank });
    }
  });
  const { rules, dropped, regexCount } = buildRules(network, limits);
  const built = buildCosmetic(cosmetic, hosts);
  return {
    rules,
    generic: built.generic,
    cosmetic: built.cosmetic,
    stats: {
      lists: perList,
      rules: rules.length,
      regexRules: regexCount,
      droppedRules: dropped,
      genericSelectors: built.generic.length,
      siteSelectorHosts: Object.keys(built.cosmetic.specific).length,
      cosmeticSkipped: built.skipped
    }
  };
}
