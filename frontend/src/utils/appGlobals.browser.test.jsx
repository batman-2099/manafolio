import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useT } from './i18n';

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
