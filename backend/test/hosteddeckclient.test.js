const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const axios = require('axios');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-hosted-decks-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'hosted-deck-test-password';
const db = require('../src/db');
const hosted = require('../src/hostedDeckClient');
const { modelRequest } = require('../src/utils/aiDecks');
const { authenticateToken } = require('../src/middleware/auth');
const { sanitizeUser } = require('../src/utils/authHelpers');
const settings = { inventory_type: 'collection', format: 'Casual', target_size: 1, prompt: 'Build my deck.' };
const valid = { message: 'Here is your deck.', draft: {
  name: 'Owned deck', description: '', inventory_type: 'collection', format: 'Casual', target_size: 1,
  commander_card_id: null, cards: [{ card_id: 'mtg-hosted-forest', quantity: 1 }], warnings: [],
} };
const choices = content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] });
const candidates = content => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(content) }] } }] });
let replies = { gemini: candidates(valid), openrouter: choices(valid) };
const keys = { gemini: ['gemini-user-one-secret', 'gemini-user-two-secret'], openrouter: ['openrouter-user-one-secret', 'openrouter-user-two-secret'] };
const modelIds = { gemini: 'gemini-2.5-flash', openrouter: 'vendor/structured:free' };
const modelInfo = { id: modelIds.openrouter, name: 'Structured free model', supported_parameters: ['structured_outputs', 'response_format'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } };
let modelReply = { data: [modelInfo, { ...modelInfo, id: 'vendor/plain', supported_parameters: ['response_format'] }, { ...modelInfo, id: 'vendor/image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } }] };
let geminiPage = false;
let status;
let hold;
const calls = [];
const oldAdapter = axios.defaults.adapter;
axios.defaults.adapter = async config => {
  if (config.signal.aborted) throw new Error('Canceled before sending');
  const url = new URL(config.url);
  const provider = url.hostname === 'generativelanguage.googleapis.com' ? 'gemini' : 'openrouter';
  assert.strictEqual(url.origin, provider === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://openrouter.ai');
  const key = provider === 'gemini' ? config.headers.get('x-goog-api-key') : config.headers.get('Authorization')?.replace(/^Bearer /, '');
  assert.ok(keys[provider].includes(key) || key === 'rejected-secret', 'only the requesting user credential may reach the provider');
  assert.ok(!url.href.includes(key), 'credentials must never appear in URLs');
  const body = config.data ? JSON.parse(config.data) : undefined;
  calls.push({ provider, key, path: url.pathname, body });
  if (hold === config.method) {
    hold = null;
    return new Promise((resolve, reject) => {
      config.signal.addEventListener('abort', () => reject(new Error('provider-secret canceled')), { once: true });
      holdStarted();
    });
  }
  if (status || key === 'rejected-secret') {
    throw Object.assign(new Error(`provider-secret ${key}`), { response: { status: status || 401, data: { error: key } } });
  }
  let result;
  if (url.pathname.endsWith('/key')) result = { data: { label: key, is_management_key: false } };
  else if (config.method === 'get') {
    if (provider === 'openrouter') result = modelReply;
    else if (geminiPage && !url.searchParams.has('pageToken')) result = { models: [], nextPageToken: 'second-page' };
    else result = { models: [
      { name: `models/${modelIds.gemini}`, displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    ] };
  } else {
    if (provider === 'gemini') {
      // Simulate Gemini's schema subset rather than accepting an OpenAI schema by accident.
      const encoded = JSON.stringify(body.generationConfig.responseJsonSchema);
      assert.ok(!encoded.includes('minLength') && !encoded.includes('maxLength'));
      assert.deepStrictEqual(body.generationConfig.responseJsonSchema.properties.draft.anyOf[1], { type: 'null' });
    } else {
      assert.strictEqual(body.model, modelIds.openrouter, 'a free selection must never route to a paid model');
      assert.strictEqual(body.provider.require_parameters, true, 'unsupported structured-output endpoints must be excluded');
      assert.strictEqual(body.provider.allow_fallbacks, false);
      assert.ok(!body.models, 'no fallback model list is permitted');
    }
    result = replies[provider];
  }
  return { status: 200, statusText: 'OK', headers: {}, config, data: typeof result === 'string' ? result : JSON.stringify(result) };
};
let holdStarted;
let server;
let base;
async function api(method, route, body, token = 'session-one') {
  const response = await fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const ai = (method, route, body, token) => api(method, `/api/ai-decks${route}`, body, token);
async function main() {
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'not-a-password', 'other-share')");
    await db.run("UPDATE users SET api_key = 'readonly-one' WHERE id = 1");
    for (const [id, token] of [[1, 'session-one'], [2, 'session-two']]) {
      await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01')", [token, id]);
    }
    await db.run("INSERT INTO card_cache (id, name, game, supertype, subtypes, types) VALUES ('mtg-hosted-forest', 'Forest', 'mtg', 'MTG', '[\"Basic\",\"Land\"]', '[]')");
    await db.run("INSERT INTO collection (card_id, quantity, user_id, list_type, game) VALUES ('mtg-hosted-forest', 1, 1, 'collection', 'mtg')");
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/ai-decks', authenticateToken, require('../src/routes/aiDecks'));
    app.use('/api/auth', require('../src/routes/auth'));
    app.use('/api/admin', require('../src/routes/admin'));
    app.use('/api', authenticateToken, require('../src/routes/importExport'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    assert.strictEqual((await ai('PUT', '/credentials', { provider: 'gemini', api_key: keys.gemini[0] }, '')).status, 401);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const route = method === 'GET' ? '/account?provider=gemini' : '/credentials?provider=gemini';
      assert.strictEqual((await ai(method, route, method === 'PUT' ? { provider: 'gemini', api_key: keys.gemini[0] } : undefined, 'readonly-one')).status, 403);
    }
    const initialPreferences = (await ai('GET', '/preferences')).body;
    for (const provider of ['gemini', 'openrouter']) {
      assert.deepStrictEqual((await ai('GET', `/account?provider=${provider}`)).body, { provider, connected: false });
      assert.strictEqual((await ai('GET', `/models?provider=${provider}`)).status, 409);
      for (const [index, token] of ['session-one', 'session-two'].entries()) {
        assert.deepStrictEqual(await ai('PUT', '/credentials', { provider, api_key: keys[provider][index] }, token), { status: 200, body: { ok: true } });
      }
      assert.deepStrictEqual((await ai('GET', `/account?provider=${provider}`)).body, { provider, connected: true });
      await ai('GET', `/account?provider=${provider}`, undefined, 'session-two');
      assert.strictEqual(calls.at(-1).key, keys[provider][1]);
    }
    assert.deepStrictEqual((await ai('GET', '/preferences')).body, initialPreferences, 'connecting providers must not change the saved selection');
    const rejected = await ai('PUT', '/credentials', { provider: 'gemini', api_key: 'rejected-secret' });
    assert.strictEqual(rejected.status, 400);
    assert.ok(!JSON.stringify(rejected).includes('rejected-secret'));
    assert.strictEqual((await db.get('SELECT ai_gemini_api_key AS key FROM users WHERE id = 1')).key, keys.gemini[0], 'failed validation must preserve the working key');
    for (const body of [{ provider: 'chatgpt', api_key: 'x' }, { provider: 'gemini', api_key: 'x\nsecret' }, { provider: 'gemini', api_key: keys.gemini[0], user_id: 2 }]) {
      assert.strictEqual((await ai('PUT', '/credentials', body)).status, 400);
    }
    assert.strictEqual((await ai('DELETE', '/credentials')).status, 400);
    assert.strictEqual((await ai('DELETE', '/credentials?provider=gemini')).status, 200);
    assert.deepStrictEqual((await ai('GET', '/account?provider=gemini')).body, { provider: 'gemini', connected: false });
    assert.strictEqual((await ai('GET', '/account?provider=openrouter')).body.connected, true);
    assert.strictEqual((await ai('GET', '/account?provider=gemini', undefined, 'session-two')).body.connected, true);
    await hosted.saveCredentials(1, { provider: 'gemini', api_key: keys.gemini[0] });
    geminiPage = true;
    assert.deepStrictEqual((await hosted.gemini.models(1)).models.map(model => model.id), [modelIds.gemini]);
    geminiPage = false;
    assert.deepStrictEqual((await ai('GET', '/models?provider=openrouter')).body.models.map(model => model.id), [modelIds.openrouter]);

    for (const provider of ['gemini', 'openrouter']) {
      const preferences = { provider, model: modelIds[provider], reasoning_effort: null, ollama_url: null };
      assert.strictEqual((await ai('PUT', '/preferences', { ...preferences, model: null })).status, 400);
      assert.strictEqual((await ai('PUT', '/preferences', { ...preferences, reasoning_effort: 'high' })).status, 400);
      assert.strictEqual((await ai('PUT', '/preferences', { ...preferences, model: 'missing' })).status, 400);
      assert.deepStrictEqual((await ai('PUT', '/preferences', preferences)).body, preferences);
      const response = await ai('POST', '/suggest', settings);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body.draft.cards, valid.draft.cards);
      const complete = replies[provider];
      const wrap = provider === 'gemini' ? candidates : choices;
      replies[provider] = wrap({ ...valid, draft: { ...valid.draft, cards: [{ card_id: 'mtg-not-owned', quantity: 1 }] } });
      assert.strictEqual((await ai('POST', '/suggest', settings)).status, 502, 'hosted output must pass owned inventory validation');
      replies[provider] = wrap({ ...valid, message: 'x'.repeat(8001) });
      assert.strictEqual((await ai('POST', '/suggest', settings)).status, 502, 'local string bounds remain enforced for Gemini');
      replies[provider] = wrap({ message: 'What play style?', draft: null });
      assert.deepStrictEqual((await ai('POST', '/suggest', settings)).body, { message: 'What play style?', draft: null });
      replies[provider] = complete;
    }
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM decks')).count, 0, 'suggestions and rejected outputs never save decks');
    const { prompt, schema } = modelRequest(settings, []);
    for (const provider of ['gemini', 'openrouter']) {
      const suggest = options => hosted[provider].suggest(1, prompt, schema, { model: modelIds[provider], ...options });
      const complete = replies[provider];
      const invalidReplies = provider === 'gemini' ? [
        { candidates: [null] }, { candidates: [{ ...complete.candidates[0], finishReason: 'MAX_TOKENS' }] },
        { candidates: [{ ...complete.candidates[0], finishReason: 'SAFETY' }] },
        { ...complete, promptFeedback: { blockReason: 'SAFETY' } },
        { candidates: [{ ...complete.candidates[0], content: { parts: [{ thought: true, text: JSON.stringify(valid) }] } }] },
        { candidates: [{ ...complete.candidates[0], content: { parts: [{ functionCall: { name: 'tool' } }] } }] },
        { candidates: [{ ...complete.candidates[0], content: { parts: [{ text: '```json\n{}\n```' }] } }] },
      ] : [
        { choices: [null] }, { choices: [{ ...complete.choices[0], finish_reason: 'length' }] },
        { choices: [{ ...complete.choices[0], finish_reason: null }] },
        { choices: [{ ...complete.choices[0], message: { content: JSON.stringify(valid), refusal: 'provider-secret' } }] },
        { choices: [{ ...complete.choices[0], message: { content: JSON.stringify(valid), tool_calls: [{}] } }] },
        { choices: [{ ...complete.choices[0], message: { content: '[]' } }] },
        { choices: [{ ...complete.choices[0], message: { content: '{"message":' } }] },
      ];
      for (const reply of [...invalidReplies, { error: 'provider-secret' }, 'provider-secret not JSON', 'x'.repeat(1024 * 1024 + 1)]) {
        replies[provider] = reply;
        await assert.rejects(() => suggest(), error => error.status === 502 && !error.message.includes('provider-secret'));
      }
      replies[provider] = complete;
      const count = calls.length;
      await assert.rejects(() => hosted[provider].suggest(1, 'x'.repeat(512 * 1024 + 1), schema, { model: modelIds[provider] }), error => error.status === 413);
      await assert.rejects(() => suggest({ model: undefined }), error => error.status === 400);
      assert.strictEqual(calls.length, count, 'invalid requests must fail before contacting providers');
      await assert.rejects(() => suggest({ model: 'missing' }), error => error.status === 400);
      for (const method of ['get', 'post']) {
        const controller = new AbortController();
        hold = method;
        const started = new Promise(resolve => { holdStarted = resolve; });
        const pending = suggest({ signal: controller.signal });
        const rejected = assert.rejects(pending, error => error.status === 499);
        await started;
        controller.abort();
        await rejected;
      }
      for (const failureStatus of [401, 402, 429, 500]) {
        status = failureStatus;
        await assert.rejects(() => suggest(), error => error.status === ({ 401: 400, 402: 402, 429: 429, 500: 502 })[failureStatus]
          && !error.message.includes('secret'));
      }
      status = undefined;
    }
    modelReply = { data: [] };
    await assert.rejects(() => hosted.openrouter.suggest(1, prompt, schema, { model: modelIds.openrouter }), error => error.status === 400);
    const safeResponses = [
      await api('GET', '/api/export?format=backup'), await api('GET', '/api/auth/me'),
      await api('GET', '/api/auth/me', undefined, 'readonly-one'), await api('GET', '/api/admin/users'),
      await ai('GET', '/preferences'),
    ];
    for (const response of safeResponses) assert.strictEqual(response.status, 200);
    assert.strictEqual(safeResponses[0].body.format, 'manafolio-backup');
    assert.strictEqual(safeResponses[0].body.collection[0].card_id, 'mtg-hosted-forest');
    safeResponses.push(sanitizeUser(await db.get('SELECT * FROM users WHERE id = 1')));
    const encoded = JSON.stringify(safeResponses);
    for (const secret of Object.values(keys).flat()) assert.ok(!encoded.includes(secret), 'account responses and account backups must exclude hosted keys');
    assert.ok(!encoded.includes('ai_gemini_api_key') && !encoded.includes('ai_openrouter_api_key'));
    assert.strictEqual((await api('DELETE', '/api/admin/users/2')).status, 200);
    assert.strictEqual(await db.get('SELECT ai_gemini_api_key, ai_openrouter_api_key FROM users WHERE id = 2'), undefined);
    assert.strictEqual((await ai('GET', '/account?provider=gemini', undefined, 'session-two')).status, 401);
    console.log('Hosted provider completeness, validation, cancellation, credential isolation, deletion and backup privacy checks passed');
  } finally {
    axios.defaults.adapter = oldAdapter;
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
