// Syntax-checks every JS file in the repo, then boots the daemon on a spare port
// and exercises its HTTP contract and safety rules.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const REPO = path.resolve(__dirname, '..', '..');
const ESM_DIRS = [path.join(REPO, 'browser', 'agent-extension')];

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(full) : e.name.endsWith('.js') ? [full] : [];
  });
}

function syntaxCheck() {
  const files = [...jsFiles(path.join(REPO, 'ai-agent-os')), ...jsFiles(path.join(REPO, 'browser'))];
  for (const file of files) {
    const esm = ESM_DIRS.some((d) => file.startsWith(d));
    const args = esm ? ['--input-type=module', '--check'] : ['--check', file];
    execFileSync(process.execPath, args, { input: esm ? fs.readFileSync(file) : undefined, stdio: ['pipe', 'ignore', 'inherit'] });
  }
  console.log(`✓ syntax: ${files.length} files`);
}

async function daemonCheck() {
  const AgentOSDaemon = require('../local-daemon/server');
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'grol-check-'));
  const daemon = new AgentOSDaemon({ port: 0, host: '127.0.0.1', dataDir, logger: { info() {}, warn() {}, error() {} } });
  await daemon.start();
  const base = `http://127.0.0.1:${daemon.port}`;
  const exec = (module, action, parameters = {}, headers = {}) => fetch(`${base}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ task_id: 'check', module, action, parameters })
  });

  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, 'healthy');

    const { capabilities } = await (await fetch(`${base}/capabilities`)).json();
    for (const m of ['filesystem', 'process', 'desktop', 'screen', 'browser', 'scheduler']) {
      assert.ok(capabilities[m], `module ${m} registered`);
    }

    assert.equal((await (await exec('scheduler', 'getTime')).json()).status, 'success');
    assert.equal((await (await exec('process', 'executeCommand', { command: 'echo hi' })).json()).status,
      'requires_confirmation', 'shell commands need confirmation');
    assert.equal((await (await exec('filesystem', 'deleteFile', { path: 'desktop/x' })).json()).status,
      'requires_confirmation', 'deletes need confirmation');
    const denied = await (await exec('filesystem', 'readFile', { path: '/etc/hosts' })).json();
    assert.notEqual(denied.status, 'success', 'system directories are protected');
    assert.equal((await exec('scheduler', 'getTime', {}, { Origin: 'https://evil.example' })).status, 403,
      'web origins are refused');
    console.log('✓ daemon: endpoints, confirmation policy, path and origin protection');
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

syntaxCheck();
daemonCheck().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
