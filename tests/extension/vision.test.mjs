import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

const events = [];
const session = {};
installChromeStub({
  runtime: {
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: async (msg) => { events.push(msg); },
    onMessage: { addListener() {} }, lastError: null
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in session).map((k) => [k, session[k]])),
      set: async (o) => { Object.assign(session, o); },
      remove: async (k) => { delete session[k]; }
    }
  }
});

const helpers = await import('../../browser/agent-extension/vision-helpers.js');
const { ProgressGuard } = await import('../../browser/agent-extension/vision-progress.js');
const { TaskRun } = await import('../../browser/agent-extension/vision-run.js');
const { ActionExecutor } = await import('../../browser/agent-extension/vision-actions.js');
const { withImageSize, drawMarks } = await import('../../browser/agent-extension/mark-render.js');
const { CdpPageTarget, keyEventSpec, imageSize, drivable } = await import('../../browser/agent-extension/cdp-page-target.js');
const { default: VisionAgent, LIMITS } = await import('../../browser/agent-extension/vision-agent.js');
const { SOM_SCRIPT, CURSOR_SCRIPT } = await import('../../browser/agent-extension/page-scripts.js');

const quietLogger = { info() {}, warn() {}, error() {} };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function until(pred, { timeout = 4000, step = 5 } = {}) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error('condition not met in time');
    await tick(step);
  }
}


describe('vision-helpers', () => {
  test('parseKeyChord handles names, chords and aliases', () => {
    const p = helpers.parseKeyChord;
    assert.deepEqual(p('enter'), { key: 'Enter', modifiers: [] });
    assert.deepEqual(p('Control+a'), { key: 'a', modifiers: ['control'] });
    assert.deepEqual(p('cmd + shift + z'), { key: 'z', modifiers: ['meta', 'shift'] });
    assert.deepEqual(p('Shift+Tab'), { key: 'Tab', modifiers: ['shift'] });
    assert.deepEqual(p('ctrl+alt+Delete'), { key: 'Delete', modifiers: ['control', 'alt'] });
    assert.deepEqual(p('Control++'), { key: '+', modifiers: ['control'] });
    assert.deepEqual(p('+'), { key: '+', modifiers: [] });
    assert.deepEqual(p(' '), { key: 'Space', modifiers: [] });
    assert.deepEqual(p(''), { key: 'Enter', modifiers: [] });
    assert.deepEqual(p('esc'), { key: 'Escape', modifiers: [] });
    assert.deepEqual(p('pagedown'), { key: 'PageDown', modifiers: [] });
    assert.deepEqual(p('option+left'), { key: 'ArrowLeft', modifiers: ['alt'] });
  });

  test('normalizeNavUrl accepts web addresses and refuses other schemes', () => {
    const n = helpers.normalizeNavUrl;
    assert.equal(n('amazon.in/deals'), 'https://amazon.in/deals');
    assert.equal(n('https://example.com'), 'https://example.com/');
    assert.equal(n('localhost:3000/x'), 'https://localhost:3000/x');
    assert.equal(n('example.com:8080/a'), 'https://example.com:8080/a');
    assert.equal(n('//cdn.example.com/a'), 'https://cdn.example.com/a');
    assert.equal(n('about:blank'), 'about:blank');
    assert.equal(n('javascript:alert(1)'), null);
    assert.equal(n('chrome://settings'), null);
    assert.equal(n('data:text/html,hi'), null);
    assert.equal(n('best laptops 2024'), null);
    assert.equal(n(''), null);
    assert.equal(n(undefined), null);
  });

  test('valueMatches tolerates re-spaced and formatted values', () => {
    assert.ok(helpers.valueMatches('98765 43210', '9876543210'));
    assert.ok(helpers.valueMatches('héllo wörld', 'héllo'));
    assert.ok(!helpers.valueMatches('', 'abc'));
    assert.ok(helpers.valueMatches('anything', ''));
    assert.ok(!helpers.valueMatches('abc', '!!!'));
  });

  test('matchMarksByText: exact wins, repeats are ambiguous, non-Latin labels are not all equal', () => {
    const marks = [
      { mark: 1, name: 'Add to cart | Phone A — ₹100' },
      { mark: 2, name: 'Add to cart | Phone B — ₹200' },
      { mark: 3, name: 'Checkout' },
      { mark: 4, name: 'खरीदें' },
      { mark: 5, name: 'कार्ट' },
      { mark: 6, name: 'Hidden', disabled: true }
    ];
    assert.deepEqual(helpers.matchMarksByText(marks, 'checkout').map((m) => m.mark), [3]);
    assert.equal(helpers.matchMarksByText(marks, 'Add to cart').length, 2);
    assert.deepEqual(helpers.matchMarksByText(marks, 'खरीदें').map((m) => m.mark), [4]);
    assert.deepEqual(helpers.matchMarksByText(marks, '!!!'), []);
    assert.equal(helpers.lookAlikeOfGoal('Android', 'tick the Android 14 filter'), 'android 14');
    assert.equal(helpers.lookAlikeOfGoal('Android 14', 'tick the Android 14 filter'), null);
    assert.equal(helpers.lookAlikeOfGoal('Samsung', 'tick the Samsung brand'), null);
    assert.equal(helpers.lookAlikeOfGoal('iPhone', 'buy an iPhone 15 Pro'), 'iphone 15 pro');
    assert.equal(helpers.lookAlikeOfGoal('Android', 'android phones, android 14 too'), null);
    assert.deepEqual(helpers.matchMarksByText(marks, ''), []);
    assert.deepEqual(helpers.matchMarksByText(null, 'x'), []);
  });

  test('startUrlFor and recoveryUrl', () => {
    assert.equal(helpers.startUrlFor('compare on Amazon and Flipkart', ''), 'https://www.amazon.in');
    assert.equal(helpers.startUrlFor('search amazon', 'https://www.amazon.in/s?k=x'), null);
    assert.equal(helpers.startUrlFor('open example.org', ''), 'https://example.org');
    assert.match(helpers.startUrlFor('best pizza near me', 'about:blank'), /google\.com\/search\?q=best%20pizza/);
    assert.equal(helpers.startUrlFor('best pizza near me', 'https://site.test/'), null);
    assert.equal(helpers.recoveryUrl({ plan: ['go to https://a.test/x now'], goal: 'g' }), 'https://a.test/x');
    assert.equal(helpers.recoveryUrl({ plan: [], goal: 'g', lastGoodUrl: 'https://b.test/' }), 'https://b.test/');
    assert.equal(helpers.recoveryUrl({ goal: '' }), null);
  });

  test('describeAction / actionKey never throw on sparse actions', () => {
    assert.equal(helpers.describeAction({ action: 'type' }, {}), 'Typing ""');
    assert.equal(helpers.describeAction({ action: 'click', mark: 2 }, { marks: [{ mark: 2, name: 'Go' }] }), 'Clicking "Go"');
    assert.equal(helpers.actionKey('u', { action: 'type', text: 42 }), 'u#type#42');
    assert.equal(helpers.actionKey('u', { action: 'key', key: 'Tab' }), 'u#key#Tab');
    assert.notEqual(helpers.actionKey('u', { action: 'scroll', direction: 'down' }, 0),
      helpers.actionKey('u', { action: 'scroll', direction: 'down' }, 600));
    assert.notEqual(helpers.actionKey('u', { action: 'key', key: 'Tab' }), helpers.actionKey('u', { action: 'key', key: 'Escape' }));
    assert.match(helpers.describeView('u', 't', { marks: [] }), /0 interactive/);
  });

  test('withDeadline resolves a timeout result and clears its timer', async () => {
    const slow = new Promise((r) => setTimeout(() => r({ success: true }), 200));
    const res = await helpers.withDeadline(slow, 10, 'click');
    assert.deepEqual(res, { success: false, timedOut: true, error: 'click exceeded 10ms' });
    assert.deepEqual(await helpers.withDeadline(Promise.resolve({ success: true }), 1000, 'x'), { success: true });
    assert.deepEqual(await helpers.withDeadline({ success: 1 }, 1000, 'x'), { success: 1 });
  });
});

describe('mark-render geometry', () => {
  test('withImageSize takes the scale from the real image', () => {
    const shot = { cssWidth: 800, cssHeight: 600, scaleX: 1, scaleY: 1 };
    assert.deepEqual(withImageSize(shot, 1600, 1200), { ...shot, imageWidth: 1600, imageHeight: 1200, scaleX: 0.5, scaleY: 0.5 });
    assert.equal(withImageSize(shot, 0, 0), shot);
    const fractional = withImageSize({ cssWidth: 1280, cssHeight: 720 }, 1600, 900);
    assert.equal(fractional.scaleX, 0.8);
  });

  test('drawMarks returns the original shot when it cannot draw', async () => {
    const shot = { dataUrl: 'data:image/png;base64,AAAA', cssWidth: 10 };
    assert.equal(await drawMarks(shot, []), shot);
    assert.equal(await drawMarks(null, [{}]), null);
    assert.equal(await drawMarks(shot, [{ mark: 1, rect: { x: 0, y: 0, w: 5, h: 5 } }]), shot);
  });
});


describe('ProgressGuard', () => {
  test('flags repeats beyond the limit and exposes the stuck warning', () => {
    const g = new ProgressGuard({ maxRepeats: 3 });
    assert.equal(g.recordAction('a'), false);
    assert.equal(g.recordAction('a'), false);
    assert.equal(g.recordAction('a'), false);
    assert.match(g.stuckWarning(), /same action three times/);
    assert.equal(g.recordAction('a'), true);
  });

  test('cycle warning counts only states the agent acted on', () => {
    const g = new ProgressGuard();
    assert.equal(g.cycleWarning('S'), null);
    g.recordAction('x', 'S');
    assert.equal(g.cycleWarning('S'), null);
    g.recordAction('y', 'T');
    g.recordAction('z', 'S');
    assert.match(g.cycleWarning('S'), /3 times/);
  });

  test('no-change streak ignores deliberate non-visual actions', () => {
    const g = new ProgressGuard();
    assert.equal(g.recordOutcome({ changed: false }), 1);
    assert.equal(g.recordOutcome({ changed: false, nonVisual: true }), 1);
    assert.equal(g.recordOutcome({ changed: false }), 2);
    assert.equal(g.recordOutcome({ changed: true }), 0);
  });

  test('avoid list per url', () => {
    const g = new ProgressGuard();
    g.avoid('u', 'Clicking X');
    g.avoid('u', 'Clicking X');
    g.avoid('u', '');
    assert.deepEqual(g.avoidList('u'), ['Clicking X']);
    g.forget('u');
    assert.deepEqual(g.avoidList('u'), []);
  });
});

describe('TaskRun', () => {
  test('abort cuts a sleep short and releases a pause and a hand-off', async () => {
    const run = new TaskRun('g');
    const t0 = Date.now();
    const sleeping = run.sleep(5000);
    run.pause();
    const pausing = run.waitWhilePaused();
    const waiting = run.waitForUser();
    assert.equal(run.waitingForUser, true);
    run.abort();
    await sleeping;
    assert.equal(await pausing, true);
    assert.deepEqual(await waiting, { aborted: true });
    assert.ok(Date.now() - t0 < 500);
    assert.deepEqual(await run.waitForUser(), { aborted: true });
  });

  test('resume releases a pause; hand-off keys ignore query and hash', async () => {
    const run = new TaskRun('g');
    assert.equal(await run.waitWhilePaused(), false);
    run.pause();
    let released = false;
    run.waitWhilePaused().then(() => { released = true; });
    await tick(20);
    assert.equal(released, false);
    run.resume();
    await tick(5);
    assert.equal(released, true);
    run.markHandedOff('signin', 'https://a.test/login?x=1#y');
    assert.ok(run.handedOff('signin', 'https://a.test/login'));
    assert.ok(!run.handedOff('payment', 'https://a.test/login'));
  });

  test('finish resolves done once', async () => {
    const run = new TaskRun('g');
    run.finish();
    run.finish();
    await run.done;
    assert.equal(run.active, false);
  });
});


class FakeTarget {
  constructor({ marks, url = 'https://site.test/' } = {}) {
    this.url = url;
    this.title = 'Site';
    this.version = 0;
    this.alive = true;
    this.password = false;
    this.docId = 'doc-1';
    this.marks = marks || [
      { mark: 1, name: 'Search', role: 'button', x: 100, y: 50, rect: { x: 60, y: 40, w: 80, h: 20 } },
      { mark: 2, name: 'Query', role: 'input:text', typable: true, x: 300, y: 50, rect: { x: 200, y: 40, w: 200, h: 20 } }
    ];
    this.calls = [];
    this.fail = {};
    this.fieldValue = '';
    this.changesOn = new Set(['click', 'loadURL', 'scroll']);
  }

  sig() { return { url: this.url, title: this.title, nodes: 10, textHash: this.version, textLen: 100, scrollY: 0, vw: 800, vh: 600 }; }
  bump(kind) { if (this.changesOn.has(kind)) this.version++; }
  check(name) { if (this.fail[name]) throw new Error(this.fail[name]); }

  isAlive() { return this.alive; }
  cancelledByUser() { return !this.alive && this.detachReason === 'canceled_by_user'; }
  async resolve() { this.calls.push(['resolve']); this.check('resolve'); return this.alive ? 1 : null; }
  async useTab() { return 1; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  async ensureDisplayed() {}
  async waitForSettle() { return { signature: this.sig() }; }
  async signature() { return this.sig(); }
  async metrics() { return { w: 800, h: 600, dpr: 2 }; }

  async capture() {
    this.check('capture');
    return { dataUrl: 'data:image/jpeg;base64,', mimeType: 'image/jpeg', cssWidth: 800, cssHeight: 600,
             imageWidth: 1600, imageHeight: 1200, scaleX: 0.5, scaleY: 0.5, bytes: 0 };
  }

  async executeJS(code) {
    this.check('executeJS');
    if (code === SOM_SCRIPT || code === CURSOR_SCRIPT) return 'already';
    if (code.includes('__grolSoM.analyze()')) return { onScreenText: 'A page with plenty of visible text', signals: {} };
    if (code.includes('__grolSoM.mark()')) {
      return { docId: this.docId, marks: this.marks, counts: { total: this.marks.length }, viewport: { w: 800, h: 600 }, scroll: { y: 0, maxY: 0 } };
    }
    if (code.includes('input[type="password"]')) return this.password;
    if (code.includes('input[name="identifier"]')) return false;
    if (code.includes('input[type=range]')) return [];
    if (code.includes('scrollable(')) { this.calls.push(['scroll']); this.bump('scroll'); return { moved: true, target: 'window' }; }
    let m = /resolveMark\((\d+)\)/.exec(code);
    if (m) {
      const mk = this.marks.find((x) => x.mark === Number(m[1]));
      return mk && !this.goneMarks ? { x: mk.x, y: mk.y, name: mk.name, role: mk.role, tag: mk.tag || 'BUTTON' } : null;
    }
    if (code.includes('.docId')) return this.docId;
    if (code.includes('pointHits(')) return true;
    if (code.includes('activeValue()')) return '';
    if ((m = /fieldValue\((\d+)\)/.exec(code))) return this.fieldValue;
    if (code.includes('typeInto(')) return { success: true, field: 'q' };
    if (code.includes('focusMark(')) return true;
    if (code.includes('moveTo(')) return { duration: 1 };
    if (code.includes('armClick()')) { this.calls.push(['arm']); return true; }
    if (code.includes('clickReached(')) return this.reached ?? true;
    if (code.includes('activateMark(') || code.includes('activateText(')) {
      this.calls.push(['dom-activate']);
      return { success: !!this.domWorks, tag: 'BUTTON', via: 'self' };
    }
    return null;
  }

  async click(x, y) { this.check('click'); this.calls.push(['click', x, y]); this.bump('click'); return { success: true }; }
  async pressKey(key, modifiers = []) { this.check('pressKey'); this.calls.push(['key', key, modifiers]); this.bump('key'); return { success: true }; }
  async typeText(text) { this.calls.push(['type', text]); this.fieldValue += text; return { success: true }; }
  async clearField() { this.fieldValue = ''; return { success: true }; }
  async loadURL(url) { this.check('loadURL'); this.calls.push(['load', url]); this.url = url; this.bump('loadURL'); return { success: true }; }
  async goBack() { return { success: true }; }
  async wheel(x, y, dx, dy) { this.calls.push(['wheel', x, y, dx, dy]); return { success: true }; }
  async drag() { return { success: true }; }
}

class FakePlanner {
  constructor(script, { verdicts = [], plan = ['Do it'] } = {}) {
    this.script = script;
    this.verdicts = verdicts;
    this.plan = plan;
    this.decisions = 0;
    this.contexts = [];
  }
  async getInitialPlan() {
    if (this.plan instanceof Error) throw this.plan;
    return { steps: this.plan };
  }
  async decide(ctx) {
    this.decisions++;
    this.contexts.push(ctx);
    const next = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(ctx) : structuredClone(next);
  }
  async verifyDone() {
    const v = this.verdicts.length > 1 ? this.verdicts.shift() : this.verdicts[0];
    if (v instanceof Error) throw v;
    return v === undefined ? { complete: true, evidence: 'looks done' } : v;
  }
}

const FAST = {
  plannerRetryMs: 1, observeRetryMs: 1, verifyRetryMs: 1, afterHandoffMs: 1,
  betweenStepsMs: 0, replaceWait: 200
};

function makeAgent({ script, target = new FakeTarget(), limits = {}, planner = {} } = {}) {
  const agent = new VisionAgent({ logger: quietLogger, target, limits: { ...FAST, ...limits } });
  agent.planner = new FakePlanner(script, planner);
  return { agent, target, planner: agent.planner };
}

const completion = (taskId) => events.find((e) => e.type === 'agent:task-complete' && e.data.taskId === taskId);
const finished = (agent) => until(() => !agent.running);

describe('VisionAgent loop', () => {
  beforeEach(() => { events.length = 0; });

  test('public surface matches what background.js uses', () => {
    const { agent } = makeAgent({ script: [{ action: 'done' }] });
    for (const m of ['startTask', 'pauseTask', 'resumeTask', 'abortTask', 'resumeAfterUserAction', 'getStatus']) {
      assert.equal(typeof agent[m], 'function', m);
    }
    assert.equal(agent.task, null);
    assert.ok(agent.target);
    assert.deepEqual(agent.getStatus(), { state: 'idle', running: false, task: null });
    assert.deepEqual(agent.pauseTask(), { success: false, error: 'No task running' });
    assert.deepEqual(agent.resumeTask(), { success: false, error: 'No task running' });
    assert.deepEqual(agent.abortTask(), { success: false, error: 'No task running' });
    assert.equal(agent.resumeAfterUserAction().success, false);
  });

  test('empty goal is refused', async () => {
    const { agent } = makeAgent({ script: [] });
    assert.deepEqual(await agent.startTask('   '), { success: false, error: 'Goal is required' });
    assert.deepEqual(await agent.startTask(null), { success: false, error: 'Goal is required' });
  });

  test('successful task: click a mark, then a verified done', async () => {
    const { agent, target } = makeAgent({
      script: [
        { action: 'click', mark: 1, observation: { progress: 'searching', planStep: 1 } },
        { action: 'done', summary: 'Found it' }
      ]
    });
    const res = await agent.startTask('find the thing');
    assert.equal(res.success, true);
    await finished(agent);
    assert.deepEqual(target.calls.filter((c) => c[0] === 'click'), [['click', 100, 50]]);
    const done = completion(res.taskId);
    assert.deepEqual(done.data, { success: true, verified: true, result: 'Found it', taskId: res.taskId });
    assert.equal(agent.getStatus().state, 'completed');
    assert.equal(agent.task.steps.length, 1);
    assert.equal(agent.task.steps[0].outcome, 'page changed');
    assert.deepEqual(agent.task.progressNotes, ['searching']);
    assert.ok(events.some((e) => e.type === 'agent:plan-steps'));
    const emitted = new Set(events.map((e) => e.type));
    for (const dead of ['agent:task-started', 'agent:observation', 'agent:action-start', 'agent:action-complete', 'agent:action-error', 'agent:note']) {
      assert.ok(!emitted.has(dead), dead + ' has no listener and must not be sent');
    }
  });

  test('pixel coordinates from the model are converted from image to CSS pixels', async () => {
    const { agent, target } = makeAgent({
      script: [{ action: 'click', x: 400, y: 300 }, { action: 'done', summary: 'ok' }]
    });
    await agent.startTask('click the middle');
    await finished(agent);
    assert.deepEqual(target.calls.filter((c) => c[0] === 'click'), [['click', 200, 150]]);
  });

  test('stops at the step limit', async () => {
    const { agent } = makeAgent({
      script: [(ctx) => ({ action: 'scroll', direction: ctx.history.length % 2 ? 'up' : 'down', amount: 300 })],
      limits: { maxSteps: 3 }
    });
    const res = await agent.startTask('scroll forever');
    await finished(agent);
    assert.equal(completion(res.taskId).data.result, 'Reached the 3-step limit without finishing');
    assert.equal(agent.getStatus().state, 'failed');
  });

  test('abort while the planner is thinking stops without acting', async () => {
    let release;
    const { agent, target } = makeAgent({
      script: [() => new Promise((r) => { release = () => r({ action: 'click', mark: 1 }); })]
    });
    const res = await agent.startTask('slow thinking');
    await until(() => release);
    assert.equal(agent.getStatus().state, 'thinking');
    assert.deepEqual(agent.abortTask(), { success: true });
    assert.equal(agent.getStatus().state, 'aborted');
    release();
    await finished(agent);
    assert.equal(target.calls.filter((c) => c[0] === 'click').length, 0);
    assert.equal(completion(res.taskId).data.result, 'Task stopped by user');
  });

  test('abort during a long action returns promptly', async () => {
    const { agent } = makeAgent({ script: [{ action: 'wait', ms: 8000 }] });
    const res = await agent.startTask('wait a while');
    await until(() => agent.getStatus().state === 'executing');
    const t0 = Date.now();
    agent.abortTask();
    await finished(agent);
    assert.ok(Date.now() - t0 < 500, 'abort must not wait out the action');
    assert.equal(completion(res.taskId).data.result, 'Task stopped by user');
  });

  test('pause mid-decision discards the stale decision; resume re-observes', async () => {
    let release;
    const { agent, target, planner } = makeAgent({
      script: [
        () => new Promise((r) => { release = () => r({ action: 'click', mark: 1 }); }),
        { action: 'done', summary: 'ok' }
      ]
    });
    await agent.startTask('pause me');
    await until(() => release);
    assert.deepEqual(agent.pauseTask(), { success: true });
    assert.equal(agent.getStatus().state, 'paused');
    release();
    await tick(60);
    assert.equal(target.calls.filter((c) => c[0] === 'click').length, 0);
    assert.equal(agent.getStatus().state, 'paused');
    assert.equal(planner.decisions, 1);
    assert.deepEqual(agent.resumeTask(), { success: true });
    await finished(agent);
    assert.equal(planner.decisions, 2);
    assert.equal(target.calls.filter((c) => c[0] === 'click').length, 0);
    assert.equal(agent.getStatus().state, 'completed');
  });

  test('planner errors are retried, then fail the task', async () => {
    const { agent, planner } = makeAgent({ script: [new Error('model said nonsense')], limits: { maxPlannerFailures: 3 } });
    const res = await agent.startTask('confuse the model');
    await finished(agent);
    assert.equal(planner.decisions, 3);
    assert.equal(completion(res.taskId).data.result, 'AI could not decide what to do: model said nonsense');
  });

  test('a missing API key fails at once, not after retries', async () => {
    const { agent } = makeAgent({ script: [{ action: 'done' }], planner: { plan: new Error('Add a Gemini API key in Settings.') } });
    const res = await agent.startTask('anything');
    assert.equal(res.success, false);
    assert.equal(agent.getStatus().state, 'failed');
    assert.equal(agent.running, false);

    const again = makeAgent({ script: [new Error('400 API key not valid')] });
    const r2 = await again.agent.startTask('anything');
    await finished(again.agent);
    assert.equal(again.planner.decisions, 1);
    assert.match(completion(r2.taskId).data.result, /API key not valid/);
  });

  test('a planner reply without an action counts as a failure', async () => {
    const { agent } = makeAgent({ script: [null], limits: { maxPlannerFailures: 2 } });
    const res = await agent.startTask('x');
    await finished(agent);
    assert.match(completion(res.taskId).data.result, /AI returned no action/);
  });

  test('target failing to attach at start never leaves the task running', async () => {
    const target = new FakeTarget();
    target.fail.resolve = 'Cannot attach to this target.';
    const { agent } = makeAgent({ script: [{ action: 'done' }], target });
    const res = await agent.startTask('go');
    assert.equal(res.success, false);
    assert.equal(agent.running, false);
    assert.equal(agent.getStatus().state, 'failed');
    assert.match(completion(agent.task.id).data.result, /Could not start: Cannot attach/);
  });

  test('observation failures consume steps and end the task', async () => {
    const target = new FakeTarget();
    target.fail.capture = 'screenshot timed out';
    const { agent, planner } = makeAgent({ script: [{ action: 'done' }], target, limits: { maxSteps: 3 } });
    const res = await agent.startTask('look');
    await finished(agent);
    assert.equal(planner.decisions, 0);
    assert.match(completion(res.taskId).data.result, /3-step limit/);
  });

  test('an action whose target throws is recorded as failed and the loop carries on', async () => {
    const target = new FakeTarget();
    target.fail.pressKey = 'debugger not attached';
    const { agent } = makeAgent({ script: [{ action: 'key', key: 'Enter' }, { action: 'done', summary: 's' }], target });
    await agent.startTask('press enter');
    await finished(agent);
    assert.equal(agent.task.steps[0].outcome, 'FAILED: debugger not attached');
    assert.equal(agent.getStatus().state, 'completed');
  });

  test('a closed tab that cannot be replaced fails the task; a user-cancelled session aborts it', async () => {
    const target = new FakeTarget();
    const { agent } = makeAgent({
      script: [() => { target.alive = false; return { action: 'key', key: 'Tab' }; }, { action: 'done' }],
      target
    });
    const res = await agent.startTask('close it');
    await finished(agent);
    assert.equal(completion(res.taskId).data.result, 'Browser page was closed');

    const t2 = new FakeTarget();
    const second = makeAgent({
      script: [() => { t2.alive = false; t2.detachReason = 'canceled_by_user'; return { action: 'key', key: 'Tab' }; }],
      target: t2
    });
    const r2 = await second.agent.startTask('cancel it');
    await finished(second.agent);
    assert.equal(completion(r2.taskId).data.result, 'Task stopped by user');
    assert.equal(second.agent.getStatus().state, 'aborted');
  });

  test('a tab that keeps dying after re-attaching ends the task instead of spinning', async () => {
    const target = new FakeTarget();
    const { agent } = makeAgent({ script: [{ action: 'done' }], target, limits: { maxReattaches: 2 } });
    target.waitForSettle = async () => { target.alive = false; return { signature: target.sig() }; };
    target.resolve = async () => { target.alive = true; return 1; };
    const res = await agent.startTask('flaky tab');
    await finished(agent);
    assert.equal(completion(res.taskId).data.result, 'Lost control of the browser page repeatedly');
  });

  test('a site error page is retried only after a growing pause', async () => {
    const err = { page: 'Cart', state: 'error', blocker: 'Oops! something went wrong', progress: '', plan_step: 1 };
    const { agent, target } = makeAgent({
      script: [{ action: 'key', key: 'F5', observation: err }, { action: 'key', key: 'F6', observation: err }, { action: 'done' }],
      limits: { siteErrorBackoffMs: [80, 160], maxConsecutiveNoChange: 99 }
    });
    const started = Date.now();
    await agent.startTask('open the cart');
    await finished(agent);
    assert.deepEqual(target.calls.filter((c) => c[0] === 'key').map((c) => c[1]), ['F5', 'F6']);
    assert.ok(Date.now() - started >= 240, 'waited 80ms then 160ms before the two retries');
  });

  test('a click on a shorter look-alike of the goal\'s label is refused once with the exact fix', async () => {
    const marks = [{ mark: 1, name: 'Android', role: 'link', x: 100, y: 50, rect: { x: 60, y: 40, w: 80, h: 20 } }];
    const { agent, target, planner } = makeAgent({
      script: [{ action: 'click', mark: 1 }, { action: 'click', mark: 1 }, { action: 'done' }],
      target: new FakeTarget({ marks })
    });
    await agent.startTask('on amazon tick the Android 14 filter');
    await finished(agent);
    assert.equal(target.calls.filter((c) => c[0] === 'click').length, 1, 'refused the first time, allowed when insisted');
    assert.match(JSON.stringify(planner.contexts[1]), /NOT \\"android 14\\".*click_text/);
  });

  test('scrolling down a long page again and again is progress, not a loop', async () => {
    const target = new FakeTarget();
    let y = 0;
    const orig = target.executeJS.bind(target);
    target.executeJS = async (code) => {
      if (code.includes('scrollable(')) y += 600;
      const out = await orig(code);
      return code.includes('__grolSoM.mark()') ? { ...out, scroll: { y, maxY: 9000 } } : out;
    };
    const { agent } = makeAgent({
      script: [...Array(6).fill({ action: 'scroll', direction: 'down' }), { action: 'done' }],
      target, limits: { maxConsecutiveNoChange: 99 }
    });
    await agent.startTask('read the whole page');
    await finished(agent);
    assert.equal(target.calls.filter((c) => c[0] === 'scroll').length, 6);
    assert.equal(target.calls.filter((c) => c[0] === 'key').length, 0, 'never replaced by Escape');
  });

  test('click_text on a shorter look-alike is refused too', async () => {
    const { agent, target, planner } = makeAgent({ script: [{ action: 'click_text', text: 'Android' }, { action: 'done' }] });
    await agent.startTask('tick the Android 14 filter');
    await finished(agent);
    assert.equal(target.calls.filter((c) => c[0] === 'click').length, 0);
    assert.match(JSON.stringify(planner.contexts[1]), /NOT \\"android 14\\"/);
  });

  test('scroll with a mark scrolls the panel under that element, not mid-screen', async () => {
    const marks = [{ mark: 3, name: 'Brand', role: 'checkbox', x: 120, y: 500, rect: { x: 100, y: 490, w: 40, h: 20 } }];
    const target = new FakeTarget({ marks });
    const codes = [];
    const orig = target.executeJS.bind(target);
    target.executeJS = async (code) => { if (code.includes('scrollable(')) codes.push(code); return orig(code); };
    const { agent } = makeAgent({ script: [{ action: 'scroll', direction: 'down', mark: 3 }, { action: 'done' }], target });
    await agent.startTask('scroll the filters');
    await finished(agent);
    assert.match(codes[0], /var at = \{"x":120,"y":500\}/);
  });

  test('a type with no field named goes into the page\'s search box', async () => {
    const marks = [
      { mark: 1, name: 'Wikipedia', role: 'link', x: 50, y: 20, rect: { x: 20, y: 10, w: 60, h: 20 } },
      { mark: 2, name: 'Search Wikipedia', role: 'input:search', typable: true, x: 300, y: 50, rect: { x: 200, y: 40, w: 200, h: 20 } }
    ];
    const { agent, target } = makeAgent({
      script: [{ action: 'type', text: 'India', submit: true }, { action: 'done' }],
      target: new FakeTarget({ marks })
    });
    await agent.startTask('search wikipedia for India');
    await finished(agent);
    assert.ok(target.calls.some((c) => c[0] === 'type' && c[1] === 'India'), JSON.stringify(target.calls));
  });

  test('a tab that stops answering is revived instead of retried forever', async () => {
    const target = new FakeTarget({ url: 'https://en.wikipedia.org/wiki/India' });
    target.fail.capture = 'executeJS timed out';
    target.fail.executeJS = 'executeJS timed out';
    const revived = [];
    target.reviveTab = async (url) => { revived.push(url); delete target.fail.capture; delete target.fail.executeJS; return { success: true, via: 'reload' }; };
    const { agent } = makeAgent({ script: [{ action: 'done' }], target, limits: { maxSteps: 12 } });
    const res = await agent.startTask('read the india article');
    await finished(agent);
    assert.deepEqual(revived, ['https://en.wikipedia.org/wiki/India']);
    assert.equal(completion(res.taskId).data.success, true);
  });

  test('the page closing right as the goal is reached: the check re-attaches instead of hanging', async () => {
    const target = new FakeTarget();
    let resolves = 0;
    const origResolve = target.resolve.bind(target);
    target.resolve = async (o) => { resolves++; target.alive = true; return origResolve(o); };
    const { agent, planner } = makeAgent({ script: [() => { target.alive = false; return { action: 'done', summary: 'at checkout' }; }], target });
    const res = await agent.startTask('go to the checkout page');
    await finished(agent);
    assert.ok(resolves >= 2, 're-attached for the completion check');
    assert.equal(completion(res.taskId).data.success, true);
  });

  test('activity labels read as plain words, not milliseconds and pixels', () => {
    assert.equal(helpers.describeAction({ action: 'wait', ms: 2000 }, { marks: [] }), 'Waiting 2 seconds for the page');
    assert.equal(helpers.describeAction({ action: 'wait', ms: 1000 }, { marks: [] }), 'Waiting 1 second for the page');
    assert.equal(helpers.describeAction({ action: 'scroll', direction: 'down', amount: 800 }, { marks: [] }), 'Scrolling down the page');
  });

  test('actions that change nothing stop the task', async () => {
    const { agent, target } = makeAgent({
      script: [(ctx) => ({ action: 'key', key: ['Tab', 'ArrowDown', 'End'][ctx.history.length % 3] })],
      limits: { maxConsecutiveNoChange: 3 }
    });
    const res = await agent.startTask('do nothing useful');
    await finished(agent);
    assert.equal(target.calls.filter((c) => c[0] === 'key').length, 3);
    assert.match(completion(res.taskId).data.result, /Stopped after 3 actions that changed nothing/);
  });

  test('the same action proposed again and again is replaced by Escape', async () => {
    const { agent, target, planner } = makeAgent({
      script: [{ action: 'key', key: 'Tab' }],
      limits: { maxSteps: 5, maxConsecutiveNoChange: 99 }
    });
    await agent.startTask('tab forever');
    await finished(agent);
    const keys = target.calls.filter((c) => c[0] === 'key').map((c) => c[1]);
    assert.deepEqual(keys, ['Tab', 'Tab', 'Tab', 'Escape', 'Escape']);
    assert.match(planner.contexts[3].stuckWarning, /repeated the same action|returned to this exact page state/);
    assert.ok(planner.contexts[4].avoid.includes('Pressing Tab'));
  });

  test('key chords reach the target as key + modifiers', async () => {
    const { agent, target } = makeAgent({ script: [{ action: 'key', key: 'Control+a' }, { action: 'done' }] });
    await agent.startTask('select all');
    await finished(agent);
    assert.deepEqual(target.calls.find((c) => c[0] === 'key'), ['key', 'a', ['control']]);
  });

  test('sign-in hand-off waits for the user, then is not asked again for the same page', async () => {
    const target = new FakeTarget();
    target.password = true;
    const { agent } = makeAgent({ script: [{ action: 'done', summary: 'signed in and done' }], target });
    const res = await agent.startTask('check my account');
    await until(() => agent.getStatus().state === 'waiting_for_user');
    const asks = () => events.filter((e) => e.type === 'agent:require-user-action');
    assert.equal(asks().length, 1);
    assert.equal(asks()[0].data.kind, 'signin');
    assert.deepEqual(agent.pauseTask(), { success: true });
    assert.deepEqual(agent.resumeTask(), { success: true });
    assert.equal(agent.getStatus().state, 'waiting_for_user', 'resume restores the hand-off state');
    assert.deepEqual(agent.resumeAfterUserAction(), { success: true });
    await finished(agent);
    assert.equal(asks().length, 1);
    assert.ok(events.some((e) => e.type === 'agent:user-action-complete'));
    assert.equal(completion(res.taskId).data.success, true);
  });

  test('ask_user hands off and Stop while waiting aborts cleanly', async () => {
    const { agent } = makeAgent({ script: [{ action: 'ask_user', question: 'Which size?' }] });
    const res = await agent.startTask('buy a shirt');
    await until(() => agent.getStatus().state === 'waiting_for_user');
    assert.equal(events.find((e) => e.type === 'agent:require-user-action').data.message, 'Which size?');
    agent.abortTask();
    await finished(agent);
    assert.equal(completion(res.taskId).data.result, 'Task stopped by user');
  });

  test('done is verified: a rejection goes back to the model, then it is accepted', async () => {
    const { agent, planner } = makeAgent({
      script: [{ action: 'done', summary: 'added 5' }, { action: 'done', summary: 'added 5 for real' }],
      planner: { verdicts: [{ complete: false, missing: 'only 4 in the cart', next: 'add one more' }, { complete: true, evidence: '5 in cart' }] }
    });
    const res = await agent.startTask('add 5 items');
    await finished(agent);
    assert.equal(planner.decisions, 2);
    assert.match(agent.task.progressNotes.join(' '), /REJECTED.*only 4 in the cart.*add one more/);
    assert.deepEqual(completion(res.taskId).data, { success: true, verified: true, result: 'added 5 for real', taskId: res.taskId });
  });

  test('a completion check that fails at first is retried, and a later pass completes the task', async () => {
    const a = makeAgent({ script: [{ action: 'done', summary: 's' }],
      planner: { verdicts: [new Error('busy'), new Error('busy'), { complete: true, evidence: 'visible' }] } });
    const r = await a.agent.startTask('x');
    await finished(a.agent);
    assert.equal(completion(r.taskId).data.success, true);
    assert.equal(completion(r.taskId).data.verified, true);
  });

  test('done that cannot be verified is never reported as success; repeated rejection fails', async () => {
    const a = makeAgent({ script: [{ action: 'done', summary: 's' }], planner: { verdicts: [new Error('quota')] } });
    const r1 = await a.agent.startTask('x');
    await finished(a.agent);
    assert.equal(completion(r1.taskId).data.success, false);
    assert.match(completion(r1.taskId).data.result, /Couldn't confirm the task was finished/);

    const b = makeAgent({ script: [{ action: 'done', summary: 's' }], planner: { verdicts: [{ complete: false, missing: 'nope' }] } });
    const r2 = await b.agent.startTask('y');
    await finished(b.agent);
    assert.equal(completion(r2.taskId).data.result, 'Not finished: nope');
  });

  test('starting a new task stops the old one without reviving it', async () => {
    let release;
    const target = new FakeTarget();
    const { agent } = makeAgent({
      script: [() => new Promise((r) => { release = () => r({ action: 'click', mark: 1 }); })],
      target
    });
    const first = await agent.startTask('first');
    await until(() => release);
    const firstRun = agent._run;
    agent.planner = new FakePlanner([{ action: 'done', summary: 'second done' }]);
    const second = await agent.startTask('second');
    assert.equal(second.success, true);
    release();
    await finished(agent);
    await firstRun.done;
    assert.equal(firstRun.aborted, true);
    assert.equal(target.calls.filter((c) => c[0] === 'click').length, 0, 'the old run must not act');
    assert.equal(completion(first.taskId).data.result, 'Task stopped by user');
    assert.equal(completion(second.taskId).data.result, 'second done');
    assert.equal(agent.getStatus().state, 'completed');
    assert.equal(agent.task.goal, 'second');
  });

  test('a mark number outside the list is reported, not clicked', async () => {
    const { agent, target } = makeAgent({ script: [{ action: 'click', mark: 99 }, { action: 'done' }] });
    await agent.startTask('bad mark');
    await finished(agent);
    assert.match(agent.task.steps[0].outcome, /There is no element \[99\]/);
    assert.equal(target.calls.filter((c) => c[0] === 'click').length, 0);
  });

  test('LIMITS are exported for callers and tests', () => {
    assert.equal(LIMITS.maxSteps, 60);
  });
});


describe('ActionExecutor', () => {
  const view = (target, extra = {}) => ({
    marks: target.marks, docId: target.docId, viewport: { w: 800, h: 600 },
    shot: { cssWidth: 800, cssHeight: 600, scaleX: 0.5, scaleY: 0.5 }, ...extra
  });
  const exec = (target) => new ActionExecutor({ target, logger: quietLogger, run: new TaskRun('g') });

  test('pixel targets outside the screenshot are refused', async () => {
    const t = new FakeTarget();
    const ex = exec(t);
    assert.deepEqual(await ex.resolveTarget({ x: 1598, y: 1198 }, view(t)), { x: 799, y: 599, via: 'pixel 1598,1198', meta: null });
    assert.equal(await ex.resolveTarget({ x: 1600, y: 10 }, view(t)), null);
    assert.equal(await ex.resolveTarget({ x: -1, y: 10 }, view(t)), null);
    assert.equal(await ex.resolveTarget({ x: NaN, y: 10 }, view(t)), null);
  });

  test('a gone mark uses its cached spot only within the same document', async () => {
    const t = new FakeTarget();
    t.goneMarks = true;
    const ex = exec(t);
    const cached = await ex.resolveTarget({ mark: 1 }, view(t));
    assert.equal(cached.via, 'mark 1 (cached)');
    assert.equal(cached.x, 100);
    t.docId = 'doc-2';
    await assert.rejects(ex.resolveTarget({ mark: 1 }, view(t, { docId: 'doc-1' })), /page changed since the screenshot/);
  });

  test('scroll falls back to a wheel in the scroll direction', async () => {
    const t = new FakeTarget();
    t.executeJS = async () => ({ moved: false });
    const ex = exec(t);
    const down = await ex.start({ action: 'scroll', direction: 'down', amount: 500 }, view(t)).promise;
    assert.equal(down.target, 'wheel');
    assert.deepEqual(t.calls.at(-1), ['wheel', 400, 300, 0, 500]);
    await ex.start({ action: 'scroll', direction: 'left', amount: 200 }, view(t)).promise;
    assert.deepEqual(t.calls.at(-1), ['wheel', 400, 300, -200, 0]);
    const bad = await ex.start({ action: 'scroll', direction: 'sideways' }, view(t)).promise;
    assert.equal(bad.success, false);
  });

  test('navigate and open_tab refuse non-web addresses', async () => {
    const t = new FakeTarget();
    const ex = exec(t);
    const res = await ex.start({ action: 'navigate', url: 'javascript:alert(1)' }, view(t)).promise;
    assert.equal(res.success, false);
    assert.equal(t.calls.filter((c) => c[0] === 'load').length, 0);
    await ex.start({ action: 'navigate', url: 'example.com' }, view(t)).promise;
    assert.deepEqual(t.calls.at(-1), ['load', 'https://example.com/']);
    assert.equal((await ex.start({ action: 'open_tab', url: 'chrome://settings' }, view(t)).promise).success, false);
  });

  test('clicking a native dropdown points the model at select_option', async () => {
    const t = new FakeTarget({ marks: [{ mark: 1, name: 'Size', role: 'select', tag: 'SELECT', x: 5, y: 5, rect: { x: 0, y: 0, w: 10, h: 10 } }] });
    const res = await exec(t).start({ action: 'click', mark: 1 }, view(t)).promise;
    assert.match(res.error, /select_option/);
    assert.equal(t.calls.filter((c) => c[0] === 'click').length, 0);
    const sel = await exec(t).start({ action: 'select_option', text: 'M' }, view(t)).promise;
    assert.match(sel.error, /mark number/);
  });

  test('type reports a field that refuses the value', async () => {
    const t = new FakeTarget();
    t.typeText = async () => ({ success: true });
    const orig = t.executeJS.bind(t);
    t.executeJS = async (code) => code.includes('typeInto(')
      ? { success: false, error: 'this is a date field; it only accepts YYYY-MM-DD' }
      : orig(code);
    const res = await exec(t).start({ action: 'type', mark: 2, text: '05/01/2024' }, view(t)).promise;
    assert.deepEqual(res, { success: false, error: 'this is a date field; it only accepts YYYY-MM-DD' });
  });

  test('type accepts a re-formatted value without overwriting it', async () => {
    const t = new FakeTarget();
    t.typeText = async () => { t.fieldValue = '98765 43210'; return { success: true }; };
    let forced = false;
    const orig = t.executeJS.bind(t);
    t.executeJS = async (code) => { if (code.includes('typeInto(')) forced = true; return orig(code); };
    const res = await exec(t).start({ action: 'type', mark: 2, text: '9876543210', submit: true }, view(t)).promise;
    assert.equal(res.success, true);
    assert.equal(forced, false);
    assert.deepEqual(t.calls.at(-1), ['key', 'Enter', []]);
  });

  test('a cancelled action stops touching the page', async () => {
    const t = new FakeTarget();
    const orig = t.executeJS.bind(t);
    t.executeJS = async (code) => { await tick(20); return orig(code); };
    const ex = exec(t);
    const run = ex.start({ action: 'click', mark: 1 }, view(t));
    await tick(5);
    run.cancel();
    const res = await run.promise;
    assert.equal(res.success, false);
    assert.match(res.error, /cancelled/);
    assert.equal(t.calls.filter((c) => c[0] === 'click').length, 0);
  });

  test('a click that reached its control is not repeated through the DOM', async () => {
    const t = new FakeTarget();
    t.changesOn.delete('click');
    t.domWorks = true;
    const res = await exec(t).start({ action: 'click', mark: 1 }, view(t)).promise;
    assert.equal(res.success, true);
    assert.equal(res.forcedActivation, undefined);
    assert.equal(t.calls.filter((c) => c[0] === 'dom-activate').length, 0);
    assert.ok(t.calls.some((c) => c[0] === 'arm'));
  });

  test('a click that never arrived falls back to DOM activation', async () => {
    const t = new FakeTarget();
    t.changesOn.delete('click');
    t.domWorks = true;
    t.reached = false;
    const res = await exec(t).start({ action: 'click', mark: 1 }, view(t)).promise;
    assert.equal(res.forcedActivation, true);
    assert.equal(t.calls.filter((c) => c[0] === 'dom-activate').length, 1);
  });

  test('remember keeps unique notes on the task', async () => {
    const t = new FakeTarget();
    const ex = exec(t);
    await ex.start({ action: 'remember', note: 'price 100' }, view(t)).promise;
    await ex.start({ action: 'remember', note: 'price 100' }, view(t)).promise;
    assert.deepEqual(ex.run.task.notes, ['price 100']);
    assert.equal((await ex.start({ action: 'remember', note: ' ' }, view(t)).promise).success, false);
    assert.equal((await ex.start({ action: 'teleport' }, view(t)).promise).error, 'Unsupported action: teleport');
  });
});


function pngBase64(width, height) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return Buffer.from(b).toString('base64');
}

function jpegBase64(width, height) {
  const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xFF, 0xD8, ...app0, ...sof, 0xFF, 0xD9]).toString('base64');
}

function stubDebugger({ attach, onCommand } = {}) {
  const detachListeners = [];
  const sent = [];
  const tabs = new Map([[1, { id: 1, url: 'https://site.test/', title: 'Site' }]]);
  let nextId = 10;
  chrome.debugger = {
    attach: attach || (async () => {}),
    detach: async () => {},
    sendCommand: async (src, method, params) => {
      sent.push({ tabId: src.tabId, method, params });
      return onCommand ? onCommand(method, params, src) : {};
    },
    onDetach: { addListener: (f) => detachListeners.push(f), removeListener() {} },
    onEvent: { addListener() {}, removeListener() {} }
  };
  chrome.tabs = {
    query: async () => [...tabs.values()].map((t, i) => ({ ...t, active: i === 0 })),
    create: async (o) => { const t = { id: nextId++, url: o.url }; tabs.set(t.id, t); return t; },
    update: async () => ({}),
    get: async (id) => { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return tabs.get(id); }
  };
  return { sent, detachListeners, tabs };
}

describe('CdpPageTarget', () => {
  test('drivable refuses browser pages and the Web Store', () => {
    assert.ok(drivable('https://example.com'));
    assert.ok(drivable('about:blank'));
    for (const u of ['chrome://settings', 'chrome-error://chromewebdata/', 'chrome-extension://x/y.html',
      'devtools://devtools', 'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/x',
      'view-source:https://a.test', 'data:text/html,x', '', undefined]) {
      assert.ok(!drivable(u), String(u));
    }
  });

  test('attach failure on an undrivable tab falls back to a fresh tab', async () => {
    const attached = [];
    const { tabs } = stubDebugger({
      attach: async ({ tabId }) => {
        if (tabId === 1) throw new Error('Cannot access a chrome:// URL');
        attached.push(tabId);
      }
    });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    const id = await t.resolve({ force: true });
    assert.equal(id, 10);
    assert.deepEqual(attached, [10]);
    assert.ok(tabs.has(10));
    assert.equal(t.isAlive(), true);
    assert.equal(session.workTabId, 10);
  });

  test('other attach failures propagate; DevTools holding the tab falls back', async () => {
    stubDebugger({ attach: async () => { throw new Error('Unexpected protocol failure'); } });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await assert.rejects(t.resolve({ force: true }), /Unexpected protocol failure/);
    assert.equal(t.isAlive(), false);

    stubDebugger({ attach: async ({ tabId }) => { if (tabId === 1) throw new Error('Another debugger is already attached to the tab with id: 1.'); } });
    const t2 = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    assert.equal(await t2.resolve({ force: true }), 10);
  });

  test('no tab to drive resolves to null', async () => {
    stubDebugger();
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => null });
    assert.equal(await t.resolve(), null);
  });

  test('attaching never enables the Runtime domain (anti-bot scripts detect it)', async () => {
    const { sent } = stubDebugger();
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    assert.ok(sent.some((c) => c.method === 'Page.enable'));
    assert.ok(!sent.some((c) => c.method === 'Runtime.enable'));
  });

  test('detach events mark the session dead and record a user cancel', async () => {
    const { detachListeners } = stubDebugger();
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    assert.equal(t.getURL(), 'https://site.test/', 'tab info is fresh right after attaching');
    detachListeners.forEach((f) => f({ tabId: 2 }, 'target_closed'));
    assert.equal(t.isAlive(), true, 'other tabs are ignored');
    detachListeners.forEach((f) => f({ tabId: 1 }, 'canceled_by_user'));
    assert.equal(t.isAlive(), false);
    assert.equal(t.cancelledByUser(), true);
    await assert.rejects(t.send('Page.enable'), /not attached/);
    const settled = await t.waitForSettle({ timeout: 5000 });
    assert.equal(settled.detached, true);
  });

  test('a command failing because the tab is gone marks the session dead', async () => {
    let gone = false;
    stubDebugger({ onCommand: () => { if (gone) throw new Error('Debugger is not attached to the tab with id: 1.'); return {}; } });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    gone = true;
    await assert.rejects(t.send('Runtime.evaluate', {}), /not attached/);
    assert.equal(t.isAlive(), false);
    assert.equal(t.cancelledByUser(), false);
  });

  test('executeJS: values, undefined, page exceptions and timeouts', async () => {
    let reply = {};
    stubDebugger({ onCommand: (method) => (method === 'Runtime.evaluate' ? (typeof reply === 'function' ? reply() : reply) : {}) });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    reply = { result: { type: 'number', value: 42 } };
    assert.equal(await t.executeJS('6*7'), 42);
    reply = { result: { type: 'undefined' } };
    assert.equal(await t.executeJS('void 0'), undefined);
    reply = { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' } } };
    await assert.rejects(t.executeJS('x'), /ReferenceError: x is not defined/);
    reply = { exceptionDetails: { text: 'Uncaught (in promise)' } };
    await assert.rejects(t.executeJS('p'), /Uncaught \(in promise\)/);
    reply = () => new Promise(() => {});
    await assert.rejects(t.executeJS('hang', { timeout: 20 }), /timed out/);
  });

  test('capture reports image size and CSS scale at dpr 1 and 2', async () => {
    for (const dpr of [1, 2]) {
      stubDebugger({
        onCommand: (method) => {
          if (method === 'Page.captureScreenshot') return { data: jpegBase64(800 * dpr, 600 * dpr) };
          if (method === 'Runtime.evaluate') return { result: { value: { w: 800, h: 600, y: 0, dpr } } };
          return {};
        }
      });
      const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
      await t.resolve();
      const shot = await t.capture();
      assert.equal(shot.imageWidth, 800 * dpr);
      assert.equal(shot.imageHeight, 600 * dpr);
      assert.equal(shot.cssWidth, 800);
      assert.equal(shot.scaleX, 1 / dpr);
      assert.equal(shot.scaleY, 1 / dpr);
      assert.match(shot.dataUrl, /^data:image\/jpeg;base64,/);
    }
  });

  test('capture falls back to devicePixelRatio when the header is unreadable', async () => {
    stubDebugger({
      onCommand: (method) => {
        if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
        if (method === 'Runtime.evaluate') return { result: { value: { w: 500, h: 400, y: 0, dpr: 1.5 } } };
        return {};
      }
    });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    const shot = await t.capture({ format: 'png' });
    assert.equal(shot.imageWidth, 750);
    assert.equal(shot.scaleX, 500 / 750);
  });

  test('capture that never returns times out', async () => {
    stubDebugger({ onCommand: (method) => (method === 'Page.captureScreenshot' ? new Promise(() => {}) : {}) });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    await assert.rejects(t.capture({ timeout: 20 }), /screenshot timed out/);
  });

  test('imageSize reads PNG and JPEG headers', () => {
    assert.deepEqual(imageSize(pngBase64(1600, 1200)), { width: 1600, height: 1200 });
    assert.deepEqual(imageSize(jpegBase64(1280, 720)), { width: 1280, height: 720 });
    assert.equal(imageSize('not base64 at all!'), null);
    assert.equal(imageSize(''), null);
  });

  test('keyEventSpec: virtual key codes, text and modifier bitmask', () => {
    const bs = keyEventSpec('Backspace');
    assert.deepEqual(bs.down, { type: 'rawKeyDown', modifiers: 0, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    assert.equal(bs.up.type, 'keyUp');
    const enter = keyEventSpec('Enter').down;
    assert.equal(enter.type, 'keyDown');
    assert.equal(enter.text, '\r');
    const expected = {
      Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      PageUp: 33, PageDown: 34, Home: 36, End: 35, F5: 116
    };
    for (const [k, code] of Object.entries(expected)) assert.equal(keyEventSpec(k).down.windowsVirtualKeyCode, code, k);
    const space = keyEventSpec('Space').down;
    assert.equal(space.key, ' ');
    assert.equal(space.text, ' ');
    assert.equal(keyEventSpec('Tab', ['shift']).down.modifiers, 8);
    assert.equal(keyEventSpec('Delete', ['control', 'alt']).down.modifiers, 3);
    assert.equal(keyEventSpec('ArrowLeft', ['meta', 'shift']).down.modifiers, 12);
    const shiftA = keyEventSpec('a', ['shift']).down;
    assert.equal(shiftA.key, 'A');
    assert.equal(shiftA.text, 'A');
    assert.equal(shiftA.code, 'KeyA');
    assert.equal(keyEventSpec('5').down.code, 'Digit5');
  });

  test('keyEventSpec: shortcuts carry no text; macOS gets editing commands', () => {
    const ctrlA = keyEventSpec('a', ['control'], { mac: false }).down;
    assert.equal(ctrlA.modifiers, 2);
    assert.equal(ctrlA.text, undefined);
    assert.equal(ctrlA.type, 'rawKeyDown');
    assert.equal(ctrlA.commands, undefined);
    const macCtrlA = keyEventSpec('a', ['control'], { mac: true }).down;
    assert.equal(macCtrlA.modifiers, 4, 'Control+a means select-all, which is Cmd on macOS');
    assert.deepEqual(macCtrlA.commands, ['selectAll']);
    assert.deepEqual(keyEventSpec('z', ['meta', 'shift'], { mac: true }).down.commands, ['redo']);
    assert.deepEqual(keyEventSpec('v', ['meta'], { mac: true }).down.commands, ['paste']);
    assert.equal(keyEventSpec('f', ['control'], { mac: true }).down.modifiers, 2, 'other Control chords are left alone');
    assert.equal(keyEventSpec('Enter', ['control']).down.text, '\r');
  });

  test('pressKey sends keyDown then keyUp over CDP', async () => {
    const { sent } = stubDebugger();
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1, mac: false });
    await t.resolve();
    sent.length = 0;
    await t.pressKey('Tab', ['shift']);
    assert.deepEqual(sent.map((s) => [s.method, s.params.type, s.params.modifiers]),
      [['Input.dispatchKeyEvent', 'rawKeyDown', 8], ['Input.dispatchKeyEvent', 'keyUp', 8]]);
  });

  test('click sends a full press with buttons; invalid points are refused', async () => {
    const { sent } = stubDebugger();
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    sent.length = 0;
    assert.deepEqual(await t.click(10.4, 20.6), { success: true });
    assert.deepEqual(sent.map((s) => [s.params.type, s.params.x, s.params.y, s.params.buttons]),
      [['mouseMoved', 10, 21, 0], ['mousePressed', 10, 21, 1], ['mouseReleased', 10, 21, 0]]);
    assert.equal((await t.click(NaN, 1)).success, false);
  });

  test('loadURL reports navigation errors and refuses browser pages', async () => {
    const { sent } = stubDebugger({
      onCommand: (method) => {
        if (method === 'Page.navigate') return { frameId: 'f', errorText: 'net::ERR_NAME_NOT_RESOLVED' };
        return {};
      }
    });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    const res = await t.loadURL('https://nope.invalid/');
    assert.equal(res.success, false);
    assert.match(res.error, /ERR_NAME_NOT_RESOLVED/);
    sent.length = 0;
    assert.equal((await t.loadURL('chrome://settings')).success, false);
    assert.equal(sent.length, 0);
  });

  test('useTab refuses undrivable tabs and attaches drivable ones', async () => {
    const { tabs } = stubDebugger();
    tabs.set(5, { id: 5, url: 'chrome://settings' });
    tabs.set(6, { id: 6, url: '', pendingUrl: 'https://new.test/' });
    const t = new CdpPageTarget({ logger: quietLogger, getTabId: async () => 1 });
    await t.resolve();
    await assert.rejects(t.useTab(5), /cannot control/);
    assert.equal(await t.useTab(6), 6);
    assert.equal(t.tabId, 6);
    assert.equal(t.getURL(), 'https://new.test/');
  });

  test('sigKey includes viewport size', () => {
    const a = CdpPageTarget.sigKey({ url: 'u', title: 't', nodes: 1, textHash: 2, textLen: 3, scrollY: 0, vw: 800, vh: 600 });
    const b = CdpPageTarget.sigKey({ url: 'u', title: 't', nodes: 1, textHash: 2, textLen: 3, scrollY: 0, vw: 700, vh: 600 });
    assert.notEqual(a, b);
    assert.equal(CdpPageTarget.sigKey(null), 'none');
  });
});
