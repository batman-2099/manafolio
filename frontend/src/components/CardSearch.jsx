import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, Plus, X, ShieldAlert, Check, MousePointerClick, Zap, Undo2, Maximize2, Download } from 'lucide-react';
import confetti from 'canvas-confetti';
import { priceText } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import CardEntryFields from './CardEntryFields';
import CardImageZoom from './CardImageZoom';
import { getCardDisplayName } from '../utils/langHelper';
import { useMultiSelect } from '../utils/useMultiSelect';
import { CONDITIONS, getPrintings } from '../utils/cardOptions';
import { langName, isEnglish, displayName, translatedName, setReference, setCode, getLanguagesForGame } from '../utils/languages';
import { defaultGame, gameLabel } from '../utils/games';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';
import { readProgressStream } from '../utils/importStream';
import { downloadBlob } from '../utils/downloadBlob';

const CSV_FIELDS = [
  ['name', 'csvMapping.name', ['name', 'card name', 'card']],
  ['quantity', 'csvMapping.quantity', ['quantity', 'count', 'qty']],
  ['set_code', 'csvMapping.setCode', ['set id', 'set code', 'set', 'edition']],
  ['collector_number', 'csvMapping.collectorNumber', ['card number', 'collector number', 'number']],
  ['condition', 'csvMapping.condition', ['condition']],
  ['printing', 'csvMapping.printing', ['printing', 'foil']],
  ['language', 'csvMapping.language', ['language']],
  ['purchase_price', 'csvMapping.purchasePrice', ['purchase price', 'price']],
  ['card_id', 'csvMapping.cardId', ['card id', 'id']]
];

const suggestedCsvMapping = (headers) => Object.fromEntries(CSV_FIELDS.map(([field, , names]) => [
  field,
  headers.find(header => names.includes(header.toLowerCase())) || ''
]));

function ImportLog({ entries }) {
  const { t, locale } = useT();
  const container = useRef(null);
  const follow = useRef(true);
  const attempt = useRef(null);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }), [locale]);

  useEffect(() => {
    if (entries[0]?.stage === 'connecting' && attempt.current !== entries[0].id) {
      attempt.current = entries[0].id;
      follow.current = true;
    }
    if (follow.current && container.current) container.current.scrollTop = container.current.scrollHeight;
  }, [entries]);

  if (!entries.length) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <strong style={{ color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('importLog.title')}</strong>
      <div
        ref={container}
        role="log"
        aria-label={t('importLog.title')}
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
        onScroll={event => {
          const node = event.currentTarget;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
        style={{ maxHeight: 'min(200px, 30dvh)', overflowY: 'auto', overflowWrap: 'anywhere', padding: '0.6rem', marginTop: '0.4rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)', fontSize: '0.78rem' }}
      >
        {entries.map(entry => (
          <div key={entry.id} style={{ padding: '0.2rem 0', color: entry.stage === 'failed' ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
            <time dateTime={new Date(entry.time).toISOString()} style={{ color: 'var(--text-muted)' }}>{timeFormat.format(entry.time)}</time>
            {' · '}{t(`importLog.${entry.stage}`, entry)}
            {entry.set ? ` · ${t('importLog.set', { set: entry.set })}` : ''}
          </div>
        ))}
      </div>
      <p style={{ margin: '0.4rem 0 0', color: 'var(--text-muted)', fontSize: '0.75rem' }}>{t('importLog.disconnect')}</p>
    </div>
  );
}


function CardSearch({ onAddSuccess, showToast }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [numberQuery, setNumberQuery] = useState('');
  const [setCodeQuery, setSetCodeQuery] = useState('');
  const game = defaultGame();
  // Which language's printings to search.
  const [searchLang, setSearchLang] = useState('en');
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const searchPending = useRef(false);
  const submittedSearch = useRef(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  // Paging. A full page back means there is probably another one; `total` is the
  // provider's real match count when it reports one (cache hits don't).
  const [pageSize, setPageSize] = useState(() => parseInt(localStorage.getItem('search_page_size'), 10) || 60);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(null);

  // Multi-select for bulk add — the same hook, gesture and visuals the
  // collection uses, so selecting works identically on both screens. Only the
  // action differs: bulk ADD here, bulk edit there (so runBulk goes unused).
  const {
    selectMode, setSelectMode, selectedIds, setSelectedIds, selectAt,
    clearSelection, exitSelectMode, pressHandlers, longPressFired,
  } = useMultiSelect({ showToast });
  const [bulkAdding, setBulkAdding] = useState(false);

  // Set suggestions, sourced from the sets already cached in the DB.
  const [knownSets, setKnownSets] = useState([]);
  const [setsOpen, setSetsOpen] = useState(false);

  // Rapid add: set code stays pinned, type a collector number, press Enter, the
  // card goes straight in. `rapidLog` is the running receipt with undo.
  const [rapidMode, setRapidMode] = useState(false);
  const [rapidNumber, setRapidNumber] = useState('');
  const [rapidBusy, setRapidBusy] = useState(false);
  const [rapidLog, setRapidLog] = useState([]);
  const rapidInputRef = useRef(null);
  const textImportInput = useRef(null);
  const csvImportInput = useRef(null);
  const [importingText, setImportingText] = useState(false);
  const [manaBoxPreview, setManaBoxPreview] = useState(null);
  const [csvPreview, setCsvPreview] = useState(null);
  const [importSummary, setImportSummary] = useState(null);
  const [importLog, setImportLog] = useState([]);
  const importRequest = useRef(null);
  const importFileReader = useRef(null);
  const importLogId = useRef(0);

  useEffect(() => () => {
    importRequest.current?.abort();
    importFileReader.current?.abort();
  }, []);

  const appendImportLog = event => {
    const entry = { ...event, id: ++importLogId.current, time: Date.now() };
    // ponytail: retain only the latest 200 events, not a second full import history.
    setImportLog(entries => [...entries.slice(-199), entry]);
  };
  const [addToArena, setAddToArena] = useState(false);

  // Filter states
  const [filterRarity, setFilterRarity] = useState('');
  const [filterType, setFilterType] = useState('');
  const [sortBy, setSortBy] = useState('relevance');

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const drawerGeneration = useRef(0);
  const printingRequest = useRef(0);
  const printingPending = useRef(false);
  const [localizing, setLocalizing] = useState(false);
  const addPending = useRef(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => () => {
    drawerGeneration.current++;
    printingRequest.current++;
  }, []);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  const [language, setLanguage] = useState('English');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [grader, setGrader] = useState('Raw');
  const [grade, setGrade] = useState('');
  const [certNumber, setCertNumber] = useState('');

  // Set codes for autocomplete; search expects codes without the game prefix.
  useEffect(() => {
    let cancelled = false;
    setKnownSets([]);
    fetch(`/api/sets?game=${game}&lang=${encodeURIComponent(searchLang)}`)
      .then(r => (r.ok ? r.json() : []))
      .then(rows => {
        if (cancelled) return;
        const seen = new Set();
        setKnownSets(rows
          .filter(s => !s.game || s.game === game)
          .map(s => ({ code: String(s.id || '').replace(/^mtg-/, ''), name: s.name, symbol_url: s.symbol_url }))
          .filter(s => s.code && !seen.has(s.code) && seen.add(s.code))
          .reverse()); // newest first — that is what people are adding
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [game, searchLang]);


  // pageNum > 1 appends to the existing results instead of replacing them.
  const runSearch = async (pageNum, size = pageSize, criteria = null) => {
    if (searchPending.current) return;
    searchPending.current = true;
    const append = pageNum > 1;
    const submitted = criteria || (append ? submittedSearch.current : { query, numberQuery, setCodeQuery, game, searchLang });
    if (!submitted) { searchPending.current = false; return; }
    if (!append) submittedSearch.current = submitted;
    if (append) setLoadingMore(true); else setLoading(true);
    setSearchError(null);
    if (!append) {
      setSearching(true);
      setFilterType('');
      setFilterRarity('');
      setSortBy('relevance');
      clearSelection();
      setTotal(null);
    }
    try {
      const params = new URLSearchParams();
      if (submitted.query) params.append('name', submitted.query);
      if (submitted.numberQuery) params.append('number', submitted.numberQuery);
      if (submitted.setCodeQuery) params.append('set', submitted.setCodeQuery);
      params.append('scope', 'internet');
      params.append('game', submitted.game);
      params.append('lang', submitted.searchLang);
      params.append('page', pageNum);
      params.append('limit', size);

      const response = await fetch(`/api/search?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        const reported = parseInt(response.headers.get('X-Total-Count'), 10);
        if (Number.isFinite(reported)) setTotal(reported);
        setHasMore(data.length >= size);
        setPage(pageNum);
        // Paging shifts the exact-match head off later pages, so the same
        // printing can come back twice — keep the first copy.
        setCards(prev => {
          if (!append) return data;
          const seen = new Set(prev.map(c => c.id));
          return [...prev, ...data.filter(c => !seen.has(c.id))];
        });
        // Exactly one match means the search already identified the card (set +
        // number usually does). Skip the "click the only result" step.
        if (!append && data.length === 1 && !selectMode) openQuickAdd(data[0]);
      } else {
        const errData = await response.json().catch(() => ({}));
        if (response.status === 429 || errData.error === 'Rate limit exceeded') {
          setSearchError('rate-limit');
        } else if (response.status === 503) {
          setSearchError('upstream');
        }
        showToast(errData.error || t('search.errRequest'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('search.errApi'), 'error');
    } finally {
      searchPending.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const handleSearch = (e) => {
    if (e) e.preventDefault();
    if (!query && !numberQuery && !setCodeQuery) return;
    runSearch(1);
  };

  const changePageSize = (size) => {
    setPageSize(size);
    localStorage.setItem('search_page_size', String(size));
    if (searching) runSearch(1, size, submittedSearch.current);
  };

  // Dynamically compute filters from search results
  const uniqueRarities = useMemo(() => {
    const set = new Set();
    cards.forEach(c => { if (c.rarity) set.add(c.rarity); });
    return Array.from(set).sort();
  }, [cards]);


  const uniqueTypes = useMemo(() => {
    const set = new Set();
    cards.forEach(c => {
      if (c.types) {
        c.types.forEach(t => set.add(t));
      }
    });
    return Array.from(set).sort();
  }, [cards]);

  // Apply filters and sorting
  const filteredAndSortedCards = useMemo(() => {
    let result = [...cards];

    // Apply filters
    if (filterRarity) {
      result = result.filter(c => c.rarity === filterRarity);
    }
    if (filterType) {
      result = result.filter(c => c.types && c.types.includes(filterType));
    }

    // Apply sorting
    if (sortBy === 'name-asc') {
      result.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === 'name-desc') {
      result.sort((a, b) => b.name.localeCompare(a.name));
    } else if (sortBy === 'price-asc') {
      result.sort((a, b) => (a.price_trend || 0) - (b.price_trend || 0));
    } else if (sortBy === 'price-desc') {
      result.sort((a, b) => (b.price_trend || 0) - (a.price_trend || 0));
    } else if (sortBy === 'number-asc') {
      result.sort((a, b) => {
        const numA = parseInt(a.number, 10);
        const numB = parseInt(b.number, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.number.localeCompare(b.number);
      });
    } else if (sortBy === 'number-desc') {
      result.sort((a, b) => {
        const numA = parseInt(a.number, 10);
        const numB = parseInt(b.number, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numB - numA;
        return b.number.localeCompare(a.number);
      });
    }

    return result;
  }, [cards, filterRarity, filterType, sortBy]);

  // Tap: swallowed if a long-press just armed selection; otherwise toggle (in
  // select mode) or open Quick Add. Mirrors CollectionList.activateCard.
  const handleCardClick = (card, event) => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) selectAt(card.id, filteredAndSortedCards.map(c => c.id), event?.shiftKey);
    else openQuickAdd(card);
  };

  const handleBulkAdd = async () => {
    const ids = filteredAndSortedCards.filter(c => selectedIds.has(c.id)).map(c => c.id);
    if (ids.length === 0) { showToast(t('search.errNoneSelected'), 'error'); return; }
    setBulkAdding(true);
    try {
      const response = await fetch('/api/collection/bulk-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_ids: ids,
          quantity: parseInt(quantity, 10) || 1,
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          list_type: addToArena ? 'arena' : 'collection',
          game
        })
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        showToast(data.message || t('search.addedCards', { count: ids.length }), 'success');
        // Reflect the new owned counts without re-running the search.
        const added = parseInt(quantity, 10) || 1;
        setCards(prev => prev.map(c => (selectedIds.has(c.id)
          ? { ...c, owned_qty: (c.owned_qty || 0) + added }
          : c)));
        exitSelectMode();
        onAddSuccess();
      } else {
        showToast(data.error || t('search.errBulkAdd'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('search.errAddCards'), 'error');
    } finally {
      setBulkAdding(false);
    }
  };

  // One card straight into the collection, no drawer. Stacked on purpose: one
  // Enter press becomes exactly one row, so undo removes exactly what it added
  // (an unstacked qty-3 add would leave two orphan copies behind).
  const addCardNow = async (card) => {
    const response = await fetch('/api/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card_id: card.id,
        quantity: parseInt(quantity, 10) || 1,
        condition,
        printing,
        language,
        purchase_price: parseFloat(purchasePrice) || 0,
        game,
        stackable: true,
        list_type: addToArena ? 'arena' : 'collection'
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t('search.errAddCard'));
    return data;
  };

  // Enter in the rapid field: look the number up in the pinned set and add it.
  // One unambiguous match adds immediately; anything else falls back to the
  // normal result grid rather than guessing which printing was meant.
  const handleRapidAdd = async () => {
    const number = rapidNumber.trim();
    if (!number || rapidBusy) return;
    if (!setCodeQuery.trim()) { showToast(t('search.errNoSetCode'), 'error'); return; }
    setRapidBusy(true);
    try {
      const params = new URLSearchParams({
        number, set: setCodeQuery, scope: 'internet', game, lang: searchLang, page: '1', limit: '10'
      });
      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || t('search.errLookup'), 'error');
        return;
      }
      const matches = await res.json();
      const exact = matches.filter(c => String(c.number) === number || parseInt(c.number, 10) === parseInt(number, 10));
      const hit = exact.length === 1 ? exact[0] : (matches.length === 1 ? matches[0] : null);

      if (!hit) {
        if (matches.length === 0) {
          showToast(t('search.errNoSuchNumber', { number, set: setCodeQuery.toUpperCase() }), 'error');
        } else {
          // Ambiguous: show them and let the user pick, keeping the number typed.
          setCards(matches);
          setSearching(true);
          showToast(t('search.pickPrinting', { count: matches.length, number }), 'status');
        }
        return;
      }

      const result = await addCardNow(hit);
      setRapidLog(prev => [{ entryId: result.id, card: hit, qty: parseInt(quantity, 10) || 1 }, ...prev].slice(0, 25));
      setRapidNumber('');
      // Keep the owned badge honest if the card is also on screen.
      if (!addToArena) {
        setCards(prev => prev.map(c => (c.id === hit.id
          ? { ...c, owned_qty: (c.owned_qty || 0) + (parseInt(quantity, 10) || 1) }
          : c)));
      }
      onAddSuccess();
    } catch (err) {
      console.error(err);
      showToast(err.message || t('search.errAddCardGeneric'), 'error');
    } finally {
      setRapidBusy(false);
      // Focus never leaves the field, so the next number can just be typed.
      rapidInputRef.current?.focus();
    }
  };

  const undoRapidAdd = async (entry) => {
    try {
      const res = await fetch(`/api/collection/${entry.entryId}`, { method: 'DELETE' });
      if (!res.ok) { showToast(t('search.errUndo'), 'error'); return; }
      setRapidLog(prev => prev.filter(e => e.entryId !== entry.entryId));
      setCards(prev => prev.map(c => (c.id === entry.card.id
        ? { ...c, owned_qty: Math.max(0, (c.owned_qty || 0) - entry.qty) }
        : c)));
      showToast(t('search.removed', { name: displayName(entry.card) }), 'success');
      onAddSuccess();
    } catch (err) {
      console.error(err);
      showToast(t('search.errUndoGeneric'), 'error');
    }
  };

  const handleLanguageChange = async (newLang) => {
    if (!selectedCard || addPending.current) return;
    setLanguage(newLang);
    const request = ++printingRequest.current;
    const generation = drawerGeneration.current;
    printingPending.current = true;
    setLocalizing(true);
    const isCurrent = () => request === printingRequest.current && generation === drawerGeneration.current;
    try {
      const targetGame = selectedCard.game || game;
      const resp = await fetch(`/api/cards/${encodeURIComponent(selectedCard.id)}/printing?lang=${encodeURIComponent(newLang)}&game=${encodeURIComponent(targetGame)}`);
      if (resp.ok) {
        const localized = await resp.json();
        if (isCurrent() && localized?.id) {
          setSelectedCard({ ...selectedCard, ...localized, language: newLang });
          return;
        }
      }
      if (isCurrent()) setLanguage(selectedCard.language || langName(searchLang));
    } catch (e) {
      if (isCurrent()) setLanguage(selectedCard.language || langName(searchLang));
      console.warn('Could not switch to localized printing:', e);
    } finally {
      if (isCurrent()) {
        printingPending.current = false;
        setLocalizing(false);
      }
    }
  };

  const openQuickAdd = (card) => {
    drawerGeneration.current++;
    printingRequest.current++;
    printingPending.current = false;
    setLocalizing(false);
    addPending.current = false;
    setAdding(false);
    setSelectedCard(card);
    setPurchasePrice(0); // Default to 0 purchase spend
    // The card itself knows which printing it is, so the copy is recorded in that
    // language rather than defaulting to English and needing a manual correction.
    setLanguage(card.language || langName(searchLang));
    setPrinting('Normal');


    setIsDrawerOpen(true);
  };

  const closeDrawer = () => {
    drawerGeneration.current++;
    printingRequest.current++;
    printingPending.current = false;
    setLocalizing(false);
    addPending.current = false;
    setAdding(false);
    setIsDrawerOpen(false);
    setIsFullScreen(false);
    setSelectedCard(null);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('Normal');
    // Back to the searched language, not hard-coded English: someone adding a run
    // of Japanese cards should not have to re-pick it for every card.
    setLanguage(langName(searchLang));
    setPurchasePrice(0);
    setGrader('Raw');
    setGrade('');
    setCertNumber('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard || addPending.current || printingPending.current) return;
    addPending.current = true;
    setAdding(true);
    const generation = drawerGeneration.current;
    const action = e.nativeEvent.submitter?.value || 'collection';
    const listType = addToArena && action === 'collection' ? 'arena' : action;

    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: selectedCard.id,
          quantity: parseInt(quantity, 10),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: null,
          list_type: listType,
          grader,
          grade: grade === '' ? null : parseFloat(grade),
          cert_number: certNumber.trim() || null
        })
      });
      if (generation !== drawerGeneration.current) {
        if (response.ok) onAddSuccess();
        return;
      }

      if (response.ok) {
        showToast(t('search.addedToCollection', { name: displayName(selectedCard) }), 'success');
        
        // Trigger confetti for rare/valuable cards!
        const rarity = (selectedCard.rarity || '').toLowerCase();
        const price = selectedCard.price_trend || 0;
        if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || price > 10) {
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }

        onAddSuccess(); // Update stats
        closeDrawer();
      } else {
        // A rejected cert number (already in the collection) explains itself; the
        // generic message would send the user back to re-type a correct number.
        const body = await response.json().catch(() => null);
        if (generation === drawerGeneration.current) showToast(body?.error || t('search.errAddDb'), 'error');
      }
    } catch (err) {
      console.error(err);
      if (generation === drawerGeneration.current) showToast(t('search.errSave'), 'error');
    } finally {
      if (generation === drawerGeneration.current) {
        addPending.current = false;
        setAdding(false);
      }
    }
  };

  const handleImportFile = (event, format) => {
    const file = event.target.files[0];
    if (!file || importingText) return;
    const reader = new FileReader();
    const controller = new AbortController();
    importFileReader.current = reader;
    importRequest.current = controller;
    const listType = addToArena ? 'arena' : 'collection';
    setImportingText(true);
    setImportLog([]);
    reader.onload = async () => {
      try {
        const text = String(reader.result || '');
        const response = await fetch('/api/import/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ format, data: text })
        });
        const summary = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        const preview = { ...summary, text, filename: file.name, listType };
        if (format === 'internal') {
          setCsvPreview({
            ...preview,
            errors: response.ok ? summary.errors || [] : [summary.error || t('settings.importFailed', { error: '' })],
            mapping: suggestedCsvMapping(summary.headers || [])
          });
        } else {
          if (!response.ok) throw new Error(summary.error || t('settings.importFailed', { error: '' }));
          setManaBoxPreview(preview);
        }
      } catch (error) {
        if (!controller.signal.aborted) showToast(error.message || t('settings.importFailed', { error: '' }), 'error');
      } finally {
        if (!controller.signal.aborted) setImportingText(false);
        if (importRequest.current === controller) importRequest.current = null;
        if (importFileReader.current === reader) importFileReader.current = null;
      }
    };
    reader.onerror = () => {
      if (!controller.signal.aborted) {
        showToast(t('settings.errReadFile'), 'error');
        setImportingText(false);
      }
      if (importRequest.current === controller) importRequest.current = null;
      if (importFileReader.current === reader) importFileReader.current = null;
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const refreshCsvPreview = async () => {
    if (!csvPreview || importingText) return;
    const controller = new AbortController();
    importRequest.current = controller;
    setImportingText(true);
    try {
      const response = await fetch('/api/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ format: 'internal', data: csvPreview.text, mapping: csvPreview.mapping })
      });
      const summary = await response.json().catch(() => ({}));
      if (controller.signal.aborted) return;
      setCsvPreview(preview => ({
        ...preview,
        ...summary,
        errors: response.ok ? summary.errors || [] : [summary.error || t('settings.importFailed', { error: '' })]
      }));
    } catch (error) {
      if (!controller.signal.aborted) showToast(error.message || t('settings.importFailed', { error: '' }), 'error');
    } finally {
      if (!controller.signal.aborted) setImportingText(false);
      if (importRequest.current === controller) importRequest.current = null;
    }
  };

  const downloadFailedImport = () => {
    const text = importSummary.failed.items.map(item => {
      const printing = item.set_code && item.collector_number
        ? ` (${item.set_code}) ${item.collector_number}`
        : '';
      return `${item.quantity} ${item.name}${printing}`;
    }).join('\n');
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${importSummary.filename.replace(/\.[^.]+$/, '')}-failed.txt`);
  };

  const commitImport = async (format, preview) => {
    if (!preview || importingText || (format === 'internal' && preview.errors.length)) return;
    const controller = new AbortController();
    importRequest.current = controller;
    setImportingText(true);
    setImportLog([]);
    appendImportLog({ stage: 'connecting' });
    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        signal: controller.signal,
        body: JSON.stringify({ format, data: preview.text, list_type: preview.listType, ...(format === 'internal' ? { mapping: preview.mapping } : {}) })
      });
      const data = await readProgressStream(response, event => {
        if (!controller.signal.aborted && ['parsed', 'local-lookup', 'local-resolved', 'api-fallback', 'lookup', 'retry', 'resolved', 'caching', 'saving', 'saved'].includes(event.stage)) appendImportLog(event);
      }, {
        failed: t('settings.importFailed', { error: '' }),
        incomplete: t('importLog.incomplete'),
        invalid: t('importLog.invalid')
      });
      if (controller.signal.aborted) return;
      if (!data.summary || typeof data.summary !== 'object' || Array.isArray(data.summary)) throw new Error(t('importLog.invalid'));
      appendImportLog({ stage: 'complete' });
      setCsvPreview(null);
      setManaBoxPreview(null);
      setImportSummary({ ...data.summary, filename: preview.filename });
      onAddSuccess();
    } catch (error) {
      if (!controller.signal.aborted) {
        appendImportLog({ stage: 'failed', error: error.message || t('settings.importFailed', { error: '' }) });
      }
    } finally {
      if (!controller.signal.aborted) setImportingText(false);
      if (importRequest.current === controller) importRequest.current = null;
    }
  };

  // Helper to determine location type layout guidance
  return (
    <div className="card-search">
      {/* Search Header Panel */}
      <div className="glass-panel" style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', margin: 0, color: 'var(--text-strong)' }}>{t('search.title', { game: gameLabel(game) })}</h2>
        </div>
        <form onSubmit={handleSearch} style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label className="control-label" htmlFor="search-card-name">{t('search.cardName')}</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="search-card-name"
                  type="text"
                  className="input-control"
                  placeholder={t('search.namePlaceholderMtg')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ width: '100%', paddingLeft: '2.5rem' }}
                />
                <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              </div>
            </div>
          </div>

          {/* auto-fit rather than a fixed 2 columns: language made this row three
              fields wide, and they have to stay usable on a phone. */}
          <div className="search-filter-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {/* The language of the cards being searched for, not the app's. */}
              <label className="control-label" htmlFor="search-language">{t('search.language')}</label>
              <select
                id="search-language"
                className="select-control"
                value={searchLang}
                onChange={(e) => {
                  const code = e.target.value;
                  setSearchLang(code);
                  // The copy being added is almost always in the language just
                  // searched, so make that the entry default instead of English.
                  setLanguage(langName(code));
                  // Clear the set scope when switching the printing language.
                  setSetCodeQuery('');
                }}
              >
                {getLanguagesForGame(game).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label className="control-label" htmlFor="search-card-number">{t('search.cardNumber')}</label>
              <input
                id="search-card-number"
                type="text"
                className="input-control"
                placeholder={t('search.numberPlaceholder')}
                value={numberQuery}
                onChange={(e) => setNumberQuery(e.target.value)}
              />
            </div>
            <div className="search-sets-field" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', position: 'relative' }}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSetsOpen(false); }}
              onKeyDown={event => { if (event.key === 'Escape') setSetsOpen(false); }}>
              <label className="control-label" htmlFor="search-set-codes">{t('search.sets')}</label>
              <input
                id="search-set-codes"
                type="text"
                className="input-control"
                autoComplete="off"
                placeholder={t('search.setsPlaceholderMtg')}
                value={setCodeQuery}
                onFocus={() => setSetsOpen(true)}
                onChange={event => { setSetCodeQuery(event.target.value); setSetsOpen(true); }}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {knownSets.filter(set => setCodeQuery.toLowerCase().split(/[\s,]+/).includes(set.code.toLowerCase())).map(set => (
                  <span key={set.code} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
                    {set.symbol_url && <img src={set.symbol_url} alt="" width="20" height="20" style={{ objectFit: 'contain', background: '#fff', borderRadius: '3px', padding: '2px' }} onError={event => { event.currentTarget.style.display = 'none'; }} />}
                    {set.name} ({set.code.toUpperCase()})
                  </span>
                ))}
              </div>
              {setsOpen && (
                <section id="known-set-codes" aria-label={t('search.setSuggestions')} style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, maxHeight: '260px', overflowY: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }}>
                  {knownSets.filter(set => {
                    const term = setCodeQuery.split(/[\s,]+/).at(-1).toLowerCase();
                    return !term || set.code.toLowerCase().includes(term) || set.name.toLowerCase().includes(term);
                  }).map(set => (
                    <button key={set.code} type="button" className="btn btn-secondary"
                      style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', gap: '0.5rem', textAlign: 'left' }}
                      onClick={() => {
                        setSetCodeQuery(previous => previous.replace(/[^\s,]*$/, set.code));
                        setSetsOpen(false);
                      }}>
                      {set.symbol_url && <img src={set.symbol_url} alt="" width="24" height="24" loading="lazy" style={{ objectFit: 'contain', background: '#fff', borderRadius: '3px', padding: '2px' }} onError={event => { event.currentTarget.style.display = 'none'; }} />}
                      {set.name} ({set.code.toUpperCase()})
                    </button>
                  ))}
                </section>
              )}
            </div>
          </div>

          <div className="search-actions" style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={loading || loadingMore} aria-busy={loading} style={{ flex: '1 1 220px' }}>
              {loading
                ? <span className="spinner" aria-hidden="true" style={{ width: 18, height: 18, margin: 0, borderWidth: 2, borderColor: 'currentColor', borderTopColor: 'transparent' }} />
                : <Search size={18} aria-hidden="true" />}
              {t('search.submit')}
            </button>
            <button
              type="button"
              className={`btn ${rapidMode ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={rapidMode}
              onClick={() => {
                const next = !rapidMode;
                setRapidMode(next);
                if (next) setTimeout(() => rapidInputRef.current?.focus(), 0);
              }}
              title={t('search.rapidHint')}
              style={{ flex: '0 1 auto' }}
            >
              <Zap size={18} />
              {t(rapidMode ? 'search.rapidOn' : 'search.rapid')}
            </button>
          </div>
          <span role="status" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}>
            {loading ? t('common.loading') : ''}
          </span>
        </form>
        <div className="search-destination">
          <label className="control-label" htmlFor="search-destination">{t('search.destination')}</label>
          <select id="search-destination" className="select-control" aria-describedby="search-destination-hint" value={addToArena ? 'arena' : 'collection'} onChange={event => setAddToArena(event.target.value === 'arena')}>
            <option value="collection">{t('nav.collection')}</option>
            <option value="arena">{t('collection.arena')}</option>
          </select>
          <p id="search-destination-hint">{t('search.destinationHint')}</p>
        </div>
        <section className="search-import-actions" aria-labelledby="search-import-title">
          <h3 id="search-import-title" className="section-heading">{t('search.importTitle')}</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            <button type="button" className="btn btn-secondary" onClick={() => textImportInput.current?.click()} disabled={importingText}>
              <Download size={18} aria-hidden="true" />
              {importingText ? t('settings.importing') : t('deck.chooseManaBoxFile')}
            </button>
            <input ref={textImportInput} type="file" accept=".txt,text/plain" onChange={event => handleImportFile(event, 'manabox')} style={{ display: 'none' }} />
            <button type="button" className="btn btn-secondary" onClick={() => csvImportInput.current?.click()} disabled={importingText}>
              <Download size={18} aria-hidden="true" />
              {importingText ? t('settings.importing') : t('search.chooseCsvFile')}
            </button>
            <input ref={csvImportInput} type="file" accept=".csv,text/csv" onChange={event => handleImportFile(event, 'internal')} style={{ display: 'none' }} />
          </div>
        </section>
      </div>

      {/* Rapid add: type a number, press Enter, next. */}
      {rapidMode && (
        <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', borderLeft: '4px solid var(--accent-yellow)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Zap size={18} style={{ color: 'var(--accent-yellow)' }} />
            <strong style={{ color: 'var(--text-strong)', fontSize: '0.95rem' }}>
              {setCodeQuery ? t('search.rapidToSet', { set: setCodeQuery.toUpperCase() }) : t('search.rapid')}
            </strong>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {t(setCodeQuery ? 'search.rapidReady' : 'search.rapidNeedsSet')}
            </span>
          </div>

          <div className="search-entry-controls" style={{ display: 'flex', gap: '0.5rem', alignItems: 'end', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ flex: '1 1 180px', margin: 0 }}>
              <label className="control-label" htmlFor="rapid-card-number">{t('csvMapping.collectorNumber')}</label>
            <input
              ref={rapidInputRef}
              id="rapid-card-number"
              type="text"
              inputMode="numeric"
              className="input-control"
              placeholder={t('search.rapidNumberPlaceholder')}
              value={rapidNumber}
              // Never disabled mid-add: disabling blurs the field, and the
              // refocus would land on a still-disabled element, forcing a click
              // back in for every card. Re-entry is guarded in the handler.
              disabled={!setCodeQuery}
              onChange={(e) => setRapidNumber(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleRapidAdd(); } }}
              style={{ width: '100%', fontSize: '1.1rem', fontWeight: 700 }}
            />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="control-label" htmlFor="rapid-condition">{t('card.condition')}</label>
            <select id="rapid-condition" className="select-control" value={condition} onChange={(e) => setCondition(e.target.value)}>
              {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="control-label" htmlFor="rapid-printing">{t('card.printing')}</label>
            <select id="rapid-printing" className="select-control" value={printing} onChange={(e) => setPrinting(e.target.value)}>
              {getPrintings().map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="control-label" htmlFor="rapid-quantity">{t('card.quantity')}</label>
            <input
              id="rapid-quantity"
              type="number"
              min="1"
              className="input-control"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              title={t('search.copiesPerEnter')}
              style={{ width: '80px', fontSize: '0.75rem' }}
            />
            </div>
            {rapidBusy && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('search.adding')}</span>}
          </div>

          {rapidLog.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                {t('search.addedThisSession', { count: rapidLog.length })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '0.75rem', maxHeight: '55vh', overflowY: 'auto' }}>
              {rapidLog.map(entry => (
                <div key={entry.entryId} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0, background: 'var(--surface-2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <CardImage card={entry.card} alt={displayName(entry.card)} style={{ width: '100%', aspectRatio: '0.718', objectFit: 'contain', borderRadius: 'var(--radius-sm)' }} />
                  <span title={`#${entry.card.number} ${displayName(entry.card)}`} style={{ fontSize: '0.8rem', color: 'var(--text-strong)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    #{entry.card.number} {displayName(entry.card)}{entry.qty > 1 ? ` ×${entry.qty}` : ''}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.5rem', marginTop: 'auto', justifyContent: 'center' }}
                    onClick={() => undoRapidAdd(entry)}
                  >
                    <Undo2 size={12} /> {t('search.undo')}
                  </button>
                </div>
              ))}
              </div>
            </div>
          )}
        </div>
      )}

      {searchError && (
        <div role="alert" className="glass-panel" style={{ borderLeft: '4px solid var(--accent-red)', background: 'rgba(239, 68, 68, 0.08)', padding: '1.25rem', marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
            <ShieldAlert size={18} />
            {t(`searchErr.${searchError}.title`)}
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
            {t(`searchErr.${searchError}.body`)}
          </p>
        </div>
      )}

      {/* Filters and Sorting Panel */}
      {!loading && cards.length > 0 && (
        <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label className="control-label" htmlFor="search-filter-type">{t('search.filterType')}</label>
              <select id="search-filter-type" className="select-control" value={filterType} onChange={e => setFilterType(e.target.value)}>
                <option value="">{t('collection.allTypes')}</option>
                {uniqueTypes.map(type => <option key={type} value={type}>{type}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label className="control-label" htmlFor="search-filter-rarity">{t('search.filterRarity')}</label>
              <select id="search-filter-rarity" className="select-control" value={filterRarity} onChange={e => setFilterRarity(e.target.value)}>
                <option value="">{t('collection.allRarities')}</option>
                {uniqueRarities.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>


            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label className="control-label" htmlFor="search-sort">{t('search.sortBy')}</label>
              <select id="search-sort" className="select-control" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                {['relevance', 'name-asc', 'name-desc', 'price-asc', 'price-desc', 'number-asc', 'number-desc']
                  .map(key => <option key={key} value={key}>{t(`search.sort.${key}`)}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label className="control-label" htmlFor="search-page-size">{t('search.cardsPerPage')}</label>
              <select id="search-page-size" className="select-control" value={pageSize} onChange={e => changePageSize(parseInt(e.target.value, 10))}>
                {[30, 60, 120, 250].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {t('search.showingMatches', { shown: filteredAndSortedCards.length, count: total != null ? total : cards.length })}
              {total != null && cards.length < total ? ` ${t('search.loadedSuffix', { loaded: cards.length })}` : ''}
            </span>
            {/* Same control, label and icon as the collection's select toggle. */}
            <button
              type="button"
              className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
              title={t('collection.selectHint')}
            >
              <MousePointerClick size={14} />
              {t(selectMode ? 'bulk.done' : 'collection.select')}
            </button>
          </div>
        </div>
      )}

      {/* Bulk add bar — sticky single row, matching the collection's bulk bar. */}
      {selectMode && (
        <div className="glass-panel" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('bulk.selected', { count: selectedIds.size })}</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={() => setSelectedIds(new Set(filteredAndSortedCards.map(c => c.id)))}>{t('bulk.selectAll', { count: filteredAndSortedCards.length })}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={clearSelection}>{t('bulk.clear')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <div className="form-group" style={{ margin: 0 }}>
            <label className="control-label" htmlFor="search-bulk-condition">{t('card.condition')}</label>
          <select id="search-bulk-condition" className="select-control" value={condition} onChange={(e) => setCondition(e.target.value)}>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="control-label" htmlFor="search-bulk-printing">{t('card.printing')}</label>
          <select id="search-bulk-printing" className="select-control" value={printing} onChange={(e) => setPrinting(e.target.value)}>
            {getPrintings().map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="control-label" htmlFor="search-bulk-quantity">{t('card.quantity')}</label>
          <input
            id="search-bulk-quantity"
            type="number"
            min="1"
            className="input-control"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            title={t('search.copiesEachSelected')}
            style={{ fontSize: '0.72rem', width: '70px', padding: '0.3rem 0.4rem' }}
          />
          </div>
          <button
            className="btn btn-primary"
            style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }}
            disabled={bulkAdding || selectedIds.size === 0}
            onClick={handleBulkAdd}
          >
            {bulkAdding ? t('search.adding') : t('search.addN', { count: selectedIds.size })}
          </button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', marginLeft: 'auto' }} onClick={exitSelectMode}>{t('bulk.done')}</button>
        </div>
      )}

      {/* Search Results Grid */}
      {!loading && cards.length > 0 && filteredAndSortedCards.length > 0 && (
        <div className="card-grid">
          {filteredAndSortedCards.map((card) => {
            const isSelected = selectedIds.has(card.id);
            return (
              <div
                key={card.id}
                className="tcg-card"
                style={{ cursor: 'pointer', touchAction: 'pan-y' }}
                role="button"
                tabIndex={0}
                aria-label={`${t(selectMode ? 'collection.select' : 'search.quickAdd')}: ${displayName(card)}`}
                aria-pressed={selectMode ? isSelected : undefined}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleCardClick(card, event);
                  }
                }}
                onClick={(e) => handleCardClick(card, e)}
                {...pressHandlers(card.id)}
              >
                <div className="tcg-card-inner" style={isSelected ? { outline: '3px solid var(--accent-red)', outlineOffset: '2px' } : undefined}>
                  {/* Same check bubble the collection uses for selection. */}
                  {selectMode && (
                    <div style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 20, width: '22px', height: '22px', borderRadius: '50%', background: isSelected ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontSize: '0.8rem', fontWeight: 900 }}>{isSelected ? '✓' : ''}</div>
                  )}
                  <CardImage card={card} className="tcg-card-image" loading="lazy" draggable={false} />
                  {/* Already-in-the-binder count, so a set browse doesn't invite
                      re-adding what the user already has. */}
                  {card.owned_qty > 0 && (
                    <div style={{ position: 'absolute', top: '8px', left: '8px', background: 'var(--accent-green, #22c55e)', color: '#04210f', padding: '2px 6px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '3px', fontSize: '0.65rem', fontWeight: 800 }}>
                      <Check size={10} /> {card.owned_qty}
                    </div>
                  )}
                  {!selectMode && (
                    <div style={{ position: 'absolute', bottom: '8px', right: '8px', background: 'rgba(0,0,0,0.85)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border-glass-hover)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Plus size={10} style={{ color: 'var(--accent-red)' }} />
                      <span style={{ fontSize: '0.65rem', fontWeight: 700 }}>{t('search.quickAdd')}</span>
                    </div>
                  )}
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{displayName(card)}</div>
                  {/* Second line only when the localized name needs help: the
                      English name where a provider gives us one (Magic always
                      does), otherwise the set code — language-independent, and the
                      only handle you have on a card whose name you can't read. */}
                  {translatedName(card) ? (
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {translatedName(card)}
                    </div>
                  ) : !isEnglish(card.language) && setReference(card) ? (
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {setReference(card)}
                    </div>
                  ) : null}
                  <div className="tcg-card-meta">
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{card.set_name}</span>
                    <span className="tcg-card-price">{priceText(card.price_trend, card.price_currency)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Load More */}
      {!loading && hasMore && cards.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', margin: '1.5rem 0' }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loadingMore}
            onClick={() => runSearch(page + 1)}
          >
            {loadingMore ? 'Loading...' : `Load ${pageSize} more`}
          </button>
        </div>
      )}

      {/* Filtered Empty State */}
      {!loading && cards.length > 0 && filteredAndSortedCards.length === 0 && (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem', marginBottom: '2rem' }}>
          <p>{t('search.noFilterMatches')}</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && searching && !searchError && cards.length === 0 && (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>{t('search.noQueryMatches')}</p>
        </div>
      )}

      {/* Drawer Dialog Backdrop */}
      <div className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>

      {/* Quick Add Drawer Sheet */}
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
              <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                <h3 style={{ color: 'var(--text-strong)', fontSize: '1.25rem', margin: 0, wordBreak: 'break-word' }}>{t('search.addCardTitle')}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.25rem 0 0 0', wordBreak: 'break-word' }}>
                  {getCardDisplayName(selectedCard.name, selectedCard.printed_name)}
                  {translatedName(selectedCard) && <span style={{ color: 'var(--text-muted)' }}> ({translatedName(selectedCard)})</span>}
                  {' '}({selectedCard.set_name}
                  {/* Code only where the set name isn't readable to an English speaker. */}
                  {!isEnglish(selectedCard.language) && setCode(selectedCard) ? ` / ${setCode(selectedCard)}` : ''}
                  {' • '}#{selectedCard.number})
                </p>
              </div>
              <button type="button" aria-label={t('common.close')} className="btn btn-secondary btn-icon-only" onClick={closeDrawer} style={{ borderRadius: '50%', flexShrink: 0 }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
              {/* Tap the art to enlarge, same as the collection inspector. */}
              <button type="button" className="ci-image-wrap" aria-label={t('inspector.zoomHint')} aria-haspopup="dialog"
                onClick={() => setIsFullScreen(true)}
                title={t('inspector.zoomHint')}
                style={{ position: 'relative', flexShrink: 0, cursor: 'pointer', lineHeight: 0 }}
              >
                <CardImage card={selectedCard} style={{ width: '75px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: 'var(--radius-sm)', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }} />
                <div style={{
                  position: 'absolute', bottom: '4px', right: '4px',
                  background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
                  padding: '2px 4px', borderRadius: '4px', color: '#fff',
                  display: 'flex', alignItems: 'center', pointerEvents: 'none',
                  border: '1px solid rgba(255,255,255,0.15)'
                }}>
                  <Maximize2 size={11} />
                </div>
              </button>
              <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('search.tcgMarketPrice', { printing })}</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--accent-yellow)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{priceText(resolveCardPrice(selectedCard, printing), selectedCard.price_currency)}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('search.rarityLabel')} <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{selectedCard.rarity}</span></div>
              </div>
            </div>

            <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
              <CardEntryFields
                quantity={quantity} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                onQuantity={setQuantity} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={handleLanguageChange}
                game={selectedCard?.game || game}
                grader={grader} grade={grade} certNumber={certNumber}
                onGrader={setGrader} onGrade={setGrade} onCertNumber={setCertNumber}
              />


              <div className="quick-add-footer" style={{ marginTop: '1.25rem', paddingTop: '1rem' }}>
                <div className="quick-add-footer-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeDrawer}>{t('common.cancel')}</button>
                  <button type="submit" value="wishlist" className="btn btn-secondary" disabled={adding || localizing} aria-busy={adding || localizing}>{t('search.addToWishlist')}</button>
                  <button type="submit" value="collection" className="btn btn-primary" disabled={adding || localizing} aria-busy={adding || localizing}>{t(addToArena ? 'search.addToArena' : 'search.addToCollection')}</button>
                </div>
              </div>
            </form>
          </div>
        )}
      </div>

      {manaBoxPreview && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0, 0, 0, 0.78)', display: 'grid', placeItems: 'center', padding: '1rem' }}
          onClick={() => !importingText && setManaBoxPreview(null)}
        >
          <div className="glass-panel" role="dialog" aria-modal="true" aria-label={t('manaboxPreview.title')} onClick={event => event.stopPropagation()} style={{ width: '100%', maxWidth: '420px', minWidth: 0, maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', display: 'grid', gap: '1rem' }}>
            <div>
              <h2 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('manaboxPreview.title')}</h2>
              <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{manaBoxPreview.filename}</p>
              <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)' }}>{t('csvPreview.destination', { destination: t(manaBoxPreview.listType === 'arena' ? 'collection.arena' : 'nav.collection') })}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.8rem' }}>
              {[
                [t('manaboxPreview.cards'), manaBoxPreview.cards],
                [t('manaboxPreview.normal'), manaBoxPreview.normal],
                [t('manaboxPreview.foils'), manaBoxPreview.foils],
              ].map(([label, value]) => (
                <div key={label} style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)', textAlign: 'center' }}>
                  <strong style={{ display: 'block', color: 'var(--text-strong)', fontSize: '1rem' }}>{value}</strong>
                  <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('manaboxPreview.printings', { count: manaBoxPreview.printings })}</p>
            <ImportLog entries={importLog} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setManaBoxPreview(null)} disabled={importingText}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={() => commitImport('manabox', manaBoxPreview)} disabled={importingText}>{importingText ? t('settings.importing') : t('manaboxPreview.commit')}</button>
            </div>
          </div>
        </div>
      )}

      {csvPreview && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0, 0, 0, 0.78)', display: 'grid', placeItems: 'center', padding: '1rem' }}
          onClick={() => !importingText && setCsvPreview(null)}
        >
          <div className="glass-panel" role="dialog" aria-modal="true" aria-label={t('csvPreview.title')} onClick={event => event.stopPropagation()} style={{ width: '100%', maxWidth: '520px', minWidth: 0, maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', display: 'grid', gap: '1rem' }}>
            <div>
              <h2 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('csvPreview.title')}</h2>
              <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{csvPreview.filename}</p>
              <p style={{ margin: '0.2rem 0 0', color: 'var(--text-muted)', fontSize: '0.75rem' }}>{t('csvPreview.destination', { destination: t(csvPreview.listType === 'arena' ? 'collection.arena' : 'nav.collection') })}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', fontSize: '0.8rem' }}>
              {[
                [t('csvPreview.cards'), csvPreview.cards || 0],
                [t('csvPreview.copies'), csvPreview.quantity || 0],
              ].map(([label, value]) => (
                <div key={label} style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)', textAlign: 'center' }}>
                  <strong style={{ display: 'block', color: 'var(--text-strong)', fontSize: '1rem' }}>{value}</strong>
                  <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <strong style={{ color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('csvMapping.title')}</strong>
              <div style={{ maxHeight: '190px', overflowY: 'auto', display: 'grid', gap: '0.4rem' }}>
                {CSV_FIELDS.map(([field, label]) => (
                  <label key={field} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: '0.5rem', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                    <span>{t(label)}</span>
                    <select
                      disabled={importingText}
                      style={{ minWidth: 0, width: '100%' }}
                      value={csvPreview.mapping?.[field] || ''}
                      onChange={event => setCsvPreview(preview => ({ ...preview, errors: [], mapping: { ...preview.mapping, [field]: event.target.value } }))}
                    >
                      <option value="">{t('csvMapping.unused')}</option>
                      {(csvPreview.headers || []).map(header => <option key={header} value={header}>{header}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <button type="button" className="btn btn-secondary" onClick={refreshCsvPreview} disabled={importingText}>{t('csvMapping.refresh')}</button>
            </div>
            {csvPreview.errors.length > 0 && (
              <div style={{ display: 'grid', gap: '0.4rem' }}>
                <strong style={{ color: 'var(--accent-red)', fontSize: '0.85rem' }}>{t('csvPreview.errors')}</strong>
                <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'grid', gap: '0.35rem' }}>
                  {csvPreview.errors.map((error, index) => (
                    <div key={`${error}-${index}`} style={{ padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-sm)', background: 'rgba(239, 68, 68, 0.1)', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{error}</div>
                  ))}
                </div>
              </div>
            )}
            <ImportLog entries={importLog} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setCsvPreview(null)} disabled={importingText}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={() => commitImport('internal', csvPreview)} disabled={importingText || csvPreview.errors.length > 0}>{importingText ? t('settings.importing') : t('csvPreview.commit')}</button>
            </div>
          </div>
        </div>
      )}

      {importSummary && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0, 0, 0, 0.78)', display: 'grid', placeItems: 'center', padding: '1rem' }}
          onClick={() => setImportSummary(null)}
        >
          <div className="glass-panel" role="dialog" aria-modal="true" aria-label={t('importSummary.title')} onClick={event => event.stopPropagation()} style={{ width: '100%', maxWidth: '520px', minWidth: 0, maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', display: 'grid', gap: '1rem' }}>
            <div>
              <h2 style={{ margin: 0, color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('importSummary.title')}</h2>
              <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{importSummary.filename}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', fontSize: '0.8rem' }}>
              {[
                [t('importSummary.added'), importSummary.added],
                [t('importSummary.failed'), importSummary.failed]
              ].map(([label, summary]) => (
                <div key={label} style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)', textAlign: 'center' }}>
                  <strong style={{ display: 'block', color: 'var(--text-strong)', fontSize: '1rem' }}>{summary.cards} {t('importSummary.cards')}</strong>
                  <span style={{ color: 'var(--text-muted)' }}>{summary.copies} {t('importSummary.copies')} · {label}</span>
                </div>
              ))}
            </div>
            <ImportLog entries={importLog} />
            {importSummary.added.items.length > 0 && (
              <div style={{ display: 'grid', gap: '0.4rem' }}>
                <strong style={{ color: 'var(--accent-green)', fontSize: '0.85rem' }}>{t('importSummary.addedCards')}</strong>
                <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'grid', gap: '0.35rem' }}>
                  {importSummary.added.items.map((item, index) => (
                    <div key={`${item.name}-${index}`} style={{ padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-sm)', background: 'rgba(34, 197, 94, 0.1)', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{item.quantity}× {item.name}</div>
                  ))}
                </div>
              </div>
            )}
            {importSummary.failed.items.length > 0 && (
              <div style={{ display: 'grid', gap: '0.4rem' }}>
                <strong style={{ color: 'var(--accent-red)', fontSize: '0.85rem' }}>{t('importSummary.failedCards')}</strong>
                <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'grid', gap: '0.35rem' }}>
                  {importSummary.failed.items.map((item, index) => (
                    <div key={`${item.name}-${index}`} style={{ padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-sm)', background: 'rgba(239, 68, 68, 0.1)', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{item.quantity}× {item.name}</div>
                  ))}
                </div>
                <button type="button" className="btn btn-secondary" onClick={downloadFailedImport}><Download size={16} /> {t('importSummary.downloadFailed')}</button>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" onClick={() => setImportSummary(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Outside the drawer on purpose: .quick-add-drawer is transformed, and a
          transformed ancestor becomes the containing block for position:fixed,
          which would trap this overlay inside the drawer instead of the page. */}
      {isFullScreen && selectedCard && (
        <CardImageZoom card={selectedCard} onClose={() => setIsFullScreen(false)} />
      )}
    </div>
  );
}

export default CardSearch;
