// Demo mode: no backend. Seed a fake logged-in admin and answer every /api
// request from bundled JSON fixtures so the static GitHub Pages build is a
// read-only tour of the real UI. Only bundled when VITE_DEMO is set (see
// main.jsx guard) so production/mobile builds carry none of this.
import themes from '../../../shared/themes.json';

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

let aiPreferences = { provider: 'chatgpt', model: null, reasoning_effort: null, ollama_url: null };
const aiConnections = { chatgpt: false, ollama: true, gemini: false, openrouter: false };
const aiModels = {
  chatgpt: [{ id: 'gpt-5.4', name: 'GPT-5.4', isDefault: true, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' }],
  ollama: [{ id: 'llama3.2:latest', name: 'llama3.2:latest', reasoningEfforts: [] }],
  gemini: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoningEfforts: [] }],
  openrouter: [{ id: 'openrouter/free', name: 'Free Models Router', reasoningEfforts: [] }],
};
const orig = window.fetch.bind(window);

window.fetch = (input, opts = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  // Non-API traffic (fonts, Scryfall card images) still hits the network.
  if (!url.includes('/api/')) return orig(input, opts);

  const method = (opts.method || 'GET').toUpperCase();
  const path = (url.replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/+$/, '')) || '/';

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

  if (method === 'GET' && routes[path]) {
    let data = routes[path];
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
            const identity = card.color_identity;
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

  if (method === 'POST' && path === '/api/notes') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    return Promise.resolve(json({
      note: {
        id: Date.now(),
        user_id: 1,
        title: body.title || 'Untitled',
        body: body.body || '',
        pinned: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    }, 201));
  }
  if (method === 'PUT' && path.startsWith('/api/notes/')) {
    const id = parseInt(path.split('/').pop(), 10);
    const body = opts.body ? JSON.parse(opts.body) : {};
    return Promise.resolve(json({ note: { id, ...body } }));
  }
  if (method === 'DELETE' && path.startsWith('/api/notes/')) {
    return Promise.resolve(json({ success: true }));
  }

  // Writes and un-captured GETs: never persist. Return a benign empty shape so
  // views render instead of crashing. List-ish paths get [], everything else {}.
  if (method === 'GET') {
    if (path === '/api/notes') return Promise.resolve(json({ notes: [] }));
    const listish = /\/(collection|locations|decks|sets|search|users|compartments|notes)/.test(path);
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
