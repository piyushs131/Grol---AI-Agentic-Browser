#!/usr/bin/env node
// Grol OS Control helper: runs the AgentOS daemon on loopback so the sandboxed
// extension can reach the desktop (screenshots, apps, files) over HTTP.
const fs = require('fs');
const path = require('path');

// Installed copies keep ai-agent-os next to this file; the repo keeps it two levels up.
const ROOT = [path.join(__dirname, 'ai-agent-os'), path.join(__dirname, '..', '..', 'ai-agent-os')]
  .find((dir) => fs.existsSync(dir));
const AgentOSDaemon = require(path.join(ROOT, 'local-daemon', 'server'));

// launchd would restart a hung helper only after SIGKILL; exit on our own first.
const STOP_TIMEOUT_MS = 5000;

const logger = {
  info: (m) => console.log(`[os] ${m}`),
  warn: (m) => console.warn(`[os] ${m}`),
  error: (m) => console.error(`[os] ${m}`)
};

function fail(message) {
  logger.error(`failed to start: ${message}`);
  process.exit(1);
}

function createDaemon() {
  try {
    return new AgentOSDaemon({
      port: process.env.GROL_OS_PORT || 7777,
      host: '127.0.0.1',
      // Beside this file, not the cwd: stable under launchd and in the repo alike.
      dataDir: process.env.AGENT_OS_DATA_DIR || path.join(__dirname, '.agent-os-data'),
      logger
    });
  } catch (err) {
    return fail(err.message);
  }
}

const daemon = createDaemon();

daemon.start()
  .then(() => logger.info(`listening on http://127.0.0.1:${daemon.port}`))
  .catch((err) => fail(err.message));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), STOP_TIMEOUT_MS).unref();
  try {
    await daemon.stop();
  } catch (err) {
    logger.error(`stop failed: ${err.message}`);
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
