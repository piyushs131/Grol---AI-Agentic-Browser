
import { CdpPageTarget } from './cdp-page-target.js';
import VisionPlanner from './vision-planner.js';
import { PageObserver } from './vision-observer.js';
import { ActionExecutor } from './vision-actions.js';
import { ProgressGuard } from './vision-progress.js';
import { TaskRun } from './vision-run.js';
import {
  startUrlFor, recoveryUrl, pageFlags, describeView, describeAction, actionKey, withDeadline, lookAlikeOfGoal
} from './vision-helpers.js';

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
  verifyAttempts: 4,
  maxBlankRestores: 3,
  maxReattaches: 5,
  settleTimeout: 15000,
  postActionSettleTimeout: 12000,
  actionDeadline: 45000,
  replaceWait: 4000,
  plannerRetryMs: 1200,
  siteErrorBackoffMs: [4000, 8000, 15000],
  observeRetryMs: 700,
  verifyRetryMs: 2500,
  afterHandoffMs: 600,
  betweenStepsMs: 180
};

const POINTER_ACTIONS = new Set(['click', 'click_text', 'type', 'select_option']);
const NON_VISUAL = new Set(['wait', 'remember']);

const NETWORK_ERROR_RE = /network connection looks down|fetch failed|ENOTFOUND|EAI_AGAIN|timed out/i;
const FATAL_PLANNER_RE = /API key/i;

const isBlankUrl = (u) => !u || u === 'about:blank';

class VisionAgent {
  constructor(options = {}) {
    this.logger = options.logger;
    this.target = options.target || new CdpPageTarget({ logger: this.logger });
    this.planner = new VisionPlanner({ logger: this.logger });
    this.observer = new PageObserver({ target: this.target, logger: this.logger });
    this.limits = { ...LIMITS, ...(options.limits || {}) };
    this.state = State.IDLE;
    this._run = null;
  }

  get task() { return this._run ? this._run.task : null; }

  get running() { return !!(this._run && this._run.active); }

  emit(channel, data) {
    try {
      const sent = chrome.runtime.sendMessage({ type: channel, data });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (_) {}
  }

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
    let siteErrors = 0;
    let observeFailures = 0;
    let revives = 0;
    let pageUnchanged = false;
    let lastGoodUrl = null;
    let blankStreak = 0;
    let blankRestores = 0;
    let blindRecoveries = 0;
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
        if (!target.isAlive()) continue;
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
        if (++observeFailures >= 2 && here && !isBlankUrl(here) && revives < 2 && target.reviveTab) {
          revives++;
          observeFailures = 0;
          this.logger?.warn(`[Agent] the tab stopped responding - reviving it (${here.slice(0, 80)})`);
          const revived = await target.reviveTab(here).catch(() => ({ success: false }));
          this.logger?.info(`[Agent] tab revived: ${revived.success ? revived.via : 'no'}`);
          continue;
        }
        this.logger?.warn('[Agent] observation failed - retrying');
        await run.sleep(L.observeRetryMs);
        step++;
        continue;
      }
      observeFailures = 0;

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
      const siteError = action.observation && action.observation.state === 'error';
      siteErrors = siteError ? siteErrors + 1 : 0;
      if (siteError && action.action !== 'done') {
        const waits = L.siteErrorBackoffMs || [];
        const ms = waits[Math.min(siteErrors, waits.length) - 1] || 0;
        if (ms) {
          this.logger?.info(`[Agent] the site shows an error page - waiting ${Math.round(ms / 1000)}s before retrying`);
          await run.sleep(ms);
          if (run.aborted) break;
        }
      }

      if (action.action === 'done') {
        let verdict = await this._verifyDone(run, action);
        for (let attempt = 1; !verdict && !run.aborted && attempt < L.verifyAttempts; attempt++) {
          await run.sleep(L.verifyRetryMs * attempt);
          verdict = await this._verifyDone(run, action);
        }
        if (run.aborted) break;

        if (!verdict) {
          return this._fail(run, "Couldn't confirm the task was finished: the completion check could not run. " +
            'Check the page yourself.');
        }
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
        return this._complete(run, action.summary);
      }
      if (action.action === 'ask_user') {
        const handoff = await this._waitForUser(run, { kind: 'assist', message: action.question });
        if (handoff.aborted) break;
        pageUnchanged = false;
        continue;
      }

      const key = actionKey(url, action, view.scroll && view.scroll.y);
      if (guard.recordAction(key, stateKey)) {
        this.logger?.warn('[Agent] blocking a repeated action, pressing Escape instead: ' + key);
        guard.avoid(url, describeAction(action, view));
        action = { action: 'key', key: 'Escape', observation: action.observation,
                   reasoning: 'forced recovery - the same action was proposed repeatedly' };
      }

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

      if (await run.waitWhilePaused()) continue;
      if (run.aborted) break;

      this._setState(run, State.EXECUTING);
      const description = describeAction(action, view);
      this.emit('agent:action-log', { actionType: action.action, description, stepIndex: step });

      const before = settle.signature || await target.signature();
      const refused = this._lookAlikeRefusal(run, action, view);
      const exec = refused ? null : executor.start(action, view);
      const result = refused || await withDeadline(exec.promise, L.actionDeadline, action.action);
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

  _lookAlikeRefusal(run, action, view) {
    let m = null;
    if (action.action === 'click' && typeof action.mark === 'number') {
      m = (view.marks || []).find((x) => x.mark === action.mark);
    } else if (action.action === 'click_text' && action.text) {
      m = { mark: '?', name: String(action.text) };
    }
    const wanted = m && lookAlikeOfGoal(m.name, run.task.goal);
    if (!wanted) return null;
    run.lookAlikes ||= new Set();
    const key = `${String(m.name).toLowerCase()}>${wanted}`;
    if (run.lookAlikes.has(key)) return null;
    run.lookAlikes.add(key);
    this.logger?.info(`[Agent] refused "${m.name}" - the goal asks for "${wanted}"`);
    return {
      success: false,
      error: `${m.mark === '?' ? '' : `[${m.mark}] `}"${m.name}" is NOT "${wanted}" from the goal. Do not click a shorter look-alike. ` +
        `Use {"action":"click_text","text":"${wanted}"} - it scrolls the page and side panels to find it.`
    };
  }

  _absorbObservation(run, observation) {
    if (!observation || typeof observation !== 'object') return;
    const task = run.task;
    const progress = String(observation.progress ?? '').trim();
    if (progress) {
      const notes = task.progressNotes;
      if (notes[notes.length - 1] !== progress) notes.push(progress);
      if (notes.length > 6) notes.shift();
    }
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

  async _ensureAttached() {
    if (this.target.isAlive()) return true;
    try {
      await this.target.resolve({ force: true });
    } catch (err) {
      this.logger?.warn('[Agent] could not re-attach: ' + err.message);
    }
    if (this.target.isAlive()) this.logger?.info(`[Agent] re-attached to ${this.target.getURL().slice(0, 80)}`);
    return this.target.isAlive();
  }

  async _verifyDone(run, action) {
    await this._ensureAttached();
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

  async _complete(run, summary) {
    if (run.finished) return { success: true, summary };
    this._setState(run, State.COMPLETED);
    this.logger?.info('[Agent] task complete: ' + summary);
    Object.assign(run.task, { state: State.COMPLETED, finishedAt: Date.now(), result: summary, verified: true });
    if (run === this._run) await this._hideCursor();
    this.emit('agent:task-complete', { success: true, verified: true, result: summary, taskId: run.id });
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
