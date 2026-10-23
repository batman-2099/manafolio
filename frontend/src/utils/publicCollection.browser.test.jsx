import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SharedCollection from '../components/SharedCollection';
import { I18nProvider } from './i18n';
import en from '../locales/en.json';

// Isolated Vite page: await (await import('/src/utils/publicCollection.browser.test.jsx')).runPublicCollectionRegressions()
export async function runPublicCollectionRegressions() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const original = { fetch: window.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, lang: localStorage.getItem('manafolio_ui_lang'), documentLang: document.documentElement.lang };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('manafolio_ui_lang', 'en');
  const cards = Array.from({ length: 121 }, (_, index) => ({ entry_id: index + 1, card_id: `pagination-${index}`, name: `Pagination fixture ${String(index).padStart(3, '0')}`, set_name: 'Fixture set', number: String(index), game: 'mtg', types: [], subtypes: [], rarity: index === 0 ? 'Rare' : 'Common', printing: 'Normal', condition: 'Near Mint', quantity: 1, price_trend: 1, price_currency: 'USD' }));
  let entries = [...cards, { ...cards[0], entry_id: 122, printing: 'Holofoil' }];
  window.fetch = async url => {
    assert(String(url).startsWith('/api/shared/'), `unexpected request: ${url}`);
    return { ok: true, json: async () => ({ owner: 'Pagination fixture', collection: entries, stats: { summary: { totalValue: entries.length, totalCards: entries.length, uniqueCards: cards.length }, sets: [], types: [], rarities: [] } }) };
  };
  const render = token => act(async () => { root.render(<I18nProvider><SharedCollection shareToken={token} /></I18nProvider>); });
  const click = element => act(async () => { assert(element, 'control exists'); element.click(); });
  const button = key => [...host.querySelectorAll('button')].find(element => element.textContent === en[key]);
  const grid = () => [...host.querySelectorAll('.card-grid .tcg-card')];
  const change = (element, value) => act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  try {
    await render('pagination-fixture');
    const seen = new Set();
    for (const count of [60, 60, 1]) {
      assert(grid().length === count, 'rendering is bounded to sixty cards');
      grid().forEach(card => seen.add(card.getAttribute('aria-label')));
      if (count === 60) await click(button('collection.nextPage'));
    }
    assert(seen.size === 121 && button('collection.nextPage').disabled, 'all matches are reachable exactly once and final page is bounded');
    await change(host.querySelector('#shared-search'), 'Pagination fixture 000');
    assert(grid().length === 1 && !button('collection.nextPage'), 'search from final page does not strand results');
    const mixed = [...host.querySelectorAll('.card-grid .collection-card-tag')].find(tag => tag.textContent === en['shared.mixed']);
    assert(mixed && mixed.scrollWidth <= mixed.clientWidth, 'mixed printing text fits within its badge');
    await change(host.querySelector('#shared-search'), '');
    assert(grid().length === 60 && button('collection.previousPage').disabled, 'clearing filter resets to first page');
    await click(button('collection.nextPage'));
    await change(host.querySelector('#shared-sort'), 'name-asc');
    assert(button('collection.previousPage').disabled, 'sort change resets the page');
    await click(host.querySelector('[aria-controls="shared-filters"]'));
    await click(button('collection.nextPage'));
    await click(host.querySelector('#stackCardsSharedOpt'));
    assert(button('collection.previousPage').disabled, 'stack change resets the page');
    await click(button('collection.nextPage'));
    await click(button('collection.nextPage'));
    assert(grid().length === 2, 'unstacked final page includes both original copies');
    entries = cards.slice(0, 2);
    await render('replacement-fixture');
    assert(grid().length === 2 && !button('collection.nextPage'), 'replacement load clamps and resets pagination');
    return { passed: ['public-bounded-pagination-all-matches', 'filter-sort-stack-page-reset', 'replacement-load-clamp'] };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    window.fetch = original.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
    if (original.lang === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', original.lang);
    document.documentElement.lang = original.documentLang;
  }
}
