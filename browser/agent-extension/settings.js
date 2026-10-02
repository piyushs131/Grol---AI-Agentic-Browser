import { PROVIDERS, knownProvider, detectProvider, registerCredential, resolveProvider } from './llm-providers.js';

async function readAi() {
  const { ai } = await chrome.storage.local.get(['ai']);
  return ai && typeof ai === 'object' ? ai : {};
}

function effectiveKey(ai) {
  const key = typeof ai.apiKey === 'string' ? ai.apiKey.trim() : '';
  const p = PROVIDERS[ai.provider];
  const keyless = p && (p.local || (ai.provider === 'custom' && ai.baseUrl));
  return key || (keyless ? `local:${ai.provider}` : '');
}

export async function getApiKey() {
  const ai = await readAi();
  const key = effectiveKey(ai);
  if (key) registerCredential(key, { provider: ai.provider === 'auto' ? '' : ai.provider, baseUrl: ai.baseUrl, model: ai.model });
  return key;
}

export async function getAiSettings() {
  const ai = await readAi();
  const key = await getApiKey();
  const p = key ? resolveProvider(key) : null;
  return {
    hasKey: !!key,
    provider: ai.provider || 'auto',
    activeProvider: p ? p.id : null,
    providerLabel: p ? p.label : '',
    baseUrl: ai.baseUrl || '',
    model: ai.model || ''
  };
}

export async function saveApiKey(apiKey, { provider = 'auto', baseUrl = '', model = '' } = {}) {
  const ai = await readAi();
  const next = {
    ...ai,
    apiKey: String(apiKey || '').trim(),
    provider: PROVIDERS[provider] ? provider : 'auto',
    baseUrl: String(baseUrl || '').trim(),
    model: String(model || '').trim()
  };
  await chrome.storage.local.set({ ai: next });
  return getApiKey();
}

export function apiKeyProblem(apiKey, { provider, baseUrl = '' } = {}) {
  const key = String(apiKey ?? '').trim();
  const p = PROVIDERS[provider];
  if (p && p.local) return '';
  if (provider === 'custom' && !/^https?:\/\/\S+$/.test(String(baseUrl || '').trim())) {
    return 'Enter the base URL of your OpenAI-compatible server, e.g. https://api.example.com/v1';
  }
  if (/^local:\w+$/.test(key) || (provider === 'custom' && !key)) return '';
  if (!key) return 'Add an AI API key in Settings (Gemini, Claude, OpenAI, Grok, Groq, OpenRouter…).';
  if (!/^[A-Za-z0-9._:\-]{16,300}$/.test(key)) return 'That does not look like an API key. Copy it again from your provider.';
  if (provider === 'auto' ? !detectProvider(key) : !provider && !knownProvider(key)) {
    return "Couldn't tell which provider this key is for. Pick the provider in Settings.";
  }
  return '';
}
