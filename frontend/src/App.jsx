import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { LayoutDashboard, Database, MapPin, Settings as SettingsIcon, LogOut, ShieldAlert, Plus, Swords, BookOpen, MoreHorizontal, X } from 'lucide-react';
import Login from './components/Login';
import Logo from './components/Logo';
import { pushBackGuard } from './utils/useBackGuard';
import { useT } from './utils/i18n';
import themes from '../../shared/themes.json';

// View components are code-split so heavy deps (recharts in the chart views)
// load on demand instead of in the initial bundle.
const Dashboard = lazy(() => import('./components/Dashboard'));
const AddCards = lazy(() => import('./components/AddCards'));
const CollectionList = lazy(() => import('./components/CollectionList'));
const LocationManager = lazy(() => import('./components/LocationManager'));
const Settings = lazy(() => import('./components/Settings'));
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const SetupWizard = lazy(() => import('./components/SetupWizard'));
const SharedCollection = lazy(() => import('./components/SharedCollection'));
const SharedContainer = lazy(() => import('./components/SharedContainer'));
const DeckBuilder = lazy(() => import('./components/DeckBuilder'));
const HowTo = lazy(() => import('./components/HowTo'));

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      // Class component, so no hook: App hands t down as a prop.
      const t = this.props.t;
      return (
        <div style={{ padding: '2rem', color: 'var(--text-strong)', background: 'rgba(255,0,0,0.1)', border: '1px solid red', borderRadius: '8px', margin: '2rem' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', color: 'var(--accent-red)' }}>{t('error.crashed')}</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff8888', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '4px', fontSize: '0.85rem' }}>{this.state.error && this.state.error.toString()}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', marginTop: '1rem', color: 'var(--text-secondary)' }}>{this.state.error && this.state.error.stack}</pre>
          <button className="btn btn-primary" style={{ marginTop: '1.5rem' }} onClick={() => window.location.reload()}>{t('error.reload')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Fallback shown while a lazily-loaded view chunk is fetched.
function ChunkFallback() {
  const { t } = useT();
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
      <div className="spinner" aria-label={t('common.loading')} />
    </div>
  );
}

// Global fetch interceptor to append authorization headers and handle 401s
const originalFetch = window.fetch;
window.fetch = function (input, options = {}) {
  // `input` may be a string, a URL, or a Request object — normalize before using string methods.
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const isPublicOrAuthRoute = url.includes('/api/shared/') || url.includes('/api/auth/login') || url.includes('/api/auth/register') || url.includes('/api/auth/bootstrap');

  const token = localStorage.getItem('manafolio_token');
  const finalOptions = { ...options };
  if (token && url.startsWith('/api/') && !isPublicOrAuthRoute) {
    finalOptions.headers = {
      ...finalOptions.headers,
      'Authorization': `Bearer ${token}`
    };
  }
  return originalFetch(input, finalOptions).then(response => {
    if (response.status === 401 && url.startsWith('/api/') && !isPublicOrAuthRoute && token === localStorage.getItem('manafolio_token')) {
      // Dispatch custom event to trigger logout without page refresh
      window.dispatchEvent(new Event('manafolio_logout'));
    }
    return response;
  });
};

function App() {
  const { t } = useT();
  const [token, setToken] = useState(localStorage.getItem('manafolio_token'));
  const [user, setUser] = useState(() => {
    try {
      const u = JSON.parse(localStorage.getItem('manafolio_user') || 'null');
      if (u) u.theme = themes.includes(u.theme) ? u.theme : 'dark';
      return u;
    } catch {
      return null;
    }
  });

  const sessionRevision = useRef(0);

  const [activeTab, setActiveTab] = useState('dashboard');
  const [moreOpen, setMoreOpen] = useState(false);
  const navRef = useRef(null);
  const moreTriggerRef = useRef(null);
  // First-run scanning setup. Asked once per session, only for an admin, and only
  // while it is genuinely incomplete — setupNeeded() reads the same endpoints the
  // wizard does so there is one definition of 'set up'.
  const [showSetup, setShowSetup] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [focusEntryId, setFocusEntryId] = useState(null);
  const [storageViewKey, setStorageViewKey] = useState(0);
  const [storageInventoryType, setStorageInventoryType] = useState('collection');
  const [deckViewKey, setDeckViewKey] = useState(0);
  const [selectedCardFilter, setSelectedCardFilter] = useState('');
  const [toast, setToast] = useState(null);
  const toastIdRef = useRef(0);
  const toastRef = useRef(null);
  const [statsTrigger, setStatsTrigger] = useState(0);

  const tabGuardRef = useRef(null);
  const navigationGuardRef = useRef(null);

  // Navigate tabs through here so each change pushes a history entry: a back
  // gesture then returns to the PREVIOUS tab (not always dashboard), and modals
  // stack their own guards on top. We never dispose the old tab guard — each
  // switch pushes a fresh entry so the back button walks through tab history.
  // Disposing with history.back() would race during rapid switches and navigate
  // the browser past the app origin into about:blank.
  const goTab = (tab, inventoryType = 'collection') => {
    if (tab !== activeTab && navigationGuardRef.current?.() === false) return false;
    if (moreOpen) moreTriggerRef.current?.focus();
    setMoreOpen(false);
    if (tab === 'storage') setStorageInventoryType(inventoryType);
    if (tab === activeTab) return true;
    const prev = activeTab;
    const prevStorageInventoryType = storageInventoryType;
    tabGuardRef.current = pushBackGuard(() => {
      if (navigationGuardRef.current?.() === false) return false;
      setMoreOpen(false);
      tabGuardRef.current = null;
      setActiveTab(prev);
      setStorageInventoryType(prevStorageInventoryType);
    });
    setActiveTab(tab);
    return true;
  };

  // Detect public share route on load
  const [shareToken] = useState(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/share\/([a-zA-Z0-9_-]+)$/);
    return match ? match[1] : null;
  });
  const [sharedContainerId] = useState(() => {
    const id = new URLSearchParams(window.location.search).get('container');
    return /^\d+$/.test(id || '') ? id : null;
  });

  // The browser value is only a first-paint cache; the account owns the theme.
  useLayoutEffect(() => {
    const selected = shareToken
      ? new URLSearchParams(window.location.search).get('theme')
      : token && user?.theme;
    const theme = themes.includes(selected) ? selected : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    if (!shareToken) {
      try { localStorage.setItem('theme', theme); } catch { /* storage may be blocked */ }
    }
  }, [token, user?.theme, shareToken]);

  // Reload the account on session restoration, including changes made on another device.
  useEffect(() => {
    if (!token || shareToken) return;
    let cancelled = false;
    const revision = sessionRevision.current;
    fetch('/api/auth/me')
      .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to fetch profile')))
      .then(data => {
        if (cancelled || revision !== sessionRevision.current || token !== localStorage.getItem('manafolio_token')) return;
        setUser(data.user);
        localStorage.setItem('manafolio_user', JSON.stringify(data.user));
      })
      .catch(err => { if (!cancelled) console.error('Session refresh failed:', err); });
    return () => { cancelled = true; };
  }, [token, shareToken]);

  const showToast = useCallback((message, kind = 'status') => {
    setToast({ id: ++toastIdRef.current, message, kind });
  }, []);

  // Handle OIDC / SSO token in URL redirect
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const oidcToken = params.get('oidc_token') || params.get('token');
      if (oidcToken && !token) {
        // Clean URL parameters immediately
        const newUrl = window.location.pathname + (window.location.hash || '');
        window.history.replaceState({}, document.title, newUrl);

        // Fetch user profile with the token to complete login
        const revision = sessionRevision.current;
        fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${oidcToken}` }
        })
          .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to fetch profile')))
          .then(data => {
            if (data.user && revision === sessionRevision.current && !localStorage.getItem('manafolio_token')) {
              sessionRevision.current += 1;
              setToken(oidcToken);
              setUser(data.user);
              localStorage.setItem('manafolio_token', oidcToken);
              localStorage.setItem('manafolio_user', JSON.stringify(data.user));
              showToast(t('toast.welcomeBack', { name: data.user.username }), 'success');
              setActiveTab('dashboard');
            }
          })
          .catch(err => {
            console.error('OIDC token verification failed:', err);
            showToast(t('login.errOidcFailed'), 'error');
          });
      }
    } catch { /* ignore URL parse error */ }
  }, [t, token, showToast]);

  useEffect(() => {
    if (!toast) return;
    let remaining = Math.max(6000, Math.min(15000, (toast.message?.length || 0) * 60));
    let startedAt;
    let timer;
    let hovered = false;
    let focused = false;
    const updateTimer = () => {
      if (timer) {
        clearTimeout(timer);
        remaining -= performance.now() - startedAt;
        timer = null;
      }
      if (document.hidden || hovered || focused) return;
      startedAt = performance.now();
      timer = setTimeout(() => setToast(current => current?.id === toast.id ? null : current), remaining);
    };
    const onEnter = (event) => { if (event.pointerType === 'mouse') { hovered = true; updateTimer(); } };
    const onLeave = () => { hovered = false; updateTimer(); };
    const onFocus = () => { focused = true; updateTimer(); };
    const onBlur = (event) => {
      if (!element?.contains(event.relatedTarget)) { focused = false; updateTimer(); }
    };
    const element = toastRef.current;
    element?.addEventListener('pointerenter', onEnter);
    element?.addEventListener('pointerleave', onLeave);
    element?.addEventListener('focusin', onFocus);
    element?.addEventListener('focusout', onBlur);
    document.addEventListener('visibilitychange', updateTimer);
    updateTimer();
    return () => {
      clearTimeout(timer);
      element?.removeEventListener('pointerenter', onEnter);
      element?.removeEventListener('pointerleave', onLeave);
      element?.removeEventListener('focusin', onFocus);
      element?.removeEventListener('focusout', onBlur);
      document.removeEventListener('visibilitychange', updateTimer);
    };
  }, [toast]);

  useEffect(() => {
    if (!moreOpen) return;
    const onOutside = (event) => {
      if (!navRef.current?.contains(event.target)) setMoreOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen]);

  // Offer first-run setup to an admin until it is finished or skipped. The flag
  // lives on the server, so closing the wizard halfway resumes it at the next
  // login on any device; everything it configures is also reachable from Settings
  // and Admin.
  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    let cancelled = false;
    import('./components/SetupWizard')
      .then(m => m.setupNeeded())
      .then(needed => { if (needed && !cancelled) setShowSetup(true); })
      .catch(() => { /* never block the app on the wizard's own probe */ });
    return () => { cancelled = true; };
  }, [user]);

  // Handle automatic logout on 401
  useEffect(() => {
    const handleAutoLogout = () => {
      if (navigationGuardRef.current?.() === false) return;
      sessionRevision.current += 1;
      setToken(null);
      setUser(null);
      localStorage.removeItem('manafolio_token');
      localStorage.removeItem('manafolio_user');
      showToast(t('toast.sessionExpired'), 'error');
    };
    window.addEventListener('manafolio_logout', handleAutoLogout);
    return () => window.removeEventListener('manafolio_logout', handleAutoLogout);
  }, [t, showToast]);


  const handleLoginSuccess = (newToken, newUser) => {
    sessionRevision.current += 1;
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('manafolio_token', newToken);
    localStorage.setItem('manafolio_user', JSON.stringify(newUser));
    showToast(t('toast.welcomeBack', { name: newUser.username }), 'success');
    setActiveTab('dashboard');
  };

  const handleLogout = () => {
    if (navigationGuardRef.current?.() === false) return;
    // Revoke token on server asynchronously
    fetch('/api/auth/logout', { method: 'POST' }).catch(err => console.error(err));

    sessionRevision.current += 1;
    setToken(null);
    setUser(null);
    localStorage.removeItem('manafolio_token');
    localStorage.removeItem('manafolio_user');
    showToast(t('toast.loggedOut'), 'success');
  };

  const handleUpdateUser = (changes) => {
    if (!token || token !== localStorage.getItem('manafolio_token')) return;
    sessionRevision.current += 1;
    setUser(current => {
      if (!current || current.id !== user.id) return current;
      const updatedUser = { ...current, ...changes };
      localStorage.setItem('manafolio_user', JSON.stringify(updatedUser));
      return updatedUser;
    });
  };

  const handleSaveTheme = async (theme) => {
    const response = await fetch('/api/auth/theme', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
    const data = await response.json();
    if (token !== localStorage.getItem('manafolio_token')) return false;
    if (!response.ok) throw new Error(data.error || t('prefs.themeError'));
    handleUpdateUser({ theme: data.theme });
    return true;
  };

  const triggerRefresh = () => {
    setStatsTrigger(prev => prev + 1);
  };

  // Render shared collection view if URL matches /share/:token. ?container=<id>
  // narrows it to one binder or box, drawn as that container rather than a list.
  if (shareToken) {
    return (
      <Suspense fallback={<ChunkFallback />}>
        {sharedContainerId
          ? <SharedContainer shareToken={shareToken} containerId={sharedContainerId} />
          : <SharedCollection shareToken={shareToken} />}
      </Suspense>
    );
  }

  const toastNotification = toast && (
    <div
      key={toast.id}
      ref={toastRef}
      className={`toast toast-${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <span className="toast-message">{toast.message}</span>
      <button type="button" className="toast-dismiss" aria-label={t('common.close')} onClick={() => setToast(null)}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );

  // Render login screen if unauthenticated
  if (!token || !user) {
    return <><Login onLoginSuccess={handleLoginSuccess} />{toastNotification}</>;
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard statsTrigger={statsTrigger} onNavigate={goTab} setSelectedLocationId={setSelectedLocationId} setFocusEntryId={setFocusEntryId} onUpdate={triggerRefresh} showToast={showToast} />;
      case 'add-cards':
        return <AddCards onAddSuccess={triggerRefresh} showToast={showToast} setActiveTab={goTab} />;
      case 'collection':
        return (
          <CollectionList 
            statsTrigger={statsTrigger} 
            onUpdate={triggerRefresh} 
            showToast={showToast} 
            token={token} 
            selectedCardFilter={selectedCardFilter}
            setSelectedCardFilter={setSelectedCardFilter}
            onNavigate={goTab}
            setSelectedLocationId={setSelectedLocationId}
            setFocusEntryId={setFocusEntryId}
          />
        );
      case 'storage':
        return (
          <LocationManager
            key={`${storageViewKey}-${storageInventoryType}`}
            inventoryType={storageInventoryType}
            onInventoryTypeChange={(inventoryType) => {
              setSelectedLocationId(null);
              setFocusEntryId(null);
              setStorageInventoryType(inventoryType);
            }}
            statsTrigger={statsTrigger}
            onUpdate={triggerRefresh}
            showToast={showToast}
            selectedLocationId={selectedLocationId}
            setSelectedLocationId={setSelectedLocationId}
            focusEntryId={focusEntryId}
            setFocusEntryId={setFocusEntryId}
          />
        );
      case 'deckbuilder':
        return <DeckBuilder key={deckViewKey} showToast={showToast} navigationGuardRef={navigationGuardRef} />;
      case 'howto':
        return <HowTo />;
      case 'settings':
        return <Settings user={user} onUpdateUser={handleUpdateUser} onSaveTheme={handleSaveTheme} showToast={showToast} />;
      case 'admin':
        return <AdminPanel user={user} onUpdateUser={handleUpdateUser} showToast={showToast} />;
      default:
        return <Dashboard statsTrigger={statsTrigger} onNavigate={goTab} setSelectedLocationId={setSelectedLocationId} setFocusEntryId={setFocusEntryId} onUpdate={triggerRefresh} showToast={showToast} />;
    }
  };

  return (
    <div className="app-container">
      {showSetup && (
        <Suspense fallback={null}>
          <SetupWizard user={user} onUpdateUser={handleUpdateUser} showToast={showToast} onClose={() => setShowSetup(false)} />
        </Suspense>
      )}
      {/* Premium Header */}
      <header className="app-header">
        <div className="logo-section">
          <h1 className="logo-text">Manafolio</h1>
          <div className="logo-icon">
            <Logo />
          </div>
          <span className="app-version">v{import.meta.env.VITE_APP_VERSION}</span>
        </div>

        {/* Navigation Tabs (Nested inside header for unified layout) */}
        <nav ref={navRef} className="nav-tabs" style={{ margin: 0 }}>
          <button 
            className={`nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
            aria-current={activeTab === 'dashboard' ? 'page' : undefined}
            onClick={() => goTab('dashboard')}
          >
            <LayoutDashboard size={18} />
            <span>{t('nav.dashboard')}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'add-cards' ? 'active' : ''}`}
            aria-current={activeTab === 'add-cards' ? 'page' : undefined}
            onClick={() => goTab('add-cards')}
          >
            <Plus size={18} />
            <span>{t('nav.addCards')}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'collection' ? 'active' : ''}`}
            aria-current={activeTab === 'collection' ? 'page' : undefined}
            onClick={() => goTab('collection')}
          >
            <Database size={18} />
            <span>{t('nav.collection')}</span>
          </button>
          <button
            className={`nav-tab ${activeTab === 'storage' ? 'active' : ''}`}
            aria-current={activeTab === 'storage' ? 'page' : undefined}
            onClick={() => {
              if (!goTab('storage')) return;
              setSelectedLocationId(null);
              setFocusEntryId(null);
              setStorageViewKey(key => key + 1);
            }}
          >
            <MapPin size={18} />
            <span>{t('nav.storage')}</span>
          </button>
          <button
            ref={moreTriggerRef}
            type="button"
            className={`nav-tab nav-more-trigger ${['deckbuilder', 'howto', 'settings', 'admin'].includes(activeTab) ? 'active' : ''}`}
            aria-expanded={moreOpen}
            aria-controls="nav-secondary"
            onClick={() => setMoreOpen(open => !open)}
          >
            <MoreHorizontal size={18} aria-hidden="true" />
            <span>{t('nav.more')}</span>
          </button>
          <div id="nav-secondary" className={`nav-secondary ${moreOpen ? 'is-open' : ''}`}>
            <button
              className={`nav-tab ${activeTab === 'deckbuilder' ? 'active' : ''}`}
              aria-current={activeTab === 'deckbuilder' ? 'page' : undefined}
              onClick={() => {
                if (activeTab === 'deckbuilder' && navigationGuardRef.current?.() === false) return;
                if (goTab('deckbuilder')) setDeckViewKey(key => key + 1);
              }}
            >
              <Swords size={18} />
              <span>{t('nav.deckBuilder')}</span>
            </button>

            <button
              className={`nav-tab ${activeTab === 'howto' ? 'active' : ''}`}
              aria-current={activeTab === 'howto' ? 'page' : undefined}
              onClick={() => goTab('howto')}
            >
              <BookOpen size={18} aria-hidden="true" />
              <span style={{ whiteSpace: 'nowrap' }}>{t('nav.howto')}</span>
            </button>

            <button
              className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              onClick={() => goTab('settings')}
            >
              <SettingsIcon size={18} />
              <span>{t('nav.settings')}</span>
            </button>
            {user.role === 'admin' && (
              <button
                className={`nav-tab ${activeTab === 'admin' ? 'active' : ''}`}
                aria-current={activeTab === 'admin' ? 'page' : undefined}
                onClick={() => goTab('admin')}
              >
                <ShieldAlert size={18} style={{ color: 'var(--accent-red)' }} />
                <span>{t('nav.admin')}</span>
              </button>
            )}
          </div>
        </nav>

        <div className="header-account" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div className="header-greeting" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            <span>{t('header.greeting')} <strong style={{ color: 'var(--text-strong)' }}>{user.username}</strong> ({t(`role.${user.role}`)})</span>
          </div>
          <button
            onClick={handleLogout}
            className="btn btn-secondary btn-icon-only"
            title={t('header.logOut')}
            aria-label={t('header.logOut')}
            style={{ padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ flex: 1, marginTop: '1rem' }}>
        {/* key on activeTab remounts the boundary per tab, so a crash in one
            view clears when you navigate away instead of persisting until a
            manual reload. */}
        <ErrorBoundary key={activeTab} t={t}>
          <div className="view-transition">
            <Suspense fallback={<ChunkFallback />}>
              {renderContent()}
            </Suspense>
          </div>
        </ErrorBoundary>
      </main>

      {toastNotification}
    </div>
  );
}

export default App;
