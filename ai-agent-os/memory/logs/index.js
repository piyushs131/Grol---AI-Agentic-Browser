// Leveled logger for the daemon: timestamped lines to the console and a file.

const path = require('path');
const fs = require('fs');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const noop = () => {};
const NOOP_LOGGER = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop, close: noop });

// Accepts any partial logger ({ info, warn, error } from the launcher, say)
// and fills in the missing levels so callers never have to check.
function normalizeLogger(logger) {
  if (!logger) return NOOP_LOGGER;
  const pick = (level, fallback) => (typeof logger[level] === 'function' ? logger[level].bind(logger) : fallback);
  const info = pick('info', noop);
  return {
    debug: pick('debug', noop),
    info,
    warn: pick('warn', info),
    error: pick('error', pick('warn', info)),
    close: pick('close', noop)
  };
}

class DaemonLogger {
  constructor(logFile, { level = 'info' } = {}) {
    this.minLevel = LEVELS[level] || LEVELS.info;
    this.stream = logFile ? openLogStream(logFile) : null;
  }

  _write(level, args) {
    if (LEVELS[level] < this.minLevel) return;

    const message = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    if (this.stream && this.stream.writable) this.stream.write(line + '\n');
  }

  debug(...args) { this._write('debug', args); }
  info(...args) { this._write('info', args); }
  warn(...args) { this._write('warn', args); }
  error(...args) { this._write('error', args); }

  close() {
    if (this.stream) this.stream.end();
    this.stream = null;
  }
}

// A long-lived daemon appends forever, so the previous file is kept as .1 once
// it passes MAX_LOG_BYTES.
function rotateIfLarge(logFile) {
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // No file yet.
  }
}

function openLogStream(logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateIfLarge(logFile);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    // Open/write failures arrive as 'error' events; unhandled they would kill the daemon.
    stream.on('error', (err) => {
      console.error(`[DaemonLogger] log file ${logFile} unusable: ${err.message}`);
      stream.destroy();
    });
    return stream;
  } catch (err) {
    console.error(`[DaemonLogger] Could not open log file ${logFile}: ${err.message}`);
    return null;
  }
}

function safeStringify(value) {
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

module.exports = DaemonLogger;
module.exports.NOOP_LOGGER = NOOP_LOGGER;
module.exports.normalizeLogger = normalizeLogger;
