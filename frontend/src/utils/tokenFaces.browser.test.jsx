import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CardEntryFields from '../components/CardEntryFields';
import CardImageZoom from '../components/CardImageZoom';
import en from '../locales/en.json';

// Run on an isolated styled Vite page; every network request stays in this fixture.
// await (await import('/src/utils/tokenFaces.browser.test.jsx')).runTokenFaceRegressions()
export async function runTokenFaceRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const front = { id: 'mtg-front', name: 'Goblin', game: 'mtg', subtypes: ['Token'], image_url: '/mtg-card-back.webp' };
  const back = { id: 'mtg-back', name: 'Soldier', game: 'mtg', subtypes: ['Token'], set_name: 'Fixture tokens', number: '2', language: 'English', image_url: '/logo.svg' };
  let selected = null;
  let fail = true;
  let searches = 0;
  window.fetch = async url => {
    if (String(url).startsWith('/api/search?')) {
      searches++;
      return { ok: !fail, json: async () => [front, { ...back, id: 'non-token', subtypes: ['Creature'] }, back] };
    }
    if (String(url).startsWith('/api/card-art')) return { ok: true, json: async () => [] };
    throw new Error(`Unexpected request: ${url}`);
  };
  function Fields({ inventoryType = 'collection' }) {
    const [reverse, setReverse] = useState(null);
    return <CardEntryFields card={front} inventoryType={inventoryType} reverseCard={reverse} onReverseCard={value => { selected = value; setReverse(value); }} quantity={1} purchasePrice={0} condition="Near Mint" printing="Normal" language="English" game="mtg" onQuantity={() => {}} onPurchasePrice={() => {}} onCondition={() => {}} onPrinting={() => {}} onLanguage={() => {}} />;
  }
  const input = () => host.querySelector('input[id$="-search"]');
  const choice = () => host.querySelector('select[id$="-choice"]');
  const search = async () => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === en['shared.search']).click());
  const select = async value => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(choice(), value);
    choice().dispatchEvent(new Event('change', { bubbles: true }));
  });
  try {
    await act(async () => root.render(<Fields />));
    assert(input()?.labels.length === 1 && selected === null && !choice(), 'reverse selector is labeled and never invents a pair');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input(), 'Soldier');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await search();
    assert(host.querySelector('[role="alert"]')?.textContent === en['token.searchError'], 'search failure is announced');
    fail = false;
    await search();
    assert(searches === 2 && choice().options.length === 2, 'retry works and only a different token may be selected');
    assert(selected === null, 'search results alone do not select a reverse');
    await select(back.id);
    assert(selected.id === back.id && host.querySelector('img')?.alt === 'Soldier', 'explicit selected printing is previewed');
    await select('');
    assert(selected === null, 'reverse can be cleared explicitly');
    await act(async () => root.render(<Fields inventoryType="arena" />));
    assert(!input(), 'Arena does not offer physical pairing');
    const pair = { ...front, reverse_card_id: back.id, reverse_name: back.name, reverse_image_url: back.image_url };
    await act(async () => root.render(<CardImageZoom card={pair} onClose={() => {}} />));
    const flip = host.querySelector('button[aria-pressed]');
    await act(async () => flip.click());
    assert(flip.getAttribute('aria-pressed') === 'true' && host.querySelector('img').alt === 'Soldier', 'existing zoom flips to explicit reverse art');
    await act(async () => flip.click());
    assert(host.querySelector('img').alt === 'Goblin', 'flipping restores front artwork');
    return { passed: ['no inferred pairing', 'labels', 'search error and retry', 'token-only filtering', 'explicit selection and clear', 'Arena exclusion', 'paired artwork flip'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
}
