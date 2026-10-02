
export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7777';
const DEFAULT_TIMEOUT_MS = 45000;

export class DaemonClient {
  constructor({ baseUrl = DEFAULT_DAEMON_URL, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.signal = signal;
  }

  async request(path, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    if (this.signal?.aborted) return { status: 'error', error: 'Stopped.', aborted: true };
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
      const data = await res.json().catch(() => null);
      if (data && typeof data === 'object') return data;
      return { status: 'error', error: `OS Control helper: unreadable reply (HTTP ${res.status})` };
    } catch (err) {
      if (this.signal?.aborted) return { status: 'error', error: 'Stopped.', aborted: true };
      if (timeout.aborted) return { status: 'error', error: `OS Control helper: no answer after ${Math.round(timeoutMs / 1000)}s` };
      return { status: 'error', error: `OS Control helper is not reachable (${err.message})`, unreachable: true };
    }
  }

  async probe() {
    const r = await this.request('/health', { timeoutMs: 5000 });
    if (r.aborted) return 'stopped';
    if (r.unreachable) return 'down';
    return r.status === 'error' ? 'slow' : 'up';
  }

  async isUp() {
    const r = await this.request('/health', { timeoutMs: 5000 });
    return !r.unreachable && !r.aborted && r.status !== 'error';
  }

  call(module, action, parameters = {}) {
    return this.request('/execute', {
      method: 'POST',
      body: { task_id: `os-${Date.now()}`, module, action, parameters }
    });
  }

  confirm(confirmationId, approved = true) {
    return this.request('/confirm', { method: 'POST', body: { confirmation_id: confirmationId, approved } });
  }

  async fileActions() {
    const d = await this.request('/capabilities', { timeoutMs: 10000 });
    const fs = d && d.capabilities && d.capabilities.filesystem;
    return Object.entries((fs && fs.actions) || {})
      .map(([n, m]) => `filesystem.${n} {${((m && m.parameters) || []).join(', ')}} - ${(m && m.description) || ''}`);
  }
}
