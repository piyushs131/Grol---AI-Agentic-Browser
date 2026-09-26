// Runs action requests: applies the confirmation policy, enforces a timeout,
// and records every outcome in the memory store.

const crypto = require('crypto');
const { ActionResponse, DEFAULT_TIMEOUT_MS, errorMessage } = require('../../shared/schemas/action-schema');
const { NOOP_LOGGER } = require('../../memory/logs');
const { assessRisk } = require('./risk-policy');

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING = 100;
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|credential|auth)/i;
const MAX_LOGGED_STRING = 4000;
const MAX_LOGGED_RESULT = 5000;
const MAX_SANITIZE_DEPTH = 4;
const MAX_LOGGED_ITEMS = 50;

const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

class ActionExecutor {
  constructor(registry, logger = NOOP_LOGGER, memoryStore = null, options = {}) {
    this.registry = registry;
    this.logger = logger;
    this.memoryStore = memoryStore;
    this.pendingConfirmations = new Map();
    this.confirmationTtlMs = positiveNumber(options.confirmationTtlMs, DEFAULT_CONFIRMATION_TTL_MS);
    this.maxPending = positiveNumber(options.maxPending, DEFAULT_MAX_PENDING);
  }

  // What the policy says about module.action, judged on both the requested
  // name and the one that will actually run.
  assess(module, action) {
    const target = this.registry.resolve(module, action);
    const resolved = target ? `${target.module}.${target.action}` : null;
    return { target, ...assessRisk(`${module}.${action}`, resolved, target && this.registry.getActionMeta(target)) };
  }

  async execute(actionRequest) {
    const { task_id, module, action } = actionRequest;
    this.logger.info(`Executing: ${module}.${action} [task:${task_id}]`);

    const { target, risk, needsConfirmation } = this.assess(module, action);
    if (!target) return this._fail(actionRequest, risk, this.registry.notFoundMessage(module, action));
    if (needsConfirmation) {
      return this._record(actionRequest, risk, this._requestConfirmation(actionRequest, target, risk));
    }
    return this._run(actionRequest, target, risk);
  }

  // The pending entry is removed before anything is awaited, so a replayed or
  // concurrent confirm of the same id can never run the action twice.
  async confirmAndExecute(confirmationId, { approved = true, reason } = {}) {
    const pending = this._takePending(confirmationId);
    if (!pending) return ActionResponse.error('unknown', 'Confirmation ID not found or expired');

    const { actionRequest, target, risk } = pending;
    if (Date.now() > pending.expiresAt) return this._fail(actionRequest, risk, 'Confirmation request expired');
    if (approved !== true) return this._fail(actionRequest, risk, reason || 'Action denied by approver');

    // Modules may have changed while the user was deciding; run only what was approved.
    const current = this.registry.resolve(actionRequest.module, actionRequest.action);
    if (!current || current.module !== target.module || current.action !== target.action) {
      return this._fail(actionRequest, risk, `${target.module}.${target.action} is no longer available`);
    }
    return this._run(actionRequest, target, risk);
  }

  get pendingCount() {
    return this.pendingConfirmations.size;
  }

  _takePending(confirmationId) {
    if (typeof confirmationId !== 'string') return null;
    const pending = this.pendingConfirmations.get(confirmationId);
    this.pendingConfirmations.delete(confirmationId);
    return pending || null;
  }

  _requestConfirmation(actionRequest, target, risk) {
    const { task_id, module, action, parameters } = actionRequest;
    this._prunePending();
    const confirmationId = crypto.randomUUID();
    const expiresAt = Date.now() + this.confirmationTtlMs;
    this.pendingConfirmations.set(confirmationId, { actionRequest, target, expiresAt, risk });
    return ActionResponse.requiresConfirmation(task_id, {
      confirmation_id: confirmationId,
      risk_level: risk,
      expires_at: expiresAt,
      message: `This action (${module}.${action}) requires confirmation under security policy.`,
      details: parameters
    }, module, action);
  }

  // Drops expired requests, then the oldest ones, so a caller that never
  // answers cannot grow the map without bound.
  _prunePending() {
    const now = Date.now();
    for (const [id, pending] of this.pendingConfirmations) {
      if (now > pending.expiresAt) this.pendingConfirmations.delete(id);
    }
    for (const id of this.pendingConfirmations.keys()) {
      if (this.pendingConfirmations.size < this.maxPending) break;
      this.pendingConfirmations.delete(id);
    }
  }

  async _run(actionRequest, target, risk) {
    const { task_id, module, action, parameters, timeout } = actionRequest;
    const startTime = Date.now();
    let response;
    try {
      const result = await this._withTimeout(
        () => this.registry.executeAction(target.module, target.action, parameters), timeout, module, action
      );
      response = ActionResponse.success(task_id, result, Date.now() - startTime, module, action);
    } catch (err) {
      this.logger.error(`Action failed: ${module}.${action} - ${errorMessage(err)}`);
      response = ActionResponse.error(task_id, err, Date.now() - startTime, module, action);
    }
    return this._record(actionRequest, risk, response);
  }

  // The action itself cannot be cancelled; the caller just stops waiting.
  async _withTimeout(run, timeout = DEFAULT_TIMEOUT_MS, module, action) {
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Action ${module}.${action} timed out after ${timeout}ms`)), timeout);
    });
    try {
      return await Promise.race([Promise.resolve().then(run), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  _fail(actionRequest, risk, message) {
    const { task_id, module, action } = actionRequest;
    return this._record(actionRequest, risk, ActionResponse.error(task_id, message, 0, module, action));
  }

  _record(request, risk, response) {
    if (!this.memoryStore) return response;
    try {
      this.memoryStore.logAction({
        task_id: request.task_id,
        module: request.module,
        action: request.action,
        parameters: truncatedJson(sanitize(request.parameters), Infinity),
        risk_level: risk,
        status: response.status,
        result: truncatedJson(sanitize(response.result), MAX_LOGGED_RESULT),
        error: response.error,
        execution_time: response.execution_time,
        timestamp: Date.now()
      });
    } catch (err) {
      this.logger.warn(`Failed to log action: ${errorMessage(err)}`);
    }
    return response;
  }
}

// Keeps secrets and huge payloads (typed text, file contents) out of the log.
function sanitize(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_LOGGED_STRING ? `${value.slice(0, MAX_LOGGED_STRING)}...[TRUNCATED]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_SANITIZE_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, MAX_LOGGED_ITEMS).map((v) => sanitize(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return `[${value.constructor?.name || 'object'}]`;
  const clean = {};
  for (const [key, v] of Object.entries(value)) {
    clean[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(v, depth + 1);
  }
  return clean;
}

function truncatedJson(value, maxLength) {
  if (value === null || value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json.substring(0, maxLength);
  } catch {
    return '[unserializable]';
  }
}

module.exports = ActionExecutor;
module.exports.sanitize = sanitize;
