import { useState, useEffect, useRef, useId } from 'react';
import { X, MapPin, Trash2, Star, Maximize2, ExternalLink, Search, Copy } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { translatedName, setCode, isEnglish } from '../utils/languages';
import { formatPrice, priceText } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { tcgplayerUrl, cardmarketUrl, searchUrl, priceSource, noLinkReason } from '../utils/marketplaceLinks';
import CardImage from './CardImage';
import CardImageZoom from './CardImageZoom';
import CardEntryFields from './CardEntryFields';
import PriceHistoryChart from './PriceHistoryChart';
import AddToDeckSelect from './AddToDeckSelect';
import CardArtEditor from './CardArtEditor';
import RelatedTokens from './RelatedTokens';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';
import { getSlotNumber } from '../utils/getSlotNumber';

// MTG color identity pip colors (WUBRG), approximating the printed mana colors.
const MTG_COLOR_BG = {
  White: '#f8f6d8', Blue: '#0e68ab', Black: '#2b2422', Red: '#d3202a', Green: '#00733e'
};
const MTG_COLOR_FG = {
  White: '#3a3520', Blue: '#fff', Black: '#fff', Red: '#fff', Green: '#fff'
};

// Shared card detail popup used by Dashboard, CollectionList and LocationManager.
// Self-contained: owns its edit form (PUT) and delete (DELETE) so every screen
// gets the same rich view + edit without duplicating the form. onUpdate() lets
// the parent refetch after a change. onViewStorage is optional (hidden if absent).
function CardInspectorModal({ card, onClose, onUpdate, onDeleted, showToast, onViewStorage, startInEdit = false }) {
  const { t } = useT();
  const [mode, setMode] = useState('view');
  const [locations, setLocations] = useState([]);
  const [q, setQ] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [isTrade, setIsTrade] = useState(0);
  const [favorite, setFavorite] = useState(0);
  const [listType, setListType] = useState('collection');
  const [missing, setMissing] = useState(false);
  const [notes, setNotes] = useState('');
  const [grader, setGrader] = useState('Raw');
  const [grade, setGrade] = useState('');
  const [certNumber, setCertNumber] = useState('');
  const [marketValue, setMarketValue] = useState('');
  const [localizedCard, setLocalizedCard] = useState(null);
  const [prevTargetId, setPrevTargetId] = useState(card?.entry_id || card?.id || null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [creatingCommanderDeck, setCreatingCommanderDeck] = useState(false);
  const [deckListVersion, setDeckListVersion] = useState(0);
  const creatingCommanderDeckRef = useRef(false);
  const hasToggledRef = useRef(false);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  const isOpen = !!card;

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [isOpen]);

  useBackGuard(isFullScreen, () => setIsFullScreen(false));

  const targetEntryId = card?.entry_id || card?.id;
  if (targetEntryId !== prevTargetId) {
    setPrevTargetId(targetEntryId);
    if (localizedCard) setLocalizedCard(null);
    if (isFullScreen) setIsFullScreen(false);
  }

  const activeCard = card ? (localizedCard || card) : null;

  useEffect(() => {
    if (!targetEntryId) return;
    let cancelled = false;
    setLocations([]);
    fetch(`/api/locations?inventory_type=${listType === 'graveyard' ? 'graveyard' : 'collection'}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!cancelled) setLocations(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [targetEntryId, listType]);

  useEffect(() => {
    if (!card) return;
    setLocalizedCard(null);
    hasToggledRef.current = false;
    setMode(startInEdit ? 'edit' : 'view');
    setQ(card.quantity ?? 1);
    setCondition(card.condition || 'Near Mint');
    setPrinting(card.printing || 'Normal');
    setLanguage(card.language || 'English');
    setPurchasePrice(card.purchase_price || 0);
    setLocationId(card.location_id || '');
    setIsTrade(card.is_trade ? 1 : 0);
    setFavorite(card.favorite ? 1 : 0);
    setListType(card.list_type || 'collection');
    setNotes(card.notes || '');
    setGrader(card.grader || 'Raw');
    setGrade(card.grade == null ? '' : String(card.grade));
    setCertNumber(card.cert_number || '');
    setMissing(!!card.missing);
    setMarketValue(card.market_value == null ? '' : String(card.market_value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset form only when the entry changes, not on every card mutation
  }, [targetEntryId, startInEdit]);

  const handleLanguageChange = async (newLang) => {
    setLanguage(newLang);
    if (!activeCard) return;
    try {
      const cardId = activeCard.card_id || activeCard.id;
      const resp = await fetch(`/api/cards/${encodeURIComponent(cardId)}/printing?lang=${encodeURIComponent(newLang)}&game=${activeCard.game || activeCard.supertype || ''}`);
      if (resp.ok) {
        const localized = await resp.json();
        if (localized && localized.id) {
          const updated = {
            ...(card || {}),
            ...localized,
            card_id: localized.id,
            language: newLang,
          };
          if (card) {
            Object.assign(card, updated);
          }
          setLocalizedCard(updated);
        }
      }
    } catch (e) {
      console.warn('Could not switch to localized printing:', e);
    }
  };

  const handleClose = () => {
    if (hasToggledRef.current && onUpdate) {
      onUpdate();
    }
    onClose && onClose();
  };

  useBackGuard(!!card, handleClose);

  if (!card || !activeCard) return null;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!targetEntryId) return;
    const qNum = Math.max(1, parseInt(q, 10) || 1);
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Sent only when actually changed. The server reads quantity as the
          // absolute number of copies owned and adds or removes rows to match,
          // and some screens open this popup on a single row whose quantity is
          // not the whole stack — so an untouched field must not be able to
          // trim copies the user never asked to lose.
          ...(qNum !== (card.quantity ?? 1) ? { quantity: qNum } : {}),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: locationId ? parseInt(locationId, 10) : null,
          list_type: listType,
          is_trade: isTrade ? 1 : 0,
          favorite: favorite ? 1 : 0,
          missing: missing ? 1 : 0,
          notes,
          grader,
          grade: grade === '' ? null : parseFloat(grade),
          cert_number: certNumber.trim() || null,
          // Only when it actually changed. A value just fetched from the provider is
          // already saved with that provider recorded as its source; sending it back
          // untouched would relabel it as hand-typed and exempt it from a refresh.
          ...(marketValue !== (card.market_value == null ? '' : String(card.market_value))
            ? { market_value: marketValue === '' ? null : parseFloat(marketValue) }
            : {})
        })
      });
      if (res.ok) {
        card.quantity = qNum;
        card.condition = condition;
        card.printing = printing;
        card.language = language;
        card.purchase_price = parseFloat(purchasePrice) || 0;
        card.location_id = locationId ? parseInt(locationId, 10) : null;
        card.list_type = listType;
        card.is_trade = isTrade ? 1 : 0;
        card.favorite = favorite ? 1 : 0;
        card.missing = missing ? 1 : 0;
        card.notes = notes;
        card.grader = grader;
        card.grade = grade === '' ? null : parseFloat(grade);
        card.cert_number = certNumber.trim() || null;
        card.market_value = marketValue === '' ? null : parseFloat(marketValue);
        // The server resolves this per printing on the next fetch; mirror it here so
        // a screen still holding this object does not show the old printing's price.
        card.price_trend = resolveCardPrice(card, printing);
        showToast && showToast(t('inspector.entryUpdated'), 'success');
        onUpdate && onUpdate();
        onClose();
      } else {
        // The server's own words when it has any: a duplicate cert number names the
        // card already holding it, which a generic failure toast would throw away
        // and leave the user re-typing a number that was never the problem.
        const body = await res.json().catch(() => null);
        showToast && showToast(body?.error || t('inspector.errUpdate'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errEdit'), 'error');
    }
  };


  const handleDuplicate = async () => {
    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: activeCard.card_id || activeCard.id,
          quantity: 1,
          condition: activeCard.condition,
          printing: activeCard.printing,
          language: activeCard.language,
          purchase_price: activeCard.purchase_price || 0,
          location_id: activeCard.location_id || null,
          list_type: activeCard.list_type,
          is_trade: activeCard.is_trade,
          game: activeCard.game
        })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || t('inspector.errDuplicate'));
      showToast?.(t('inspector.duplicated'), 'success');
      onUpdate?.();
    } catch (error) {
      console.error(error);
      showToast?.(error.message || t('inspector.errDuplicate'), 'error');
    }
  };

  const handleQuickToggle = async (field, value) => {
    if (!targetEntryId) return;
    const nextFavorite = field === 'favorite' ? (value ? 1 : 0) : (favorite ? 1 : 0);
    const nextIsTrade = field === 'is_trade' ? (value ? 1 : 0) : (isTrade ? 1 : 0);
    const nextListType = field === 'list_type' ? value : listType;

    // Optimistic UI & prop object updates
    if (field === 'is_trade') { setIsTrade(nextIsTrade); card.is_trade = nextIsTrade; }
    if (field === 'favorite') { setFavorite(nextFavorite); card.favorite = nextFavorite; }
    if (field === 'list_type') { setListType(nextListType); card.list_type = nextListType; }

    // Only the toggled flags. Quantity and placement are deliberately absent:
    // a favourite/trade toggle must never change how many copies you own or
    // where they live, and sending quantity here reconciles the whole stack.
    const payload = field === 'list_type' ? { list_type: nextListType } : {
      list_type: nextListType,
      is_trade: nextIsTrade,
      favorite: nextFavorite
    };

    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        hasToggledRef.current = true;
        showToast && showToast(t('inspector.cardUpdated'), 'success');
        if (field === 'list_type' && (nextListType === 'graveyard' || listType === 'graveyard')) {
          onUpdate?.();
          onClose?.();
        }
      } else {
        // revert on fail
        if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
        if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
        if (field === 'list_type') { setListType(listType); card.list_type = listType; }
        const data = await res.json().catch(() => null);
        showToast && showToast(data?.error || t('inspector.errUpdate'), 'error');
      }
    } catch (err) {
      console.error(err);
      if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
      if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
      if (field === 'list_type') { setListType(listType); card.list_type = listType; }
      showToast && showToast(t('inspector.errUpdateGeneric'), 'error');
    }
  };

  const handleAddToDeck = async (deckId) => {
    if (!targetEntryId || !deckId) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: [targetEntryId], action: 'add_to_deck', value: deckId })
      });
      const data = await res.json().catch(() => ({}));
      showToast && showToast(res.ok ? (data.message || t('inspector.addedToDeck')) : (data.error || t('inspector.errAddDeck')), res.ok ? 'success' : 'error');
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errAddDeckGeneric'), 'error');
    }
  };

  const handleCreateCommanderDeck = async () => {
    if (creatingCommanderDeckRef.current) return;
    creatingCommanderDeckRef.current = true;
    setCreatingCommanderDeck(true);
    try {
      const response = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: activeCard.name,
          format: 'Commander / EDH',
          target_size: 100,
          game: 'mtg',
          inventory_type: activeCard.list_type,
          commander_card_id: activeCard.card_id || activeCard.id,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        showToast?.(`${t('deck.errCreate')}${data?.error ? ` ${data.error}` : ''}`, 'error');
        return;
      }
      setDeckListVersion(version => version + 1);
      showToast?.(t('deck.created'), 'success');
    } catch (error) {
      console.error(error);
      showToast?.(t('deck.errCreateGeneric'), 'error');
    } finally {
      creatingCommanderDeckRef.current = false;
      setCreatingCommanderDeck(false);
    }
  };

  const handleDelete = async () => {
    if (!targetEntryId) return;
    if (!window.confirm(t('collection.confirmDeleteCard', { name: card.name }))) return;
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast && showToast(t('collection.cardRemoved', { name: card.name }), 'success');
        onDeleted && onDeleted(targetEntryId);
        onUpdate && onUpdate();
        onClose();
      } else {
        showToast && showToast(t('collection.errDelete'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('common.errBackend'), 'error');
    }
  };

  // Resolved against the printing selected RIGHT NOW, not the one that was saved
  // when this row was fetched. `card.price_trend` arrives from the server already
  // resolved for the stored printing, so rendering it directly meant switching
  // Normal to Holofoil in the form changed nothing on screen — the number
  // only caught up after a save and a refetch, which reads as "prices don't
  // respond to the foil type". Same resolution order as the server.
  const displayPrice = resolveCardPrice(activeCard, printing);

  return (
    <dialog ref={dialogRef} aria-labelledby={titleId} className="modal-overlay" onCancel={(event) => {
      event.preventDefault();
      event.stopPropagation();
      handleClose();
    }} style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 999
    }} onClick={(event) => { if (event.target === event.currentTarget) handleClose(); }}>
      <div className={`glass-panel card-inspector ${mode === 'edit' ? 'mode-edit' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} type="button" aria-label={t('common.close')} className="btn btn-secondary btn-icon-only" onClick={handleClose} style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          borderRadius: '50%',
          zIndex: 10
        }}>
          <X size={16} />
        </button>

        {/* Left side: Main Card Image Focus */}
        <div className="ci-image-col" style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <button
            type="button"
            aria-label={t('inspector.zoomHint')}
            aria-haspopup="dialog"
            className="ci-image-wrap"
            onClick={() => setIsFullScreen(true)}
            title={t('inspector.zoomHint')}
            style={{ position: 'relative', width: '100%', maxWidth: '300px', cursor: 'pointer' }}
          >
            {/* CardImage, not a bare <img>: this was the last call site still
                reading card.image_url directly, so contributed art uploaded
                through the editor below was never shown in the very view that
                uploads it, and a card with no provider art rendered as a broken
                image icon here alone. */}
            <CardImage
              card={activeCard}
              style={{
                width: '100%',
                aspectRatio: 0.718,
                objectFit: 'cover',
                borderRadius: 'var(--radius-sm)'
              }}
            />
            <span style={{
              position: 'absolute',
              bottom: '0.6rem',
              right: '0.6rem',
              background: 'rgba(0,0,0,0.65)',
              padding: '0.25rem 0.5rem',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              fontSize: '0.875rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              pointerEvents: 'none',
              border: '1px solid rgba(255,255,255,0.15)'
            }}>
              <Maximize2 size={12} />
              <span>{t('inspector.fullScreen')}</span>
            </span>
          </button>
          <CardArtEditor
            card={activeCard}
            hasProviderArt={!!activeCard.image_url}
            showToast={showToast}
            onChanged={onUpdate}
          />
        </div>

        {/* Right side: Information / Edit */}
        <div className="ci-info-col" style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              {activeCard.list_type === 'wishlist' && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.3)' }}>
                  {t('inspector.wishlistItem')}
                </span>
              )}
              {activeCard.list_type === 'arena' && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(249, 115, 22, 0.15)', color: '#f97316', border: '1px solid rgba(249, 115, 22, 0.3)' }}>
                  {t('inspector.arenaItem')}
                </span>
              )}
              {activeCard.list_type === 'graveyard' && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(148, 163, 184, 0.15)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                  {t('inspector.graveyardItem')}
                </span>
              )}
              {activeCard.list_type === 'arena' && (
                <button type="button" className="btn btn-secondary" style={{ color: 'var(--accent-green)', padding: '0.2rem 0.5rem', fontSize: '0.8rem' }} onClick={() => handleQuickToggle('list_type', 'collection')} title={t('bulk.moveToCollection')}>
                  {t('inspector.obtained')}
                </button>
              )}
              {activeCard.is_trade === 1 && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(74, 222, 128, 0.15)', color: 'var(--accent-green)', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                  {t('inspector.forTrade')}
                </span>
              )}
            </div>

            <h3 id={titleId} className="section-heading" style={{ fontSize: '1.5rem', color: 'var(--text-strong)', fontWeight: 700, lineHeight: 1.2, marginBottom: '0.25rem' }}>
              {getCardDisplayName(activeCard.name, activeCard.printed_name)}
            </h3>
            {/* Show the English name alongside a localized printing when available. */}
            {translatedName(activeCard) && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                {translatedName(activeCard)}
              </p>
            )}
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', fontWeight: 500 }}>
              {activeCard.set_name}
              {/* Set code alongside the native set name: it reads the same in every
                  language, so it is the part you can search or quote. The collector
                  number is already spelled out just after, so only the code here. */}
              {!isEnglish(language) && setCode(activeCard) && (
                <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}> ({setCode(activeCard)})</span>
              )}
              {(activeCard.number || activeCard.collector_number || activeCard.card_number) ? ` • #${activeCard.number || activeCard.collector_number || activeCard.card_number}` : ''}{activeCard.rarity ? ` • ${activeCard.rarity}` : ''} • {t(activeCard.list_type === 'graveyard' ? 'inspector.archived' : 'inspector.owned', { count: activeCard.quantity ?? 1 })}
            </p>

            {/* MTG color pips and type line. */}
            {(activeCard.supertype === 'MTG' || activeCard.game === 'mtg') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {(Array.isArray(activeCard.types) ? activeCard.types : []).map(color => (
                  <span key={color} className={`mtg-color-pip mtg-color-${color.toLowerCase()}`} style={{
                    fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em',
                    padding: '0.15rem 0.45rem', borderRadius: '999px',
                    background: MTG_COLOR_BG[color] || 'rgba(255,255,255,0.1)',
                    color: MTG_COLOR_FG[color] || '#fff', border: '1px solid rgba(0,0,0,0.2)'
                  }}>{color}</span>
                ))}
                {(!activeCard.types || activeCard.types.length === 0) && (
                  <span style={{ fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '999px', background: 'rgba(180,180,180,0.25)', color: '#eee' }}>{t('inspector.colorless')}</span>
                )}
                {Array.isArray(activeCard.subtypes) && activeCard.subtypes.length > 0 && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{activeCard.subtypes.join(' ')}</span>
                )}
              </div>
            )}
          </div>

          {mode === 'edit' ? (
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {listType !== 'collection' && listType !== 'graveyard' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(74,222,128,0.1)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(74,222,128,0.2)' }}>
                  <input type="checkbox" checked={listType === 'collection'} onChange={(e) => setListType(e.target.checked ? 'collection' : activeCard.list_type)} id="markOwned" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="markOwned" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--accent-green)', fontSize: '0.85rem' }}>
                    {t('inspector.markObtained')}
                  </label>
                </div>
              ) : listType === 'collection' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <input type="checkbox" checked={isTrade === 1} onChange={(e) => setIsTrade(e.target.checked ? 1 : 0)} id="isTrade" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="isTrade" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>
                    {t('inspector.listedInTrade')}
                  </label>
                </div>
              ) : null}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: missing ? 'rgba(255,71,71,0.1)' : 'rgba(255,255,255,0.02)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} id="isMissing" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="isMissing" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: missing ? 'var(--accent-red)' : 'var(--text-strong)', fontSize: '0.85rem' }}>
                  {t('inspector.markMissing')}
                </label>
              </div>

              <CardEntryFields
                game={activeCard.game || activeCard.supertype}
                quantity={q} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                onQuantity={setQ} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={handleLanguageChange}
                grader={grader} grade={grade} certNumber={certNumber}
              />

              {/* What this copy is worth, when the card's market price is not it —
                  a slab, a signed card, a misprint. Everything that adds up money
                  (net worth, set totals, the top-valuable list) reads this instead
                  once it is set. Empty means "use the card's price" again. */}
              <div className="form-group">
                <label htmlFor="copy-value">{t('inspector.copyValue')}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    id="copy-value"
                    type="number" inputMode="decimal" min="0" step="0.01"
                    className="input-control"
                    style={{ flex: 1 }}
                    value={marketValue}
                    onChange={(e) => setMarketValue(e.target.value)}
                    placeholder={formatPrice(displayPrice)}
                  />
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.3rem', lineHeight: 1.4 }}>
                  {t('inspector.copyValueHint')}
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="inspector-location">{t('inspector.storageContainer')}</label>
                <select id="inspector-location" className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">{t('bulk.unassignedPile')}</option>
                  {locations.slice().sort((a, b) => a.name.localeCompare(b.name)).map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="inspector-notes">{t('nav.notes')}</label>
                <textarea
                  id="inspector-notes"
                  className="input-control"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('inspector.notesPlaceholder')}
                  rows={3}
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setMode('view')} style={{ flex: 1 }}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>{t('inspector.saveChanges')}</button>
              </div>
            </form>
          ) : (
            <>
              {/* Specifications Details Grid */}
              <div className="view-section" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.6rem 1rem', fontSize: '0.875rem', overflowWrap: 'anywhere', marginTop: 0, paddingTop: '0.75rem' }}>
                {/* A slab reports its grade where a raw card reports its condition:
                    they answer the same question, and showing 'Near Mint' for a
                    PSA 9 states an opinion the grader already overruled. */}
                {activeCard.grader && activeCard.grader !== 'Raw' ? (
                  <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specGrade')}</span> <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>{activeCard.grader}{activeCard.grade != null ? ` ${activeCard.grade}` : ''}</span></div>
                ) : (
                  <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specCondition')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.condition}</span></div>
                )}
                {activeCard.cert_number && (
                  <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specCert')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.cert_number}</span></div>
                )}
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specPrinting')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.printing}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specLanguage')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.language}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specSupertype')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{activeCard.supertype}</span></div>
              </div>

              {/* Storage Container details (clickable to view in storage) */}
              {['collection', 'graveyard'].includes(activeCard.list_type) && (
                <div
                  className="view-section ci-storage-link"
                  onClick={() => onViewStorage?.(activeCard)}
                  role={onViewStorage ? 'button' : undefined}
                  tabIndex={onViewStorage ? 0 : undefined}
                  onKeyDown={(event) => {
                    if (onViewStorage && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      onViewStorage(activeCard);
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 0', marginTop: 0,
                    fontSize: '0.875rem', cursor: onViewStorage ? 'pointer' : 'default'
                  }}
                  title={onViewStorage ? t('inspector.viewInStorage') : undefined}
                >
                  <MapPin size={14} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
                  <div style={{ minWidth: 0, overflowWrap: 'anywhere', flex: 1 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('inspector.locationLabel')} </span>
                    <strong style={{ color: 'var(--text-strong)' }}>
                      {activeCard.location_name ? `${activeCard.location_name}${activeCard.location_type ? ` (${activeCard.location_type})` : ''}` : t('bulk.unassignedPile')}
                    </strong>
                    {activeCard.location_name && activeCard.compartment_display_label && (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {` • ${activeCard.compartment_display_label}`}
                        {getSlotNumber(activeCard) !== null ? ` • ${t('wizard.slot', { slot: getSlotNumber(activeCard) })}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {activeCard.list_type === 'collection' && (
                <AddToDeckSelect
                  key={deckListVersion}
                  onAdd={handleAddToDeck}
                  placeholder={t('inspector.addToDeck')}
                  style={{ fontSize: '0.875rem', padding: '0.5rem', width: '100%' }}
                />
              )}
              {(activeCard.game === 'mtg' || activeCard.supertype === 'MTG') && ['collection', 'arena'].includes(activeCard.list_type) && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCreateCommanderDeck}
                  disabled={creatingCommanderDeck}
                  style={{ width: '100%', fontSize: '0.875rem' }}
                >
                  {creatingCommanderDeck ? t('common.loading') : t('inspector.createCommanderDeck')}
                </button>
              )}

              {activeCard.notes && (
                <div className="view-section" style={{ fontSize: '0.9375rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 0, paddingTop: '0.75rem' }}>
                  {activeCard.notes}
                </div>
              )}

              <RelatedTokens cardIds={[activeCard.card_id || activeCard.id]} inventoryType={activeCard.list_type === 'arena' ? 'arena' : 'collection'} />

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {activeCard.list_type === 'graveyard' ? (
                  <>
                    <button type="button" className="btn btn-secondary" onClick={() => handleQuickToggle('list_type', 'collection')}>{t('bulk.restoreToCollection')}</button>
                    <button type="button" className="btn btn-secondary" onClick={() => handleQuickToggle('list_type', 'arena')}>{t('bulk.restoreToArena')}</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-secondary" onClick={() => handleQuickToggle('list_type', 'graveyard')}>{t('bulk.archive')}</button>
                )}
              </div>

              {/* Main Actions Row: Edit Card + Icon buttons for Favorite & Delete */}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setMode('edit')}>
                  {t('inspector.editCard')}
                </button>

                {activeCard.grader === 'Raw' && (
                  <button type="button" className="btn btn-secondary btn-icon-only" style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem' }} onClick={handleDuplicate} title={t('inspector.duplicateCard')} aria-label={t('inspector.duplicateCard')}>
                    <Copy size={16} />
                  </button>
                )}

              {activeCard.list_type !== 'collection' && activeCard.list_type !== 'arena' && activeCard.list_type !== 'graveyard' && (
                <button 
                  className="btn btn-secondary" 
                  style={{ backgroundColor: 'rgba(74,222,128,0.2)', color: 'var(--accent-green)', border: '1px solid rgba(74,222,128,0.3)', padding: '0 0.75rem', fontSize: '0.8rem' }} 
                  onClick={() => handleQuickToggle('list_type', 'collection')}
                  title={t('bulk.moveToCollection')}
                >
                  {t('inspector.obtained')}
                </button>
              )}

                <button
                  type="button"
                  className={`btn ${favorite === 1 ? 'btn-primary' : 'btn-secondary'} btn-icon-only`}
                  style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem', ...(favorite === 1 ? { backgroundColor: 'rgba(250,204,21,0.2)', color: '#facc15', border: '1px solid rgba(250,204,21,0.3)' } : {}) }}
                  onClick={() => handleQuickToggle('favorite', favorite === 1 ? 0 : 1)}
                  title={t(favorite === 1 ? 'inspector.unfavorite' : 'inspector.favorite')}
                  aria-label={t(favorite === 1 ? 'inspector.unfavorite' : 'inspector.favorite')}
                  aria-pressed={favorite === 1}
                >
                  <Star size={16} fill={favorite === 1 ? '#facc15' : 'none'} />
                </button>

                <button
                  type="button"
                  className="btn btn-danger btn-icon-only"
                  style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem' }}
                  onClick={handleDelete}
                  title={t('inspector.deleteCard')}
                  aria-label={t('inspector.deleteCard')}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {/* Price Panel */}
              <div style={{ borderTop: '1px solid var(--border-glass)', borderBottom: '1px solid var(--border-glass)', padding: '0.75rem 0', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>{t('inspector.marketPrice')}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-yellow)', marginTop: '0.15rem' }}>
                    {priceText(displayPrice, activeCard.price_currency)}
                  </div>
                  {/* Say where a non-English price came from and in what currency —
                      it is Cardmarket's EUR figure rendered with the app's $. */}
                  {priceSource(activeCard) && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                      {t('inspector.priceVia', { source: priceSource(activeCard).name, currency: priceSource(activeCard).currency })}
                    </div>
                  )}
                  {/* Every price source this app has — TCGplayer, Scryfall,
                      Cardmarket — quotes RAW singles. None of them price slabs, and
                      a PSA 10 is worth a multiple of its raw copy. So for a graded
                      copy the number above is either a value set on this copy, or it
                      is the raw price and says so. Inventing a grade multiplier
                      would be worse than either: confidently wrong. */}
                  {activeCard.market_value > 0 ? (
                    <div style={{ fontSize: '0.62rem', color: 'var(--accent-yellow)', marginTop: '0.1rem', lineHeight: 1.35 }}>
                      {t('inspector.valueFromYou')}
                    </div>
                  ) : activeCard.grader && activeCard.grader !== 'Raw' && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--accent-yellow)', marginTop: '0.1rem', lineHeight: 1.35 }}>
                      {t('inspector.priceRawOnly')}
                    </div>
                  )}
                  {/* Printings are priced separately; conditions are not, by anyone
                      Manafolio talks to — TCGplayer, Scryfall and Cardmarket all quote
                      a Near Mint copy. Saying so beats letting a played card show a
                      NM price with nothing to explain it, and beats inventing a
                      condition multiplier, which would be a made-up number wearing
                      the same styling as a real one. */}
                  {!(activeCard.market_value > 0) && condition && condition !== 'Near Mint' && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.1rem', lineHeight: 1.35 }}>
                      {t('inspector.priceNearMintOnly', { condition })}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>{t('inspector.purchaseValue')}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-strong)', marginTop: '0.15rem' }}>
                    {priceText(activeCard.purchase_price)}
                  </div>
                </div>
              </div>

              {/* Marketplace links. "View on TCGplayer" now means the card's own
                  product page and nothing else — it used to fall back to a name
                  search wearing the same label, which for a Japanese printing
                  reliably found nothing.

                  A search is still offered, as its own action with its own words, so
                  the reader can tell which of the two they are about to get. */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {tcgplayerUrl(activeCard) && (
                  <a
                    href={tcgplayerUrl(activeCard)} target="_blank" rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                  >
                    <ExternalLink size={13} /> {t('inspector.viewOnTcgplayer')}
                  </a>
                )}
                {cardmarketUrl(activeCard) && (
                  <a
                    href={cardmarketUrl(activeCard)} target="_blank" rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                  >
                    <ExternalLink size={13} /> Cardmarket
                  </a>
                )}
                {/* Only shown when there is no direct link — as a fallback the reader
                    chooses, not a substitute presented as the real thing. */}
                {!tcgplayerUrl(activeCard) && !cardmarketUrl(activeCard) && searchUrl(activeCard) && (
                  <a
                    href={searchUrl(activeCard)} target="_blank" rel="noopener noreferrer"
                    className="btn btn-secondary"
                    style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                  >
                    <Search size={13} /> {t('inspector.searchTcgplayer')}
                  </a>
                )}
              </div>
              {noLinkReason(activeCard) && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {noLinkReason(activeCard)}
                </div>
              )}

              {/* Price History Area Chart */}
              <PriceHistoryChart cardId={activeCard.card_id || activeCard.id} currency={activeCard.price_currency} height={100} defaultRange="30d" />

            </>
          )}
        </div>
      </div>

      {isFullScreen && (
        <CardImageZoom card={activeCard} onClose={() => setIsFullScreen(false)} />
      )}
    </dialog>
  );
}

export default CardInspectorModal;
