import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CardInspectorModal from '../components/CardInspectorModal';
import DeckBuilder from '../components/DeckBuilder';
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
  const cards = [1, 2, 3].map(entry_id => ({ entry_id, id: 'sample-printing', card_id: 'sample-printing', name: `Sample ${entry_id}`, quantity: entry_id, game: 'mtg', list_type: 'collection', printing: 'Normal', set_id: `set${entry_id}`, set_name: `Sample Set ${entry_id}` }));
  cards[0] = { ...cards[0], subtypes: ['Token'], image_url: '/logo.svg?front', reverse_card_id: 'sample-reverse', reverse_name: 'Sample reverse', reverse_image_url: '/logo.svg?reverse' };
  cards[0].set_id = 'mtg-set1';
  cards[0].number = '42★';
  cards[0].cardmarket_url = 'https://www.cardmarket.com/en/Magic/Products?idProduct=123';
  cards[2] = { ...cards[2], stack_entries: [{ ...cards[2], position: 10000, missing: 1 }, { ...cards[2], entry_id: 4, position: 2000, quantity: 1 }, { ...cards[2], entry_id: 5, quantity: 1, missing: 1 }] };
  cards[2].stack_entries[0].deck_allocations = [
    { deck_id: 1, name: 'Sample reserved deck', quantity: 1, checked_out: true },
    { deck_id: 2, name: 'Sample pulled deck', quantity: 1, checked_out: false },
  ];
  cards[0].missing = 1;
  let settle;
  let updates = 0;
  let deckLookupFails = true;
  let creationFails = true;
  const commander = { ...cards[1], name: 'Sample commander', subtypes: ['Legendary', 'Creature'], list_type: 'arena' };
  const createdDeck = { id: 42, name: commander.name, game: 'mtg', inventory_type: 'arena', format: 'Commander / EDH', target_size: 100, commander_card_id: commander.id, cards: [{ ...commander, quantity: 1 }], total_cards: 1 };
  window.fetch = async (url, options = {}) => {
    if (url === '/api/ai-decks/account') return { ok: true, json: async () => ({ connected: false }) };
    if (url === '/api/decks' && options.method === 'POST') return { ok: !creationFails, json: async () => creationFails ? { error: 'Sample creation failure' } : { id: createdDeck.id } };
    if (url === '/api/decks/42') return { ok: true, json: async () => createdDeck };
    if (url === '/api/sets') return { ok: true, json: async () => [] };
    if (options.method === 'PUT') return new Promise(resolve => { settle = () => resolve({ ok: true }); });
    if (url.startsWith('/api/collection?')) return { ok: !deckLookupFails, json: async () => cards.map((card, index) => ({
      ...card, checked_out_qty: index === 0 ? 1 : 0, in_deck_qty: index < 2 ? 1 : 0,
      deck_allocations: index < 2 ? [{ deck_id: index + 1, name: index === 0 ? 'Reserved sample' : 'Pulled sample', quantity: 1, checked_out: index === 0 }] : [],
    })) };
    if (url === '/api/sets?game=mtg') return { ok: true, json: async () => [{ id: 'mtg-set1', symbol_url: '/logo.svg' }] };
    if (url.startsWith('/api/locations?') || url === '/api/decks' || url.includes('price-history')) return { ok: true, json: async () => [] };
    if (url.includes('card-art')) return { ok: true, json: async () => ({}) };
    throw new Error(`Unexpected sample request: ${url}`);
  };
  function Preview() {
    const [card, setCard] = useState(cards[0]);
    return <CardInspectorModal card={card} cards={cards} onNavigate={setCard} onClose={() => setCard(null)} onUpdate={() => { updates++; }} />;
  }
  function CommanderPreview() {
    const [deckId, setDeckId] = useState(null);
    return deckId
      ? <DeckBuilder initialDeckId={deckId} showToast={() => {}} />
      : <CardInspectorModal card={commander} onClose={() => {}} onOpenDeck={setDeckId} />;
  }
  const button = text => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.getAttribute('aria-label') === text);
  const click = async node => { assert(node, 'expected button exists'); await act(async () => node.click()); };
  const previous = () => button(en['inspector.previousCard']);
  const next = () => button(en['inspector.nextCard']);
  const setDetails = () => [...host.querySelectorAll('p')].find(node => node.textContent.includes('Sample Set'));
  try {
    await act(async () => root.render(<Preview />));
    const manaPool = host.querySelector('a[href^="https://manapool.com/"]');
    assert(manaPool?.href === 'https://manapool.com/card/set1/42%E2%98%85'
      && manaPool.textContent.includes('Mana Pool'), 'marketplace link uses the exact set and encoded collector number');
    assert(!host.querySelector('a[href*="cardmarket.com"]'), 'card details replace the legacy Cardmarket link');
    assert(host.textContent.includes(en['loc.errLoadCards']), 'missing dashboard allocation data must report lookup failures');
    deckLookupFails = false;
    await click(button(en['loc.retry']));
    assert(host.querySelector('.stored-entry-status .card-deck-status-summary')?.textContent.includes('Reserved sample'),
      'retry must show the current stored entry deck inside its status tag');
    assert(host.querySelector('.stored-entry-status .card-missing-status'), 'missing card details must show a Missing tag');
    assert(previous().disabled && !next().disabled, 'first card has only next available');
    assert(setDetails().textContent.includes('Sample Set 1') && setDetails().querySelector('img')?.getAttribute('src') === '/logo.svg', 'set metadata shows the current symbol beside the name');
    assert(host.textContent.split('Sample Set 1').length === 2, 'the set name is not duplicated under Printing');
    const faces = host.querySelectorAll('.ci-image-col .ci-image-wrap');
    assert(faces.length === 2 && faces[0].querySelector('img').getAttribute('src') === '/logo.svg?front'
      && faces[1].querySelector('img').getAttribute('src') === '/logo.svg?reverse', 'paired token shows front then reverse artwork');
    for (const [index, source] of ['/logo.svg?front', '/logo.svg?reverse'].entries()) {
      faces[index].focus();
      await click(faces[index]);
      const zoom = host.querySelector(`dialog[aria-label="${en['inspector.fullScreen']}"]`);
      assert(zoom?.querySelector('img').getAttribute('src') === source, 'zoom opens the selected face');
      const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
      await act(async () => zoom.dispatchEvent(new Event('cancel', { cancelable: true })));
      await popped;
      await act(async () => {});
      assert(document.activeElement === faces[index] && host.querySelector('dialog[open]'), 'closing zoom retains inspector and restores the selected face trigger');
    }
    await click(next());
    assert(host.querySelector('.section-heading').textContent.includes('Sample 2'), 'same-printing entries navigate by entry identity');
    assert(!host.querySelector('a[href^="https://manapool.com/"]'), 'printing without a collector number does not retain or invent a Mana Pool link');
    assert(setDetails().textContent.includes('Sample Set 2') && !setDetails().querySelector('img'), 'navigation keeps the set name without leaking the previous set symbol');
    assert(host.querySelectorAll('.ci-image-col .ci-image-wrap').length === 1, 'unpaired card does not retain the previous reverse artwork');
    assert(host.querySelector('.stored-entry-status .card-deck-status-summary')?.textContent.includes('Pulled sample')
      && !host.textContent.includes('Reserved sample'), 'navigation must replace deck allocation details with the new entry');
    assert(!host.querySelector('.stored-entry-status .card-missing-status'), 'navigation must not retain another entry’s Missing tag');
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
    const choices = [...host.querySelectorAll('.stored-entry-choices > button')];
    assert(choices[0].textContent.includes('Slot 2') && choices[1].textContent.includes('Slot 10') && !choices[2].textContent.includes('Slot'),
      'stored entries sort numerically by slot, with unpositioned copies last');
    assert(cards[2].stack_entries.map(entry => entry.entry_id).join() === '3,4,5', 'sorting must not mutate the source stack');
    const entryButton = id => choices[[4, 3, 5].indexOf(id)];
    assert(entryButton(3).querySelector('.card-missing-status')?.textContent === '3 of 3 Missing', 'missing entry counts all its copies');
    assert(!entryButton(4).querySelector('.card-missing-status'), 'available entry has no missing tag');
    assert(entryButton(5).querySelector('.card-missing-status')?.textContent === en['inspector.missing'], 'single missing entry shows the missing tag');
    const deckTags = [...entryButton(3).querySelectorAll('.card-deck-status-summary')];
    assert(deckTags.length === 2 && deckTags[0].textContent.includes('Sample reserved deck') && deckTags[0].textContent.includes(en['deck.inPlay'])
      && deckTags[1].textContent.includes('Sample pulled deck') && deckTags[1].textContent.includes(en['deck.pulled']),
    'entry chooser must put each deck name and its distinct allocation status inside the tag');
    assert(!entryButton(4).querySelector('.card-deck-status-summary'), 'unassigned entry must not inherit another entry’s deck tag');
    await click(entryButton(4));
    assert(next().disabled && !previous().disabled, 'last aggregate member retains list boundary');
    await click(previous());
    await click(button(en['inspector.editCard']));
    assert(host.querySelector('textarea').value === '', 'discarded draft does not leak when returning');
    await click(button(en['common.cancel']));
    await click(previous());
    assert(previous().disabled && host.querySelector('.section-heading').textContent.includes('Sample 1'), 'previous returns to first without wrapping');
    const closed = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    await click(button(en['common.close']));
    await closed;
    await act(async () => {});
    assert(!host.querySelector('dialog') && document.activeElement === trigger, 'close restores original trigger after multiple card changes');
    await act(async () => root.render(<CardInspectorModal card={{ ...cards[1], subtypes: ['Token'], image_url: '/logo.svg?native-front', image_url_back: '/logo.svg?native-back', name_back: 'Phyrexian' }} onClose={() => {}} />));
    const nativeFaces = host.querySelectorAll('.ci-image-col .ci-image-wrap');
    assert(nativeFaces.length === 2 && nativeFaces[1].querySelector('img').alt === 'Phyrexian', 'native token back is visible without an explicit reverse ID');
    await click(nativeFaces[1]);
    const nativeZoom = host.querySelector(`dialog[aria-label="${en['inspector.fullScreen']}"]`);
    assert(nativeZoom.querySelector('img').getAttribute('src') === '/logo.svg?native-back', 'native reverse zoom uses back artwork, not the front');
    const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    await act(async () => nativeZoom.dispatchEvent(new Event('cancel', { cancelable: true })));
    await popped;
    await act(async () => {});
    const replaced = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    await act(async () => root.render(<CommanderPreview />));
    await replaced;
    await act(async () => {});
    await click(button(en['inspector.createCommanderDeck']));
    assert(host.querySelector('dialog[open]') && host.textContent.includes('Sample creation failure'), 'failed commander creation retains the inspector and error');
    creationFails = false;
    await click(button(en['inspector.createCommanderDeck']));
    assert(!host.querySelector('dialog[open]') && button(en['deck.backToDecks']) && host.textContent.includes(commander.name),
      'successful commander creation opens the new deck detail rather than the gallery');
    return { passed: ['paired token face order and independent zoom', 'entry-identity ordering and boundaries', 'edit preservation and reset', 'pending write guard', 'parent refresh', 'aggregate member safety', 'original focus restoration'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    trigger.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
}
