import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeckBuilder from '../components/DeckBuilder';
import en from '../locales/en.json';
import { I18nProvider } from './i18n';

// Isolated Vite page only; every fetch is mocked, including AI generation/save.
export async function runUiDeckRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const original = { fetch: window.fetch, confirm: window.confirm, open: window.open, matchMedia: window.matchMedia, pushState: history.pushState, back: history.back, act: globalThis.IS_REACT_ACT_ENVIRONMENT, clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard') };
  const originalLocale = localStorage.getItem('manafolio_ui_lang');
  const originalLang = document.documentElement.lang;
  localStorage.setItem('manafolio_ui_lang', 'en');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const guard = { current: null };
  const toasts = [];
  let compact = true;
  let mediaChange;
  let settleSuggest;
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
  const response = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
  const card = { id: 'fixture', name: 'Fixture card', game: 'mtg', quantity: 2, owned_qty: 0, types: [], subtypes: [], number: '1' };
  const deck = { id: 7, name: 'Fixture deck', game: 'mtg', inventory_type: 'arena', format: 'Casual', target_size: 60, cards: [card], total_cards: 2 };
  const aiCard = { ...card, id: 'mtg-fixture', game: 'mtg', owned_qty: 1, available_qty: 1, locked_qty: 0, color_identity: [], color_identity_known: true };
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
  window.matchMedia = query => query === '(max-width: 768px)' ? { get matches() { return compact; }, addEventListener: (_, listener) => { mediaChange = listener; }, removeEventListener: () => {} } : original.matchMedia.call(window, query);
  window.confirm = () => { confirms++; return false; };
  window.open = () => { opened++; return null; };
  window.fetch = async (url, options = {}) => {
    if (url === '/api/decks') return response([deck]);
    if (url === '/api/decks/7') return response(deck);
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
    if (String(url).startsWith('/api/ai-decks/inventory?')) return response({ cards: [aiCard] });
    if (url === '/api/sets?game=mtg' || url === '/api/locations') return response([]);
    if (url === '/api/ai-decks/suggest') return new Promise(resolve => { settleSuggest = resolve; });
    if (url === '/api/ai-decks' && options.method === 'POST') return new Promise(resolve => { settleSave = resolve; });
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  try {
    await render();
    await click(button('aiDeck.title'));
    assert(guard.current(), 'pristine AI builder must allow navigation');
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
    await act(async () => { saveForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    const beforeSuccessConfirm = confirms;
    await act(async () => { settleSave(response({ id: 7 })); });
    assert(!host.querySelector('#ai-deck-title') && confirms === beforeSuccessConfirm, 'successful save bypasses discard confirmation and opens saved deck');

    const cards = host.querySelector('.deck-cards-heading');
    const overview = host.querySelector('.deck-summary-layout');
    assert(cards && overview, `saved deck must load card editing and overview; notices: ${JSON.stringify(toasts)}`);
    assert(cards.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING, 'mobile card list must precede analytics in DOM');
    const disclosure = host.querySelector('.deck-actions-disclosure');
    assert(disclosure && !disclosure.open, 'mobile secondary deck actions start collapsed');
    await click(disclosure.querySelector('summary'));
    assert(disclosure.open && disclosure.contains(button('deck.share')) && disclosure.contains(host.querySelector('[title="' + en['deck.exportHint'] + '"]')), 'native disclosure exposes secondary actions without duplicates');
    assert(host.querySelectorAll('[title="' + en['deck.exportHint'] + '"]').length === 1, 'responsive actions exist only once');
    await act(async () => { compact = false; mediaChange(); });
    assert(host.querySelector('.deck-summary-layout').compareDocumentPosition(host.querySelector('.deck-cards-heading')) & Node.DOCUMENT_POSITION_FOLLOWING, 'desktop preserves overview before card list');
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
    await click(button('deck.showQuickImport'));
    await change(host.querySelector('select[aria-label="' + en['deck.format'] + '"]'), 'manabox');
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
    await cancelDialog();
    return ['AI dirty/busy navigation, unload, settings, Back, save failure/retry/success', 'mobile/desktop ordering and native secondary-action disclosure', 'native export focus/cancel and clipboard failure/recovery', 'pending import dismissal and long summary scroll', 'checkout/return locations failure and safe retry', 'cancel failure/progress retention, Back/Escape veto and duplicate-mutation guards', 'native ManaBox picker and file import'];
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    window.fetch = original.fetch;
    window.confirm = original.confirm;
    window.open = original.open;
    window.matchMedia = original.matchMedia;
    history.pushState = original.pushState;
    history.back = original.back;
    if (original.clipboard) Object.defineProperty(navigator, 'clipboard', original.clipboard); else delete navigator.clipboard;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
    if (originalLocale === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', originalLocale);
    document.documentElement.lang = originalLang;
  }
}
