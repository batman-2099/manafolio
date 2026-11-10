import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeckBuilder from '../components/DeckBuilder';
import AiDeckBuilder from '../components/AiDeckBuilder';
import { deckCardMovePrompt } from './deckCardMoves';
import { I18nProvider } from './i18n';
import en from '../locales/en.json';

// Run on an isolated Vite page; no real inventory or AI requests are made.
export async function runDeckCardMoveRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const original = { fetch: window.fetch, confirm: window.confirm, pushState: history.pushState, back: history.back, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const originalLocale = localStorage.getItem('manafolio_ui_lang');
  const originalLang = document.documentElement.lang;
  localStorage.setItem('manafolio_ui_lang', 'en');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  history.pushState = () => {};
  history.back = () => queueMicrotask(() => window.dispatchEvent(new PopStateEvent('popstate')));
  window.confirm = () => true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const card = { id: 'move-a', name: 'First printing', game: 'mtg', quantity: 2, owned_qty: 4, available_qty: 4, locked_qty: 0, color_identity: [], color_identity_known: true, types: [], subtypes: [], number: '1' };
  const second = { ...card, id: 'move-b', name: 'Second printing' };
  let deck = { id: 7, name: 'Move fixture', game: 'mtg', inventory_type: 'collection', container_id: 10, container_name: 'Linked box', format: 'Casual', target_size: 2, cards: [card], total_cards: 2 };
  const containers = [
    { id: 10, name: 'Linked box', game: 'mtg', inventory_type: 'collection' },
    { id: 11, name: 'Destination box', game: 'mtg', inventory_type: 'collection' },
    { id: 12, name: 'Locked box', game: 'mtg', inventory_type: 'collection', locked: 1 },
    { id: 13, name: 'Wrong game', game: 'pokemon', inventory_type: 'collection' },
    { id: 14, name: 'Graveyard box', game: 'mtg', inventory_type: 'graveyard' },
  ];
  const requests = [];
  let locationRequests = 0;
  let locationFailure = false;
  let holdLocations = false;
  let locationSignal;
  let settleLocations;
  let holdSave = false;
  let settleSave;
  let generationCards = [{ card_id: card.id, quantity: 1 }, { card_id: second.id, quantity: 1 }];
  let renderKey = 0;
  let savedAi = 0;
  const guard = { current: null };
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  window.fetch = async (url, options = {}) => {
    if (url === '/api/decks/7/editor' || (String(url).startsWith('/api/ai-decks') && ['PUT', 'POST'].includes(options.method) && url !== '/api/ai-decks/suggest')) {
      const body = JSON.parse(options.body);
      requests.push({ url, method: options.method, body });
      const finish = status => {
        if (status >= 400) return response({ error: 'Movement fixture failure' }, status);
        if (url === '/api/decks/7/editor') deck = { ...deck, ...body, cards: body.cards.map(row => ({ ...[card, second].find(item => item.id === row.card_id), ...row, id: row.card_id, source_entry_id: body.card_moves ? 900 : row.source_entry_id })), total_cards: body.cards.reduce((sum, row) => sum + row.quantity, 0) };
        return response({ id: 7, message: 'Saved' });
      };
      return holdSave ? new Promise(resolve => { settleSave = status => resolve(finish(status)); }) : finish(200);
    }
    if (url === '/api/decks') return response([deck]);
    if (url === '/api/decks/7') return response(deck);
    if (url === '/api/decks/7/locations') return response([]);
    if (String(url).endsWith('/sources')) return response({ sources: [{ entry_id: 22, location_name: 'Destination box', available: 4, quantity: 4 }] });
    if (String(url).startsWith('/api/locations')) {
      locationRequests++;
      locationSignal = options.signal;
      if (holdLocations) return new Promise(resolve => { settleLocations = () => resolve(response(containers)); });
      return response(locationFailure ? {} : containers, locationFailure ? 503 : 200);
    }
    if (url === '/api/sets' || url === '/api/sets?game=mtg' || String(url).startsWith('/api/collection?')) return response([]);
    if (url === '/api/ai-decks/account') return response({ connected: true });
    if (String(url).startsWith('/api/ai-decks/inventory?')) return response({ cards: [card, second] });
    if (url === '/api/ai-decks/suggest') return new Response(JSON.stringify({ type: 'complete', data: { message: 'Fixture suggestion', draft: { name: 'Improved fixture', description: '', strategy: 'Use both printings together.', commander_card_id: null, cards: generationCards } } }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    throw new Error(`Unexpected movement fixture request: ${url}`);
  };
  const button = (key, scope = host) => [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === en[key] || element.getAttribute('aria-label') === en[key]);
  const click = async element => {
    assert(element && !element.matches(':disabled'), 'action must exist and be enabled');
    await act(async () => { element.focus(); element.click(); });
  };
  const change = async (element, value) => {
    assert(element && !element.matches(':disabled'), 'field must be editable');
    await act(async () => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  };
  const dialog = () => host.querySelector('dialog[open]:has(#deck-card-move-title)');
  const renderManual = async () => {
    await act(async () => { root.render(<I18nProvider><DeckBuilder key={++renderKey} showToast={() => {}} navigationGuardRef={guard} /></I18nProvider>); });
    await click([...host.querySelectorAll('button')].find(element => element.textContent.trim() === deck.name));
  };
  const renderAi = async source => {
    await act(async () => { root.render(<I18nProvider><AiDeckBuilder key={++renderKey} sourceDeck={source} onClose={() => {}} onSaved={() => { savedAi++; }} onPreview={() => {}} onOpenAiSettings={() => {}} /></I18nProvider>); });
    await act(async () => host.querySelector('#ai-conversation-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };
  try {
    const originalDeck = structuredClone(deck);
    const changes = deckCardMovePrompt(deck, deck, [{ ...card, quantity: 1 }, { ...second, quantity: 1 }]);
    assert(changes.added[0].quantity === 1 && changes.removed[0].quantity === 1, 'exact printing quantity deltas are additions and removals');
    assert(!deckCardMovePrompt(deck, deck, [{ ...card, source_entry_id: 44 }]), 'source-only changes do not prompt');
    assert(!deckCardMovePrompt({ ...deck, container_id: null }, deck, []), 'unlinked decks do not prompt');
    assert(!deckCardMovePrompt({ ...deck, inventory_type: 'arena' }, { ...deck, inventory_type: 'arena' }, []), 'Arena decks do not prompt');
    assert(!deckCardMovePrompt({ ...deck, inventory_type: 'graveyard' }, deck, []), 'inventory transitions do not prompt');
    assert(deckCardMovePrompt({ ...deck, inventory_type: 'graveyard' }, { ...deck, inventory_type: 'graveyard' }, []), 'same-inventory Graveyard changes prompt');

    await renderManual();
    await click(button('deck.decreaseQty'));
    const trigger = button('common.save');
    await click(trigger);
    assert(dialog()?.textContent.includes('1 × First printing') && !requests.length, 'manual decrease prompts before saving');
    assert(dialog().contains(document.activeElement), 'movement dialog owns native focus');
    await click(button('common.cancel', dialog()));
    assert(!dialog() && !requests.length && document.activeElement === trigger, 'cancel keeps draft and restores focus without saving');
    await click(button('common.save'));
    const select = host.querySelector('#deck-card-move-destination');
    assert([...select.options].map(option => option.value).join(',') === ',11', 'destinations default to Unassigned and exclude linked, locked, foreign inventory and wrong game');
    await change(select, '11');
    holdSave = true;
    await click(button('deck.cardMoveSave'));
    assert(requests[0].body.card_moves.container_id === 10 && requests[0].body.card_moves.removed_location_id === 11 && requests[0].body.card_moves.before_cards[0].quantity === 2, 'save sends chosen target and saved baseline, not draft counts');
    assert([...dialog().querySelectorAll('button,select')].every(element => element.disabled) && guard.current() === false, 'pending movement freezes controls and navigation');
    await act(async () => dialog().dispatchEvent(new Event('cancel', { cancelable: true })));
    assert(dialog(), 'pending save cannot be dismissed');
    await act(async () => settleSave(409));
    assert(dialog().textContent.includes('Movement fixture failure') && select.value === '11', 'failed save keeps dialog, destination and draft retryable');
    await click(button('deck.cardMoveSave'));
    await act(async () => settleSave(200));
    assert(!dialog() && deck.cards[0].source_entry_id === 900, 'successful save refreshes moved deck sources');
    holdSave = false;

    const beforeAddLocations = locationRequests;
    await click(button('deck.increaseQty'));
    await click(button('common.save'));
    assert(dialog()?.textContent.includes('Linked box') && !host.querySelector('#deck-card-move-destination') && locationRequests === beforeAddLocations, 'additions-only prompt names linked container and does not fetch destinations');
    await click(button('deck.cardMoveSave'));
    assert(requests.at(-1).body.card_moves.removed_location_id === null, 'additions-only payload explicitly includes null removal destination');

    await click(button('deck.decreaseQty'));
    await click(button('common.save'));
    await click(button('deck.cardMoveSkip'));
    assert(!requests.at(-1).body.card_moves && deck.cards[0].quantity === 1, 'explicit skip saves original editor payload without movement');
    await change(host.querySelector('#deck-notes'), 'Metadata only');
    await click(button('common.save'));
    assert(!dialog() && requests.at(-1).body.notes === 'Metadata only' && !requests.at(-1).body.card_moves, 'metadata-only saves bypass prompt');

    locationFailure = true;
    await click(button('deck.removeFromDeck'));
    await click(button('common.save'));
    assert(dialog().textContent.includes(en['deck.cardMoveLoadError']) && button('deck.cardMoveSave').disabled && !button('deck.cardMoveSkip').disabled, 'loading failure offers retry and skip without an empty false-success state');
    locationFailure = false;
    await click(button('common.retry', dialog()));
    assert(!button('deck.cardMoveSave').disabled, 'destination fetch can be retried');
    await click(button('common.cancel', dialog()));
    holdLocations = true;
    await click(button('common.save'));
    const pendingLocationSignal = locationSignal;
    assert(dialog().textContent.includes(en['deck.cardMoveLoading']), 'pending destinations announce loading');
    await click(button('common.cancel', dialog()));
    assert(pendingLocationSignal.aborted, 'closing prompt aborts destination fetch');
    await act(async () => settleLocations());
    holdLocations = false;

    deck = { ...originalDeck, container_id: null, container_name: null };
    await renderManual();
    await click(button('deck.decreaseQty'));
    await click(button('common.save'));
    assert(!dialog() && !requests.at(-1).body.card_moves, 'ordinary unlinked save bypasses prompt');

    deck = structuredClone(originalDeck);
    await renderAi(deck);
    const beforeAi = requests.length;
    await click(button('aiDeck.saveCurrent'));
    assert(dialog()?.textContent.includes('First printing') && dialog().textContent.includes('Second printing') && requests.length === beforeAi, 'AI replacement compares generated quantities against original source deck');
    await click(button('common.cancel', dialog()));
    assert(!dialog() && requests.length === beforeAi && host.querySelector('#ai-name'), 'AI cancel retains unsaved generated draft');
    await click(button('aiDeck.saveNew'));
    assert(!dialog() && requests.at(-1).method === 'POST' && !requests.at(-1).body.card_moves && savedAi === 1, 'AI Save as New never moves or prompts');
    await click(button('aiDeck.saveCurrent'));
    holdSave = true;
    await click(button('deck.cardMoveSave'));
    await act(async () => settleSave(409));
    assert(dialog()?.textContent.includes('Movement fixture failure'), 'AI movement failure preserves draft and modal');
    await click(button('deck.cardMoveSkip'));
    await act(async () => settleSave(200));
    assert(!dialog() && requests.at(-1).method === 'PUT' && !requests.at(-1).body.card_moves, 'AI retry may explicitly save without moving');
    holdSave = false;
    await click(button('aiDeck.saveCurrent'));
    await change(host.querySelector('#deck-card-move-destination'), '11');
    await click(button('deck.cardMoveSave'));
    assert(requests.at(-1).url === '/api/ai-decks/7' && requests.at(-1).body.card_moves.removed_location_id === 11 && requests.at(-1).body.card_moves.before_cards[0].quantity === 2, 'AI replacement uses identical movement contract and original baseline');

    generationCards = [{ card_id: card.id, quantity: 2 }];
    await renderAi(deck);
    await click(button('aiDeck.saveCurrent'));
    assert(!dialog() && !requests.at(-1).body.card_moves, 'unchanged AI card counts bypass prompt');
    generationCards = [{ card_id: second.id, quantity: 2 }];
    await renderAi({ ...deck, container_id: null, container_name: null });
    await click(button('aiDeck.saveCurrent'));
    assert(!dialog() && !requests.at(-1).body.card_moves, 'older unlinked AI source data bypasses prompt');
    deck = structuredClone(originalDeck);
    await renderManual();
    await click(button('deck.decreaseQty'));
    await click(host.querySelector(`button[aria-label="${en['deck.previewArt']}: ${card.name}"]`));
    await change(host.querySelector('#deck-card-source'), '22');
    assert(dialog(), 'source-selection auto-save also prompts for pending quantity deltas');
    await click(button('deck.cardMoveSkip'));
    assert(requests.at(-1).body.cards[0].source_entry_id === 22 && !requests.at(-1).body.card_moves, 'source-triggered skip preserves the explicit source payload');

    return { passed: true, saves: requests.length };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = original.fetch;
    window.confirm = original.confirm;
    history.pushState = original.pushState;
    history.back = original.back;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
    if (originalLocale === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', originalLocale);
    document.documentElement.lang = originalLang;
  }
}
