import { generateContent, GeminiError, redactSecrets } from './gemini-fetch-client.js';
import { geminiLadder, checkApiKey } from './gemini-models.js';
import { DEFAULT_DAEMON_URL } from './os-daemon.js';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_TOKENS = 16000;

export const PROVIDERS = {
  gemini:     { label: 'Google Gemini', kind: 'gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  anthropic:  { label: 'Anthropic Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai:     { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini'], keyUrl: 'https://platform.openai.com/api-keys' },
  xai:        { label: 'xAI Grok', kind: 'openai', baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'], keyUrl: 'https://console.x.ai' },
  groq:       { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
    models: ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile'], keyUrl: 'https://console.groq.com/keys' },
  openrouter: { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', checkPath: '/key',
    models: ['openrouter/auto'], keyUrl: 'https://openrouter.ai/keys' },
  deepseek:   { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'], vision: false, keyUrl: 'https://platform.deepseek.com/api_keys' },
  mistral:    { label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    models: ['pixtral-large-latest', 'mistral-large-latest'], keyUrl: 'https://console.mistral.ai/api-keys' },
  together:   { label: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8'], keyUrl: 'https://api.together.ai/settings/api-keys' },
  ollama:     { label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', local: true, models: [] },
  lmstudio:   { label: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', local: true, models: [] },
  custom:     { label: 'Other (OpenAI-compatible)', kind: 'openai', baseUrl: '', models: [] }
};

export function detectProvider(apiKey) {
  const k = String(apiKey || '').trim();
  const local = /^local:(\w+)$/.exec(k);
  if (local && PROVIDERS[local[1]]) return local[1];
  if (/^sk-ant-/.test(k)) return 'anthropic';
  if (/^(AIza|AQ\.)/.test(k)) return 'gemini';
  if (/^xai-/.test(k)) return 'xai';
  if (/^gsk_/.test(k)) return 'groq';
  if (/^sk-or-/.test(k)) return 'openrouter';
  if (/^sk-/.test(k)) return 'openai';
  return null;
}

const registered = new Map();

export function registerCredential(apiKey, { provider, baseUrl, model } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return;
  registered.set(key, {
    provider: PROVIDERS[provider] ? provider : null,
    baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(model || '').trim()
  });
}

export function knownProvider(apiKey) {
  const key = String(apiKey || '').trim();
  return (registered.get(key) || {}).provider || detectProvider(key);
}

export function resolveProvider(apiKey) {
  const key = String(apiKey || '').trim();
  const reg = registered.get(key) || {};
  const id = reg.provider || detectProvider(key) || 'gemini';
  const p = PROVIDERS[id];
  return { id, ...p, baseUrl: reg.baseUrl || p.baseUrl || '', model: reg.model || '' };
}

export const providerLabel = (apiKey) => resolveProvider(apiKey).label;


function errorText(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const e = j.error || j;
    return String((e && (e.message || e.error || e.type)) || bodyText).slice(0, 300);
  } catch (_) {
    return String(bodyText || '').slice(0, 300);
  }
}

const IMAGE_REJECTED = /image|vision|multimodal|image_url/i;

function classify(status, bodyText, p, apiKey, retryAfter) {
  const msg = redactSecrets(errorText(bodyText), apiKey);
  const head = `${status} ${msg}`.trim();
  const badKey = status === 400 && /(incorrect|invalid|missing).{0,20}(api[ -]?key|x-api-key)|api[ -]?key.{0,20}(invalid|incorrect)/i.test(msg);
  if (status === 401 || status === 403 || badKey) {
    return new GeminiError('auth', `${p.label} rejected the API key (${head}). Check the key in Settings.`, { status });
  }
  if (status === 404) return new GeminiError('retired', head, { status });
  if (status === 429) {
    const secs = Number(retryAfter);
    return new GeminiError('quota', head, { status, retryAfterMs: Number.isFinite(secs) ? secs * 1000 : 0,
      perDay: /per day|daily/i.test(msg) });
  }
  if (status === 503 || status === 529) return new GeminiError('overloaded', head, { status });
  if (status >= 500) return new GeminiError('server', head, { status });
  if (IMAGE_REJECTED.test(msg)) return new GeminiError('bad-request', head, { status });
  if (/model.*(not found|does not exist|unknown|invalid|not available|decommissioned)/i.test(msg)) {
    return new GeminiError('retired', head, { status });
  }
  return new GeminiError('bad-request', head, { status });
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\//;

async function viaHelper(url, method, body, { timeoutMs, signal, apiKey, p, label }) {
  const relayed = await postJSON(`${DEFAULT_DAEMON_URL}/llm-local`, {}, { url, method, body },
    { timeoutMs, signal, apiKey, p, label, relay: false }).catch((err) => {
    if (err.kind === 'network') {
      throw new GeminiError('auth', `${p.label} refuses requests from the browser. Start the OS Control helper ` +
        '(browser/companion/install-autostart.sh) so Grol can reach it, or set OLLAMA_ORIGINS="chrome-extension://*" and restart Ollama.');
    }
    throw err;
  });
  const status = Number(relayed && relayed.status);
  const text = String((relayed && relayed.body) || '');
  if (!(status >= 200 && status < 300)) throw classify(status || 502, text, p, apiKey, null);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new GeminiError('server', `${status} ${p.label} returned a reply that is not JSON`, { status });
  }
}

async function postJSON(url, headers, body, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, apiKey, p, label, relay = true }) {
  if (signal?.aborted) throw new GeminiError('aborted', 'Stopped.');
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal
    });
    if (res.status === 403 && relay && LOOPBACK.test(url)) {
      return viaHelper(url, body === undefined ? 'GET' : 'POST', body, { timeoutMs, signal, apiKey, p, label });
    }
    if (!res.ok) {
      throw classify(res.status, await res.text().catch(() => ''), p, apiKey, res.headers.get('retry-after'));
    }
    try {
      return await res.json();
    } catch (_) {
      throw new GeminiError('server', `${res.status} ${p.label} returned a reply that is not JSON`, { status: res.status });
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err;
    if (timedOut) throw new GeminiError('timeout', `timeout: ${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (signal?.aborted) throw new GeminiError('aborted', 'Stopped.');
    const cause = err && err.cause && (err.cause.code || err.cause.message);
    const local = p.local ? ` Is ${p.label.replace(' (local)', '')} running at ${p.baseUrl}?` : '';
    throw new GeminiError('network', redactSecrets(`${err && err.message || 'network error'}${cause ? ` (${cause})` : ''}.${local}`, apiKey));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const images = (parts) => parts.filter((x) => x && x.inlineData && x.inlineData.data);
const texts = (parts) => parts.filter((x) => x && typeof x.text === 'string' && x.text).map((x) => x.text);

async function anthropicGenerate(apiKey, p, model, parts, opts) {
  const content = [
    ...images(parts).map((x) => ({ type: 'image', source: { type: 'base64', media_type: x.inlineData.mimeType, data: x.inlineData.data } })),
    ...texts(parts).map((text) => ({ type: 'text', text }))
  ];
  const body = { model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content }] };
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (/^claude-(opus-5-5|sonnet-5-5|opus-5|fable-5)/.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const data = await postJSON(`${p.baseUrl}/messages`, headers, body, { ...opts, apiKey, p, label: model });
  if (data && data.stop_reason === 'refusal') {
    throw new GeminiError('blocked', `Claude declined to answer${data.stop_details && data.stop_details.category ? ` (${data.stop_details.category})` : ''}.`);
  }
  const text = (Array.isArray(data && data.content) ? data.content : [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  if (text.trim()) return text;
  if (data && data.stop_reason === 'max_tokens') throw new GeminiError('empty', 'Claude ran out of output tokens before answering.');
  throw new GeminiError('empty', `Claude returned an empty answer${data && data.stop_reason ? ` (${data.stop_reason})` : ''}.`);
}

const textOnly = new Set();

async function openaiGenerate(apiKey, p, model, parts, opts) {
  if (!p.baseUrl) throw new GeminiError('auth', 'Set the base URL of your OpenAI-compatible server in Settings.');
  const withImages = p.vision !== false && !textOnly.has(`${p.baseUrl}|${model}`);
  const content = [
    ...texts(parts).map((text) => ({ type: 'text', text })),
    ...(withImages ? images(parts).map((x) => ({ type: 'image_url', image_url: { url: `data:${x.inlineData.mimeType};base64,${x.inlineData.data}` } })) : [])
  ];
  const headers = {};
  if (apiKey && !/^local:/.test(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
  if (p.id === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/piyushs131/Grol---AI-Agentic-Browser'; headers['X-Title'] = 'Grol'; }
  const body = { model, messages: [{ role: 'user', content }] };
  let data;
  try {
    data = await postJSON(`${p.baseUrl}/chat/completions`, headers, body, { ...opts, apiKey, p, label: model });
  } catch (err) {
    if (withImages && images(parts).length && err.kind === 'bad-request' && IMAGE_REJECTED.test(err.message)) {
      textOnly.add(`${p.baseUrl}|${model}`);
      return openaiGenerate(apiKey, p, model, parts, opts);
    }
    throw err;
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = choice && choice.message;
  let text = msg && msg.content;
  if (Array.isArray(text)) text = text.map((c) => (c && (c.text || '')) || '').join('');
  if (typeof text === 'string' && text.trim()) return text;
  if (choice && choice.finish_reason === 'content_filter') throw new GeminiError('blocked', `${p.label} withheld its answer (content filter).`);
  if (choice && choice.finish_reason === 'length') throw new GeminiError('empty', `${p.label} ran out of output tokens before answering.`);
  throw new GeminiError('empty', `${p.label} returned an empty answer.`);
}

export async function generate(apiKey, model, parts, { generationConfig, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const key = String(apiKey || '').trim();
  const p = resolveProvider(key);
  if (!key && !p.local) throw new GeminiError('auth', 'No AI API key is set. Add one in Settings.');
  const list = Array.isArray(parts) ? parts : [];
  if (p.kind === 'gemini') return generateContent(key, model, list, { generationConfig, timeoutMs, signal });
  if (p.kind === 'anthropic') return anthropicGenerate(key, p, model, list, { timeoutMs, signal });
  return openaiGenerate(key, p, model, list, { timeoutMs, signal });
}


const discovered = new Map();

async function localModels(p, apiKey) {
  if (discovered.has(p.baseUrl)) return discovered.get(p.baseUrl);
  try {
    const headers = apiKey && !/^local:/.test(apiKey) ? { Authorization: `Bearer ${apiKey}` } : {};
    const data = await postJSON(`${p.baseUrl}/models`, headers, undefined, { timeoutMs: 5000, apiKey, p, label: 'model list' });
    const ids = (Array.isArray(data && data.data) ? data.data : []).map((m) => m && m.id).filter(Boolean)
      .filter((id) => !/embed|whisper|tts|rerank/i.test(id));
    discovered.set(p.baseUrl, ids);
    return ids;
  } catch (_) {
    return [];
  }
}

export async function modelLadder(apiKey) {
  const key = String(apiKey || '').trim();
  const p = resolveProvider(key);
  if (p.kind === 'gemini') {
    const list = await geminiLadder(key);
    return p.model ? [p.model.startsWith('models/') ? p.model : `models/${p.model}`, ...list] : list;
  }
  let list = [...(p.models || [])];
  if (!list.length && !p.model) list = await localModels(p, key);
  const all = [...new Set([p.model, ...list].filter(Boolean))];
  if (!all.length) {
    throw new GeminiError('auth', `No model is set for ${p.label}. Enter a model name in Settings` +
      (p.local ? ' (or pull one first, e.g. "ollama pull llama3.2-vision").' : '.'));
  }
  return all;
}

export async function checkCredential(apiKey) {
  const key = String(apiKey || '').trim();
  const p = resolveProvider(key);
  try {
    if (p.kind === 'gemini') return checkApiKey(key);
    const headers = p.kind === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : (key && !/^local:/.test(key) ? { Authorization: `Bearer ${key}` } : {});
    if (!p.baseUrl) return 'unknown';
    await postJSON(`${p.baseUrl}${p.checkPath || '/models'}`, headers, undefined, { timeoutMs: 8000, apiKey: key, p, label: 'key check' });
    return 'valid';
  } catch (err) {
    return err && err.kind === 'auth' ? 'invalid' : 'unknown';
  }
}

export function resetProviders() {
  discovered.clear();
  textOnly.clear();
}
