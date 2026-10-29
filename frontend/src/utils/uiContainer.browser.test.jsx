import { act } from 'react';
import { createRoot } from 'react-dom/client';
import CreateContainerModal from '../components/CreateContainerModal';
import SetupWizard from '../components/SetupWizard';
import LocationManager from '../components/LocationManager';
import en from '../locales/en.json';

// Run on an isolated Vite page; every request is mocked, never a real database.
// await (await import('/src/utils/uiContainer.browser.test.jsx')).runUiContainerRegressions()
export async function runUiContainerRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalConfirm = window.confirm;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalState = history.state;
  const originalUrl = location.href;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cases = [];
  const requests = [];
  let settle;
  let closes = 0;
  let cards = [];
  let locations = [1, 2].map(id => ({ id, name: `Binder ${id}`, type: 'Binder', compartment_count: 1, total_cards: 0, total_capacity: 9 }));
  locations.push({ id: 3, name: 'Token box', type: 'Deck Box', sort_order: 'custom', compartment_count: 1, total_cards: 0, occupied_slots: 2, total_capacity: 1 });
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  window.fetch = async (url, options = {}) => {
    if (options.method && options.method !== 'GET') {
      requests.push({ url, method: options.method, body: JSON.parse(options.body || '{}') });
      return new Promise(resolve => { settle = (status = 200) => {
        if (status < 400 && options.method === 'PUT' && String(url).startsWith('/api/locations/')) {
          locations = locations.map(row => row.id === Number(String(url).split('/').at(-1)) ? { ...row, ...JSON.parse(options.body) } : row);
        }
        resolve(response({ error: 'Fixture failure' }, status));
      }; });
    }
    if (url === '/api/admin/models') return response({ models: [], catalogs: [] });
    if (url === '/api/admin/catalogs') return response({ catalogs: [] });
    if (url === '/api/locations' || url === '/api/locations?inventory_type=collection') return response(locations);
    if (url === '/api/collection?list_type=collection') return response(cards);
    if (['/api/storage-units', '/api/sets', '/api/decks'].includes(url)) return response([]);
    if (url === '/api/card-art/index') return response({});
    if (url === '/api/locations/3/compartments') return response([{ id: 30, location_id: 3, idx: 1, display_label: 'Token row', capacity: 1, count: locations[2].occupied_slots, capacity_count: locations[2].total_cards }]);
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const button = key => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === en[key]);
  const click = async key => { const node = button(key); assert(node, `Missing ${key}`); await act(async () => node.click()); };
  const change = async (selector, value) => {
    const node = host.querySelector(selector);
    assert(node && !node.matches(':disabled'), `Editable field expected: ${selector}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const clear = async () => {
    await act(async () => root.render(null));
    // Let useBackGuard's programmatic pop finish before mounting another overlay.
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  const cancelDialog = () => host.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
  const back = async () => {
    await act(async () => {
      await new Promise(resolve => {
        window.addEventListener('popstate', resolve, { once: true });
        history.back();
      });
    });
  };
  try {
    await act(async () => root.render(<CreateContainerModal onClose={() => { closes++; }} onCreate={async payload => {
      const result = await fetch('/api/locations', { method: 'POST', body: JSON.stringify(payload) });
      if (!result.ok) throw new Error('Fixture failure');
    }} />));
    await click('common.next');
    assert(document.activeElement.id === 'create-container-title', 'layout heading receives focus');
    assert(host.querySelector('[aria-current="step"]')?.textContent.includes(en['container.step.layout']), 'layout is announced as current');
    await change('#create-container-name', 'Draft binder');
    for (const selector of ['#create-container-count', '#create-container-capacity']) {
      for (const value of ['', '0', '-1', '1.5']) {
        await change(selector, value);
        await click('common.next');
        assert(host.querySelector('#container-layout-form'), `${selector}=${value} must stay on layout`);
        // requestSubmit exercises the native submission path used by Enter;
        // synthetic keyboard events alone cannot invoke browser default actions.
        await act(async () => host.querySelector('#container-layout-form').requestSubmit());
        assert(host.querySelector('#container-layout-form') && requests.length === 0, 'native submit must reject invalid counts without coercion');
      }
      await change(selector, '3');
    }
    await change('#create-container-name', '   ');
    await act(async () => host.querySelector('#container-layout-form').requestSubmit());
    assert(host.querySelector('#container-layout-form'), 'whitespace-only name is invalid');
    await change('#create-container-name', 'Draft binder');
    await act(async () => host.querySelector('#container-layout-form').requestSubmit());
    assert(!host.querySelector('#container-layout-form') && document.activeElement.id === 'create-container-title', 'valid native submit advances and focuses heading');
    await click('common.next');
    const filing = host.querySelector('#container-filing-form');
    await act(async () => {
      filing.requestSubmit();
      filing.requestSubmit();
      cancelDialog();
      button('common.back').click();
      host.querySelector('button[aria-label="Close"]').click();
    });
    assert(requests.length === 1 && closes === 0, 'same-tick submission locks duplicate, Escape, close and Back');
    assert([...filing.querySelectorAll('input, select, button')].every(node => node.matches(':disabled')), 'filing inputs are frozen');
    await back();
    await back();
    assert(closes === 0 && host.querySelector('#container-filing-form'), 'repeated browser Back stays blocked while creating');
    await act(async () => settle(500));
    assert(host.querySelector('[role="alert"]') && !button('common.back').disabled, 'create failure is announced and releases navigation');
    await click('common.back');
    await click('common.back');
    assert(host.querySelector('#create-container-name').value === 'Draft binder' && host.querySelector('#create-container-count').value === '3', 'failed create retains draft');
    await click('common.next');
    await click('common.next');
    await click('container.create');
    assert(requests.length === 2 && requests[1].body.compartmentPlan.count === 3, 'retry sends exact positive integer without coercion');
    await act(async () => settle());
    cases.push('layout native validation/Enter submit, step focus and current announcement', 'create same-tick/pending close/Escape/Back lock, failure draft and retry');
    await clear();

    requests.length = 0;
    await act(async () => root.render(<SetupWizard onClose={() => { closes++; }} />));
    await click('common.next');
    await click('common.next');
    assert(document.activeElement.id === 'setup-step-title', 'setup storage heading receives focus');
    let deleteWarning;
    window.confirm = message => { deleteWarning = message; return false; };
    await act(async () => host.querySelector('button[aria-label="Delete Token box"]').click());
    assert(deleteWarning === en['setup.storage.confirmDeleteCards.other'].replace('{name}', 'Token box').replace('{count}', '2'), 'token-only box deletion warns about occupied slots');
    assert(requests.length === 0, 'cancelled deletion leaves stored tokens untouched');
    cases.push('token-only setup deletion warning');
    await change('#setup-location-name', 'New binder');
    await act(async () => { button('setup.storage.add').click(); button('setup.storage.add').click(); });
    assert(requests.length === 1 && host.querySelector('#setup-location-name').matches(':disabled'), 'setup add owns draft and rejects same-tick duplicate');
    assert(button('common.next').disabled && host.querySelector('[role="status"]'), 'pending setup exposes status and disables navigation');
    await act(async () => settle(500));
    assert(host.querySelector('#setup-location-name').value === 'New binder' && host.querySelector('[role="alert"]'), 'setup add failure retains draft');
    await click('setup.storage.add');
    await act(async () => settle());
    assert(host.querySelector('#setup-location-name').value === '', 'successful add clears its submitted draft');
    await act(async () => host.querySelector('button[aria-label="Rename Binder 1"]').click());
    await change('input[aria-label="Rename Binder 1"]', 'Renamed binder');
    await act(async () => {
      button('common.save').click();
      host.querySelector('button[aria-label="Rename Binder 2"]').click();
      button('common.save').click();
      button('common.cancel').click();
    });
    assert(requests.length === 3 && requests.at(-1).url === '/api/locations/1', 'rename is single-flight and cannot switch ownership');
    assert(host.querySelector('input[aria-label="Rename Binder 1"]').matches(':disabled'), 'pending rename keeps correct editor frozen');
    await act(async () => settle(500));
    assert(host.querySelector('input[aria-label="Rename Binder 1"]').value === 'Renamed binder', 'rename failure retains correct draft');
    await click('common.save');
    await act(async () => settle());
    assert(host.querySelector('button[aria-label="Rename Renamed binder"]'), 'rename retry updates the intended row');
    cases.push('setup add/rename duplicate lock, disabled controls, correct editor and failure recovery');

    const closesBeforeFinish = closes;
    await act(async () => { button('setup.skip').click(); button('setup.skip').click(); cancelDialog(); });
    await back();
    assert(closes === closesBeforeFinish && requests.filter(r => r.url === '/api/settings').length === 1, 'setup completion is single-flight and blocks dismissal');
    await clear();
    await act(async () => root.render(<SetupWizard onClose={() => { closes++; }} />));
    await act(async () => settle());
    assert(closes === closesBeforeFinish && host.querySelector('dialog[open]'), 'old completion cannot close a new wizard instance');
    cases.push('setup pending completion close/history lock and stale-instance isolation');
    await clear();
    await act(async () => root.render(<LocationManager onUpdate={() => {}} showToast={() => {}} />));
    const tokenBox = [...host.querySelectorAll('button')].find(node => node.textContent.includes('Token box'));
    assert(tokenBox?.querySelector('.storage-card-quantity strong')?.textContent === '0', 'deck box badge excludes tokens');
    assert(!tokenBox.querySelector('.storage-capacity-warning'), 'gallery does not warn for token-only occupancy');
    await act(async () => tokenBox.click());
    assert(button('collection.select') && !button('collection.select').disabled, 'token-only box keeps selection enabled');
    assert(!host.querySelector('.storage-capacity-warning'), 'token-only row does not warn');
    assert(host.querySelector('option[value="30"]').textContent === 'Token row', 'token-only row dropdown does not warn');
    await click('nav.more');
    const resort = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === 'Re-sort Container');
    assert(resort && !resort.disabled, 'token-only box keeps re-sort enabled');
    await click('loc.containerSettings');
    assert(host.querySelector('#container-settings-title') && host.textContent.includes('0 / 1'), 'settings capacity excludes tokens');
    assert(!host.querySelector('.storage-capacity-warning'), 'settings does not warn for token-only occupancy');
    const settingsPanel = host.querySelector('#container-settings-title').closest('form');
    const expand = settingsPanel.querySelector('.container-settings-expand input');
    const compactWidth = settingsPanel.getBoundingClientRect().width;
    await act(async () => expand.click());
    const expandedWidth = settingsPanel.getBoundingClientRect().width;
    assert(innerWidth > 768 ? expandedWidth > compactWidth : expandedWidth === compactWidth, 'settings expansion is desktop-only');
    settingsPanel.scrollTop = settingsPanel.scrollHeight;
    assert(expandedWidth <= innerWidth && button('admin.saveSettings').getBoundingClientRect().bottom <= settingsPanel.getBoundingClientRect().bottom, 'expanded settings stay within the viewport and keep Save reachable');
    await act(async () => expand.click());
    assert(settingsPanel.getBoundingClientRect().width === compactWidth, 'settings can return to their original width');
    cases.push('desktop settings expansion, viewport bounds and restore');
    await back();
    assert(!host.querySelector('#container-settings-title') && button('collection.select'), 'Back closes container settings before leaving its workspace');
    await back();
    assert(button('loc.createContainer') && !host.querySelector('.storage-workspace-identity'), 'Back from an opened container returns to the gallery');
    await act(async () => [...host.querySelectorAll('button')].find(node => node.textContent.includes('Token box')).click());
    await act(async () => host.querySelector(`button[aria-label="${en['nav.storage']}"]`).click());
    await new Promise(resolve => setTimeout(resolve, 40));
    assert(button('loc.createContainer'), 'the explicit Storage button returns to the same gallery state');
    cases.push('storage Back unwinds settings then workspace and matches the gallery button');
    await clear();
    locations[2] = { ...locations[2], total_cards: 2, occupied_slots: 4 };
    await act(async () => root.render(<LocationManager onUpdate={() => {}} showToast={() => {}} />));
    const overfullBox = [...host.querySelectorAll('button')].find(node => node.textContent.includes('Token box'));
    const overLimit = en['loc.overLimit'].replace('{used}', '2').replace('{capacity}', '1');
    assert(overfullBox.querySelector('.storage-capacity-warning')?.textContent === overLimit, 'gallery warns for excess non-token cards only');
    await act(async () => overfullBox.click());
    assert(host.querySelector('.storage-capacity-warning')?.textContent === overLimit, 'row warns for excess non-token cards only');
    assert(host.querySelector('option[value="30"]').textContent.includes(overLimit), 'row dropdown warns for excess non-token cards only');
    await click('nav.more');
    await click('loc.containerSettings');
    assert(host.querySelector('#container-settings-title') && host.textContent.includes('2 / 1'), 'settings capacity counts non-token cards only');
    const settingsWarnings = host.querySelectorAll('.storage-capacity-warning');
    assert(settingsWarnings.length > 0 && [...settingsWarnings].every(node => node.textContent === overLimit), 'settings warns for excess non-token cards only');
    cases.push('deck box token-excluding capacity, real overflow and token-only actions');
    await clear();
    cards = [
      { entry_id: 1, card_id: 'sample-spell', name: 'Sample spell', set_name: 'Sample Set' },
      { entry_id: 2, card_id: 'sample-token', name: 'Goblin', subtypes: ['Token'], set_name: 'Sample Set', reverse_name: 'Soldier', reverse_card_id: 'sample-reverse' },
      { entry_id: 3, card_id: 'sample-set-token', name: 'Treasure', set_name: 'Sample Tokens' },
      { entry_id: 4, card_id: 'sample-token', name: 'Goblin', subtypes: ['Token'], set_name: 'Sample Set', reverse_name: 'Soldier', reverse_card_id: 'sample-reverse' },
    ].map(card => ({ ...card, id: card.card_id, game: 'mtg', location_id: 3, compartment_id: 30, position: card.entry_id * 1000, quantity: 1 }));
    await act(async () => root.render(<LocationManager onUpdate={() => {}} showToast={() => {}} />));
    await act(async () => [...host.querySelectorAll('button')].find(node => node.textContent.includes('Token box')).click());
    await act(async () => host.querySelector(`button[title="${en['loc.detailView']}"]`).click());
    const tokenSection = () => host.querySelector(`section[aria-label="${en['tokens.title']}"]`);
    assert(tokenSection()?.querySelectorAll('button').length === 2, 'typed and token-set cards share a separate section, with duplicate pairs stacked');
    assert(!tokenSection().textContent.includes('Sample spell') && tokenSection().previousElementSibling.textContent.includes('Sample spell'), 'ordinary cards precede the token section');
    const tokenButtons = tokenSection().querySelectorAll('button');
    const pairedImages = tokenButtons[0].querySelectorAll('img');
    assert(pairedImages.length === 2 && pairedImages[0].alt === 'Goblin' && pairedImages[1].alt === 'Soldier', 'paired token displays its front and reverse together in order');
    assert(tokenButtons[1].querySelectorAll('img').length === 1, 'unpaired token keeps one image');
    const searchSelector = `input[aria-label="${en['shared.search']}"]`;
    await change(searchSelector, 'Soldier');
    assert(tokenSection()?.querySelectorAll('button').length === 1 && tokenSection().textContent.includes('Goblin'), 'reverse-face search retains the paired token in its section');
    await change(searchSelector, 'Sample spell');
    assert(!tokenSection(), 'no empty token section appears when filters exclude tokens');
    await change(searchSelector, '');
    await act(async () => {
      const sort = host.querySelector(`select[aria-label="${en['collection.sortBy']}"]`);
      sort.value = 'name-asc';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert(tokenSection()?.querySelectorAll('button').length === 2, 'sorting keeps one separate token section');
    await click('collection.select');
    assert(tokenSection().querySelectorAll('button').length === 3, 'selection exposes every stored token entry rather than ambiguous stacks');
    await act(async () => tokenSection().querySelector('img[alt="Soldier"]').click());
    assert(host.textContent.includes('1 selected') && !button('loc.removeFromStorage').disabled, 'tokens remain selectable for existing container actions');
    await act(async () => tokenSection().querySelector('img[alt="Goblin"]').click());
    assert(host.textContent.includes('0 selected') && button('loc.removeFromStorage').disabled, 'both token faces toggle the same owned entry');
    cases.push('separate token gallery preserves classification, pairing, stacking, filtering, sorting and selection');
    await clear();
    cards = [{ ...cards[0], card_id: 'sample-incubator', name: 'Incubator', set_name: 'Sample Tokens',
      image_url: '/logo.svg?native-front', image_url_back: '/logo.svg?native-back', name_back: 'Phyrexian' }];
    await act(async () => root.render(<LocationManager onUpdate={() => {}} showToast={() => {}} />));
    await act(async () => [...host.querySelectorAll('button')].find(node => node.textContent.includes('Token box')).click());
    const nativeImages = tokenSection()?.querySelectorAll('img');
    assert(nativeImages?.length === 2 && nativeImages[1].alt === 'Phyrexian'
      && nativeImages[1].getAttribute('src') === '/logo.svg?native-back', 'native double-faced token renders both artworks without creating a second owned entry');
    cases.push('native token reverse artwork in container gallery');
    return { passed: cases.length, cases };
  } finally {
    await act(async () => root.unmount());
    await new Promise(resolve => setTimeout(resolve, 40));
    host.remove();
    history.replaceState(originalState, '', originalUrl);
    window.fetch = originalFetch;
    window.confirm = originalConfirm;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
}
