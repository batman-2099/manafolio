import { act } from 'react';
import { createRoot } from 'react-dom/client';
import AddCards from '../components/AddCards';
import en from '../locales/en.json';

// Run on an isolated Vite page; every fetch is mocked and no collection is touched.
// await (await import('/src/utils/uiSearch.browser.test.jsx')).runUiSearchRegressions()
export async function runUiSearchRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalUrl = window.location.href;
  const originalHistory = window.history.state;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const requests = [];
  const unexpected = [];
  const singleWrites = [];
  let tokenResults = null;
  const toasts = [];
  let refreshes = 0;
  let settle;
  const guard = { current: null };
  const response = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => '2' }, json: async () => body });
  const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="14"/%3E';
  const front = { id: 'mtg-front', name: 'Goblin', game: 'mtg', language: 'English', set_id: 'tst', set_name: 'Fixture tokens', number: '1', subtypes: ['Token'], image_url: image };
  const back = { ...front, id: 'mtg-back', name: 'Soldier', number: '2' };
  window.fetch = async (url, options = {}) => {
    if (url === '/api/card-art/index') return response([]);
    if (url === '/api/collection' && options.method === 'POST') {
      singleWrites.push(JSON.parse(options.body));
      return response({ id: 100 + singleWrites.length });
    }
    if (String(url).startsWith('/api/collection?')) return response([]);
    if (String(url).startsWith('/api/search?') && tokenResults) {
      const params = new URL(String(url), location.origin).searchParams;
      return response(params.get('prints') === '1' ? [front, back] : params.get('number') ? [front] : tokenResults);
    }
    if (String(url).startsWith('/api/locations?') && tokenResults) return response([{ id: 7, name: 'Token box' }]);
    if (url === '/api/collection/bulk-add') {
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { settle = (body, status) => resolve(response(body, status)); });
    }
    if (String(url).startsWith('/api/search?')) return response([
      { id: 'sample-a', name: 'Sample Alpha', game: 'mtg', language: 'English', set_name: 'Sample Set', owned_qty: 4, image_url: image },
      { id: 'sample-b', name: 'Sample Beta', game: 'mtg', language: 'English', set_name: 'Sample Set', owned_qty: 7, image_url: image },
    ]);
    if (String(url).startsWith('/api/sets?') || String(url).startsWith('/api/locations?')) return response([]);
    unexpected.push(String(url));
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const change = async (element, value) => {
    assert(element && !element.matches(':disabled'), 'edit only available controls');
    await act(async () => {
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
    assert(element.value === value, 'controlled draft retains input');
  };
  const button = text => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text);
  const click = async node => { assert(node, 'expected control exists'); await act(async () => node.click()); };
  const closeOverlay = async (effect, popCount = 1) => {
    const popped = new Promise(resolve => {
      let count = 0;
      const onPop = () => {
        if (++count !== popCount) return;
        window.removeEventListener('popstate', onPop);
        resolve();
      };
      window.addEventListener('popstate', onPop);
    });
    await act(effect);
    await popped;
    await act(async () => {});
  };
  const card = name => [...host.querySelectorAll('.tcg-card')].find(node => node.querySelector('.tcg-card-name')?.textContent === name);
  const owned = name => card(name).querySelector('.tcg-card-inner .lucide-check').parentElement.textContent.trim();
  const bulkForm = () => host.querySelector('#search-bulk-quantity').form;
  const submit = async () => { await act(async () => bulkForm().requestSubmit()); };
  try {
    await act(async () => root.render(<AddCards onAddSuccess={() => { refreshes++; }} showToast={(...args) => toasts.push(args)} navigationGuardRef={guard} />));
    const modes = host.querySelector('[role="group"].sub-nav-tabs');
    assert(modes?.getAttribute('aria-label'), 'mode group has a name');
    assert(modes.querySelectorAll('[aria-pressed="true"]').length === 1, 'exactly one mode is pressed');
    assert(button(en['addCards.search']).getAttribute('aria-pressed') === 'true', 'search mode announced as selected');
    await change(host.querySelector('#search-card-name'), 'Sample');
    await act(async () => host.querySelector('#search-card-name').form.requestSubmit());
    await click(button(en['collection.select']));
    await click(card('Sample Alpha'));
    await click(card('Sample Beta'));
    for (const invalid of ['0', '', '1.5']) {
      await change(host.querySelector('#search-bulk-quantity'), invalid);
      await submit();
      assert(requests.length === 0, `quantity ${JSON.stringify(invalid)} cannot send a request`);
      assert(!host.querySelector('#search-bulk-quantity').checkValidity(), 'invalid quantity has native feedback');
    }
    await change(host.querySelector('#search-bulk-quantity'), '2');
    await act(async () => {
      bulkForm().requestSubmit();
      bulkForm().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert(requests.length === 1, 'same-turn duplicate submit sends only one mutation');
    assert(requests[0].quantity === 2 && requests[0].list_type === 'collection', 'request captures quantity and inventory');
    assert(host.querySelector('#search-bulk-quantity').matches(':disabled') && host.querySelector('#search-destination').matches(':disabled'), 'pending mutation owns draft and inventory');
    await click(card('Sample Alpha'));
    await click(button(en['addCards.slab']));
    assert(card('Sample Alpha').getAttribute('aria-pressed') === 'true', 'pending click cannot alter selection');
    assert(button(en['addCards.search']).getAttribute('aria-pressed') === 'true' && guard.current() === false, 'pending mode/navigation change blocked');
    await act(async () => settle({ added: 1, failed: [{ card_id: 'sample-b', error: 'Sample provider unavailable' }] }));
    assert(owned('Sample Alpha') === '6' && owned('Sample Beta') === '7', 'only successful Physical card increments badge');
    assert(card('Sample Alpha').getAttribute('aria-pressed') === 'false' && card('Sample Beta').getAttribute('aria-pressed') === 'true', 'partial success leaves only failed card selected');
    assert(host.querySelector('[role="alert"]').textContent.includes('Sample Beta: Sample provider unavailable'), 'per-card failure is visible and announced');
    assert(toasts.at(-1)[1] === 'error' && refreshes === 1, 'partial success is not reported as unconditional success');
    await submit();
    assert(requests.length === 2 && requests[1].card_ids.join() === 'sample-b', 'retry submits failed IDs only');
    await act(async () => settle({ added: 0, failed: [{ card_id: 'sample-b', error: 'Still unavailable' }] }, 500));
    assert(owned('Sample Beta') === '7' && card('Sample Beta').getAttribute('aria-pressed') === 'true', 'all-failed response retains retry selection and count');
    await submit();
    await act(async () => settle({ added: 1, failed: [] }));
    assert(owned('Sample Alpha') === '6' && owned('Sample Beta') === '9', 'retry adds failed card exactly once');
    assert(!host.querySelector('#search-bulk-quantity') && refreshes === 2, 'complete success exits selection');
    await change(host.querySelector('#search-destination'), 'arena');
    await click(button(en['collection.select']));
    await click(card('Sample Alpha'));
    await submit();
    assert(requests.at(-1).list_type === 'arena', 'Arena destination sent');
    await act(async () => settle({ added: 1, failed: [] }));
    assert(owned('Sample Alpha') === '6' && owned('Sample Beta') === '9', 'Arena addition leaves Physical badges unchanged');
    await click(button(en['addCards.slab']));
    assert(button(en['addCards.slab']).getAttribute('aria-pressed') === 'true' && button(en['addCards.search']).getAttribute('aria-pressed') === 'false', 'mode pressed semantics update after switching');
    tokenResults = [front, back];
    await click(button(en['addCards.search']));
    await change(host.querySelector('#search-card-name'), 'tokens');
    await act(async () => host.querySelector('#search-card-name').form.requestSubmit());
    const prompt = () => button(en['token.continueWithout'])?.closest('dialog');
    const promptButton = text => [...prompt().querySelectorAll('button')].find(node => node.textContent.trim() === text);
    const chooseReverse = async (id, popCount = 1) => {
      await click(promptButton(en['shared.search']));
      await change(prompt().querySelector('select[id$="-choice"]'), id);
      await closeOverlay(async () => promptButton(en['token.useReverse']).click(), popCount);
    };
    await click(button(en['collection.select']));
    await click(card(front.name));
    await click(card(back.name));
    const bulkCount = requests.length;
    const toastCount = toasts.length;
    const beforeTokenRefreshes = refreshes;
    await submit();
    assert(prompt() && requests.length === bulkCount, 'bulk token prompt opens before any mutation');
    await closeOverlay(async () => promptButton(en['token.continueWithout']).click());
    assert(prompt()?.textContent.includes(back.name) && requests.length === bulkCount, 'second token prompt still precedes every bulk write');
    await closeOverlay(async () => promptButton(en['common.cancel']).click());
    assert(requests.length === bulkCount && toasts.length === toastCount && refreshes === beforeTokenRefreshes, 'canceling a later bulk token writes nothing and reports no success');
    assert(card(front.name).getAttribute('aria-pressed') === 'true' && card(back.name).getAttribute('aria-pressed') === 'true', 'bulk cancel preserves the complete selection');
    await submit();
    await chooseReverse(back.id);
    await closeOverlay(async () => promptButton(en['token.continueWithout']).click());
    assert(requests.length === bulkCount + 1 && requests.at(-1).reverse_card_ids[front.id] === back.id && requests.at(-1).reverse_card_ids[back.id] === null, 'bulk sends individual reverse choices once');
    await act(async () => settle({ added: 2, failed: [] }));
    await change(host.querySelector('#search-default-container'), '7');

    await click(card(front.name));
    const quick = () => host.querySelector('.quick-add-modal');
    await change(quick().querySelector('input[id$="-quantity"]'), '3');
    const quickSubmit = () => quick().querySelector('button[value="collection"]');
    await act(async () => {
      quickSubmit().click();
      quick().querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert(prompt() && singleWrites.length === 0, 'Quick Add guards duplicate submits while awaiting reverse choice');
    const quickToasts = toasts.length;
    await closeOverlay(async () => promptButton(en['common.cancel']).click());
    assert(singleWrites.length === 0 && toasts.length === quickToasts && quick().querySelector('input[id$="-quantity"]').value === '3', 'Quick Add cancel retains the form without a write or success toast');
    await click(quickSubmit());
    await chooseReverse(back.id, 2);
    assert(singleWrites.length === 1 && singleWrites[0].reverse_card_id === back.id && singleWrites[0].quantity === 3 && singleWrites[0].location_id === 7 && !quick(), 'Quick Add saves the chosen pair, quantity and location once');

    await change(host.querySelector('#search-set-codes'), 'tst');
    await click(button(en['search.rapid']));
    await change(host.querySelector('#rapid-quantity'), '2');
    await change(host.querySelector('#rapid-card-number'), '1');
    const rapidSubmit = async () => act(async () => host.querySelector('#rapid-card-number').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await rapidSubmit();
    await rapidSubmit();
    const rapidToasts = toasts.length;
    await closeOverlay(async () => promptButton(en['common.cancel']).click());
    assert(singleWrites.length === 1 && toasts.length === rapidToasts && host.querySelector('#rapid-card-number').value === '1' && !host.querySelector('.lucide-undo-2'), 'Rapid Add cancel keeps input and creates neither write nor receipt');
    await rapidSubmit();
    await chooseReverse(back.id);
    assert(singleWrites.length === 2 && singleWrites[1].reverse_card_id === back.id && singleWrites[1].quantity === 2 && singleWrites[1].location_id === 7 && singleWrites[1].stackable === true && host.querySelector('#rapid-card-number').value === '', 'Rapid Add saves one paired stack with its quantity and location before clearing input');
    await click(card(front.name));
    await click([...quick().querySelectorAll('button')].find(node => node.textContent.trim() === en['shared.search']));
    await change(quick().querySelector('select[id$="-choice"]'), back.id);
    await closeOverlay(async () => quickSubmit().click());
    assert(!prompt() && singleWrites.length === 3 && singleWrites[2].reverse_card_id === back.id, 'an explicitly selected Quick Add reverse skips the prompt');
    await change(host.querySelector('#search-destination'), 'arena');
    await change(host.querySelector('#rapid-card-number'), '1');
    await rapidSubmit();
    assert(!prompt() && singleWrites.length === 4 && singleWrites[3].list_type === 'arena' && singleWrites[3].reverse_card_id === null, 'Arena token addition skips physical reverse prompting');
    assert(unexpected.length === 0, `no unmocked requests: ${unexpected.join(', ')}`);
    return { passed: ['bulk quantity native validation', 'pending duplicate and draft/navigation ownership', 'mixed success and failed-only retry', 'all-failed retry recovery', 'Arena preserves Physical badges', 'named mode group pressed state', 'bulk token cancellation before every write', 'per-card bulk reverse choices', 'Quick Add token cancel and paired write', 'Rapid Add token cancel and paired stack', 'already-selected reverse and Arena skip prompt'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
    window.history.replaceState(originalHistory, '', originalUrl);
  }
}
