
export const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 60000;
const BLOCKING_FINISH = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export class GeminiError extends Error {
  constructor(kind, message, { status = 0, retryAfterMs = 0, perDay = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.perDay = perDay;
  }
}

export function redactSecrets(text, apiKey = '') {
  let s = String(text ?? '');
  const key = String(apiKey || '').trim();
  if (key.length >= 8) s = s.split(key).join('***');
  return s
    .replace(/([?&](?:key|api_key|apiKey)=)[^&\s"'#]+/gi, '$1***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '***')
    .replace(/\bAQ\.[0-9A-Za-z_.-]{20,}/g, '***');
}

function readErrorBody(text) {
  try {
    const e = JSON.parse(text).error || {};
    const details = Array.isArray(e.details) ? e.details : [];
    const reason = details.map((d) => d && d.reason).find(Boolean) || '';
    const delay = details.map((d) => d && d.retryDelay).find(Boolean) || '';
    return { message: String(e.message || ''), status: String(e.status || ''), reason, retryDelay: String(delay) };
  } catch (_) {
    return { message: String(text || '').slice(0, 300), status: '', reason: '', retryDelay: '' };
  }
}

function retryAfterMs(info) {
  const m = /([\d.]+)s/.exec(info.retryDelay) || /retry in ([\d.]+)\s*s/i.exec(info.message);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

export function classifyHttpError(status, bodyText, apiKey = '') {
  const info = readErrorBody(bodyText);
  const detail = redactSecrets(`${info.status ? info.status + ': ' : ''}${info.message}`.slice(0, 300), apiKey);
  const head = `${status} ${detail}`.trim();
  const keyProblem = /API_KEY|api key/i.test(`${info.reason} ${info.message}`);
  if (status === 401 || status === 403 || (status === 400 && keyProblem)) {
    return new GeminiError('auth', `Google rejected the Gemini API key (${head}). Check the key in Settings.`, { status });
  }
  if (status === 404) return new GeminiError('retired', head, { status });
  if (status === 429) {
    const perDay = /PerDay|per day/i.test(bodyText);
    return new GeminiError('quota', head, { status, retryAfterMs: retryAfterMs(info), perDay });
  }
  if (status === 503) return new GeminiError('overloaded', head, { status });
  if (status >= 500) return new GeminiError('server', head, { status });
  return new GeminiError('bad-request', head, { status });
}

async function request(apiKey, path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, label = path } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new GeminiError('auth', 'No Gemini API key is set. Add one in Settings.');
  if (signal?.aborted) throw new GeminiError('aborted', 'Stopped.');

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const abandoned = new Promise((_, reject) => {
    ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  abandoned.catch(() => {});
  const guard = (p) => Promise.race([p, abandoned]);
  try {
    const res = await guard(fetch(`${API_ROOT}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal
    }));
    if (!res.ok) throw classifyHttpError(res.status, await guard(res.text()).catch(() => ''), key);
    try {
      return await guard(res.json());
    } catch (_) {
      throw new GeminiError('server', `${res.status} Gemini returned a reply that is not JSON`, { status: res.status });
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err;
    if (timedOut) throw new GeminiError('timeout', `timeout: ${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (signal?.aborted) throw new GeminiError('aborted', 'Stopped.');
    const cause = err && err.cause && (err.cause.code || err.cause.message);
    throw new GeminiError('network', redactSecrets(`${err && err.message || 'network error'}${cause ? ` (${cause})` : ''}`, key));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const modelPath = (model) => (String(model || '').startsWith('models/') ? model : `models/${model}`);

export function candidateText(data) {
  const cand = (data && Array.isArray(data.candidates) && data.candidates[0]) || null;
  const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  const text = parts.filter((p) => p && !p.thought).map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
  if (text.trim()) return text;

  const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
  if (blocked) throw new GeminiError('blocked', `Gemini blocked the request (${blocked}).`);
  const finish = cand && cand.finishReason;
  if (BLOCKING_FINISH.has(finish)) throw new GeminiError('blocked', `Gemini withheld its answer (${finish}).`);
  if (finish === 'RECITATION') throw new GeminiError('recitation', 'Gemini withheld its answer (RECITATION).');
  if (finish === 'MAX_TOKENS') throw new GeminiError('empty', 'Gemini ran out of output tokens before answering.');
  throw new GeminiError('empty', `Gemini returned an empty answer${finish ? ` (${finish})` : ''}.`);
}

export async function generateContent(apiKey, model, parts, { generationConfig, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const name = modelPath(model);
  const body = { contents: [{ role: 'user', parts }] };
  if (generationConfig) body.generationConfig = generationConfig;
  const data = await request(apiKey, `${name}:generateContent`, { method: 'POST', body, timeoutMs, signal, label: name });
  return candidateText(data);
}

export async function listModels(apiKey, { timeoutMs = 10000, signal } = {}) {
  const data = await request(apiKey, 'models?pageSize=200', { timeoutMs, signal, label: 'model list' });
  return Array.isArray(data && data.models) ? data.models : [];
}
