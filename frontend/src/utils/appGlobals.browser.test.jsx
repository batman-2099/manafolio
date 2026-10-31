import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useT } from './i18n';
import en from '../locales/en.json';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

// Run on the isolated browser-test page, never on an authenticated app page.
export async function runFetchAvailabilityRegressions() {
  const savedFetch = window.fetch;
  const savedToken = localStorage.getItem('manafolio_token');
  const events = [];
  const record = event => events.push(event.type);
  const names = ['manafolio_server_unavailable', 'manafolio_server_available', 'manafolio_logout'];
  let respond;
  window.fetch = () => new Promise((resolve, reject) => { respond = { resolve, reject }; });
  names.forEach(name => window.addEventListener(name, record));
  try {
    await import('../App');
    localStorage.setItem('manafolio_token', 'session-one');
    const request = async (result, reject = false) => {
      const pending = window.fetch('/api/collection');
      if (reject) respond.reject(result); else respond.resolve(result);
      try { return await pending; }
      catch (error) { assert(error === result, 'interceptor preserves the original rejection'); }
    };
    await request(new DOMException('Canceled', 'AbortError'), true);
    assert(events.length === 0, 'intentional abort is not an outage');
    await request(new TypeError('Network failed'), true);
    assert(events.join() === 'manafolio_server_unavailable', 'network failure marks outage');
    events.length = 0;
    await request({ status: 503, ok: false });
    await request({ status: 400, ok: false });
    assert(events.join() === 'manafolio_server_unavailable', 'server errors mark outage; client errors do not recover it');
    await request({ status: 200, ok: true });
    assert(events.at(-1) === 'manafolio_server_available', 'successful current-session API response recovers outage');
    for (const result of [{ status: 200, ok: true }, { status: 503, ok: false }, { status: 401, ok: false }, new TypeError('Late failure')]) {
      events.length = 0;
      localStorage.setItem('manafolio_token', 'session-one');
      const pending = window.fetch('/api/collection').catch(error => error);
      localStorage.setItem('manafolio_token', 'session-two');
      if (result instanceof Error) respond.reject(result); else respond.resolve(result);
      await pending;
      assert(events.length === 0, 'stale-session completion cannot alter availability or log out a new session');
    }
    localStorage.removeItem('manafolio_token');
    events.length = 0;
    await request({ status: 200, ok: true });
    assert(events.length === 0, 'anonymous completion does not recover an authenticated session');
    return { passed: ['abort', 'network/5xx outage', 'successful recovery', 'client-error non-recovery', 'stale-session isolation'] };
  } finally {
    names.forEach(name => window.removeEventListener(name, record));
    window.fetch = savedFetch;
    if (savedToken === null) localStorage.removeItem('manafolio_token'); else localStorage.setItem('manafolio_token', savedToken);
  }
}

export async function runLocalePublicationRegressions() {
  const saved = { locale: localStorage.getItem('manafolio_ui_lang'), lang: document.documentElement.lang, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current;
  let mounts = 0;
  const renders = [];
  function Probe() {
    current = useT();
    renders.push([current.locale, current.t('common.cancel')]);
    useEffect(() => { mounts++; }, []);
    return <><span>{current.t('common.cancel')}</span><input aria-label="Unsaved draft" defaultValue="draft" /></>;
  }
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('manafolio_ui_lang', 'en');
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
    const input = host.querySelector('input');
    input.value = 'unsaved edits';
    act(() => current.setLocale('de'));
    assert(current.locale === 'en' && host.textContent === 'Cancel' && document.documentElement.lang === 'en', 'pending dictionary retains the previously published locale, labels and document language');
    assert(input.isConnected && input.value === 'unsaved edits', 'pending locale does not unmount the app');
    await act(async () => { await import('../locales/de.json'); });
    assert(current.locale === 'de' && host.textContent === 'Abbrechen' && document.documentElement.lang === 'de', 'loaded locale and dictionary publish together');
    act(() => current.setLocale('fr'));
    assert(current.locale === 'de' && host.textContent === 'Abbrechen', 'second pending switch keeps the loaded pair');
    act(() => current.setLocale('en'));
    await act(async () => { await import('../locales/fr.json'); });
    assert(current.locale === 'en' && host.textContent === 'Cancel', 'late superseded dictionary cannot overwrite the latest choice');
    assert(mounts === 1 && host.querySelector('input') === input && input.value === 'unsaved edits', 'language switching preserves component identity and draft state');
    const labels = { en: 'Cancel', de: 'Abbrechen', fr: 'Annuler' };
    assert(renders.every(([locale, label]) => labels[locale] === label), 'no render mixes locale formatting with another dictionary');
    return { passed: ['pending locale remains coherent', 'atomic loaded pair', 'stale load ignored', 'mounted app and unsaved state retained'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (saved.locale === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', saved.locale);
    document.documentElement.lang = saved.lang;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
  }
}

export async function runMountedSessionRegressions() {
  const saved = { fetch: window.fetch, confirm: window.confirm, act: globalThis.IS_REACT_ACT_ENVIRONMENT, url: location.href, state: history.state, lang: document.documentElement.lang, theme: document.documentElement.getAttribute('data-theme') };
  const storage = new Map(['manafolio_token', 'manafolio_user', 'manafolio_ui_lang', 'theme'].map(key => [key, localStorage.getItem(key)]));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const users = { A: { id: 901, username: 'Session A', role: 'user', theme: 'dark' }, B: { id: 902, username: 'Session B', role: 'user', theme: 'dark' } };
  const card = { id: 'fixture-card', card_id: 'fixture-card', entry_id: 9001, name: 'Private A card', game: 'mtg', language: 'English', quantity: 2, snapshot: 'fixture-snapshot', printing: 'Normal', condition: 'Near Mint', grader: 'Raw', set_id: 'fixture', number: '1', types: [], subtypes: [], colors: [], rarity: 'Common' };
  const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const confirms = [];
  const unexpected = [];
  let heldCollection;
  let holdCollection = false;
  let confirmOutcome = 'network';
  const account = () => JSON.parse(localStorage.getItem('manafolio_user') || 'null');
  const replace = (name, suffix = '') => act(async () => {
    localStorage.setItem('manafolio_token', `session-${name}${suffix}`);
    localStorage.setItem('manafolio_user', JSON.stringify(users[name]));
    window.dispatchEvent(new StorageEvent('storage', { key: 'manafolio_token' }));
  });
  const button = (key, scope = host) => [...scope.querySelectorAll('button')].find(node => node.textContent.trim() === en[key]);
  const click = element => act(async () => { assert(element, 'expected mounted App control'); element.click(); });
  const waitForView = async selector => {
    for (let attempt = 0; attempt < 120 && !host.querySelector(selector); attempt++) {
      await act(async () => new Promise(resolve => setTimeout(resolve, 16)));
    }
  };
  const change = (input, value) => act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  const trades = async () => {
    await click(button('nav.more', host.querySelector('nav')));
    await click(button('trade.title', host.querySelector('nav')));
    await waitForView('.trade-workbench');
  };
  window.fetch = async (url, options = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/auth/me') return response({ user: account() });
    if (path === '/api/auth/config') return response({});
    if (path === '/api/card-art/index') return response({ ids: [] });
    if (path === '/api/stats') return response({}, 503);
    if (['/api/sets', '/api/locations', '/api/decks', '/api/stats/history'].includes(path)) return response([]);
    if (path === '/api/collection') {
      if (holdCollection) return new Promise(resolve => { heldCollection = () => resolve(response([{ ...card, name: 'Late private A card' }])); });
      return response(account()?.id === users.A.id ? [card] : [{ ...card, entry_id: 9002, name: 'Private B card' }]);
    }
    if (path === '/api/trades/entries') return response(account()?.id === users.A.id ? [card] : []);
    if (path === '/api/search') return response([{ ...card, id: 'received-card', card_id: 'received-card', name: 'Receiving card' }]);
    if (path === '/api/trades/review') {
      const request = JSON.parse(options.body);
      return response({ request, giving: [{ ...card, quantity: 1, estimate: null }], receiving: [{ ...card, id: 'received-card', card_id: 'received-card', quantity: 1, estimate: null }] });
    }
    if (path === '/api/trades/confirm') {
      confirms.push({ owner: account()?.id, request: JSON.parse(options.body) });
      if (confirmOutcome === 'network') throw new TypeError('Fixture uncertain response');
      if (confirmOutcome === 'expired') {
        window.dispatchEvent(new Event('manafolio_logout'));
        return response({ error: 'Fixture expired session' }, 401);
      }
      return response({ given: 1, received: 1 });
    }
    unexpected.push(String(url));
    return response({}, 404);
  };
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('manafolio_ui_lang', 'en');
    await replace('A');
    const { default: App } = await import('../App');
    // Preload lazy views; still mount and exercise the real App and its real children.
    await Promise.all([import('../components/Dashboard'), import('../components/CollectionList'), import('../components/TradeWorkbench')]);
    await act(async () => root.render(<I18nProvider><App /></I18nProvider>));
    await click(button('nav.collection', host.querySelector('nav')));
    await waitForView('.tcg-card');
    assert(host.textContent.includes('Private A card'), `A collection is mounted before replacement: ${host.textContent}; unexpected requests: ${unexpected.join(', ')}`);
    await change(host.querySelector('#collection-search'), 'Private A');
    holdCollection = true;
    await change(host.querySelector('#collection-inventory'), 'wishlist');
    assert(heldCollection, 'A collection request is held');
    await replace('B');
    assert(button('nav.dashboard', host.querySelector('nav')).getAttribute('aria-current') === 'page' && !host.textContent.includes('Private A'), 'identity replacement resets navigation and removes A collection');
    holdCollection = false;
    await click(button('nav.collection', host.querySelector('nav')));
    await waitForView('.tcg-card');
    await act(async () => heldCollection());
    assert(host.querySelector('#collection-search').value === '' && host.querySelector('#collection-inventory').value === 'collection', 'B receives fresh collection selection and filters');
    assert(host.textContent.includes('Private B card') && !host.textContent.includes('Late private A'), 'held A response cannot publish in B collection');

    await replace('A', '-draft');
    await trades();
    await click(host.querySelector('.trade-results button'));
    window.confirm = () => false;
    await click(button('nav.dashboard', host.querySelector('nav')));
    assert(host.querySelector('.trade-selection li'), 'voluntary navigation is vetoed by dirty draft');
    await replace('B', '-draft');
    await trades();
    assert(!host.querySelector('.trade-selection li') && !host.textContent.includes('Private A card'), 'A editable draft is not retained for B');

    await replace('A', '-uncertain');
    await trades();
    await click(host.querySelector('.trade-results button'));
    const search = host.querySelector('.trade-columns form');
    await change(search.querySelector('input'), 'Receiving');
    await act(async () => search.requestSubmit());
    await click(host.querySelectorAll('.trade-results')[1].querySelector('button'));
    await act(async () => host.querySelector('#trade-review-form').requestSubmit());
    await click(button('trade.confirm'));
    assert(confirms.length === 1 && host.textContent.includes('Fixture uncertain response'), 'uncertain trade preserves the original confirmation');
    await act(async () => window.dispatchEvent(new Event('manafolio_logout')));
    assert(!localStorage.getItem('manafolio_token') && !host.querySelector('.app-container') && host.querySelector('input[type="password"]'), 'mandatory expiry clears an invalid session despite an uncertain-trade guard');
    await replace('B', '-recovery');
    await trades();
    assert(!button('trade.confirm') && !host.textContent.includes('Private A card') && confirms.length === 1, 'B cannot see or replay A recovery');
    await replace('A', '-recovery');
    await trades();
    assert(button('trade.confirm') && confirms.length === 1 && host.textContent.includes(en['trade.retry']), 'same account is offered explicit recovery without automatic replay');
    confirmOutcome = 'success';
    await click(button('trade.confirm'));
    assert(confirms.length === 2 && JSON.stringify(confirms[0]) === JSON.stringify(confirms[1]), 'reauthentication retries the exact account-owned trade ID and payload');
    await replace('B', '-after-success');
    await replace('A', '-after-success');
    await trades();
    assert(!button('trade.confirm'), 'successful receipt clears recovery');

    await click(host.querySelector('.trade-results button'));
    const nextSearch = host.querySelector('.trade-columns form');
    await change(nextSearch.querySelector('input'), 'Receiving');
    await act(async () => nextSearch.requestSubmit());
    await click(host.querySelectorAll('.trade-results')[1].querySelector('button'));
    await act(async () => host.querySelector('#trade-review-form').requestSubmit());
    confirmOutcome = 'expired';
    await click(button('trade.confirm'));
    assert(!localStorage.getItem('manafolio_token'), 'confirm 401 forces expiry');
    await replace('A', '-after-401');
    await trades();
    assert(!button('trade.confirm'), 'definitively rejected 401 is not retained as uncertain recovery');
    assert(!unexpected.length, `unexpected mounted App requests: ${unexpected.join(', ')}`);
    return { passed: ['mounted collection account replacement with held response', 'draft isolation', 'mandatory expiry bypasses dirty guard', 'same-account explicit uncertain receipt retry', '401 clears recovery'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = saved.fetch;
    window.confirm = saved.confirm;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
    for (const [key, value] of storage) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
    document.documentElement.lang = saved.lang;
    if (saved.theme === null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', saved.theme);
    history.replaceState(saved.state, '', saved.url);
  }
}
