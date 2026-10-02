import { listModels } from './gemini-fetch-client.js';

const CACHE_MS = 60 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 1000;

export const STATIC_STRONG = ['models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-3.6-flash',
  'models/gemini-flash-latest', 'models/gemini-3.5-flash', 'models/gemini-3-flash-preview'];
export const STATIC_LITE = ['models/gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite', 'models/gemini-flash-lite-latest'];

const FLASH = /^models\/gemini-(?:(\d+(?:\.\d+)?)-)?flash(-lite)?(?:-(latest|preview))?$/;

const EMPTY = { key: null, expires: 0, strong: null, lite: null };
let cache = EMPTY;
let inflight = null;
let generation = 0;

function rank(name) {
  const m = name.match(FLASH);
  const version = m && m[1] ? parseFloat(m[1]) : -1;
  return [version, m && m[3] === 'preview' ? 0 : 1];
}

function byRank(a, b) {
  const [va, sa] = rank(a);
  const [vb, sb] = rank(b);
  return vb - va || sb - sa || a.localeCompare(b);
}

export function rankModels(models) {
  const names = [...new Set((models || [])
    .filter((m) => m && (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name))
    .filter((n) => FLASH.test(n)))];
  return {
    strong: names.filter((n) => !n.includes('-lite')).sort(byRank),
    lite: names.filter((n) => n.includes('-lite')).sort(byRank)
  };
}

async function discover(key) {
  const ranked = rankModels(await listModels(key));
  if (!ranked.strong.length && !ranked.lite.length) throw new Error('no Flash models on this key');
  return ranked;
}

async function refresh(key) {
  const gen = generation;
  try {
    const found = await discover(key);
    if (gen === generation) cache = { key, expires: Date.now() + CACHE_MS, ...found };
  } catch (err) {
    if (err && err.kind === 'auth') throw err;
    if (gen !== generation) return;
    const keep = cache.key === key && cache.strong;
    cache = keep
      ? { ...cache, expires: Date.now() + FAILED_RETRY_MS }
      : { key, expires: Date.now() + FAILED_RETRY_MS, strong: STATIC_STRONG, lite: STATIC_LITE };
  }
}

export async function geminiLadder(apiKey) {
  const key = String(apiKey || '').trim();
  if (cache.key !== key || Date.now() >= cache.expires || !cache.strong) {
    if (!inflight || inflight.key !== key) {
      const promise = refresh(key).finally(() => { if (inflight && inflight.promise === promise) inflight = null; });
      inflight = { key, promise };
    }
    await inflight.promise;
  }
  if (cache.key !== key || !cache.strong) return [...STATIC_STRONG, ...STATIC_LITE];
  return [...cache.strong, ...cache.lite];
}

export function resetGeminiLadder() {
  cache = EMPTY;
  inflight = null;
  generation++;
}

export const ladderGeneration = () => generation;

export async function checkApiKey(apiKey, { timeoutMs = 8000 } = {}) {
  try {
    await listModels(apiKey, { timeoutMs });
    return 'valid';
  } catch (err) {
    return err && err.kind === 'auth' ? 'invalid' : 'unknown';
  }
}
