import { runOsTask } from './os-agent.js';

const STORE_KEY = 'osTask';
const MAX_EVENTS = 400;
const REPLACE_WAIT_MS = 3000;
const LIVE = new Set(['thinking', 'executing', 'paused', 'waiting_for_user']);
export const INTERRUPTED = 'Interrupted: the browser restarted its background worker. Run the task again.';

export class OsTaskController {
  constructor({ run = runOsTask, send = () => {}, storage = null, keepAlive = () => () => {}, logger } = {}) {
    this.run = run;
    this.send = send;
    this.storage = storage;
    this.keepAlive = keepAlive;
    this.logger = logger;
    this.current = null;
    this.last = null;
    this.seq = 0;
  }

  broadcast(task, type, data = {}) {
    const msg = { type, data: { ...data, taskId: task.id } };
    if (type !== 'os:confirm-request') {
      task.events.push(msg);
      if (task.events.length > MAX_EVENTS) task.events.splice(1, task.events.length - MAX_EVENTS);
    }
    try { Promise.resolve(this.send(msg)).catch(() => {}); } catch (_) {}
    this.persist();
  }

  setState(task, state) {
    task.state = state;
    this.broadcast(task, 'os:state', { state });
  }

  snapshot(task = this.current || this.last) {
    return task ? { taskId: task.id, goal: task.goal, state: task.state, events: task.events,
      pendingConfirm: task.pendingConfirm || null } : null;
  }

  persist() {
    if (!this.storage) return;
    Promise.resolve()
      .then(() => this.storage.set(STORE_KEY, this.snapshot()))
      .catch((e) => this.logger?.warn('[os] could not save task state: ' + e.message));
  }

  async restore() {
    if (!this.storage || this.current) return;
    let saved = null;
    try { saved = await this.storage.get(STORE_KEY); } catch (_) { return; }
    if (this.current) return;
    if (!saved || typeof saved !== 'object' || !saved.taskId || !Array.isArray(saved.events)) return;
    const task = { id: saved.taskId, goal: String(saved.goal || ''), state: saved.state, events: saved.events,
      pendingConfirm: null, finished: true };
    this.last = task;
    if (LIVE.has(task.state)) {
      task.state = 'failed';
      this.broadcast(task, 'os:done', { success: false, result: INTERRUPTED, state: 'failed' });
    }
  }

  async start(goal, apiKey) {
    const previous = this.current;
    if (previous) {
      this.stop();
      await Promise.race([previous.done, new Promise((r) => setTimeout(r, REPLACE_WAIT_MS))]);
    }
    const task = {
      id: `os-${Date.now()}-${++this.seq}`, goal, state: 'thinking', events: [], pendingConfirm: null,
      aborted: false, paused: false, resumers: [], confirmWaits: new Map(), controller: new AbortController()
    };
    this.current = task;
    this.broadcast(task, 'os:started', { goal });
    const stopKeepAlive = this.keepAlive();
    task.done = Promise.resolve()
      .then(() => this.run(goal, this.hooks(task, apiKey)))
      .catch((e) => ({ success: false, result: e && e.message ? e.message : String(e) }))
      .then((out) => this.finish(task, out || {}))
      .finally(() => stopKeepAlive());
    return task.id;
  }

  hooks(task, apiKey) {
    return {
      apiKey,
      signal: task.controller.signal,
      isAborted: () => task.aborted,
      waitIfPaused: async () => {
        if (!task.paused || task.aborted) return false;
        await new Promise((r) => task.resumers.push(r));
        return true;
      },
      emit: (tag, text, tone, detail) => {
        if (task.aborted) return;
        if (/^\d+$/.test(tag) && task.state !== 'paused') this.setState(task, 'executing');
        this.broadcast(task, 'os:log', { tag, text, tone, detail });
      },
      askConfirm: (req) => new Promise((resolve) => {
        if (task.aborted) return resolve(false);
        const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        task.pendingConfirm = { id, ...req };
        task.confirmWaits.set(id, (allow) => {
          task.confirmWaits.delete(id);
          task.pendingConfirm = null;
          if (allow && !task.paused && !task.aborted) this.setState(task, 'executing');
          resolve(allow);
        });
        this.setState(task, 'waiting_for_user');
        this.broadcast(task, 'os:confirm-request', { id, ...req });
      })
    };
  }

  finish(task, out) {
    const state = task.aborted ? 'aborted' : out.success ? 'completed' : 'failed';
    task.state = state;
    task.pendingConfirm = null;
    task.finished = true;
    if (this.current === task) this.current = null;
    if (!this.current) this.last = task;
    this.broadcast(task, 'os:done', { success: !!out.success, result: String(out.result ?? ''), state });
  }

  pause() {
    const t = this.current;
    if (!t || t.paused || t.aborted) return false;
    t.paused = true;
    this.setState(t, 'paused');
    return true;
  }

  resume() {
    const t = this.current;
    if (!t || !t.paused || t.aborted) return false;
    t.paused = false;
    this.setState(t, t.pendingConfirm ? 'waiting_for_user' : 'executing');
    t.resumers.splice(0).forEach((r) => r());
    return true;
  }

  stop() {
    const t = this.current;
    if (!t || t.aborted) return false;
    t.aborted = true;
    t.paused = false;
    t.controller.abort();
    t.resumers.splice(0).forEach((r) => r());
    for (const answer of [...t.confirmWaits.values()]) answer(false);
    return true;
  }

  answerConfirm(id, allow) {
    const t = this.current;
    const answer = t && typeof id === 'string' ? t.confirmWaits.get(id) : null;
    if (!answer) return false;
    answer(allow === true);
    return true;
  }
}
