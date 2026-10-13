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
  const toasts = [];
  let refreshes = 0;
  let settle;
  const guard = { current: null };
  const response = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => '2' }, json: async () => body });
  const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="14"/%3E';
  window.fetch = async (url, options = {}) => {
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
    assert(unexpected.length === 0, 'no unmocked requests');
    return { passed: ['bulk quantity native validation', 'pending duplicate and draft/navigation ownership', 'mixed success and failed-only retry', 'all-failed retry recovery', 'Arena preserves Physical badges', 'named mode group pressed state'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
    window.history.replaceState(originalHistory, '', originalUrl);
  }
}
