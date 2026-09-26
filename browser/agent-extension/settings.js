// The Gemini key is stored in chrome.storage.local as { ai: { apiKey, provider } }.
// Keep that shape: existing installs already have their key there.

export async function getApiKey() {
  const { ai } = await chrome.storage.local.get(['ai']);
  return typeof (ai && ai.apiKey) === 'string' ? ai.apiKey.trim() : '';
}

export async function saveApiKey(apiKey) {
  const { ai } = await chrome.storage.local.get(['ai']);
  await chrome.storage.local.set({ ai: { ...(ai || {}), apiKey: String(apiKey || '').trim(), provider: 'gemini' } });
}

// Why a key cannot be right, or '' when it looks usable. Google's keys are
// "AIza..." or "AQ...." today; only the shape is checked so a new prefix works.
export function apiKeyProblem(apiKey) {
  const key = String(apiKey ?? '').trim();
  if (!key) return 'Add a Gemini API key in Settings.';
  if (!/^[A-Za-z0-9._-]{20,200}$/.test(key)) return 'That does not look like a Gemini API key. Copy it again from AI Studio.';
  return '';
}
