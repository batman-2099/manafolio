// Demo mode: no backend. Seed a fake logged-in admin and answer every /api
// request from bundled JSON fixtures so the static GitHub Pages build is a
// read-only tour of the real UI. Only bundled when VITE_DEMO is set (see
// main.jsx guard) so production/mobile builds carry none of this.
import themes from '../../../shared/themes.json';
import storageUnitTypes from '../../../shared/storageUnitTypes.json';
import { prepareStorageImage } from '../utils/prepareImage';

// Route = '/api/' + fixture basename with '_' -> '/'. Capture filenames were
// chosen so this mapping is exact: stats_history -> /api/stats/history,
// locations_43_compartments -> /api/locations/43/compartments, etc.
const files = import.meta.glob('./fixtures/*.json', { eager: true, import: 'default' });
const routes = {};
for (const [path, data] of Object.entries(files)) {
  const base = path.replace(/^.*\/fixtures\//, '').replace(/\.json$/, '');
  routes['/api/' + base.replace(/_/g, '/')] = data;
}

// Pretend an admin is logged in so App skips the login screen and every tab
// (including Admin) is reachable. No real token/secret involved.
localStorage.setItem('manafolio_token', 'demo');
localStorage.setItem('manafolio_user', JSON.stringify(routes['/api/auth/me'].user));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function unitCoverChoices(unitId) {
  const locations = routes['/api/locations'].filter(location => location.storage_unit_id === unitId);
  const cards = routes['/api/collection'].filter(card => card.quantity > 0 && card.game === 'mtg' && card.image_url?.trim() && locations.some(location =>
    location.id === card.location_id && ['collection', 'graveyard'].includes(location.inventory_type || 'collection')
    && (card.list_type || 'collection') === (location.inventory_type || 'collection')));
  cards.sort((a, b) => (b.added_at || '').localeCompare(a.added_at || '') || a.entry_id - b.entry_id);
  return [...new Map(cards.map(card => [card.card_id, {
    card_id: card.card_id, name: card.name, game: card.game, image_url: card.image_url,
  }])).values()];
}

let aiPreferences = { provider: 'chatgpt', model: null, reasoning_effort: null, ollama_url: null };
const aiConnections = { chatgpt: false, ollama: true, gemini: false, openrouter: false };
const aiModels = {
  chatgpt: [{ id: 'gpt-5.4', name: 'GPT-5.4', isDefault: true, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' }],
  ollama: [{ id: 'llama3.2:latest', name: 'llama3.2:latest', reasoningEfforts: [] }],
  gemini: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoningEfforts: [] }],
  openrouter: [{ id: 'openrouter/free', name: 'Free Models Router', reasoningEfforts: [] }],
};
const orig = window.fetch.bind(window);

window.fetch = async (input, opts = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  // Non-API traffic (fonts, Scryfall card images) still hits the network.
  if (!url.includes('/api/')) return orig(input, opts);

  const method = (opts.method || 'GET').toUpperCase();
  const path = (url.replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/+$/, '')) || '/';
  if (path.startsWith('/api/trades/')) {
    return json({ error: 'Trade inventory changes require a server installation; the demo cannot commit trades.' }, 503);
  }

  if (path === '/api/storage-units' || /^\/api\/storage-units\/\d+(?:\/cover-choices)?$/.test(path)) {
    const units = routes['/api/storage-units'];
    const id = path === '/api/storage-units' ? null : Number(path.split('/')[3]);
    const unit = units.find(item => item.id === id);
    if (method === 'GET' && id === null) return Promise.resolve(json(units.map(item => {
      const choices = unitCoverChoices(item.id);
      return { ...item, cover_card_id: item.cover_card_id ?? null, cover_image: item.cover_image ?? null,
        cover: item.cover_image ? { card_id: null, name: item.name, game: 'mtg', image_url: item.cover_image } : choices.find(card => card.card_id === item.cover_card_id) || choices[0] || null,
        container_count: routes['/api/locations'].filter(location => location.storage_unit_id === item.id).length };
    })));
    if (id !== null && !unit) return Promise.resolve(json({ error: 'Storage unit not found.' }, 404));
    if (method === 'GET' && path.endsWith('/cover-choices')) return Promise.resolve(json(unitCoverChoices(id).sort((a, b) => a.name.localeCompare(b.name) || a.card_id.localeCompare(b.card_id))));
    if (method === 'DELETE' && unit) {
      routes['/api/storage-units'] = units.filter(item => item.id !== id);
      routes['/api/locations'].forEach(location => {
        if (location.storage_unit_id === id) Object.assign(location, { storage_unit_id: null, storage_unit_name: null });
      });
      return Promise.resolve(json({ message: 'Storage unit deleted; containers retained.' }));
    }
    if (method === 'POST' || method === 'PUT') {
      const { name, type, cover_card_id, cover_image } = JSON.parse(opts.body || '{}');
      if (cover_image !== undefined && cover_card_id !== undefined) return json({ error: 'Choose either an upload or a card image.' }, 400);
      let image;
      if (cover_image !== undefined) {
        try {
          if (typeof cover_image !== 'string' || cover_image.length >= 700_000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(cover_image)) throw new Error('format');
          image = await prepareStorageImage(await (await orig(cover_image)).blob());
        } catch {
          return json({ error: 'Choose a static PNG, JPEG or WebP image.' }, 400);
        }
      }
      if (type !== undefined && !storageUnitTypes.includes(type)) return Promise.resolve(json({ error: 'Choose a valid storage unit type.' }, 400));
      if ((method === 'POST' || name !== undefined) && (typeof name !== 'string' || !name.trim() || name.trim().length > 200)) return Promise.resolve(json({ error: 'Enter a name of up to 200 characters.' }, 400));
      if (cover_card_id != null && !unitCoverChoices(id).some(card => card.card_id === cover_card_id)) return Promise.resolve(json({ error: 'Choose a card from this storage unit.' }, 400));
      if (unit) {
        if (name !== undefined) unit.name = name.trim();
        if (cover_card_id !== undefined) Object.assign(unit, { cover_card_id, cover_image: null });
        if (image !== undefined) Object.assign(unit, { cover_card_id: null, cover_image: image });
        if (type !== undefined) unit.type = type;
        routes['/api/locations'].forEach(location => {
          if (location.storage_unit_id === id) location.storage_unit_name = unit.name;
        });
        return Promise.resolve(json({ message: 'Storage unit updated.' }));
      }
      const created = { id: Math.max(0, ...units.map(item => item.id)) + 1, name: name.trim(), type: type ?? 'Other', container_count: 0, cover_card_id: null, cover_image: null, cover: null };
      units.push(created);
      return Promise.resolve(json(created, 201));
    }
    return Promise.resolve(json({ error: 'Unsupported storage unit request.' }, 405));
  }
  if ((method === 'PUT' && /^\/api\/locations\/\d+$/.test(path)) || (method === 'POST' && path === '/api/locations')) {
    const body = JSON.parse(opts.body || '{}');
    const unit = routes['/api/storage-units'].find(item => item.id === body.storage_unit_id);
    if (body.storage_unit_id != null && !unit) return Promise.resolve(json({ error: 'Storage unit not found.' }, 404));
    let location = routes['/api/locations'].find(item => item.id === Number(path.split('/').pop()));
    if (method === 'POST') {
      const { count = 1, capacity = 9 } = body.compartmentPlan || {};
      location = { id: Math.max(0, ...routes['/api/locations'].map(item => item.id)) + 1, locked: 0, total_cards: 0, compartment_count: count, total_capacity: count * capacity, inventory_type: 'collection', storage_unit_id: null, storage_unit_name: null };
      routes['/api/locations'].push(location);
      routes[`/api/locations/${location.id}/compartments`] = Array.from({ length: count }, (_, index) => ({
        id: location.id * 1000 + index, location_id: location.id, idx: index + 1, capacity, locked: 0, display_label: String(index + 1),
      }));
    }
    if (!location) return Promise.resolve(json({ error: 'Container not found.' }, 404));
    Object.assign(location, body);
    if (Object.hasOwn(body, 'storage_unit_id')) location.storage_unit_name = unit?.name ?? null;
    return Promise.resolve(json(method === 'POST' ? { id: location.id } : { message: 'Container updated.' }, method === 'POST' ? 201 : 200));
  }
  if (/^\/api\/decks\/\d+\/share$/.test(path) || path.startsWith('/api/shared/decks/')) {
    return Promise.resolve(json({ error: 'Public deck sharing is unavailable in the demo.' }, 503));
  }

  if (path.startsWith('/api/ai-decks/')) {
    const params = new URL(url, window.location.origin).searchParams;
    const body = opts.body ? JSON.parse(opts.body) : {};
    const provider = params.get('provider') || body.provider || aiPreferences.provider;
    if (!Object.hasOwn(aiConnections, provider)) return Promise.resolve(json({ error: 'Unknown AI provider.' }, 400));
    if (path === '/api/ai-decks/preferences') {
      if (method === 'PUT') {
        if (body.model && !aiModels[provider].some(model => model.id === body.model)) return Promise.resolve(json({ error: 'Choose an available model.' }, 400));
        if (provider !== 'chatgpt' && !body.model) return Promise.resolve(json({ error: 'Choose a model.' }, 400));
        aiPreferences = { provider, model: body.model || null, reasoning_effort: provider === 'chatgpt' ? body.reasoning_effort || null : null, ollama_url: body.ollama_url || null };
      }
      return Promise.resolve(json(aiPreferences));
    }
    if (path === '/api/ai-decks/credentials' && ['PUT', 'DELETE'].includes(method)) {
      if (!['gemini', 'openrouter'].includes(provider)) return Promise.resolve(json({ error: 'Choose an API-key provider.' }, 400));
      // Store connection state only: even sample keys never enter fixtures or storage.
      aiConnections[provider] = method === 'PUT';
      return Promise.resolve(json({ ok: true }));
    }
    if (path === '/api/ai-decks/account') {
      if (method === 'DELETE') aiConnections.chatgpt = false;
      return Promise.resolve(json({ provider, connected: aiConnections[provider] }));
    }
    if (path === '/api/ai-decks/models') return Promise.resolve(json({ models: aiConnections[provider] ? aiModels[provider] : [] }));
    return Promise.resolve(json({ error: 'Live AI requests are disabled in the demo.' }, 503));
  }
  if (method === 'PATCH' && path === '/api/auth/theme') {
    const { theme } = JSON.parse(opts.body || '{}');
    if (!themes.includes(theme)) return Promise.resolve(json({ error: 'Invalid theme' }, 400));
    routes['/api/auth/me'].user.theme = theme;
    return Promise.resolve(json({ theme }));
  }
  if (method === 'PATCH' && /^\/api\/decks\/\d+\/card-back$/.test(path)) {
    const deck = routes[path.replace(/\/card-back$/, '')];
    if (!deck || deck.game !== 'mtg') return Promise.resolve(json({ error: 'Deck not found.' }, 404));
    const body = JSON.parse(opts.body || '{}');
    const { color, image } = body;
    if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'color') || !Object.hasOwn(body, 'image')
      || !(color === null || (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)))
      || !(image === null || (typeof image === 'string' && image.length < 500_000 && /^data:image\/webp;base64,/.test(image)))
      || (color !== null && image !== null)) {
      return Promise.resolve(json({ error: 'Invalid card back.' }, 400));
    }
    const back = { card_back_color: color, card_back_image: image };
    Object.assign(deck, back);
    const listedDeck = routes['/api/decks'].find(item => item.id === deck.id);
    if (listedDeck) Object.assign(listedDeck, back);
    return Promise.resolve(json(back));
  }
  if (method === 'PATCH' && /^\/api\/decks\/\d+\/sleeved$/.test(path)) {
    const deckPath = path.replace(/\/sleeved$/, '');
    const deck = routes[deckPath];
    if (!deck) return Promise.resolve(json({ error: 'Deck not found.' }, 404));
    const { sleeved } = JSON.parse(opts.body || '{}');
    if (!Number.isInteger(sleeved) || sleeved < 0 || sleeved > 3) {
      return Promise.resolve(json({ error: 'Invalid sleeve setting.' }, 400));
    }
    deck.sleeved = sleeved;
    const listedDeck = routes['/api/decks'].find(item => item.id === deck.id);
    if (listedDeck) listedDeck.sleeved = sleeved;
    return Promise.resolve(json({ sleeved }));
  }
  if (method === 'PUT' && /^\/api\/decks\/\d+\/editor$/.test(path)) {
    const deck = routes[path.replace(/\/editor$/, '')];
    if (!deck) return Promise.resolve(json({ error: 'Deck not found.' }, 404));
    const body = JSON.parse(opts.body || '{}');
    if (typeof body.notes === 'string') deck.notes = body.notes;
    return Promise.resolve(json({ message: 'Demo mode: notes are saved for this session only. Other editor changes are not saved.' }));
  }

  if (method === 'GET' && routes[path]) {
    let data = routes[path];
    if (path === '/api/collection') data = data.map(card => ({
      ...card,
      storage_unit_name: routes['/api/locations'].find(location => location.id === card.location_id)?.storage_unit_name ?? null,
    }));
    if (/^\/api\/decks\/\d+\/locations$/.test(path)) data = data.map(card => ({
      ...card, locations: card.locations.map(source => ({
        ...source, storage_unit_name: routes['/api/locations'].find(location => location.id === source.location_id)?.storage_unit_name ?? null,
      })),
    }));
    const game = new URL(url, window.location.origin).searchParams.get('game');
    if (game && Array.isArray(data) && ['/api/sets', '/api/collection', '/api/locations', '/api/decks'].includes(path)) {
      data = data.filter(item => item.game === game);
    }
    if (path === '/api/locations' || path === '/api/collection') {
      const field = path === '/api/locations' ? 'inventory_type' : 'list_type';
      const inventory = new URL(url, window.location.origin).searchParams.get(field) || 'collection';
      data = data.filter(item => (item[field] || 'collection') === inventory);
      if (path === '/api/locations') {
        data = data.map(location => {
          const contents = routes['/api/collection'].filter(card => card.location_id === location.id
            && (card.list_type || 'collection') === inventory && card.quantity > 0);
          const choices = contents.filter(card => card.image_url);
          const card = choices.find(card => card.card_id === location.cover_card_id) || choices[0];
          const colors = { W: 'W', White: 'W', U: 'U', Blue: 'U', B: 'B', Black: 'B', R: 'R', Red: 'R', G: 'G', Green: 'G' };
          const symbols = new Set(contents.flatMap(card => {
            const identity = card.types;
            if (card.game !== 'mtg' || !Array.isArray(identity) || !identity.every(color => Object.hasOwn(colors, color))) return [];
            return identity.length ? identity.map(color => colors[color]) : ['C'];
          }));
          return { ...location, mana_symbols: ['W', 'U', 'B', 'R', 'G', 'C'].filter(symbol => symbols.has(symbol)), cover: card ? {
            card_id: card.card_id, name: card.name, game: card.game, image_url: card.image_url,
          } : null };
        });
      }
    }
    return Promise.resolve(json(data));
  }

  if (method === 'POST' && path === '/api/cards/related-tokens') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const cardIds = new Set(body.card_ids || []);
    const tokens = routes[path].tokens.map(token => ({
      ...token,
      source_cards: token.source_cards.filter(card => cardIds.has(card.id)),
    })).filter(token => token.source_cards.length > 0);
    return Promise.resolve(json({ tokens }));
  }

  // Writes and un-captured GETs: never persist. Return a benign empty shape so
  // views render instead of crashing. List-ish paths get [], everything else {}.
  if (method === 'GET') {
    const listish = /\/(collection|locations|decks|sets|search|users|compartments)/.test(path);
    return Promise.resolve(json(listish ? [] : {}));
  }
  return Promise.resolve(json({ message: 'Demo mode: changes are not saved.' }));
};

// Dismissible notice so it's clear this is a sample build. Injected outside React
// so it survives tab changes; mobile keeps it in flow above the app.
function banner() {
  if (document.getElementById('demo-banner')) return;
  const el = document.createElement('div');
  el.id = 'demo-banner';
  el.innerHTML =
    '<span><strong>Demo</strong> &mdash; sample data, nothing you change is saved. '
    + 'Live features (card scanner, add/search, import &amp; export, price sync) are disabled.</span>'
    + '<button aria-label="Dismiss">×</button>';
  const btn = el.querySelector('button');
  btn.style.cssText = 'background:rgba(0,0,0,0.15);border:none;color:#1a1a1a;'
    + 'font-size:1.1rem;line-height:1;cursor:pointer;border-radius:4px;padding:0 0.5rem';
  btn.onclick = () => el.remove();
  document.body.prepend(el);
}
if (document.body) banner();
else document.addEventListener('DOMContentLoaded', banner);
