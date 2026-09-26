import { useState, useEffect, useRef } from 'react';
import { useScrollReveal } from '../utils/useScrollReveal';
import { ShieldAlert, Share2, Clipboard, RefreshCw, KeyRound, Check, Database, Download, Upload, Eye, EyeOff, SlidersHorizontal, Info, Bug, Lightbulb, MessagesSquare, ScrollText, Github, Languages } from 'lucide-react';
import { CURRENCIES, getCurrency, setCurrency } from '../utils/formatPrice';
import { LOCALES, localeName, useT } from '../utils/i18n';
import { getRepoUrl, issueUrl } from '../utils/repo';
import CodexSettings from './CodexSettings';
import themes from '../../../shared/themes.json';


function Settings({ user, onUpdateUser, onSaveTheme, showToast }) {
  const { locale, setLocale, t } = useT();
  const revealRef = useScrollReveal();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  
  const [shareEnabled, setShareEnabled] = useState(user?.share_enabled === 1);
  const [shareLocations, setShareLocations] = useState(user?.share_locations === 1);
  const [shareLoading, setShareLoading] = useState(false);
  const [containers, setContainers] = useState([]);

  const [accessKey, setAccessKey] = useState(user?.api_key || '');
  const [showAccessKey, setShowAccessKey] = useState(false);
  const [accessKeyLoading, setAccessKeyLoading] = useState(false);

  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [bulkTime, setBulkTime] = useState('');
  const [bulkBusy, setBulkBusy] = useState('loading');
  const [bulkNotice, setBulkNotice] = useState(null);
  const mountedRef = useRef(true);

  const theme = themes.includes(user?.theme) ? user.theme : 'dark';
  const [themeLoading, setThemeLoading] = useState(false);

  const handleThemeChange = async (value) => {
    setThemeLoading(true);
    try {
      const saved = await onSaveTheme(value);
      if (saved && mountedRef.current) showToast(t('prefs.themeSet', { theme: t(`theme.${value}`) }), 'success');
    } catch {
      if (mountedRef.current) showToast(t('prefs.themeError'), 'error');
    } finally {
      if (mountedRef.current) setThemeLoading(false);
    }
  };
  const [currency, setCurrencyState] = useState(() => getCurrency());

  const [collectionDefaultView, setCollectionDefaultView] = useState(() => localStorage.getItem('collection_default_view') || 'gallery');
  const [storageDefaultView, setStorageDefaultView] = useState(() => localStorage.getItem('storage_default_view') || 'layout');
  const [deckDefaultView, setDeckDefaultView] = useState(() => localStorage.getItem('deck_default_view') || 'list');
  const [defaultCardScale, setDefaultCardScale] = useState(() => {
    const scale = Number(localStorage.getItem('card_default_scale'));
    return scale >= 0.6 && scale <= 2.5 ? scale : 1;
  });

  const [versionInfo, setVersionInfo] = useState(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [backendReachable, setBackendReachable] = useState(true);
  const [repoUrl, setRepoUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    fetch('/api/settings')
      .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then(data => {
        if (cancelled) return;
        setPublicBaseUrl(data.public_base_url || '');
        setBulkTime(data.scryfall_bulk_download_time || '10:00');
      })
      .catch(() => {
        if (!cancelled) setBulkNotice({ error: true, key: 'settings.bulkLoadError' });
      })
      .finally(() => {
        if (!cancelled) setBulkBusy('');
      });
    return () => { cancelled = true; mountedRef.current = false; };
  }, []);

  const handleBulkAction = async (action) => {
    if (bulkBusy || user?.role !== 'admin') return;
    setBulkBusy(action);
    setBulkNotice(null);
    try {
      const response = await fetch(action === 'save' ? '/api/settings' : '/api/settings/scryfall-bulk/download', action === 'save' ? {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scryfall_bulk_download_time: bulkTime }),
      } : { method: 'POST' });
      const data = await response.json();
      if (!mountedRef.current) return;
      if (!response.ok) {
        setBulkNotice({ error: true, message: data.error, key: action === 'save' ? 'admin.errSettings' : 'settings.bulkDownloadError' });
      } else if (action === 'save') {
        setBulkTime(data.scryfall_bulk_download_time);
        setBulkNotice({ key: 'admin.settingsUpdated' });
      } else {
        setBulkNotice({ key: 'settings.bulkDownloaded', values: {
          count: data.count.toLocaleString(locale),
          date: new Date(data.updated_at).toLocaleString(locale, { timeZone: 'UTC', timeZoneName: 'short' }),
        } });
      }
    } catch {
      if (mountedRef.current) setBulkNotice({ error: true, key: action === 'save' ? 'admin.errSettingsGeneric' : 'settings.bulkDownloadError' });
    } finally {
      if (mountedRef.current) setBulkBusy('');
    }
  };

  // The build stamps its own version in, so Settings can always state what it
  // is even with the backend down. The call below only adds the SERVER's
  // version (to catch a stale backend behind a fresh frontend) and powers the
  // update check — it is never what makes the version appear.
  const appVersion = import.meta.env.VITE_APP_VERSION || null;
  const isDemo = !!import.meta.env.VITE_DEMO;

  useEffect(() => {
    let cancelled = false;
    getRepoUrl()
      .then(url => { if (!cancelled) setRepoUrl(url); })
      .catch(() => { /* Offline support instructions remain visible. */ });
    fetch('/api/settings/version')
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => { setVersionInfo(data); setBackendReachable(true); })
      .catch(() => setBackendReachable(false));
    return () => { cancelled = true; };
  }, []);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const res = await fetch('/api/settings/version?check=1');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setVersionInfo(data);
      setBackendReachable(true);
      if (data.check_failed) showToast(t('settings.updateNoGithub'), 'error');
      else if (data.update_available) showToast(t('settings.updateAvailable', { version: data.latest }), 'status');
      else showToast(t('settings.updateLatest'), 'success');
    } catch (err) {
      console.error(err);
      setBackendReachable(false);
      showToast(t('settings.updateNoServer'), 'error');
    } finally {
      setCheckingUpdate(false);
    }
  };

  // The version shown: the build's own stamp, falling back to whatever the
  // server reports if an older bundle has no stamp baked in.
  const shownVersion = appVersion || versionInfo?.version || null;
  // A frontend newer than the backend usually means a half-finished update —
  // worth surfacing, since it produces confusing bugs that look like app bugs.
  const versionSkew = appVersion && versionInfo?.version && appVersion !== versionInfo.version
    ? versionInfo.version
    : null;

  // Prefill a bug report with the details that otherwise take three round trips
  // to obtain. Environment only — nothing about the user's collection.
  const bugReportUrl = () => {
    const body = [
      '### What happened?',
      '',
      '',
      '### What did you expect?',
      '',
      '',
      '### Steps to reproduce',
      '1. ',
      '2. ',
      '',
      '### Environment',
      `- Manafolio (app): ${shownVersion || 'unknown'}`,
      `- Manafolio (server): ${versionInfo?.version || (backendReachable ? 'unknown' : 'unreachable')}`,
      `- Platform: ${navigator.platform || 'unknown'}`,
      `- Browser: ${navigator.userAgent}`,
      `- Screen: ${window.screen?.width}x${window.screen?.height}`,
      '',
      '<!-- Screenshots help a lot. Please remove anything you would rather not share. -->',
    ].join('\n');
    return issueUrl(repoUrl, { labels: 'bug', title: '[Bug] ', body });
  };

  const featureRequestUrl = () => {
    const body = [
      '### What would you like Manafolio to do?',
      '',
      '',
      '### Why would that help?',
      '',
      '',
      `<!-- Manafolio ${shownVersion || 'unknown'} -->`,
    ].join('\n');
    return issueUrl(repoUrl, { labels: 'enhancement', title: '[Feature] ', body });
  };

  const handleImportFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = null;

    let fileData;
    try {
      fileData = await file.text();
    } catch {
      showToast(t('settings.errReadFile'), 'error');
      return;
    }

    const filename = file.name.toLowerCase();
    try {
      let format = filename.endsWith('.json') ? 'json' : (filename.endsWith('.txt') ? 'manabox' : 'csv');
      let completeBackup = false;
      if (format === 'json') {
        try {
          const parsed = JSON.parse(fileData);
          completeBackup = parsed?.format === 'manafolio-backup' && parsed.version === 1;
        } catch { /* The server returns the normal JSON-import error. */ }
      }
      if (!window.confirm(t(completeBackup ? 'settings.confirmRestore' : 'settings.confirmImport', { file: file.name }))) return;
      if (completeBackup) format = 'backup';

      showToast(t('settings.importing'), 'status');
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, data: fileData })
      });

      const result = await response.json();
      if (response.ok) {
        showToast(result.message || t('settings.importOk'), 'success');
      } else {
        showToast(t('settings.importFailed', { error: result.error || t('settings.unknownError') }), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.importFailed', { error: err.message }), 'error');
    }
  };

  // Containers to offer share links for. Only fetched once both share toggles are
  // on, because that is the only state the links work in.
  useEffect(() => {
    if (!shareEnabled || !shareLocations) { setContainers([]); return; }
    fetch('/api/locations')
      .then(res => (res.ok ? res.json() : []))
      .then(list => setContainers(Array.isArray(list) ? list : []))
      .catch(() => setContainers([]));
  }, [shareEnabled, shareLocations]);

  useEffect(() => {
    if (user) {
      setShareEnabled(user.share_enabled === 1 || user.share_enabled === true);
      setShareLocations(user.share_locations === 1 || user.share_locations === true);
      setAccessKey(user.api_key || '');
    }
  }, [user]);

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (!currentPassword) {
      showToast(t('settings.errCurrentPassword'), 'error');
      return;
    }
    if (password.length < 8) {
      showToast(t('login.errPasswordShort', { count: 8 }), 'error');
      return;
    }
    if (password !== confirmPassword) {
      showToast(t('login.errPasswordMismatch'), 'error');
      return;
    }

    setPasswordLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, password })
      });

      if (response.ok) {
        showToast(t('settings.passwordUpdated'), 'success');
        setCurrentPassword('');
        setPassword('');
        setConfirmPassword('');
      } else {
        const data = await response.json();
        showToast(data.error || t('settings.errPasswordUpdate'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.errPasswordUpdateGeneric'), 'error');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleExport = async (format) => {
    try {
      const response = await fetch(`/api/export?format=${format}`);
      if (!response.ok) {
        showToast(t('settings.errExport'), 'error');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'backup' ? 'manafolio_backup.json' : `manafolio_collection.${format === 'json' ? 'json' : 'csv'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showToast(t('settings.errExportGeneric'), 'error');
    }
  };

  const handleShareToggle = async (checked) => {
    setShareEnabled(checked);
    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_enabled: checked })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser({ share_enabled: data.user.share_enabled });
        showToast(t(checked ? 'settings.sharingOn' : 'settings.sharingOff'), 'success');
      } else {
        setShareEnabled(!checked); // Revert
        showToast(t('settings.errSharing'), 'error');
      }
    } catch (err) {
      console.error(err);
      setShareEnabled(!checked);
      showToast(t('settings.errSharingGeneric'), 'error');
    } finally {
      setShareLoading(false);
    }
  };

  const handleLocationsToggle = async (checked) => {
    setShareLocations(checked);
    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_locations: checked })
      });
      if (response.ok) {
        const data = await response.json();
        onUpdateUser({ share_locations: data.user.share_locations });
        showToast(t(checked ? 'settings.locationsOn' : 'settings.locationsOff'), 'success');
      } else {
        setShareLocations(!checked);
        showToast(t('settings.errLocations'), 'error');
      }
    } catch (err) {
      console.error(err);
      setShareLocations(!checked);
      showToast(t('settings.errLocationsGeneric'), 'error');
    } finally {
      setShareLoading(false);
    }
  };

  const handleRegenerateToken = async () => {
    if (!window.confirm(t('settings.confirmRegenerate'))) {
      return;
    }

    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate_share_token: true })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser({ share_token: data.user.share_token });
        showToast(t('settings.tokenRegenerated'), 'success');
      } else {
        showToast(t('settings.errRegenerate'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.errRegenerateGeneric'), 'error');
    } finally {
      setShareLoading(false);
    }
  };


  // Create/rotate/revoke the read-only API key. Rotating and revoking both break
  // whatever is already using the old key, so both ask first.
  const handleAccessKey = async (action) => {
    if (action === 'create' && accessKey && !window.confirm(t('settings.accessConfirmRotate'))) return;
    if (action === 'revoke' && !window.confirm(t('settings.accessConfirmRevoke'))) return;
    setAccessKeyLoading(true);
    try {
      const response = await fetch('/api/auth/api-key', { method: action === 'revoke' ? 'DELETE' : 'POST' });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        const next = action === 'revoke' ? '' : (data?.api_key || '');
        setAccessKey(next);
        setShowAccessKey(action !== 'revoke');
        onUpdateUser({ api_key: next });
        showToast(t(action === 'revoke' ? 'settings.accessRevoked' : 'settings.accessCreated'), 'success');
      } else {
        showToast(data?.error || t('settings.errAccessKey'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.errAccessKey'), 'error');
    } finally {
      setAccessKeyLoading(false);
    }
  };

  const origin = publicBaseUrl || `${window.location.protocol}//${window.location.host}`;
  const activeTheme = theme;
  const themeQuery = activeTheme !== 'dark' ? `&theme=${encodeURIComponent(activeTheme)}` : '';
  const shareUrl = `${origin}/share/${user?.share_token}${activeTheme !== 'dark' ? `?theme=${encodeURIComponent(activeTheme)}` : ''}`;
  const tradeUrl = `${origin}/share/${user?.share_token}?list=trade${themeQuery}`;
  const wishlistUrl = `${origin}/share/${user?.share_token}?list=wishlist${themeQuery}`;

  const [copiedType, setCopiedType] = useState(''); // 'collection', 'trade', 'wishlist'

  // messageType is separate from type because the per-container rows key their
  // "copied" tick by container id, while sharing one toast message.
  const copyToClipboard = (url, type, messageType = type) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedType(type);
      showToast(t(`settings.copied.${messageType}`), 'success');
      setTimeout(() => setCopiedType(''), 2000);
    }).catch(() => {
      showToast(t('settings.errCopy'), 'error');
    });
  };

  return (
    <div ref={revealRef} className="settings-page" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <header className="page-heading">
        <div>
          <h2 className="page-title">{t('settings.title')}</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 0' }}>{t('settings.subtitle')}</p>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }} className="settings-grid">
        {/* Sharing Panel */}
        <div className="view-section" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Share2 size={20} aria-hidden="true" />
            <h3 className="section-heading">{t('settings.sharingTitle')}</h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>{t('settings.shareLibrary')}</div>
              <div id="settings-share-hint" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{t('settings.shareLibraryHint')}</div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '44px', minHeight: '44px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                aria-label={t('settings.shareLibrary')}
                aria-describedby="settings-share-hint"
                checked={shareEnabled}
                onChange={(e) => handleShareToggle(e.target.checked)}
                disabled={shareLoading}
                style={{ width: '22px', height: '22px', accentColor: 'var(--accent-red)' }}
              />
            </label>
          </div>

          {shareEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
              
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="settings-share-collection">{t('settings.linkCollection')}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    id="settings-share-collection"
                    type="text" 
                    className="input-control" 
                    value={shareUrl} 
                    readOnly 
                    style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(shareUrl, 'collection')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'collection' ? <Check size={14} style={{ color: 'var(--accent-green)' }} /> : <Clipboard size={14} />}
                    <span>{t('settings.copy')}</span>
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="settings-share-trade">{t('settings.linkTrade')}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    id="settings-share-trade"
                    type="text" 
                    className="input-control" 
                    value={tradeUrl} 
                    readOnly 
                    style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(tradeUrl, 'trade')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'trade' ? <Check size={14} style={{ color: 'var(--accent-green)' }} /> : <Clipboard size={14} />}
                    <span>{t('settings.copy')}</span>
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="settings-share-wishlist">{t('settings.linkWishlist')}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    id="settings-share-wishlist"
                    type="text" 
                    className="input-control" 
                    value={wishlistUrl} 
                    readOnly 
                    style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(wishlistUrl, 'wishlist')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'wishlist' ? <Check size={14} style={{ color: 'var(--accent-green)' }} /> : <Clipboard size={14} />}
                    <span>{t('settings.copy')}</span>
                  </button>
                </div>
              </div>

              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                {/* The three query strings go in as placeholders rather than as
                    <code> elements: that keeps the sentence one translatable unit
                    and stops a translator from accidentally localising a URL. */}
                <strong>{t('settings.tipLabel')}</strong> {t('settings.themeTip', {
                  theme: t(`theme.${activeTheme}`),
                  manaWhite: '?theme=mana-white',
                  manaBlue: '?theme=mana-blue',
                  dark: '?theme=dark',
                })}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>{t('settings.showLocations')}</div>
                  <div id="settings-share-locations-hint" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{t('settings.showLocationsHint')}</div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '44px', minHeight: '44px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    aria-label={t('settings.showLocations')}
                    aria-describedby="settings-share-locations-hint"
                    checked={shareLocations}
                    onChange={(e) => handleLocationsToggle(e.target.checked)}
                    disabled={shareLoading}
                    style={{ width: '22px', height: '22px', accentColor: 'var(--accent-red)' }}
                  />
                </label>
              </div>

              {/* A container link opens that binder or box as itself — pockets
                  and pages, or box rows — rather than as a flat card list, which
                  is why it needs the locations toggle above to be on. */}
              {shareLocations && containers.length > 0 && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>{t('settings.linkContainer')}</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {containers.map(loc => (
                      <div key={loc.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {loc.name}
                        </span>
                        <button
                          className="btn btn-secondary"
                          onClick={() => copyToClipboard(`${origin}/share/${user?.share_token}?container=${loc.id}${themeQuery}`, `container-${loc.id}`, 'container')}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}
                        >
                          {copiedType === `container-${loc.id}` ? <Check size={14} style={{ color: 'var(--accent-green)' }} /> : <Clipboard size={14} />}
                          <span>{t('settings.copy')}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button
                  className="btn btn-secondary"
                  onClick={handleRegenerateToken}
                  disabled={shareLoading}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
                >
                  <RefreshCw size={12} className={shareLoading ? 'spin-animation' : ''} />
                  <span>{t('settings.regenerateLink')}</span>
                </button>
              </div>
            </div>
          )}

          {!shareEnabled && (
            <div style={{ display: 'flex', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              <ShieldAlert size={16} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
              <span>{t('settings.privateNotice')}</span>
            </div>
          )}
        </div>

        {/* Change Password Panel */}
        <div className="view-section" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <KeyRound size={20} aria-hidden="true" />
            <h3 className="section-heading">{t('settings.securityTitle')}</h3>
          </div>

          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="current-password">{t('settings.currentPassword')}</label>
              <input
                id="current-password"
                type="password"
                name="current-password"
                autoComplete="current-password"
                className="input-control"
                placeholder={t('settings.currentPasswordPlaceholder')}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-new-password">{t('settings.newPassword')}</label>
              <input
                id="settings-new-password"
                type="password"
                name="new-password"
                autoComplete="new-password"
                className="input-control"
                placeholder={t('settings.newPasswordPlaceholder', { count: 8 })}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-confirm-password">{t('login.confirmPassword')}</label>
              <input
                id="settings-confirm-password"
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                className="input-control"
                placeholder={t('login.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <button 
              type="submit" 
              className="btn btn-primary" 
              disabled={passwordLoading}
              style={{ padding: '0.6rem 1.2rem', alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              {passwordLoading ? (
                <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>
              ) : t('settings.updatePassword')}
            </button>
          </form>
        </div>

        <div className="view-section" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <KeyRound size={20} aria-hidden="true" />
            <h3 className="section-heading">{t('settings.keysTitle')}</h3>
          </div>


          {/* The one key that points the other way: not a credential Manafolio uses
              to reach a service, but one something else uses to read Manafolio. Shown
              in full rather than once-at-creation — read-only is what makes that
              acceptable, and a write-once secret is one people rotate repeatedly
              until they manage to catch it. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-access-key">{t('settings.accessTitle')}</label>
              {accessKey ? (
                <div style={{ position: 'relative' }}>
                  <input
                    id="settings-access-key"
                    type={showAccessKey ? 'text' : 'password'}
                    readOnly
                    className="input-control"
                    value={accessKey}
                    onClick={(e) => e.target.select()}
                    style={{ fontFamily: 'monospace', paddingRight: '2.4rem', width: '100%' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowAccessKey((v) => !v)}
                    aria-label={t(showAccessKey ? 'settings.hideApiKey' : 'settings.showApiKey')}
                    title={t(showAccessKey ? 'settings.hideApiKey' : 'settings.showApiKey')}
                    style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                  >
                    {showAccessKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('settings.accessNone')}</div>
              )}
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: 1.45 }}>
                {t('settings.accessIntro')} {t('settings.accessNetWorth')}
              </div>
              <pre style={{ margin: '0.4rem 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                {`curl -H "Authorization: Bearer ${accessKey || '<key>'}" ${origin}/api/stats/networth`}
              </pre>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={accessKeyLoading}
                onClick={() => handleAccessKey('create')}
                style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                {accessKeyLoading ? (
                  <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>
                ) : t(accessKey ? 'settings.accessRotate' : 'settings.accessCreate')}
              </button>
              {accessKey && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={accessKeyLoading}
                  onClick={() => handleAccessKey('revoke')}
                  style={{ padding: '0.5rem 1rem', fontSize: '0.8rem' }}
                >
                  {t('settings.accessRevoke')}
                </button>
              )}
            </div>
          </div>
        </div>

        {user && <CodexSettings key={user.id} />}

        {user?.role === 'admin' && (
          <section className="view-section" aria-labelledby="settings-bulk-title" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Database size={20} aria-hidden="true" />
              <h3 id="settings-bulk-title" className="section-heading">{t('settings.bulkTitle')}</h3>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>{t('settings.bulkHint')}</p>
            <form onSubmit={(e) => { e.preventDefault(); handleBulkAction('save'); }} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="settings-bulk-time">{t('settings.bulkTime')}</label>
                <input
                  id="settings-bulk-time"
                  type="time"
                  step="60"
                  required
                  className="input-control"
                  value={bulkTime}
                  onChange={(e) => { setBulkTime(e.target.value); setBulkNotice(null); }}
                  disabled={!!bulkBusy}
                  aria-describedby="settings-bulk-utc"
                  style={{ maxWidth: '15rem' }}
                />
                <p id="settings-bulk-utc" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.4rem 0 0' }}>{t('settings.bulkUtcHint')}</p>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button type="submit" className="btn btn-primary" disabled={!!bulkBusy || !bulkTime}>
                  {bulkBusy === 'save' && <RefreshCw size={14} className="spin-animation" aria-hidden="true" />}
                  {t(bulkBusy === 'save' ? 'settings.bulkSaving' : 'common.save')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => handleBulkAction('download')} disabled={!!bulkBusy} aria-describedby="settings-bulk-force">
                  {bulkBusy === 'download' ? <RefreshCw size={14} className="spin-animation" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                  {t(bulkBusy === 'download' ? 'settings.bulkDownloading' : 'settings.bulkDownload')}
                </button>
              </div>
            </form>
            <p id="settings-bulk-force" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>{t('settings.bulkForceHint')}</p>
            {bulkBusy === 'loading' && <p role="status" style={{ color: 'var(--text-secondary)', margin: 0 }}>{t('common.loading')}</p>}
            {bulkNotice && (
              <p role={bulkNotice.error ? 'alert' : 'status'} style={{ fontSize: '0.85rem', color: bulkNotice.error ? 'var(--accent-red)' : 'var(--text-strong)', margin: 0 }}>
                {bulkNotice.message || t(bulkNotice.key, bulkNotice.values)}
              </p>
            )}
          </section>
        )}

        {/* Collection Backup & Data Options Panel */}
        <div className="view-section" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Database size={20} aria-hidden="true" />
            <h3 className="section-heading">{t('settings.backupTitle')}</h3>
          </div>

          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {t('settings.backupHint')}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => handleExport('backup')}
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>{t('settings.exportBackup')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('csv')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>{t('settings.exportCsv')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('json')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>{t('settings.exportJson')}</span>
            </button>

            <label 
              className="btn btn-primary" 
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', cursor: 'pointer', margin: 0 }}
            >
              <Upload size={14} />
              <span>{t('settings.importBackup')}</span>
              <input
                type="file"
                accept=".json,.csv,.txt"
                onChange={handleImportFile}
                style={{ display: 'none' }}
              />
            </label>
          </div>
        </div>

        {/* Preferences Panel */}
        <div className="view-section" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <SlidersHorizontal size={20} aria-hidden="true" />
            <h3 className="section-heading">{t('prefs.title')}</h3>
          </div>

          {/* Interface language. The picker only appears once a second locale file
              exists to switch to — dropping one into src/locales is what makes it
              appear — but the call for translators shows either way, since with
              English alone there is nothing else to advertise it.
              This is not the card language: that is picked per card on entry. */}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor={LOCALES.length > 1 ? 'settings-ui-lang' : undefined}>{t('prefs.language')}</label>
            {LOCALES.length > 1 ? (
              <>
                <select
                  id="settings-ui-lang"
                  className="select-control"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                >
                  {LOCALES.map(code => (
                    <option key={code} value={code}>{localeName(code)}</option>
                  ))}
                </select>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
                  {t('prefs.languageHint')}
                </div>
              </>
            ) : (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {t('prefs.languageOnlyEnglish')}
              </div>
            )}
            {repoUrl && <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', marginTop: '0.5rem' }}>
              <Languages size={13} style={{ color: 'var(--accent-yellow)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-secondary)' }}>
                {t('prefs.translateCta')}{' '}
                <a
                  href={`${repoUrl}/blob/main/docs/TRANSLATING.md`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-yellow)', fontWeight: 600 }}
                >
                  {t('prefs.translateCtaLink')}
                </a>
              </span>
            </div>}
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="settings-theme">{t('prefs.theme')}</label>
            <select
              id="settings-theme"
              className="select-control"
              value={theme}
              disabled={themeLoading}
              onChange={(e) => handleThemeChange(e.target.value)}
            >
              {themes.map(value => <option key={value} value={value}>{t(`theme.${value}`)}</option>)}
            </select>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
              {t('prefs.themeHint')}
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="settings-currency">{t('prefs.currency')}</label>
            <select
              id="settings-currency"
              className="select-control"
              value={currency}
              onChange={(e) => {
                const val = e.target.value;
                setCurrencyState(val);
                setCurrency(val);
                showToast(t('prefs.currencySet', { currency: val }), 'success');
              }}
            >
              {CURRENCIES.map(c => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
              {t('prefs.currencyHint')}
            </div>
          </div>


          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>{t('prefs.defaultViews')}</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
              {[
                ['collection', collectionDefaultView, setCollectionDefaultView, 'collection_default_view', [['gallery', t('collection.galleryView')], ['list', t('collection.listView')]]],
                ['storage', storageDefaultView, setStorageDefaultView, 'storage_default_view', [['layout', t('loc.gridView')], ['list', t('loc.detailView')]]],
                ['deck', deckDefaultView, setDeckDefaultView, 'deck_default_view', [['list', t('deck.tableView')], ['grid', t('deck.gridView')]]]
              ].map(([key, value, setValue, storageKey, options]) => (
                <div key={key}>
                  <label htmlFor={`settings-${key}-view`}>{t(`prefs.defaultView.${key}`)}</label>
                  <select id={`settings-${key}-view`} className="select-control" value={value} onChange={(e) => { setValue(e.target.value); localStorage.setItem(storageKey, e.target.value); }}>
                    {options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('prefs.defaultViewsHint')}</div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="settings-default-card-scale">{t('prefs.defaultCardScale')}</label>
            <select
              id="settings-default-card-scale"
              className="select-control"
              value={defaultCardScale}
              onChange={(e) => {
                const scale = Number(e.target.value);
                setDefaultCardScale(scale);
                localStorage.setItem('card_default_scale', scale);
              }}
            >
              {[0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.5].map(scale => (
                <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>
              ))}
            </select>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{t('prefs.defaultCardScaleHint')}</div>
          </div>
        </div>

        {/* About / version */}
        <div className="view-section" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Info size={20} aria-hidden="true" />
            <h3 className="section-heading">{t('settings.aboutTitle')}</h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>{shownVersion ? `Manafolio v${shownVersion}` : t('settings.versionUnknown')}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  title={t('settings.copyVersionHint')}
                  onClick={() => {
                    const text = `Manafolio app v${shownVersion || 'unknown'} | server v${versionInfo?.version || (backendReachable ? 'unknown' : 'unreachable')} | ${navigator.platform || 'unknown'} | ${navigator.userAgent}`;
                    navigator.clipboard?.writeText(text)
                      .then(() => showToast(t('settings.versionCopied'), 'success'))
                      .catch(() => showToast(t('settings.errCopyShort'), 'error'));
                  }}
                  style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
                >
                  <Clipboard size={12} /> {t('settings.copy')}
                </button>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {isDemo
                  ? t('settings.updateDemo')
                  : !backendReachable
                  ? t('settings.updateUnreachable')
                  : versionInfo?.check_failed
                    ? t('settings.updateGithubFailed')
                    : versionInfo?.update_available
                      ? t('settings.updateAvailable', { version: versionInfo.latest })
                      : versionInfo?.latest
                        ? t('settings.updateRunningLatest')
                        : t('settings.updateOnDemand')}
              </div>
              {versionSkew && (
                <div style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)', marginTop: '0.25rem' }}>
                  {t('settings.versionSkew', { version: versionSkew })}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* The demo answers /api from static fixtures, so a "check" would
                  report "you're up to date" without having checked anything. */}
              <button type="button" className="btn btn-secondary" onClick={handleCheckUpdate} disabled={checkingUpdate || isDemo}>
                <RefreshCw size={16} className={checkingUpdate ? 'spin-animation' : ''} />
                {t(checkingUpdate ? 'settings.checking' : 'settings.checkForUpdates')}
              </button>
              {versionInfo?.update_available && (
                <a
                  className="btn btn-primary"
                  href={versionInfo.release_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: 'none' }}
                >
                  <Download size={16} />
                  {t('settings.getVersion', { version: versionInfo.latest })}
                </a>
              )}
            </div>
          </div>

          {/* Support links. Each opens GitHub's own compose page in a new tab —
              prefilled, never submitted, so nothing is posted without the user
              reading it and pressing the button on GitHub. */}
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-strong)', marginBottom: '0.5rem' }}>
              {t('settings.getInvolvedTitle')}
            </div>
            {repoUrl ? <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <a className="btn btn-secondary" href={bugReportUrl()} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Bug size={16} /> {t('settings.reportBug')}
              </a>
              <a className="btn btn-secondary" href={featureRequestUrl()} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Lightbulb size={16} /> {t('settings.requestFeature')}
              </a>
              <a className="btn btn-secondary" href={`${repoUrl}/blob/main/docs/TRANSLATING.md`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Languages size={16} /> {t('settings.helpTranslate')}
              </a>
              <a className="btn btn-secondary" href={`${repoUrl}/issues`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <MessagesSquare size={16} /> {t('settings.browseIssues')}
              </a>
              <a className="btn btn-secondary" href={`${repoUrl}/releases`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <ScrollText size={16} /> {t('settings.changelog')}
              </a>
              <a className="btn btn-secondary" href={repoUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Github size={16} /> {t('settings.source')}
              </a>
            </div> : <p>{t('settings.supportUnavailable')}</p>}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', lineHeight: 1.4 }}>
              {t('settings.reportNote')}
            </div>
          </div>

          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('settings.updateChecksNote')}{' '}
            {repoUrl && <a href={versionInfo?.releases_url || `${repoUrl}/releases`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-yellow)' }}>
              {t('settings.source')}
            </a>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
