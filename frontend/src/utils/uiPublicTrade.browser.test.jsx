import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SharedCollection from '../components/SharedCollection';
import TradeWorkbench from '../components/TradeWorkbench';
import { I18nProvider } from './i18n';
import en from '../locales/en.json';

// Isolated Vite page only; every API request is intercepted, including trade confirmation.
// await (await import('/src/utils/uiPublicTrade.browser.test.jsx')).runUiPublicTradeRegressions()
export async function runUiPublicTradeRegressions() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const original = { fetch: window.fetch, confirm: window.confirm, act: globalThis.IS_REACT_ACT_ENVIRONMENT, url: location.href, state: history.state, lang: localStorage.getItem('manafolio_ui_lang'), documentLang: document.documentElement.lang };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('manafolio_ui_lang', 'en');
  const response = body => ({ ok: true, status: 200, json: async () => body });
  const base = { card_id: 'public-fixture', id: 'public-fixture', name: 'Public fixture', set_name: 'Fixture set', number: '7', game: 'mtg', types: [], subtypes: [], rarity: 'Common', condition: 'Near Mint', printing: 'Normal', language: 'English', quantity: 2, price_trend: 1, price_currency: 'USD', grader: 'Raw' };
  const copies = [{ ...base, entry_id: 987651, added_at: '2026-10-13T12:00:00Z', location: 'Blue binder' }, { ...base, entry_id: 987652, added_at: '2026-10-12T12:00:00Z', quantity: 3, condition: 'Played', printing: 'Holofoil', language: 'German', location: 'Red box' }];
  const entries = copies.map((card, index) => ({ ...card, snapshot: `fixture-${index}`, location_name: card.location }));
  let shareLocations = true;
  let confirmCalls = 0;
  let mutations = 0;
  let updates = 0;
  let reviewRequest;
  window.fetch = async (url, options = {}) => {
    if (String(url).startsWith('/api/shared/')) return response({ owner: 'Fixture owner', shareLocations, collection: copies, stats: { summary: { totalValue: 5, totalCards: 5, uniqueCards: 1 }, sets: [], types: [], rarities: [] } });
    if (url === '/api/trades/entries') return response(entries);
    if (String(url).startsWith('/api/search?')) return response([{ ...base, id: 'receive-fixture', name: 'Receiving fixture' }]);
    if (url === '/api/trades/review') {
      reviewRequest = JSON.parse(options.body);
      return response({ request: reviewRequest, giving: [{ ...entries[0], estimate: 1, currency: 'USD' }], receiving: [{ ...base, estimate: 1, currency: 'USD' }] });
    }
    if (url === '/api/trades/confirm') { mutations++; return response({ given: 1, received: 1 }); }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const render = component => act(async () => { root.render(<I18nProvider>{component}</I18nProvider>); });
  const click = element => act(async () => { assert(element, 'expected control exists'); element.click(); });
  const button = (key, scope = host) => [...scope.querySelectorAll('button')].find(element => element.textContent === en[key]);
  const change = (input, value) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const closePublicModal = async () => {
    const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    await click(host.querySelector('dialog[open] button'));
    await act(async () => { await popped; });
  };
  try {
    await render(<SharedCollection shareToken="fixture" />);
    assert(host.querySelectorAll('.card-grid .tcg-card').length === 1, 'duplicate copies render as one aggregate');
    await click(host.querySelector('.card-grid .tcg-card'));
    let dialog = host.querySelector('dialog[open]');
    const breakdown = dialog.querySelector('[aria-labelledby="shared-copies-title"]');
    assert(breakdown && breakdown.querySelectorAll('li').length === 2, 'stack exposes every original member');
    const rows = [...breakdown.querySelectorAll('li')].map(row => row.textContent);
    assert(['2', 'Normal', 'Near Mint', 'English', 'Blue binder'].every(value => rows[0].includes(value)), 'first copy retains its quantity, finish, condition, language and location');
    assert(['3', 'Holofoil', 'Played', 'German', 'Red box'].every(value => rows[1].includes(value)), 'second copy retains its distinct attributes');
    assert(dialog.textContent.includes('x5') && dialog.textContent.includes(en['shared.mixed']), 'aggregate quantity and mixed summary are truthful');
    assert(!dialog.textContent.includes('987651') && !dialog.textContent.includes('987652'), 'public copy breakdown does not expose entry IDs');
    await closePublicModal();
    await render(null);
    shareLocations = false;
    await render(<SharedCollection shareToken="hidden-fixture" />);
    await click(host.querySelector('.card-grid .tcg-card'));
    dialog = host.querySelector('dialog[open]');
    assert(!host.textContent.includes('Blue binder') && !host.textContent.includes('Red box') && !dialog.textContent.includes('Blue binder') && !dialog.textContent.includes('Red box'), 'private locations stay hidden even if present in fixture data');
    await closePublicModal();
    await click(host.querySelector('[aria-controls="shared-filters"]'));
    await click(host.querySelector('#stackCardsSharedOpt'));
    assert(host.querySelectorAll('.card-grid .tcg-card').length === 2, 'unstacked mode keeps original entries separate');
    await click(host.querySelector('.card-grid .tcg-card'));
    dialog = host.querySelector('dialog[open]');
    assert(!dialog.querySelector('#shared-copies-title') && dialog.textContent.includes('x2') && dialog.textContent.includes('Near Mint'), 'unstacked details retain original quantity and condition without aggregate breakdown');
    await closePublicModal();
    await render(null);

    const navigationGuardRef = { current: null };
    await render(<TradeWorkbench navigationGuardRef={navigationGuardRef} onUpdate={() => updates++} />);
    let add = host.querySelector('.trade-results button');
    add.focus();
    // Native keyboard activation dispatches a click with detail=0; no custom key handler is required.
    await click(add);
    assert(document.activeElement === host.querySelector('.trade-results button'), 'keyboard add moves focus to next available giving result');
    assert(host.querySelector('.trade-selection [role="status"]').textContent.includes('1 giving'), 'live selection count announces giving change');
    await click(document.activeElement);
    assert(document.activeElement === host.querySelector('.trade-columns h3'), 'last result moves focus to Giving heading');
    const searchForm = host.querySelector('.trade-columns form');
    await change(searchForm.querySelector('input'), 'Receiving');
    await act(async () => { searchForm.requestSubmit(); });
    await click(host.querySelectorAll('.trade-results')[1].querySelector('button'));
    const beforeDiscard = host.querySelector('.trade-selection').textContent;
    window.confirm = () => { confirmCalls++; return false; };
    await click(button('common.cancel'));
    assert(confirmCalls === 1 && host.querySelector('.trade-selection').textContent === beforeDiscard, 'cancelled discard preserves both sides of draft');
    window.confirm = () => { confirmCalls++; return true; };
    await click(button('common.cancel'));
    assert(confirmCalls === 2 && host.querySelectorAll('.trade-selection li').length === 0, 'confirmed discard clears both sides');
    assert(mutations === 0, 'discard never sends trade mutations');

    await click(host.querySelector('.trade-results button'));
    await click(host.querySelectorAll('.trade-results')[1].querySelector('button'));
    await act(async () => { host.querySelector('#trade-review-form').requestSubmit(); });
    assert(reviewRequest.giving.length === 1 && reviewRequest.receiving.length === 1, 'review uses current fixture draft');
    window.confirm = () => { throw new Error('successful trade must not ask to discard'); };
    await click(button('trade.confirm'));
    assert(mutations === 1 && updates === 1 && host.querySelectorAll('.trade-selection li').length === 0, 'successful fixture trade resets unconditionally');
    return { passed: ['mixed-stack-copy-breakdown', 'public-location-privacy', 'keyboard-giving-focus-and-live-count', 'cancelled-discard-preserves-draft', 'confirmed-discard-clears-draft', 'successful-trade-reset-without-discard-confirmation'] };
  } finally {
    const modalOpen = !!document.querySelector('#shared-card-title');
    const popped = modalOpen ? new Promise(resolve => window.addEventListener('popstate', resolve, { once: true })) : null;
    await act(async () => { root.unmount(); });
    if (popped) await popped;
    host.remove();
    window.fetch = original.fetch;
    window.confirm = original.confirm;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
    if (original.lang === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', original.lang);
    document.documentElement.lang = original.documentLang;
    history.replaceState(original.state, '', original.url);
  }
}
