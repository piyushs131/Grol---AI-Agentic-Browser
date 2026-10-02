
const MAX_CANDIDATES = 20;

function balancedObjectAt(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export function extractFirstJSONObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  return start === -1 ? null : balancedObjectAt(s, start);
}

export function parseModelJSON(text) {
  const cleaned = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/```[a-z]*[ \t]*\r?\n?/gi, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {  }

  let from = 0;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const start = cleaned.indexOf('{', from);
    if (start === -1) break;
    const candidate = balancedObjectAt(cleaned, start);
    if (candidate) {
      try { return JSON.parse(candidate); } catch (_) {  }
    }
    from = start + 1;
  }
  throw new Error('AI did not return JSON: ' + cleaned.slice(0, 160));
}
