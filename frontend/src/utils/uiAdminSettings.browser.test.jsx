import { act } from 'react';
import { createRoot } from 'react-dom/client';
import Settings from '../components/Settings';
import AdminPanel from '../components/AdminPanel';
import { I18nProvider } from './i18n';
import en from '../locales/en.json';

// Isolated Vite page only: await (await import('/src/utils/uiAdminSettings.browser.test.jsx')).runUiAdminSettingsRegressions()
// Fetch is fully intercepted; failures exercise retry without downloading files or seeding a server.
export async function runUiAdminSettingsRegressions() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const saved = { fetch: window.fetch, confirm: window.confirm, act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'), indexedDB: Object.getOwnPropertyDescriptor(window, 'indexedDB'),
    locale: localStorage.getItem('manafolio_ui_lang'), state: history.state, url: location.href };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const notices = [];
  const pending = new Map();
  const counts = new Map();
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const defer = url => { counts.set(url, (counts.get(url) || 0) + 1); return new Promise(resolve => pending.set(url, resolve)); };
  const settle = async (url, body = {}, status = 500) => { await act(async () => { pending.get(url)(response(body, status)); pending.delete(url); }); };
  const button = key => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === en[key] || node.getAttribute('aria-label') === en[key]);
  const click = async (...nodes) => { await act(async () => { nodes.forEach(node => { assert(node, 'fixture button exists'); node.click(); }); }); };
  const render = async component => { await act(async () => { root.render(<I18nProvider>{component}</I18nProvider>); }); };
  const showToast = (...notice) => notices.push(notice);
  const user = { id: 901, username: 'fixture', role: 'member', share_enabled: 1, share_locations: 1, share_token: 'fixture', api_key: 'fixture-key' };
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('manafolio_ui_lang', 'en');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    window.confirm = () => true;
    window.fetch = async (url, options = {}) => {
      url = String(url);
      if (url === '/api/locations' || url.startsWith('/api/export?') || url === '/api/admin/seed-cards' || url.endsWith('/download') || (url === '/api/admin/users/901' && options.method)) return defer(url);
      if (url === '/api/admin/users') return response([{ ...user, created_at: '2025-01-01', total_cards: 0 }]);
      if (url === '/api/admin/backups') return response({ backups: [{ file: 'fixture.db', size: 12, created_at: '2025-01-01' }] });
      if (url === '/api/settings') return response({ public_base_url: 'https://fixture.invalid' });
      if (url === '/api/settings/version') return response({ version: '1.2.3' });
      if (url === '/api/ai-decks/preferences') return response({ provider: 'chatgpt' });
      if (url.startsWith('/api/ai-decks/account?')) return response({ connected: false });
      if (url === '/api/admin/catalogs') return response({ catalogs: [] });
      if (url === '/api/admin/models') return response({});
      if (url === 'https://api.github.com/repositories/1389194597') return response({ html_url: 'https://github.com/fixture/fixture' });
      throw new Error(`Unexpected fixture request: ${url}`);
    };
    await render(<Settings user={user} showToast={showToast} onUpdateUser={() => {}} onSaveTheme={async () => true} />);
    assert(host.textContent.includes(en['common.loading']), 'container links show loading');
    const shareInput = [...host.querySelectorAll('input[readonly]')].find(input => input.value.includes('/share/fixture'));
    await click(shareInput.parentElement.querySelector('button'));
    assert(document.activeElement === shareInput && shareInput.selectionEnd === shareInput.value.length, 'missing clipboard selects the existing share URL');
    assert(notices.at(-1)[0] === en['settings.copyManually'] && notices.at(-1)[1] === 'error', 'missing clipboard reports manual copy, not success');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
    await click(shareInput.parentElement.querySelector('button'));
    assert(notices.at(-1)[0] === en['settings.copyManually'], 'denied clipboard has the same recovery');
    await click(host.querySelector(`button[title="${en['settings.copyVersionHint']}"]`));
    assert(window.getSelection().toString().startsWith('Manafolio v'), 'version copy failure selects visible version text');
    await settle('/api/locations');
    assert(host.textContent.includes(en['settings.containerLinksError']) && shareInput.isConnected, 'container error preserves other sharing controls');
    await click(button('common.retry'));
    await settle('/api/locations', [], 200);
    assert(host.textContent.includes(en['settings.containerLinksEmpty']), 'empty containers differ from failure');
    const exportButton = button('settings.exportBackup');
    await click(exportButton, exportButton);
    assert(counts.get('/api/export?format=backup') === 1 && exportButton.disabled, 'same-tick export is locked');
    assert(host.textContent.includes(en['settings.downloading']), 'export announces pending');
    await settle('/api/export?format=backup');
    assert(!exportButton.disabled && notices.at(-1)[1] === 'error', 'failed export unlocks and reports error');
    await click(exportButton);
    assert(counts.get('/api/export?format=backup') === 2, 'failed export can retry');
    await settle('/api/export?format=backup');
    const keyButton = host.querySelector(`button[aria-label="${en['settings.showApiKey']}"]`);
    assert(keyButton.getBoundingClientRect().width >= 44 && keyButton.getBoundingClientRect().height >= 44, 'key reveal target is at least 44px');
    await click(keyButton);
    assert(host.querySelector('#settings-access-key').type === 'text', 'key reveal still works');

    await render(<AdminPanel user={{ ...user, role: 'admin' }} showToast={showToast} onUpdateUser={() => {}} />);
    let confirmation = '';
    window.confirm = text => { confirmation = text; return true; };
    const seed = button('admin.generateTestCards');
    await click(seed, seed);
    assert(counts.get('/api/admin/seed-cards') === 1 && seed.disabled, 'seed is synchronously locked');
    assert(confirmation.includes('lea') && confirmation.includes('mh3') && /backup/i.test(confirmation) && /delet/i.test(confirmation), 'seed confirmation discloses replacement scope and backup');
    await settle('/api/admin/seed-cards');
    assert(!seed.disabled, 'seed failure releases pending state');
    const role = button('admin.toggleRole');
    const remove = button('admin.deleteAccount');
    await click(role, remove);
    assert(counts.get('/api/admin/users/901') === 1 && role.disabled && remove.disabled, 'same-user role/delete conflict is locked synchronously');
    await settle('/api/admin/users/901', { error: 'Fixture rejection' });
    assert(!role.disabled && !remove.disabled, 'user failure unlocks both actions');
    await click(remove);
    assert(counts.get('/api/admin/users/901') === 2, 'delete can retry after role failure');
    await settle('/api/admin/users/901', { error: 'Fixture rejection' });
    const download = button('admin.downloadBackup');
    await click(download, download);
    assert(counts.get('/api/admin/backups/fixture.db/download') === 1 && download.disabled, 'admin backup download is locked');
    await settle('/api/admin/backups/fixture.db/download');
    assert(!download.disabled, 'backup failure releases download control');
    await click(download);
    assert(counts.get('/api/admin/backups/fixture.db/download') === 2, 'backup download supports retry');
    await settle('/api/admin/backups/fixture.db/download');
    return { passed: ['clipboard unavailable/denied and version manual selection', 'container loading/error/retry/empty preserves sharing', 'export pending/duplicate/failure/retry', '44px key reveal', 'seed truthful confirmation/pending/failure', 'per-user conflicting actions/failure/retry', 'admin backup pending/failure/retry'] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.fetch = saved.fetch;
    window.confirm = saved.confirm;
    if (saved.clipboard) Object.defineProperty(navigator, 'clipboard', saved.clipboard); else delete navigator.clipboard;
    if (saved.indexedDB) Object.defineProperty(window, 'indexedDB', saved.indexedDB); else delete window.indexedDB;
    if (saved.locale === null) localStorage.removeItem('manafolio_ui_lang'); else localStorage.setItem('manafolio_ui_lang', saved.locale);
    history.replaceState(saved.state, '', saved.url);
    window.getSelection()?.removeAllRanges();
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
  }
}
