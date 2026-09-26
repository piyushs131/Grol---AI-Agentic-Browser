// One task's lifetime: its record and its control flags. Every run owns its
// own flags, so a run that was replaced (Stop, then a new task) can never be
// revived by the new run clearing a shared "aborted" flag.

export class TaskRun {
  constructor(goal) {
    this.task = {
      id: crypto.randomUUID(),
      goal,
      startedAt: Date.now(),
      steps: [],
      plan: [],
      planIndex: 0,
      // The model's running account of progress; step history alone slides out
      // of the window and the agent loses count on goals like "5 people".
      progressNotes: [],
      // Facts carried across pages (read on one site, typed into another).
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

  // A sleep that Stop cuts short, so a long backoff never delays stopping.
  sleep(ms) {
    if (this.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this._wakers.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
      this._wakers.add(done);
    });
  }

  // Blocks while paused; true if it had to wait (the page may have changed).
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

  // A hand-off the user already answered for this page is not asked again:
  // a checkout with a phone field would otherwise hand off forever.
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
