import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useT } from '../utils/i18n';

const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' };
const EFFORT_KEYS = {
  none: 'aiDeck.effortNone', minimal: 'aiDeck.effortMinimal', low: 'aiDeck.effortLow',
  medium: 'aiDeck.effortMedium', high: 'aiDeck.effortHigh', xhigh: 'aiDeck.effortXhigh',
};

async function request(path, options, fallback) {
  const response = await fetch(`/api/ai-decks${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

export default function CodexSettings() {
  const { t } = useT();
  const [account, setAccount] = useState(null);
  const [login, setLogin] = useState(null);
  const [accountError, setAccountError] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [checkedOllamaUrl, setCheckedOllamaUrl] = useState(undefined);
  const [preferences, setPreferences] = useState(null);
  const [preferencesError, setPreferencesError] = useState('');
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const lifetime = useRef(null);
  const providerSession = useRef(null);
  const provider = preferences?.provider;
  const isOllama = provider === 'ollama';

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPreferencesError('');
    setSaved(false);
    request('/preferences', { signal: controller.signal }, t('codexSettings.errPreferences'))
      .then(data => {
        if (controller.signal.aborted) return;
        setPreferences(current => current || data);
        setCheckedOllamaUrl(current => current === undefined ? data.ollama_url || '' : current);
      })
      .catch(err => { if (!controller.signal.aborted) setPreferencesError(err.message); });
    return () => controller.abort();
  }, [preferencesRevision, t]);

  useEffect(() => {
    if (!provider || (provider === 'ollama' && typeof checkedOllamaUrl !== 'string')) return;
    const controller = new AbortController();
    const { signal } = controller;
    providerSession.current = controller;
    setAccount(null);
    setAccountError('');
    setAccountBusy(false);
    setAccountLoading(true);
    setModels([]);
    setModelsError('');
    setModelsLoading(false);
    const query = new URLSearchParams({ provider });
    if (provider === 'ollama') query.set('ollama_url', checkedOllamaUrl);
    const load = async () => {
      let data;
      try {
        data = await request(`/account?${query}`, { signal }, t('aiDeck.errAccount'));
        if (signal.aborted) return;
        setAccount(data);
        if (provider === 'ollama' && !data.connected) throw new Error(t('codexSettings.ollamaUnavailable'));
      } catch (err) {
        if (!signal.aborted) setAccountError(err.message);
      } finally {
        if (!signal.aborted) setAccountLoading(false);
      }
      if ((!data?.connected && provider !== 'ollama') || signal.aborted) return;
      setModelsLoading(true);
      try {
        const result = await request(`/models?${query}`, { signal }, t('aiDeck.errModels'));
        if (signal.aborted) return;
        if (!result.models.length) throw new Error(t('aiDeck.emptyModels'));
        setModels(result.models);
      } catch (err) {
        if (!signal.aborted) setModelsError(err.message);
      } finally {
        if (!signal.aborted) setModelsLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [provider, checkedOllamaUrl, connectionRevision, t]);

  useEffect(() => {
    if (!login || provider !== 'chatgpt') return;
    const session = providerSession.current.signal;
    const controller = new AbortController();
    let timer;
    const timeout = setTimeout(() => {
      controller.abort();
      clearTimeout(timer);
      if (session.aborted) return;
      setLogin(null);
      setAccountError(t('aiDeck.loginExpired'));
    }, Math.max(0, login.expiresAt - Date.now()));
    const poll = async () => {
      if (controller.signal.aborted || session.aborted) return;
      try {
        const data = await request('/account?provider=chatgpt', { signal: controller.signal }, t('aiDeck.errAccount'));
        if (controller.signal.aborted || session.aborted) return;
        setAccount(data);
        setAccountError('');
        if (data.connected) { setLogin(null); setConnectionRevision(value => value + 1); return; }
      } catch (err) {
        if (controller.signal.aborted || session.aborted) return;
        setAccountError(err.message);
      }
      timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 1500);
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(timeout); };
  }, [login, provider, t]);

  const handleAccount = async (disconnect = false) => {
    if (provider !== 'chatgpt' || accountBusy || accountLoading || saving) return;
    setAccountBusy(true);
    setAccountError('');
    const signal = providerSession.current.signal;
    if (disconnect) setLogin(null);
    try {
      const data = await request(disconnect ? '/account' : '/account/login', {
        method: disconnect ? 'DELETE' : 'POST', signal,
      }, t('aiDeck.errAccount'));
      if (signal.aborted) return;
      if (disconnect) { setAccount({ provider: 'chatgpt', connected: false }); setModels([]); }
      else setLogin({ ...data, expiresAt: Date.now() + 10 * 60 * 1000 });
    } catch (err) {
      if (!signal.aborted) setAccountError(err.message);
    } finally {
      if (!signal.aborted) setAccountBusy(false);
    }
  };

  const changeProvider = event => {
    providerSession.current?.abort();
    setLogin(null);
    setAccount(null);
    setAccountError('');
    setAccountBusy(false);
    setAccountLoading(false);
    setModels([]);
    setModelsError('');
    setModelsLoading(false);
    setPreferences(current => ({ ...current, provider: event.target.value, model: null, reasoning_effort: null }));
    setSaved(false);
    setSaveError('');
  };

  const changeOllamaUrl = event => {
    providerSession.current?.abort();
    setCheckedOllamaUrl(null);
    setPreferences(current => ({ ...current, ollama_url: event.target.value, model: null, reasoning_effort: null }));
    setAccount(null);
    setAccountError('');
    setAccountLoading(false);
    setModels([]);
    setModelsError('');
    setModelsLoading(false);
    setSaved(false);
    setSaveError('');
  };

  const checkConnection = () => {
    providerSession.current?.abort();
    if (isOllama) setCheckedOllamaUrl(preferences.ollama_url || '');
    setConnectionRevision(value => value + 1);
  };

  const providerDefault = models.find(model => model.isDefault) || models[0];
  const selectedModel = preferences?.model ? models.find(model => model.id === preferences.model) : isOllama ? null : providerDefault;
  const staleModel = models.length > 0 && !!preferences?.model && !selectedModel;
  const staleEffort = !!selectedModel && !!preferences?.reasoning_effort && !selectedModel.reasoningEfforts.includes(preferences.reasoning_effort);
  const defaultEffort = selectedModel?.reasoningEfforts.includes(selectedModel.defaultReasoningEffort)
    ? selectedModel.defaultReasoningEffort : selectedModel?.reasoningEfforts[0];
  const effortLabel = effort => EFFORT_KEYS[effort] ? t(EFFORT_KEYS[effort]) : effort;
  const canSave = account?.connected && preferences && selectedModel && (!isOllama || typeof checkedOllamaUrl === 'string') && !accountBusy && !accountLoading && !saving && !modelsLoading && !modelsError && !staleEffort;

  const save = async event => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaved(false);
    setSaveError('');
    const signal = lifetime.current.signal;
    try {
      const data = await request('/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify(preferences),
      }, t('codexSettings.errSave'));
      if (signal.aborted) return;
      setPreferences(data);
      setSaved(true);
    } catch (err) {
      if (!signal.aborted) setSaveError(err.message);
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  };

  return (
    <section className="glass-panel" aria-labelledby="codex-settings-title" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: 0 }}>
      <div style={{ ...rowStyle, borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
        <Sparkles size={20} style={{ color: 'var(--accent-yellow)' }} aria-hidden="true" />
        <h3 id="codex-settings-title" style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('codexSettings.title')}</h3>
      </div>
      <div className="form-group">
        <label htmlFor="ai-provider">{t('codexSettings.provider')}</label>
        <select id="ai-provider" className="input-control" value={provider || ''} disabled={!preferences || saving} onChange={changeProvider}>
          {!provider && <option value="">{t('common.loading')}</option>}
          <option value="chatgpt">ChatGPT</option>
          <option value="ollama">Ollama</option>
        </select>
      </div>
      {provider && <>
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{t(isOllama ? 'codexSettings.ollamaHint' : 'aiDeck.accountHint')}</p>
      {isOllama && (
        <div className="form-group">
          <label htmlFor="ai-ollama-url">{t('codexSettings.ollamaUrl')}</label>
          <input id="ai-ollama-url" type="url" className="input-control" value={preferences.ollama_url || ''} placeholder="http://127.0.0.1:11434" maxLength={2048} disabled={saving} onChange={changeOllamaUrl} aria-describedby="ai-ollama-url-hint" />
          <p id="ai-ollama-url-hint" style={{ color: 'var(--text-secondary)', margin: 0 }}>{t('codexSettings.ollamaUrlHint')}</p>
        </div>
      )}
      <h4>{isOllama ? 'Ollama' : t('aiDeck.accountTitle')}</h4>
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{t(isOllama ? 'codexSettings.ollamaPrivacy' : 'aiDeck.privacy')}</p>
      <div style={rowStyle}>
        <span role="status">{account?.connected ? t('aiDeck.connected') : isOllama && checkedOllamaUrl === null ? t('codexSettings.checkRequired') : account === null && !accountError ? t('common.loading') : t('aiDeck.disconnected')}{!isOllama && account?.connected && account.email ? ` · ${account.email}` : ''}</span>
        {isOllama ? (
          <button type="button" className="btn btn-secondary" disabled={accountLoading || modelsLoading || saving} onClick={checkConnection}>
            {t(accountLoading ? 'common.loading' : accountError ? 'aiDeck.retry' : 'codexSettings.checkConnection')}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={accountBusy || accountLoading || saving || !!login} onClick={() => handleAccount(!!account?.connected)}>
            {accountBusy ? t('common.loading') : t(account?.connected ? 'aiDeck.disconnect' : 'aiDeck.connect')}
          </button>
        )}
      </div>
      {!isOllama && login && (
        <div style={{ overflowWrap: 'anywhere' }}>
          <p>{t('aiDeck.loginInstructions')}</p>
          <a href={/^https:\/\//i.test(login.verificationUrl) ? login.verificationUrl : undefined} target="_blank" rel="noopener noreferrer">{login.verificationUrl}</a>
          <p>{t('aiDeck.userCode')}: <code style={{ fontSize: '1.3rem', userSelect: 'all' }}>{login.userCode}</code></p>
          <p role="status">{t('aiDeck.waiting')}</p>
          <button type="button" className="btn btn-secondary" disabled={accountBusy} onClick={() => handleAccount(true)}>{t('common.cancel')}</button>
        </div>
      )}
      {accountError && <p role="alert" style={{ color: 'var(--status-error)' }}>{accountError}</p>}
      </>}
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{t('codexSettings.hint')}</p>
      {!preferences && !preferencesError && <p role="status">{t('common.loading')}</p>}
      {preferencesError && <p role="alert" style={{ color: 'var(--status-error)' }}>{preferencesError} <button type="button" className="btn btn-secondary" onClick={() => setPreferencesRevision(value => value + 1)}>{t('aiDeck.retry')}</button></p>}
      {account?.connected && preferences && (
        <form onSubmit={save}>
          <fieldset disabled={accountBusy || saving || modelsLoading || !models.length} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div style={{ ...rowStyle, alignItems: 'start' }}>
              <div className="form-group" style={{ flex: '1 1 180px', minWidth: 0 }}>
                <label htmlFor="ai-model">{t('aiDeck.model')}</label>
                <select id="ai-model" className="input-control" value={preferences.model || ''} onChange={event => {
                  setPreferences(current => ({ ...current, model: event.target.value || null, reasoning_effort: null }));
                  setSaved(false);
                  setSaveError('');
                }}>
                  <option value="">{isOllama ? t('codexSettings.chooseModel') : `${t('codexSettings.providerDefault')}${providerDefault ? ` · ${providerDefault.name}` : ''}`}</option>
                  {preferences.model && !models.some(model => model.id === preferences.model) && <option value={preferences.model}>{preferences.model}</option>}
                  {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </div>
              {!isOllama && <div className="form-group" style={{ flex: '1 1 180px', minWidth: 0 }}>
                <label htmlFor="ai-effort">{t('aiDeck.thinkingLevel')}</label>
                <select id="ai-effort" className="input-control" value={preferences.reasoning_effort || ''} disabled={!preferences.model || !selectedModel || (!selectedModel.reasoningEfforts.length && !staleEffort)} onChange={event => {
                  setPreferences(current => ({ ...current, reasoning_effort: event.target.value || null }));
                  setSaved(false);
                  setSaveError('');
                }}>
                  <option value="">{t('aiDeck.modelDefault')}{defaultEffort ? ` · ${effortLabel(defaultEffort)}` : ''}</option>
                  {preferences.reasoning_effort && !selectedModel?.reasoningEfforts.includes(preferences.reasoning_effort) && <option value={preferences.reasoning_effort}>{effortLabel(preferences.reasoning_effort)}</option>}
                  {selectedModel?.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
                </select>
              </div>}
            </div>
            <button type="submit" className="btn btn-primary" disabled={!canSave}>{t(saving ? 'common.loading' : 'codexSettings.save')}</button>
          </fieldset>
          {staleModel && <p role="alert" style={{ color: 'var(--status-error)' }}>{t('codexSettings.staleModel')}</p>}
          {staleEffort && <p role="alert" style={{ color: 'var(--status-error)' }}>{t('codexSettings.staleEffort')}</p>}
        </form>
      )}
      {modelsLoading && <p role="status">{t('aiDeck.loadingModels')}</p>}
      {modelsError && <p role="alert" style={{ color: 'var(--status-error)' }}>{modelsError} <button type="button" className="btn btn-secondary" disabled={accountBusy || accountLoading || saving} onClick={checkConnection}>{t('aiDeck.retry')}</button></p>}
      {saveError && <p role="alert" style={{ color: 'var(--status-error)' }}>{saveError}</p>}
      {saved && <p role="status">{t('codexSettings.saved')}</p>}
    </section>
  );
}
