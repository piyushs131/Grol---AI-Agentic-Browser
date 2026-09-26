// Action log backed by SQLite (better-sqlite3), with a bounded in-memory
// fallback when the native module is missing, was built for a different Node
// ABI, or the database file cannot be opened.

const path = require('path');
const fs = require('fs');
const { NOOP_LOGGER } = require('../logs');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  // Fall back to memory below.
}

const FALLBACK_MAX = 10000;
const FALLBACK_KEEP = 5000;
const MAX_HISTORY_PAGE = 500;
const DEFAULT_HISTORY_PAGE = 50;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    module TEXT NOT NULL,
    action TEXT NOT NULL,
    parameters TEXT,
    risk_level TEXT DEFAULT 'low',
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    execution_time INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_action_log_task ON action_log(task_id);
  CREATE INDEX IF NOT EXISTS idx_action_log_module ON action_log(module);
  CREATE INDEX IF NOT EXISTS idx_action_log_timestamp ON action_log(timestamp);
`;

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

// SQLite treats a negative LIMIT as "no limit", so pages are always clamped.
function clampPage(limit, offset) {
  return {
    limit: Math.min(Math.max(toInt(limit, DEFAULT_HISTORY_PAGE), 1), MAX_HISTORY_PAGE),
    offset: Math.max(toInt(offset, 0), 0)
  };
}

// Every named parameter must be bound, so absent fields become explicit nulls.
function toRow(entry) {
  return {
    task_id: String(entry.task_id),
    module: String(entry.module),
    action: String(entry.action),
    parameters: entry.parameters ?? null,
    risk_level: entry.risk_level ?? 'low',
    status: String(entry.status),
    result: entry.result ?? null,
    error: entry.error ?? null,
    execution_time: entry.execution_time ?? 0,
    timestamp: entry.timestamp ?? Date.now()
  };
}

class MemoryStore {
  constructor(dbPath, { logger = NOOP_LOGGER } = {}) {
    this.logger = logger;
    this.db = null;
    this.fallbackActions = [];
    if (Database && dbPath) this._open(dbPath);
  }

  get isPersistent() {
    return this.db !== null;
  }

  _open(dbPath) {
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(SCHEMA);
      this.insertAction = this.db.prepare(`
        INSERT INTO action_log (task_id, module, action, parameters, risk_level, status, result, error, execution_time, timestamp)
        VALUES (@task_id, @module, @action, @parameters, @risk_level, @status, @result, @error, @execution_time, @timestamp)
      `);
      this.selectHistory = this.db.prepare('SELECT * FROM action_log ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?');
    } catch (err) {
      this.logger.warn(`SQLite unavailable, keeping the action log in memory: ${err.message}`);
      this.close();
    }
  }

  logAction(entry) {
    const row = toRow(entry);
    if (!this.db) return this._logInMemory(row);
    try {
      this.insertAction.run(row);
    } catch (err) {
      this.logger.warn(`Failed to log action to SQLite: ${err.message}`);
    }
  }

  _logInMemory(row) {
    this.fallbackActions.push(row);
    if (this.fallbackActions.length > FALLBACK_MAX) {
      this.fallbackActions = this.fallbackActions.slice(-FALLBACK_KEEP);
    }
  }

  getActionHistory(limit, offset) {
    const page = clampPage(limit, offset);
    if (!this.db) {
      const end = this.fallbackActions.length - page.offset;
      return end > 0 ? this.fallbackActions.slice(Math.max(end - page.limit, 0), end).reverse() : [];
    }
    try {
      return this.selectHistory.all(page.limit, page.offset);
    } catch (err) {
      this.logger.warn(`Failed to read action history: ${err.message}`);
      return [];
    }
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch {}
    this.db = null;
  }
}

module.exports = MemoryStore;
module.exports.MAX_HISTORY_PAGE = MAX_HISTORY_PAGE;
