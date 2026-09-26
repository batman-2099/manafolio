const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const codex = require('../codexDeckClient');
const ollama = require('../ollamaDeckClient');
const { validateDeckAddition } = require('../utils/deckRules');
const {
  FORMATS, REVIEW_WARNING, fail, inventoryType, containerIds, sourceDeckId, sourceDeck, preferencesRequest, suggestionRequest, suggestionResponse, draftRequest,
  inventory, cardRules, filterInventory, validateDraft, modelRequest,
} = require('../utils/aiDecks');

const router = express.Router();
const suggesting = new Set();
// ponytail: serialize this endpoint's saves on the app's single SQLite connection.
let saving = false;

function sessionOnly(req, res, next) {
  if (req.user.via_api_key) return res.status(403).json({ error: 'Sign in with your browser session to use AI deck generation and preferences.' });
  next();
}

function endpoint(handler) {
  return async (req, res) => {
    try { await handler(req, res); } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      res.status(status).json({ error: status === 500 ? 'Unable to complete the AI deck request. Please try again.' : error.message });
    }
  };
}

const suggestionLimit = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'AI suggestion limit reached. Try again in an hour.' },
});
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many connection attempts. Try again in 15 minutes.' },
});

router.use((req, res, next) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Sign in to use AI decks.' });
  // The app parser also has a transport limit; keep this feature's request bound explicit.
  const limit = req.path === '/suggest' ? 512 * 1024 : 32768;
  if (req.body && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > limit) {
    return res.status(413).json({ error: `AI deck requests cannot exceed ${limit / 1024} KiB.` });
  }
  next();
});

function client(provider) {
  if (!['chatgpt', 'ollama'].includes(provider)) fail('Choose ChatGPT or Ollama as the AI provider.');
  return provider === 'ollama' ? ollama : codex;
}

async function selectedProvider(req) {
  const preferences = await db.get('SELECT ai_provider, ai_ollama_url FROM users WHERE id = ?', [req.user.id]);
  const provider = req.query.provider ?? preferences.ai_provider;
  client(provider);
  if (req.query.ollama_url !== undefined && provider !== 'ollama') fail('Ollama URL is only available for the Ollama provider.');
  const baseUrl = provider === 'ollama'
    ? ollama.normalizeBaseUrl(req.query.ollama_url ?? preferences.ai_ollama_url)
    : undefined;
  return { provider, baseUrl };
}

router.get('/account', sessionOnly, endpoint(async (req, res) => {
  const { provider, baseUrl } = await selectedProvider(req);
  res.json({ ...await client(provider).account(req.user.id, { baseUrl }), provider });
}));
router.post('/account/login', sessionOnly, loginLimit, endpoint(async (req, res) => {
  res.json(await codex.login(req.user.id));
}));
router.delete('/account', sessionOnly, endpoint(async (req, res) => {
  await codex.logout(req.user.id);
  res.json({ ok: true });
}));
router.get('/models', sessionOnly, endpoint(async (req, res) => {
  const { provider, baseUrl } = await selectedProvider(req);
  res.json(await client(provider).models(req.user.id, { baseUrl }));
}));
router.get('/preferences', sessionOnly, endpoint(async (req, res) => {
  res.json(await db.get('SELECT ai_provider AS provider, ai_model AS model, ai_reasoning_effort AS reasoning_effort, ai_ollama_url AS ollama_url FROM users WHERE id = ?', [req.user.id]));
}));
router.put('/preferences', sessionOnly, endpoint(async (req, res) => {
  const preferences = preferencesRequest(req.body);
  if (preferences.model !== null) {
    const { models } = await client(preferences.provider).models(req.user.id, { baseUrl: preferences.ollama_url });
    const selected = models.find(model => model.id === preferences.model);
    if (!selected) fail('The selected AI model is unavailable. Refresh the model list and try again.');
    if (preferences.reasoning_effort !== null && !selected.reasoningEfforts.includes(preferences.reasoning_effort)) {
      fail('The selected thinking level is not supported by this AI model.');
    }
  }
  await db.run('UPDATE users SET ai_provider = ?, ai_model = ?, ai_reasoning_effort = ?, ai_ollama_url = ? WHERE id = ?',
    [preferences.provider, preferences.model, preferences.reasoning_effort, preferences.ollama_url, req.user.id]);
  res.json(preferences);
}));
router.get('/inventory', endpoint(async (req, res) => {
  const type = inventoryType(req.query.inventory_type);
  const container_ids = req.query.container_ids === undefined ? [] : containerIds(req.query.container_ids, type, true);
  const source = await sourceDeck(req.user.id, sourceDeckId(req.query.source_deck_id, true), { inventory_type: type });
  if (req.query.include_checked_out !== undefined && !['true', 'false'].includes(req.query.include_checked_out)) {
    fail('Include checked-out cards must be true or false.');
  }
  const include_checked_out = req.query.include_checked_out === 'true';
  res.json({ inventory_type: type, cards: await cardRules(await inventory(req.user.id, type, { container_ids, include_checked_out, sourceDeck: source })) });
}));
router.post('/suggest', sessionOnly, suggestionLimit, endpoint(async (req, res) => {
  const { source_deck_id, ...request } = suggestionRequest(req.body);
  const source = await sourceDeck(req.user.id, source_deck_id, request);
  if (suggesting.has(req.user.id)) fail('A deck suggestion is already running for your account.', 429);
  suggesting.add(req.user.id);
  const streaming = req.accepts(['application/json', 'application/x-ndjson']) === 'application/x-ndjson';
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  res.once('close', disconnect);
  const canWrite = () => !res.destroyed && !res.writableEnded;
  const sendEvent = event => {
    if (!canWrite()) return;
    if (!res.headersSent) {
      res.set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
    }
    res.write(`${JSON.stringify(event)}\n`);
    res.flush?.();
  };
  const onProgress = streaming ? progress => sendEvent({ type: 'progress', ...progress }) : undefined;
  try {
    const preferences = await db.get('SELECT ai_provider, ai_model, ai_reasoning_effort, ai_ollama_url FROM users WHERE id = ?', [req.user.id]);
    const model = preferences.ai_model ?? undefined;
    const reasoning_effort = preferences.ai_reasoning_effort ?? undefined;
    const owned = await inventory(req.user.id, request.inventory_type, { ...request, sourceDeck: source });
    if (!canWrite()) return;
    onProgress?.({ stage: 'inventory' });
    onProgress?.({ stage: 'catalog' });
    const cards = filterInventory(await cardRules(owned), request);
    if (!canWrite()) return;
    if (request.current_draft) {
      const ids = new Set(cards.map(card => card.id));
      if (request.current_draft.cards.some(card => !ids.has(card.card_id))
        || (request.current_draft.commander_card_id !== null && !ids.has(request.current_draft.commander_card_id))) {
        fail('The current draft contains a printing outside your selected Magic inventory.');
      }
    }
    onProgress?.({ stage: 'inventory_ready', printings: cards.length, availableCopies: cards.reduce((sum, card) => sum + card.available_qty, 0) });
    const { prompt, schema } = modelRequest(request, cards, source);
    onProgress?.({ stage: 'request_ready', bytes: Buffer.byteLength(prompt, 'utf8') });
    const output = await client(preferences.ai_provider).suggest(req.user.id, prompt, schema, { model, reasoning_effort, signal: controller.signal, baseUrl: preferences.ai_ollama_url }, onProgress);
    if (!canWrite()) return;
    onProgress?.({ stage: 'validating' });
    let response;
    try {
      response = suggestionResponse(output);
      if (response.draft) {
        const draft = response.draft;
        if (draft.inventory_type !== request.inventory_type || draft.format !== request.format || draft.target_size !== request.target_size) {
          fail('The AI changed the requested inventory, format or target size.');
        }
        validateDraft(draft, cards);
        draft.include_checked_out = request.include_checked_out;
        draft.warnings = [REVIEW_WARNING, ...draft.warnings];
        if (request.inventory_type === 'collection' && request.include_checked_out) {
          draft.warnings.push('This draft may use cards from checked-out decks. Return those decks before checking out or playing this deck.');
        }
        const selected = new Set(draft.cards.map(card => card.card_id));
        if (FORMATS[draft.format] && cards.some(card => selected.has(card.id) && !card.legalities?.[FORMATS[draft.format]])) {
          draft.warnings.push('Cached format legality is unavailable for some selected cards; verify their legality yourself.');
        }
      }
    } catch (error) {
      fail(`The AI did not return a valid response or owned-card draft. ${error.status ? error.message : 'Please try again.'} Nothing was saved.`, 502);
    }
    if (streaming) {
      onProgress({ stage: 'complete' });
      sendEvent({ type: 'complete', data: response });
      if (canWrite()) res.end();
    } else res.json(response);
  } catch (error) {
    if (!canWrite()) return;
    if (!res.headersSent) throw error;
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    sendEvent({ type: 'error', error: status === 500 ? 'Unable to complete the AI deck request. Please try again.' : error.message });
    if (canWrite()) res.end();
  } finally {
    res.removeListener('close', disconnect);
    suggesting.delete(req.user.id);
  }
}));

const saveDeck = endpoint(async (req, res) => {
  const replacementId = sourceDeckId(req.params.id, true);
  const draft = draftRequest(req.body);
  if (replacementId !== undefined && draft.source_deck_id !== replacementId) {
    fail('Source deck ID must match the deck being replaced.');
  }
  if (saving) fail('Another deck is being saved. Please try again.', 409);
  saving = true;
  try {
    const id = await db.withTransaction(async () => {
      const source = await sourceDeck(req.user.id, draft.source_deck_id, draft);
      if (replacementId !== undefined) {
        const current = await db.get('SELECT checked_out FROM decks WHERE id = ? AND user_id = ?', [replacementId, req.user.id]);
        if (current.checked_out) fail('Return this deck before replacing it with an AI draft. You can still save it as a new deck.', 409);
      }
      const selected = new Set(draft.cards.map(card => card.card_id));
      const cards = await cardRules((await inventory(req.user.id, draft.inventory_type, { ...draft, sourceDeck: source })).filter(card => selected.has(card.id)));
      validateDraft(draft, cards);
      let deckId = replacementId;
      let pulled;
      if (replacementId !== undefined) {
        pulled = new Map((await db.all('SELECT card_id, checked_out FROM deck_cards WHERE deck_id = ?', [deckId]))
          .map(card => [card.card_id, card.checked_out]));
        await db.run('UPDATE decks SET name = ?, description = ?, commander_card_id = ? WHERE id = ?',
          [draft.name, draft.description, draft.commander_card_id, deckId]);
        await db.run('DELETE FROM deck_cards WHERE deck_id = ?', [deckId]);
      } else {
        const created = await db.run(`INSERT INTO decks
          (user_id, name, description, game, inventory_type, format, target_size, commander_card_id)
          VALUES (?, ?, ?, 'mtg', ?, ?, ?, ?)`,
        [req.user.id, draft.name, draft.description, draft.inventory_type, draft.format, draft.target_size, draft.commander_card_id]);
        deckId = created.lastID;
      }
      for (const card of draft.cards) {
        const check = await validateDeckAddition({ deckId, userId: req.user.id, cardId: card.card_id, newQty: card.quantity });
        if (!check.ok) fail(check.error);
        await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES (?, ?, ?, ?)',
          [deckId, card.card_id, card.quantity, pulled?.get(card.card_id) || 0]);
      }
      return deckId;
    });
    res.status(replacementId === undefined ? 201 : 200).json({ id });
  } finally {
    saving = false;
  }
});

router.post('/', saveDeck);
router.put('/:id', saveDeck);

module.exports = router;
