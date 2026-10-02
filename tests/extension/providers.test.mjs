import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

installChromeStub();

const EXT = '../../browser/agent-extension/';
const P = await import(EXT + 'llm-providers.js');
const { GeminiLadder } = await import(EXT + 'gemini-ladder.js');
const { resetGeminiLadder } = await import(EXT + 'gemini-models.js');

const realFetch = globalThis.fetch;
let calls;
let reply;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const IMG = { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } };
const ANTHROPIC_KEY = 'sk-ant-api03-TESTKEY000000000000000000000000';
const XAI_KEY = 'xai-TESTKEY00000000000000000000000000';

beforeEach(() => {
  calls = [];
  reply = () => json({});
  P.resetProviders();
  resetGeminiLadder();
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} };
    calls.push(call);
    return reply(call);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('provider detection', () => {
  test('key prefixes name the provider; unknown keys need it picked', () => {
    assert.equal(P.detectProvider(ANTHROPIC_KEY), 'anthropic');
    assert.equal(P.detectProvider('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123'), 'gemini');
    assert.equal(P.detectProvider(XAI_KEY), 'xai');
    assert.equal(P.detectProvider('gsk_abcdefghijklmnopqrstuvwxyz'), 'groq');
    assert.equal(P.detectProvider('sk-or-v1-abcdefghijklmnopqrstuvwxyz'), 'openrouter');
    assert.equal(P.detectProvider('sk-proj-abcdefghijklmnopqrstuvwxyz'), 'openai');
    assert.equal(P.detectProvider('local:ollama'), 'ollama');
    assert.equal(P.detectProvider('abcdefghijklmnopqrstuvwxyz123456'), null);
  });

  test('a registered provider, base URL and model win over detection', () => {
    P.registerCredential('mistral-plain-key-0000000000', { provider: 'mistral', model: 'pixtral-12b' });
    const p = P.resolveProvider('mistral-plain-key-0000000000');
    assert.equal(p.id, 'mistral');
    assert.equal(p.baseUrl, 'https://api.mistral.ai/v1');
    assert.equal(p.model, 'pixtral-12b');
  });
});

describe('Claude (Anthropic Messages API)', () => {
  test('request shape: headers, image before text, refusal fallback on current models', async () => {
    reply = () => json({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' });
    const text = await P.generate(ANTHROPIC_KEY, 'claude-opus-5-5', [{ text: 'look' }, IMG],
      { generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } });
    assert.equal(text, '{"ok":true}');
    const c = calls[0];
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(c.headers['x-api-key'], ANTHROPIC_KEY);
    assert.equal(c.headers['anthropic-version'], '2023-06-01');
    assert.equal(c.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(c.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(c.body.fallbacks, 'default');
    assert.equal(c.body.model, 'claude-opus-5-5');
    assert.equal(c.body.max_tokens, 16000);
    assert.equal(c.body.temperature, undefined, 'sampling parameters are rejected by current Claude models');
    assert.deepEqual(c.body.messages[0].content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'text', text: 'look' }
    ]);
  });

  test('Haiku gets no fallback parameters', async () => {
    reply = () => json({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    await P.generate(ANTHROPIC_KEY, 'claude-haiku-4-5', [{ text: 'x' }]);
    assert.equal(calls[0].headers['anthropic-beta'], undefined);
    assert.equal(calls[0].body.fallbacks, undefined);
  });

  test('errors map onto the ladder kinds', async () => {
    for (const [status, kind] of [[401, 'auth'], [404, 'retired'], [429, 'quota'], [529, 'overloaded'], [500, 'server'], [400, 'bad-request']]) {
      reply = () => json({ type: 'error', error: { type: 'x', message: `boom ${ANTHROPIC_KEY}` } }, status, { 'retry-after': '7' });
      const err = await P.generate(ANTHROPIC_KEY, 'claude-opus-5-5', [{ text: 'x' }]).catch((e) => e);
      assert.equal(err.kind, kind, `HTTP ${status}`);
      assert.ok(!err.message.includes(ANTHROPIC_KEY), 'the key never appears in an error');
      if (status === 429) assert.equal(err.retryAfterMs, 7000);
      if (status === 401) assert.match(err.message, /Anthropic Claude rejected the API key/);
    }
    reply = () => json({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } });
    assert.equal((await P.generate(ANTHROPIC_KEY, 'claude-opus-5-5', [{ text: 'x' }]).catch((e) => e)).kind, 'blocked');
  });
});

describe('OpenAI-compatible providers', () => {
  test('xAI Grok: chat completions with a bearer key and a data-URL image', async () => {
    reply = () => json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
    assert.equal(await P.generate(XAI_KEY, 'grok-4', [{ text: 'what is this' }, IMG]), 'done');
    const c = calls[0];
    assert.equal(c.url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(c.headers.Authorization, `Bearer ${XAI_KEY}`);
    assert.deepEqual(c.body.messages[0].content, [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }
    ]);
    assert.equal(c.body.temperature, undefined);
  });

  test('a text-only model that rejects images is asked again without them, and remembered', async () => {
    reply = (c) => (c.body.messages[0].content.some((p) => p.type === 'image_url')
      ? json({ error: { code: 400, message: 'Multimodal data provided, but model does not support multimodal requests.' } }, 400)
      : json({ choices: [{ message: { content: 'text answer' } }] }));
    P.registerCredential('sk-proj-TEXTONLY0000000000000000000', { provider: 'openai', model: 'tiny-slm' });
    assert.equal(await P.generate('sk-proj-TEXTONLY0000000000000000000', 'tiny-slm', [{ text: 'q' }, IMG]), 'text answer');
    assert.equal(calls.length, 2);
    await P.generate('sk-proj-TEXTONLY0000000000000000000', 'tiny-slm', [{ text: 'q' }, IMG]);
    assert.equal(calls.length, 3, 'no second image attempt for a known text-only model');
  });

  test('local Ollama: no key, no auth header, models discovered from /models', async () => {
    P.registerCredential('local:ollama', { provider: 'ollama' });
    reply = (c) => (c.url.endsWith('/models')
      ? json({ data: [{ id: 'nomic-embed-text' }, { id: 'llama3.2-vision' }] })
      : json({ choices: [{ message: { content: 'local answer' } }] }));
    assert.deepEqual(await P.modelLadder('local:ollama'), ['llama3.2-vision']);
    assert.equal(await P.generate('local:ollama', 'llama3.2-vision', [{ text: 'hi' }]), 'local answer');
    assert.equal(calls[1].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(calls[1].headers.Authorization, undefined);
  });

  test('a local server that is not running says where it was looked for', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const err = await P.generate('local:lmstudio', 'qwen', [{ text: 'x' }]).catch((e) => e);
    assert.equal(err.kind, 'network');
    assert.match(err.message, /LM Studio running at http:\/\/localhost:1234\/v1/);
  });

  test('a custom endpoint uses its base URL and model', async () => {
    P.registerCredential('custom-key-000000000000000000', { provider: 'custom', baseUrl: 'https://llm.example.com/v1/', model: 'my-model' });
    reply = () => json({ choices: [{ message: { content: 'ok' } }] });
    assert.deepEqual(await P.modelLadder('custom-key-000000000000000000'), ['my-model']);
    await P.generate('custom-key-000000000000000000', 'my-model', [{ text: 'x' }]);
    assert.equal(calls[0].url, 'https://llm.example.com/v1/chat/completions');
  });
});

describe('local model servers', () => {
  test('a local server refusing the browser origin (403) is reached through the OS helper relay', async () => {
    P.registerCredential('local:ollama', { provider: 'ollama' });
    reply = (c) => {
      if (c.url === 'http://localhost:11434/v1/chat/completions') return new Response('', { status: 403 });
      if (c.url === 'http://127.0.0.1:7777/llm-local') {
        assert.equal(c.body.url, 'http://localhost:11434/v1/chat/completions');
        assert.equal(c.body.method, 'POST');
        return json({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'via helper' } }] }) });
      }
      return json({}, 500);
    };
    assert.equal(await P.generate('local:ollama', 'qwen', [{ text: 'hi' }]), 'via helper');
  });

  test('with no helper running, the 403 explains exactly how to fix it', async () => {
    P.registerCredential('local:ollama', { provider: 'ollama' });
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('http://127.0.0.1:7777')) throw new TypeError('Failed to fetch');
      return new Response('', { status: 403 });
    };
    const err = await P.generate('local:ollama', 'qwen', [{ text: 'hi' }]).catch((e) => e);
    assert.equal(err.kind, 'auth');
    assert.match(err.message, /OLLAMA_ORIGINS/);
  });

  test('remote APIs are never relayed', async () => {
    reply = () => new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 });
    await P.generate(XAI_KEY, 'grok-4', [{ text: 'x' }]).catch(() => {});
    assert.ok(calls.every((c) => !c.url.includes('7777')));
  });

  test('xAI answering a wrong key with 400 still reads as a rejected key', async () => {
    reply = () => json({ code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' }, 400);
    assert.equal((await P.generate(XAI_KEY, 'grok-4', [{ text: 'x' }]).catch((e) => e)).kind, 'auth');
    assert.equal(await P.checkCredential(XAI_KEY), 'invalid');
  });
});

describe('model ladder on any provider', () => {
  test('a Claude key walks Claude models and fails over when one is overloaded', async () => {
    reply = (c) => (c.body.model === 'claude-opus-5-5'
      ? json({ error: { message: 'Overloaded' } }, 529)
      : json({ content: [{ type: 'text', text: 'answer from ' + c.body.model }], stop_reason: 'end_turn' }));
    const ladder = new GeminiLadder({ retryDelayMs: 1 });
    assert.equal(await ladder.ask(ANTHROPIC_KEY, [{ text: 'q' }]), 'answer from claude-sonnet-5-5');
    assert.ok(calls.every((c) => c.url.startsWith('https://api.anthropic.com/')));
  });

  test('a picked model goes first', async () => {
    P.registerCredential(XAI_KEY, { provider: 'xai', model: 'grok-code-fast' });
    assert.deepEqual((await P.modelLadder(XAI_KEY))[0], 'grok-code-fast');
  });

  test('an exhausted ladder names the provider', async () => {
    reply = () => json({ error: { message: 'down' } }, 503);
    const err = await new GeminiLadder({ retryDelayMs: 1 }).ask(XAI_KEY, [{ text: 'q' }]).catch((e) => e);
    assert.match(err.message, /Every xAI Grok model failed/);
  });

  test('a credential check asks the provider and reports a rejected key', async () => {
    reply = () => json({ error: { message: 'invalid x-api-key' } }, 401);
    assert.equal(await P.checkCredential(ANTHROPIC_KEY), 'invalid');
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models');
    reply = () => json({ data: [] });
    assert.equal(await P.checkCredential(XAI_KEY), 'valid');
  });
});

describe('Settings save regressions (found by driving the real form)', () => {
  test('an OpenRouter key is checked where a key is required, not on the public model list', async () => {
    reply = (c) => (c.url.endsWith('/key') ? json({ error: { message: 'No auth credentials found' } }, 401) : json({ data: [] }));
    assert.equal(await P.checkCredential('sk-or-v1-FAKE0000000000000000000000'), 'invalid');
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  });

  test('"Detect from the key" judges the key itself, not a provider remembered from an earlier try', async () => {
    const { apiKeyProblem } = await import(EXT + 'settings.js');
    P.registerCredential('FAKEKEYFORTESTING0000000000000000', { provider: 'mistral' });
    assert.match(apiKeyProblem('FAKEKEYFORTESTING0000000000000000', { provider: 'auto' }), /Pick the provider/);
    assert.equal(apiKeyProblem('FAKEKEYFORTESTING0000000000000000'), '', 'a running agent still trusts the saved provider');
  });
});

describe('hedged model requests', () => {
  const answer = (model) => json({ content: [{ type: 'text', text: 'from ' + model }], stop_reason: 'end_turn' });
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

  test('a model that hangs gets the next one asked in parallel, and the first answer wins', async () => {
    reply = (c) => (c.body.model === 'claude-opus-5-5' ? later(600, answer('opus')) : answer(c.body.model));
    const t0 = Date.now();
    const out = await new GeminiLadder({ retryDelayMs: 1 }).ask(ANTHROPIC_KEY, [{ text: 'q' }], { hedgeMs: 80 });
    assert.equal(out, 'from claude-sonnet-5-5');
    assert.ok(Date.now() - t0 < 500, 'did not wait for the hung model');
    await later(650);
  });

  test('a fast first answer never sends a second request', async () => {
    reply = (c) => answer(c.body.model);
    await new GeminiLadder().ask(ANTHROPIC_KEY, [{ text: 'q' }], { hedgeMs: 200 });
    await later(250);
    assert.equal(calls.length, 1);
  });

  test('when both lanes fail, the error is the first model\'s', async () => {
    reply = () => json({ error: { message: 'bad input' } }, 400);
    const err = await new GeminiLadder({ retryDelayMs: 1 }).ask(ANTHROPIC_KEY, [{ text: 'q' }], { hedgeMs: 1 }).catch((e) => e);
    assert.match(err.message, /failed|bad input/);
  });
});
