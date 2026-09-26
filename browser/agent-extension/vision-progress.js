// Loop detection for the agent: repeated actions, page states it keeps
// returning to, actions that changed nothing, and what not to retry per page.

import { stuckWarning } from './vision-helpers.js';

export class ProgressGuard {
  constructor({ maxRepeats = 3, stateWindow = 10, actionWindow = 8 } = {}) {
    this.maxRepeats = maxRepeats;
    this.stateWindow = stateWindow;
    this.actionWindow = actionWindow;
    this.noChangeStreak = 0;
    this._avoid = new Map();       // url -> Set(action description)
    this._actions = [];
    this._states = [];             // page signatures seen when acting
  }

  avoid(url, description) {
    if (!description) return;
    if (!this._avoid.has(url)) this._avoid.set(url, new Set());
    this._avoid.get(url).add(description);
  }

  avoidList(url) { return Array.from(this._avoid.get(url) || []); }

  forget(url) { this._avoid.delete(url); }

  // Two actions that undo each other (open picker, close picker...) change
  // the page every time, so only revisiting the same page state catches it.
  // Counts only states the agent acted on: a retry after a failed model call
  // is not a revisit.
  revisits(stateKey) {
    return this._states.filter((k) => k === stateKey).length + 1;
  }

  cycleWarning(stateKey) {
    const n = this.revisits(stateKey);
    if (n < 3) return null;
    return `You have returned to this exact page state ${n} times. Your last few ` +
      `actions are undoing each other. Something on this page must be changed ` +
      `FIRST (a mode, a trip type, a filter, an option in a menu) before the ` +
      `action you keep retrying can work.`;
  }

  // True when this exact action was already tried too often recently.
  recordAction(key, stateKey) {
    this._actions.push(key);
    if (this._actions.length > this.actionWindow) this._actions.shift();
    if (stateKey) {
      this._states.push(stateKey);
      if (this._states.length > this.stateWindow) this._states.shift();
    }
    return this._actions.filter((k) => k === key).length > this.maxRepeats;
  }

  stuckWarning() { return stuckWarning(this._actions); }

  // Waiting or noting deliberately leaves the page alone: it neither counts
  // as a dead action nor proves progress.
  recordOutcome({ changed, nonVisual }) {
    if (changed) this.noChangeStreak = 0;
    else if (!nonVisual) this.noChangeStreak++;
    return this.noChangeStreak;
  }
}
