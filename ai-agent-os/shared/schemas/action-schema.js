// Request/response shapes for POST /execute and POST /confirm.

const ACTION_STATUS = Object.freeze({
  SUCCESS: 'success',
  ERROR: 'error',
  REQUIRES_CONFIRMATION: 'requires_confirmation'
});

const RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
});

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TASK_ID_LENGTH = 200;
// Also keeps "__proto__"-style names out before any lookup happens.
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function errorMessage(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err ?? 'Unknown error');
}

function validateTaskId(taskId) {
  if (taskId === undefined || taskId === null || taskId === '') return 'task_id is required';
  const ok = (typeof taskId === 'string' && taskId.length <= MAX_TASK_ID_LENGTH) ||
    (typeof taskId === 'number' && Number.isFinite(taskId));
  return ok ? null : `task_id must be a string (max ${MAX_TASK_ID_LENGTH} chars) or a number`;
}

function validateIdentifier(field, value) {
  if (value === undefined || value === null || value === '') return `${field} is required`;
  return typeof value === 'string' && IDENTIFIER.test(value) ? null : `${field} must be an identifier like "readFile"`;
}

function validateParameters(parameters) {
  return parameters === undefined || parameters === null || isPlainObject(parameters) ? null : 'parameters must be an object';
}

function validateTimeout(timeout) {
  if (timeout === undefined) return null;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? null : 'timeout must be a positive number of ms';
}

class ActionRequest {
  constructor(body = {}) {
    const source = isPlainObject(body) ? body : {};
    this.task_id = source.task_id;
    this.module = source.module;
    this.action = source.action;
    this.parameters = source.parameters;
    this.timeout = source.timeout;
  }

  // Normalises the fields in place when valid, so the executor only ever sees
  // an object for parameters and a bounded timeout.
  validate(knownModules = null) {
    const moduleError = validateIdentifier('module', this.module);
    const errors = [
      validateTaskId(this.task_id),
      moduleError,
      validateIdentifier('action', this.action),
      validateParameters(this.parameters),
      validateTimeout(this.timeout)
    ].filter(Boolean);
    if (!moduleError && knownModules && !knownModules.includes(this.module)) {
      errors.push(`Unknown module: ${this.module}. Valid: ${knownModules.join(', ')}`);
    }
    if (errors.length === 0) {
      this.parameters = this.parameters || {};
      this.timeout = Math.min(this.timeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    }
    return { valid: errors.length === 0, errors };
  }
}

class ActionResponse {
  constructor({ task_id, status, result = null, error = null, execution_time = 0, module = '', action = '' }) {
    this.task_id = task_id;
    this.status = status;
    this.result = result === undefined ? null : result;
    this.error = error;
    this.execution_time = execution_time;
    this.module = module;
    this.action = action;
    this.timestamp = Date.now();
  }

  static success(task_id, result, execution_time, module = '', action = '') {
    return new ActionResponse({ task_id, status: ACTION_STATUS.SUCCESS, result, execution_time, module, action });
  }

  static error(task_id, error, execution_time = 0, module = '', action = '') {
    return new ActionResponse({
      task_id, status: ACTION_STATUS.ERROR, error: errorMessage(error), execution_time, module, action
    });
  }

  static requiresConfirmation(task_id, details, module = '', action = '') {
    return new ActionResponse({ task_id, status: ACTION_STATUS.REQUIRES_CONFIRMATION, result: details, module, action });
  }

  toJSON() {
    return {
      task_id: this.task_id,
      status: this.status,
      result: this.result,
      error: this.error,
      execution_time: this.execution_time,
      module: this.module,
      action: this.action,
      timestamp: this.timestamp
    };
  }
}

module.exports = {
  ACTION_STATUS,
  RISK_LEVELS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  ActionRequest,
  ActionResponse,
  errorMessage,
  isPlainObject
};
