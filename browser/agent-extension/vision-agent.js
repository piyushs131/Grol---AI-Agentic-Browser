// VisionAgent: the web-page agent loop. One strictly serialised cycle per step:
// settle -> mark -> capture -> decide (one action) -> point -> act -> verify.
// Observation, action execution, loop detection and per-task state live in
// vision-observer.js, vision-actions.js, vision-progress.js and vision-run.js.

import { CdpPageTarget } from './cdp-page-target.js';
import VisionPlanner from './vision-planner.js';
import { PageObserver } from './vision-observer.js';
import { ActionExecutor } from './vision-actions.js';
import { ProgressGuard } from './vision-progress.js';
import { TaskRun } from './vision-run.js';
import {
  startUrlFor, recoveryUrl, pageFlags, describeView, describeAction, actionKey, withDeadline
} from './vision-helpers.js';

const BUSY_NOTICE_INTERVAL_MS = 15000;

const sigKey = CdpPageTarget.sigKey;

export const State = {
  IDLE: 'idle',
  PLANNING: 'planning',
  OBSERVING: 'observing',
  THINKING: 'thinking',
  EXECUTING: 'executing',
  WAITING_FOR_USER: 'waiting_for_user',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted'
};

export const LIMITS = {
  maxSteps: 60,
  maxConsecutiveNoChange: 8,
  maxRepeatsOfSameAction: 3,
  maxPlannerFailures: 4,
  maxNetworkFailures: 7,
  maxDoneRejections: 3,
  maxBlankRestores: 3,
  maxReattaches: 5,
  settleTimeout: 15000,
  postActionSettleTimeout: 12000,
  // Backstop so no single step can wedge the loop.
  actionDeadline: 45000,
  // How long a new task waits for the one it replaced to wind down.
  replaceWait: 4000,
  plannerRetryMs: 1200,
  observeRetryMs: 700,
  verifyRetryMs: 800,
  afterHandoffMs: 600,
  betweenStepsMs: 180
};

// Actions aimed at a screen position: invalid if the page relayouts first.
const POINTER_ACTIONS = new Set(['click', 'click_text', 'type', 'select_option']);
// Actions that deliberately do not touch the page, so "no change" is expected.
const NON_VISUAL = new Set(['wait', 'remember']);

const NETWORK_ERROR_RE = /network connection looks down|fetch failed|ENOTFOUND|EAI_AGAIN|timed out/i;
// Retrying cannot fix these; say so at once instead of after four attempts.
const FATAL_PLANNER_RE = /API key/i;

const isBlankUrl = (u) => !u || u === 'about:blank';

class VisionAgent {
  constructor(options = {}) {
    this.logger = options.logger;
    this.target = options.target || new CdpPageTarget({ logger: this.logger });
    this.planner = new VisionPlanner({ logger: this.logger, onModelBusy: () => this._reportModelBusy() });
    this.observer = new PageObserver({ target: this.target, logger: this.logger });
    this.limits = { ...LIMITS, ...(options.limits || {}) };
    this.state = State.IDLE;
    this._run = null;
  }

  get task() { return this._run ? this._run.task : null; }

  // A slow or overloaded model otherwise looks exactly like a frozen task.
  _reportModelBusy() {
    const now = Date.now();
    if (!this._run || now - (this._busyNoticeAt || 0) < BUSY_NOTICE_INTERVAL_MS) return;
    this._busyNoticeAt = now;
    this.emit('agent:action-log', { actionType: 'retry', description: 'Gemini is busy — trying another model' });
  }
  get running() { return !!(this._run && this._run.active); }

  // sendMessage rejects when no UI is listening (panel closed) - that's fine.
  emit(channel, data) {
    try {
      const sent = chrome.runtime.sendMessage({ type: channel, data });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (_) {}
  }

  // A replaced run keeps winding down in the background; it must not repaint
  // the UI of the run that replaced it.
  _setState(run, next) {
    if (run !== this._run) return;
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.logger?.info(`[Agent] ${prev} -> ${next}`);
    this.emit('agent:status-change', { oldState: prev, newState: next, status: next, task: run.task });
  }

  async startTask(goal) {
    const text = String(goal ?? '').trim();
    if (!text) return { success: false, error: 'Goal is required' };

    const previous = this._run;
    if (previous && previous.active) {
      this.logger?.warn('[Agent] task already running - stopping it first');
      this._stop(previous);
      let timer;
      await Promise.race([previous.done, new Promise((r) => { timer = setTimeout(r, this.limits.replaceWait); })]);
      clearTimeout(timer);
    }

    const run = new TaskRun(text);
    this._run = run;
    this._setState(run, State.PLANNING);

    let plan;
    try {
      const tabId = await this.target.resolve({ force: true, fresh: true });
      if (!tabId) {
        await this._fail(run, 'No browser page available to control');
        return { success: false, error: 'No browser page available' };
      }
      plan = await this._planAndOpen(run);
    } catch (err) {
      await this._fail(run, 'Could not start: ' + err.message);
      return { success: false, error: err.message };
    }
    if (run.aborted) {
      await this._finishAborted(run);
      return { success: false, aborted: true, error: 'Task stopped by user' };
    }
    if (plan.fatal) {
      await this._fail(run, plan.fatal);
      return { success: false, error: plan.fatal };
    }

    run.task.plan = plan.steps;
    this.emit('agent:plan-steps', { steps: plan.steps });
    this._runLoop(run)
      .catch((err) => {
        this.logger?.error('[Agent] loop crashed: ' + (err && err.stack || err));
        return this._fail(run, (err && err.message) || String(err));
      })
      .finally(() => run.finish());
    return { success: true, taskId: run.id };
  }

  // Plan and open the first site in parallel.
  async _planAndOpen(run) {
    const goal = run.task.goal;
    let fatal = null;
    const planning = this.planner.getInitialPlan(goal)
      .then((p) => (p && Array.isArray(p.steps) && p.steps.length ? p.steps.map(String) : [`Complete the task: ${goal}`]))
      .catch((err) => {
        this.logger?.warn('[Agent] planning failed: ' + err.message);
        if (FATAL_PLANNER_RE.test(err.message)) fatal = err.message;
        return [`Complete the task: ${goal}`];
      });
    const opening = (async () => {
      const dest = startUrlFor(goal, this.target.getURL() || '');
      if (!dest || run.aborted) return;
      this.logger?.info(`[Agent] opening ${dest} while planning`);
      this.emit('agent:action-log', { actionType: 'navigate', description: `Opening ${dest}`, stepIndex: 0 });
      const res = await this.target.loadURL(dest).catch((err) => ({ success: false, error: err.message }));
      if (!res.success) this.logger?.warn('[Agent] first navigation failed: ' + res.error);
    })();
    const [steps] = await Promise.all([planning, opening]);
    return { steps, fatal };
  }

  pauseTask() {
    const run = this._activeRun();
    if (!run) return { success: false, error: 'No task running' };
    run.pause();
    this._setState(run, State.PAUSED);
    return { success: true };
  }

  resumeTask() {
    const run = this._activeRun();
    if (!run) return { success: false, error: 'No task running' };
    if (!run.paused) return { success: true };
    run.resume();
    this._setState(run, run.waitingForUser ? State.WAITING_FOR_USER : State.OBSERVING);
    return { success: true };
  }

  abortTask() {
    const run = this._activeRun();
    if (!run) return { success: false, error: 'No task running' };
    this._stop(run);
    return { success: true };
  }

  resumeAfterUserAction() {
    const run = this._activeRun();
    if (!run || !run.resolveUser({ aborted: false })) {
      return { success: false, error: 'Agent is not waiting for you' };
    }
    this.emit('agent:user-action-complete', {});
    return { success: true };
  }

  getStatus() {
    const task = this.task;
    return {
      state: this.state,
      running: this.running,
      task: task ? { id: task.id, goal: task.goal, steps: task.steps.length, plan: task.plan } : null
    };
  }

  _activeRun() {
    return this._run && this._run.active && !this._run.aborted ? this._run : null;
  }

  _stop(run) {
    run.abort();
    this._setState(run, State.ABORTED);
  }

  async _runLoop(run) {
    const L = this.limits;
    const target = this.target;
    const executor = new ActionExecutor({ target, logger: this.logger, run });
    const guard = new ProgressGuard({ maxRepeats: L.maxRepeatsOfSameAction });
    let step = 0;
    let plannerFailures = 0;
    let pageUnchanged = false;
    let lastGoodUrl = null;         // last page that actually had content
    let blankStreak = 0;
    let blankRestores = 0;
    let blindRecoveries = 0;        // navigations used to escape an unobservable tab
    let doneRejections = 0;
    let reattaches = 0;

    while (step < L.maxSteps) {
      if (run.aborted) break;
      if (await run.waitWhilePaused()) continue;

      this._setState(run, State.OBSERVING);
      const settle = await target.waitForSettle({ timeout: L.settleTimeout });
      if (run.aborted) break;
      if (!target.isAlive()) {
        if (target.cancelledByUser && target.cancelledByUser()) {
          run.abort();
          break;
        }
        // A tab that dies again right after re-attaching must not spin forever.
        if (++reattaches > L.maxReattaches) return this._fail(run, 'Lost control of the browser page repeatedly');
        await target.resolve({ force: true });
        if (!target.isAlive()) return this._fail(run, 'Browser page was closed');
        continue;
      }

      const url = target.getURL();
      const title = target.getTitle();
      await this._refreshTabs(run);

      const stateKey = sigKey(settle.signature || await target.signature());
      const cycleWarning = guard.cycleWarning(stateKey);
      if (cycleWarning) {
        this.logger?.warn(`[Agent] cycle detected - same page state ${guard.revisits(stateKey)}x`);
        for (const s of run.task.steps.slice(-3)) guard.avoid(url, s.summary);
      }

      const sensitive = await this.observer.detectSensitiveScreen(url);
      if (sensitive && !run.handedOff(sensitive.kind, url)) {
        const handoff = await this._waitForUser(run, sensitive);
        if (handoff.aborted) break;
        run.markHandedOff(sensitive.kind, target.getURL() || url);
        run.markHandedOff(sensitive.kind, url);
        pageUnchanged = false;
        continue;
      }

      const view = await this.observer.observe();
      if (run.aborted) break;
      if (!view) {
        // A blank tab has nothing to capture and never will; navigating is the
        // only way out, and does not cost a step.
        const here = target.getURL();
        if (isBlankUrl(here) && blindRecoveries < 2) {
          const dest = this._recoveryUrl(run, lastGoodUrl);
          if (dest) {
            blindRecoveries++;
            this.logger?.warn(`[Agent] nothing to observe at ${here || 'no url'} - navigating to ${dest}`);
            await target.loadURL(dest).catch(() => null);
            await run.sleep(900);
            continue;
          }
        }
        this.logger?.warn('[Agent] observation failed - retrying');
        await run.sleep(L.observeRetryMs);
        step++;
        continue;
      }

      // A blank page is something to undo, not to reason about: restore the
      // last page with content instead of spending model calls on it.
      const blank = view.marks.length === 0 &&
                    (isBlankUrl(url) || (view.analysis &&
                     (view.analysis.onScreenText || '').trim().length < 10));
      if (blank && !lastGoodUrl && isBlankUrl(url) && blindRecoveries < 2) {
        const dest = this._recoveryUrl(run, null);
        if (dest) {
          blindRecoveries++;
          this.logger?.warn(`[Agent] blank tab - going straight to ${dest}`);
          await target.loadURL(dest).catch(() => null);
          continue;
        }
      }
      if (blank) {
        blankStreak++;
        // Bounded: a page that is blank for good must reach the model, not
        // bounce between restore and blank forever.
        if (lastGoodUrl && blankStreak >= 2 && blankRestores < L.maxBlankRestores) {
          blankRestores++;
          this.logger?.warn(`[Agent] page is blank (${url}) - restoring ${lastGoodUrl}`);
          await target.loadURL(lastGoodUrl).catch(() => null);
          blankStreak = 0;
          await run.sleep(600);
          continue;
        }
        if (blankStreak <= 4) {
          this.logger?.warn(`[Agent] page is blank (${url}) - waiting for it to render`);
          await run.sleep(1000);
          continue;
        }
      } else {
        blankStreak = 0;
        if (!isBlankUrl(url)) lastGoodUrl = url;
      }

      this.logger?.info('[Agent] view: ' + describeView(url, title, view));

      // Paused while observing: look again, the user may have used the page.
      if (await run.waitWhilePaused()) continue;

      this._setState(run, State.THINKING);
      let action;
      try {
        action = await this.planner.decide({
          goal: run.task.goal,
          plan: run.task.plan,
          url,
          title,
          shot: view.shot,
          marks: view.marks,
          analysis: view.analysis,
          counts: view.counts,
          blockers: view.blockers,
          menus: view.menus,
          sliders: view.sliders,
          scroll: view.scroll,
          progressNotes: run.task.progressNotes,
          notes: run.task.notes,
          tabs: run.tabs,
          history: run.task.steps.slice(-8),
          pageUnchanged,
          avoid: guard.avoidList(url),
          stuckWarning: cycleWarning || guard.stuckWarning()
        });
        if (!action || typeof action.action !== 'string') throw new Error('AI returned no action');
        plannerFailures = 0;
      } catch (err) {
        if (run.aborted) break;
        const message = (err && err.message) || String(err);
        plannerFailures++;
        this.logger?.error(`[Agent] decide failed (${plannerFailures}): ${message}`);
        if (FATAL_PLANNER_RE.test(message)) return this._fail(run, message);

        // Network trouble gets a longer leash and backoff than a model that
        // genuinely cannot decide.
        const isNetwork = NETWORK_ERROR_RE.test(message);
        const budget = isNetwork ? L.maxNetworkFailures : L.maxPlannerFailures;
        if (plannerFailures >= budget) {
          return this._fail(run,
            (isNetwork ? 'Lost connection to the AI service: ' : 'AI could not decide what to do: ') + message);
        }
        const backoff = isNetwork
          ? Math.min(20000, 2500 * Math.pow(1.8, plannerFailures - 1))
          : L.plannerRetryMs;
        this.logger?.info(`[Agent] retrying in ${Math.round(backoff / 1000)}s`);
        await run.sleep(backoff);
        continue;
      }

      if (run.aborted) break;
      this._absorbObservation(run, action.observation);
      step++;

      if (action.action === 'done') {
        // Never take "done" on trust, and fail closed: a rejected claim goes
        // back to the model, an unverifiable one is reported as unverified.
        let verdict = await this._verifyDone(run, action);
        if (!verdict && !run.aborted) {
          await run.sleep(L.verifyRetryMs);
          verdict = await this._verifyDone(run, action);
        }
        if (run.aborted) break;

        if (!verdict) return this._complete(run, action.summary, { verified: false });
        if (!verdict.complete) {
          doneRejections++;
          const missing = verdict.missing || 'the page does not show the task finished';
          this.logger?.warn(`[Agent] rejected "done" (${doneRejections}) - ${missing}`);
          if (doneRejections >= L.maxDoneRejections) return this._fail(run, `Not finished: ${missing}`);
          run.task.progressNotes.push(
            `A completion check REJECTED the claim "${String(action.summary ?? '').slice(0, 120)}". ` +
            `Still missing: ${missing}. ` +
            (verdict.next ? `Do this next: ${verdict.next}` : '')
          );
          pageUnchanged = false;
          continue;
        }
        if (verdict.evidence) this.logger?.info('[Agent] completion verified: ' + verdict.evidence);
        return this._complete(run, action.summary, { verified: true });
      }
      if (action.action === 'ask_user') {
        const handoff = await this._waitForUser(run, { kind: 'assist', message: action.question });
        if (handoff.aborted) break;
        pageUnchanged = false;
        continue;
      }

      const key = actionKey(url, action);
      if (guard.recordAction(key, stateKey)) {
        // Skipping would leave the page frozen and the same action proposed
        // again. Escape usually closes whatever makes it fail, and always
        // produces a fresh observation.
        this.logger?.warn('[Agent] blocking a repeated action, pressing Escape instead: ' + key);
        guard.avoid(url, describeAction(action, view));
        action = { action: 'key', key: 'Escape', observation: action.observation,
                   reasoning: 'forced recovery - the same action was proposed repeatedly' };
      }

      // Rects measured for the screenshot are stale once the viewport resizes
      // (e.g. the side panel opening mid-run); re-observe rather than misclick.
      if (POINTER_ACTIONS.has(action.action) && view.viewport) {
        const now = await target.metrics();
        if (now && (now.w !== view.viewport.w || now.h !== view.viewport.h)) {
          this.logger?.warn(
            `[Agent] page relayouted mid-step (${view.viewport.w}x${view.viewport.h} -> ` +
            `${now.w}x${now.h}) - re-observing instead of clicking a stale position`
          );
          pageUnchanged = false;
          await run.sleep(400);
          continue;
        }
      }

      // Paused while deciding: the decision may be about a page that changed.
      if (await run.waitWhilePaused()) continue;
      if (run.aborted) break;

      this._setState(run, State.EXECUTING);
      const description = describeAction(action, view);
      this.emit('agent:action-log', { actionType: action.action, description, stepIndex: step });

      const before = settle.signature || await target.signature();
      const exec = executor.start(action, view);
      const result = await withDeadline(exec.promise, L.actionDeadline, action.action);
      if (result.timedOut) exec.cancel();
      if (run.aborted) break;

      const after = await target.waitForSettle({ timeout: L.postActionSettleTimeout });
      const afterSig = after.signature || await target.signature();
      const changed = sigKey(before) !== sigKey(afterSig);
      pageUnchanged = !changed && !NON_VISUAL.has(action.action);
      const noChangeStreak = guard.recordOutcome({ changed, nonVisual: NON_VISUAL.has(action.action) });
      if (pageUnchanged) guard.avoid(url, description);
      else if (changed && target.getURL() !== url) guard.forget(url);

      const outcome = !result.success
        ? 'FAILED: ' + (result.error || 'unknown')
        : (changed ? 'page changed' : 'no visible change');
      this.logger?.[result.success ? 'info' : 'warn'](`[Agent] step ${step}: ${description} -> ${outcome}`);

      const obs = action.observation;
      run.task.steps.push({
        step,
        summary: description,
        outcome,
        note: obs && obs.state && obs.state !== 'ok'
          ? `page was ${obs.state}` + (obs.blocker ? ': ' + obs.blocker : '')
          : (result.covered ? 'target was under an overlay' : ''),
        url,
        reasoning: action.reasoning
      });

      if (noChangeStreak >= L.maxConsecutiveNoChange) {
        return this._fail(run, `Stopped after ${noChangeStreak} actions that changed nothing on ${url}`);
      }

      await run.sleep(L.betweenStepsMs);
    }

    if (run.aborted) return this._finishAborted(run);
    return this._fail(run, `Reached the ${L.maxSteps}-step limit without finishing`);
  }

  _recoveryUrl(run, lastGoodUrl) {
    return recoveryUrl({ plan: run.task.plan || [], goal: run.task.goal || '', lastGoodUrl });
  }

  async _refreshTabs(run) {
    try {
      const open = await chrome.tabs.query({ currentWindow: true });
      run.tabs = open.map((t, i) => ({ index: i, title: t.title, url: t.url, active: t.active }));
    } catch (_) { run.tabs = []; }
  }

  // Fold the model's own reading of the page into task state and the UI.
  _absorbObservation(run, observation) {
    if (!observation || typeof observation !== 'object') return;
    const task = run.task;
    const progress = String(observation.progress ?? '').trim();
    if (progress) {
      const notes = task.progressNotes;
      if (notes[notes.length - 1] !== progress) notes.push(progress);
      if (notes.length > 6) notes.shift();
    }
    // UI progress follows the plan step the model says it is on, not the
    // number of actions taken.
    const planLen = (task.plan || []).length;
    const planStep = Number(observation.planStep);
    if (Number.isInteger(planStep) && planStep > 0 && planLen) {
      const index = Math.min(planStep, planLen) - 1;
      if (index !== task.planIndex) {
        task.planIndex = index;
        if (run === this._run) this.emit('agent:plan-progress', { index });
      }
    }
    if (observation.page) {
      this.logger?.info(
        `[Agent] read: ${observation.page} (state=${observation.state}` +
        (observation.blocker ? `, blocked by ${observation.blocker}` : '') + ')'
      );
    }
  }

  // Re-observe and have the model find evidence for its "done" claim.
  // Returns null when the check could not run.
  async _verifyDone(run, action) {
    const proof = await this.observer.observe().catch(() => null);
    if (!proof || run.aborted) return null;
    try {
      return await this.planner.verifyDone({
        goal: run.task.goal,
        claim: action.summary,
        url: this.target.getURL(),
        title: this.target.getTitle(),
        shot: proof.shot,
        marks: proof.marks,
        analysis: proof.analysis,
        counts: proof.counts,
        plan: run.task.plan,
        notes: run.task.notes,
        history: run.task.steps.slice(-12)
      }) || null;
    } catch (err) {
      this.logger?.warn('[Agent] completion check failed: ' + err.message);
      return null;
    }
  }

  async _waitForUser(run, request) {
    this._setState(run, State.WAITING_FOR_USER);
    if (run === this._run) this.emit('agent:require-user-action', request);
    this.logger?.info('[Agent] handing control to the user: ' + request.kind);

    const outcome = await run.waitForUser();
    if (!outcome.aborted) {
      this._setState(run, run.paused ? State.PAUSED : State.OBSERVING);
      await run.sleep(this.limits.afterHandoffMs);
    }
    return outcome;
  }

  async _hideCursor() {
    try { await this.target.executeJS('window.__grolCursor && window.__grolCursor.hide()'); } catch (_) {}
  }

  async _finishAborted(run) {
    if (run.finished) return { success: false, aborted: true };
    this._setState(run, State.ABORTED);
    run.task.state = State.ABORTED;
    run.task.finishedAt = Date.now();
    if (run === this._run) await this._hideCursor();
    this.emit('agent:task-complete', { success: false, result: 'Task stopped by user', taskId: run.id });
    run.finish();
    return { success: false, aborted: true };
  }

  async _complete(run, summary, { verified = true } = {}) {
    if (run.finished) return { success: true, summary };
    this._setState(run, State.COMPLETED);
    this.logger?.info(`[Agent] task complete${verified ? '' : ' (UNVERIFIED)'}: ` + summary);
    Object.assign(run.task, { state: State.COMPLETED, finishedAt: Date.now(), result: summary, verified });
    if (run === this._run) await this._hideCursor();
    this.emit('agent:task-complete', { success: true, verified, result: summary, taskId: run.id });
    run.finish();
    return { success: true, summary };
  }

  async _fail(run, reason) {
    if (run.finished) return { success: false, error: reason };
    this._setState(run, State.FAILED);
    this.logger?.error('[Agent] task failed: ' + reason);
    Object.assign(run.task, { state: State.FAILED, finishedAt: Date.now(), error: reason });
    if (run === this._run) await this._hideCursor();
    this.emit('agent:task-complete', { success: false, result: reason, taskId: run.id });
    run.finish();
    return { success: false, error: reason };
  }
}

export { VisionAgent };
export default VisionAgent;
