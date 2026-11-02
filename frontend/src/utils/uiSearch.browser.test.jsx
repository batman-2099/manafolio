import { act } from 'react';
import { createRoot } from 'react-dom/client';
import AddCards from '../components/AddCards';
import MtgDeckImport from '../components/MtgDeckImport';
import en from '../locales/en.json';

// Run on an isolated Vite page; every fetch is mocked and no collection is touched.
// await (await import('/src/utils/uiSearch.browser.test.jsx')).runUiSearchRegressions()
export async function runUiSearchRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalConfirm = window.confirm;
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
  let lookupCount = 0;
  let tokenResults = null;
  let rapidPriceCard = null;
  let failRapidWrite = false;
  let failRapidLookup = false;
  let lastRapidNumber;
  let rapidPairResults = null;
  const rapidDeletes = [];
  const toasts = [];
  let refreshes = 0;
  let settle;
  const guard = { current: null };
  const response = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => '2' }, json: async () => body });
  const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="14"/%3E';
  const front = { id: 'mtg-front', name: 'Goblin', game: 'mtg', language: 'English', set_id: 'tst', set_name: 'Fixture tokens', number: '1', subtypes: ['Token'], image_url: image, price_normal: 2.5, price_holofoil: 5, price_currency: 'USD' };
  const back = { ...front, id: 'mtg-back', name: 'Soldier', number: '2' };
  const precon = { fileName: 'fixture-precon', name: 'Fixture precon', token_editions: [{ id: 'fixture-edition', label: 'Fixture edition' }] };
  const preconWrites = [];
  let preconTokens = [];
  let tokenLookups = 0;
  let tokenLookupPending = false;
  let tokenLookupFailure = false;
  let settleTokens;
  let settlePrecon;
  window.fetch = async (url, options = {}) => {
    if (String(url).startsWith('/api/mtg-decks?')) return response([precon, { ...precon, fileName: 'other-precon', name: 'Other precon' }]);
    if (String(url).startsWith(`/api/mtg-decks/${precon.fileName}/tokens?`)) {
      tokenLookups++;
      assert(new URL(String(url), location.origin).searchParams.get('token_edition') === 'fixture-edition', 'token preparation receives the selected edition');
      if (tokenLookupPending) return new Promise(resolve => { settleTokens = () => resolve(response({ cards: preconTokens })); });
      return tokenLookupFailure ? response({ error: 'Fixture token preparation failed' }, 502) : response({ cards: preconTokens });
    }
    if (url === `/api/mtg-decks/${precon.fileName}/import`) {
      preconWrites.push(JSON.parse(options.body));
      return new Promise(resolve => { settlePrecon = (body, status) => resolve(response(body, status)); });
    }
    if (String(url).startsWith('/api/search?')) lookupCount++;
    if (url === '/api/card-art/index') return response([]);
    if (url === '/api/collection' && options.method === 'POST') {
      if (failRapidWrite) return response({ error: 'Sample save failure' }, 500);
      singleWrites.push(JSON.parse(options.body));
      return response({ id: 100 + singleWrites.length });
    }
    if (/^\/api\/collection\/\d+$/.test(String(url)) && ['PUT', 'DELETE'].includes(options.method)) {
      if (options.method === 'DELETE' && !failRapidWrite) rapidDeletes.push(String(url));
      return response({}, failRapidWrite ? 500 : 200);
    }
    if (String(url).startsWith('/api/collection?')) return response([]);
    if (String(url).startsWith('/api/search?') && tokenResults) {
      const params = new URL(String(url), location.origin).searchParams;
      if (params.has('number')) {
        lastRapidNumber = params.get('number');
        if (failRapidLookup) return response({ error: 'Sample lookup failure' }, 503);
      }
      if (params.has('number') && rapidPairResults) {
        const result = rapidPairResults[params.get('number').replace(/^0+(?=\d)/, '')] ?? [];
        return result === 'failure' ? response({ error: 'Sample reverse lookup failure' }, 503) : response(result);
      }
      return response(params.get('prints') === '1' ? [front, back] : params.get('number') ? [rapidPriceCard || front] : tokenResults);
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
    assert([...quick().querySelectorAll('input, select')].every(control => control.matches(':disabled')), 'pending Quick Add disables all entry fields and its container');
    const quickToasts = toasts.length;
    await closeOverlay(async () => promptButton(en['common.cancel']).click());
    assert(singleWrites.length === 0 && toasts.length === quickToasts && quick().querySelector('input[id$="-quantity"]').value === '3', 'Quick Add cancel retains the form without a write or success toast');
    await click(quickSubmit());
    await chooseReverse(back.id, 2);
    assert(singleWrites.length === 1 && singleWrites[0].reverse_card_id === back.id && singleWrites[0].quantity === 3 && singleWrites[0].location_id === 7 && !quick(), 'Quick Add saves the chosen pair, quantity and location once');

    await change(host.querySelector('#search-set-codes'), 'tst');
    await click(button(en['search.rapid']));
    await change(host.querySelector('#rapid-card-number'), '1');
    const rapidSubmit = async () => act(async () => host.querySelector('#rapid-card-number').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const beforeInvalidLookup = lookupCount;
    for (const invalid of ['', '0', '-1', '1.5']) {
      await change(host.querySelector('#rapid-quantity'), invalid);
      await rapidSubmit();
      assert(lookupCount === beforeInvalidLookup && singleWrites.length === 1 && !prompt(), `invalid Rapid Add quantity ${JSON.stringify(invalid)} cannot look up or save a card`);
      assert(document.activeElement === host.querySelector('#rapid-quantity') && !host.querySelector('#rapid-quantity').checkValidity(), 'invalid Rapid Add quantity receives focus and native validation');
      assert(toasts.at(-1)[0] === en['search.errQuantity'] && toasts.at(-1)[1] === 'error', 'invalid Rapid Add quantity announces actionable feedback');
    }
    await change(host.querySelector('#rapid-quantity'), '2');
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
    await change(host.querySelector('#rapid-quantity'), '2');
    await change(host.querySelector('#rapid-card-number'), '1');
    await rapidSubmit();
    assert(!prompt() && singleWrites.length === 4 && singleWrites[3].list_type === 'arena' && singleWrites[3].reverse_card_id === null, 'Arena token addition skips physical reverse prompting');
    const sessionTotal = () => host.querySelector('.search-rapid [role="status"]').textContent;
    const receiptButton = label => [...host.querySelectorAll('.search-rapid button')].find(node => node.textContent.trim() === label);
    assert(sessionTotal().includes('$10.00') && host.querySelector('.search-rapid').textContent.includes('$2.50 ea'),
      'rapid receipts show the unit price and the session total includes quantities');
    await click(receiptButton(en['search.foil']));
    assert(sessionTotal().includes('$15.00'), 'successful foil change reprices all copies in that receipt');
    failRapidWrite = true;
    await click(receiptButton(en['search.foil']));
    await click(receiptButton(en['search.undo']));
    assert(sessionTotal().includes('$15.00'), 'failed finish changes and undo preserve session value');
    failRapidWrite = false;
    await click(receiptButton(en['search.undo']));
    assert(sessionTotal().includes('$5.00'), 'successful undo removes that receipt value');
    rapidPriceCard = { ...front, id: 'priced-sample', name: 'Priced sample', subtypes: [], price_normal: 1 };
    await change(host.querySelector('#rapid-quantity'), '1');
    for (let index = 0; index < 25; index++) {
      await change(host.querySelector('#rapid-card-number'), '1');
      await rapidSubmit();
    }
    assert(sessionTotal().includes('$30.00'), 'session total includes receipts older than the latest 25');
    rapidPriceCard = { ...rapidPriceCard, price_normal: 2, price_currency: 'EUR' };
    await change(host.querySelector('#rapid-card-number'), '1');
    await rapidSubmit();
    assert(sessionTotal().includes('$30.00 + €2.00') || sessionTotal().includes('€2.00 + $30.00'),
      'different currencies are subtotaled separately without conversion');
    rapidPriceCard = { ...rapidPriceCard, price_normal: null, price_trend: 99 };
    await change(host.querySelector('#rapid-card-number'), '1');
    await rapidSubmit();
    assert(sessionTotal().includes(en['search.sessionUnpriced']) && !sessionTotal().includes('99'),
      'missing finish quotes are excluded, not replaced by another finish’s trend');
    assert(host.querySelector('.search-rapid').textContent.includes(en['priceCheck.unavailable']), 'unpriced receipt is explicit');
    const totalBeforeFailure = sessionTotal();
    failRapidWrite = true;
    await change(host.querySelector('#rapid-card-number'), '1');
    await rapidSubmit();
    assert(sessionTotal() === totalBeforeFailure, 'failed additions do not change the session total');
    failRapidWrite = false;
    rapidPriceCard = { ...front, id: 'foil-shortcut', name: 'Foil shortcut', number: '123a', subtypes: [] };
    await change(host.querySelector('#rapid-quantity'), '2');
    const lookupsBeforeDot = lookupCount;
    await change(host.querySelector('#rapid-card-number'), '.');
    await rapidSubmit();
    assert(lookupCount === lookupsBeforeDot, 'a bare dot does not look up or add a card');
    await change(host.querySelector('#rapid-card-number'), '123a. ');
    await rapidSubmit();
    assert(lastRapidNumber === '123a' && singleWrites.at(-1).printing === 'Holofoil' && singleWrites.at(-1).quantity === 2,
      'a trailing dot selects foil for all copies and is stripped from the collector-number lookup');
    assert(receiptButton(en['search.foil']).getAttribute('aria-pressed') === 'true' && sessionTotal().includes('$40.00'),
      'foil shortcut is reflected in the receipt and running total');
    assert(host.querySelector('#rapid-printing').value === 'Normal', 'foil shortcut does not change the default finish');
    await change(host.querySelector('#rapid-card-number'), '123a');
    await rapidSubmit();
    assert(singleWrites.at(-1).printing === 'Normal', 'the next unsuffixed number uses the selected default finish');
    failRapidLookup = true;
    await change(host.querySelector('#rapid-card-number'), '123a.');
    await rapidSubmit();
    failRapidLookup = false;
    await change(host.querySelector('#rapid-card-number'), '999');
    await click(button(en['common.retry']));
    assert(lastRapidNumber === '123a' && singleWrites.at(-1).printing === 'Holofoil',
      'retry preserves the submitted collector number and foil choice');

    await change(host.querySelector('#search-destination'), 'collection');
    rapidPairResults = {
      '1': [front], '2': [back], '1a': [{ ...front, id: 'mtg-suffix', number: '1a' }],
      '3': [{ ...back, subtypes: [], set_name: 'Ordinary Set', number: '3' }],
      '4': [back, { ...back, id: 'ambiguous-back' }],
      '5': [{ ...front, number: '5' }], '6': [{ ...back, number: '6a' }],
    };
    const beforePairs = singleWrites.length;
    for (const invalid of ['1//', '//2', '1/2', '1///2', '1//2//3', '1//999', '999//2', '1//3', '3//2', '1//4', '4//2', '1//5', '1//6']) {
      await change(host.querySelector('#rapid-card-number'), invalid);
      await rapidSubmit();
      assert(singleWrites.length === beforePairs && !prompt() && host.querySelector('#rapid-card-number').value === invalid,
        `invalid or unresolved pair ${invalid} saves neither face and retains the input`);
      assert(toasts.at(-1)[1] === 'error', 'invalid pair gives error feedback');
    }
    await change(host.querySelector('#search-destination'), 'arena');
    await change(host.querySelector('#rapid-card-number'), '1//2');
    await rapidSubmit();
    assert(singleWrites.length === beforePairs, 'Arena cannot silently discard an explicit reverse');
    await change(host.querySelector('#search-destination'), 'collection');
    rapidPairResults['2'] = 'failure';
    await change(host.querySelector('#rapid-card-number'), '001 // 002.');
    await rapidSubmit();
    assert(singleWrites.length === beforePairs && host.querySelector('[role="alert"]'), 'reverse lookup failure saves neither face and offers retry');
    rapidPairResults['2'] = [back];
    await change(host.querySelector('#rapid-card-number'), '999');
    await click(button(en['common.retry']));
    assert(singleWrites.length === beforePairs + 1 && !prompt(), 'retry resolves the original pair without asking for its reverse again');
    assert(singleWrites.at(-1).card_id === front.id && singleWrites.at(-1).reverse_card_id === back.id
      && singleWrites.at(-1).quantity === 2 && singleWrites.at(-1).stackable && singleWrites.at(-1).printing === 'Holofoil',
    'padded pair with foil shortcut saves one physical stack with both faces and the chosen quantity');
    assert(host.querySelector('.search-rapid').textContent.includes('#1//2 Goblin // Soldier'), 'receipt identifies both token faces');
    const pairedEntry = 100 + singleWrites.length;
    await click(receiptButton(en['search.undo']));
    assert(rapidDeletes.at(-1) === `/api/collection/${pairedEntry}` && !host.querySelector('.search-rapid').textContent.includes('#1//2'),
      'Undo deletes the paired physical entry and removes its receipt');
    failRapidWrite = true;
    await change(host.querySelector('#rapid-card-number'), '1a//2');
    await rapidSubmit();
    assert(singleWrites.length === beforePairs + 1 && host.querySelector('#rapid-card-number').value === '1a//2', 'failed paired save preserves the input');
    failRapidWrite = false;
    await act(async () => {
      const input = host.querySelector('#rapid-card-number');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert(singleWrites.length === beforePairs + 2 && singleWrites.at(-1).card_id === 'mtg-suffix'
      && singleWrites.at(-1).reverse_card_id === back.id && singleWrites.at(-1).printing === 'Normal',
    'suffixes remain distinct and repeated Enter saves the pair only once');
    rapidPairResults = null;

    window.confirm = () => true;
    await click(button(en['addCards.deck']));
    await change(host.querySelector('input[type="search"]'), 'Fixture');
    await click(button(en['mtgDeck.search']));
    await change(host.querySelector('select'), 'fixture-edition');
    const verified = { ...front, id: 'mtg-verified', reverse_card_id: back.id };
    const native = { ...front, id: 'mtg-native', image_url_back: image };
    preconTokens = [verified, native, front, front, back];
    tokenLookupPending = true;
    const addPrecon = button(en['mtgDeck.add']);
    await act(async () => { addPrecon.click(); addPrecon.click(); });
    assert(tokenLookups === 1 && preconWrites.length === 0 && !prompt(), 'same-turn precon submits prepare tokens once before any write');
    assert([...host.querySelectorAll('input, select')].every(control => control.disabled), 'precon preparation locks search and import options');
    assert([...host.querySelectorAll('button')].filter(node => node.textContent.trim() === en['mtgDeck.add']).every(node => node.disabled), 'another precon cannot import during preparation');
    await click(button(en['addCards.slab']));
    assert(button(en['addCards.deck']).getAttribute('aria-pressed') === 'true' && guard.current() === false, 'precon preparation blocks mode and application navigation');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    assert(unload.defaultPrevented, 'precon preparation protects browser unload');
    await act(async () => settleTokens());
    tokenLookupPending = false;
    assert(prompt()?.textContent.includes(front.name), 'verified and native reverse sides bypass review');
    const beforePreconRefreshes = refreshes;
    await closeOverlay(async () => promptButton(en['token.continueWithout']).click());
    assert(prompt()?.textContent.includes(back.name) && preconWrites.length === 0, 'duplicate fronts share one decision and all review precedes writes');
    await closeOverlay(async () => promptButton(en['common.cancel']).click());
    assert(preconWrites.length === 0 && refreshes === beforePreconRefreshes && guard.current() === true && !button(en['mtgDeck.add']).disabled, 'later precon cancellation writes nothing and restores controls/navigation');
    assert(document.activeElement === addPrecon, 'cancelled precon review restores focus to its enabled Add deck trigger');

    await click(button(en['mtgDeck.add']));
    await chooseReverse(back.id);
    await closeOverlay(async () => promptButton(en['token.continueWithout']).click());
    const preconBody = preconWrites[0];
    assert(preconWrites.length === 1 && preconBody.reverse_card_ids[front.id] === back.id && preconBody.reverse_card_ids[back.id] === null, 'precon import submits the selected reverse and explicit skip');
    assert(Object.keys(preconBody.reverse_card_ids).length === 2 && preconBody.token_edition === 'fixture-edition' && preconBody.create_container && preconBody.create_deck, 'known faces are not overridden and existing import options survive');
    await click(button(en['mtgDeck.adding']));
    assert(preconWrites.length === 1 && guard.current() === false, 'in-flight precon write prevents duplicate submission and navigation');
    await act(async () => settlePrecon({ error: 'Fixture import failed' }, 500));
    assert(toasts.at(-1)[0] === 'Fixture import failed' && guard.current() === true && !button(en['mtgDeck.add']).disabled, 'import failure restores retry controls and announces the error');
    await click(button(en['mtgDeck.add']));
    assert(!prompt() && preconWrites.length === 2 && JSON.stringify(preconWrites[1]) === JSON.stringify(preconBody), 'failed import retry retains completed reverse decisions');
    await act(async () => settlePrecon({ added: 5 }));
    assert(refreshes === beforePreconRefreshes + 1 && guard.current() === true, 'successful precon import refreshes once and releases navigation');

    tokenLookupFailure = true;
    await click(button(en['mtgDeck.add']));
    assert(preconWrites.length === 2 && toasts.at(-1)[0] === 'Fixture token preparation failed' && guard.current() === true, 'token resolution failure never writes and permits retry');
    tokenLookupFailure = false;
    preconTokens = [verified, native];
    await click(button(en['mtgDeck.add']));
    assert(!prompt() && preconWrites.length === 3 && !Object.hasOwn(preconWrites[2], 'reverse_card_ids'), 'known-only import skips review and omits manual overrides');
    await act(async () => settlePrecon({ added: 2 }));
    let chosen = null;
    const beforeChooseLookups = tokenLookups;
    await act(async () => root.render(<MtgDeckImport onChoose={deck => { chosen = deck; }} />));
    await change(host.querySelector('input[type="search"]'), 'Fixture');
    await click(button(en['mtgDeck.search']));
    window.confirm = () => { throw new Error('Choosing a definition must not confirm an inventory import'); };
    await click(button(en['mtgDeck.choose']));
    assert(chosen?.fileName === precon.fileName && tokenLookups === beforeChooseLookups && preconWrites.length === 3 && !prompt(), 'deck-definition selection does not prepare tokens or write inventory');
    assert(unexpected.length === 0, `no unmocked requests: ${unexpected.join(', ')}`);
    return { passed: ['bulk quantity native validation', 'pending duplicate and draft/navigation ownership', 'mixed success and failed-only retry', 'all-failed retry recovery', 'Arena preserves Physical badges', 'named mode group pressed state', 'bulk token cancellation before every write', 'per-card bulk reverse choices', 'Quick Add token cancel and paired write', 'Rapid Add token cancel and paired stack', 'already-selected reverse and Arena skip prompt', 'precon sequential choice/skip/cancel without writes', 'precon native/verified bypass', 'precon preparation and import duplicate/navigation guards', 'precon preparation/import recovery and retained choices', 'precon definition-only selection'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = originalFetch;
    window.confirm = originalConfirm;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
    window.history.replaceState(originalHistory, '', originalUrl);
  }
}

export async function runPreconRequestOwnershipRegressions() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const saved = { fetch: window.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const requests = [];
  const toasts = [];
  const decks = [{ fileName: 'first', name: 'First deck' }, { fileName: 'second', name: 'Second deck' }];
  window.fetch = (url, options = {}) => new Promise(resolve => {
    requests.push({ url, signal: options.signal, resolve: (body, status = 200) => resolve({ ok: status < 300, json: async () => body }) });
  });
  const change = value => act(async () => {
    const input = host.querySelector('input[type="search"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const enter = () => act(async () => host.querySelector('input[type="search"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const search = () => host.querySelector('.mtg-deck-import > div:nth-of-type(2) button');
  const detailButton = index => host.querySelectorAll('.mtg-deck-import-result')[index].querySelector('button');
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(<MtgDeckImport showToast={(...args) => toasts.push(args)} />));
    await change('first');
    await act(async () => search().click());
    await change('second');
    assert(requests[0].signal.aborted, 'editing a query cancels its previous request immediately');
    await enter();
    await act(async () => requests[1].resolve(decks));
    await act(async () => requests[0].resolve([{ fileName: 'stale', name: 'Stale result' }]));
    assert(host.textContent.includes('Second deck') && !host.textContent.includes('Stale result'), 'old search cannot replace latest keyboard search results');

    await enter();
    await enter();
    assert(requests[2].signal.aborted && search().disabled, 'repeated Enter shares request ownership and keeps latest search busy');
    await act(async () => requests[2].resolve({ error: 'Stale search error' }, 500));
    assert(search().disabled && !toasts.length, 'old search errors and finally cannot clear latest loading state');
    await act(async () => requests[3].resolve(decks));
    await act(async () => detailButton(0).click());
    await act(async () => detailButton(1).click());
    assert(requests[4].signal.aborted, 'latest details selection cancels previous details');
    await act(async () => requests[5].resolve({ creatures: [{ name: 'Latest creature', count: 1 }] }));
    await act(async () => requests[4].resolve({ creatures: [{ name: 'Stale creature', count: 1 }] }));
    assert(host.textContent.includes('Latest creature') && !host.textContent.includes('Stale creature'), 'deferred details cannot overwrite latest selection');

    await act(async () => detailButton(0).click());
    await change('replacement');
    assert(requests[6].signal.aborted && !host.querySelector('.mtg-deck-import-result'), 'query editing cancels details and clears mismatched results');
    await act(async () => requests[6].resolve({ error: 'Stale details error' }, 500));
    assert(!toasts.length, 'query-cancelled details cannot announce stale errors');
    await enter();
    await act(async () => root.render(null));
    assert(requests[7].signal.aborted, 'unmount cancels pending search');
    await act(async () => requests[7].resolve({ error: 'Unmounted search error' }, 500));
    assert(!toasts.length, 'unmounted search cannot publish a notification');

    await act(async () => root.render(<MtgDeckImport showToast={(...args) => toasts.push(args)} />));
    await change('details');
    await enter();
    await act(async () => requests[8].resolve(decks));
    await act(async () => detailButton(0).click());
    await act(async () => root.render(null));
    assert(requests[9].signal.aborted, 'unmount cancels pending details');
    await act(async () => requests[9].resolve({ error: 'Unmounted details error' }, 500));
    assert(!toasts.length, 'unmounted details cannot publish a notification');
    return { passed: ['latest keyboard/button search wins', 'stale search preserves loading/error ownership', 'latest details wins', 'query change cancels details', 'unmount cancels both request types'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = saved.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
  }
}
