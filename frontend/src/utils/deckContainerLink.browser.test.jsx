import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeckBuilder from '../components/DeckBuilder';
import { I18nProvider } from './i18n';
import en from '../locales/en.json';

export async function runDeckContainerLinkRegressions() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const original = { fetch: window.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const deck = { id: 1, name: 'Sample linked deck', game: 'mtg', inventory_type: 'collection', format: 'Casual', target_size: 60, cards: [], container_id: 10, container_name: 'Sample box' };
  let fail = true;
  window.fetch = async (url, options = {}) => {
    let body;
    if (url === '/api/decks/1/container-link') {
      if (fail) return { ok: false, json: async () => ({ error: 'Sample failure' }) };
      const { container_id } = JSON.parse(options.body);
      body = { container_id, container_name: container_id === 11 ? 'Second box' : null };
      Object.assign(deck, body);
    } else if (url === '/api/decks') body = [deck];
    else if (url === '/api/decks/1') body = deck;
    else if (url === '/api/decks/1/locations') body = [];
    else if (url === '/api/locations?inventory_type=collection') body = [{ id: 10, name: 'Sample box', game: 'mtg' }, { id: 11, name: 'Second box', game: 'any' }, { id: 12, name: 'Legacy game', game: 'other' }];
    else if (String(url).includes('card-art')) body = {};
    else throw new Error(`Unexpected fixture request: ${url}`);
    return { ok: true, json: async () => body };
  };
  const select = async value => {
    await act(async () => {
      const control = host.querySelector('#deck-linked-container');
      assert(!control.disabled, 'saved deck container control is available');
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<I18nProvider><DeckBuilder initialDeckId={1} showToast={() => {}} /></I18nProvider>));
    assert(!host.querySelector('#deck-linked-container option[value="12"]'), 'unsupported game containers are not offered');
    await act(async () => {
      const notes = host.querySelector('#deck-notes');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(notes, 'Unsaved sample notes');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await select('11');
    assert(host.querySelector('#deck-linked-container').value === '10' && host.textContent.includes(en['deck.containerLinkError']), 'failed save preserves the previous association and reports failure');
    fail = false;
    await select('11');
    assert(host.querySelector('#deck-linked-container').value === '11', 'retry publishes the saved association');
    assert(host.querySelector('#deck-notes').value === 'Unsaved sample notes' && !deck.notes, 'linking never saves or discards unsaved deck edits');
    await select('');
    assert(host.querySelector('#deck-linked-container').value === '' && deck.container_id === null, 'unlink removes only the association');
    return ['failed link rollback', 'retry', 'unsaved deck edits retained', 'unlink'];
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = original.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
  }
}
