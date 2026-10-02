import { parseModelJSON } from './gemini-json.js';

export function buildVerifyPrompt({ goal, claim, history, front }) {
  return [
    'You are auditing another agent that controls a macOS computer. It says it FINISHED this task:',
    `  GOAL:  ${goal}`,
    `  CLAIM: ${String(claim || '').slice(0, 400)}`,
    '',
    `Frontmost app right now: ${front ? `${front.app}${front.title ? ` — "${front.title}"` : ''}` : 'unknown'}`,
    'The attached screenshot shows the screen RIGHT NOW. The actions the agent ran and what each returned:',
    ...(history.length ? history.slice(-15).map((h, i) => `  ${i + 1}. ${h}`) : ['  (none)']),
    '',
    'Be strict. Split the goal into EVERY action and detail it asks for (the right app, the right file or',
    'folder name and location, the exact text typed, the message actually sent, every item of a list).',
    'A requirement counts as met only with evidence: visible on the screenshot, or an action result above',
    'that confirms it (e.g. filesystem.createDirectory -> ok for that path). An app merely opened, an empty',
    'document, a message still in the input box, a FAILED action, or a claim with no evidence is NOT met.',
    'If the goal only asks for information, the CLAIM must contain the answer and it must be backed by the',
    'action results or the screen.',
    '',
    'Reply with JSON only:',
    '{"requirements":[{"need":"..","met":true,"evidence":".."}],"complete":false,"evidence":"one sentence","missing":"what is still not done","next":"the single next action that would finish it"}'
  ].join('\n');
}

export function parseVerdict(text) {
  let out;
  try { out = parseModelJSON(text); } catch (_) { out = null; }
  if (Array.isArray(out)) out = out[0];
  if (!out || typeof out !== 'object') throw new Error('unreadable completion verdict');
  const reqs = Array.isArray(out.requirements) ? out.requirements : [];
  const unmet = reqs.filter((r) => r && (r.met === false || r.met === 'false'));
  const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
  return {
    complete: (out.complete === true || out.complete === 'true') && !unmet.length,
    evidence: str(out.evidence, 300),
    missing: (str(out.missing, 300) || unmet.map((r) => String(r.need ?? '')).join('; ')).slice(0, 300),
    next: str(out.next, 200)
  };
}
