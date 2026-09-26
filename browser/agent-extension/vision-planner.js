// VisionPlanner: reads the page (screenshot with numbered marks plus the page's
// own text) and decides ONE action. The reply must state an observation before
// the action, and "done" claims are audited separately by verifyDone().
// Prompts live in vision-prompts.js, reply parsing in vision-normalize.js.
import { GeminiLadder } from './gemini-ladder.js';
import { parseModelJSON } from './gemini-json.js';
import { getApiKey, apiKeyProblem } from './settings.js';
import { SYSTEM_PROMPT, PLAN_PROMPT, VERIFY_PROMPT, buildVisionMessage } from './vision-prompts.js';
import { normalizeAction, readObservation } from './vision-normalize.js';

const truthy = (v) => v === true || v === 'true';
// The plan only feeds the panel's checklist, so the task never waits long for it.
const PLAN_DEADLINE_MS = 20000;
const DECISION_DEADLINE_MS = 90000;

class VisionPlanner {
  constructor({ logger, ladder, readApiKey = getApiKey, onModelBusy } = {}) {
    this.logger = logger;
    this.onModelBusy = onModelBusy;
    this.ladder = ladder || new GeminiLadder({ logger });
    this.readApiKey = readApiKey;
  }

  async apiKey() {
    const key = String((await this.readApiKey()) || '').trim();
    const problem = apiKeyProblem(key);
    if (problem) throw new Error(problem);
    return key;
  }

  async ask(texts, shot, { json = true, deadlineMs = DECISION_DEADLINE_MS } = {}) {
    const apiKey = await this.apiKey();
    const parts = texts.map((text) => ({ text }));
    const data = shot && typeof shot.dataUrl === 'string' ? shot.dataUrl.split(',')[1] : '';
    if (data) parts.push({ inlineData: { mimeType: shot.mimeType || 'image/png', data } });
    return this.ladder.ask(apiKey, parts, { json, deadlineMs, onModelError: (model, err) => this.onModelBusy?.(model, err) });
  }

  // Always resolves to a non-empty plan so the UI and agent have steps to follow.
  async getInitialPlan(goal) {
    await this.apiKey();
    try {
      const plan = parseModelJSON(await this.ask([PLAN_PROMPT(goal)], null, { json: false, deadlineMs: PLAN_DEADLINE_MS }));
      const steps = Array.isArray(plan?.steps)
        ? plan.steps.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 300))
        : [];
      if (steps.length) {
        this.logger?.info('Plan created with ' + steps.length + ' steps');
        return { steps, reasoning: typeof plan.reasoning === 'string' ? plan.reasoning : '' };
      }
    } catch (error) {
      this.logger?.error('Planning error: ' + error.message);
    }
    return {
      steps: [
        `Step 1: Open or navigate to the appropriate website for: ${goal}`,
        `Step 2: Complete the user's task: ${goal}`
      ],
      reasoning: 'Fallback plan - execute these steps to accomplish the goal.'
    };
  }

  // A separate, narrow call: "is this actually finished?" is a different
  // question from "what next?", and the decision prompt is biased toward acting.
  async verifyDone(ctx) {
    const claim = String(ctx.claim || '').slice(0, 400);
    const raw = await this.ask([VERIFY_PROMPT(ctx.goal, claim) + buildVisionMessage(ctx)], ctx.shot);
    let out;
    try { out = parseModelJSON(raw); } catch (_) { out = null; }
    if (Array.isArray(out)) out = out[0];
    // An unreadable verdict is not a pass.
    if (!out || typeof out !== 'object') {
      return { complete: false, evidence: '', missing: 'the completion check could not be read', next: '' };
    }
    const reqs = Array.isArray(out.requirements) ? out.requirements : [];
    const unmet = reqs.filter((r) => r && (r.met === false || r.met === 'false'));
    const text = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
    return {
      complete: truthy(out.complete) && !unmet.length,
      evidence: text(out.evidence, 300),
      missing: (text(out.missing, 300) || unmet.map((r) => String(r.need ?? '')).join('; ')).slice(0, 300),
      next: text(out.next, 200)
    };
  }

  async decide(ctx) {
    const content = await this.ask([SYSTEM_PROMPT, buildVisionMessage(ctx)], ctx.shot);
    if (!content) throw new Error('Empty response from AI');
    return normalizeAction(parseModelJSON(content));
  }

  normalize(raw) { return normalizeAction(raw); }

  readObservation(raw) { return readObservation(raw); }

  buildVisionMessage(ctx) { return buildVisionMessage(ctx); }
}

export default VisionPlanner;
