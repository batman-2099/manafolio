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
  let deckQuantity = 2;
  let owned = false;
  let reject = true;
  let release;
  const writes = [];
  const response = (body, ok = true) => ({ ok, json: async () => body });
  window.fetch = async (url, options = {}) => {
    if (url === '/api/cards/related-tokens') return response({ tokens: [{ id, matched_card_id: matched, name: 'Sample Goblin', owned, locations: [], source_cards: [{ name: 'Sample creator' }] }] });
    if (url === '/api/decks') return response([{ id: 7, name: 'Sample deck' }]);
    if (url.startsWith('/api/locations?')) return response([{ id: 9, name: 'Sample box' }]);
    if (url === '/api/decks/7') return response({ cards: [{ id: matched, quantity: deckQuantity }] });
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
  try {
    await render({ compact: true });
    await open();
    const deckSelect = host.querySelector('dialog select');
    await select(deckSelect, '7');
    assert(host.querySelector('[role="alert"]').textContent === 'Sample rejection', 'rejection remains visible without closing viewer');
    assert(deckQuantity === 2, 'rejected addition preserves quantity');
    reject = false;
    await select(deckSelect, '7');
    assert(deckQuantity === 3 && writes.at(-1).card_id === matched, 'adding uses matched printing and increments rather than overwrites');
    const container = host.querySelector(`select[aria-label="${en['relatedTokens.addToContainer']}"]`);
    await select(container, '9');
    await select(container, '9');
    assert(writes.length === 3, 'pending duplicate adds are blocked');
    assert(writes.at(-1).location_id === 9 && writes.at(-1).list_type === 'collection', 'container addition uses selected physical destination');
    assert(host.querySelector('dialog button').disabled, 'pending save cannot dismiss viewer');
    await act(async () => release());
    assert(host.textContent.includes(en['relatedTokens.owned']), 'ownership refreshes after successful addition');
    await act(async () => host.querySelector('dialog button').click());
    await render({ inventoryType: 'arena' });
    await open();
    assert(host.querySelectorAll('dialog select').length === 1, 'Arena never offers physical containers');
    await render({ inventoryType: 'arena', disabled: true });
    assert(host.querySelector('dialog select').disabled, 'unsaved deck guard disables additions');
    return { passed: ['error recovery', 'matched-printing increment', 'pending duplicate guard', 'container destination and ownership refresh', 'Arena isolation', 'unsaved deck guard'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
}
