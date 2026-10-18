import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CardInspectorModal from '../components/CardInspectorModal';
import en from '../locales/en.json';

// Run on an isolated Vite page; all requests use sample data.
export async function runInspectorNavigationRegressions() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const trigger = document.createElement('button');
  trigger.textContent = 'Sample card trigger';
  document.body.append(trigger, host);
  trigger.focus();
  const root = createRoot(host);
  const cards = [1, 2, 3].map(entry_id => ({ entry_id, id: 'sample-printing', card_id: 'sample-printing', name: `Sample ${entry_id}`, quantity: entry_id, game: 'mtg', list_type: 'collection' }));
  cards[2] = { ...cards[2], stack_entries: [{ ...cards[2] }, { ...cards[2], entry_id: 4, quantity: 1 }] };
  let settle;
  let updates = 0;
  window.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') return new Promise(resolve => { settle = () => resolve({ ok: true }); });
    if (url.startsWith('/api/locations?') || url === '/api/decks' || url.includes('price-history')) return { ok: true, json: async () => [] };
    if (url.includes('card-art')) return { ok: true, json: async () => ({}) };
    throw new Error(`Unexpected sample request: ${url}`);
  };
  function Preview() {
    const [card, setCard] = useState(cards[0]);
    return <CardInspectorModal card={card} cards={cards} onNavigate={setCard} onClose={() => setCard(null)} onUpdate={() => { updates++; }} />;
  }
  const button = text => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.getAttribute('aria-label') === text);
  const click = async node => { assert(node, 'expected button exists'); await act(async () => node.click()); };
  const previous = () => button(en['inspector.previousCard']);
  const next = () => button(en['inspector.nextCard']);
  try {
    await act(async () => root.render(<Preview />));
    assert(previous().disabled && !next().disabled, 'first card has only next available');
    await click(next());
    assert(host.querySelector('.section-heading').textContent.includes('Sample 2'), 'same-printing entries navigate by entry identity');
    await click(button(en['inspector.editCard']));
    const notes = host.querySelector('textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(notes, 'Unsaved sample note');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert(previous().disabled && next().disabled, 'editing disables both directions');
    await click(next());
    assert(host.querySelector('textarea').value === 'Unsaved sample note', 'navigation cannot discard an edit');
    await click(button(en['common.cancel']));
    await click(button(en['inspector.favorite']));
    assert(next().matches(':disabled'), 'pending mutation blocks navigation');
    await click(next());
    assert(host.querySelector('.section-heading').textContent.includes('Sample 2'), 'pending write retains target');
    await act(async () => settle());
    await click(next());
    assert(updates === 1, 'successful quick changes refresh parent before navigating');
    assert(host.textContent.includes(en['inspector.chooseEntry']), 'next aggregate still requires explicit member choice');
    await click([...host.querySelectorAll('button')].find(node => node.textContent.includes('#4')));
    assert(next().disabled && !previous().disabled, 'last aggregate member retains list boundary');
    await click(previous());
    await click(button(en['inspector.editCard']));
    assert(host.querySelector('textarea').value === '', 'discarded draft does not leak when returning');
    await click(button(en['common.cancel']));
    await click(previous());
    assert(previous().disabled && host.querySelector('.section-heading').textContent.includes('Sample 1'), 'previous returns to first without wrapping');
    await click(button(en['common.close']));
    assert(!host.querySelector('dialog') && document.activeElement === trigger, 'close restores original trigger after multiple card changes');
    return { passed: ['entry-identity ordering and boundaries', 'edit preservation and reset', 'pending write guard', 'parent refresh', 'aggregate member safety', 'original focus restoration'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    trigger.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
}
