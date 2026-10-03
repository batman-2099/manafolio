import { useState, useEffect, useRef } from 'react';
import { User, Lock, ArrowRight, Eye, EyeOff, Shield, ShieldAlert } from 'lucide-react';
import { useT } from '../utils/i18n';
import Logo from './Logo';

// Must match OWNER_USERNAME in backend/src/routes/auth.js — the bootstrap route
// ignores whatever username is posted and always creates `admin`.
const OWNER_USERNAME = 'admin';

function Login({ onLoginSuccess, pendingContainer }) {
  const { t } = useT();
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mismatchSubmitted, setMismatchSubmitted] = useState(false);
  const confirmPasswordRef = useRef(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const oidcErr = params.get('oidc_error');
      if (oidcErr) {
        // Clean URL parameter without reloading
        window.history.replaceState({}, document.title, window.location.pathname);
        return oidcErr;
      }
    } catch { /* ignore */ }
    return '';
  });
  const [loading, setLoading] = useState(false);
  // Whether open self-registration is allowed (invite-only by default). Drives
  // whether the Sign Up option is shown at all.
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  // A server with no accounts at all: the form creates the owner account instead
  // of signing in, so nobody has to dig a generated password out of the logs.
  const [setupRequired, setSetupRequired] = useState(false);
  // OIDC / SSO status
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcProviderName, setOidcProviderName] = useState('Single Sign-On');

  useEffect(() => {
    let cancelled = false, tries = 0;
    // Retry transient network failures and refetch when the browser tab resumes.
    const load = () => {
      fetch('/api/auth/config')
        .then(res => res.ok ? res.json() : Promise.reject(new Error('config unreachable')))
        .then(data => {
          if (cancelled) return;
          setRegistrationEnabled(!!data.registrationEnabled);
          setSetupRequired(!!data.setupRequired);
          setOidcEnabled(!!data.oidcEnabled);
          if (data.oidcProviderName) setOidcProviderName(data.oidcProviderName);
          // The owner account's name is the server's to decide, not the
          // visitor's — see the bootstrap route. Shown read-only rather than
          // hidden, because it is the name they will log in with next time.
          if (data.setupRequired) setUsername(OWNER_USERNAME);
        })
        .catch(() => { if (!cancelled && tries++ < 5) setTimeout(load, 1500); });
    };
    load();
    const onVis = () => { if (document.visibilityState === 'visible') { tries = 0; load(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // Creating an account (first-run owner, or self-registration) asks for the
  // password twice and validates it; signing in does neither.
  const creating = isRegister || setupRequired;
  const passwordMismatch = creating && mismatchSubmitted && password !== confirmPassword;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    // Browser password managers parse the form when the submit lands, and they
    // need to find an <input type="password"> to offer to save anything. Someone
    // who left "show password" on would otherwise submit a plain text field and
    // never get the save prompt — so the reveal always closes on submit.
    setShowPassword(false);

    setLoading(true);

    if (creating) {
      if (username.length < 3) {
        setError(t('login.errUsernameShort', { count: 3 }));
        setLoading(false);
        return;
      }
      if (password.length < 8) {
        setError(t('login.errPasswordShort', { count: 8 }));
        setLoading(false);
        return;
      }
      if (password !== confirmPassword) {
        setMismatchSubmitted(true);
        confirmPasswordRef.current?.focus();
        setLoading(false);
        return;
      }
    }

    const endpoint = setupRequired ? '/api/auth/bootstrap'
      : isRegister ? '/api/auth/register'
        : '/api/auth/login';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('login.errFailed'));
      }

      onLoginSuccess(data.token, data.user);
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100dvh',
      boxSizing: 'border-box',
      padding: 'calc(1rem + env(safe-area-inset-top, 0px)) 1rem calc(1rem + env(safe-area-inset-bottom, 0px)) 1rem'
    }}>
      <div className="login-form" style={{ maxWidth: '420px', width: '100%' }}>
        <header style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <div style={{ width: '48px', height: '48px', flexShrink: 0 }}><Logo /></div>
            <span style={{ fontSize: '1.25rem', fontWeight: 700 }} translate="no">Manafolio</span>
            <span className="app-version">v{import.meta.env.VITE_APP_VERSION}</span>
          </div>
          <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.5rem' }}>
            {t(setupRequired ? 'login.setupSubmit' : isRegister ? 'login.register' : 'login.signIn')}
          </h1>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            {t(setupRequired ? 'login.setupTagline' : isRegister ? 'login.taglineRegister' : 'login.taglineLogin')}
          </p>
        </header>

        {setupRequired && (
          <div style={{
            marginBottom: '1.5rem',
            fontSize: '0.9375rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.5
          }}>
            {t('login.setupNote')}
          </div>
        )}

        {error && (
          <div role="alert" style={{
            padding: '0.75rem 1rem',
            border: '1px solid var(--accent-red)',
            color: 'var(--accent-red)',
            fontSize: '0.875rem',
            marginBottom: '1.5rem',
            borderRadius: 'var(--radius-sm)'
          }}>
            {error}
          </div>
        )}

        {oidcEnabled && !setupRequired && !isRegister && (
          <div style={{ marginBottom: '1.25rem' }}>
            <a
              href="/api/auth/oidc/login"
              onClick={() => {
                try {
                  if (pendingContainer) sessionStorage.setItem('manafolio_login_container', pendingContainer);
                  else sessionStorage.removeItem('manafolio_login_container');
                } catch { /* local sign-in retains the URL when browser storage is unavailable */ }
              }}
              className="btn btn-secondary"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.6rem',
                padding: '0.75rem 1rem',
                width: '100%',
                boxSizing: 'border-box',
                fontSize: '0.95rem',
                fontWeight: 600,
                borderRadius: 'var(--radius-sm)',
                textDecoration: 'none',
                cursor: 'pointer'
              }}
            >
              <Shield size={18} style={{ color: 'var(--accent-red)' }} />
              <span>{t('login.oidcLogin', { provider: oidcProviderName })}</span>
            </a>

            <div style={{ display: 'flex', alignItems: 'center', margin: '1.25rem 0 0.25rem 0', gap: '0.75rem' }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--border-glass)' }} />
              <span style={{ fontSize: '0.9375rem', color: 'var(--text-secondary)' }}>
                {t('login.orDivider')}
              </span>
              <div style={{ flex: 1, height: '1px', background: 'var(--border-glass)' }} />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="login-username">{t('login.username')}</label>
            <div style={{ position: 'relative' }}>
              <input
                id="login-username"
                type="text"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                className="input-control"
                style={{ width: '100%', paddingLeft: '2.5rem' }}
                placeholder={t('login.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                // readOnly, never disabled: a disabled field is dropped from the
                // form, so a password manager inspecting it mid-submit sees no
                // username to save. Read-only still blocks typing.
                readOnly={setupRequired || loading}
              />
              <User size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="login-password">{t('login.password')}</label>
            <div style={{ position: 'relative' }}>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete={creating ? 'new-password' : 'current-password'}
                className="input-control"
                style={{ width: '100%', paddingLeft: '2.5rem', paddingRight: '2.5rem' }}
                placeholder={t('login.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                readOnly={loading}
              />
              <Lock size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={t(showPassword ? 'login.hidePassword' : 'login.showPassword')}
                aria-pressed={showPassword}
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  minWidth: '44px',
                  minHeight: '44px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {creating && (
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="login-confirm-password">{t('login.confirmPassword')}</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="login-confirm-password"
                  ref={confirmPasswordRef}
                  aria-invalid={passwordMismatch || undefined}
                  aria-describedby={passwordMismatch ? 'login-confirm-error' : undefined}
                  type={showPassword ? 'text' : 'password'}
                  name="confirm-password"
                  autoComplete="new-password"
                  className="input-control"
                  style={{ width: '100%', paddingLeft: '2.5rem', borderColor: passwordMismatch ? 'var(--accent-red)' : undefined }}
                  placeholder={t('login.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  readOnly={loading}
                />
                <Lock size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              </div>
              {passwordMismatch && (
                <p id="login-confirm-error" role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-red)', fontSize: '0.875rem', margin: '0.5rem 0 0' }}>
                  <ShieldAlert size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                  {t('login.errPasswordMismatch')}
                </p>
              )}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{
              padding: '0.75rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              fontSize: '1rem',
              fontWeight: 700
            }}
            disabled={loading}
          >
            <span>{t(setupRequired ? 'login.setupSubmit' : isRegister ? 'login.register' : 'login.login')}</span>
            {loading
              ? <span className="spinner" aria-hidden="true" style={{ width: '16px', height: '16px', margin: 0, borderWidth: '2px' }} />
              : <ArrowRight size={16} aria-hidden="true" />}
          </button>
        </form>

        {registrationEnabled && !setupRequired && (
          <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t(isRegister ? 'login.haveAccount' : 'login.noAccount')}{' '}
            <button
              onClick={() => {
                setIsRegister(!isRegister);
                setError('');
                setPassword('');
                setConfirmPassword('');
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-red)',
                fontWeight: 600,
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: '0 2px'
              }}
              disabled={loading}
            >
              {t(isRegister ? 'login.signIn' : 'login.signUp')}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default Login;
