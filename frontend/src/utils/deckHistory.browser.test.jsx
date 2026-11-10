import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeckHistory from '../components/DeckHistory';
import { I18nProvider } from './i18n';
import en from '../locales/en.json';

export async function runDeckHistoryRegressions() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const original = { fetch: window.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cards = ['removed', 'added', 'changed'].map(id => ({ id, name: `Sample ${id}`, quantity: id === 'changed' ? 3 : 1, image_url: '/logo.svg' }));
  const snapshot = { cards: [{ card_id: 'removed', quantity: 1 }, { card_id: 'changed', quantity: 2 }] };
  const saved = { cards: [{ card_id: 'added', quantity: 1 }, { card_id: 'changed', quantity: 3 }] };
  let lookupFails = true;
  const entries = [41, 42].map(entry_id => ({ ...cards[0], entry_id, card_id: 'removed', name: `Stored copy ${entry_id}`, quantity: 1, list_type: 'collection', game: 'mtg', deck_allocations: [] }));
  window.fetch = async url => {
    if (String(url).includes('/card-art')) return { ok: true, json: async () => ({}) };
    if (String(url).startsWith('/api/collection?')) {
      const query = new URL(url, window.location.origin).searchParams;
      assert(query.get('list_type') === 'collection', 'history lookup preserves deck inventory');
      if (query.get('card_id') === 'removed') return { ok: true, json: async () => entries };
      if (query.get('card_id') === 'added') return { ok: true, json: async () => [] };
      return { ok: !lookupFails, json: async () => [entries[0]] };
    }
    if (String(url).startsWith('/api/locations?') || url === '/api/decks' || String(url).includes('price-history') || String(url).startsWith('/api/sets')) return { ok: true, json: async () => [] };
    if (url === '/api/ai-decks/account') return { ok: true, json: async () => ({ connected: false }) };
    assert(url === '/api/decks/1/revisions', 'unexpected history request');
    return { ok: true, json: async () => ({ cards, revisions: [{ id: 1, kind: 'baseline', created_at: '2026-11-09T12:00:00Z', snapshot }] }) };
  };
  try {
    await act(async () => root.render(<I18nProvider><DeckHistory deck={{ id: 1, cards: cards.slice(1) }} saved={saved} onClose={() => {}} onRestored={() => {}} /></I18nProvider>));
    const groups = [...host.querySelectorAll('.deck-history-group')];
    assert(groups.length === 3, 'removed, added, and changed cards have separate sections');
    for (const [index, kind] of ['removed', 'added', 'changed'].entries()) {
      const group = groups[index];
      assert(group.getAttribute('aria-labelledby') === group.querySelector('h3').id, 'section has an accessible heading');
      assert(group.querySelectorAll('li').length === 1 && group.querySelector('li').textContent.includes(`Sample ${kind}`), 'each change appears only in its own section');
    }
    assert(groups[2].textContent.includes('2 → 3 (+1)'), 'quantity changes retain their before and after values');
    const click = async selector => { await act(async () => host.querySelector(selector).click()); };
    await click('.deck-history-card-change--removed button');
    assert(host.querySelectorAll('.stored-entry-choices > button').length === 2, 'removed cards resolve to real collection entries and require a copy choice');
    await click('.stored-entry-choices > button:last-child');
    assert(host.querySelector('.section-heading')?.textContent.includes('Stored copy 42'), 'chosen collection copy opens the full inspector, not the deck art preview');
    const closeInspector = async () => {
      const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
      await act(async () => host.querySelector('.ci-image-col').closest('dialog').dispatchEvent(new Event('cancel', { cancelable: true })));
      await popped;
    };
    await closeInspector();
    assert(host.querySelector('.deck-history-panel') && !host.querySelector('.ci-image-col'), 'closing collection details retains the history comparison');
    await click('.deck-history-card-change--added button');
    assert(host.textContent.includes(en['collection.noMatches']) && !host.querySelector('.ci-image-col'), 'missing owned copies never open an editable inspector with a printing ID');
    await click('.deck-history-card-change--changed button');
    assert(host.textContent.includes(en['collection.errLoad']) && !host.querySelector('.ci-image-col'), 'lookup failures are visible without opening stale details');
    lookupFails = false;
    await click('.deck-history-card-change--changed button');
    assert(host.querySelector('.section-heading')?.textContent.includes('Stored copy 41'), 'clicking again retries a failed lookup and opens the sole stored copy');
    await closeInspector();
    await act(async () => {
      const comparison = host.querySelectorAll('.deck-history-selectors select')[1];
      comparison.value = '1';
      comparison.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert(host.querySelectorAll('.deck-history-group').length === 0, 'identical comparisons omit empty sections');
    return { passed: ['separate change sections', 'quantity changes', 'collection copy details', 'missing copies', 'lookup retry', 'empty section removal'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = original.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
  }
}
