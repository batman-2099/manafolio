import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeckBuilder from '../components/DeckBuilder';
import en from '../locales/en.json';
import { I18nProvider } from './i18n';
import COLOR_THEMES from '../../../shared/aiDeckColorThemes.json';

// Isolated Vite page only; every fetch is mocked, including AI generation/save.
export async function runUiDeckRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const original = { fetch: window.fetch, confirm: window.confirm, open: window.open, pushState: history.pushState, back: history.back, act: globalThis.IS_REACT_ACT_ENVIRONMENT, clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard') };
  const originalLocale = localStorage.getItem('manafolio_ui_lang');
  const originalLang = document.documentElement.lang;
  localStorage.setItem('manafolio_ui_lang', 'en');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const guard = { current: null };
  const toasts = [];
  let settleSuggest;
  let suggestBody;
  let settleSave;
  let settleCompare;
  let holdCompare = false;
  let settings = 0;
  let opened = 0;
  let confirms = 0;
  let locationsFail = false;
  let holdMutation = false;
  let settleMutation;
  const mutations = { checkout: 0, return: 0 };
  let locationRequests = 0;
  let detailRequests = 0;
  let settleArchidekt;
  let archidektSignal;
  let previewBody;
  let createdBody;
  let createFails = true;
  const searches = [];
  const response = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
  const card = { id: 'fixture', name: 'Fixture card', game: 'mtg', quantity: 2, owned_qty: 0, types: [], subtypes: [], number: '1' };
  const deck = { id: 7, name: 'Fixture deck', game: 'mtg', inventory_type: 'arena', format: 'Casual', target_size: 60, cards: [card], total_cards: 2 };
  const aiCard = { ...card, id: 'mtg-fixture', game: 'mtg', owned_qty: 1, available_qty: 1, locked_qty: 0, color_identity: [], color_identity_known: true };
  const aiInventory = [
    aiCard,
    { ...aiCard, id: 'white', color_identity: ['White'] },
    { ...aiCard, id: 'azorius', color_identity: ['White', 'Blue'] },
    { ...aiCard, id: 'off-theme-source-land', color_identity: ['Red'], source_qty: 1, subtypes: ['Land'] },
    { ...aiCard, id: 'unknown-source', color_identity_known: false, source_qty: 1 },
  ];
  const locations = [{ card_id: card.id, missing: 0, locations: [1, 2].map(entry_id => ({ entry_id, card_name: `Physical copy ${entry_id}`, take: 1, location_name: 'Unassigned Pile' })) }];
  const button = key => [...host.querySelectorAll('button')].find(el => el.textContent.trim() === en[key] || el.getAttribute('aria-label') === en[key]);
  const click = async element => { assert(element, 'action must exist'); await act(async () => { element.focus(); element.click(); }); };
  const change = async (element, value) => {
    assert(element && !element.matches(':disabled'), 'field must be editable');
    await act(async () => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  };
  const cancelDialog = async () => { await act(async () => { host.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true })); }); };
  const render = async () => { await act(async () => { root.render(<I18nProvider><DeckBuilder showToast={(...args) => toasts.push(args)} navigationGuardRef={guard} onOpenAiSettings={() => { if (guard.current() !== false) settings++; }} /></I18nProvider>); }); };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Keep guard stack behavior real without navigating the isolated test document.
  history.pushState = () => {};
  history.back = () => queueMicrotask(() => window.dispatchEvent(new PopStateEvent('popstate')));
  window.confirm = () => { confirms++; return false; };
  window.open = () => { opened++; return null; };
  window.fetch = async (url, options = {}) => {
    if (String(url).startsWith('/api/search?')) {
      return new Promise((resolve, reject) => searches.push({ resolve: (cards, status = 200) => resolve(response(cards, status)), reject }));
    }
    if (url === '/api/decks/archidekt/preview') {
      archidektSignal = options.signal;
      previewBody = JSON.parse(options.body);
      return new Promise(resolve => { settleArchidekt = (body, status = 200) => resolve(response(body, status)); });
    }
    if (url === '/api/decks' && options.method === 'POST') {
      createdBody = JSON.parse(options.body);
      return response(createFails ? { error: 'Fixture creation failure' } : { id: 7 }, createFails ? 503 : 200);
    }
    if (url === '/api/decks') return response([deck]);
    if (url === '/api/decks/7') { detailRequests++; return response(deck); }
    if (url === '/api/decks/7/cards/fixture/sources') return response({ sources: locations[0].locations.map(location => ({ ...location, available: 2, quantity: 2 })) });
    if (url === '/api/decks/7/locations') {
      locationRequests++;
      return response(locationsFail ? { error: 'Fixture locations failure' } : locations, locationsFail ? 503 : 200);
    }
    if (url === '/api/decks/7/checkout' || url === '/api/decks/7/return') {
      const operation = String(url).split('/').at(-1);
      mutations[operation]++;
      const complete = (status = 200) => {
        if (status < 400) deck.checked_out = operation === 'checkout' ? 1 : 0;
        return response({}, status);
      };
      return holdMutation ? new Promise(resolve => { settleMutation = status => resolve(complete(status)); }) : complete();
    }
    if (url === '/api/sets') return response([]);
    if (String(url).startsWith('/api/collection?')) return holdCompare ? new Promise(resolve => { settleCompare = () => resolve(response([])); }) : response([]);
    if (url === '/api/ai-decks/account') return response({ connected: true });
    if (String(url).startsWith('/api/ai-decks/inventory?')) return response({ cards: aiInventory });
    if (url === '/api/sets?game=mtg' || url === '/api/locations') return response([]);
    if (url === '/api/ai-decks/suggest') { suggestBody = JSON.parse(options.body); return new Promise(resolve => { settleSuggest = resolve; }); }
    if (url === '/api/ai-decks' && options.method === 'POST') return new Promise(resolve => { settleSave = resolve; });
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  try {
    await render();
    for (const view of ['deck.gridView', 'deck.tableView']) {
      await click(button(view));
      const name = [...host.querySelectorAll('button')].find(element => element.textContent.trim() === deck.name);
      assert(name?.tabIndex === 0, 'deck names remain reachable without a separate Open action');
      const before = detailRequests;
      await click(name);
      assert(button('deck.backToDecks') && detailRequests === before + 1, 'activating a deck name opens it once without bubbling into another load');
      await click(button('deck.backToDecks'));
    }
    deck.inventory_type = 'collection';
    const unassigned = locations[0].locations[0];
    locations[0].locations[0] = { ...unassigned, location_name: 'Sample binder', location_id: 9, compartment_id: 90, compartment_display: 'Page 2', position: 7000 };
    const sortCards = [
      ['slot-low', 2000, 'Page 2'], ['slot-high', 10000, 'Page 2'],
      ['slot-unknown', null, 'Page 2'], ['earlier-page', 1000, 'Page 1']
    ].map(([id, position, page]) => {
      locations.push({ card_id: id, missing: 0, locations: [{ ...locations[0].locations[0], position, compartment_display: page }] });
      return { ...card, id, name: id };
    });
    deck.cards = [card, ...sortCards];
    await click([...host.querySelectorAll('button')].find(element => element.textContent.trim() === deck.name));
    const storedLabel = `Sample binder · Page 2 · ${en['loc.slotNumber'].replace('{n}', 7)}`;
    for (const mode of ['List', 'Grid']) {
      await click([...host.querySelectorAll('.deck-display-controls button')].find(element => element.textContent.trim() === mode));
      assert([...host.querySelectorAll('[title]')].some(element => element.title.includes(storedLabel)), 'both deck card views show the stored slot, not collector number');
    }
    await click(host.querySelector(`button[aria-label="${en['deck.previewArt']}: ${card.name}"]`));
    assert(host.querySelector('dialog').textContent.includes(storedLabel), 'card preview includes its physical slot');
    const sourceOptions = [...host.querySelectorAll('#deck-card-source option')];
    assert(sourceOptions.some(option => option.textContent.includes(storedLabel)), 'specific source choices include their stored slot');
    assert(sourceOptions.some(option => option.textContent.includes('Unassigned Pile') && !option.textContent.includes('Slot')), 'unassigned copies do not invent a physical slot');
    await cancelDialog();
    await change(host.querySelector('.deck-display-controls select'), 'location');
    for (const mode of ['List', 'Grid']) {
      await click([...host.querySelectorAll('.deck-display-controls button')].find(element => element.textContent.trim() === mode));
      const ordered = [...host.querySelectorAll(`button[aria-label^="${en['deck.previewArt']}:"]`)].map(element => element.getAttribute('aria-label').split(': ')[1]);
      assert(ordered.join(',') === ['earlier-page', 'slot-low', card.name, 'slot-high', 'slot-unknown'].join(','),
        'location sort preserves page grouping and sorts numeric slots ascending, with unknown slots last');
    }
    const stored = locations[0].locations[0];
    for (const [positions, summary] of [
      [[7000, 8000, 9000, 7000], '7 - 9'],
      [[11000, 7000, 9000], '7,9,11']
    ]) {
      await click(button('deck.backToDecks'));
      locations[0].locations = [...positions.map(position => ({ ...stored, position })), unassigned];
      await click([...host.querySelectorAll('button')].find(element => element.textContent.trim() === deck.name));
      const label = `×${positions.length} Sample binder · Page 2 · ${en['loc.slotRanges'].replace('{slots}', summary)}, Unassigned Pile`;
      for (const mode of ['List', 'Grid']) {
        await click([...host.querySelectorAll('.deck-display-controls button')].find(element => element.textContent.trim() === mode));
        assert([...host.querySelectorAll('[title]')].some(element => element.title === label),
          'stacked locations deduplicate slots and use a range only without gaps, retaining unassigned copies');
      }
      await click(host.querySelector(`button[aria-label="${en['deck.previewArt']}: ${card.name}"]`));
      assert(host.querySelector('dialog').textContent.includes(label), 'preview uses the same compact slot summary');
      await cancelDialog();
    }
    locations[0].locations = [unassigned];
    deck.cards = [card];
    locations.splice(1);
    locations[0].locations[0] = unassigned;
    await click(button('deck.backToDecks'));
    await click([...host.querySelectorAll('button')].find(element => element.textContent.trim() === deck.name));
    const search = async query => {
      await change(host.querySelector('.deck-search-form input'), query);
      await act(async () => host.querySelector('.deck-search-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    };
    const oldCard = { ...card, id: 'old-search', name: 'Old search result', owned_qty: 1 };
    const newCard = { ...card, id: 'new-search', name: 'Current search result', owned_qty: 1 };
    await search('old');
    await search('current');
    await act(async () => searches[1].resolve([newCard]));
    await act(async () => searches[0].resolve([oldCard]));
    assert(host.textContent.includes(newCard.name) && !host.textContent.includes(oldCard.name), 'late old search cannot replace the current results');
    await search('stale-error');
    await search('pending');
    const toastCount = toasts.length;
    await act(async () => searches[2].reject(new Error('stale request')));
    assert(toasts.length === toastCount && host.querySelector('.deck-editing-workspace .spinner'), 'stale failure cannot publish an error or clear current loading');
    await act(async () => searches[3].resolve([newCard]));
    await click(button('deck.editProperties'));
    // Dispatch directly while properties are open to exercise the inventory boundary.
    await search('before-inventory-switch');
    await click([...host.querySelectorAll('dialog button')].find(element => element.textContent.trim() === en['deck.arena']));
    await click(button('deck.applyProperties'));
    await act(async () => searches[4].resolve([oldCard]));
    assert(!host.textContent.includes(oldCard.name) && !host.querySelector('.deck-editing-workspace .spinner'), 'inventory switch invalidates pending search and resets loading');
    window.confirm = () => true;
    await click(button('deck.backToDecks'));
    window.confirm = () => { confirms++; return false; };
    deck.inventory_type = 'collection';
    await click([...host.querySelectorAll('button')].find(element => element.textContent.trim() === deck.name));
    await search('before-leave');
    await click(button('deck.backToDecks'));
    await click([...host.querySelectorAll('button')].find(element => element.textContent.trim() === deck.name));
    await act(async () => searches[5].resolve([oldCard]));
    assert(!host.textContent.includes(oldCard.name), 'leaving and reopening a deck invalidates its previous search');
    await click(button('deck.backToDecks'));
    deck.inventory_type = 'arena';
    await click(button('deck.gridView'));
    await click(button('aiDeck.title'));
    assert(guard.current(), 'pristine AI builder must allow navigation');
    const poolHas = count => host.textContent.includes(`Matching inventory: ${count} owned · ${count} available · 0 checked out`);
    assert(poolHas(5), 'Any theme retains the complete inventory');
    await click(button('aiDeck.colorTheme'));
    const themeGroup = host.querySelector('[role="group"][aria-label="Color theme"]');
    const themeChoices = [...themeGroup.querySelectorAll('label')];
    assert(themeChoices.length === 25, 'all 25 named color themes are offered');
    COLOR_THEMES.forEach((theme, index) => {
      const choice = themeChoices[index];
      assert(choice.textContent === theme.name, 'theme names retain the requested order');
      assert([...choice.querySelectorAll('svg[role="img"]')].map(icon => icon.getAttribute('aria-label')).join() === theme.colors.join(), 'each choice exposes actual mana symbols with color names');
      assert([...choice.querySelectorAll('[title]')].map(icon => icon.title).join() === theme.colors.join(), 'each mana symbol has its color on hover');
    });
    await click(themeChoices[0].querySelector('input'));
    assert(poolHas(3) && guard.current() === false, 'theme filters unknown and off-theme source cards and marks setup dirty');
    assert(button('aiDeck.colorTheme').querySelectorAll('svg[role="img"]').length === 2, 'selected trigger retains mana symbols');
    await click(button('aiDeck.useAllAvailableLands'));
    assert(poolHas(3), 'all-land override cannot reintroduce an off-theme source land');
    await click(button('aiDeck.useAllAvailableLands'));
    await change(host.querySelector('#ai-inventory'), 'arena');
    assert(button('aiDeck.colorTheme').textContent === 'Any' && poolHas(5), 'inventory switch resets theme and restores full pool');
    await change(host.querySelector('#ai-inventory'), 'collection');
    await click(button('aiDeck.colorTheme'));
    await click(host.querySelector('[role="group"][aria-label="Color theme"] input[type="radio"]'));
    await change(host.querySelector('#ai-format'), 'Casual');
    await change(host.querySelector('#ai-target'), '1');
    await change(host.querySelector('#ai-prompt'), 'Keep this prompt');
    assert(guard.current() === false, 'parent navigation must protect AI input');
    await click(button('aiDeck.openSettings'));
    await click(host.querySelector('[aria-label="' + en['common.back'] + '"]'));
    assert(settings === 0 && host.querySelector('#ai-prompt').value === 'Keep this prompt', 'cancelled settings and Back must preserve AI input');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    assert(unload.defaultPrevented, 'AI input must protect browser unload');
    await act(async () => { host.querySelector('#ai-conversation-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert(suggestBody.color_theme === 'azorius' && suggestBody.colors.length === 0, 'generation sends the theme separately from Colors');
    const beforeBusyConfirm = confirms;
    assert(guard.current() === false && confirms === beforeBusyConfirm, 'busy AI generation must block rather than offer discard');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    assert(host.querySelector('#ai-deck-title'), 'browser Back cannot destroy in-flight generation');
    const data = { message: 'Generated locally', draft: { name: 'AI fixture', description: '', strategy: 'Fixture strategy', commander_card_id: null, cards: [{ card_id: aiCard.id, quantity: 1 }] } };
    await act(async () => { settleSuggest({ ok: true, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'complete', data }) + '\n')); controller.close(); } }) }); });
    assert(host.querySelector('#ai-prompt').value === '' && guard.current() === false, 'generated draft remains protected after prompt clears');
    const saveForm = [...host.querySelectorAll('form')].find(form => form.id !== 'ai-conversation-form');
    assert(saveForm, 'generated draft must offer save form');
    await act(async () => { saveForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert(guard.current() === false && settleSave, 'pending AI save must block navigation');
    await act(async () => { settleSave(response({ error: 'Fixture save failure' }, 500)); });
    assert(host.textContent.includes('Fixture save failure') && guard.current() === false, 'failed save retains protected draft and recovery');
    await click(button('aiDeck.colorTheme'));
    await click([...host.querySelector('[role="group"][aria-label="Color theme"]').querySelectorAll('button')].find(el => el.textContent.trim() === en['bulk.clear']));
    assert(poolHas(5) && !host.textContent.includes('Fixture save failure') && host.querySelectorAll('form').length === 1, 'clearing theme restores inventory and clears stale errors and draft');
    await click(button('aiDeck.colorTheme'));
    await act(async () => { host.querySelector('#ai-conversation-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert(suggestBody.color_theme === '' && suggestBody.messages.length === 0 && suggestBody.current_draft === null, 'theme reset starts a fresh unrestricted request');
    await act(async () => { settleSuggest(new Response(JSON.stringify({ type: 'complete', data }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })); });
    const recoveredSaveForm = [...host.querySelectorAll('form')].find(form => form.id !== 'ai-conversation-form');
    await act(async () => { recoveredSaveForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    const beforeSuccessConfirm = confirms;
    await act(async () => { settleSave(response({ id: 7 })); });
    assert(!host.querySelector('#ai-deck-title') && confirms === beforeSuccessConfirm, 'successful save bypasses discard confirmation and opens saved deck');

    const cards = host.querySelector('.deck-cards-heading');
    const overview = host.querySelector('.deck-summary-layout');
    assert(cards && overview, `saved deck must load card editing and overview; notices: ${JSON.stringify(toasts)}`);
    assert(host.querySelector('.deck-editor-header').compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING, 'deck overview must follow the name and actions');
    assert(overview.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING, 'deck overview must precede card editing on every screen');
    assert(button('deck.share').checkVisibility()
      && host.querySelector('[title="' + en['deck.exportHint'] + '"]').checkVisibility(),
    'mobile deck actions must be visible without expanding a menu');
    assert(host.querySelectorAll('[title="' + en['deck.exportHint'] + '"]').length === 1, 'responsive actions exist only once');
    const exportTrigger = host.querySelector(`[title="${en['deck.exportHint']}"]`);
    await click(exportTrigger);
    assert(host.querySelector('dialog[open]').contains(document.activeElement), 'native export must own focus');
    await change(host.querySelector('#deck-export-format'), 'buylist');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const successes = toasts.filter(([, type]) => type === 'success').length;
    await click(button('deck.copyOpenTcg'));
    const text = host.querySelector('#deck-export-text');
    assert(opened === 1 && document.activeElement === text && text.selectionEnd === text.value.length, 'absent clipboard opens synchronously and selects manual copy text');
    assert(host.querySelector('dialog [role="status"]').textContent === en['deck.copyManually'], 'manual copy recovery is visible');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
    await click(button('deck.copyClipboard'));
    assert(toasts.filter(([, type]) => type === 'success').length === successes, 'denied/absent clipboard never report false success');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    await click(button('deck.copyClipboard'));
    assert(toasts.at(-1)[1] === 'success', 'clipboard recovery reports success after fulfillment');
    await cancelDialog();
    assert(!host.querySelector('dialog') && document.activeElement === exportTrigger, 'export cancel restores trigger focus');

    await click(host.querySelector(`[title="${en['deck.importHint']}"]`));
    await change(host.querySelector('#deck-import-text'), Array.from({ length: 60 }, (_, i) => `1 Missing card ${i}`).join('\n'));
    holdCompare = true;
    await click(button('deck.compare'));
    await cancelDialog();
    assert(host.querySelector('#deck-import-text').disabled, 'pending comparison prevents dismiss and input edits');
    await act(async () => { settleCompare(); });
    await click(button('deck.importMatched'));
    assert(host.querySelector('#deck-import-summary-title'), 'comparison completes into native summary');
    const panel = host.querySelector('.deck-text-panel');
    assert(getComputedStyle(panel).overflowY === 'auto' && panel.getBoundingClientRect().height <= innerHeight, 'long import summary remains bounded and scrollable');
    await cancelDialog();
    assert(!host.querySelector('dialog'), 'summary supports Escape/cancel');
    deck.inventory_type = 'collection';
    await click(button('deck.backToDecks'));
    const action = text => [...host.querySelectorAll('button')].find(el => el.textContent.trim() === text);
    locationsFail = true;
    await click(action('Checkout'));
    assert(mutations.checkout === 1 && host.querySelector('dialog [role="alert"]')?.textContent.includes(en['deck.checkoutLocationsFailed']), 'successful checkout with failed locations keeps a recoverable guide');
    assert(button('bulk.done').disabled, 'failed guide cannot be mistaken for an empty completed guide');
    locationsFail = false;
    await click(button('common.retry'));
    assert(mutations.checkout === 1, 'guide retry fetches locations without repeating checkout');
    const copyOne = () => [...host.querySelectorAll('dialog button')].find(el => el.textContent.includes('Physical copy 1'));
    await click(copyOne());
    holdMutation = true;
    await cancelDialog();
    assert(copyOne().getAttribute('aria-pressed') === 'true' && button('bulk.done').disabled, 'pending cancel retains checklist and blocks Done');
    await cancelDialog();
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    assert(mutations.return === 1, 'Escape and Back cannot repeat pending cancellation');
    await act(async () => { settleMutation(500); });
    assert(host.querySelector('dialog [role="alert"]')?.textContent.includes(en['wizard.checkout.cancelFailed']) && copyOne().getAttribute('aria-pressed') === 'true', 'failed reversal explicitly retains checkout state and checklist');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    assert(mutations.return === 2 && host.querySelector('dialog'), 'Back guard remains active after failed async cancellation');
    await act(async () => { settleMutation(200); });
    assert(!host.querySelector('dialog') && deck.checked_out === 0, 'successful cancellation alone closes guide');

    holdMutation = false;
    await click(action('Checkout'));
    await click(button('wizard.selectAll'));
    await click(button('bulk.done'));
    locationsFail = true;
    const returnsBeforePreflight = mutations.return;
    await click(action('Return'));
    assert(mutations.return === returnsBeforePreflight && deck.checked_out === 1 && host.querySelector('[role="alert"]')?.textContent.includes('still checked out'), 'failed return locations never mutates deck status');
    const requestsBeforeRetry = locationRequests;
    locationsFail = false;
    await click(button('common.retry'));
    assert(locationRequests === requestsBeforeRetry + 1 && mutations.return === returnsBeforePreflight + 1 && host.querySelector('dialog'), 'return retry loads locations before one return mutation');
    await click(copyOne());
    holdMutation = true;
    await cancelDialog();
    await act(async () => { settleMutation(500); });
    assert(host.querySelector('dialog [role="alert"]')?.textContent.includes(en['wizard.checkin.cancelFailed']) && copyOne().getAttribute('aria-pressed') === 'true', 'failed return cancellation preserves returned state and progress');
    await click(button('wizard.retryCancel'));
    await cancelDialog();
    await act(async () => { settleMutation(200); });
    assert(!host.querySelector('dialog') && deck.checked_out === 1, 'return cancellation retry restores checkout and closes guide');

    await click(button('deck.createDeck'));
    const archidektUrl = 'https://archidekt.com/decks/24321624/spellslinger';
    const archidektDeck = { name: 'Archidekt fixture', description: 'Imported description', card_count: 100, commander: true };
    const loadArchidekt = async () => {
      await click(button('deck.importArchidekt'));
      await change(host.querySelector('#deck-archidekt-url'), archidektUrl);
      await click(button('deck.archidektLoad'));
    };
    const archidektSelected = () => host.querySelector('.deck-create-body [role="status"]');
    await loadArchidekt();
    assert(previewBody.url === archidektUrl && !createdBody && button('deck.archidektLoad').disabled, 'preview sends URL, reports loading, and never creates a deck');
    await act(async () => { settleArchidekt({ error: 'Fixture preview failure' }, 503); });
    assert(host.querySelector('#deck-archidekt-error')?.textContent === 'Fixture preview failure' && host.querySelector('#deck-archidekt-url').value === archidektUrl, 'preview failure stays inline and retains URL');
    await click(button('common.retry'));
    await act(async () => { settleArchidekt(archidektDeck); });
    assert(!host.querySelector('#deck-archidekt-url') && document.activeElement === button('deck.importArchidekt'), 'successful preview returns focus to creation form');
    assert(host.querySelector('#new-deck-name').value === archidektDeck.name && [...host.querySelectorAll('textarea')].some(el => el.value === archidektDeck.description), 'preview fills editable name and description');
    assert(host.querySelector('#new-deck-format').value === 'Commander / EDH' && host.querySelector('#new-deck-size').value === '100' && archidektSelected()?.textContent.includes('100'), 'commander preview sets format/size and announces selected count');
    await click(host.querySelector('.deck-create-footer button[type="submit"]'));
    assert(createdBody.archidekt_url === archidektUrl && !createdBody.precon_file && !createdBody.decklist_text && archidektSelected(), 'creation failure preserves exclusive Archidekt selection for retry');
    createFails = false;
    await click(host.querySelector('.deck-create-footer button[type="submit"]'));
    assert(!host.querySelector('#deck-create-title') && button('deck.backToDecks'), 'Create Deck saves Archidekt through the existing flow and opens the saved deck');
    await click(button('deck.backToDecks'));
    await click(button('deck.createDeck'));
    assert(!archidektSelected(), 'successful creation resets Archidekt selection');
    await change(host.querySelector('#new-deck-format'), 'Modern');
    await change(host.querySelector('#new-deck-size'), '75');
    await loadArchidekt();
    await act(async () => { settleArchidekt({ ...archidektDeck, commander: false }); });
    assert(host.querySelector('#new-deck-format').value === 'Modern' && host.querySelector('#new-deck-size').value === '75', 'noncommander preview preserves chosen format and size');
    await click(button('deck.showQuickImport'));
    await change(host.querySelector('textarea[aria-label="' + en['deck.showQuickImport'] + '"]'), '1 Fixture card');
    assert(!archidektSelected(), 'typing a decklist clears Archidekt selection');
    await loadArchidekt();
    await act(async () => { settleArchidekt(archidektDeck); });
    await click(button('deck.showQuickImport'));
    await change(host.querySelector('select[aria-label="' + en['deck.format'] + '"]'), 'manabox');
    assert(!archidektSelected(), 'switching to ManaBox clears Archidekt selection');
    const fileButton = button('deck.chooseManaBoxFile');
    assert(fileButton?.tagName === 'BUTTON' && fileButton.type === 'button', 'ManaBox picker uses a keyboard-operable native button');
    const fileInput = host.querySelector('input[type="file"]');
    let pickerOpened = 0;
    fileInput.click = () => { pickerOpened++; };
    await click(fileButton);
    assert(pickerOpened === 1, 'ManaBox button opens its file input');
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['2 Fixture card'], 'fixture.txt', { type: 'text/plain' })] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let attempts = 0; attempts < 60 && ![...host.querySelectorAll('textarea')].some(el => el.value === '2 Fixture card'); attempts++) {
      await act(async () => new Promise(resolve => setTimeout(resolve, 16)));
    }
    assert([...host.querySelectorAll('textarea')].some(el => el.value === '2 Fixture card'), 'ManaBox file contents still populate import text');
    await loadArchidekt();
    await act(async () => { settleArchidekt(archidektDeck); });
    await loadArchidekt();
    const canceledSignal = archidektSignal;
    await act(async () => { host.querySelector('dialog[aria-labelledby="deck-archidekt-title"]').dispatchEvent(new Event('cancel', { cancelable: true })); });
    assert(canceledSignal.aborted && !host.querySelector('#deck-archidekt-url') && archidektSelected(), 'Escape aborts pending preview without dropping prior selection or closing creation');
    await act(async () => { settleArchidekt({ ...archidektDeck, name: 'Stale preview' }); });
    assert(host.querySelector('#new-deck-name').value === archidektDeck.name, 'late canceled response cannot overwrite creation fields');
    await cancelDialog();
    await click(button('deck.createDeck'));
    assert(!archidektSelected() && host.querySelector('#new-deck-name').value === '', 'canceling creation resets Archidekt and form fields');
    await loadArchidekt();
    await act(async () => { root.render(null); });
    assert(archidektSignal.aborted, 'unmount aborts pending Archidekt preview');
    return ['AI dirty/busy navigation, unload, settings, Back, save failure/retry/success', 'mobile/desktop ordering and always-visible deck actions', 'native export focus/cancel and clipboard failure/recovery', 'pending import dismissal and long summary scroll', 'checkout/return locations failure and safe retry', 'cancel failure/progress retention, Back/Escape veto and duplicate-mutation guards', 'native ManaBox picker and file import', 'Archidekt preview recovery, commander defaults, exclusive sources, create retry/save, Escape/unmount abort and stale response guard'];
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    window.fetch = original.fetch;
    window.confirm = original.confirm;
    window.open = original.open;
    history.pushState = original.pushState;
    history.back = original.back;
    if (original.clipboard) Object.defineProperty(navigator, 'clipboard', original.clipboard); else delete navigator.clipboard;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
    if (originalLocale === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', originalLocale);
    document.documentElement.lang = originalLang;
  }
}
