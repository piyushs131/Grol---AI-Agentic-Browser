
export class TaskRun {
  constructor(goal) {
    this.task = {
      id: crypto.randomUUID(),
      goal,
      startedAt: Date.now(),
      steps: [],
      plan: [],
      planIndex: 0,
      progressNotes: [],
      notes: [],
      state: 'planning'
    };
    this.aborted = false;
    this.paused = false;
    this.finished = false;
    this.tabs = [];
    this._wakers = new Set();
    this._userResolver = null;
    this._handedOff = new Set();
    this._resolveDone = null;
    this.done = new Promise((resolve) => { this._resolveDone = resolve; });
  }

  get id() { return this.task.id; }
  get active() { return !this.finished; }
  get waitingForUser() { return !!this._userResolver; }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.paused = false;
    this.resolveUser({ aborted: true });
    this._wake();
  }

  pause() { if (!this.aborted) this.paused = true; }

  resume() {
    this.paused = false;
    this._wake();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this._resolveDone();
  }

  sleep(ms) {
    if (this.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this._wakers.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
      this._wakers.add(done);
    });
  }

  async waitWhilePaused() {
    if (!this.paused) return false;
    while (this.paused && !this.aborted) {
      await new Promise((resolve) => this._wakers.add(resolve));
    }
    return true;
  }

  waitForUser() {
    if (this.aborted) return Promise.resolve({ aborted: true });
    this.resolveUser({ aborted: false });
    return new Promise((resolve) => { this._userResolver = resolve; });
  }

  resolveUser(outcome) {
    const resolve = this._userResolver;
    if (!resolve) return false;
    this._userResolver = null;
    resolve(outcome);
    return true;
  }

  handoffKey(kind, url) {
    let where = String(url || '');
    try { const u = new URL(where); where = u.origin + u.pathname; } catch (_) {}
    return kind + '|' + where;
  }

  handedOff(kind, url) { return this._handedOff.has(this.handoffKey(kind, url)); }
  markHandedOff(kind, url) { this._handedOff.add(this.handoffKey(kind, url)); }

  _wake() {
    const wakers = [...this._wakers];
    this._wakers.clear();
    for (const wake of wakers) wake();
  }
}
