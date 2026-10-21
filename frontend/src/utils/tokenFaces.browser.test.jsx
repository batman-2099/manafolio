import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CardEntryFields from '../components/CardEntryFields';
import CardImageZoom from '../components/CardImageZoom';
import en from '../locales/en.json';
import { useReverseTokenPrompt } from './useReverseTokenPrompt';

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
  const front = { id: 'mtg-front', name: 'Goblin', game: 'mtg', set_id: 'tst', set_name: 'Fixture Tokens', subtypes: [], image_url: '/mtg-card-back.webp' };
  const back = { id: 'mtg-back', name: 'Soldier', game: 'mtg', set_id: 'else', subtypes: [], set_name: 'Fixture tokens', number: '2', language: 'English', image_url: '/logo.svg' };
  let selected = null;
  let fail = true;
  let searches = 0;
  let candidates = null;
  window.fetch = async url => {
    if (String(url).startsWith('/api/sets?')) return { ok: true, json: async () => [{ id: 'mtg-else', name: 'Other Tokens', symbol_url: '/logo.svg' }] };
    if (String(url).startsWith('/api/search?')) {
      searches++;
      const set = new URL(String(url), location.origin).searchParams.get('set');
      return { ok: !fail, json: async () => (candidates || [front, { ...back, id: 'non-token', set_name: 'Ordinary Set', subtypes: ['Creature'] }, back]).filter(card => !set || card.set_id === set) };
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
  const changeSet = async value => act(async () => {
    const field = [...host.querySelectorAll('label')].find(label => label.textContent === en['collection.fSet']).control;
    assert(!field.readOnly, 'reverse set can be changed');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const search = async () => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === en['shared.search']).click());
  const select = async value => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(choice(), value);
    choice().dispatchEvent(new Event('change', { bubbles: true }));
  });
  try {
    await act(async () => root.render(<Fields />));
    assert(input()?.labels.length === 1 && selected === null && !choice(), 'reverse selector is labeled and never invents a pair');
    await changeSet('Other');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Other Tokens (ELSE)')).click());
    assert(host.querySelector('input[id$="-set"]').value === 'else', 'choosing a set name supplies its code for reverse lookup');
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
    assert(selected.id === back.id && host.querySelector('img[alt="Soldier"]'), 'explicit selected printing is previewed');
    await select('');
    assert(selected === null, 'reverse can be cleared explicitly');
    await changeSet('');
    const numberInput = [...host.querySelectorAll('label')].find(label => label.textContent === en['search.cardNumber']).querySelector('input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(numberInput, '2');
      numberInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => numberInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert(selected?.id === back.id && choice().value === back.id, 'number search selects its sole valid reverse and updates the dropdown');
    await select('');
    candidates = [back, { ...back, id: 'another-printing', language: 'German' }];
    await search();
    assert(selected === null && choice().value === '', 'ambiguous numbered results require an explicit printing choice');
    candidates = [];
    await search();
    assert(selected === null && host.textContent.includes(en['token.noResults']), 'an unmatched number does not invent a reverse');
    candidates = null;
    await act(async () => root.render(<Fields inventoryType="arena" />));
    assert(!input(), 'Arena does not offer physical pairing');
    const pair = { ...front, reverse_card_id: back.id, reverse_name: back.name, reverse_image_url: back.image_url };
    await act(async () => root.render(<CardImageZoom card={pair} onClose={() => {}} />));
    const flip = host.querySelector('button[aria-pressed]');
    await act(async () => flip.click());
    assert(flip.getAttribute('aria-pressed') === 'true' && host.querySelector('img').alt === 'Soldier', 'existing zoom flips to explicit reverse art');
    await act(async () => flip.click());
    assert(host.querySelector('img').alt === 'Goblin', 'flipping restores front artwork');
    let requestReverse;
    const Prompt = () => {
      const prompt = useReverseTokenPrompt();
      requestReverse = prompt.requestReverse;
      return prompt.reversePrompt;
    };
    const action = label => [...host.querySelectorAll('button')].find(button => button.textContent === label);
    const closePrompt = async effect => {
      const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
      await act(effect);
      await popped;
    };
    await act(async () => root.render(<Prompt />));
    assert((await requestReverse(front, { inventoryType: 'arena' })).reverseCard === null && !host.querySelector('dialog'), 'Arena bypasses the physical prompt');
    assert((await requestReverse(front, { reverseCard: back })).reverseCard === back && !host.querySelector('dialog'), 'already chosen reverse does not ask twice');
    let decision;
    await act(async () => { decision = requestReverse(front); });
    assert(host.querySelector('dialog[open]') && action(en['token.useReverse']).disabled, 'an unpaired token waits for an explicit decision');
    await closePrompt(async () => action(en['common.cancel']).click());
    assert(await decision === null, 'cancel aborts rather than adding an unpaired copy');
    await act(async () => { decision = requestReverse(front); });
    await closePrompt(async () => action(en['token.continueWithout']).click());
    assert((await decision).reverseCard === null, 'explicit skip proceeds without inventing a reverse');
    await act(async () => { decision = requestReverse(front); });
    await changeSet('else');
    await search();
    await select(back.id);
    await closePrompt(async () => action(en['token.useReverse']).click());
    assert((await decision).reverseCard.id === back.id, 'confirmation returns the selected cross-set printing');
    await act(async () => { decision = requestReverse(front); });
    await closePrompt(async () => root.render(null));
    assert(await decision === null, 'unmount cancels the pending addition');
    return { passed: ['no inferred pairing', 'labels', 'search error and retry', 'token-only filtering', 'explicit selection and clear', 'Arena exclusion', 'paired artwork flip', 'prompt cancel/skip/select/unmount', 'already-paired bypass'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
}
