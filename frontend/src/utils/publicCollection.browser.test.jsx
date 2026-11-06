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
  cards[0].types = ['Blue'];
  cards[0].subtypes = ['Creature'];
  cards[1].types = ['Blue'];
  cards[1].subtypes = ['Instant'];
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
    const type = host.querySelector('#shared-type');
    assert([...type.options].map(option => option.value).join(',') === ',Creature,Instant', 'Type choices use card types rather than colors');
    await change(type, 'Creature');
    assert(grid().length === 1 && grid()[0].querySelector('.tcg-card-name').textContent === cards[0].name, 'Type filter includes only matching subtypes');
    await change(type, '');
    await click(button('collection.nextPage'));
    await click(host.querySelector('#stackCardsSharedOpt'));
    assert(button('collection.previousPage').disabled, 'stack change resets the page');
    await click(button('collection.nextPage'));
    await click(button('collection.nextPage'));
    assert(grid().length === 2, 'unstacked final page includes both original copies');
    entries = cards.slice(0, 2);
    await render('replacement-fixture');
    assert(grid().length === 2 && !button('collection.nextPage'), 'replacement load clamps and resets pagination');
    return { passed: ['public-bounded-pagination-all-matches', 'filter-sort-stack-page-reset', 'replacement-load-clamp', 'public-type-filter-subtypes'] };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    window.fetch = original.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
    if (original.lang === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', original.lang);
    document.documentElement.lang = original.documentLang;
  }
}

export async function runCollectionPrintingRegressions() {
  const { default: CollectionList } = await import('../components/CollectionList');
  const { default: CardEntryFields } = await import('../components/CardEntryFields');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const saved = { fetch: window.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, lang: document.documentElement.lang };
  const storage = new Map(['manafolio_ui_lang', 'collection_default_view', 'default_game'].map(key => [key, localStorage.getItem(key)]));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const treatments = ['regular', 'borderless', 'extendedart', 'showcase', 'retro', 'fullart'];
  const base = { game: 'mtg', set_name: 'Treatment fixtures', number: '1', quantity: 1, printing: 'Normal', condition: 'Near Mint', language: 'English', types: [], subtypes: [], rarity: 'Common', image_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' };
  const cards = treatments.map((value, index) => ({ ...base, entry_id: index + 1, card_id: `treatment-${value}`, name: `Treatment ${value}`, printing_treatments: [value] }));
  cards.push(
    { ...base, entry_id: 7, card_id: 'overlap', name: 'Overlapping art', printing_treatments: ['borderless', 'fullart'] },
    { ...base, entry_id: 8, card_id: 'foil-regular', name: 'Foil regular', printing: 'Holofoil', printing_treatments: ['regular'] },
    { ...base, entry_id: 9, card_id: 'foil-showcase', name: 'Foil showcase', printing: 'Holofoil', printing_treatments: ['showcase'] },
    { ...base, entry_id: 10, card_id: 'unknown', name: 'Unknown treatment', printing_treatments: null },
    { ...base, entry_id: 11, card_id: 'missing', name: 'Missing treatment', missing: 1 },
    { ...cards[0], entry_id: 12, quantity: 2, missing: 1 },
  );
  const requests = [];
  let hold = false;
  let hydrated = false;
  const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname === '/api/collection') {
      let data = parsed.searchParams.get('list_type') === 'graveyard'
        ? [{ ...cards[4], name: 'Archived retro' }]
        : parsed.searchParams.has('is_trade') ? [cards[7]] : cards;
      data = data.map(card => {
        const { printing_treatments, ...entry } = card;
        return parsed.searchParams.has('include_treatments')
          ? { ...entry, printing_treatments: hydrated && !printing_treatments ? ['retro'] : printing_treatments }
          : entry;
      });
      const request = { params: parsed.searchParams, signal: options.signal };
      requests.push(request);
      if (hold) return new Promise(resolve => { request.resolve = (body = data, status = 200) => resolve(response(body, status)); });
      return response(data);
    }
    assert(['/api/sets', '/api/locations', '/api/decks'].includes(parsed.pathname), `unexpected collection request: ${url}`);
    return response([]);
  };
  const click = element => act(async () => { assert(element, 'control exists'); element.click(); });
  const button = (key, scope = host) => [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === en[key]);
  const filterDialog = () => host.querySelector('dialog[open]');
  const group = () => host.querySelector(`[role="group"][aria-label="${en['card.printing']}"]`);
  const option = label => [...group().querySelectorAll('label')].find(element => element.textContent === label)?.querySelector('input');
  const toggle = label => click(option(label));
  const openFilters = async () => {
    if (!filterDialog()) await click(host.querySelector('[aria-controls="collection-filter-options"]'));
    if (!group()) await click(host.querySelector(`button[aria-label="${en['card.printing']}"]`));
  };
  const names = () => [...host.querySelectorAll('.card-grid .tcg-card')].map(card => card.getAttribute('aria-label')).sort();
  const expectNames = expected => assert(JSON.stringify(names()) === JSON.stringify([...expected].sort()), `expected ${expected.join(', ')}; got ${names().join(', ')}`);
  const clear = () => click(button('collection.clearFilters', filterDialog()));
  const change = (element, value) => act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('manafolio_ui_lang', 'en');
    localStorage.setItem('collection_default_view', 'gallery');
    localStorage.setItem('default_game', 'mtg');
    await act(async () => root.render(<I18nProvider><CollectionList statsTrigger={0} /></I18nProvider>));
    assert(requests.length === 1 && !requests[0].params.has('include_treatments') && requests[0].params.get('list_type') === 'collection', 'ordinary collection reads do not hydrate metadata');
    for (const card of host.querySelectorAll('.card-grid .tcg-card')) {
      const missing = ['Missing treatment', 'Treatment regular'].includes(card.getAttribute('aria-label'));
      const badge = card.querySelector('.card-missing-status');
      assert(Boolean(badge) === missing, 'only missing cards and stacks containing a missing copy show a badge');
      if (missing) {
        const expected = card.getAttribute('aria-label') === 'Treatment regular' ? '2 of 3 Missing' : en['inspector.missing'];
        assert(badge.textContent === expected && card.getAttribute('aria-describedby').split(' ').includes(badge.id), 'missing status counts copies in a stack and describes the card');
      }
    }
    await click(host.querySelector(`button[title="${en['collection.listView']}"]`));
    assert([...host.querySelectorAll('.collection-table .card-missing-status')].some(badge => badge.textContent === '2 of 3 Missing'), 'list view shows the same missing-copy count');
    await click(host.querySelector(`button[title="${en['collection.galleryView']}"]`));
    await openFilters();
    assert(group().querySelectorAll('input').length === 8, 'Printing offers both finishes and all six treatments');
    await toggle('Foil');
    expectNames(['Foil regular', 'Foil showcase']);
    assert(requests.length === 1, 'finish-only filters remain local');
    await toggle('Nonfoil');
    assert(names().length === 11, 'multiple finishes use OR and duplicates remain stacked');
    await clear();
    hold = true;
    await toggle(en['collection.treatment.regular']);
    const firstHydration = requests.at(-1);
    assert(firstHydration.params.get('include_treatments') === 'true' && firstHydration.signal instanceof AbortSignal, 'treatment selection explicitly hydrates with a scoped abort signal');
    assert(host.querySelector('.read-state-initial') && !host.textContent.includes(en['collection.noMatches']), 'metadata-free cache is not presented as a known empty treatment result');
    hold = false;
    await act(async () => firstHydration.resolve());
    expectNames(['Treatment regular', 'Foil regular']);
    assert(host.querySelector('.card-grid').textContent.includes('x3'), 'treatment filtering precedes duplicate stacking');
    assert(host.textContent.includes(en['collection.treatmentsIncomplete']), 'null and missing treatments visibly produce partial results');
    for (const treatment of treatments) {
      await clear();
      await toggle(en[`collection.treatment.${treatment}`]);
      const expected = [`Treatment ${treatment}`];
      if (treatment === 'regular') expected.push('Foil regular');
      if (treatment === 'showcase') expected.push('Foil showcase');
      if (['borderless', 'fullart'].includes(treatment)) expected.push('Overlapping art');
      expectNames(expected);
    }
    await clear();
    await toggle(en['collection.treatment.regular']);
    await toggle(en['collection.treatment.showcase']);
    expectNames(['Treatment regular', 'Foil regular', 'Treatment showcase', 'Foil showcase']);
    await toggle('Foil');
    expectNames(['Foil regular', 'Foil showcase']);
    await toggle('Nonfoil');
    expectNames(['Treatment regular', 'Foil regular', 'Treatment showcase', 'Foil showcase']);
    await change(host.querySelector('#collection-min-price'), '1');
    expectNames([]);
    assert(!host.textContent.includes(en['collection.noMatches']), 'unknown metadata never claims a complete zero-result set');
    await change(host.querySelector('#collection-min-price'), '');
    await click(button('bulk.done', filterDialog()));
    hold = true;
    await click(button('dash.retry'));
    assert(host.textContent.includes(en['common.refreshing']) && names().length === 4, 'metadata Retry announces loading while retaining known matches');
    await act(async () => requests.at(-1).resolve({}, 503));
    assert(host.querySelector('[role="alert"]')?.textContent.includes(en['collection.errLoad']) && names().length === 4, 'failed hydration retains matches and offers existing error recovery');
    await openFilters();
    assert(option('Foil').checked && option('Nonfoil').checked && option(en['collection.treatment.regular']).checked && option(en['collection.treatment.showcase']).checked, 'failure preserves all finish and treatment choices');
    await click(button('bulk.done', filterDialog()));
    hold = false;
    hydrated = true;
    await click(button('dash.retry'));
    assert(!host.textContent.includes(en['collection.treatmentsIncomplete']) && !host.querySelector('[role="alert"]'), 'successful Retry clears error and incomplete notice');
    await openFilters();
    await clear();
    assert([...group().querySelectorAll('input')].every(input => !input.checked) && !requests.at(-1).params.has('include_treatments'), 'clear resets choices and restores cache-only reads');
    await toggle(en['collection.treatment.regular']);
    await click(host.querySelector('#tradeOnlyOpt'));
    expectNames(['Foil regular']);
    assert(requests.at(-1).params.get('is_trade') === '1' && requests.at(-1).params.get('include_treatments') === 'true', 'trade inventory scope is retained during hydration');
    await clear();
    await toggle(en['collection.treatment.retro']);
    await click(button('bulk.done', filterDialog()));
    await change(host.querySelector('#collection-inventory'), 'graveyard');
    expectNames(['Archived retro']);
    assert(requests.at(-1).params.get('list_type') === 'graveyard' && requests.at(-1).params.get('include_treatments') === 'true', 'archive inventory stays scoped with treatment selection');
    await openFilters();
    await clear();
    hold = true;
    await toggle(en['collection.treatment.regular']);
    const obsolete = requests.at(-1);
    hold = false;
    await clear();
    assert(obsolete.signal.aborted, 'clearing treatment selection aborts its in-flight hydration');
    await act(async () => obsolete.resolve([cards[0]]));
    expectNames(['Archived retro']);
    await click(button('bulk.done', filterDialog()));
    await click(button('collection.select'));
    const bulkPrinting = [...host.querySelectorAll('select')].find(select => select.options[0]?.textContent === en['bulk.setPrinting']);
    assert([...bulkPrinting.options].map(item => item.value).join() === ',Normal,Holofoil', 'bulk Set printing still exposes finishes only');
    await openFilters();
    hold = true;
    await toggle(en['collection.treatment.regular']);
    const unmounted = requests.at(-1);
    await act(async () => root.render(<I18nProvider><CardEntryFields quantity={1} purchasePrice={0} condition="Near Mint" printing="Normal" language="English" game="mtg" onQuantity={() => {}} onPurchasePrice={() => {}} onCondition={() => {}} onPrinting={() => {}} onLanguage={() => {}} /></I18nProvider>));
    assert(unmounted.signal.aborted, 'unmount aborts treatment lookup, including account-session replacement');
    assert([...host.querySelector('select[id$="-printing"]').options].map(item => item.value).join() === 'Normal,Holofoil', 'entry forms still expose finishes only');
    await act(async () => unmounted.resolve());
    assert(!host.querySelector('.card-grid'), 'late unmounted hydration cannot republish collection data');
    return { passed: ['six treatment choices', 'overlap and OR/AND matching', 'finish-only editing', 'filter before stacking', 'unknown metadata and Retry loading', 'failure preserves selection', 'clear and stale response abort', 'trade and archive scope', 'unmount isolation'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = saved.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
    document.documentElement.lang = saved.lang;
    for (const [key, value] of storage) {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    }
  }
}
