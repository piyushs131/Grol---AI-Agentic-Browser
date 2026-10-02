import { GeminiError } from './gemini-fetch-client.js';
import { ladderGeneration } from './gemini-models.js';
import { generate, modelLadder, providerLabel } from './llm-providers.js';
import { sleep } from './sleep.js';

const REQUEST_TIMEOUT_MS = 30000;
const MIN_REQUEST_MS = 3000;
const MAX_NETWORK_RETRIES = 3;
const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;
const OVERLOAD_COOLDOWN_MS = 10 * 60 * 1000;
export const NETWORK_DOWN = 'Cannot reach the AI service - the network connection looks down. Check your internet and try again.';

function quotaCooldownMs(err) {
  if (err.perDay) return QUOTA_COOLDOWN_MS;
  if (err.retryAfterMs) return Math.min(QUOTA_COOLDOWN_MS, Math.max(30000, err.retryAfterMs));
  return 60000;
}

const kindOf = (err) => (err instanceof GeminiError ? err.kind : 'bad-reply');

export function storedLastModel(key = 'gemini.lastGoodModel') {
  const area = globalThis.chrome && chrome.storage && chrome.storage.local;
  if (!area) return null;
  return {
    load: () => area.get(key).then((o) => (typeof o[key] === 'string' ? o[key] : null), () => null),
    save: (model) => area.set({ [key]: model }).catch(() => {})
  };
}

export class GeminiLadder {
  constructor({ logger, stickToLastGood = false, cooldowns = true, retryDelayMs = 800, memory = null } = {}) {
    this.logger = logger;
    this.memory = memory;
    this.restored = null;
    this.stickToLastGood = stickToLastGood;
    this.cooldowns = cooldowns;
    this.retryDelayMs = retryDelayMs;
    this.forget();
  }

  forget() {
    this.coolingUntil = new Map();
    this.retired = new Set();
    this.lastModel = null;
    this.stateKey = null;
    this.generation = ladderGeneration();
  }

  syncKey(apiKey) {
    if (this.stateKey !== apiKey || this.generation !== ladderGeneration()) {
      this.forget();
      this.stateKey = apiKey;
    }
  }

  isSkipped(model) {
    return this.retired.has(model) || (this.coolingUntil.get(model) || 0) > Date.now();
  }

  order(models) {
    const last = this.lastModel;
    return this.stickToLastGood && last && models.includes(last) ? [last, ...models.filter((m) => m !== last)] : models;
  }

  cool(model, ms) {
    if (this.cooldowns) this.coolingUntil.set(model, Date.now() + ms);
  }

  onFailure(model, err, attempt) {
    const short = model.replace(/^models\//, '');
    switch (kindOf(err)) {
      case 'auth':
      case 'blocked':
      case 'aborted':
        return 'fatal';
      case 'recitation':
        this.logger?.warn(`Gemini ${short} withheld a reply as recitation - trying the next model.`);
        return 'next';
      case 'retired':
        this.logger?.warn(`Gemini ${short} is no longer available (404) - dropping it.`);
        this.retired.add(model);
        return 'next';
      case 'overloaded':
        this.logger?.warn(`Gemini ${short} is overloaded - trying the next model.`);
        this.cool(model, OVERLOAD_COOLDOWN_MS);
        return 'next';
      case 'quota': {
        const ms = quotaCooldownMs(err);
        this.logger?.warn(`Gemini ${short} is out of quota - skipping it for ${Math.round(ms / 1000)}s.`);
        this.cool(model, ms);
        return 'next';
      }
      case 'network':
      case 'server':
        if (attempt < MAX_NETWORK_RETRIES) {
          this.logger?.warn(`Gemini ${short} transient error (attempt ${attempt}/${MAX_NETWORK_RETRIES}): ${err.message}`);
          return 'retry';
        }
        return 'next';
      default:
        this.logger?.warn(`Gemini ${short} failed: ${err.message}`);
        return 'next';
    }
  }

  async ask(apiKey, parts, opts = {}) {
    const hedgeMs = Number(opts.hedgeMs) || 0;
    if (!hedgeMs) return this._walk(apiKey, parts, opts);
    const lanes = [new AbortController(), new AbortController()];
    const link = (ctl) => {
      if (opts.signal) {
        if (opts.signal.aborted) ctl.abort();
        else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
      }
      return ctl.signal;
    };
    const first = this._walk(apiKey, parts, { ...opts, signal: link(lanes[0]) });
    first.catch(() => {});
    let timer;
    const hedge = new Promise((resolve) => { timer = setTimeout(resolve, hedgeMs); });
    const early = await Promise.race([first.then(() => 'done', () => 'done'), hedge.then(() => 'hedge')]);
    clearTimeout(timer);
    if (early === 'done') return first;
    if (opts.signal?.aborted || (opts.isAborted && opts.isAborted())) return first;
    this.logger?.info(`Model: no answer after ${Math.round(hedgeMs / 1000)}s - asking the next model in parallel`);
    const second = this._walk(apiKey, parts, { ...opts, signal: link(lanes[1]), rotate: 1 });
    second.catch(() => {});
    try {
      const winner = await Promise.any([first.then((v) => ({ v, i: 0 })), second.then((v) => ({ v, i: 1 }))]);
      lanes[1 - winner.i].abort();
      return winner.v;
    } catch (_) {
      return first;
    }
  }

  async _walk(apiKey, parts, {
    json = false, generationConfig, parse, timeoutMs = REQUEST_TIMEOUT_MS, deadlineMs = Infinity,
    rounds = 1, roundBackoffMs = [], signal, isAborted = () => false, onModelError, onRound, rotate = 0
  } = {}) {
    const endsAt = Date.now() + deadlineMs;
    const remaining = () => endsAt - Date.now();
    const checkDeadline = () => {
      if (remaining() < MIN_REQUEST_MS) {
        throw new GeminiError('timeout', `${providerLabel(apiKey)} did not answer within ${Math.round(deadlineMs / 1000)}s. ` +
          (lastError ? `(last error: ${String(lastError.message).slice(0, 120)})` : 'Try again in a minute.'));
      }
    };
    this.syncKey(apiKey);
    if (this.memory && this.stickToLastGood) {
      this.restored ||= this.memory.load().then((m) => { if (m && !this.lastModel) this.lastModel = m; });
      await this.restored;
    }
    const config = generationConfig || (json ? { responseMimeType: 'application/json' } : undefined);
    const stopped = () => signal?.aborted || isAborted();
    const checkStop = () => { if (stopped()) throw new GeminiError('aborted', 'Stopped.'); };
    const models = await modelLadder(apiKey);
    let lastError = null;

    for (let round = 0; round < Math.max(1, rounds); round++) {
      if (round) {
        const waitMs = roundBackoffMs[round] ?? roundBackoffMs[roundBackoffMs.length - 1] ?? 0;
        onRound?.({ round, waitMs, error: lastError });
        await sleep(waitMs, { signal, isAborted });
      }
      let networkFailures = 0;
      const ordered = this.order(models);
      const lane = rotate ? [...ordered.slice(rotate % ordered.length), ...ordered.slice(0, rotate % ordered.length)] : ordered;
      for (const model of lane) {
        checkStop();
        if (this.isSkipped(model)) continue;
        for (let attempt = 1; ; attempt++) {
          checkDeadline();
          try {
            const text = await generate(apiKey, model, parts,
              { generationConfig: config, timeoutMs: Math.min(timeoutMs, remaining()), signal });
            const value = parse ? parse(text) : text;
            this.coolingUntil.delete(model);
            if (this.lastModel !== model) {
              this.logger?.info(`Model: answered by ${model.replace(/^models\//, '')}`);
              this.memory?.save(model);
            }
            this.lastModel = model;
            return value;
          } catch (err) {
            if (stopped()) throw new GeminiError('aborted', 'Stopped.');
            lastError = err;
            const decision = this.onFailure(model, err, attempt);
            if (decision === 'fatal') throw err;
            if (decision === 'retry') {
              await sleep(this.retryDelayMs * attempt, { signal, isAborted });
              checkStop();
              continue;
            }
            if (kindOf(err) === 'network') networkFailures++;
            onModelError?.(model, err);
            break;
          }
        }
        if (networkFailures >= 2) throw new GeminiError('network', NETWORK_DOWN);
      }
    }
    throw this.exhausted(lastError, providerLabel(apiKey));
  }

  exhausted(lastError, label = 'AI') {
    if (!lastError) {
      const soonest = Math.min(...[...this.coolingUntil.values()].filter((t) => t > Date.now()));
      const wait = isFinite(soonest) ? ` Try again in ${Math.ceil((soonest - Date.now()) / 1000)}s.` : '';
      return new GeminiError('quota', `Every ${label} model is out of quota or overloaded right now.${wait}`);
    }
    return new GeminiError(kindOf(lastError), `Every ${label} model failed. Try again in a minute. ` +
      `(last error: ${String(lastError.message).slice(0, 160)})`, { status: lastError.status || 0 });
  }
}
