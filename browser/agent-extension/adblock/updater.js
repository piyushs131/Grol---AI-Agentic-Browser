import { convertLists } from './convert.js';
import { withRuntimeGeneric } from './cosmetic-filters.js';
import { LISTS } from './sources.js';

export const REFRESH_MS = 24 * 60 * 60 * 1000;
const KEYS = { meta: 'adblock.meta', rules: 'adblock.rules', cosmetic: 'adblock.cosmetic' };
const MIN_RULES = 1000;
const MIN_LIST_CHARS = 1000;

export function createListStore({ storage, bundle }) {
  async function newest() {
    const [{ [KEYS.meta]: stored }, bundled] = await Promise.all([storage.get(KEYS.meta), bundle.meta()]);
    return stored && stored.fetchedAt > bundled.fetchedAt ? { meta: stored, stored: true } : { meta: bundled, stored: false };
  }
  const read = async (key) => (await storage.get(key))[key];
  return {
    async current() {
      const { meta, stored } = await newest();
      return {
        meta,
        rules: () => (stored ? read(KEYS.rules) : bundle.rules()),
        cosmetic: () => (stored ? read(KEYS.cosmetic) : bundle.cosmetic())
      };
    },
    save: ({ meta, rules, cosmetic }) => storage.set({ [KEYS.meta]: meta, [KEYS.rules]: rules, [KEYS.cosmetic]: cosmetic }),
    bundledGeneric: () => bundle.generic()
  };
}

async function download(fetchImpl, { id, url }) {
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < MIN_LIST_CHARS || /^\s*</.test(text)) throw new Error(`${id}: not a filter list`);
  return { id, text };
}

export async function refreshLists({ store, apply, fetchImpl = fetch, now = Date.now, limits, lists = LISTS }) {
  const texts = await Promise.all(lists.map((l) => download(fetchImpl, l)));
  const converted = convertLists(texts, limits);
  if (converted.rules.length < MIN_RULES) throw new Error(`only ${converted.rules.length} rules converted`);
  const cosmetic = withRuntimeGeneric(converted.cosmetic, converted.generic, await store.bundledGeneric());
  const data = { meta: { fetchedAt: now(), version: `fetched-${now()}`, stats: converted.stats }, rules: converted.rules, cosmetic };
  await apply(data);
  await store.save(data);
  return data;
}

export const isStale = (meta, now = Date.now()) => !meta || !(now - meta.fetchedAt < REFRESH_MS);
