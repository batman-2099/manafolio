import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SlabLookup from '../components/SlabLookup';
import CatalogPanel from '../components/CatalogPanel';
import { I18nProvider, useT } from './i18n';
import { useMultiSelect } from './useMultiSelect';
import en from '../locales/en.json';

// Automatically discovered by scripts/browser-tests.mjs; all requests stay in memory.
export async function runLookupStateRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const saved = { fetch: window.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    locale: localStorage.getItem('manafolio_ui_lang'), lang: document.documentElement.lang };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const notices = [];
  const requests = [];
  const pending = new Map();
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const settle = async (url, body = {}, status = 200) => act(async () => {
    assert(pending.has(url), `pending request exists: ${url}`);
    pending.get(url)(response(body, status));
    pending.delete(url);
  });
  const showToast = (...notice) => notices.push(notice);
  const button = key => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === en[key]);
  const click = async (...nodes) => act(async () => nodes.forEach(node => { assert(node, 'control exists'); node.click(); }));
  const render = async component => act(async () => root.render(component));
  const type = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const card = { id: 'slab-a', game: 'mtg', name: 'Printing A', set_name: 'Fixture', number: '1', image_url: '/logo.svg' };
  const slab = { game: 'mtg', cert: { grader: 'PSA', grade: 9, cert_number: '12345678', subject: 'Fixture slab' }, candidates: [card, { ...card, id: 'slab-b', name: 'Printing B' }] };
  const setsUrl = '/api/sets?game=mtg&lang=English&tree=1';
  const countsUrl = '/api/scan-sets?game=mtg&lang=English';
  const tree = [{ id: 'mtg-tst', name: 'Fixture set', children: [] }];
  let added = 0;
  let selection;
  let locale;
  function BulkFixture() {
    selection = useMultiSelect({ showToast });
    locale = useT();
    return null;
  }
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('manafolio_ui_lang', 'en');
    window.fetch = async (url, options = {}) => {
      url = String(url);
      if (url === '/api/card-art/index') return response({ ids: [] });
      if (url === '/api/admin/catalogs') return response({ catalogs: [{ game: 'mtg', lang: 'English', cached: 0 }] });
      if (url === '/api/admin/models') return response({});
      if (url === '/api/admin/catalogs/build') {
        requests.push({ url, body: JSON.parse(options.body) });
        return response({});
      }
      if (url.startsWith('/api/collection/cert/') || url === '/api/collection' || url === '/api/collection/bulk' || url === setsUrl || url === countsUrl) {
        requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
        return new Promise(resolve => pending.set(url, resolve));
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    };
    await render(<SlabLookup showToast={showToast} onAddSuccess={() => { added++; }} />);
    const certInput = host.querySelector('input');
    await act(async () => type(certInput, '12345678'));
    await act(async () => { submit(); submit(); });
    assert(requests.length === 1 && certInput.disabled && button('slab.looking').disabled, 'duplicate lookup is guarded synchronously and certificate is locked');
    await settle('/api/collection/cert/12345678', slab);
    let candidates = [...host.querySelectorAll('.slab-printings button')];
    await act(async () => {
      candidates[0].click();
      candidates[1].click();
      submit();
      type(certInput, '87654321');
    });
    assert(requests.length === 2 && requests[1].body.card_id === 'slab-a' && requests[1].body.cert_number === '12345678', 'pending add rejects alternative printing and new lookup, preserving exact certificate identity');
    assert(certInput.value === '12345678' && certInput.disabled && button('slab.lookUp').disabled && candidates.every(node => node.disabled), 'all conflicting controls and same-tick edits are locked');
    await settle('/api/collection', {}, 409);
    assert(added === 0 && certInput.value === '12345678' && candidates.every(node => !node.disabled), 'failed add retains certificate and candidates for retry');
    assert(notices.at(-1)[0] === en['slab.errAdd'], 'failed add exposes its fallback message');
    await click(candidates[1], candidates[0]);
    assert(requests.length === 3 && requests.at(-1).body.card_id === 'slab-b', 'retry can deliberately choose another printing, but submits only once');
    await settle('/api/collection');
    assert(added === 1 && certInput.value === '' && !host.querySelector('.slab-printings'), 'successful add clears only its locked certificate');
    await act(async () => type(certInput, '87654321'));
    await act(async () => submit());
    await settle('/api/collection/cert/87654321', { ...slab, cert: { ...slab.cert, cert_number: '87654321' } });
    assert(certInput.value === '87654321' && host.textContent.includes('87654321'), 'a new certificate can be looked up after completion');

    for (const failedUrl of [setsUrl, countsUrl]) {
      await render(<CatalogPanel key={failedUrl} showToast={showToast} />);
      await click(host.querySelector('summary'));
      await click(button('catalog.chooseSets'));
      assert(host.querySelector('[role="status"]')?.textContent === en['catalog.loadingSets'], 'catalog picker announces loading');
      await settle(failedUrl, {}, 503);
      await settle(failedUrl === setsUrl ? countsUrl : setsUrl, failedUrl === setsUrl ? { sets: {} } : tree);
      assert(host.querySelector('[role="alert"]')?.textContent.includes(en['catalog.errListSets']), `${failedUrl} HTTP failure is visible`);
      assert(!host.textContent.includes(en['scan.noSetMatches']) && !host.querySelector('input[type="checkbox"]'), 'failure is not presented as empty sets or missing counts');
      await click(button('common.retry'));
      await settle(setsUrl, tree);
      await settle(countsUrl, { sets: { tst: { cached: 5, embedded: 5 } } });
      assert(!host.querySelector('[role="alert"]') && host.textContent.includes('Fixture set'), 'retry restores set choices');
      await click(host.querySelector('input[type="checkbox"]'));
      const build = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === en['catalog.buildNSelected'].replace('{count}', '1'));
      assert(build && !build.disabled, 'recovered selection is buildable');
      await click(build);
      assert(requests.at(-1).url === '/api/admin/catalogs/build' && requests.at(-1).body.sets.join() === 'tst', 'retry uses exact selected set codes');
    }

    await render(<I18nProvider><BulkFixture /></I18nProvider>);
    act(() => locale.setLocale('de'));
    let de;
    await act(async () => { de = (await import('../locales/de.json')).default; });
    assert(locale.locale === 'de', 'German dictionary is published before bulk action');
    await act(async () => { await selection.runBulk('trade'); });
    assert(notices.at(-1)[0] === de['search.errNoneSelected'], 'empty-selection fallback uses active locale');
    await act(async () => selection.arm(7));
    let bulk;
    await act(async () => { bulk = selection.runBulk('trade'); });
    await settle('/api/collection/bulk', {}, 500);
    await bulk;
    assert(notices.at(-1)[0] === de['bulk.errAction'] && selection.selectedIds.has(7), 'localized HTTP fallback preserves retry selection');
    await act(async () => { bulk = selection.runBulk('trade'); });
    await act(async () => {
      pending.get('/api/collection/bulk')(Promise.reject(new Error('Fixture connection failure')));
      pending.delete('/api/collection/bulk');
      await bulk;
    });
    assert(notices.at(-1)[0] === de['bulk.errAction'] && selection.selectedIds.has(7), 'network fallback is localized and retains selection');
    await act(async () => { bulk = selection.runBulk('trade'); });
    await settle('/api/collection/bulk');
    await bulk;
    assert(notices.at(-1)[0] === de['bulk.done'] && selection.selectedIds.size === 0, 'success fallback uses active locale');
    return { passed: ['deferred slab lookup/add conflicts and retry', 'both catalog HTTP errors, retry and selected build', 'localized bulk fallbacks'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = saved.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
    if (saved.locale === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', saved.locale);
    document.documentElement.lang = saved.lang;
  }
}
