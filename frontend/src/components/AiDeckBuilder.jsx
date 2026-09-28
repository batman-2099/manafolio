import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import { useT } from '../utils/i18n';
import { readProgressStream } from '../utils/importStream';
import MultiSelectDropdown from './MultiSelectDropdown';
import CardImage from './CardImage';
import RelatedTokens from './RelatedTokens';

const FORMATS = {
  collection: ['Commander / EDH', 'Standard', 'Modern', 'Pioneer', 'Legacy', 'Vintage', 'Pauper', 'Casual'],
  arena: ['Standard', 'Alchemy', 'Historic', 'Explorer', 'Timeless', 'Brawl', 'Casual'],
};
const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' };
const fieldsetStyle = { border: 0, padding: 0, margin: 0, minWidth: 0 };
const printingLabel = card => `${card.name} · ${card.set_name || '—'} #${card.number || '—'} · ${card.id}`;
const EFFORT_KEYS = {
  none: 'aiDeck.effortNone', minimal: 'aiDeck.effortMinimal', low: 'aiDeck.effortLow',
  medium: 'aiDeck.effortMedium', high: 'aiDeck.effortHigh', xhigh: 'aiDeck.effortXhigh',
};
const PROGRESS_STAGES = new Set([
  'inventory', 'inventory_ready', 'catalog', 'request_ready', 'connecting',
  'model_ready', 'generating', 'waiting', 'response_received', 'validating',
]);

async function request(path, options, fallback) {
  const response = await fetch(`/api/ai-decks${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

export default function AiDeckBuilder({ sourceDeck = null, onClose, onSaved, onPreview }) {
  const { t, locale } = useT();
  const [account, setAccount] = useState(null);
  const [accountError, setAccountError] = useState('');
  const [inventoryType, setInventoryType] = useState(sourceDeck?.inventory_type || 'collection');
  const [includeCheckedOut, setIncludeCheckedOut] = useState(false);
  const [containerIds, setContainerIds] = useState([]);
  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [locationsError, setLocationsError] = useState('');
  const [locationsRevision, setLocationsRevision] = useState(0);
  const inventoryController = useRef(null);
  const [inventory, setInventory] = useState([]);
  const [colors, setColors] = useState([]);
  const [sets, setSets] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState('');
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [format, setFormat] = useState(sourceDeck?.format || 'Commander / EDH');
  const [targetSize, setTargetSize] = useState(sourceDeck?.target_size || 100);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState('');
  const saveInFlight = useRef(false);
  const [error, setError] = useState('');
  const [generationLog, setGenerationLog] = useState([]);
  const logContainer = useRef(null);
  const conversationContainer = useRef(null);
  const followLog = useRef(true);
  const logId = useRef(0);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }), [locale]);
  const lifetime = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (followLog.current && logContainer.current) logContainer.current.scrollTop = logContainer.current.scrollHeight;
  }, [generationLog]);

  useEffect(() => {
    if (conversationContainer.current) conversationContainer.current.scrollTop = conversationContainer.current.scrollHeight;
  }, [messages]);

  const appendGenerationLog = event => {
    const entry = { id: ++logId.current, time: Date.now(), stage: event.stage };
    for (const field of ['printings', 'availableCopies', 'bytes', 'elapsedSeconds']) {
      entry[field] = Number.isSafeInteger(event[field]) && event[field] >= 0 ? event[field] : '—';
    }
    if (event.stage === 'model_ready') {
      entry.model = typeof event.model === 'string' && /^[\w.:/-]{1,120}$/.test(event.model) ? event.model : '';
      entry.effort = Object.hasOwn(EFFORT_KEYS, event.reasoning_effort) ? event.reasoning_effort : '';
    }
    // ponytail: retain the latest 200 public statuses, not a second generation history.
    setGenerationLog(entries => [...entries.slice(-199), entry]);
  };

  useEffect(() => {
    const controller = new AbortController();
    request('/account', { signal: controller.signal }, t('aiDeck.errAccount'))
      .then(data => { if (!controller.signal.aborted) setAccount(data); })
      .catch(err => { if (!controller.signal.aborted) setAccountError(err.message); });
    return () => controller.abort();
  }, [t]);

  useEffect(() => {
    if (inventoryType !== 'collection') return;
    const controller = new AbortController();
    setLocationsLoading(true);
    setLocationsError('');
    fetch('/api/locations', { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('aiDeck.errContainers'));
        if (!controller.signal.aborted) setLocations(data);
      })
      .catch(err => { if (!controller.signal.aborted) setLocationsError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLocationsLoading(false); });
    return () => controller.abort();
  }, [inventoryType, locationsRevision, t]);

  useEffect(() => {
    const controller = new AbortController();
    inventoryController.current = controller;
    setInventoryLoading(true);
    setInventoryError('');
    setInventory([]);
    setDraft(null);
    setMessages([]);
    setPrompt('');
    setGenerationLog([]);
    setError('');
    const params = new URLSearchParams({ inventory_type: inventoryType });
    if (inventoryType === 'collection' && containerIds.length) params.set('container_ids', containerIds.join(','));
    if (sourceDeck?.id) params.set('source_deck_id', sourceDeck.id);
    if (inventoryType === 'collection') params.set('include_checked_out', String(includeCheckedOut));
    request(`/inventory?${params}`, { signal: controller.signal }, t('aiDeck.errInventory'))
      .then(data => { if (!controller.signal.aborted) setInventory(data.cards); })
      .catch(err => { if (!controller.signal.aborted) setInventoryError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setInventoryLoading(false); });
    return () => controller.abort();
  }, [inventoryType, containerIds, includeCheckedOut, sourceDeck?.id, inventoryRevision, t]);

  const colorOptions = useMemo(() => Array.from(new Set([...colors, ...inventory.flatMap(card =>
    card.color_identity.length ? card.color_identity : card.color_identity_known ? ['Colorless'] : []
  )])).sort().map(color => ({ value: color, label: color === 'Colorless' ? t('inspector.colorless') : color })), [inventory, colors, t]);
  const setOptions = useMemo(() => Array.from(new Map([
    ...sets.map(id => [id, { value: id, label: id }]),
    ...inventory.filter(card => card.set_id).map(card => [
      card.set_id, { value: card.set_id, label: `${card.set_name || card.set_id} (${card.set_id})` },
    ]),
  ]).values()).sort((a, b) => a.label.localeCompare(b.label, locale)), [inventory, sets, locale]);
  const containerOptions = useMemo(() => locations.map(location => ({
    value: location.id, label: location.name,
  })).sort((a, b) => a.label.localeCompare(b.label, locale)), [locations, locale]);
  const filteredInventory = useMemo(() => inventory.flatMap(card => {
    const matchesFilters = (sets.length === 0 || sets.includes(card.set_id))
      && (colors.length === 0 || colors.some(color => color === 'Colorless'
        ? card.color_identity_known && card.color_identity.length === 0
        : card.color_identity.includes(color)));
    if (matchesFilters) return [card];
    return card.source_qty > 0 ? [{ ...card, available_qty: Math.min(card.available_qty, card.source_qty) }] : [];
  }), [inventory, colors, sets]);
  const cardById = useMemo(() => new Map(filteredInventory.map(card => [String(card.id), card])), [filteredInventory]);
  const counts = useMemo(() => filteredInventory.reduce((sum, card) => ({
    owned: sum.owned + card.owned_qty, available: sum.available + card.available_qty, locked: sum.locked + card.locked_qty,
  }), { owned: 0, available: 0, locked: 0 }), [filteredInventory]);
  const total = (draft?.cards || []).reduce((sum, card) => sum + Number(card.quantity), 0);
  const invalidCards = draft?.cards.some(card => !Number.isInteger(card.quantity) || card.quantity < 1 || card.quantity > (cardById.get(String(card.card_id))?.available_qty || 0));
  const isCommander = /commander|edh|brawl/i.test(format);
  const saveDisabled = !!busy || inventoryLoading || !!inventoryError || !draft || !draft.name.trim() || draft.cards.length === 0 || total !== Number(targetSize) || invalidCards || (isCommander && !draft.commander_card_id);
  const conversationFull = messages.length >= 40;
  const needsMessage = messages.length > 0 || !!draft;

  const restartConversation = () => { setMessages([]); setError(''); setGenerationLog([]); };
  const clearDraft = () => { setDraft(null); restartConversation(); setPrompt(''); };
  const clearInventory = () => {
    inventoryController.current?.abort();
    setInventoryLoading(true);
    setInventoryError('');
    setInventory([]);
    clearDraft();
  };
  const changeQuantity = (id, quantity) => setDraft(current => ({
    ...current, cards: current.cards.map(card => String(card.card_id) === id ? { ...card, quantity } : card),
  }));
  const removeCard = id => setDraft(current => ({
    ...current,
    commander_card_id: String(current.commander_card_id) === id ? null : current.commander_card_id,
    cards: current.cards.filter(card => String(card.card_id) !== id),
  }));

  const generate = async event => {
    event.preventDefault();
    if (busy || !account?.connected || inventoryLoading || inventoryController.current?.signal.aborted || inventoryError) return;
    if (conversationFull) { setError(t('aiDeck.conversationFull')); return; }
    if (prompt.length > 4000) { setError(t('aiDeck.promptLimit')); return; }
    if (needsMessage && !prompt.trim()) return;
    const content = prompt.trim() || t(sourceDeck ? 'aiDeck.defaultImprove' : 'aiDeck.defaultGenerate');
    setBusy('generate');
    setError('');
    setGenerationLog([]);
    followLog.current = true;
    appendGenerationLog({ stage: 'requesting' });
    const signal = lifetime.current.signal;
    try {
      const response = await fetch('/api/ai-decks/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, signal,
        body: JSON.stringify({
          inventory_type: inventoryType, format, target_size: targetSize, prompt: content, colors, sets,
          messages,
          current_draft: draft ? {
            name: draft.name, description: draft.description, commander_card_id: draft.commander_card_id,
            cards: draft.cards.map(({ card_id, quantity }) => ({ card_id, quantity })),
            inventory_type: inventoryType, format, target_size: targetSize,
          } : null,
          include_checked_out: inventoryType === 'collection' && includeCheckedOut,
          ...(inventoryType === 'collection' ? { container_ids: containerIds } : {}),
          ...(sourceDeck ? { source_deck_id: sourceDeck.id } : {}),
        }),
      });
      const data = await readProgressStream(response, event => {
        if (!signal.aborted && PROGRESS_STAGES.has(event.stage)) appendGenerationLog(event);
      }, {
        failed: t('aiDeck.errSuggest'),
        incomplete: t('aiDeckLog.incomplete'),
        invalid: t('aiDeckLog.invalid'),
      });
      if (signal.aborted) return;
      if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 8000
        || (data.draft !== null && (!data.draft || !Array.isArray(data.draft.cards)))) {
        throw new Error(t('aiDeckLog.invalid'));
      }
      if (data.draft !== null) setDraft(data.draft);
      setMessages(current => [...current, { role: 'user', content }, { role: 'assistant', content: data.message }]);
      setPrompt('');
      appendGenerationLog({ stage: 'complete' });
    } catch (err) {
      if (!signal.aborted) {
        setError(err.message);
        appendGenerationLog({ stage: 'failed' });
      }
    } finally {
      if (!signal.aborted) setBusy('');
    }
  };

  const save = async event => {
    event.preventDefault();
    if (saveInFlight.current || saveDisabled || inventoryController.current?.signal.aborted || !event.currentTarget.checkValidity()) return;
    const replace = !!sourceDeck && event.nativeEvent.submitter?.value === 'replace';
    if (replace && sourceDeck.checked_out) { setError(t('aiDeck.returnBeforeSave')); return; }
    saveInFlight.current = true;
    setBusy('save');
    setError('');
    const signal = lifetime.current.signal;
    try {
      const data = await request(replace ? `/${sourceDeck.id}` : '', {
        method: replace ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({
          name: draft.name, description: draft.description, inventory_type: inventoryType,
          include_checked_out: inventoryType === 'collection' && includeCheckedOut,
          ...(sourceDeck ? { source_deck_id: sourceDeck.id } : {}),
          format, target_size: targetSize, commander_card_id: isCommander ? draft.commander_card_id : null,
          cards: draft.cards,
        }),
      }, t('aiDeck.errSave'));
      if (!signal.aborted) onSaved(data.id);
    } catch (err) {
      if (!signal.aborted) setError(err.message);
    } finally {
      saveInFlight.current = false;
      if (!signal.aborted) setBusy('');
    }
  };

  return (
    <section aria-labelledby="ai-deck-title" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: 0 }}>
      <div style={rowStyle}>
        <button type="button" className="btn btn-secondary" onClick={onClose} aria-label={t('common.back')}><ArrowLeft size={18} /></button>
        <h2 id="ai-deck-title" style={{ margin: 0 }}><Sparkles size={20} /> {t(sourceDeck ? 'aiDeck.improve' : 'aiDeck.title')}</h2>
      </div>
      {sourceDeck && <p style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.improveHint', { name: sourceDeck.name })}</p>}
      <section>
        <span role="status" style={{ color: account?.connected ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
          {account?.connected ? t('aiDeck.aiConnected') : account === null && !accountError ? t('common.loading') : t('aiDeck.disconnected')}
        </span>
        {account && !account.connected && <p style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.connectInSettings')}</p>}
        {accountError && <p role="alert" style={{ color: 'var(--status-error)' }}>{accountError}</p>}
      </section>

      <div>
        <fieldset disabled={!!busy} style={{ ...fieldsetStyle, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: '1.25rem', alignItems: 'start' }}>
          <section className="glass-panel" aria-labelledby="ai-pool-title" style={{ minWidth: 0 }}>
            <h3 id="ai-pool-title" style={{ marginBottom: '1rem' }}>{t('aiDeck.poolTitle')}</h3>
          {inventoryType === 'collection' && (
            <div className="form-group">
              <fieldset disabled={locationsLoading || !!locationsError} style={fieldsetStyle} aria-describedby="ai-container-hint">
                <label>{t('aiDeck.containers')}</label>
                <MultiSelectDropdown
                  label={t('aiDeck.containers')}
                  allLabel={t('aiDeck.allContainers')}
                  value={containerIds}
                  options={containerOptions}
                  onChange={value => { if (!busy) { clearInventory(); setContainerIds(value); } }}
                />
              </fieldset>
              <p id="ai-container-hint" style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.containerHint')}</p>
              {sourceDeck && <p style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.improveContainerHint')}</p>}
              {locationsLoading && <p role="status">{t('common.loading')}</p>}
              {locationsError && <p role="alert">{locationsError} <button type="button" className="btn btn-secondary" onClick={() => setLocationsRevision(value => value + 1)}>{t('aiDeck.retry')}</button></p>}
            </div>
          )}
          {inventoryType === 'collection' && (
            <div className="form-group">
              <label style={rowStyle}>
                <input type="checkbox" checked={includeCheckedOut} aria-describedby="ai-checked-out-hint" onChange={event => { clearInventory(); setIncludeCheckedOut(event.target.checked); }} />
                {t('aiDeck.includeCheckedOut')}
              </label>
              <p id="ai-checked-out-hint" style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.includeCheckedOutHint')}</p>
            </div>
          )}
          <fieldset disabled={inventoryLoading || !!inventoryError} style={fieldsetStyle} aria-describedby="ai-filter-hint">
            <div style={{ ...rowStyle, alignItems: 'start' }}>
              <div className="form-group" style={{ flex: '1 1 180px', minWidth: 0 }}>
                <label>{t('collection.fColor')}</label>
                <MultiSelectDropdown
                  key={inventoryType}
                  label={t('collection.fColor')}
                  allLabel={t('collection.allColors')}
                  value={colors}
                  options={colorOptions}
                  onChange={value => { if (!busy) { clearDraft(); setColors(value); } }}
                />
              </div>
              <div className="form-group" style={{ flex: '1 1 240px', minWidth: 0 }}>
                <label>{t('collection.fSet')}</label>
                <MultiSelectDropdown
                  key={inventoryType}
                  label={t('collection.fSet')}
                  allLabel={t('collection.allSets')}
                  value={sets}
                  options={setOptions}
                  onChange={value => { if (!busy) { clearDraft(); setSets(value); } }}
                />
              </div>
            </div>
          </fieldset>
          <p id="ai-filter-hint" style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.filterHint')}</p>
          <p role="status">{inventoryLoading ? t('common.loading') : t('aiDeck.matchingCounts', counts)}</p>
          {inventoryError && <p role="alert">{inventoryError} <button type="button" className="btn btn-secondary" onClick={() => { clearInventory(); setInventoryRevision(value => value + 1); }}>{t('aiDeck.retry')}</button></p>}
          {!inventoryLoading && !inventoryError && counts.available === 0 && <p>{t(colors.length || sets.length || containerIds.length ? 'aiDeck.emptyFilters' : 'aiDeck.emptyInventory')}</p>}
          </section>
          <section className="glass-panel" aria-labelledby="ai-setup-title" style={{ minWidth: 0 }}>
            <h3 id="ai-setup-title" style={{ marginBottom: '1rem' }}>{t('aiDeck.setupTitle')}</h3>
          <div style={{ ...rowStyle, alignItems: 'start' }}>
            <div className="form-group" style={{ flex: '1 1 180px' }}>
              <label htmlFor="ai-inventory">{t('aiDeck.inventory')}</label>
              <select id="ai-inventory" className="input-control" disabled={!!sourceDeck} value={inventoryType} onChange={event => { clearInventory(); setContainerIds([]); setColors([]); setSets([]); setIncludeCheckedOut(false); setInventoryType(event.target.value); setFormat(event.target.value === 'arena' ? 'Standard' : 'Commander / EDH'); setTargetSize(event.target.value === 'arena' ? 60 : 100); }}>
                <option value="collection">{t('aiDeck.physical')}</option><option value="arena">MTG Arena</option>
              </select>
            </div>
            <div className="form-group" style={{ flex: '1 1 180px' }}>
              <label htmlFor="ai-format">{t('deck.format')}</label>
              <select id="ai-format" className="input-control" disabled={!!sourceDeck} value={format} onChange={event => { clearDraft(); setFormat(event.target.value); setTargetSize(/commander|edh|brawl/i.test(event.target.value) ? 100 : 60); }}>
                {sourceDeck && !FORMATS[inventoryType].includes(format) && <option>{format}</option>}
                {FORMATS[inventoryType].map(value => <option key={value}>{value}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ flex: '1 1 100px' }}>
              <label htmlFor="ai-target">{t('deck.targetSize')}</label>
              <input id="ai-target" form="ai-conversation-form" className="input-control" type="number" min="1" max="250" step="1" required readOnly={!!sourceDeck || isCommander} value={targetSize} onChange={event => { clearDraft(); setTargetSize(event.target.value === '' ? '' : Number(event.target.value)); }} />
            </div>
          </div>
            <p style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.inventoryHint')}</p>
          </section>
          </div>
        </fieldset>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1.25rem', alignItems: 'start' }}>
      <form id="ai-conversation-form" onSubmit={generate} style={{ minWidth: 0 }}>
        <fieldset disabled={!!busy} style={fieldsetStyle}>
          <section className="glass-panel" aria-labelledby="ai-conversation-title" style={{ minWidth: 0 }}>
            <h3 id="ai-conversation-title">{t('aiDeck.conversationTitle')}</h3>
            <p id="ai-conversation-hint" style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.conversationHint')}</p>
            {messages.length > 0 && <>
              <div ref={conversationContainer} role="log" aria-labelledby="ai-conversation-title" aria-live="polite" aria-relevant="additions" tabIndex={0} style={{ maxHeight: 'min(400px, 50dvh)', overflowY: 'auto', overflowWrap: 'anywhere', overscrollBehavior: 'contain', padding: '0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)' }}>
                {messages.map((message, index) => (
                  <div key={index} className={message.role === 'assistant' ? 'ai-response' : undefined} style={{ marginBottom: '0.75rem' }}>
                    <strong>{t(message.role === 'user' ? 'aiDeck.you' : 'aiDeck.assistant')}</strong>
                    <p style={{ whiteSpace: 'pre-wrap', margin: '0.25rem 0 0' }}>{message.content}</p>
                  </div>
                ))}
              </div>
              <p style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.messageCount', { count: messages.length })}</p>
              <button type="button" className="btn btn-secondary" onClick={restartConversation}>{t('aiDeck.restartConversation')}</button>
            </>}
            {conversationFull && <p role="status">{t('aiDeck.conversationFull')}</p>}
          <div className="form-group" style={{ marginTop: '0.75rem' }}>
            <label htmlFor="ai-prompt">{t(needsMessage ? 'aiDeck.followUp' : sourceDeck ? 'aiDeck.improvePrompt' : 'aiDeck.prompt')}</label>
            <textarea id="ai-prompt" className="input-control" rows={3} maxLength={4000} required={needsMessage} aria-describedby="ai-conversation-hint ai-prompt-limit" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t(needsMessage ? 'aiDeck.followUpPlaceholder' : sourceDeck ? 'aiDeck.improvePromptPlaceholder' : 'aiDeck.promptPlaceholder')} />
            <p id="ai-prompt-limit" style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.promptLimit')} ({prompt.length}/4000)</p>
          </div>
          <button className="btn btn-primary" type="submit" aria-busy={busy === 'generate'} disabled={!!busy || !account?.connected || inventoryLoading || !!inventoryError || conversationFull || (needsMessage && !prompt.trim())}>
            {busy === 'generate' ? <LoaderCircle size={16} className="spin-animation ai-waiting-icon" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />} {t(busy === 'generate' ? 'aiDeck.generating' : needsMessage || prompt.trim() ? 'aiDeck.send' : 'aiDeck.generate')}
          </button>
          </section>
        </fieldset>
      </form>
      {draft && (
        <form className="glass-panel" onSubmit={save}>
          <fieldset disabled={!!busy} style={fieldsetStyle}>
            <h3>{t('aiDeck.draftTitle')}</h3>
            <p>{t(sourceDeck ? 'aiDeck.improveDraftHint' : 'aiDeck.draftHint')}</p>
            {(draft.warnings || []).length > 0 && <ul>{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            <div className="form-group">
              <label htmlFor="ai-name">{t('deck.deckName')}</label>
              <input id="ai-name" className="input-control" required maxLength={120} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
            </div>
            <div className="form-group">
              <label htmlFor="ai-description">{t('deck.descriptionOptional')}</label>
              <textarea id="ai-description" className="input-control" rows={3} maxLength={4000} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} />
            </div>
            {isCommander && (
              <div className="form-group">
                <label htmlFor="ai-commander">{t('deck.commander')}</label>
                <select id="ai-commander" className="input-control" required value={draft.commander_card_id || ''} onChange={event => setDraft(current => ({ ...current, commander_card_id: event.target.value || null }))}>
                  <option value="">{t('aiDeck.chooseCommander')}</option>
                  {draft.cards.map(card => <option key={card.card_id} value={card.card_id}>{cardById.has(String(card.card_id)) ? printingLabel(cardById.get(String(card.card_id))) : card.card_id}</option>)}
                </select>
              </div>
            )}
            <p role="status"><strong>{t('aiDeck.total', { total, target: targetSize })}</strong></p>
            {total !== Number(targetSize) && <p>{t('aiDeck.sizeWarning')}</p>}
            {invalidCards && <p role="alert">{t('aiDeck.quantityWarning')}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '0.75rem', maxHeight: '55vh', overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {draft.cards.map(card => {
                const id = String(card.card_id);
                const owned = cardById.get(id);
                return (
                  <div key={id} style={{ position: 'relative', borderRadius: '6px', overflow: 'hidden', border: card.quantity > (owned?.available_qty || 0) ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)', background: 'var(--surface-1)', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <button type="button" disabled={!owned} aria-label={`${t('deck.previewArt')}: ${owned?.name || id}`} onClick={() => onPreview(owned)} style={{ position: 'relative', width: '100%', aspectRatio: 0.718, padding: 0, border: 0, background: 'none', cursor: 'pointer' }}>
                      <CardImage card={owned || { id, name: id }} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      {String(draft.commander_card_id) === id && <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'var(--accent-yellow)', color: 'var(--bg-primary)', padding: '4px', fontSize: '0.75rem', fontWeight: 800 }}>{t('deck.commander')}</span>}
                      <span style={{ position: 'absolute', top: '4px', right: '4px', background: 'var(--bg-primary)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', border: '1px solid var(--accent-yellow)' }}>x{card.quantity}</span>
                    </button>
                    <div title={owned ? printingLabel(owned) : id} style={{ padding: '4px', fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{owned?.name || id}</div>
                    {owned && <p style={{ padding: '0 4px', color: 'var(--text-secondary)', fontSize: '0.65rem' }}>{t('aiDeck.cardCounts', { available: owned.available_qty, locked: owned.locked_qty })}</p>}
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '0.25rem', padding: '4px', marginTop: 'auto', background: 'var(--surface-2)' }}>
                      <input aria-label={t('aiDeck.quantityLabel', { name: owned?.name || id })} className="input-control" style={{ width: '3.5rem', minWidth: 0, padding: '0.25rem' }} type="number" min="1" max={owned?.available_qty || 0} step="1" required value={card.quantity} onChange={event => changeQuantity(id, event.target.value === '' ? '' : Number(event.target.value))} />
                      <button type="button" className="btn btn-secondary btn-icon-only" style={{ padding: '0.25rem' }} aria-label={t('aiDeck.removeLabel', { name: owned?.name || id })} onClick={() => removeCard(id)}><Trash2 size={14} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
            <RelatedTokens cardIds={draft.cards.map(card => card.card_id)} title={t('tokens.title')} inventoryType={inventoryType} commanderCardId={isCommander ? draft.commander_card_id : undefined} />
            <div style={{ ...rowStyle, marginTop: '1rem' }}>
              {sourceDeck && (
                <button type="submit" value="replace" className="btn btn-primary" disabled={saveDisabled || !!sourceDeck.checked_out} aria-describedby={sourceDeck.checked_out ? 'ai-return-before-save' : undefined}>
                  {t(busy === 'save' ? 'aiDeck.saving' : 'aiDeck.saveCurrent')}
                </button>
              )}
              <button type="submit" value="new" className={sourceDeck ? 'btn btn-secondary' : 'btn btn-primary'} disabled={saveDisabled}>
                {t(busy === 'save' ? 'aiDeck.saving' : sourceDeck ? 'aiDeck.saveNew' : 'aiDeck.save')}
              </button>
            </div>
            {sourceDeck?.checked_out && <p id="ai-return-before-save" style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.returnBeforeSave')}</p>}
          </fieldset>
        </form>
      )}
      </div>
      {generationLog.length > 0 && (
        <details className="glass-panel" style={{ minWidth: 0 }}>
          <summary id="ai-generation-log-title" style={{ cursor: 'pointer', fontWeight: 600 }}>{t('aiDeckLog.title')}</summary>
          <div
            ref={logContainer}
            role="log"
            aria-labelledby="ai-generation-log-title"
            aria-live="polite"
            aria-relevant="additions"
            tabIndex={0}
            onScroll={event => {
              const node = event.currentTarget;
              followLog.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
            }}
            style={{ maxHeight: 'min(240px, 35dvh)', overflowY: 'auto', overflowWrap: 'anywhere', overscrollBehavior: 'contain', padding: '0.6rem', marginTop: '0.4rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)', fontSize: '0.8rem' }}
          >
            {generationLog.map(entry => (
              <div key={entry.id} style={{ padding: '0.2rem 0', color: entry.stage === 'failed' ? 'var(--status-error)' : 'var(--text-secondary)' }}>
                <time dateTime={new Date(entry.time).toISOString()} style={{ color: 'var(--text-muted)' }}>{timeFormat.format(entry.time)}</time>
                {' · '}{t(`aiDeckLog.${entry.stage}`, entry)}
                {entry.model && ` · ${t('aiDeck.model')}: ${entry.model}`}
                {entry.effort && ` · ${t('aiDeck.thinkingLevel')}: ${t(EFFORT_KEYS[entry.effort])}`}
              </div>
            ))}
          </div>
        </details>
      )}
      {error && <p role="alert" style={{ color: 'var(--status-error)' }}>{error}</p>}
      <p style={{ color: 'var(--text-secondary)' }}>{t('aiDeck.reviewWarning')}</p>

    </section>
  );
}
