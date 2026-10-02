
const express = require('express');
const { ActionRequest, errorMessage, isPlainObject } = require('../../shared/schemas/action-schema');

const MAX_REASON_LENGTH = 500;

const sendError = (res, code, error) => res.status(code).json({ status: 'error', error, timestamp: Date.now() });

const safely = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, errorMessage(err));
  }
};

const requireJsonBody = (req, res, next) => {
  if (!req.is('application/json')) return sendError(res, 415, 'Request body must be JSON (Content-Type: application/json)');
  if (!isPlainObject(req.body)) return sendError(res, 400, 'Request body must be a JSON object');
  next();
};

function parseConfirmation(body) {
  const { confirmation_id: id, approved = true, reason } = body;
  if (typeof id !== 'string' || !id) return { error: 'confirmation_id required' };
  if (typeof approved !== 'boolean') return { error: 'approved must be a boolean' };
  if (reason !== undefined && typeof reason !== 'string') return { error: 'reason must be a string' };
  return { id, approved, reason: reason ? reason.slice(0, MAX_REASON_LENGTH) : undefined };
}

const LOCAL_LLM_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})\/(v1|api)\//;
const LOCAL_LLM_TIMEOUT_MS = 180000;

function localLlmTarget(url, ownPort) {
  const m = LOCAL_LLM_URL.exec(String(url || ''));
  if (!m) return { error: 'url must be a local model API (http://localhost:<port>/v1/...)' };
  const port = Number(m[2]);
  if (port === Number(ownPort) || port < 1 || port > 65535) return { error: 'That port is not a model server' };
  return { url: String(url) };
}

function createRouter(executor, registry, memoryStore, { ownPort } = {}) {
  const router = express.Router();

  router.post('/llm-local', requireJsonBody, safely(async (req, res) => {
    const { url, method = 'POST', body } = req.body;
    const target = localLlmTarget(url, req.socket.localPort || ownPort);
    if (target.error) return sendError(res, 400, target.error);
    if (method !== 'GET' && method !== 'POST') return sendError(res, 400, 'method must be GET or POST');
    let upstream;
    try {
      upstream = await fetch(target.url, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(LOCAL_LLM_TIMEOUT_MS)
      });
    } catch (err) {
      return sendError(res, 502, `Local model server not reachable: ${errorMessage(err)}`);
    }
    res.json({ status: upstream.status, body: await upstream.text() });
  }));

  router.post('/execute', requireJsonBody, safely(async (req, res) => {
    const actionRequest = new ActionRequest(req.body);
    const { valid, errors } = actionRequest.validate(registry.getModuleNames());
    if (!valid) return sendError(res, 400, `Validation failed: ${errors.join(', ')}`);
    res.json((await executor.execute(actionRequest)).toJSON());
  }));

  router.post('/confirm', requireJsonBody, safely(async (req, res) => {
    const { id, approved, reason, error } = parseConfirmation(req.body);
    if (error) return sendError(res, 400, error);
    res.json((await executor.confirmAndExecute(id, { approved, reason })).toJSON());
  }));

  router.get('/capabilities', safely((req, res) => {
    res.json({
      status: 'success',
      capabilities: registry.getSystemManifest(),
      modules: registry.getModuleNames(),
      timestamp: Date.now()
    });
  }));

  router.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      modules: registry.getModuleNames(),
      platform: process.platform,
      nodeVersion: process.version,
      timestamp: Date.now()
    });
  });

  router.get('/history', safely((req, res) => {
    const history = memoryStore.getActionHistory(req.query.limit, req.query.offset);
    res.json({ status: 'success', history, timestamp: Date.now() });
  }));

  return router;
}

module.exports = { createRouter, sendError, localLlmTarget };
