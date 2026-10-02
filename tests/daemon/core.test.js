const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OS_ROOT = path.join(REPO, 'ai-agent-os');
const AgentOSDaemon = require(path.join(OS_ROOT, 'local-daemon', 'server'));
const ModuleRegistry = require(path.join(OS_ROOT, 'local-daemon', 'module-registry'));
const ActionExecutor = require(path.join(OS_ROOT, 'local-daemon', 'executor'));
const { AUTONOMOUS_ACTIONS, RISK_FLOOR } = require(path.join(OS_ROOT, 'local-daemon', 'executor', 'risk-policy'));
const MemoryStore = require(path.join(OS_ROOT, 'memory', 'sqlite'));
const DaemonLogger = require(path.join(OS_ROOT, 'memory', 'logs'));
const { ActionRequest, ActionResponse, MAX_TIMEOUT_MS } = require(path.join(OS_ROOT, 'shared', 'schemas', 'action-schema'));
const { CapabilityModule } = require(path.join(OS_ROOT, 'shared', 'schemas', 'capability-schema'));

const EXT = AgentOSDaemon.EXTENSION_ORIGIN;
const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grol-daemon-test-'));
  tempDirs.push(dir);
  return dir;
}

function captureLogger() {
  const lines = [];
  const push = (level) => (m) => lines.push(`${level} ${m}`);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

class TestKitModule extends CapabilityModule {
  constructor() {
    super('testkit', 'test double');
    this.calls = [];
  }

  async initialize(context) {
    await super.initialize(context);
    const add = (name, handler, meta = {}) => this.registerAction(name, handler, { riskLevel: 'low', ...meta });
    add('echo', (p) => { this.calls.push(['echo', p]); return { echoed: p }; });
    add('critical', (p) => { this.calls.push(['critical', p]); return 'ran'; }, { riskLevel: 'critical' });
    add('gated', () => { this.calls.push(['gated']); return 'ran'; }, { requiresConfirmation: true });
    add('high', () => { this.calls.push(['high']); return 'ran'; }, { riskLevel: 'high' });
    add('syncThrow', () => { throw new Error('sync boom'); });
    add('asyncThrow', async () => { throw new Error('async boom'); });
    add('throwNull', () => { throw null; });
    add('slow', () => new Promise((r) => setTimeout(() => r('late'), 300)));
    add('accessibility', () => { throw new Error('Accessibility permission is required for Grol'); });
    add('refuse', () => { throw new Error('Refusing to send input: Grol is frontmost'); });
    add('bigint', () => ({ n: 1n }));
  }
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body, rawBody, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    const allHeaders = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
    if (host !== undefined) allHeaders.Host = host;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: allHeaders }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let daemon;
let port;
let testkit;
let logger;
let taskSeq = 0;

const execute = (module, action, parameters = {}, extra = {}) => request(port, {
  method: 'POST', path: '/execute', body: { task_id: `t${++taskSeq}`, module, action, parameters, ...extra }
});
const confirm = (body, headers) => request(port, { method: 'POST', path: '/confirm', body, headers });

before(async () => {
  logger = captureLogger();
  daemon = new AgentOSDaemon({ port: 0, host: '127.0.0.1', dataDir: tempDir(), logger });
  await daemon.start();
  port = daemon.port;
  testkit = new TestKitModule();
  await daemon.registry.registerModule('testkit', testkit, {});
});

after(async () => {
  await daemon.stop();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('endpoints', () => {
  test('GET /health', async () => {
    const r = await request(port, { path: '/health' });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'healthy');
    assert.ok(r.json.modules.includes('scheduler'));
  });

  test('GET /capabilities lists every module with described actions', async () => {
    const r = await request(port, { path: '/capabilities' });
    assert.equal(r.status, 200);
    for (const m of ['filesystem', 'process', 'desktop', 'screen', 'browser', 'scheduler']) {
      const actions = r.json.capabilities[m]?.actions;
      assert.ok(actions && Object.keys(actions).length > 0, `${m} has actions`);
      for (const meta of Object.values(actions)) {
        assert.ok(Array.isArray(meta.parameters));
        assert.equal(typeof meta.description, 'string');
        assert.ok(['low', 'medium', 'high', 'critical'].includes(meta.riskLevel));
      }
    }
  });

  test('POST /execute runs a harmless action', async () => {
    const r = await execute('scheduler', 'getTime', { timezone: 'UTC' });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'success');
    assert.equal(r.json.error, null);
    assert.equal(typeof r.json.result.requested, 'string');
    assert.match(r.json.task_id, /^t\d+$/);
  });

  test('scheduler rejects a bad timezone with a clear error', async () => {
    const bad = await execute('scheduler', 'getTime', { timezone: 'Mars/Olympus' });
    assert.equal(bad.json.status, 'error');
    assert.match(bad.json.error, /Unknown timezone/);
    const wrongType = await execute('scheduler', 'getTime', { timezone: 5 });
    assert.match(wrongType.json.error, /IANA/);
  });

  test('GET /history returns logged actions and clamps paging', async () => {
    await execute('scheduler', 'getTime');
    const r = await request(port, { path: '/history?limit=2' });
    assert.equal(r.status, 200);
    assert.equal(r.json.history.length, 2);
    const all = await request(port, { path: '/history?limit=-1&offset=-5' });
    assert.ok(all.json.history.length >= 1 && all.json.history.length <= MemoryStore.MAX_HISTORY_PAGE);
    const junk = await request(port, { path: '/history?limit=abc&offset=xyz' });
    assert.equal(junk.status, 200);
  });

  test('unknown route is a JSON 404', async () => {
    const r = await request(port, { path: '/nope' });
    assert.equal(r.status, 404);
    assert.equal(r.json.status, 'error');
  });

  test('the logger passed in is used and no log file is created', () => {
    assert.ok(logger.lines.some((l) => l.includes('Daemon running at')));
    assert.equal(fs.existsSync(path.join(daemon.dataDir, 'daemon.log')), false);
  });
});

describe('request validation', () => {
  const noStack = (r) => assert.doesNotMatch(r.text, /\n\s+at /, 'no stack trace in response');

  test('malformed JSON is a JSON 400 without a stack trace', async () => {
    const r = await request(port, { method: 'POST', path: '/execute', rawBody: '{"task_id":', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Malformed JSON body');
    noStack(r);
  });

  test('JSON null / string / number bodies are refused', async () => {
    for (const raw of ['null', '"x"', '42']) {
      const r = await request(port, { method: 'POST', path: '/execute', rawBody: raw, headers: { 'Content-Type': 'application/json' } });
      assert.equal(r.status, 400, raw);
      noStack(r);
    }
  });

  test('array body is refused', async () => {
    const r = await request(port, { method: 'POST', path: '/execute', body: [1, 2] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /JSON object/);
  });

  test('missing Content-Type is a 415', async () => {
    const r = await request(port, { method: 'POST', path: '/execute', rawBody: '{}' });
    assert.equal(r.status, 415);
    const c = await request(port, { method: 'POST', path: '/confirm', rawBody: '{}' });
    assert.equal(c.status, 415);
  });

  test('empty object reports every missing field', async () => {
    const r = await request(port, { method: 'POST', path: '/execute', body: {} });
    assert.equal(r.status, 400);
    for (const f of ['task_id', 'module', 'action']) assert.match(r.json.error, new RegExp(`${f} is required`));
  });

  test('oversized body is a JSON 413', async () => {
    const huge = Buffer.alloc(51 * 1024 * 1024, 'a');
    const r = await request(port, { method: 'POST', path: '/execute', rawBody: huge, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 413);
    assert.match(r.json.error, /exceeds/);
  });

  test('parameters of the wrong type are refused; null means none', async () => {
    for (const parameters of ['str', [1], 7, true]) {
      const r = await execute('scheduler', 'getTime', parameters);
      assert.equal(r.status, 400, JSON.stringify(parameters));
      assert.match(r.json.error, /parameters must be an object/);
    }
    const ok = await execute('scheduler', 'getTime', null);
    assert.equal(ok.json.status, 'success');
    const omitted = await request(port, { method: 'POST', path: '/execute', body: { task_id: 'x', module: 'scheduler', action: 'getTime' } });
    assert.equal(omitted.json.status, 'success');
  });

  test('task_id, module, action and timeout types are checked', async () => {
    const cases = [
      { task_id: { a: 1 }, module: 'scheduler', action: 'getTime' },
      { task_id: 'x'.repeat(201), module: 'scheduler', action: 'getTime' },
      { task_id: 'x', module: ['scheduler'], action: 'getTime' },
      { task_id: 'x', module: 'scheduler', action: { a: 1 } },
      { task_id: 'x', module: 'scheduler', action: 'get Time' },
      { task_id: 'x', module: 'scheduler', action: 'getTime', timeout: 'soon' },
      { task_id: 'x', module: 'scheduler', action: 'getTime', timeout: -1 },
      { task_id: 'x', module: 'scheduler', action: 'getTime', timeout: Number.MAX_VALUE * 0 }
    ];
    for (const body of cases) {
      const r = await request(port, { method: 'POST', path: '/execute', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const numeric = await request(port, { method: 'POST', path: '/execute', body: { task_id: 7, module: 'scheduler', action: 'getTime' } });
    assert.equal(numeric.json.status, 'success');
    assert.equal(numeric.json.task_id, 7);
  });

  test('unknown module is a 400 listing valid modules', async () => {
    const r = await execute('kernel', 'panic');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Unknown module: kernel/);
  });

  test('prototype-ish module names never resolve', async () => {
    for (const module of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype']) {
      const r = await execute(module, 'getTime');
      assert.equal(r.status, 400, module);
    }
  });

  test('prototype-ish action names are "not found", never Object.prototype members', async () => {
    for (const action of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      const r = await execute('scheduler', action);
      assert.equal(r.status, 200);
      assert.equal(r.json.status, 'error', action);
      assert.match(r.json.error, /not found/);
    }
    const proto = await execute('scheduler', '__proto__');
    assert.equal(proto.status, 400);
  });

  test('unknown action is an error response naming alternatives', async () => {
    const r = await execute('scheduler', 'teleport');
    assert.equal(r.json.status, 'error');
    assert.match(r.json.error, /Action 'teleport' not found/);
  });

  test('ActionRequest clamps timeout and normalises parameters', () => {
    const req = new ActionRequest({ task_id: 'a', module: 'm', action: 'x', timeout: 1e12, parameters: null });
    assert.equal(req.validate(['m']).valid, true);
    assert.equal(req.timeout, MAX_TIMEOUT_MS);
    assert.deepEqual(req.parameters, {});
    assert.equal(new ActionRequest('garbage').validate().valid, false);
    assert.equal(new ActionRequest(null).validate().valid, false);
  });

  test('ActionResponse.error copes with non-Error values', () => {
    assert.equal(ActionResponse.error('t', undefined).error, 'Unknown error');
    assert.equal(ActionResponse.error('t', null).error, 'Unknown error');
    assert.equal(ActionResponse.error('t', { message: 'm' }).error, 'm');
    assert.equal(ActionResponse.error('t', 42).error, '42');
    assert.equal(ActionResponse.success('t', undefined).toJSON().result, null);
  });
});

describe('action failures', () => {
  test('sync and async throws become error responses', async () => {
    assert.equal((await execute('testkit', 'syncThrow')).json.error, 'sync boom');
    assert.equal((await execute('testkit', 'asyncThrow')).json.error, 'async boom');
  });

  test('throwing a non-Error still yields a string error', async () => {
    const r = await execute('testkit', 'throwNull');
    assert.equal(r.json.status, 'error');
    assert.equal(typeof r.json.error, 'string');
  });

  test('module error messages reach the extension verbatim', async () => {
    assert.equal((await execute('testkit', 'accessibility')).json.error, 'Accessibility permission is required for Grol');
    assert.equal((await execute('testkit', 'refuse')).json.error, 'Refusing to send input: Grol is frontmost');
  });

  test('slow actions time out', async () => {
    const r = await execute('testkit', 'slow', {}, { timeout: 30 });
    assert.equal(r.json.status, 'error');
    assert.match(r.json.error, /timed out after 30ms/);
  });

  test('an unserialisable result is a JSON 500, not a crash', async () => {
    const r = await execute('testkit', 'bigint');
    assert.equal(r.status, 500);
    assert.equal(r.json.status, 'error');
    assert.doesNotMatch(r.text, /\n\s+at /);
    assert.equal((await request(port, { path: '/health' })).status, 200);
  });

  test('secrets and nested secrets are redacted from the history', async () => {
    await execute('testkit', 'echo', { password: 'hunter2', nested: { apiKey: 'sk-live', deeper: { token: 'tok' } }, keep: 'visible' });
    await execute('testkit', 'critical', { secret: 'shh' });
    const { json } = await request(port, { path: '/history?limit=5' });
    const text = JSON.stringify(json.history);
    for (const secret of ['hunter2', 'sk-live', 'tok"', 'shh']) assert.ok(!text.includes(secret), `${secret} leaked`);
    assert.ok(text.includes('visible'));
    assert.ok(text.includes('[REDACTED]'));
  });
});

describe('confirmation flow', () => {
  const ask = async (action = 'critical', parameters = {}) => {
    const r = await execute('testkit', action, parameters);
    assert.equal(r.json.status, 'requires_confirmation');
    return r.json.result;
  };
  const callsOf = (name) => testkit.calls.filter(([n]) => n === name).length;

  test('critical action asks, runs once on confirm, and cannot be replayed', async () => {
    const before = callsOf('critical');
    const pending = await ask('critical', { n: 1 });
    assert.equal(pending.risk_level, 'critical');
    assert.match(pending.confirmation_id, /^[0-9a-f-]{36}$/);
    assert.equal(callsOf('critical'), before, 'nothing ran before confirmation');

    const ok = await confirm({ confirmation_id: pending.confirmation_id });
    assert.equal(ok.json.status, 'success');
    assert.equal(ok.json.result, 'ran');
    assert.equal(callsOf('critical'), before + 1);

    const replay = await confirm({ confirmation_id: pending.confirmation_id });
    assert.equal(replay.json.status, 'error');
    assert.match(replay.json.error, /not found or expired/);
    assert.equal(callsOf('critical'), before + 1);
  });

  test('requiresConfirmation meta is honoured even at low risk', async () => {
    const pending = await ask('gated');
    assert.equal((await confirm({ confirmation_id: pending.confirmation_id, approved: false })).json.status, 'error');
  });

  test('approved:false denies and never runs', async () => {
    const before = callsOf('critical');
    const pending = await ask();
    const r = await confirm({ confirmation_id: pending.confirmation_id, approved: false, reason: 'nope' });
    assert.equal(r.json.status, 'error');
    assert.equal(r.json.error, 'nope');
    assert.equal(callsOf('critical'), before);
    assert.equal((await confirm({ confirmation_id: pending.confirmation_id })).json.status, 'error');
  });

  test('non-boolean approved is refused and keeps the request pending', async () => {
    const before = callsOf('critical');
    const pending = await ask();
    for (const approved of ['false', 'true', 0, 1, null]) {
      const r = await confirm({ confirmation_id: pending.confirmation_id, approved });
      assert.equal(r.status, 400, JSON.stringify(approved));
    }
    assert.equal(callsOf('critical'), before);
    const denied = await confirm({ confirmation_id: pending.confirmation_id, approved: false });
    assert.equal(denied.json.error, 'Action denied by approver');
  });

  test('unknown, missing or malformed confirmation ids', async () => {
    assert.equal((await confirm({ confirmation_id: 'does-not-exist' })).json.status, 'error');
    assert.equal((await confirm({})).status, 400);
    assert.equal((await confirm({ confirmation_id: 123 })).status, 400);
    assert.equal((await confirm({ confirmation_id: ['a'] })).status, 400);
    assert.equal((await confirm({ confirmation_id: 'x', reason: 5 })).status, 400);
    assert.equal((await confirm({ confirmation_id: '__proto__' })).json.status, 'error');
  });

  test('concurrent confirms of one id run the action exactly once', async () => {
    const before = callsOf('critical');
    const pending = await ask();
    const results = await Promise.all(Array.from({ length: 5 }, () => confirm({ confirmation_id: pending.confirmation_id })));
    assert.equal(results.filter((r) => r.json.status === 'success').length, 1);
    assert.equal(callsOf('critical'), before + 1);
  });

  test('confirmations expire', async () => {
    const registry = new ModuleRegistry();
    const kit = new TestKitModule();
    await registry.registerModule('testkit', kit);
    const executor = new ActionExecutor(registry, undefined, null, { confirmationTtlMs: 20 });
    const res = await executor.execute({ task_id: 'e', module: 'testkit', action: 'critical', parameters: {} });
    await new Promise((r) => setTimeout(r, 40));
    const late = await executor.confirmAndExecute(res.result.confirmation_id);
    assert.equal(late.error, 'Confirmation request expired');
    assert.equal(kit.calls.length, 0);
  });

  test('pending confirmations are bounded', async () => {
    const registry = new ModuleRegistry();
    await registry.registerModule('testkit', new TestKitModule());
    const executor = new ActionExecutor(registry, undefined, null, { maxPending: 3 });
    const ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await executor.execute({ task_id: i, module: 'testkit', action: 'critical', parameters: {} })).result.confirmation_id);
    }
    assert.equal(executor.pendingCount, 3);
    assert.equal((await executor.confirmAndExecute(ids[0])).status, 'error', 'oldest evicted');
    assert.equal((await executor.confirmAndExecute(ids[5], { approved: false })).error, 'Action denied by approver');
  });

  test('a garbage TTL from the environment falls back to the default', () => {
    const executor = new ActionExecutor(new ModuleRegistry(), undefined, null, { confirmationTtlMs: 'soon' });
    assert.equal(executor.confirmationTtlMs, 5 * 60 * 1000);
  });

  test('the module vanishing before confirmation is an error, not a crash', async () => {
    const registry = new ModuleRegistry();
    await registry.registerModule('testkit', new TestKitModule());
    const executor = new ActionExecutor(registry);
    const res = await executor.execute({ task_id: 'v', module: 'testkit', action: 'critical', parameters: {} });
    await registry.unregisterModule('testkit');
    const r = await executor.confirmAndExecute(res.result.confirmation_id);
    assert.equal(r.status, 'error');
    assert.match(r.error, /no longer available/);
  });
});

describe('local model relay', () => {
  test('relays to a loopback model server without an Origin and returns its status and body', async () => {
    const http = require('http');
    let seenOrigin = 'unset';
    const model = http.createServer((req, res) => {
      seenOrigin = req.headers.origin;
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ echo: JSON.parse(b || '{}') })); });
    });
    await new Promise((r) => model.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${model.address().port}/v1/chat/completions`;
      const r = await request(port, { method: 'POST', path: '/llm-local', headers: { Origin: EXT }, body: { url, body: { model: 'm' } } });
      assert.equal(r.status, 200);
      assert.equal(r.json.status, 200);
      assert.deepEqual(JSON.parse(r.json.body), { echo: { model: 'm' } });
      assert.equal(seenOrigin, undefined, 'the model server sees no browser Origin');
    } finally {
      model.close();
    }
  });

  test('refuses anything but a loopback model API, and never the daemon itself', async () => {
    for (const url of ['https://example.com/v1/x', 'http://localhost.evil.com:1234/v1/x', `http://127.0.0.1:${port}/v1/x`,
      'http://localhost:11434/execute', 'file:///etc/passwd', 42]) {
      const r = await request(port, { method: 'POST', path: '/llm-local', body: { url } });
      assert.equal(r.status, 400, String(url));
    }
    const r = await request(port, { method: 'POST', path: '/llm-local', body: { url: 'http://localhost:11434/v1/x', method: 'DELETE' } });
    assert.equal(r.status, 400);
  });
});

describe('origin and host guards', () => {
  const routes = [
    { method: 'GET', path: '/health' },
    { method: 'POST', path: '/execute', body: { task_id: 'o', module: 'scheduler', action: 'getTime' } },
    { method: 'POST', path: '/confirm', body: { confirmation_id: 'none' } },
    { method: 'POST', path: '/llm-local', body: { url: 'http://localhost:11434/v1/models', method: 'GET' } }
  ];

  for (const origin of ['https://evil.example', 'null', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'http://127.0.0.1:1234', '']) {
    test(`origin ${JSON.stringify(origin)} is refused everywhere`, async () => {
      for (const route of routes) {
        const r = await request(port, { ...route, headers: { Origin: origin } });
        assert.equal(r.status, 403, `${route.path}`);
        assert.equal(r.json.error, 'Origin not allowed');
      }
    });
  }

  test('the Grol extension origin and origin-less local callers are allowed', async () => {
    for (const headers of [{ Origin: EXT }, {}]) {
      for (const route of routes) {
        const r = await request(port, { ...route, headers });
        assert.equal(r.status, 200, `${route.path} ${JSON.stringify(headers)}`);
      }
    }
    const r = await request(port, { path: '/health', headers: { Origin: EXT } });
    assert.equal(r.headers['access-control-allow-origin'], EXT);
  });

  test('CORS preflight: allowed for the extension, refused for the web', async () => {
    const preflight = (origin) => request(port, {
      method: 'OPTIONS', path: '/execute',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
    });
    const ok = await preflight(EXT);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], EXT);
    assert.match(ok.headers['access-control-allow-methods'], /POST/);
    assert.equal((await preflight('https://evil.example')).status, 403);
  });

  test('loopback Host variants are allowed', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, 'localhost', '127.0.0.1']) {
      const r = await request(port, { path: '/health', host });
      assert.equal(r.status, 200, host);
    }
  });

  test('DNS-rebinding Host values are refused', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.evil:${port}`,
      '0.0.0.0', `[::2]:${port}`, '127.0.0.2', `localhost:${port}@evil`, `127.0.0.1:${port}x`]) {
      const r = await request(port, { path: '/health', host });
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error, 'Host not allowed');
    }
  });

  test('a request without a Host header is not served', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health', setHost: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.notEqual(status, 200);
  });

  test('isAllowedHost / createOriginCheck units', () => {
    assert.equal(AgentOSDaemon.isAllowedHost(undefined), false);
    const check = AgentOSDaemon.createOriginCheck('https://dev.example, null ,');
    assert.equal(check(undefined), true);
    assert.equal(check('https://dev.example'), true);
    assert.equal(check('null'), false, '"null" can never be allow-listed');
    assert.equal(check(''), false);
  });
});

describe('module registry', () => {
  let registry;
  before(async () => {
    registry = new ModuleRegistry();
    for (const name of ['process', 'desktop', 'screen']) {
      const mod = new TestKitModule();
      mod.name = name;
      await registry.registerModule(name, mod);
    }
  });

  test('direct match wins, then alias, then cross-module fallback', () => {
    assert.deepEqual(registry.resolve('process', 'echo'), { module: 'process', action: 'echo' });
    assert.deepEqual(registry.resolve('scheduler', 'echo'), { module: 'process', action: 'echo' });
    assert.equal(registry.resolve('process', 'missing'), null);
  });

  test('prototype member names never resolve', () => {
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '__defineGetter__'];
    for (const m of names) {
      for (const a of names) assert.equal(registry.resolve(m, a), null, `${m}.${a}`);
      assert.equal(registry.resolve(m, 'echo')?.action, 'echo');
      assert.equal(registry.resolve('desktop', m), null);
    }
    assert.equal(daemon.registry.resolve('desktop', 'constructor'), null);
    assert.equal(daemon.registry.resolve('__proto__', 'toString'), null);
  });

  test('aliases resolve against the live modules', () => {
    assert.deepEqual(daemon.registry.resolve('process', 'runCommand'), { module: 'process', action: 'executeCommand' });
    assert.deepEqual(daemon.registry.resolve('desktop', 'killProcess'), { module: 'process', action: 'killProcess' });
    assert.deepEqual(daemon.registry.resolve('screen', 'deleteFile'), { module: 'filesystem', action: 'deleteFile' });
  });

  test('registerModule rejects malformed modules and survives a failing init', async () => {
    const r = new ModuleRegistry();
    await assert.rejects(r.registerModule('x', {}), /missing/);
    await assert.rejects(r.registerModule('', new TestKitModule()), /non-empty/);
    const broken = new TestKitModule();
    broken.initialize = async () => { throw new Error('init failed'); };
    await assert.rejects(r.registerModule('broken', broken), /init failed/);
    assert.deepEqual(r.getModuleNames(), []);
  });

  test('shutdownAll tolerates a module whose shutdown throws', async () => {
    const r = new ModuleRegistry();
    const mod = new TestKitModule();
    mod.shutdown = async () => { throw new Error('nope'); };
    await r.registerModule('t', mod);
    await r.shutdownAll();
    assert.deepEqual(r.getModuleNames(), []);
  });
});

describe('risk policy', () => {
  let capabilities;
  before(async () => {
    capabilities = (await request(port, { path: '/capabilities' })).json.capabilities;
    delete capabilities.testkit;
  });

  const deny = async (id) => {
    const r = await confirm({ confirmation_id: id, approved: false });
    assert.equal(r.json.status, 'error');
  };

  test('every high/critical/requiresConfirmation action asks (via HTTP), except the documented UI set', async () => {
    let asked = 0;
    for (const [module, { actions }] of Object.entries(capabilities)) {
      for (const [action, meta] of Object.entries(actions)) {
        const name = `${module}.${action}`;
        const risky = meta.requiresConfirmation || meta.riskLevel === 'high' || meta.riskLevel === 'critical' || RISK_FLOOR.has(name) &&
          ['high', 'critical'].includes(RISK_FLOOR.get(name));
        if (!risky) continue;
        const { needsConfirmation } = daemon.executor.assess(module, action);
        if (AUTONOMOUS_ACTIONS.has(name)) {
          assert.equal(needsConfirmation, false, `${name} stays autonomous`);
          continue;
        }
        assert.equal(needsConfirmation, true, `${name} must require confirmation`);
        const r = await execute(module, action, { path: 'desktop/grol-test-never-created', command: 'true', name: 'x' });
        assert.equal(r.json.status, 'requires_confirmation', name);
        await deny(r.json.result.confirmation_id);
        asked++;
      }
    }
    assert.ok(asked >= 8, `asked for ${asked} actions`);
  });

  test('autonomous actions are only UI control, never critical or explicitly gated', () => {
    for (const name of AUTONOMOUS_ACTIONS) {
      assert.match(name, /^(desktop|process)\.(pressKey|hotkey|closeApplication)$/);
      const [module, action] = name.split('.');
      const meta = capabilities[module]?.actions[action];
      if (meta) {
        assert.notEqual(meta.riskLevel, 'critical');
        assert.notEqual(meta.requiresConfirmation, true);
      }
    }
  });

  test('file mutations, code execution and uploads always ask', () => {
    for (const name of ['filesystem.writeFile', 'filesystem.appendFile', 'filesystem.copyFile', 'filesystem.moveFile',
      'filesystem.createDirectory', 'filesystem.deleteFile', 'filesystem.deleteDirectory', 'process.executeCommand',
      'desktop.executeCommand', 'process.killProcess', 'browser.evaluate', 'browser.uploadFile']) {
      const [module, action] = name.split('.');
      if (!daemon.registry.resolve(module, action)) continue;
      assert.equal(daemon.executor.assess(module, action).needsConfirmation, true, name);
    }
  });

  test('aliases and cross-module fallbacks inherit the target policy', () => {
    for (const [module, aliases] of ModuleRegistry.ACTION_ALIASES) {
      for (const [action, target] of aliases) {
        const direct = daemon.executor.assess(target.module, target.action);
        const viaAlias = daemon.executor.assess(module, action);
        if (direct.needsConfirmation) assert.equal(viaAlias.needsConfirmation, true, `${module}.${action}`);
      }
    }
    for (const [module, action] of [['screen', 'deleteFile'], ['scheduler', 'killProcess'], ['browser', 'executeCommand'],
      ['process', 'runCommand'], ['desktop', 'killProcess'], ['scheduler', 'writeFile']]) {
      assert.equal(daemon.executor.assess(module, action).needsConfirmation, true, `${module}.${action}`);
    }
  });

  test('fallback-routed dangerous action asks over HTTP too', async () => {
    const r = await execute('screen', 'deleteFile', { path: 'desktop/grol-test-never-created' });
    assert.equal(r.json.status, 'requires_confirmation');
    assert.equal(r.json.result.risk_level, 'critical');
    await deny(r.json.result.confirmation_id);
  });

  test('low-risk actions run without asking', () => {
    assert.equal(daemon.executor.assess('scheduler', 'getTime').needsConfirmation, false);
    assert.equal(daemon.executor.assess('testkit', 'echo').needsConfirmation, false);
    assert.equal(daemon.executor.assess('testkit', 'high').needsConfirmation, true);
  });
});

describe('memory store and logger', () => {
  test('falls back to memory when SQLite cannot open', () => {
    const warnings = [];
    const store = new MemoryStore('/dev/null/nope/agent.db', { logger: { warn: (m) => warnings.push(m) } });
    assert.equal(store.isPersistent, false);
    assert.ok(warnings.length === 1);
    for (let i = 0; i < 5; i++) store.logAction({ task_id: i, module: 'm', action: 'a', status: 'success' });
    assert.deepEqual(store.getActionHistory(2).map((e) => e.task_id), ['4', '3']);
    assert.deepEqual(store.getActionHistory(2, 2).map((e) => e.task_id), ['2', '1']);
    assert.deepEqual(store.getActionHistory(10, 99), []);
    assert.equal(store.getActionHistory(-1).length, 1);
    store.close();
  });

  test('SQLite store persists rows with missing optional fields and clamps paging', () => {
    const store = new MemoryStore(path.join(tempDir(), 'db', 'a.db'));
    if (!store.isPersistent) return;
    for (let i = 0; i < 3; i++) store.logAction({ task_id: `k${i}`, module: 'm', action: 'a', status: 'error', timestamp: i });
    assert.equal(store.getActionHistory(-1).length, 1);
    assert.equal(store.getActionHistory(50, -3).length, 3);
    store.close();
    store.close();
    store.logAction({ task_id: 'after', module: 'm', action: 'a', status: 'success' });
  });

  test('an unusable log file never crashes the process', async () => {
    const dir = tempDir();
    const log = new DaemonLogger(dir);
    const origError = console.error;
    const origLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await new Promise((r) => setTimeout(r, 30));
      log.info('still alive');
      new DaemonLogger('/dev/null/nope/daemon.log').warn('also alive');
    } finally {
      console.error = origError;
      console.log = origLog;
      log.close();
    }
  });

  test('normalizeLogger fills in missing levels', () => {
    const seen = [];
    const l = DaemonLogger.normalizeLogger({ info: (m) => seen.push(m) });
    l.debug('d');
    l.warn('w');
    l.error('e');
    l.close();
    assert.deepEqual(seen, ['w', 'e']);
    DaemonLogger.normalizeLogger(null).info('dropped');
  });
});

describe('lifecycle', () => {
  const silent = { info() {}, warn() {}, error() {} };

  test('stop before start, twice and concurrently is safe', async () => {
    const d = new AgentOSDaemon({ port: 0, dataDir: tempDir(), logger: silent });
    await d.stop();
    await d.start();
    assert.equal(d.isRunning, true);
    await Promise.all([d.stop(), d.stop()]);
    await d.stop();
    assert.equal(d.isRunning, false);
  });

  test('start twice throws; restart after stop works', async () => {
    const d = new AgentOSDaemon({ port: 0, dataDir: tempDir(), logger: silent });
    await d.start();
    await assert.rejects(d.start(), /already started/);
    await d.stop();
    await d.start();
    assert.equal((await request(d.port, { path: '/health' })).status, 200);
    await d.stop();
  });

  test('start right after an unawaited stop, and stop during start, are ordered', async () => {
    const d = new AgentOSDaemon({ port: 0, dataDir: tempDir(), logger: silent });
    await d.start();
    const stopping = d.stop();
    await d.start();
    await stopping;
    assert.equal(d.isRunning, true);
    assert.equal((await request(d.port, { path: '/health' })).status, 200);
    await d.stop();

    const starting = d.start();
    await d.stop();
    await starting;
    assert.equal(d.isRunning, false);
  });

  test('stop lets an in-flight request finish', async () => {
    const d = new AgentOSDaemon({ port: 0, dataDir: tempDir(), logger: silent });
    await d.start();
    await d.registry.registerModule('testkit', new TestKitModule());
    const inFlight = request(d.port, { method: 'POST', path: '/execute', body: { task_id: 's', module: 'testkit', action: 'slow' } });
    await new Promise((r) => setTimeout(r, 50));
    await d.stop();
    assert.equal((await inFlight).json.result, 'late');
  });

  test('a busy port fails instead of moving, and cleans up', async () => {
    const d = new AgentOSDaemon({ port, dataDir: tempDir(), logger: silent });
    await assert.rejects(d.start(), new RegExp(`Port ${port} is already in use`));
    assert.equal(d.isRunning, false);
    assert.equal(d.memoryStore, null);
    await d.stop();
    assert.equal((await request(port, { path: '/health' })).status, 200, 'first daemon unaffected');
  });

  test('invalid ports are rejected up front', () => {
    for (const p of ['abc', -1, 70000, 1.5]) assert.throws(() => new AgentOSDaemon({ port: p }), /Invalid port/);
  });

  test('default data dir does not depend on the cwd', () => {
    const saved = process.env.AGENT_OS_DATA_DIR;
    delete process.env.AGENT_OS_DATA_DIR;
    try {
      assert.equal(new AgentOSDaemon({ port: 0 }).dataDir, path.join(OS_ROOT, '.agent-os-data'));
    } finally {
      if (saved !== undefined) process.env.AGENT_OS_DATA_DIR = saved;
    }
  });

  test('without a logger it writes daemon.log in the data dir and closes it on stop', async () => {
    const dir = tempDir();
    const d = new AgentOSDaemon({ port: 0, dataDir: dir });
    const origLog = console.log;
    console.log = () => {};
    try {
      await d.start();
      await d.stop();
    } finally {
      console.log = origLog;
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.match(fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8'), /Daemon running at/);
  });

  test('a module that fails to register is skipped, not fatal', async () => {
    const d = new AgentOSDaemon({
      port: 0, dataDir: tempDir(), logger: silent,
      modules: [['scheduler', () => new (require(path.join(OS_ROOT, 'modules', 'scheduler')))()], ['bad', () => ({})]]
    });
    await d.start();
    assert.deepEqual(d.registry.getModuleNames(), ['scheduler']);
    await d.stop();
  });

  const runHelper = (env) => spawn(process.execPath, [path.join(REPO, 'browser', 'companion', 'daemon.js')], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const waitFor = (child, pattern) => new Promise((resolve, reject) => {
    let out = '';
    const onData = (c) => { out += c; if (pattern.test(out)) resolve(out); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`exited ${code} before ${pattern}: ${out}`)));
  });
  const exitCode = (child) => new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  test('companion daemon.js starts, and SIGTERM stops it cleanly', async () => {
    const helperPort = await freePort();
    const child = runHelper({ GROL_OS_PORT: String(helperPort), AGENT_OS_DATA_DIR: tempDir() });
    await waitFor(child, /listening on/);
    assert.equal((await request(helperPort, { path: '/health' })).status, 200);
    const exited = exitCode(child);
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  });

  test('companion daemon.js exits 1 on a busy port or a bad port value', async () => {
    const busy = runHelper({ GROL_OS_PORT: String(port), AGENT_OS_DATA_DIR: tempDir() });
    assert.equal(await exitCode(busy), 1);
    const bad = runHelper({ GROL_OS_PORT: 'nope', AGENT_OS_DATA_DIR: tempDir() });
    assert.equal(await exitCode(bad), 1);
  });
});
