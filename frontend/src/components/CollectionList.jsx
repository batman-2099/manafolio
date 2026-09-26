import { useState, useEffect, useMemo } from 'react';
import { Search, Trash2, Edit2, LayoutGrid, List, SlidersHorizontal, X, MousePointerClick, Download, ChevronDown } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { priceText } from '../utils/formatPrice';
import { CONDITIONS, getPrintings, GRADERS } from '../utils/cardOptions';
import { getPrintingBadgeLabel, getPrintingBadgeStyle, getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { sortCardsByOrder } from '../utils/cardSort';
import { buildCollectionExport } from '../utils/collectionExport';
import { useMultiSelect } from '../utils/useMultiSelect';
import { defaultGameFilter, isGameEnabled } from '../utils/games';
import { useT } from '../utils/i18n';
import CardInspectorModal from './CardInspectorModal';
import AddToDeckSelect from './AddToDeckSelect';
import PackPriceSplitter from './PackPriceSplitter';
import CardImage from './CardImage';
import MultiSelectDropdown from './MultiSelectDropdown';

const labelStyle = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-secondary)' };
const PAGE_SIZE = 60;

// Maps each Sort By option to sortCardsByOrder criteria so ordering matches the
// storage engine (set = chronological via setsList, type = TYPE_ORDER).
// 'qty-desc' isn't a card-order scheme, handled separately.
const SORT_CRITERIA = {
  'added-newest': [{ by: 'added_at', dir: 'desc' }, { by: 'entry_id', dir: 'desc' }],
  'added-oldest': [{ by: 'added_at', dir: 'asc' }],
  'name-asc': [{ by: 'name', dir: 'asc' }],
  'name-desc': [{ by: 'name', dir: 'desc' }],
  'price-desc': [{ by: 'price', dir: 'desc' }],
  'price-asc': [{ by: 'price', dir: 'asc' }],
  'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
  'number-asc': [{ by: 'number', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'rarity-desc': [{ by: 'rarity', dir: 'desc' }, { by: 'name', dir: 'asc' }],
  'rarity-asc': [{ by: 'rarity', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'type-asc': [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'language-asc': [{ by: 'language', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'favorite-first': [{ by: 'favorite', dir: 'desc' }, { by: 'added_at', dir: 'desc' }],
};

// Small labelled field wrapper to keep the filter grid uniform.
function Field({ label, id, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function CollectionList({ statsTrigger, onUpdate, showToast, selectedCardFilter, setSelectedCardFilter, onNavigate, setSelectedLocationId, setFocusEntryId }) {
  const { t } = useT();
  const [collection, setCollection] = useState([]);
  const [locations, setLocations] = useState([]);
  const [setsList, setSetsList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedCardFilter) {
      setSearchFilter(selectedCardFilter);
      // Reset after applying so they can clear search manually
      setSelectedCardFilter('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardFilter]);

  // UX view state
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('collection_default_view') || 'gallery'); // 'gallery' or 'list'
  const [inspectorCard, setInspectorCard] = useState(null);
  const [inspectorStartEdit, setInspectorStartEdit] = useState(false);
  const [subTab, setSubTab] = useState('collection'); // 'collection', 'unsorted', 'wishlist', 'arena', 'graveyard'
  const inventoryType = subTab === 'graveyard' ? 'graveyard' : 'collection';
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);

  // Search & Filter state
  const [searchFilter, setSearchFilter] = useState('');
  // Falls back to a visible game if the Settings default has since been hidden.
  const [gameFilter, setGameFilter] = useState(() => (isGameEnabled(localStorage.getItem('default_game')) ? localStorage.getItem('default_game') : defaultGameFilter()));
  const [locationFilter, setLocationFilter] = useState([]);
  const [rarityFilter, setRarityFilter] = useState([]);
  const [conditionFilter, setConditionFilter] = useState([]);
  const [graderFilter, setGraderFilter] = useState([]);
  const [printingFilter, setPrintingFilter] = useState([]);
  const [setFilter, setSetFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [colorFilter, setColorFilter] = useState([]);
  const [cmcFilter, setCmcFilter] = useState([]);
  const [languageFilter, setLanguageFilter] = useState([]);
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [tradeOnly, setTradeOnly] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [notCheckedOutOnly, setNotCheckedOutOnly] = useState(false);

  // Stacking state (default to stacked)
  const [stackCards, setStackCards] = useState(true);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(true);

  // Multi-select / bulk actions — shared long-press + /api/collection/bulk logic.
  const {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode,
    bulkMoveTarget, setBulkMoveTarget, pressHandlers, longPressFired, runBulk,
  } = useMultiSelect({ showToast, onChanged: () => { onUpdate(); fetchCollection(); } });

  useEffect(() => {
    setSelectedIds(new Set());
    setLocationFilter([]);
    setBulkMoveTarget('');
  }, [subTab, setSelectedIds, setBulkMoveTarget]);

  useEffect(() => {
    fetchCollection();
    fetchSets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTrigger, subTab, tradeOnly]);

  const fetchCollection = async () => {
    try {
      setLoading(true);
      let url = '/api/collection?list_type=collection';
      if (subTab === 'wishlist' || subTab === 'arena' || subTab === 'graveyard') url = `/api/collection?list_type=${subTab}`;
      if (tradeOnly) {
        url += '&is_trade=1';
      }

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setCollection(data);
      }
    } catch (err) {
      console.error(err);
      showToast(t('collection.errLoad'), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLocations([]);
    fetch(`/api/locations?inventory_type=${inventoryType}`)
      .then(response => response.ok ? response.json() : [])
      .then(data => { if (!cancelled) setLocations(data); })
      .catch(err => console.error('Error fetching locations:', err));
    return () => { cancelled = true; };
  }, [inventoryType, statsTrigger]);

  const fetchSets = async () => {
    try {
      const response = await fetch('/api/sets');
      if (response.ok) setSetsList(await response.json());
    } catch (err) {
      console.error('Error fetching sets:', err);
    }
  };

  const handleDelete = async (entryId, cardName) => {
    if (!window.confirm(t('collection.confirmDeleteCard', { name: cardName }))) {
      return;
    }

    try {
      const response = await fetch(`/api/collection/${entryId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('collection.cardRemoved', { name: cardName }), 'success');
        onUpdate();
      } else {
        showToast(t('collection.errDelete'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('common.errBackend'), 'error');
    }
  };

  const openEdit = (item) => {
    setInspectorCard(item);
    setInspectorStartEdit(true);
  };

  // Tap: swallowed if a long-press just armed selection; otherwise toggle (in
  // select mode) or open the inspector.
  const activateCard = (item, event) => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) selectAt(item.entry_id, displayCards.map(i => i.entry_id), event?.shiftKey);
    else { setInspectorCard(item); setInspectorStartEdit(false); }
  };

  const handleViewStorage = (card) => {
    setInspectorCard(null);
    if (setSelectedLocationId) {
      setSelectedLocationId(card.location_id || 'unsorted');
    }
    if (setFocusEntryId) {
      setFocusEntryId(card.entry_id || card.id);
    }
    if (onNavigate) {
      onNavigate('storage', card.list_type === 'graveyard' ? 'graveyard' : 'collection');
    }
  };

  // Extract unique filter values from the loaded collection.
  const uniqueRarities = useMemo(
    () => Array.from(new Set(collection.map(item => item.rarity).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueSets = useMemo(
    () => Array.from(new Set(collection.map(item => item.set_name).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueTypes = useMemo(
    () => Array.from(new Set(collection.flatMap(item => item.subtypes || []).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueColors = useMemo(
    () => Array.from(new Set(collection.flatMap(item => item.color_identity || []).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueLanguages = useMemo(
    () => Array.from(new Set(collection.map(item => item.language).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueCmcs = useMemo(
    () => Array.from(new Set(collection.map(item => item.cmc).filter(v => v !== null && v !== undefined))).sort((a, b) => a - b),
    [collection]
  );

  const activeFilterCount =
    [locationFilter, rarityFilter, conditionFilter, graderFilter, printingFilter,
    setFilter, typeFilter, colorFilter, cmcFilter, languageFilter]
      .filter(v => v.length > 0).length
    + (gameFilter !== '' ? 1 : 0)
    + (minPriceFilter !== '' ? 1 : 0)
    + (maxPriceFilter !== '' ? 1 : 0)
    + (tradeOnly ? 1 : 0)
    + (favoriteOnly ? 1 : 0)
    + (notCheckedOutOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSearchFilter('');
    setGameFilter('');
    setLocationFilter([]); setRarityFilter([]); setConditionFilter([]); setGraderFilter([]);
    setPrintingFilter([]); setSetFilter([]); setTypeFilter([]); setColorFilter([]);
    setCmcFilter([]); setLanguageFilter([]);
    setMinPriceFilter(''); setMaxPriceFilter('');
    setTradeOnly(false); setFavoriteOnly(false);
    setNotCheckedOutOnly(false);
  };

  // Filter + sort
  const filteredCollection = useMemo(() => {
    // Search both the English name and the localized printed name.
    const rawSearch = searchFilter.toLowerCase();
    const result = collection.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(rawSearch) ||
                            (item.printed_name || '').toLowerCase().includes(rawSearch) ||
                            (item.set_name || '').toLowerCase().includes(rawSearch) ||
                            (item.number || '').includes(searchFilter);
      const matchesLocation = locationFilter.length === 0 ? true :
                              locationFilter.some(f => f === 'unassigned' ? !item.location_id : item.location_id == f);
      // Hidden games remain stored but are excluded from this view and its exports.
      const itemGame = item.game || 'mtg';
      const matchesGame = gameFilter === '' ? isGameEnabled(itemGame) : itemGame === gameFilter;
      const matchesRarity = rarityFilter.length === 0 ? true : rarityFilter.includes(item.rarity);
      const matchesCondition = conditionFilter.length === 0 ? true : conditionFilter.includes(item.condition);
      const matchesPrinting = printingFilter.length === 0 ? true : printingFilter.includes(item.printing);
      const matchesSet = setFilter.length === 0 ? true : setFilter.includes(item.set_name);
      const matchesType = typeFilter.length === 0 ? true : typeFilter.some(t => (item.subtypes || []).includes(t));
      const matchesColor = colorFilter.length === 0 ? true : colorFilter.some(c => (item.color_identity || []).includes(c));
      const matchesCmc = cmcFilter.length === 0 ? true : cmcFilter.includes(String(item.cmc));
      const matchesLanguage = languageFilter.length === 0 ? true : languageFilter.includes(item.language);
      const matchesFavorite = favoriteOnly ? item.favorite === 1 : true;
      // Rows written before grading existed have a NULL grader, which means raw —
      // so the comparison defaults rather than treating NULL as its own category.
      const itemGrader = item.grader || 'Raw';
      const matchesGrader = graderFilter.length === 0 ? true
        : graderFilter.some(f => f === '__graded' ? itemGrader !== 'Raw' : itemGrader === f);

      const price = item.price_trend || 0;
      const matchesMinPrice = minPriceFilter === '' ? true : price >= parseFloat(minPriceFilter);
      const matchesMaxPrice = maxPriceFilter === '' ? true : price <= parseFloat(maxPriceFilter);
      const matchesNotCheckedOut = !notCheckedOutOnly || (item.checked_out_qty || 0) === 0;
      const matchesUnsorted = subTab !== 'unsorted' || !item.location_id;

      return matchesSearch && matchesUnsorted && matchesGame && matchesLocation && matchesRarity && matchesCondition &&
             matchesPrinting && matchesSet && matchesType && matchesColor &&
             matchesCmc && matchesLanguage && matchesFavorite && matchesGrader && matchesMinPrice && matchesMaxPrice &&
             matchesNotCheckedOut;
    });

    if (sortBy === 'qty-desc') {
      result.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    } else {
      sortCardsByOrder(result, SORT_CRITERIA[sortBy] || SORT_CRITERIA['added-newest'], undefined, setsList);
    }
    return result;
  }, [collection, searchFilter, gameFilter, locationFilter, rarityFilter, conditionFilter, printingFilter, setFilter, typeFilter, colorFilter, cmcFilter, languageFilter, favoriteOnly, graderFilter, minPriceFilter, maxPriceFilter, notCheckedOutOnly, subTab, sortBy, setsList]);

  // Group duplicate cards if stack option is active
  const processedCollection = useMemo(() => {
    if (!stackCards) return filteredCollection;

    const groups = {};
    filteredCollection.forEach(item => {
      let key = item.card_id;
      if (stackByCondition) key += `-${item.condition}`;
      if (stackByPrinting) key += `-${item.printing}`;

      if (!groups[key]) {
        groups[key] = { ...item };
      } else {
        groups[key].quantity += item.quantity;
      }
    });
    return Object.values(groups);
  }, [filteredCollection, stackCards, stackByCondition, stackByPrinting]);

  // In select mode, render the unstacked list so every entry is individually
  // selectable and bulk actions hit real entry_ids (stacking merges rows).
  const displayCards = selectMode ? filteredCollection : processedCollection;
  const pageCount = Math.max(1, Math.ceil(displayCards.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  // ponytail: paginate only rendering; filters, exports and bulk selection keep all matches.
  const pageCards = displayCards.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [displayCards, subTab, tradeOnly]);

  const exportView = (format) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buildCollectionExport(displayCards, format)], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8',
    }));
    link.download = `manafolio-${subTab}-view.${format}`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const totalValue = useMemo(
    () => displayCards.reduce((sum, item) => sum + (item.price_trend || 0) * (item.quantity || 1), 0),
    [displayCards]
  );

  const paginationControls = !loading && pageCount > 1 && (
    <nav aria-label={t('collection.pagination')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: '0.75rem', margin: '1rem 0' }}>
      <button type="button" className="btn btn-secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} style={{ minHeight: '44px' }}>
        {t('collection.previousPage')}
      </button>
      <span style={{ fontSize: '0.875rem', textAlign: 'center' }}>
        {t('collection.pageCount', { page: currentPage, count: pageCount })}
        <br />
        {t('collection.pageRange', { start: (currentPage - 1) * PAGE_SIZE + 1, end: Math.min(currentPage * PAGE_SIZE, displayCards.length), count: displayCards.length })}
      </span>
      <button type="button" className="btn btn-secondary" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)} style={{ minHeight: '44px' }}>
        {t('collection.nextPage')}
      </button>
    </nav>
  );

  return (
    <div>
      <div className="sub-nav-tabs collection-inventory-nav" style={{ marginBottom: '0.75rem' }}>
          <button
            className={`sub-nav-tab ${subTab === 'collection' ? 'active' : ''}`}
            aria-pressed={subTab === 'collection'}
            onClick={() => setSubTab('collection')}
          >
            {t('nav.collection')}
          </button>
          <button
            className={`sub-nav-tab ${subTab === 'arena' ? 'active' : ''}`}
            aria-pressed={subTab === 'arena'}
            onClick={() => setSubTab('arena')}
          >
            {t('collection.arena')}
          </button>
          <button
            className={`sub-nav-tab ${subTab === 'graveyard' ? 'active' : ''}`}
            aria-pressed={subTab === 'graveyard'}
            onClick={() => setSubTab('graveyard')}
          >
            {t('collection.graveyard')}
          </button>
          <button
            className={`sub-nav-tab ${subTab === 'unsorted' ? 'active' : ''}`}
            aria-pressed={subTab === 'unsorted'}
            onClick={() => setSubTab('unsorted')}
          >
            {t('bulk.unassignedPile')}
          </button>
          <button
            className={`sub-nav-tab ${subTab === 'wishlist' ? 'active' : ''}`}
            aria-pressed={subTab === 'wishlist'}
            onClick={() => setSubTab('wishlist')}
          >
            {t('collection.wishlist')}
          </button>
      </div>


      {/* Filter Panel */}
      <div className="collection-filters" style={{ position: 'relative', zIndex: 40, overflow: 'visible', marginBottom: '0.75rem' }}>
        {/* Always-visible top bar: search + sort + filters toggle */}
        <div className="collection-filter-toolbar">
          <Field label={t('collection.searchLabel')} id="collection-search">
            <div style={{ position: 'relative' }}>
              <input
                id="collection-search"
                type="search"
                className="input-control"
                placeholder={t('collection.searchPlaceholder')}
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                style={{ width: '100%', paddingLeft: '2.5rem' }}
              />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </Field>

          <Field label={t('collection.sortBy')} id="collection-sort">
            <select id="collection-sort" className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {['added-newest', 'added-oldest', 'name-asc', 'name-desc', 'price-desc', 'price-asc', 'qty-desc', 'set-asc', 'number-asc', 'type-asc', 'rarity-desc', 'rarity-asc', 'language-asc', 'favorite-first']
                .map(key => <option key={key} value={key}>{t(`collection.sort.${key}`)}</option>)}
            </select>
          </Field>

          <button
            className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowFilters(s => !s)}
            aria-expanded={showFilters}
            aria-controls="collection-filter-options"
            style={{ padding: '0.5rem 0.9rem', minHeight: '44px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            <SlidersHorizontal size={15} />
            {t('collection.filters')}
            {activeFilterCount > 0 && (
              <span style={{ fontSize: '0.875rem', fontWeight: 700 }}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
          <div id="collection-filter-options" className="view-section" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Selector filters grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem' }}>
              <Field label={t('collection.fLocation')}>
                <MultiSelectDropdown
                  label={t('collection.fLocation')}
                  allLabel={t('collection.allLocations')}
                  value={locationFilter}
                  onChange={setLocationFilter}
                  options={[
                    { value: 'unassigned', label: t('bulk.unassignedPile') },
                    ...locations.map(loc => ({ value: loc.id, label: loc.name }))
                  ]}
                />
              </Field>

              <Field label={t('collection.fSet')}>
                <MultiSelectDropdown
                  label={t('collection.fSet')}
                  allLabel={t('collection.allSets')}
                  value={setFilter}
                  onChange={setSetFilter}
                  options={uniqueSets.map(s => ({ value: s, label: s }))}
                />
              </Field>


              <Field label={t('collection.fColor')}>
                <MultiSelectDropdown
                  label={t('collection.fColor')}
                  allLabel={t('collection.allColors')}
                  value={colorFilter}
                  onChange={setColorFilter}
                  options={uniqueColors.map(c => ({ value: c, label: c }))}
                />
              </Field>
              <Field label={t('collection.fType')}>
                <MultiSelectDropdown
                  label={t('collection.fType')}
                  allLabel={t('collection.allTypes')}
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={uniqueTypes.map(t => ({value: t, label: t}))}
                />
              </Field>


              <Field label={t('collection.fRarity')}>
                <MultiSelectDropdown
                  label={t('collection.fRarity')}
                  allLabel={t('collection.allRarities')}
                  value={rarityFilter}
                  onChange={setRarityFilter}
                  options={uniqueRarities.map(r => ({value: r, label: r}))}
                />
              </Field>

              <Field label={t('card.condition')}>
                <MultiSelectDropdown
                  label={t('card.condition')}
                  allLabel={t('collection.allConditions')}
                  value={conditionFilter}
                  onChange={setConditionFilter}
                  options={CONDITIONS.map(c => ({value: c, label: c}))}
                />
              </Field>

              <Field label={t('card.printing')}>
                <MultiSelectDropdown
                  label={t('card.printing')}
                  allLabel={t('collection.allPrintings')}
                  value={printingFilter}
                  onChange={setPrintingFilter}
                  options={getPrintings()}
                />
              </Field>

              {/* 'Any graded' earns its own entry above the per-company options:
                  "show me my slabs" is the question people actually ask, and
                  answering it otherwise means selecting each grader in turn. */}
              <Field label={t('card.grader')}>
                <MultiSelectDropdown
                  label={t('card.grader')}
                  allLabel={t('collection.allGraders')}
                  value={graderFilter}
                  onChange={setGraderFilter}
                  options={[
                    { value: '__graded', label: t('collection.anyGraded') },
                    ...GRADERS.map(g => ({ value: g, label: g === 'Raw' ? t('card.graderRaw') : g }))
                  ]}
                />
              </Field>

              {uniqueCmcs.length > 0 && (
                <Field label={t('collection.fManaValue')}>
                  <MultiSelectDropdown
                    label={t('collection.fManaValue')}
                    allLabel={t('collection.allManaValues')}
                    value={cmcFilter}
                    onChange={setCmcFilter}
                    options={uniqueCmcs.map(c => ({ value: String(c), label: String(c) }))}
                  />
                </Field>
              )}

              <Field label={t('card.language')}>
                <MultiSelectDropdown
                  label={t('card.language')}
                  allLabel={t('collection.allLanguages')}
                  value={languageFilter}
                  onChange={setLanguageFilter}
                  options={uniqueLanguages.map(l => ({ value: l, label: l }))}
                />
              </Field>

              <Field label={t('collection.fMinPrice')} id="collection-min-price">
                <input id="collection-min-price" type="number" className="input-control" placeholder={t('collection.minPricePlaceholder')} value={minPriceFilter} onChange={(e) => setMinPriceFilter(e.target.value)} />
              </Field>

              <Field label={t('collection.fMaxPrice')} id="collection-max-price">
                <input id="collection-max-price" type="number" className="input-control" placeholder={t('collection.maxPricePlaceholder')} value={maxPriceFilter} onChange={(e) => setMaxPriceFilter(e.target.value)} />
              </Field>
            </div>

            {/* Options row: stacking + trade + clear */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="stackCardsOpt" checked={stackCards} onChange={(e) => setStackCards(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="stackCardsOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                  {t('collection.stackDuplicates')}
                </label>
              </div>

              {stackCards && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByConditionOpt" checked={stackByCondition} onChange={(e) => setStackByCondition(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByConditionOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByCondition')}
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByPrintingOpt" checked={stackByPrinting} onChange={(e) => setStackByPrinting(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByPrintingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByPrinting')}
                    </label>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="tradeOnlyOpt" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="tradeOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>
                  {t('collection.tradeOnly')}
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="favoriteOnlyOpt" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="favoriteOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: '#facc15', fontWeight: 600 }}>
                  {t('collection.favoritesOnly')}
                </label>
              </div>

              {['collection', 'unsorted'].includes(subTab) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input type="checkbox" id="notCheckedOutOpt" checked={notCheckedOutOnly} onChange={(e) => setNotCheckedOutOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                  <label htmlFor="notCheckedOutOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                    {t('collection.notInCheckedOutDeck')}
                  </label>
                </div>
              )}

              {activeFilterCount > 0 && (
                <button className="btn btn-secondary" onClick={clearAllFilters} style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <X size={13} /> {t('collection.clearFilters')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

        <div className="collection-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          {subTab === 'graveyard' && (
            <button className="btn btn-secondary" onClick={() => {
              setSelectedLocationId?.(null);
              setFocusEntryId?.(null);
              onNavigate?.('storage', 'graveyard');
            }} style={{ fontSize: '0.875rem', padding: '0.4rem 0.75rem' }}>
              {t('loc.graveyardContainers')}
            </button>
          )}
          {/* Multi-select toggle (long-press cards is the primary path) */}
          <button
            className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            aria-pressed={selectMode}
            style={{ fontSize: '0.875rem', padding: '0.4rem 0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            title={t('collection.selectHint')}
          >
            <MousePointerClick size={14} />
            {t(selectMode ? 'bulk.done' : 'collection.select')}
          </button>
          <details className="collection-export" onKeyDown={(event) => {
            if (event.key === 'Escape' && event.currentTarget.open) {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector('summary').focus();
            }
          }} onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
          }}>
            <summary className="btn btn-secondary" style={{ fontSize: '0.875rem', padding: '0.4rem 0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <Download size={14} aria-hidden="true" />
              {t('collection.exportView')}
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div className="collection-export-options">
              {['csv', 'txt'].map(format => (
                <button key={format} type="button" className="btn btn-secondary" disabled={loading || !displayCards.length} onClick={(event) => {
                  exportView(format);
                  const disclosure = event.currentTarget.closest('details');
                  disclosure.open = false;
                  disclosure.querySelector('summary').focus();
                }}>
                  {t(format === 'csv' ? 'collection.exportViewCsv' : 'collection.exportViewTxt')}
                </button>
              ))}
            </div>
          </details>

          {/* View Toggle */}
          <div style={{ display: 'flex', gap: '0.25rem', marginLeft: 'auto' }}>
            <button
              className={`btn btn-icon-only ${viewMode === 'gallery' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('gallery')}
              style={{ minWidth: '44px', minHeight: '44px', padding: '0.5rem' }}
              aria-label={t('collection.galleryView')}
              aria-pressed={viewMode === 'gallery'}
              title={t('collection.galleryView')}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={`btn btn-icon-only ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('list')}
              style={{ minWidth: '44px', minHeight: '44px', padding: '0.5rem' }}
              aria-label={t('collection.listView')}
              aria-pressed={viewMode === 'list'}
              title={t('collection.listView')}
            >
              <List size={14} />
            </button>
          </div>
        </div>
      {/* Result summary bar */}
      {!loading && !selectMode && (
        <div role="status" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span><strong style={{ color: 'var(--text-strong)' }}>{displayCards.length}</strong> {t('collection.cardUnit', { count: displayCards.length })}</span>
          <span>{t('collection.totalValue')} <strong style={{ color: 'var(--text-strong)' }}>{priceText(totalValue)}</strong></span>
        </div>
      )}

      {/* Bulk action bar */}
      {selectMode && (
        <div className="glass-panel bulk-action-bar" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('bulk.selected', { count: selectedIds.size })}</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={() => setSelectedIds(new Set(filteredCollection.map(i => i.entry_id)))}>{t('collection.selectAllMatches', { count: filteredCollection.length })}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={clearSelection}>{t('bulk.clear')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('delete', null, t('bulk.confirmDelete', { count: selectedIds.size }))}>{t('bulk.delete')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('trade', null)}>{t('bulk.markTrade')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('untrade', null)}>{t('bulk.untrade')}</button>
          {subTab === 'collection' || subTab === 'unsorted' ? (
            <>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', 'wishlist', null)}>{t('bulk.moveToWishlist')}</button>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', 'arena', null)}>{t('bulk.moveToArena')}</button>
            </>
          ) : subTab === 'graveyard' ? (
            <>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', 'collection', null)}>{t('bulk.restoreToCollection')}</button>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', 'arena', null)}>{t('bulk.restoreToArena')}</button>
            </>
          ) : (
            <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', 'collection', null)}>{t('bulk.moveToCollection')}</button>
          )}
          {subTab !== 'graveyard' && (
            <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', 'graveyard', null)}>{t('bulk.archive')}</button>
          )}
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('condition', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setCondition')}</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('printing', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setPrinting')}</option>
            {getPrintings().map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <PackPriceSplitter
            entryIds={Array.from(selectedIds)}
            showToast={showToast}
            onApplied={() => { clearSelection(); onUpdate(); fetchCollection(); }}
          />
              <select className="select-control" value={bulkMoveTarget} onChange={(e) => setBulkMoveTarget(e.target.value)} style={{ fontSize: '0.72rem', maxWidth: '170px', padding: '0.3rem 0.4rem' }}>
                <option value="">{t('bulk.moveToContainer')}</option>
                <option value="unassign">{t('bulk.unassignedPile')}</option>
                {locations.slice().sort((a, b) => a.name.localeCompare(b.name)).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <button className="btn btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!bulkMoveTarget || !selectedIds.size} onClick={() => runBulk('move', bulkMoveTarget === 'unassign' ? null : bulkMoveTarget)}>{t('bulk.applyMove')}</button>
          {subTab !== 'graveyard' && (
            <>
              <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
              <AddToDeckSelect
                onAdd={(id) => runBulk('add_to_deck', id)}
                disabled={!selectedIds.size}
                style={{ fontSize: '0.72rem', maxWidth: '160px', padding: '0.3rem 0.4rem' }}
              />
            </>
          )}
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', marginLeft: 'auto' }} onClick={exitSelectMode}>{t('bulk.done')}</button>
        </div>
      )}


      {loading ? (
        <div className="spinner"></div>
      ) : displayCards.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem 0' }}>
          <p>{t('collection.noMatches')} {t(activeFilterCount > 0 ? 'collection.noMatchesFiltered' : 'collection.noMatchesEmpty')}</p>
        </div>
      ) : viewMode === 'gallery' ? (
        /* Visual Cards Grid Gallery View */
        <div className="card-grid">
          {pageCards.map((item) => {
            const rarityStyle = getCardRarityBorder(item.rarity);
            const selected = selectedIds.has(item.entry_id);

            return (
              <button
                type="button"
                key={item.entry_id}
                className="tcg-card"
                style={{ cursor: 'pointer', touchAction: 'pan-y' }}
                aria-label={getCardDisplayName(item.name, item.language, item.printed_name)}
                aria-pressed={selectMode ? selected : undefined}
                aria-haspopup={selectMode ? undefined : 'dialog'}
                onClick={(e) => activateCard(item, e)}
                {...pressHandlers(item.entry_id)}
              >
                <span className="tcg-card-inner" style={{ ...rarityStyle, ...(selected ? { outline: '3px solid var(--accent-red)', outlineOffset: '2px' } : {}) }}>
                  {selectMode && (
                    <span aria-hidden="true" style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 20, width: '22px', height: '22px', borderRadius: '50%', background: selected ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontSize: '0.8rem', fontWeight: 900 }}>{selected ? '✓' : ''}</span>
                  )}
                  <CardImage card={item} className="tcg-card-image" loading="lazy" draggable={false} />
                  {getFoilOverlayClass(item.printing) && (
                    <span className={getFoilOverlayClass(item.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {item.quantity > 1 && (
                    <span className="tcg-card-quantity-tag">x{item.quantity}</span>
                  )}

                </span>
                <span className="tcg-card-info">
                  <span className="tcg-card-name">{getCardDisplayName(item.name, item.language, item.printed_name)}</span>
                  <span className="tcg-card-meta">
                    <span>{item.set_name} • #{item.number}</span>
                    <span className="tcg-card-price">{priceText(item.price_trend, item.price_currency)}</span>
                  </span>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                    <span style={getRarityBadgeStyle(item.rarity)}>{getRarityBadgeLabel(item.rarity)}</span>
                    <span>
                      {item.grader && item.grader !== 'Raw'
                        ? `${item.grader}${item.grade != null ? ` ${item.grade}` : ''}`
                        : item.condition}
                    </span>
                    {item.printing !== 'Normal' && (
                      <span style={getPrintingBadgeStyle(item.printing)}>{getPrintingBadgeLabel(item.printing)}</span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        /* Traditional List Table View */
        <div style={{ overflow: 'hidden' }}>
          <div style={{ overflowY: 'auto' }}>
            <table className="collection-table" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>{t('collection.colCard')}</th>
                  <th style={{ width: '70px', textAlign: 'right' }}>{t('collection.colQtyValue')}</th>
                </tr>
              </thead>
              <tbody>
                {pageCards.map((item) => {
                  const selected = selectedIds.has(item.entry_id);
                  return (
                  <tr key={item.entry_id} style={selected ? { background: 'rgba(255,71,71,0.12)' } : undefined}>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={selected}
                            aria-label={getCardDisplayName(item.name, item.language, item.printed_name)}
                            onChange={() => toggleSelect(item.entry_id)}
                            style={{ width: '18px', height: '18px', flexShrink: 0, cursor: 'pointer' }}
                          />
                        )}
                        <button
                          type="button"
                          className="collection-card-trigger"
                          aria-label={getCardDisplayName(item.name, item.language, item.printed_name)}
                          aria-pressed={selectMode ? selected : undefined}
                          aria-haspopup={selectMode ? undefined : 'dialog'}
                          onClick={(e) => activateCard(item, e)}
                          {...pressHandlers(item.entry_id)}
                          style={{ position: 'relative', width: '36px', height: '50px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', cursor: 'pointer', touchAction: 'pan-y', ...getCardRarityBorder(item.rarity) }}
                        >
                          <CardImage card={item} className="collection-row-thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} draggable={false} />
                          {getFoilOverlayClass(item.printing) && (
                            <span className={getFoilOverlayClass(item.printing)} style={{ borderRadius: '4px' }} />
                          )}
                        </button>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <button type="button" className="collection-card-trigger" aria-pressed={selectMode ? selected : undefined} aria-haspopup={selectMode ? undefined : 'dialog'} onClick={(e) => activateCard(item, e)} {...pressHandlers(item.entry_id)} style={{ display: 'block', maxWidth: '100%', fontWeight: 700, color: 'var(--text-strong)', fontSize: '1rem', textAlign: 'left', cursor: 'pointer' }}>{getCardDisplayName(item.name, item.language, item.printed_name)}</button>
                          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.3rem' }}>
                            <span>{item.set_name} • #{item.number}</span>
                            <span style={{ fontSize: '0.875rem', fontWeight: 600, ...getRarityBadgeStyle(item.rarity) }}>
                              {getRarityBadgeLabel(item.rarity)}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                            {item.printing} • {item.condition}
                          </div>
                          {!selectMode && (
                            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '2px' }}>
                              <button className="btn btn-secondary btn-icon-only" style={{ minWidth: '44px', minHeight: '44px' }} onClick={() => openEdit(item)} title={t('common.edit')} aria-label={t('common.edit')}>
                                <Edit2 size={16} />
                              </button>
                              <button className="btn btn-danger btn-icon-only" style={{ minWidth: '44px', minHeight: '44px' }} onClick={() => handleDelete(item.entry_id, getCardDisplayName(item.name, item.language, item.printed_name))} title={t('common.delete')} aria-label={t('common.delete')}>
                                <Trash2 size={16} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', verticalAlign: 'top', paddingTop: '0.6rem' }}>
                      {item.quantity > 1 && (
                        <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>x{item.quantity}</div>
                      )}
                      <div style={{ fontSize: '0.875rem', color: 'var(--text-strong)', fontWeight: 600 }}>{priceText(item.price_trend, item.price_currency)}</div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {paginationControls}

      {/* Card Detail Inspector Modal (Private Authorized View) */}
      <CardInspectorModal
        card={inspectorCard}
        startInEdit={inspectorStartEdit}
        onClose={() => { setInspectorCard(null); setInspectorStartEdit(false); }}
        onUpdate={onUpdate}
        showToast={showToast}
        onViewStorage={handleViewStorage}
      />
    </div>
  );
}

export default CollectionList;
