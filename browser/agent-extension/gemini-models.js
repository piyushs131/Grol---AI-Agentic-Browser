// Which Gemini models to try, best first. Asked of Google rather than
// hard-coded, because Google retires models (404) and ships new ones often;
// the list is cached for an hour and a static one is used only if that fails.
import { listModels } from './gemini-fetch-client.js';

const CACHE_MS = 60 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 1000;

export const STATIC_STRONG = ['models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-3.6-flash',
  'models/gemini-flash-latest', 'models/gemini-3.5-flash', 'models/gemini-3-flash-preview'];
export const STATIC_LITE = ['models/gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite', 'models/gemini-flash-lite-latest'];

// gemini-3.6-flash, gemini-3-flash-preview, gemini-flash-latest, gemini-3.5-flash-lite...
// but not -tts, -image, omni or embedding models.
const FLASH = /^models\/gemini-(?:(\d+(?:\.\d+)?)-)?flash(-lite)?(?:-(latest|preview))?$/;

const EMPTY = { key: null, expires: 0, strong: null, lite: null };
let cache = EMPTY;
let inflight = null;      // { key, promise } - one discovery per key at a time
let generation = 0;

// Explicit versions newest first, a stable release before its preview, and the
// "-latest" aliases after the explicit versions (they point at one of them).
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
    // A rejected key is the user's to fix; every model would fail the same way.
    if (err && err.kind === 'auth') throw err;
    if (gen !== generation) return;
    // Keep the last good list for this key, else the static one, and ask
    // Google again in a minute rather than on every call.
    const keep = cache.key === key && cache.strong;
    cache = keep
      ? { ...cache, expires: Date.now() + FAILED_RETRY_MS }
      : { key, expires: Date.now() + FAILED_RETRY_MS, strong: STATIC_STRONG, lite: STATIC_LITE };
  }
}

// Strong models first, then lite ones.
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

// Forget the model list and tell every GeminiLadder to drop its per-model
// state: a new key may see different models and quotas.
export function resetGeminiLadder() {
  cache = EMPTY;
  inflight = null;
  generation++;
}

export const ladderGeneration = () => generation;

// 'valid', 'invalid' (Google rejected it) or 'unknown' (could not ask).
export async function checkApiKey(apiKey, { timeoutMs = 8000 } = {}) {
  try {
    await listModels(apiKey, { timeoutMs });
    return 'valid';
  } catch (err) {
    return err && err.kind === 'auth' ? 'invalid' : 'unknown';
  }
}
