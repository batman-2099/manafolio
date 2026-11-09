import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeckHistory from '../components/DeckHistory';
import { I18nProvider } from './i18n';

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
  window.fetch = async url => {
    if (String(url).includes('/card-art')) return { ok: true, json: async () => ({}) };
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
    await act(async () => {
      const comparison = host.querySelectorAll('.deck-history-selectors select')[1];
      comparison.value = '1';
      comparison.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert(host.querySelectorAll('.deck-history-group').length === 0, 'identical comparisons omit empty sections');
    return { passed: ['separate change sections', 'quantity changes', 'empty section removal'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = original.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
  }
}
