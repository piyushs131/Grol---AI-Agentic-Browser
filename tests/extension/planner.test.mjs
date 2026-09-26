// Gemini client, model discovery, the model ladder and the browser agent's
// planner (prompt building and reply normalisation). No network: fetch is mocked.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installChromeStub } from '../helpers/chrome-stub.mjs';

installChromeStub();

const EXT = '../../browser/agent-extension/';
const { parseModelJSON, extractFirstJSONObject } = await import(EXT + 'gemini-json.js');
const { generateContent, listModels, GeminiError, redactSecrets, API_ROOT } = await import(EXT + 'gemini-fetch-client.js');
const { geminiLadder, resetGeminiLadder, rankModels, checkApiKey, STATIC_STRONG, STATIC_LITE } = await import(EXT + 'gemini-models.js');
const { GeminiLadder, NETWORK_DOWN } = await import(EXT + 'gemini-ladder.js');
const { default: VisionPlanner } = await import(EXT + 'vision-planner.js');
const { normalizeAction, webUrl } = await import(EXT + 'vision-normalize.js');
const { buildVisionMessage, priceLimit } = await import(EXT + 'vision-prompts.js');

const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklm';
const realFetch = globalThis.fetch;

// ---- fetch mocking ---------------------------------------------------------

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const answer = (text) => json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const googleError = (status, message, extra = {}) => json({ error: { code: status, message, status: extra.status || '', details: extra.details || [] } }, status);

let calls = [];
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call);
  };
}
const modelOf = (url) => (/models\/([^:?]+):generateContent/.exec(url) || [])[1];
const generateCalls = () => calls.filter((c) => c.url.includes(':generateContent'));
const listCalls = () => calls.filter((c) => /\/models\?/.test(c.url));
const MODEL_LIST = {
  models: ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.6-flash-tts', 'text-embedding-004']
    .map((n) => ({ name: `models/${n}`, supportedGenerationMethods: n.includes('embedding') ? ['embedContent'] : ['generateContent'] }))
};
const LADDER = ['models/gemini-3.6-flash', 'models/gemini-3-flash-preview', 'models/gemini-flash-latest', 'models/gemini-3.5-flash-lite'];

afterEach(() => { globalThis.fetch = realFetch; resetGeminiLadder(); });

// ---- gemini-json -----------------------------------------------------------

describe('parseModelJSON', () => {
  const cases = [
    ['plain object', '{"a":1}', { a: 1 }],
    ['json fence', '```json\n{"a":1}\n```', { a: 1 }],
    ['upper-case fence', '```JSON\n{"a":2}\n```', { a: 2 }],
    ['bare fence', '```\n{"a":3}```', { a: 3 }],
    ['prose around', 'Sure! Here it is: {"a":4} hope that helps', { a: 4 }],
    ['two objects', '{"a":5}\n{"b":6}', { a: 5 }],
    ['brace inside string', '{"t":"a } b { c"}', { t: 'a } b { c' }],
    ['escaped quote in string', '{"t":"say \\"}\\" now"}', { t: 'say "}" now' }],
    ['braces in prose first', 'use {curly} then {"a":7}', { a: 7 }],
    ['unbalanced prose brace first', 'oops { then {"a":8}', { a: 8 }],
    ['top-level array', '[{"a":9}]', [{ a: 9 }]],
    ['array in prose', 'result: [{"a":10}] done', { a: 10 }],
    ['BOM', '﻿{"a":11}', { a: 11 }],
    ['nested', '{"o":{"p":[1,{"q":2}]}}', { o: { p: [1, { q: 2 }] } }]
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => assert.deepEqual(parseModelJSON(input), expected));
  }
  for (const [name, input] of [['truncated', '{"action":"click","mark":'], ['empty', ''], ['null', null], ['prose only', 'I cannot help with that']]) {
    test(`${name} throws`, () => assert.throws(() => parseModelJSON(input), /did not return JSON/));
  }
  test('extractFirstJSONObject', () => {
    assert.equal(extractFirstJSONObject('x {"a":{"b":1}} y {"c":2}'), '{"a":{"b":1}}');
    assert.equal(extractFirstJSONObject('no braces'), null);
    assert.equal(extractFirstJSONObject('{"open":'), null);
  });
});

// ---- gemini-fetch-client ---------------------------------------------------

describe('generateContent', () => {
  test('sends the key in a header, never in the URL, and returns the text', async () => {
    mockFetch(() => answer('hello'));
    assert.equal(await generateContent(`  ${KEY}\n`, 'gemini-3.6-flash', [{ text: 'hi' }]), 'hello');
    const [c] = calls;
    assert.equal(c.url, `${API_ROOT}/models/gemini-3.6-flash:generateContent`);
    assert.ok(!c.url.includes(KEY) && !c.url.includes('key='));
    assert.equal(c.init.headers['x-goog-api-key'], KEY);
    assert.deepEqual(c.body.contents[0].parts, [{ text: 'hi' }]);
  });

  test('accepts a models/ prefixed name and passes generationConfig', async () => {
    mockFetch(() => answer('x'));
    await generateContent(KEY, 'models/gemini-x', [], { generationConfig: { temperature: 0.1 } });
    assert.ok(calls[0].url.endsWith('/models/gemini-x:generateContent'));
    assert.deepEqual(calls[0].body.generationConfig, { temperature: 0.1 });
  });

  test('skips thought parts and uses only the first candidate', async () => {
    mockFetch(() => json({ candidates: [
      { content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"a":' }, { text: '1}' }] } },
      { content: { parts: [{ text: '{"b":2}' }] } }
    ] }));
    assert.equal(await generateContent(KEY, 'm', []), '{"a":1}');
  });

  test('blank or whitespace key fails fast without a request', async () => {
    mockFetch(() => answer('never'));
    for (const key of ['', '   ', null, undefined]) {
      await assert.rejects(generateContent(key, 'm', []), (e) => e instanceof GeminiError && e.kind === 'auth');
    }
    assert.equal(calls.length, 0);
  });

  const statusCases = [
    ['400 invalid key', () => googleError(400, 'API key not valid. Please pass a valid API key.', { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }), 'auth'],
    ['401', () => googleError(401, 'Request had invalid authentication credentials.'), 'auth'],
    ['403 API disabled', () => googleError(403, 'Generative Language API has not been used in project', { status: 'PERMISSION_DENIED' }), 'auth'],
    ['404 retired', () => googleError(404, 'models/gemini-1.0 is not found'), 'retired'],
    ['429 quota', () => googleError(429, 'You exceeded your current quota', { status: 'RESOURCE_EXHAUSTED' }), 'quota'],
    ['503 overloaded', () => googleError(503, 'The model is overloaded. Please try again later.'), 'overloaded'],
    ['500 server', () => googleError(500, 'Internal error'), 'server'],
    ['400 other', () => googleError(400, 'Request payload size exceeds the limit'), 'bad-request'],
    ['non-JSON error body', () => new Response('<html>Bad gateway</html>', { status: 502 }), 'server']
  ];
  for (const [name, respond, kind] of statusCases) {
    test(`HTTP ${name} -> ${kind}`, async () => {
      mockFetch(respond);
      await assert.rejects(generateContent(KEY, 'm', []), (e) => {
        assert.equal(e.kind, kind);
        assert.ok(!e.message.includes(KEY));
        return true;
      });
    });
  }

  test('auth errors carry a clear message', async () => {
    mockFetch(() => googleError(400, 'API key not valid.', { details: [{ reason: 'API_KEY_INVALID' }] }));
    await assert.rejects(generateContent(KEY, 'm', []), /Google rejected the Gemini API key.*Settings/);
  });

  test('429 reads retryDelay and the per-day marker', async () => {
    mockFetch(() => googleError(429, 'Quota exceeded for metric generate_content_free_tier_requests, limit: 20. Please retry in 41.2s.',
      { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] }));
    await assert.rejects(generateContent(KEY, 'm', []), (e) => e.kind === 'quota' && e.retryAfterMs === 41000 && !e.perDay);
    mockFetch(() => googleError(429, 'Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
    await assert.rejects(generateContent(KEY, 'm', []), (e) => e.kind === 'quota' && e.perDay);
  });

  test('times out with a "timed out" message', async () => {
    mockFetch(({ init }) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const t0 = Date.now();
    await assert.rejects(generateContent(KEY, 'm', [], { timeoutMs: 30 }), (e) => e.kind === 'timeout' && /timed out/.test(e.message));
    assert.ok(Date.now() - t0 < 1000);
  });

  test('a caller signal aborts the request', async () => {
    mockFetch(({ init }) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(generateContent(KEY, 'm', [], { signal: ctl.signal }), (e) => e.kind === 'aborted');
  });

  test('network failure (Chrome and node wording) -> network', async () => {
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(generateContent(KEY, 'm', []), (e) => e.kind === 'network' && /Failed to fetch/.test(e.message));
    mockFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    await assert.rejects(generateContent(KEY, 'm', []), (e) => e.kind === 'network' && /ENOTFOUND/.test(e.message));
  });

  test('the key never appears in error messages', async () => {
    const leaky = `bad request for ${API_ROOT}/models/m:generateContent?key=${KEY}&alt=json and key ${KEY}`;
    mockFetch(() => googleError(400, leaky));
    await assert.rejects(generateContent(KEY, 'm', []), (e) => !e.message.includes(KEY) && !/key=AIza/.test(e.message));
    mockFetch(() => { throw new TypeError(`connect failed ${API_ROOT}?key=${KEY}`); });
    await assert.rejects(generateContent(KEY, 'm', []), (e) => !e.message.includes(KEY));
    assert.equal(redactSecrets(`x?key=${KEY}&y=1 AQ.Ab12cd34ef56gh78ij90kl12mn`), 'x?key=***&y=1 ***');
  });

  const emptyCases = [
    ['prompt blocked', { promptFeedback: { blockReason: 'SAFETY' } }, 'blocked'],
    ['finish SAFETY', { candidates: [{ finishReason: 'SAFETY' }] }, 'blocked'],
    ['finish RECITATION', { candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }] }, 'blocked'],
    ['MAX_TOKENS with no text', { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }] }, 'empty'],
    ['no candidates', {}, 'empty'],
    ['whitespace only', { candidates: [{ content: { parts: [{ text: '  \n' }] } }] }, 'empty']
  ];
  for (const [name, body, kind] of emptyCases) {
    test(`${name} -> ${kind}`, async () => {
      mockFetch(() => json(body));
      await assert.rejects(generateContent(KEY, 'm', []), (e) => e.kind === kind);
    });
  }

  test('MAX_TOKENS with partial text returns the text for the parser to judge', async () => {
    mockFetch(() => json({ candidates: [{ content: { parts: [{ text: '{"a":' }] }, finishReason: 'MAX_TOKENS' }] }));
    assert.equal(await generateContent(KEY, 'm', []), '{"a":');
  });

  test('a 200 that is not JSON -> server', async () => {
    mockFetch(() => new Response('not json', { status: 200 }));
    await assert.rejects(generateContent(KEY, 'm', []), (e) => e.kind === 'server');
  });

  test('listModels uses the header too', async () => {
    mockFetch(() => json(MODEL_LIST));
    assert.equal((await listModels(KEY)).length, MODEL_LIST.models.length);
    assert.ok(!calls[0].url.includes('key='));
    assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
  });
});

// ---- gemini-models ---------------------------------------------------------

describe('geminiLadder (model discovery)', () => {
  beforeEach(() => resetGeminiLadder());

  test('ranks Flash models newest first, stable before preview, aliases last, lite after strong', async () => {
    mockFetch(() => json(MODEL_LIST));
    assert.deepEqual(await geminiLadder(KEY), LADDER);
  });

  test('rankModels ignores non-generateContent, tts and duplicate models', () => {
    const r = rankModels([...MODEL_LIST.models, MODEL_LIST.models[0], null]);
    assert.deepEqual(r.strong, LADDER.slice(0, 3));
    assert.deepEqual(r.lite, ['models/gemini-3.5-flash-lite']);
  });

  test('caches per key; a new key or a reset asks again', async () => {
    mockFetch(() => json(MODEL_LIST));
    await geminiLadder(KEY);
    await geminiLadder(KEY);
    assert.equal(listCalls().length, 1);
    await geminiLadder(KEY + 'x');
    assert.equal(listCalls().length, 2);
    resetGeminiLadder();
    await geminiLadder(KEY + 'x');
    assert.equal(listCalls().length, 3);
  });

  test('concurrent callers share one discovery', async () => {
    mockFetch(() => json(MODEL_LIST));
    await Promise.all([geminiLadder(KEY), geminiLadder(KEY), geminiLadder(KEY)]);
    assert.equal(listCalls().length, 1);
  });

  test('falls back to the static list when discovery fails, without retrying on every call', async () => {
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    assert.deepEqual(await geminiLadder(KEY), [...STATIC_STRONG, ...STATIC_LITE]);
    await geminiLadder(KEY);
    assert.equal(listCalls().length, 1);
  });

  test('falls back when the key sees no Flash models', async () => {
    mockFetch(() => json({ models: [] }));
    assert.deepEqual(await geminiLadder(KEY), [...STATIC_STRONG, ...STATIC_LITE]);
  });

  test('a rejected key is reported, not papered over with the static list', async () => {
    mockFetch(() => googleError(400, 'API key not valid.', { details: [{ reason: 'API_KEY_INVALID' }] }));
    await assert.rejects(geminiLadder(KEY), (e) => e.kind === 'auth');
  });

  test('checkApiKey', async () => {
    mockFetch(() => json(MODEL_LIST));
    assert.equal(await checkApiKey(KEY), 'valid');
    mockFetch(() => googleError(403, 'denied'));
    assert.equal(await checkApiKey(KEY), 'invalid');
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    assert.equal(await checkApiKey(KEY), 'unknown');
  });
});

// ---- GeminiLadder ----------------------------------------------------------

describe('GeminiLadder', () => {
  beforeEach(() => resetGeminiLadder());

  // byModel: { 'gemini-3.6-flash': () => Response, ... }; unlisted models answer "ok".
  function gemini(byModel = {}) {
    mockFetch(({ url }) => {
      if (/\/models\?/.test(url)) return json(MODEL_LIST);
      const fn = byModel[modelOf(url)];
      return fn ? fn() : answer(`ok from ${modelOf(url)}`);
    });
  }
  const order = () => generateCalls().map((c) => modelOf(c.url));

  test('an overloaded model is skipped on later calls', async () => {
    gemini({ 'gemini-3.6-flash': () => googleError(503, 'overloaded') });
    const ladder = new GeminiLadder();
    assert.equal(await ladder.ask(KEY, []), 'ok from gemini-3-flash-preview');
    assert.equal(await ladder.ask(KEY, []), 'ok from gemini-3-flash-preview');
    assert.deepEqual(order(), ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3-flash-preview']);
  });

  test('quota and retired models are skipped too', async () => {
    gemini({
      'gemini-3.6-flash': () => googleError(429, 'quota exceeded'),
      'gemini-3-flash-preview': () => googleError(404, 'not found')
    });
    const ladder = new GeminiLadder();
    await ladder.ask(KEY, []);
    await ladder.ask(KEY, []);
    assert.deepEqual(order(), ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-flash-latest']);
  });

  test('a rejected key stops after one request', async () => {
    gemini(Object.fromEntries(LADDER.map((m) => [m.slice(7), () => googleError(400, 'API key not valid', { details: [{ reason: 'API_KEY_INVALID' }] })])));
    await assert.rejects(new GeminiLadder().ask(KEY, []), (e) => e.kind === 'auth');
    assert.equal(generateCalls().length, 1);
  });

  test('a blocked prompt is not retried on other models', async () => {
    gemini({ 'gemini-3.6-flash': () => json({ promptFeedback: { blockReason: 'SAFETY' } }) });
    await assert.rejects(new GeminiLadder().ask(KEY, []), (e) => e.kind === 'blocked');
    assert.equal(generateCalls().length, 1);
  });

  test('network down is reported as such after two models', async () => {
    mockFetch(({ url }) => {
      if (/\/models\?/.test(url)) return json(MODEL_LIST);
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(new GeminiLadder({ retryDelayMs: 1 }).ask(KEY, []), (e) => e.message === NETWORK_DOWN);
    assert.equal(generateCalls().length, 6);      // 3 attempts x 2 models
  });

  test('a timeout moves to the next model instead of retrying in place', async () => {
    gemini({ 'gemini-3.6-flash': () => new Promise(() => {}) });
    const text = await new GeminiLadder().ask(KEY, [], { timeoutMs: 20 });
    assert.equal(text, 'ok from gemini-3-flash-preview');
  });

  test('when every model is cooling down it says so', async () => {
    gemini(Object.fromEntries(LADDER.map((m) => [m.slice(7), () => googleError(503, 'overloaded')])));
    const ladder = new GeminiLadder();
    await assert.rejects(ladder.ask(KEY, []), /Every Gemini model failed/);
    await assert.rejects(ladder.ask(KEY, []), /out of quota or overloaded.*Try again in \d+s/);
    assert.equal(generateCalls().length, LADDER.length);
  });

  test('a new key or a reset clears cooldowns', async () => {
    gemini({ 'gemini-3.6-flash': () => googleError(503, 'overloaded') });
    const ladder = new GeminiLadder();
    await ladder.ask(KEY, []);
    gemini();
    assert.equal(await ladder.ask(KEY + 'b', []), 'ok from gemini-3.6-flash');
    gemini({ 'gemini-3.6-flash': () => googleError(503, 'overloaded') });
    await ladder.ask(KEY, []);
    resetGeminiLadder();
    gemini();
    assert.equal(await ladder.ask(KEY, []), 'ok from gemini-3.6-flash');
  });

  test('stickToLastGood asks the last model that answered first', async () => {
    gemini({ 'gemini-3.6-flash': () => googleError(500, 'boom') });
    const ladder = new GeminiLadder({ stickToLastGood: true, cooldowns: false, retryDelayMs: 1 });
    await ladder.ask(KEY, []);
    gemini();
    assert.equal(await ladder.ask(KEY, []), 'ok from gemini-3-flash-preview');
    assert.deepEqual(order(), ['gemini-3-flash-preview']);
  });

  test('a reply the parser rejects moves on to the next model', async () => {
    gemini({ 'gemini-3.6-flash': () => answer('not json'), 'gemini-3-flash-preview': () => answer('{"ok":1}') });
    const out = await new GeminiLadder().ask(KEY, [], { parse: parseModelJSON });
    assert.deepEqual(out, { ok: 1 });
    assert.deepEqual(order(), ['gemini-3.6-flash', 'gemini-3-flash-preview']);
  });

  test('rounds wait between walks, and stopping ends the wait promptly', async () => {
    gemini(Object.fromEntries(LADDER.map((m) => [m.slice(7), () => googleError(503, 'overloaded')])));
    let stop = false;
    const rounds = [];
    const t0 = Date.now();
    const p = new GeminiLadder({ cooldowns: false }).ask(KEY, [], {
      rounds: 3, roundBackoffMs: [0, 10000, 10000], isAborted: () => stop,
      onRound: (r) => { rounds.push(r.waitMs); setTimeout(() => { stop = true; }, 20); }
    });
    await assert.rejects(p, (e) => e.kind === 'aborted');
    assert.deepEqual(rounds, [10000]);
    assert.ok(Date.now() - t0 < 1000);
  });

  test('rounds retry busy models and succeed when one frees up', async () => {
    let busy = true;
    mockFetch(({ url }) => {
      if (/\/models\?/.test(url)) return json(MODEL_LIST);
      return busy ? googleError(503, 'overloaded') : answer('finally');
    });
    const out = await new GeminiLadder({ cooldowns: false }).ask(KEY, [], {
      rounds: 2, roundBackoffMs: [0, 5], onRound: () => { busy = false; }
    });
    assert.equal(out, 'finally');
  });
});

// ---- VisionPlanner ---------------------------------------------------------

describe('VisionPlanner', () => {
  const fakeLadder = (...replies) => {
    const asked = [];
    return { asked, ask: async (key, parts, opts) => { asked.push({ key, parts, opts }); return replies.shift() ?? ''; } };
  };
  const planner = (ladder, key = KEY) => new VisionPlanner({ ladder, readApiKey: async () => key });

  test('decide sends prompt + page + screenshot and normalises the reply', async () => {
    const ladder = fakeLadder('```json\n{"observation":{"page":"Search","state":"ok"},"action":"click","mark":"3"}\n```');
    const a = await planner(ladder).decide({ goal: 'g', shot: { dataUrl: 'data:image/png;base64,QUJD', mimeType: 'image/png' } });
    assert.equal(a.action, 'click');
    assert.equal(a.mark, 3);
    assert.equal(a.page, 'Search');
    const parts = ladder.asked[0].parts;
    assert.equal(parts.length, 3);
    assert.deepEqual(parts[2], { inlineData: { mimeType: 'image/png', data: 'QUJD' } });
    assert.equal(ladder.asked[0].key, KEY);
  });

  test('key problems are reported before any model call', async () => {
    for (const [key, re] of [['', /Add a Gemini API key/], ['   ', /Add a Gemini API key/], ['has spaces in it but long enough', /does not look like/], ['short', /does not look like/]]) {
      const ladder = fakeLadder('{}');
      await assert.rejects(planner(ladder, key).decide({ goal: 'g' }), re);
      assert.equal(ladder.asked.length, 0);
    }
    const ladder = fakeLadder('{"action":"back"}');
    await planner(ladder, `  ${KEY}\n`).decide({ goal: 'g' });
    assert.equal(ladder.asked[0].key, KEY);
  });

  test('empty reply is an error', async () => {
    await assert.rejects(planner(fakeLadder('')).decide({ goal: 'g' }), /Empty response/);
  });

  test('getInitialPlan keeps string steps and falls back on garbage', async () => {
    const p = await planner(fakeLadder('{"steps":["Step 1: a", 7, "", "Step 2: b"],"reasoning":"r"}')).getInitialPlan('goal');
    assert.deepEqual(p.steps, ['Step 1: a', 'Step 2: b']);
    for (const reply of ['nonsense', '{"steps":[]}', '{"steps":"one"}', '[]']) {
      const f = await planner(fakeLadder(reply)).getInitialPlan('buy milk');
      assert.equal(f.steps.length, 2);
      assert.match(f.steps[0], /buy milk/);
    }
  });

  test('verifyDone fails closed', async () => {
    const verdict = (reply) => planner(fakeLadder(reply)).verifyDone({ goal: 'g', claim: 'c' });
    assert.equal((await verdict('garbage')).complete, false);
    assert.equal((await verdict('"just a string"')).complete, false);
    assert.equal((await verdict('{"complete":true,"requirements":[{"need":"x","met":false}]}')).complete, false);
    assert.equal((await verdict('{"complete":true,"requirements":[{"need":"x","met":false}]}')).missing, 'x');
    assert.equal((await verdict('{"complete":"true","evidence":"Order placed"}')).complete, true);
    assert.equal((await verdict('[{"complete":true}]')).complete, true);
    assert.equal((await verdict('{"complete":true,"evidence":{"obj":1}}')).evidence, '');
  });
});

describe('normalizeAction', () => {
  const ok = [
    ['plain click', { action: 'click', mark: 12 }, { action: 'click', mark: 12 }],
    ['string mark', { action: 'click', mark: '7' }, { mark: 7 }],
    ['nested action object', { action: { type: 'click', mark: 9 } }, { action: 'click', mark: 9 }],
    ['params wrapper', { action: 'type', params: { mark: 2, text: 'hi' } }, { action: 'type', mark: 2, text: 'hi', submit: false }],
    ['actions list', { actions: [{ action: 'back' }, { action: 'click', mark: 1 }] }, { action: 'back' }],
    ['list of names', { steps: ['back'] }, { action: 'back' }],
    ['plan next to action keeps the action', { plan: ['Step 1: x'], action: 'click', mark: 4 }, { action: 'click', mark: 4 }],
    ['array wrapper', [{ action: 'scroll', direction: 'UP' }], { action: 'scroll', direction: 'up', amount: 600 }],
    ['alias tap', { action: 'tap', mark: 1 }, { action: 'click' }],
    ['alias with spaces/dashes', { action: 'Go-Back' }, { action: 'back' }],
    ['click with label only', { action: 'click', text: 'Add to cart' }, { action: 'click_text', text: 'Add to cart' }],
    ['click with negative coords falls back to label', { action: 'click', x: -5, y: 10, label: 'OK' }, { action: 'click_text', text: 'OK' }],
    ['type trailing newline submits', { action: 'type', mark: 1, text: 'shoes\n' }, { text: 'shoes', submit: true }],
    ['set_range with currency', { action: 'set_range', value: '₹5,000', bound: 'maximum' }, { value: 5000, bound: 'max' }],
    ['set_range min', { action: 'slider', to: 200, which: 'lower' }, { action: 'set_range', value: 200, bound: 'min' }],
    ['scroll clamps', { action: 'scroll', amount: 99999 }, { direction: 'down', amount: 2000 }],
    ['wait in seconds', { action: 'wait', seconds: 3 }, { ms: 3000 }],
    ['wait clamps', { action: 'sleep', ms: 60000 }, { action: 'wait', ms: 8000 }],
    ['navigate bare domain', { action: 'goto', url: 'mail.google.com' }, { action: 'navigate', url: 'https://mail.google.com/' }],
    ['open_tab', { action: 'new_tab', href: 'https://sheets.new' }, { action: 'open_tab', url: 'https://sheets.new/' }],
    ['key default', { action: 'key' }, { key: 'Enter' }],
    ['remember truncates', { action: 'note', text: 'x'.repeat(2000) }, { action: 'remember' }],
    ['done summary fallback', { action: 'finish', reasoning: 'all good' }, { action: 'done', summary: 'all good' }],
    ['ask_user default', { action: 'handoff' }, { action: 'ask_user', question: 'Please complete this step manually.' }],
    ['switch_tab', { action: 'switch_tab', tab: '2' }, { index: 2 }]
  ];
  for (const [name, raw, expected] of ok) {
    test(name, () => {
      const a = normalizeAction(raw);
      for (const [k, v] of Object.entries(expected)) assert.deepEqual(a[k], v, `${k} of ${name}`);
    });
  }
  test('remember is capped', () => assert.equal(normalizeAction({ action: 'remember', note: 'y'.repeat(3000) }).note.length, 1500));
  test('fractional or negative marks are ignored', () => {
    assert.throws(() => normalizeAction({ action: 'click', mark: 2.5 }), /needs a mark/);
    assert.equal(normalizeAction({ action: 'click', mark: -1, x: 3, y: 4 }).mark, undefined);
  });
  test('observation is read and cleaned', () => {
    const a = normalizeAction({ observation: { page: 'Cart', state: 'Blocked by login', blocker: 'none', plan_step: '2' }, action: 'back' });
    assert.deepEqual(a.observation, { page: 'Cart', state: 'blocked', blocker: '', progress: '', planStep: 2 });
  });
  const bad = [
    ['null', null, /not an object/],
    ['string', 'click', /not an object/],
    ['no name', { mark: 3 }, /no action name/],
    ['unknown action', { action: 'teleport' }, /Unknown action/],
    ['click with nothing', { action: 'click' }, /click needs/],
    ['type without text', { action: 'type', mark: 1, text: '\n' }, /type needs text/],
    ['select without mark', { action: 'select_option', text: 'x' }, /needs a mark/],
    ['set_range without number', { action: 'set_range', value: 'lots' }, /numeric/],
    ['javascript url', { action: 'navigate', url: 'javascript:alert(1)' }, /http\(s\)/],
    ['file url', { action: 'navigate', url: 'file:///etc/passwd' }, /http\(s\)/],
    ['chrome url', { action: 'open_tab', url: 'chrome://settings' }, /http\(s\)/],
    ['data url', { action: 'navigate', url: 'data:text/html,<script>1</script>' }, /http\(s\)/],
    ['switch_tab without index', { action: 'switch_tab' }, /tab index/]
  ];
  for (const [name, raw, re] of bad) test(`rejects ${name}`, () => assert.throws(() => normalizeAction(raw), re));

  test('webUrl', () => {
    assert.equal(webUrl('localhost:3000/a'), 'https://localhost:3000/a');
    assert.equal(webUrl('hello'), '');
    assert.equal(webUrl('https://x.com/a b'), '');
    assert.equal(webUrl('about:blank'), '');
  });
});

describe('prompt building', () => {
  test('buildVisionMessage tolerates an empty context', () => {
    const text = buildVisionMessage({});
    assert.match(text, /GOAL: /);
    assert.match(text, /NO interactive elements/);
  });

  test('buildVisionMessage lists marks, menus, tabs, notes and history', () => {
    const text = buildVisionMessage({
      goal: 'find shoes', plan: ['Step 1: open site'], url: 'https://x.com', title: 'X',
      shot: { imageWidth: 800, imageHeight: 600 },
      marks: [{ mark: 1, role: 'button', name: '  Add   to cart ', disabled: true }, { mark: 2, menu: 'm1' }],
      menus: [{ id: 'm1', kind: 'listbox', label: 'Size' }],
      tabs: [{ title: 'Tab', url: 'https://t.com', active: true }],
      notes: ['price 100'], history: [{ step: 1, summary: 'clicked', outcome: 'ok' }],
      pageUnchanged: true, stuckWarning: 'same click 3 times', analysis: { signals: { captcha: 'I am not a robot' } }
    });
    for (const s of ['GOAL: find shoes', '1. Step 1: open site', 'screenshot size: 800 x 600', '[1] button (DISABLED - cannot be clicked) - "Add to cart"',
      'choose from: [2] ""', '[0] (current) Tab', '1. price 100', '1. clicked -> ok', 'DID NOT CHANGE', 'STUCK IN A LOOP', 'CAPTCHA']) {
      assert.ok(text.includes(s), `missing ${s}`);
    }
  });

  test('a price-limited goal with a slider spells out set_range', () => {
    const text = buildVisionMessage({ goal: 'headphones under ₹5,000', sliders: [{ label: 'Max price', shows: '₹30,000' }] });
    assert.match(text, /"action":"set_range","value":5000,"bound":"max"/);
    const done = buildVisionMessage({ goal: 'headphones under 5k', sliders: [{ label: 'Max price', shows: '₹5,000' }] });
    assert.match(done, /already set/);
  });

  test('priceLimit', () => {
    assert.deepEqual(priceLimit('tv under 25000'), { bound: 'max', value: 25000 });
    assert.deepEqual(priceLimit('over Rs 2,000'), { bound: 'min', value: 2000 });
    assert.equal(priceLimit('best laptop'), null);
  });
});

// ---- optional live check ---------------------------------------------------

function findApiKey(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.apiKey === 'string' && node.apiKey.trim()) return node.apiKey.trim();
  for (const v of Object.values(node)) { const k = findApiKey(v); if (k) return k; }
  return '';
}

test('live Gemini call (GROL_LIVE=1, key file in GROL_LIVE_KEY_FILE)', { skip: process.env.GROL_LIVE !== '1' }, async () => {
  globalThis.fetch = realFetch;
  resetGeminiLadder();
  const key = findApiKey(JSON.parse(readFileSync(process.env.GROL_LIVE_KEY_FILE, 'utf8')));
  assert.ok(key, 'no apiKey in the key file');
  const out = await new GeminiLadder().ask(key, [{ text: 'Reply with the JSON {"ok":true} and nothing else.' }], { json: true, parse: parseModelJSON });
  assert.equal(out.ok, true);
  await assert.rejects(generateContent('AIzaSyINVALIDINVALIDINVALIDINVALID000', 'gemini-flash-latest', [{ text: 'hi' }]),
    (e) => e.kind === 'auth' && !e.message.includes('AIzaSyINVALID'));
});

describe('deadlines: hung models never stall a task', () => {
  const hang = (call) => new Promise((resolve, reject) => {
    call.init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

  test('ladder.ask gives up at deadlineMs even when every model hangs', async () => {
    mockFetch((call) => (call.url.includes('/models?') ? json(MODEL_LIST) : hang(call)));
    const busy = [];
    const ladder = new GeminiLadder({});
    const started = Date.now();
    await assert.rejects(
      ladder.ask(KEY, [{ text: 'hi' }], { timeoutMs: 30000, deadlineMs: 4000, onModelError: (m) => busy.push(m) }),
      (err) => err.kind === 'timeout' && /did not answer within 4s/.test(err.message));
    const took = Date.now() - started;
    assert.ok(took < 6000, `took ${took}ms`);
    assert.ok(busy.length >= 1, 'progress callback fired for the hung model');
  });

  test('getInitialPlan falls back to a generic plan instead of waiting on hung models', async () => {
    mockFetch((call) => (call.url.includes('/models?') ? json(MODEL_LIST) : hang(call)));
    const busy = [];
    const planner = new VisionPlanner({ readApiKey: async () => KEY, onModelBusy: (m) => busy.push(m) });
    const ask = planner.ask.bind(planner);
    planner.ask = (texts, shot, opts) => ask(texts, shot, { ...opts, deadlineMs: 3500 });
    const plan = await planner.getInitialPlan('find a tv');
    assert.ok(plan.steps.length >= 1);
    assert.match(plan.reasoning, /Fallback/);
    assert.ok(busy.length >= 1);
  });
});
