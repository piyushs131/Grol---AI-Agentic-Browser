// HTTP routes of the AgentOS daemon.

const express = require('express');
const { ActionRequest, errorMessage, isPlainObject } = require('../../shared/schemas/action-schema');

const MAX_REASON_LENGTH = 500;

const sendError = (res, code, error) => res.status(code).json({ status: 'error', error, timestamp: Date.now() });

// Handler failures become a JSON 500 carrying the message only, never a stack.
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

function createRouter(executor, registry, memoryStore) {
  const router = express.Router();

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

module.exports = { createRouter, sendError };
