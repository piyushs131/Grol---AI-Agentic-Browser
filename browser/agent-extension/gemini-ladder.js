// Resilient Gemini calls: walk the model ladder, skipping models known to be
// out of quota, overloaded or retired. Free-tier quota is per model, so hopping
// keeps the agent running. Two policies share this code:
//  - the browser agent starts at the top every time and puts failing models on
//    a cooldown;
//  - OS Control sticks to the last model that answered and, when every model
//    is busy, waits and walks the ladder again (rounds with backoff).
import { generateContent, GeminiError } from './gemini-fetch-client.js';
import { geminiLadder, ladderGeneration } from './gemini-models.js';
import { sleep } from './sleep.js';

const REQUEST_TIMEOUT_MS = 30000;
const MIN_REQUEST_MS = 3000;
const MAX_NETWORK_RETRIES = 3;
const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;
const OVERLOAD_COOLDOWN_MS = 90 * 1000;
// Two models failing purely on the network means the connection is down, not
// the quota; vision-agent.js matches this text to wait it out.
export const NETWORK_DOWN = 'Cannot reach the AI service - the network connection looks down. Check your internet and try again.';

// A 429 for an exhausted quota is pointless to retry in place. Google states
// the wait ("retry in 52.5s"); the per-minute limit has no per-day marker.
function quotaCooldownMs(err) {
  if (err.perDay) return QUOTA_COOLDOWN_MS;
  if (err.retryAfterMs) return Math.min(QUOTA_COOLDOWN_MS, Math.max(30000, err.retryAfterMs));
  return 60000;
}

const kindOf = (err) => (err instanceof GeminiError ? err.kind : 'bad-reply');

export class GeminiLadder {
  constructor({ logger, stickToLastGood = false, cooldowns = true, retryDelayMs = 800 } = {}) {
    this.logger = logger;
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

  // Per-model state belongs to one key: a new key has its own quotas.
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

  // 'fatal' stops everything, 'retry' asks the same model again, 'next' moves on.
  onFailure(model, err, attempt) {
    const short = model.replace(/^models\//, '');
    switch (kindOf(err)) {
      case 'auth':
      case 'blocked':
      case 'aborted':
        return 'fatal';
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

  // parse: optional (text) => value; a reply it rejects moves on to the next
  // model. onModelError(model, err) and onRound({ round, waitMs, error }) let a
  // caller show progress. deadlineMs bounds the whole walk: hung models would
  // otherwise cost timeoutMs each, minutes across the ladder.
  async ask(apiKey, parts, {
    json = false, generationConfig, parse, timeoutMs = REQUEST_TIMEOUT_MS, deadlineMs = Infinity,
    rounds = 1, roundBackoffMs = [], signal, isAborted = () => false, onModelError, onRound
  } = {}) {
    const endsAt = Date.now() + deadlineMs;
    const remaining = () => endsAt - Date.now();
    const checkDeadline = () => {
      if (remaining() < MIN_REQUEST_MS) {
        throw new GeminiError('timeout', `Gemini did not answer within ${Math.round(deadlineMs / 1000)}s. ` +
          (lastError ? `(last error: ${String(lastError.message).slice(0, 120)})` : 'Try again in a minute.'));
      }
    };
    this.syncKey(apiKey);
    const config = generationConfig || (json ? { responseMimeType: 'application/json' } : undefined);
    const stopped = () => signal?.aborted || isAborted();
    const checkStop = () => { if (stopped()) throw new GeminiError('aborted', 'Stopped.'); };
    const models = await geminiLadder(apiKey);
    let lastError = null;

    for (let round = 0; round < Math.max(1, rounds); round++) {
      if (round) {
        const waitMs = roundBackoffMs[round] ?? roundBackoffMs[roundBackoffMs.length - 1] ?? 0;
        onRound?.({ round, waitMs, error: lastError });
        await sleep(waitMs, { signal, isAborted });
      }
      let networkFailures = 0;
      for (const model of this.order(models)) {
        checkStop();
        if (this.isSkipped(model)) continue;
        for (let attempt = 1; ; attempt++) {
          checkDeadline();
          try {
            const text = await generateContent(apiKey, model, parts,
              { generationConfig: config, timeoutMs: Math.min(timeoutMs, remaining()), signal });
            const value = parse ? parse(text) : text;
            this.coolingUntil.delete(model);
            if (this.lastModel !== model) this.logger?.info(`Gemini: answered by ${model.replace(/^models\//, '')}`);
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
    throw this.exhausted(lastError);
  }

  exhausted(lastError) {
    if (!lastError) {
      const soonest = Math.min(...[...this.coolingUntil.values()].filter((t) => t > Date.now()));
      const wait = isFinite(soonest) ? ` Try again in ${Math.ceil((soonest - Date.now()) / 1000)}s.` : '';
      return new GeminiError('quota', `Every Gemini model is out of quota or overloaded right now.${wait}`);
    }
    return new GeminiError(kindOf(lastError), 'Every Gemini model failed. Try again in a minute. ' +
      `(last error: ${String(lastError.message).slice(0, 160)})`, { status: lastError.status || 0 });
  }
}
