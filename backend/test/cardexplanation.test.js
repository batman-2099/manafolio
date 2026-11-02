const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const axios = require('axios');
const sharp = require('sharp');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-explain-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'explanation-test-password';
const db = require('../src/db');
const art = require('../src/cardArt');
const bulk = require('../src/scryfallBulk');
const originalResolve = bulk.resolveRows;
const originalAdapter = axios.defaults.adapter;
const httpAdapter = axios.getAdapter(originalAdapter);
const cardId = 'mtg-00000000-0000-4000-8000-000000000001';
const calls = [];
let vision = true;
let result = { explanation: 'Pay {R}.\nDeal 3 damage to any target. AI may be wrong.' };
let providerError = false;
let holdStarted;
let holdCanceled;
let server;
let providerServer;
let base;
let image;
let imageDownloads = 0;
let imageError = false;
const openrouterModel = { id: 'fixture/vision', name: 'Fixture', supported_parameters: ['structured_outputs'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } };

async function api(body = { card_id: cardId, locale: 'de-DE' }, token = 'session-one', signal) {
  const response = await fetch(`${base}/api/ai-decks/explain?provider=ignored`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal,
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'not-a-password', 'other-share')");
    await db.run("UPDATE users SET api_key = 'readonly-one' WHERE id = 1");
    for (const [id, token] of [[1, 'session-one'], [2, 'session-two']]) {
      await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01')", [token, id]);
      await db.run('UPDATE users SET ai_gemini_api_key = ?, ai_openrouter_api_key = ? WHERE id = ?', [`gemini-secret-${id}`, `openrouter-secret-${id}`, id]);
    }
    await db.run("INSERT INTO card_cache (id, name, game, image_url, set_name, number, price_trend) VALUES (?, 'Lightning Bolt', 'mtg', 'https://private.invalid/do-not-fetch', 'Fixture Set', '7', 99)", [cardId]);
    await db.run("INSERT INTO collection (card_id, user_id, quantity, notes) VALUES (?, 1, 17, 'SECRET INVENTORY NOTES')", [cardId]);
    bulk.resolveRows = async rows => ({ pairs: rows.map(row => ({ row, raw: {
      name: 'Lightning Bolt', type_line: 'Instant', mana_cost: '{R}', oracle_text: 'Deal 3 damage to any target.',
      card_faces: [{ name: 'Front', oracle_text: 'Front rules', notes: 'SECRET FACE NOTES' }, { name: 'Back', oracle_text: 'Back rules' }],
    } })) });
    image = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#ff0000' } }).png().toBuffer();
    await art.save(cardId, image);
    axios.defaults.adapter = async config => {
      const url = new URL(config.url);
      if (url.hostname === '127.0.0.1') return httpAdapter(config);
      if (url.hostname === 'cards.scryfall.io') {
        imageDownloads++;
        assert.strictEqual(config.maxRedirects, 0);
        assert.strictEqual(config.maxContentLength, art.MAX_UPLOAD_BYTES);
        if (imageError) throw new Error('unsafe redirect or download error');
        return { status: 200, headers: {}, config, data: image };
      }
      assert.ok(['generativelanguage.googleapis.com', 'openrouter.ai'].includes(url.hostname), 'never fetch arbitrary artwork URLs');
      const gemini = url.hostname === 'generativelanguage.googleapis.com';
      const key = gemini ? config.headers.get('x-goog-api-key') : config.headers.get('Authorization').replace('Bearer ', '');
      let response;
      if (url.pathname.endsWith('/key')) response = { data: { is_management_key: false } };
      else if (config.method === 'get') response = gemini
        ? { models: [{ name: 'models/gemini-fixture', displayName: 'Gemini fixture', supportedGenerationMethods: ['generateContent'] }] }
        : { data: [{ ...openrouterModel, architecture: { ...openrouterModel.architecture, input_modalities: vision ? ['text', 'image'] : ['text'] } }] };
      else {
        const body = JSON.parse(config.data);
        calls.push({ provider: gemini ? 'gemini' : 'openrouter', key, body });
        if (providerError) throw Object.assign(new Error(`PRIVATE ${key}`), { response: { status: 500 } });
        response = gemini ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }] }
          : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] };
      }
      return { status: 200, headers: {}, config, data: JSON.stringify(response) };
    };
    const provider = express();
    provider.use(express.json({ limit: '4mb' }));
    provider.get('/api/tags', (_req, res) => res.json({ models: [{ model: 'fixture-vision', name: 'Fixture vision' }] }));
    provider.post('/api/show', (_req, res) => res.json({ capabilities: vision ? ['completion', 'vision'] : ['completion'] }));
    provider.post('/api/chat', (req, res) => {
      calls.push({ provider: 'ollama', body: req.body });
      if (holdStarted) {
        const started = holdStarted;
        holdStarted = null;
        res.once('close', () => holdCanceled());
        started();
        return;
      }
      res.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify(result) } });
    });
    providerServer = provider.listen(0, '127.0.0.1');
    await new Promise(resolve => providerServer.once('listening', resolve));
    const app = express();
    app.use(express.json());
    app.use('/api/ai-decks', require('../src/middleware/auth').authenticateToken, require('../src/routes/aiDecks'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const select = async (provider, user = 1) => db.run('UPDATE users SET ai_provider = ?, ai_model = ?, ai_reasoning_effort = NULL, ai_ollama_url = ? WHERE id = ?',
      [provider, provider === 'gemini' ? 'gemini-fixture' : provider === 'openrouter' ? openrouterModel.id : 'fixture-vision', `http://127.0.0.1:${providerServer.address().port}`, user]);
    await select('gemini');
    assert.strictEqual((await api(undefined, '')).status, 401);
    assert.strictEqual((await api(undefined, 'readonly-one')).status, 403);
    for (const body of [{ card_id: cardId, image_url: 'http://localhost/private' }, { card_id: '../secret' }, { card_id: cardId, locale: 'not a language' }, []]) {
      assert.strictEqual((await api(body)).status, 400);
    }
    for (const provider of ['gemini', 'openrouter', 'ollama']) {
      await select(provider);
      assert.deepStrictEqual(await api(), { status: 200, body: result });
      const call = calls.at(-1);
      let prompt;
      let bytes;
      if (provider === 'gemini') {
        assert.strictEqual(call.key, 'gemini-secret-1');
        prompt = call.body.contents[0].parts[0].text;
        bytes = Buffer.from(call.body.contents[0].parts[1].inlineData.data, 'base64');
        assert.strictEqual(call.body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
      } else if (provider === 'openrouter') {
        assert.strictEqual(call.key, 'openrouter-secret-1');
        prompt = call.body.messages[0].content[0].text;
        bytes = Buffer.from(call.body.messages[0].content[1].image_url.url.split(',')[1], 'base64');
        assert.strictEqual(call.body.provider.allow_fallbacks, false);
      } else {
        prompt = call.body.messages[1].content;
        bytes = Buffer.from(call.body.messages[1].images[0], 'base64');
        assert.strictEqual(call.body.model, 'fixture-vision');
      }
      assert.ok(prompt.includes('de-DE') && prompt.includes('untrusted'));
      const metadata = JSON.parse(prompt.split('CARD DATA:\n')[1]);
      assert.strictEqual(metadata.id, cardId);
      assert.strictEqual(metadata.mana_cost, '{R}');
      assert.strictEqual(metadata.card_faces[1].oracle_text, 'Back rules');
      assert.ok(!/SECRET|price_trend|image_url|quantity|location|api_key/.test(JSON.stringify(metadata)), 'only public metadata reaches AI');
      const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      assert.strictEqual(decoded.info.width, 20);
      assert.ok(decoded.data[0] > 240 && decoded.data[1] < 10, 'actual red card image bytes, not a URL or placeholder');
    }
    await select('openrouter', 2);
    assert.strictEqual((await api(undefined, 'session-two')).status, 200);
    assert.strictEqual(calls.at(-1).key, 'openrouter-secret-2');
    await db.run('UPDATE users SET ai_openrouter_api_key = NULL WHERE id = 2');
    assert.strictEqual((await api(undefined, 'session-two')).status, 409);
    for (const provider of ['openrouter', 'ollama']) {
      await select(provider);
      vision = false;
      const before = calls.length;
      const rejected = await api();
      assert.strictEqual(rejected.status, 400);
      assert.match(rejected.body.error, /image input/);
      assert.strictEqual(calls.length, before, 'unsupported models never receive a text-only request');
    }
    vision = true;
    await select('gemini');
    providerError = true;
    const failed = await api();
    assert.strictEqual(failed.status, 502);
    assert.ok(!/PRIVATE|secret/.test(failed.body.error));
    providerError = false;
    result = { explanation: 'x'.repeat(12001) };
    assert.strictEqual((await api()).status, 502);
    result = { explanation: 'Restored explanation' };
    art.remove(cardId);
    const before = calls.length;
    assert.strictEqual((await api()).status, 422);
    assert.strictEqual(calls.length, before);
    assert.strictEqual(imageDownloads, 0, 'custom art wins; untrusted fallback is never downloaded');
    await db.run("UPDATE card_cache SET image_url = 'https://cards.scryfall.io/fixture.jpg' WHERE id = ?", [cardId]);
    assert.strictEqual((await api()).status, 200);
    assert.strictEqual(imageDownloads, 1);
    imageError = true;
    assert.strictEqual((await api()).status, 422);
    imageError = false;
    await art.save(cardId, image);
    bulk.resolveRows = async () => ({ pairs: [] });
    await db.run("UPDATE card_cache SET name_back = 'Native back' WHERE id = ?", [cardId]);
    assert.strictEqual((await api({ card_id: cardId })).status, 200);
    const uncachedPrompt = calls.at(-1).body.contents[0].parts[0].text;
    const uncachedCard = JSON.parse(uncachedPrompt.split('CARD DATA:\n')[1]);
    assert.deepStrictEqual(uncachedCard.card_faces.map(face => face.name), ['Lightning Bolt', 'Native back']);
    assert.ok(uncachedPrompt.includes('in en.') && uncachedPrompt.includes('acknowledge missing rules'));
    await select('ollama', 2);
    const started = new Promise(resolve => { holdStarted = resolve; });
    const canceled = new Promise(resolve => { holdCanceled = resolve; });
    const controller = new AbortController();
    const pending = api(undefined, 'session-two', controller.signal);
    const aborted = assert.rejects(pending, error => error.name === 'AbortError');
    await started;
    assert.strictEqual((await api(undefined, 'session-two')).status, 429);
    controller.abort();
    await aborted;
    await canceled;
    assert.strictEqual((await api(undefined, 'session-two')).status, 200, 'disconnect frees the in-flight guard');
    console.log('Card explanation authenticated provider, artwork, privacy, failure and cancellation checks passed');
  } finally {
    axios.defaults.adapter = originalAdapter;
    bulk.resolveRows = originalResolve;
    for (const listener of [server, providerServer]) {
      if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    }
    await require('../src/codexDeckClient').shutdown();
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
