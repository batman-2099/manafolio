import { act } from 'react';
import { createRoot } from 'react-dom/client';
import RelatedTokens from '../components/RelatedTokens';
import en from '../locales/en.json';

// Run on an isolated Vite page; no real inventory or provider requests.
export async function runRelatedTokenRegressions() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const id = 'mtg-11111111-1111-1111-1111-111111111111';
  const matched = 'mtg-22222222-2222-2222-2222-222222222222';
  const printing = { id: matched, name: 'Sample Goblin', game: 'mtg', subtypes: ['Token'], set_id: 'ttst', set_name: 'Sample token set', number: '2', language: 'English' };
  const reverse = { ...printing, id, name: 'Sample Soldier', number: '1', set_id: 'other' };
  let metadataFailure = false;
  let deckQuantity = 2;
  let owned = true;
  let reject = true;
  let release;
  const writes = [];
  const response = (body, ok = true) => ({ ok, json: async () => body });
  window.fetch = async (url, options = {}) => {
    if (url.startsWith('/api/sets?')) return response([]);
    if (url === '/api/cards/related-tokens') return response({ tokens: [{ id, matched_card_id: matched, name: 'Sample Goblin', owned, owned_qty: 3, source_entry_id: 42, owned_entries: [{ entry_id: 42, card_id: matched, front_card_id: id, reverse_card_id: matched, quantity: 3, location_name: 'Sample box' }], locations: [{ quantity: 3, location_name: 'Sample box' }], source_cards: [{ name: 'Sample creator' }] }] });
    if (url === '/api/decks') return response([{ id: 7, name: 'Sample deck' }]);
    if (url.startsWith('/api/locations?')) return response([{ id: 9, name: 'Sample box' }]);
    if (url === '/api/decks/7') return response({ cards: [{ id: matched, quantity: deckQuantity }] });
    if (url === `/api/cards/${matched}/printing?lang=en&game=mtg`) return metadataFailure ? response({ error: 'Sample metadata unavailable' }, false) : response(printing);
    if (url.startsWith('/api/search?')) {
      const set = new URL(url, location.origin).searchParams.get('set');
      return response([printing, reverse].filter(card => !set || card.set_id === set));
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      writes.push(body);
      if (reject) return response({ error: 'Sample rejection' }, false);
      if (url === '/api/decks/7/cards') { deckQuantity = body.quantity; return response({}); }
      if (url === '/api/collection') return new Promise(resolve => { release = () => { owned = true; resolve(response({ placement: { label: 'Sample box' } })); }; });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const select = async (node, value) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const render = async props => act(async () => root.render(<RelatedTokens cardIds={[id]} {...props} />));
  const open = async () => act(async () => host.querySelector('button[aria-haspopup="dialog"]').click());
  const prompt = () => [...host.querySelectorAll('dialog')].find(dialog => dialog.querySelector('h2')?.textContent === en['token.promptTitle']);
  const click = async (text, scope = host, closesPrompt = false) => {
    const target = [...scope.querySelectorAll('button')].find(button => button.textContent.trim() === text);
    assert(target && !target.disabled, `enabled button: ${text}`);
    const popped = closesPrompt ? new Promise(resolve => window.addEventListener('popstate', resolve, { once: true })) : null;
    await act(async () => target.click());
    if (popped) {
      await popped;
      await act(async () => {});
    }
  };
  try {
    await render({ compact: true });
    await open();
    const deckSelect = host.querySelector(`dialog select[aria-label="${en['deck.addToDeck']}"]`);
    await select(deckSelect, '7');
    assert(host.querySelector('[role="alert"]').textContent === 'Sample rejection', 'rejection remains visible without closing viewer');
    assert(deckQuantity === 2, 'rejected addition preserves quantity');
    reject = false;
    await select(deckSelect, '7');
    assert(deckQuantity === 3 && writes.at(-1).card_id === matched, 'adding uses matched printing and increments rather than overwrites');
    assert(writes.at(-1).source_entry_id === 42, 'reverse printing pins the same physical source entry');
    assert(!prompt(), 'deck additions do not create ownership or ask for a reverse');
    assert(host.textContent.includes('3×') && host.textContent.includes('Sample box'), 'related reverse ownership shows shared quantity and location');
    const container = host.querySelector(`select[aria-label="${en['relatedTokens.addToContainer']}"]`);
    metadataFailure = true;
    await select(container, '9');
    assert(writes.length === 2 && host.querySelector('[role="alert"]').textContent === 'Sample metadata unavailable', 'metadata failure prevents ownership writes and allows retry');
    metadataFailure = false;
    await select(container, '9');
    assert(prompt() && writes.length === 2 && container.disabled, 'container addition waits for the reverse decision before writing');
    await click(en['common.cancel'], prompt(), true);
    assert(!prompt() && writes.length === 2 && !container.disabled, 'reverse cancellation preserves the viewer without adding inventory');
    await select(container, '9');
    await act(async () => {
      const field = [...prompt().querySelectorAll('label')].find(label => label.textContent === en['collection.fSet']).control;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'other');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(en['shared.search'], prompt());
    const reverseSelect = prompt().querySelector('select');
    assert(reverseSelect.options.length === 2, 'a token from another set can be selected');
    await select(reverseSelect, id);
    await click(en['token.useReverse'], prompt(), true);
    await select(container, '9');
    assert(writes.length === 3, 'pending duplicate adds are blocked');
    assert(writes.at(-1).location_id === 9 && writes.at(-1).list_type === 'collection', 'container addition uses selected physical destination');
    assert(writes.at(-1).card_id === matched && writes.at(-1).reverse_card_id === id, 'container addition uses real printing metadata and the chosen reverse');
    assert(host.querySelector('dialog button').disabled, 'pending save cannot dismiss viewer');
    await act(async () => release());
    assert(host.textContent.includes(en['relatedTokens.owned']), 'ownership refreshes after successful addition');
    await select(container, '9');
    await click(en['token.continueWithout'], prompt(), true);
    assert(writes.length === 4 && writes.at(-1).reverse_card_id === null, 'explicit continuation creates a single unpaired copy');
    await act(async () => release());
    await act(async () => host.querySelector('dialog button').click());
    await render({ inventoryType: 'arena' });
    await open();
    assert(host.querySelectorAll('dialog select').length === 1, 'Arena never offers physical containers');
    await render({ inventoryType: 'arena', disabled: true });
    assert(host.querySelector('dialog select').disabled, 'unsaved deck guard disables additions');
    return { passed: ['error recovery', 'matched-printing increment', 'deck prompt exclusion', 'metadata retry', 'reverse cancellation', 'cross-set reverse pairing', 'explicit unpaired continuation', 'pending duplicate guard', 'container destination and ownership refresh', 'Arena isolation', 'unsaved deck guard'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
}
