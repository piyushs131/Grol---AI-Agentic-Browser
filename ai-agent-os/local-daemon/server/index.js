// AgentOS daemon: exposes the OS capability modules to the Grol extension over
// HTTP on loopback (/health, /capabilities, /execute, /confirm, /history).

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const ModuleRegistry = require('../module-registry');
const ActionExecutor = require('../executor');
const { createRouter, sendError } = require('../router');
const MemoryStore = require('../../memory/sqlite');
const DaemonLogger = require('../../memory/logs');
const { normalizeLogger } = DaemonLogger;

const FilesystemModule = require('../../modules/filesystem');
const ProcessModule = require('../../modules/process');
const BrowserModule = require('../../modules/browser');
const DesktopModule = require('../../modules/desktop');
const ScreenModule = require('../../modules/screen');
const SchedulerModule = require('../../modules/scheduler');

const DEFAULT_PORT = 7777;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', '.agent-os-data');
const EXTENSION_ORIGIN = 'chrome-extension://ebhlbffbihmgefabpeglnhjadadhcmjc';
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const MAX_BODY = '50mb';
// In-flight requests get this long to finish before stop() cuts them off.
const SHUTDOWN_GRACE_MS = 2000;
const IDLE_SWEEP_MS = 50;

const DEFAULT_MODULES = [
  ['filesystem', () => new FilesystemModule()],
  ['process', () => new ProcessModule()],
  ['browser', () => new BrowserModule()],
  ['desktop', () => new DesktopModule()],
  ['screen', () => new ScreenModule()],
  ['scheduler', () => new SchedulerModule()]
];

// A browser attaches an Origin header to every cross-site POST, so without
// this any website the user visits could POST /execute (and /confirm its own
// shell command). Requests with no Origin come from local programs, not pages.
function createOriginCheck(extraOrigins = process.env.GROL_ALLOWED_ORIGINS) {
  const allowed = new Set([
    EXTENSION_ORIGIN,
    ...String(extraOrigins || '').split(',').map((o) => o.trim()).filter((o) => o && o !== 'null')
  ]);
  return (origin) => origin === undefined || allowed.has(origin);
}

// DNS rebinding: a hostile domain can resolve to 127.0.0.1 and then look
// same-origin to itself. Only answer requests addressed to loopback names.
const isAllowedHost = (host) => LOOPBACK_HOST.test(String(host || ''));

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`Invalid port: ${value}`);
  return port;
}

function requestGuard(isAllowedOrigin, logger) {
  return (req, res, next) => {
    if (!isAllowedHost(req.headers.host)) return sendError(res, 403, 'Host not allowed');
    if (!isAllowedOrigin(req.headers.origin)) {
      logger.warn(`Blocked request from origin ${req.headers.origin} to ${req.path}`);
      return sendError(res, 403, 'Origin not allowed');
    }
    next();
  };
}

// Body-parser and unexpected failures would otherwise get Express's HTML page,
// which includes the stack trace outside production.
function jsonErrorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 500) logger.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`);
    const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body'
      : err.type === 'entity.too.large' ? `Request body exceeds ${MAX_BODY}`
        : status < 500 ? err.message : 'Internal server error';
    sendError(res, status, message);
  };
}

// Keep-alive sockets that go idle after close() would otherwise hold it open
// until the grace period, so idle ones are swept as they appear.
async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(() => resolve()));
  const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
  const grace = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  server.closeIdleConnections();
  await closed;
  clearInterval(sweep);
  clearTimeout(grace);
}

class AgentOSDaemon {
  constructor(options = {}) {
    this.port = parsePort(options.port ?? process.env.AGENT_OS_PORT ?? DEFAULT_PORT);
    this.host = options.host || process.env.AGENT_OS_HOST || DEFAULT_HOST;
    this.dataDir = path.resolve(options.dataDir || process.env.AGENT_OS_DATA_DIR || DEFAULT_DATA_DIR);
    this.moduleFactories = options.modules || DEFAULT_MODULES;
    this.executorOptions = { confirmationTtlMs: options.confirmationTtlMs ?? process.env.AGENT_OS_CONFIRM_TIMEOUT_MS };
    this.externalLogger = options.logger ? normalizeLogger(options.logger) : null;
    this.logger = this.externalLogger || normalizeLogger(null);
    this.registry = null;
    this.executor = null;
    this.memoryStore = null;
    this.server = null;
    this._starting = null;
    this._stopping = null;
  }

  get isRunning() {
    return Boolean(this.server?.listening);
  }

  async start() {
    if (this._starting || this.server) throw new Error('Daemon already started');
    this._starting = this._afterStopping(() => this._start()).catch(async (err) => {
      await this._teardownOnce();
      throw err;
    });
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  // Safe to call at any time, any number of times, even concurrently.
  async stop() {
    if (this._starting) await this._starting.catch(() => {});
    return this._teardownOnce();
  }

  async _afterStopping(fn) {
    if (this._stopping) await this._stopping;
    return fn();
  }

  _teardownOnce() {
    if (!this._stopping) {
      this._stopping = this._teardown().finally(() => { this._stopping = null; });
    }
    return this._stopping;
  }

  async _start() {
    this._openResources();
    this.logger.info('Starting AI Agent OS Daemon...');
    await this._registerModules();
    this.server = http.createServer(this._createApp());
    await this._listen();
    this.logger.info(`AI Agent OS Daemon running at http://${this.host}:${this.port}`);
    this.logger.info(`Registered modules: ${this.registry.getModuleNames().join(', ')}`);
  }

  _openResources() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!this.externalLogger) {
      this.logger = normalizeLogger(new DaemonLogger(path.join(this.dataDir, 'daemon.log')));
    }
    this.registry = new ModuleRegistry(this.logger);
    this.memoryStore = new MemoryStore(path.join(this.dataDir, 'agent-os.db'), { logger: this.logger });
    this.executor = new ActionExecutor(this.registry, this.logger, this.memoryStore, this.executorOptions);
  }

  async _teardown() {
    const { server, registry, memoryStore, logger } = this;
    this.server = null;
    this.memoryStore = null;
    this.executor = null;
    await closeServer(server);
    await registry?.shutdownAll();
    memoryStore?.close();
    if (server) logger.info('AI Agent OS Daemon stopped');
    if (!this.externalLogger) {
      logger.close();
      this.logger = normalizeLogger(null);
    }
  }

  // The extension only knows this port, so a busy port is fatal rather than moved.
  _listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.off('listening', onListening);
        reject(err.code === 'EADDRINUSE' ? new Error(`Port ${this.port} is already in use`) : err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        this.port = this.server.address().port;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
  }

  _createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.use(requestGuard(createOriginCheck(), this.logger));
    // Only origins that passed the guard reach this, so reflecting them is safe.
    app.use(cors({ origin: true, methods: ['GET', 'POST'], credentials: false }));
    // Screenshots and file contents travel in request/response bodies.
    app.use(express.json({ limit: MAX_BODY }));
    app.use('/', createRouter(this.executor, this.registry, this.memoryStore));
    app.use((req, res) => sendError(res, 404, `Route not found: ${req.method} ${req.path}`));
    app.use(jsonErrorHandler(this.logger));
    return app;
  }

  async _registerModules() {
    const context = { dataDir: this.dataDir, logger: this.logger, platform: process.platform };
    for (const [name, create] of this.moduleFactories) {
      try {
        await this.registry.registerModule(name, create(), context);
      } catch (err) {
        this.logger.warn(`Module '${name}' failed to register (non-fatal): ${err.message}`);
      }
    }
  }
}

module.exports = AgentOSDaemon;
module.exports.EXTENSION_ORIGIN = EXTENSION_ORIGIN;
module.exports.isAllowedHost = isAllowedHost;
module.exports.createOriginCheck = createOriginCheck;
