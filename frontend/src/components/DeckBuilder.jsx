import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Plus, Minus, Trash2, Copy, X, ChevronLeft, Play, BarChart2, Search, LogOut, PackageCheck, LayoutGrid, List, Download, Upload, Eye, Filter, CheckCircle, AlertTriangle, Layers, Zap, Swords, Gamepad2, SlidersHorizontal, ArrowRight, FolderPlus, FileText, MapPin, Share2 } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { shuffleArray } from '../utils/shuffle';
import { displayName } from '../utils/languages';
import { TYPE_ORDER, typeCategory } from '../utils/cardSort';
import CheckoutWizardModal from './CheckoutWizardModal';
import { useBackGuard } from '../utils/useBackGuard';
import { ownedImportIndex, findOwnedImportCard, buildDeckExport, parseDeckLine } from '../utils/deckText';
import { deckContainers } from '../utils/deckContainers';
import { defaultGame, isGameEnabled } from '../utils/games';
import { MTG_FORMATS } from '../utils/cardOptions';
import { preconFormat } from '../utils/preconFormat';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';
import MtgDeckImport from './MtgDeckImport';
import AiDeckBuilder from './AiDeckBuilder';
import RelatedTokens from './RelatedTokens';
import Modal from './Modal';
import DeckCardBack from './DeckCardBack';
import DeckContainerModal from './DeckContainerModal';
import AcquisitionPlanner from './AcquisitionPlanner';
import './DeckBuilder.css';

// Basic lands are exempt from the "max 4 of a card" deck rule.
const isBasicLand = (card, game = 'mtg') => {
  if (!card || game !== 'mtg') return false;
  const subs = card.subtypes || [];
  return (subs.includes('Land') || card.supertype === 'Land') && (subs.includes('Basic') || /^(?:Snow-Covered )?(?:Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(card.name));
};

// Total copies of a card (matched by name) already in a deck's card list.
const deckCountByName = (deckCards, name) =>
  (deckCards || []).filter(c => c.name === name).reduce((s, c) => s + c.quantity, 0);

// Initial and reset values for deck creation.
const NEW_DECK_DEFAULTS = { format: 'Commander / EDH', targetSize: 100 };

const deckEditorState = (deck) => ({
  name: deck.name.trim(),
  description: deck.description || '',
  notes: deck.notes || '',
  format: deck.format || NEW_DECK_DEFAULTS.format,
  category: deck.category || 'Competitive',
  accent_color: deck.accent_color || '#eab308',
  target_size: Number(deck.target_size || NEW_DECK_DEFAULTS.targetSize),
  inventory_type: deck.inventory_type || 'collection',
  cards: deck.cards.map(card => ({
    card_id: card.id, quantity: card.quantity, pulled: deck.inventory_type === 'collection' && !!card.checked_out,
    source_entry_id: deck.inventory_type === 'collection' ? card.source_entry_id ?? null : null
  }))
    .sort((a, b) => a.card_id.localeCompare(b.card_id)),
  commander_card_id: deck.commander_card_id || null
});

const formatCardLocations = (locations) => locations.map(({ take, storage_unit_name, location_name, compartment_display }) =>
  `${take > 1 ? `×${take} ` : ''}${storage_unit_name ? `${storage_unit_name} · ` : ''}${location_name}${compartment_display ? ` · ${compartment_display}` : ''}`
).join(', ');

const locationCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const DECK_DISTRIBUTION_COLORS = {
  Creature: '#4ade80', Land: '#c4b5fd', Instant: '#fbbf24', Sorcery: '#60a5fa',
  Enchantment: '#f87171', Artifact: '#cbd5e1', Planeswalker: '#f0abfc', Battle: '#fb923c',
  White: '#fef08a', Blue: '#60a5fa', Black: '#a78bfa', Red: '#f87171',
  Green: '#4ade80', Colorless: '#cbd5e1',
  'Land (Plains)': '#fef08a', 'Land (Island)': '#60a5fa', 'Land (Swamp)': '#a78bfa',
  'Land (Mountain)': '#f87171', 'Land (Forest)': '#4ade80', 'Land (Nonbasic)': '#fbbf24',
};

const CARD_GROUP_LABELS = {
  Creature: 'mtgDeck.creatures',
  Planeswalker: 'deck.cardGroupPlaneswalkers',
  Instant: 'deck.cardGroupInstants',
  Sorcery: 'deck.cardGroupSorceries',
  Enchantment: 'deck.cardGroupEnchantments',
  Artifact: 'deck.cardGroupArtifacts',
  Battle: 'deck.cardGroupBattles',
  Land: 'mtgDeck.lands',
  Other: 'deck.cardGroupOther',
};

const MANA_SYMBOLS = [
  ['white_cards', 'White', -475],
  ['blue_cards', 'Blue', -370],
  ['black_cards', 'Black', -265],
  ['red_cards', 'Red', -160],
  ['green_cards', 'Green', -55],
];

function ManaCounts({ deck }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      {MANA_SYMBOLS.map(([field, name, x]) => deck[field] > 0 && (
        <span key={field} title={`${deck[field]} ${name} card${deck[field] === 1 ? '' : 's'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '1px' }}>
          <svg aria-hidden="true" width="16" height="16" viewBox={`${x - 50} 0 100 100`}>
            <image href="/mana.svg" x="-945" y="-210.002" width="1045" height="730.002" />
          </svg>
          <span style={{ fontSize: 'var(--deck-mana-count-size, 0.875rem)', fontWeight: 700, color: 'var(--text-secondary)' }}>{deck[field]}</span>
        </span>
      ))}
    </span>
  );
}

function DeckBuilder({ showToast, navigationGuardRef, onOpenAiSettings }) {
  const { t } = useT();
  const cardsHeadingRef = useRef(null);
  const addCardsInputRef = useRef(null);
  const [decks, setDecks] = useState([]);
  const [activeDeck, setActiveDeck] = useState(null);
  const [savedEditorState, setSavedEditorState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'detail'
  
  // Deck View & Display Modes
  const [cardDisplayMode, setCardDisplayMode] = useState(() => localStorage.getItem('deck_default_view') || 'list'); // 'list' | 'grid'
  const [deckCardSortBy, setDeckCardSortBy] = useState('type');
  const [deckCardScale, setDeckCardScale] = useState(() => {
    const scale = Number(localStorage.getItem('card_default_scale'));
    return scale >= 0.6 && scale <= 2.5 ? scale : 1;
  });
  const deckListImageScale = 1 + Math.max(0, deckCardScale - 1) * 0.25;
  const [previewCard, setPreviewCard] = useState(null);
  const [cardSources, setCardSources] = useState(null);
  const [sourceRetry, setSourceRetry] = useState(0);

  // Deck Creation States & Constants
  const DECK_CATEGORIES = ['Competitive', 'Casual', 'Tournament', 'Theorycraft', 'Proxy', 'Trade'];
  const DECK_ACCENT_COLORS = [
    { name: 'Gold', hex: '#eab308' },
    { name: 'Red', hex: '#ef4444' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Green', hex: '#10b981' },
    { name: 'Purple', hex: '#a855f7' },
    { name: 'Slate', hex: '#64748b' },
    { name: 'Pink', hex: '#ec4899' },
    { name: 'Orange', hex: '#f97316' },
  ];

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAcquisitionPlanner, setShowAcquisitionPlanner] = useState(false);
  const [creatingDeck, setCreatingDeck] = useState(false);
  const [createDeckError, setCreateDeckError] = useState(null);
  const [showAiBuilder, setShowAiBuilder] = useState(false);
  const [aiSourceDeck, setAiSourceDeck] = useState(null);
  const closeAiBuilder = () => { setShowAiBuilder(false); setAiSourceDeck(null); };
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckDesc, setNewDeckDesc] = useState('');
  const [newDeckInventoryType, setNewDeckInventoryType] = useState('collection');
  const [newDeckFormat, setNewDeckFormat] = useState(NEW_DECK_DEFAULTS.format);
  const [newDeckCategory, setNewDeckCategory] = useState('Competitive');
  const [newDeckAccentColor, setNewDeckAccentColor] = useState('#eab308');
  const [newDeckTargetSize, setNewDeckTargetSize] = useState(NEW_DECK_DEFAULTS.targetSize);
  const [newDeckImportText, setNewDeckImportText] = useState('');
  const [newDeckImportFormat, setNewDeckImportFormat] = useState('plain');
  const [showImportDecklistArea, setShowImportDecklistArea] = useState(false);
  const [newDeckPreconFile, setNewDeckPreconFile] = useState('');
  const [showPreconPicker, setShowPreconPicker] = useState(false);
  const [deckDraft, setDeckDraft] = useState(null);
  const [savingDeck, setSavingDeck] = useState(false);
  const [saveDeckError, setSaveDeckError] = useState(null);
  const [refreshingInventory, setRefreshingInventory] = useState(false);
  
  // Card Search States inside editor
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [browseFilters, setBrowseFilters] = useState({});
  const [showBrowseFilters, setShowBrowseFilters] = useState(false);
  const browseEntries = useMemo(() => searchResults.flatMap(card => card.inventory_entries || []), [searchResults]);
  const browseFilterOptions = useMemo(() => {
    const values = field => [...new Set(browseEntries.map(card => card[field]).filter(Boolean))].sort();
    return [
      ['set_name', 'collection.allSets', values('set_name')],
      ['type', 'collection.allTypes', [...new Set(browseEntries.flatMap(card => [...(card.types || []), ...(card.subtypes || [])]))].sort()],
      ['color', 'collection.allColors', Object.keys(TYPE_ORDER).filter(color => browseEntries.some(card => typeCategory(card.types) === color))],
      ['rarity', 'collection.allRarities', values('rarity')],
      ['condition', 'collection.allConditions', values('condition')],
      ['printing', 'collection.allPrintings', values('printing')],
      ['language', 'collection.allLanguages', values('language')],
    ];
  }, [browseEntries]);
  const filteredSearchResults = useMemo(() => searchResults.filter(card =>
    !card.inventory_entries || card.inventory_entries.some(entry =>
      Object.entries(browseFilters).every(([field, value]) => {
        if (!value) return true;
        if (field === 'type') return [...(entry.types || []), ...(entry.subtypes || [])].includes(value);
        if (field === 'color') return typeCategory(entry.types) === value;
        if (field === 'deckStatus') return value === 'inPlay' ? entry.checked_out_qty > 0 : !(entry.checked_out_qty > 0);
        return entry[field] === value;
      })
    )
  ), [searchResults, browseFilters]);
  const [deckSearchGame, setDeckSearchGame] = useState(() => defaultGame());

  // Deck Selection Menu Controls
  const [deckSearchTerm, setDeckSearchTerm] = useState('');
  const [deckStatusFilter, setDeckStatusFilter] = useState('all'); // 'all' | 'ready' | 'missing' | 'in_progress' | 'in_play'
  const [deckSortBy, setDeckSortBy] = useState('created_desc'); // 'created_desc' | 'created_asc' | 'name_asc' | 'cards_desc'
  const [showGraveyardDecks, setShowGraveyardDecks] = useState(false);
  const [deckSelectionViewMode, setDeckSelectionViewMode] = useState('table'); // 'grid' | 'table'

  // Draw Simulator States
  const [showSimulator, setShowSimulator] = useState(false);
  const [simulatorDeck, setSimulatorDeck] = useState([]);
  const [hand, setHand] = useState([]);
  const [mulliganCount, setMulliganCount] = useState(0);

  // Import / Export Modals
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState('mtga');
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareUrl, setShareUrl] = useState(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState(null);
  const [shareStatus, setShareStatus] = useState('');
  const [shareRetry, setShareRetry] = useState(0);
  const shareInputRef = useRef(null);
  const shareCreateRef = useRef(null);
  const shareTriggerRef = useRef(null);
  const [importText, setImportText] = useState('');
  const [importComparison, setImportComparison] = useState(null);
  const [comparingImport, setComparingImport] = useState(false);
  const [importSummary, setImportSummary] = useState(null);

  // Checkout States
  const [checkingOut, setCheckingOut] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [checkoutLocations, setCheckoutLocations] = useState([]);
  const [checkoutMode, setCheckoutMode] = useState('checkout'); // 'checkout' | 'checkin'
  const [checkoutDeckId, setCheckoutDeckId] = useState(null); // deck the open modal acts on
  const [deckCardLocations, setDeckCardLocations] = useState({});
  const [deckLocationsError, setDeckLocationsError] = useState(false);
  const [savingSleeved, setSavingSleeved] = useState(false);
  const [sleevedError, setSleevedError] = useState(false);
  const [savingCardBack, setSavingCardBack] = useState(false);
  const [showDeckContainerModal, setShowDeckContainerModal] = useState(false);

  const editorBusy = savingDeck || savingSleeved || savingCardBack || loading || refreshingInventory || comparingImport || checkingOut || showCheckoutModal || showDeckContainerModal;
  const hasUnsavedChanges = !!activeDeck && (
    JSON.stringify(deckEditorState(activeDeck)) !== savedEditorState
    || (!!deckDraft && JSON.stringify(deckEditorState({ ...activeDeck, ...deckDraft })) !== JSON.stringify(deckEditorState(activeDeck)))
  );
  const [savingRecord, setSavingRecord] = useState(false);

  const previewDeckCard = !showAiBuilder && activeDeck?.inventory_type === 'collection'
    ? activeDeck?.cards.find(card => card.id === previewCard?.id)
    : null;
  const sourceKey = previewDeckCard ? `${activeDeck.id}/${previewDeckCard.id}` : null;
  const sourcesReady = cardSources?.key === sourceKey && cardSources?.status === 'ready';
  const sourcesError = cardSources?.key === sourceKey && cardSources?.status === 'error';
  const selectedSourceId = previewDeckCard?.source_entry_id ?? null;
  const selectedSource = sourcesReady
    ? cardSources.sources.find(source => source.entry_id === selectedSourceId)
    : null;
  const selectedSourceUnavailable = sourcesReady && selectedSourceId !== null
    && (!selectedSource || selectedSource.available < previewDeckCard.quantity);

  useEffect(() => {
    if (!showShareModal || !activeDeck?.id) return;
    const controller = new AbortController();
    setShareUrl(null);
    setShareStatus('');
    setShareError(null);
    setShareLoading(true);
    const loadShare = async () => {
      try {
        if (import.meta.env.VITE_DEMO) throw new Error(t('deck.shareDemoUnavailable'));
        const response = await fetch(`/api/decks/${activeDeck.id}/share`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !(data.url === null || typeof data.url === 'string')) throw new Error(t('deck.shareLoadError'));
        if (!controller.signal.aborted) setShareUrl(data.url ? new URL(data.url, window.location.origin).href : null);
      } catch (error) {
        if (!controller.signal.aborted) setShareError(error.message === t('deck.shareDemoUnavailable') ? error.message : t('deck.shareLoadError'));
      } finally {
        if (!controller.signal.aborted) setShareLoading(false);
      }
    };
    loadShare();
    return () => controller.abort();
  }, [showShareModal, activeDeck?.id, shareRetry, t]);

  useEffect(() => {
    if (showShareModal && !shareLoading) (shareInputRef.current || shareCreateRef.current)?.focus();
  }, [showShareModal, shareLoading, shareUrl]);

  const copyShareLink = async () => {
    setShareStatus('');
    setShareError(null);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareStatus(t('deck.shareCopied'));
    } catch {
      shareInputRef.current?.focus();
      shareInputRef.current?.select();
      setShareError(t('deck.shareCopyError'));
    }
  };

  const updateShareLink = async (revoke = false, regenerate = false) => {
    if (shareBusy || shareLoading || (!revoke && !regenerate && hasUnsavedChanges)) return;
    if ((revoke || regenerate) && !window.confirm(t(regenerate ? 'deck.shareConfirmRegenerate' : 'deck.shareConfirmRevoke'))) return;
    setShareBusy(true);
    setShareError(null);
    setShareStatus('');
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/share`, {
        method: revoke ? 'DELETE' : 'POST',
        ...(regenerate ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: true }) } : {})
      });
      const data = await response.json();
      if (!response.ok || (revoke ? data.success !== true : typeof data.url !== 'string' || !data.url)) throw new Error();
      setShareUrl(revoke ? null : new URL(data.url, window.location.origin).href);
      setShareStatus(t(revoke ? 'deck.shareRevoked' : 'deck.shareCreated'));
    } catch {
      setShareError(t(revoke ? 'deck.shareRevokeError' : 'deck.shareCreateError'));
    } finally {
      setShareBusy(false);
    }
  };

  useEffect(() => {
    if (!sourceKey) {
      setCardSources(null);
      return;
    }
    const controller = new AbortController();
    setCardSources({ key: sourceKey, status: 'loading' });
    const loadSources = async () => {
      try {
        const [deckId, cardId] = sourceKey.split('/');
        const response = await fetch(`/api/decks/${deckId}/cards/${encodeURIComponent(cardId)}/sources`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.sources)) throw new Error(data.error || t('deck.errSources'));
        if (!controller.signal.aborted) setCardSources({ key: sourceKey, status: 'ready', sources: data.sources });
      } catch (error) {
        if (!controller.signal.aborted) setCardSources({ key: sourceKey, status: 'error', error: error.message });
      }
    };
    loadSources();
    return () => controller.abort();
  }, [sourceKey, sourceRetry, activeDeck?.checked_out, savedEditorState, t]);

  const handleSourceChange = (value) => {
    if (!previewDeckCard || editorBusy || savingRecord || searching || deckDraft || activeDeck.checked_out || !sourcesReady) return;
    const sourceId = value === '' ? null : Number(value);
    if (sourceId !== null && !cardSources.sources.some(source => source.entry_id === sourceId && source.available >= previewDeckCard.quantity)) return;
    const updatedDeck = {
      ...activeDeck,
      cards: activeDeck.cards.map(card => card.id === previewDeckCard.id ? { ...card, source_entry_id: sourceId } : card)
    };
    setActiveDeck(updatedDeck);
    handleSaveDeck(updatedDeck);
  };

  const sourceLabel = (source) => [
    source.storage_unit_name,
    source.location_name || t('bulk.unassignedPile'),
    source.compartment_display,
    t('deck.sourceAvailable', { available: source.available, quantity: source.quantity })
  ].filter(Boolean).join(' · ');

  const confirmLeaveEditor = () => {
    if (activeDeck && (editorBusy || savingRecord)) {
      showToast(t('deck.waitForOperation'), 'status');
      return false;
    }
    return !hasUnsavedChanges || window.confirm(t('deck.confirmDiscard'));
  };

  const leaveDeck = () => {
    if (!confirmLeaveEditor()) return false;
    setActiveDeck(null);
    setSavedEditorState(null);
    setDeckDraft(null);
    setSaveDeckError(null);
    setSleevedError(false);
    setSearchResults([]);
    setBrowseFilters({});
    setShowBrowseFilters(false);
    setImportComparison(null);
    setViewMode('list');
    fetchDecks();
  };

  useLayoutEffect(() => {
    if (!navigationGuardRef) return;
    navigationGuardRef.current = confirmLeaveEditor;
    return () => { navigationGuardRef.current = null; };
  });

  useEffect(() => {
    if (!hasUnsavedChanges && !savingDeck) return;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges, savingDeck]);

  const closeCreateModal = () => {
    setCreateDeckError(null);
    setNewDeckName('');
    setNewDeckDesc('');
    setNewDeckFormat(NEW_DECK_DEFAULTS.format);
    setNewDeckCategory('Competitive');
    setNewDeckAccentColor('#eab308');
    setNewDeckTargetSize(NEW_DECK_DEFAULTS.targetSize);
    setNewDeckImportText('');
    setNewDeckImportFormat('plain');
    setNewDeckPreconFile('');
    setNewDeckInventoryType('collection');
    setShowPreconPicker(false);
    setShowImportDecklistArea(false);
    setShowCreateModal(false);
  };

  useBackGuard(viewMode === 'detail' && !!activeDeck, leaveDeck);
  useBackGuard(showCreateModal, () => creatingDeck ? false : closeCreateModal());
  useBackGuard(showSimulator, () => setShowSimulator(false));
  useBackGuard(!!deckDraft, () => refreshingInventory ? false : setDeckDraft(null));
  useBackGuard(showImportModal, () => setShowImportModal(false));
  useBackGuard(showExportModal, () => setShowExportModal(false));
  useBackGuard(showShareModal, () => shareBusy ? false : setShowShareModal(false));
  useBackGuard(!!importSummary, () => setImportSummary(null));
  useBackGuard(showAiBuilder, closeAiBuilder);
  useBackGuard(!!previewCard, () => setPreviewCard(null));

  useEffect(() => {
    fetchDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchDecks = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/decks');
      if (response.ok) {
        const data = await response.json();
        setDecks(data.filter(deck => isGameEnabled(deck.game)));
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errLoadDecks'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDeck = async (e) => {
    e.preventDefault();
    if (creatingDeck || !newDeckName.trim()) return;
    setCreatingDeck(true);
    setCreateDeckError(null);

    try {
      const response = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: newDeckName, 
          description: newDeckDesc, 
          game: 'mtg',
          format: newDeckFormat,
          category: newDeckCategory,
          accent_color: newDeckAccentColor,
          target_size: newDeckTargetSize,
          decklist_text: newDeckImportText,
          decklist_format: newDeckImportFormat,
          inventory_type: newDeckInventoryType,
          precon_file: newDeckPreconFile
        })
      });

      const data = await response.json();
      if (response.ok) {
        showToast(data.message || t('deck.created'), 'success');
        closeCreateModal();
        await fetchDecks();
        await loadDeckDetails(data.id);
      } else {
        setCreateDeckError(data.error || t('deck.errCreate'));
      }
    } catch (err) {
      console.error(err);
      setCreateDeckError(t('deck.errCreateGeneric'));
    } finally {
      setCreatingDeck(false);
    }
  };

  const handleManaBoxDeckFile = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    try {
      setNewDeckImportText(await file.text());
      setNewDeckImportFormat('manabox');
      setNewDeckPreconFile('');
    } catch {
      showToast(t('settings.errReadFile'), 'error');
    }
  };

  const handleApplyDeckProperties = async () => {
    if (!activeDeck || !deckDraft?.name.trim() || editorBusy) return;
    if (activeDeck.checked_out && deckDraft.inventory_type !== activeDeck.inventory_type) {
      showToast(t('deck.returnBeforeEditing'), 'error');
      return;
    }
    let cards = activeDeck.cards;
    if (deckDraft.inventory_type !== activeDeck.inventory_type) {
      setRefreshingInventory(true);
      try {
        const inventory = await loadInventoryCards(activeDeck.game, deckDraft.inventory_type);
        const owned = new Map(inventory.map(card => [card.id, card.owned_qty]));
        cards = cards.map(card => ({ ...card, source_entry_id: null, owned_qty: owned.get(card.id) || 0, locked_qty: 0, locked_decks: null }));
        setSearchResults([]);
        setBrowseFilters({});
        setShowBrowseFilters(false);
        setImportComparison(null);
        setDeckCardLocations({});
        setDeckCardSortBy('type');
      } catch (error) {
        showToast(error.message, 'error');
        return;
      } finally {
        setRefreshingInventory(false);
      }
    }
    setActiveDeck(deck => ({
      ...deck, ...deckDraft, name: deckDraft.name.trim(), target_size: Number(deckDraft.target_size), cards,
      commander_card_id: /commander|edh|brawl/i.test(deckDraft.format) ? deck.commander_card_id : null
    }));
    setDeckDraft(null);
  };

  const handleSaveDeck = async (deck = activeDeck) => {
    if (!deck || JSON.stringify(deckEditorState(deck)) === savedEditorState || editorBusy || savingRecord || searching || deckDraft) return;
    setSavingDeck(true);
    setSaveDeckError(null);
    try {
      const response = await fetch(`/api/decks/${deck.id}/editor`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deckEditorState(deck))
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('deck.errSave'));
      if (await loadDeckDetails(deck.id)) showToast(data.message, 'success');
      else setSaveDeckError(t('deck.errLoadDetails'));
      await fetchDecks();
    } catch (error) {
      console.error(error);
      setSaveDeckError(error.message);
      showToast(error.message, 'error');
    } finally {
      setSavingDeck(false);
    }
  };

  const loadDeckDetails = async (deckId) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/decks/${deckId}`);
      if (!response.ok) throw new Error(t('deck.errLoadDetails'));
      const data = await response.json();
      if (!isGameEnabled(data.game)) throw new Error(t('deck.errLoadDetails'));
      const locationsResponse = data.inventory_type === 'collection' ? await fetch(`/api/decks/${deckId}/locations`) : null;
      const locations = locationsResponse?.ok ? await locationsResponse.json() : [];
      setDeckLocationsError(data.inventory_type === 'collection' && !locationsResponse?.ok);
      setDeckCardLocations(Object.fromEntries(locations.map(({ card_id, locations: cardLocations }) => [card_id, cardLocations])));
      setActiveDeck(data);
      if (data.inventory_type !== 'collection') setDeckCardSortBy('type');
      setSavedEditorState(JSON.stringify(deckEditorState(data)));
      setDeckDraft(null);
      setSaveDeckError(null);
      setSleevedError(false);
      setSearchResults([]);
      setBrowseFilters({});
      setShowBrowseFilters(false);
      setImportComparison(null);
      setDeckSearchGame(data.game);
      setViewMode('detail');
      return true;
    } catch (err) {
      console.error(err);
      showToast(t('deck.errLoadDetails'), 'error');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleRecordChange = async (result, delta) => {
    if (!activeDeck || savingRecord || savingDeck) return;
    const count = activeDeck[result === 'win' ? 'wins' : 'losses'] ?? 0;
    if ((delta === -1 && count === 0) || (delta === 1 && count === 2147483647)) return;
    const deckId = activeDeck.id;
    setSavingRecord(true);
    try {
      const response = await fetch(`/api/decks/${deckId}/record`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, delta })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('deck.errRecord'));
      const record = { wins: data.wins, losses: data.losses };
      setActiveDeck(deck => deck?.id === deckId ? { ...deck, ...record } : deck);
      setDecks(current => current.map(deck => deck.id === deckId ? { ...deck, ...record } : deck));
    } catch (error) {
      console.error(error);
      showToast(t('deck.errRecord'), 'error');
    } finally {
      setSavingRecord(false);
    }
  };

  const handleSleevedChange = async (sleeved) => {
    if (!activeDeck || editorBusy || sleeved === (activeDeck.sleeved ?? 0)) return;
    const deckId = activeDeck.id;
    setSavingSleeved(true);
    setSleevedError(false);
    try {
      const response = await fetch(`/api/decks/${deckId}/sleeved`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleeved })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('deck.errSleeved'));
      setActiveDeck(deck => deck?.id === deckId ? { ...deck, sleeved: data.sleeved } : deck);
      setDecks(current => current.map(deck => deck.id === deckId ? { ...deck, sleeved: data.sleeved } : deck));
    } catch (error) {
      console.error(error);
      setSleevedError(true);
    } finally {
      setSavingSleeved(false);
    }
  };

  const handleCommanderChange = (cardId) => {
    if (!activeDeck || editorBusy) return;
    setActiveDeck(deck => ({ ...deck, commander_card_id: cardId || null }));
  };

  const handlePulledChange = (cardId, pulled) => {
    if (!activeDeck || editorBusy) return;
    setActiveDeck(deck => ({
      ...deck,
      cards: deck.cards.map(card => card.id === cardId ? { ...card, checked_out: pulled ? 1 : 0 } : card)
    }));
  };

  const handleAddCardToDeck = (card) => {
    if (!activeDeck || editorBusy) return;
    const existing = activeDeck.cards.find(c => c.id === card.id);
    handleUpdateCardQty(card.id, (existing?.quantity || 0) + 1, card);
  };

  const handleUpdateCardQty = (cardId, newQty, newCard = null) => {
    if (!activeDeck || editorBusy || !Number.isSafeInteger(newQty)) return;
    if (activeDeck.checked_out) {
      showToast(t('deck.returnBeforeEditing'), 'error');
      return;
    }
    if (newQty <= 0) {
      setActiveDeck(deck => ({
        ...deck,
        cards: deck.cards.filter(card => card.id !== cardId),
        commander_card_id: deck.commander_card_id === cardId ? null : deck.commander_card_id
      }));
      return;
    }
    const existing = activeDeck.cards.find(card => card.id === cardId);
    const card = existing || newCard;
    if (!card) return;
    if (newQty > (existing?.quantity || 0)) {
      if (newQty > (card.owned_qty || 0)) {
        showToast(t('deck.errOwnedLimit', { count: card.owned_qty || 0, name: displayName(card) }), 'error');
        return;
      }
      if (!isBasicLand(card, activeDeck.game) && deckCountByName(activeDeck.cards, card.name) - (existing?.quantity || 0) + newQty > 4) {
        showToast(t('deck.errCopyLimit', { count: 4, name: displayName(card) }), 'error');
        return;
      }
    }
    setActiveDeck(deck => ({
      ...deck,
      cards: existing
        ? deck.cards.map(current => current.id === cardId ? { ...current, quantity: newQty } : current)
        : [...deck.cards, { ...card, quantity: newQty, checked_out: 0, source_entry_id: null }]
    }));
  };

  const handleDeleteDeck = async (deckId, name) => {
    if (!window.confirm(t('deck.confirmDelete', { name }))) return;

    try {
      const response = await fetch(`/api/decks/${deckId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('deck.deleted'), 'success');
        fetchDecks();
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errDelete'), 'error');
    }
  };

  const handleDuplicateDeck = async (deckId) => {
    try {
      const response = await fetch(`/api/decks/${deckId}/duplicate`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) return showToast(data.error || t('deck.errDuplicate'), 'error');
      showToast(t('deck.duplicated'), 'success');
      await fetchDecks();
      loadDeckDetails(data.id);
    } catch (err) {
      console.error(err);
      showToast(t('deck.errDuplicate'), 'error');
    }
  };

  const loadInventoryCards = async (game, inventoryType) => {
    const response = await fetch(`/api/collection?game=${game}&list_type=${inventoryType}`);
    if (!response.ok) throw new Error(t('deck.errSearch'));
    const byId = new Map();
    // Collection rows are physical entries; the editor needs totals per printing.
    for (const item of await response.json()) {
      const card = byId.get(item.card_id) || {
        ...item, id: item.card_id, number: item.number || item.collector_number || item.card_number || '', owned_qty: 0, inventory_entries: []
      };
      card.owned_qty += item.quantity || 1;
      card.inventory_entries.push(item);
      byId.set(item.card_id, card);
    }
    return Array.from(byId.values());
  };

  const handleSearchCards = async (e, forceBrowse = false, search = searchQuery) => {
    if (e) e.preventDefault();
    try {
      setSearching(true);
      const inventoryType = activeDeck?.inventory_type || 'collection';
      if (forceBrowse || !search.trim() || inventoryType !== 'collection') {
        const cards = await loadInventoryCards(deckSearchGame, inventoryType);
        const query = search.trim().toLowerCase();
        setSearchResults(cards.filter(card => !query || [card.name, card.printed_name, card.set_name, card.number].some(value => String(value || '').toLowerCase().includes(query))));
      } else {
        const response = await fetch(`/api/search?name=${encodeURIComponent(search)}&scope=collection&game=${deckSearchGame}`);
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data);
        } else {
          showToast(t(response.status === 429 ? 'deck.errRateLimit' : 'deck.errSearch'), 'error');
        }
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errSearch'), 'error');
    } finally {
      setSearching(false);
    }
  };

  // --- CHECKOUT / RETURN ---
  const handleCheckout = async (deck = null) => {
    const targetDeck = deck || activeDeck;
    if (!targetDeck || targetDeck.inventory_type !== 'collection') return;
    if (editorBusy) return;
    if (targetDeck.id === activeDeck?.id && hasUnsavedChanges) return showToast(t('deck.saveFirst'), 'error');
    try {
      setCheckingOut(true);
      const res = await fetch(`/api/decks/${targetDeck.id}/checkout`, { method: 'PUT' });
      if (res.ok) {
        showToast(t('deck.checkedOut', { name: targetDeck.name }), 'success');
        if (activeDeck && activeDeck.id === targetDeck.id) {
          setActiveDeck(prev => ({ ...prev, checked_out: 1, checked_out_at: new Date().toISOString() }));
        }
        fetchDecks();

        const locRes = await fetch(`/api/decks/${targetDeck.id}/locations`);
        if (locRes.ok) {
          const locData = await locRes.json();
          setCheckoutLocations(locData);
          setCheckoutMode('checkout');
          setCheckoutDeckId(targetDeck.id);
          setShowCheckoutModal(true);
        }
      } else {
        const errData = await res.json().catch(() => null);
        if (errData && errData.details && errData.details.length > 0) {
          showToast(t('deck.errCheckout', { detail: errData.details[0], extra: errData.details.length > 1 ? t('deck.andMore', { count: errData.details.length - 1 }) : '' }), 'error');
        } else {
          showToast(errData?.error || 'Failed to check out deck.', 'error');
        }
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errCheckoutGeneric'), 'error');
    } finally {
      setCheckingOut(false);
    }
  };

  const handleReturn = async (deck = null) => {
    const targetDeck = deck || activeDeck;
    if (!targetDeck || targetDeck.inventory_type !== 'collection') return;
    if (editorBusy) return;
    if (targetDeck.id === activeDeck?.id && hasUnsavedChanges) return showToast(t('deck.saveFirst'), 'error');
    try {
      setCheckingOut(true);
      // Capture where each card lives before flipping the flag, so the check-in
      // guide can show where to return them (cards stay in their slots either
      // way, but fetch first to be safe).
      const locRes = await fetch(`/api/decks/${targetDeck.id}/locations`);
      const locData = locRes.ok ? await locRes.json() : null;
      const res = await fetch(`/api/decks/${targetDeck.id}/return`, { method: 'PUT' });
      if (res.ok) {
        showToast(t('deck.returned', { name: targetDeck.name }), 'success');
        if (activeDeck && activeDeck.id === targetDeck.id) {
          setActiveDeck(prev => ({ ...prev, checked_out: 0, checked_out_at: null }));
        }
        fetchDecks();
        if (locData) {
          setCheckoutLocations(locData);
          setCheckoutMode('checkin');
          setCheckoutDeckId(targetDeck.id);
          setShowCheckoutModal(true);
        }
      } else {
        showToast(t('deck.errReturn'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errReturnGeneric'), 'error');
    } finally {
      setCheckingOut(false);
    }
  };

  // Closing the guide via X / back = cancel: revert the toggle we just committed
  // by calling the opposite endpoint. (Done button keeps the status.)
  const handleCheckoutCancel = async () => {
    const id = checkoutDeckId;
    setShowCheckoutModal(false);
    if (!id) return;
    const undo = checkoutMode === 'checkout' ? 'return' : 'checkout';
    try {
      const res = await fetch(`/api/decks/${id}/${undo}`, { method: 'PUT' });
      if (!res.ok) { showToast(t('deck.errUndo'), 'error'); return; }
      if (activeDeck && activeDeck.id === id) {
        const back = checkoutMode === 'checkout';
        setActiveDeck(prev => ({ ...prev, checked_out: back ? 0 : 1, checked_out_at: back ? null : new Date().toISOString() }));
      }
      fetchDecks();
      showToast(t(checkoutMode === 'checkout' ? 'deck.checkoutCanceled' : 'deck.returnCanceled'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('deck.errUndo'), 'error');
    }
  };

  // --- DRAW SIMULATOR LOGIC ---
  const startSimulator = () => {
    if (!activeDeck || activeDeck.cards.length === 0) {
      showToast(t('deck.errEmptyDeck'), 'error');
      return;
    }

    // Expand cards into full array based on quantities
    const fullDeck = [];
    activeDeck.cards.forEach(c => {
      for (let i = 0; i < c.quantity; i++) {
        fullDeck.push({ ...c });
      }
    });

    const shuffled = shuffleArray(fullDeck);
    setSimulatorDeck(shuffled);
    setHand(shuffled.slice(0, 7));
    setMulliganCount(0);
    setShowSimulator(true);
  };

  const handleMulligan = () => {
    const shuffled = shuffleArray(simulatorDeck);
    const nextMulligan = mulliganCount + 1;
    const drawCount = Math.max(1, 7 - nextMulligan);
    setSimulatorDeck(shuffled);
    setHand(shuffled.slice(0, drawCount));
    setMulliganCount(nextMulligan);
  };

  const handleDrawCard = () => {
    const nextIndex = hand.length;
    if (nextIndex >= simulatorDeck.length) {
      showToast(t('deck.errNoCardsLeft'), 'error');
      return;
    }
    setHand([...hand, simulatorDeck[nextIndex]]);
  };

  // --- EXPORT & IMPORT LOGIC ---
  const handleExportDeckText = () => {
    if (!activeDeck) return '';
    return buildDeckExport(activeDeck.cards, exportFormat);
  };

  const handleCopyExportText = () => {
    const text = handleExportDeckText();
    navigator.clipboard.writeText(text)
      .then(() => showToast(t('deck.copied'), 'success'))
      .catch(() => showToast(t('deck.errCopy'), 'error'));
  };

  // Copy the buylist and open TCGplayer Mass Entry — user pastes (their mass
  // entry page has no documented prefill URL param, so clipboard + open is the
  // reliable path).
  const handleOpenMassEntry = () => {
    const text = buildDeckExport(activeDeck?.cards, 'buylist');
    if (!text) { showToast(t('deck.nothingToBuy'), 'status'); return; }
    navigator.clipboard.writeText(text).catch(() => {});
    window.open('https://www.tcgplayer.com/massentry?productline=Magic', '_blank', 'noopener');
    showToast(t('deck.buylistCopied'), 'success');
  };

  const loadOwnedImportCards = async () => {
    const cards = await loadInventoryCards(activeDeck.game, activeDeck.inventory_type || 'collection');
    return ownedImportIndex(cards);
  };

  const handleCompareImport = async () => {
    if (!importText.trim() || !activeDeck || editorBusy) return;
    setComparingImport(true);
    const lines = importText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    let ownedCards;
    try {
      ownedCards = await loadOwnedImportCards();
    } catch (err) {
      console.error(err);
      setComparingImport(false);
      showToast(t('deck.errSearch'), 'error');
      return;
    }

    for (const line of lines) {
      const parsed = parseDeckLine(line);
      if (!parsed) continue;
      const { qty, name: rawName, setCode, number } = parsed;
      const displayName = setCode && number ? `${rawName} (${setCode.toUpperCase()}) ${number}` : rawName;

      try {
        const card = findOwnedImportCard(parsed, ownedCards);
        if (card) {
          const owned = card.owned_qty || 0;
          const inDeck = activeDeck.cards.find(c => c.id === card.id)?.quantity || 0;
          results.push({
            rawName: displayName,
            requestedQty: qty,
            ownedQty: owned,
            inDeckQty: inDeck,
            card,
            status: owned >= qty ? 'full' : owned > 0 ? 'partial' : 'missing'
          });
        } else {
          results.push({
            rawName: displayName,
            requestedQty: qty,
            ownedQty: 0,
            inDeckQty: 0,
            card: null,
            status: 'missing'
          });
        }
      } catch (err) {
        console.error(err);
      }
    }
    setImportComparison(results);
    setComparingImport(false);
  };

  const handleImportDeck = () => {
    if (!activeDeck || !importComparison || editorBusy) return;
    if (activeDeck.checked_out) {
      showToast(t('deck.returnBeforeEditing'), 'error');
      return;
    }
    let cards = [...activeDeck.cards];
    let addedCount = 0;
    const skipped = [];

    for (const item of importComparison) {
      if (!item.card || item.ownedQty <= 0) {
        skipped.push({ name: item.rawName, quantity: item.requestedQty, reason: 'deck.notOwned' });
        continue;
      }
      const quantity = Math.min(item.requestedQty, item.ownedQty);
      const existing = cards.find(card => card.id === item.card.id);
      if (!isBasicLand(item.card, activeDeck.game)
        && deckCountByName(cards, item.card.name) - (existing?.quantity || 0) + quantity > 4) {
        skipped.push({ name: item.rawName, quantity, reason: 'deck.importCopyLimit' });
        continue;
      }
      cards = existing
        ? cards.map(card => card.id === existing.id ? { ...card, quantity } : card)
        : [...cards, { ...item.card, quantity, checked_out: 0, source_entry_id: null }];
      addedCount++;
      if (item.requestedQty > quantity) {
        skipped.push({ name: item.rawName, quantity: item.requestedQty - quantity, reason: 'deck.notOwned' });
      }
    }

    if (addedCount > 0) {
      setActiveDeck(deck => ({ ...deck, cards }));
      setImportText('');
      setImportComparison(null);
    }
    setImportSummary({ addedCount, skipped });
    setShowImportModal(false);
  };

  const deckGame = activeDeck?.game;

  // MTG card-type buckets, read off the parsed type line stored in subtypes.
  const MTG_MAIN_TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land'];
  const cardGroup = (card) => {
    const subs = card.subtypes || [];
    for (const t of MTG_MAIN_TYPES) if (subs.includes(t)) return t;
    return 'Other';
  };

  const GROUP_ORDER = [...MTG_MAIN_TYPES, 'Other'];

  const deckCardGroups = activeDeck && deckCardSortBy === 'pulled'
    ? [false, true].map(pulled => ({
        name: t(pulled ? 'deck.pulled' : 'deck.notPulled'),
        cards: activeDeck.cards.filter(card => !!card.checked_out === pulled)
          .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      }))
    : activeDeck && deckCardSortBy === 'location'
    ? [{
        name: t('collection.fLocation'),
        cards: [...activeDeck.cards].sort((a, b) => {
          const aLocation = deckCardLocations[a.id]?.[0];
          const bLocation = deckCardLocations[b.id]?.[0];
          if (!aLocation) return bLocation ? 1 : displayName(a).localeCompare(displayName(b));
          if (!bLocation) return -1;
          return locationCollator.compare(aLocation.location_name, bLocation.location_name)
            || locationCollator.compare(aLocation.compartment_display || '', bLocation.compartment_display || '')
            || (aLocation.position || 0) - (bLocation.position || 0)
            || displayName(a).localeCompare(displayName(b));
        })
      }]
    : activeDeck && deckCardSortBy === 'color'
    ? Object.keys(TYPE_ORDER).map(color => ({
        name: t(`dash.color.${color}`),
        cards: activeDeck.cards.filter(card => typeCategory(card.types) === color)
          .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      }))
    : GROUP_ORDER.map(name => ({
        name,
        cards: activeDeck?.cards.filter(card => cardGroup(card).toLowerCase() === name.toLowerCase())
          .sort((a, b) => displayName(a).localeCompare(displayName(b))) || []
      }));

  // --- CHART DATA GENERATION ---
  const getSupertypeChartData = () => {
    if (!activeDeck) return [];
    const counts = {};
    activeDeck.cards.forEach(c => {
      const g = cardGroup(c);
      counts[g] = (counts[g] || 0) + c.quantity;
    });
    return Object.keys(counts).map(key => ({ name: key, value: counts[key] })).filter(d => d.value > 0);
  };

  const getManaCurveData = () => {
    if (!activeDeck) return [];
    const counts = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7+': 0 };
    activeDeck.cards.forEach(c => {
      const val = c.cmc ?? null;
      if (val !== null) {
        const bucket = val >= 7 ? '7+' : String(Math.floor(val));
        if (counts[bucket] !== undefined) counts[bucket] += c.quantity;
      }
    });
    return Object.keys(counts).map(cost => ({ cost, count: counts[cost] }));
  };

  const getColorChartData = () => {
    if (!activeDeck) return [];
    const map = {};
    if (deckGame === 'mtg') {
      // Color and Land type distribution
      activeDeck.cards.forEach(c => {
        const subs = c.subtypes || [];
        const isLand = subs.includes('Land') || c.supertype === 'Land' || cardGroup(c) === 'Land';
        if (isLand) {
          const basicLandTypes = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
          const foundType = basicLandTypes.find(t => subs.includes(t) || c.name.includes(t));
          const label = foundType ? `Land (${foundType})` : 'Land (Nonbasic)';
          map[label] = (map[label] || 0) + c.quantity;
        } else {
          const colors = c.colors || c.types || [];
          if (colors.length === 0) {
            map['Colorless'] = (map['Colorless'] || 0) + c.quantity;
          } else {
            colors.forEach(col => {
              const colorName = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[col] || col;
              map[colorName] = (map[colorName] || 0) + c.quantity;
            });
          }
        }
      });
      return Object.keys(map).map(key => ({ name: key, value: map[key] }));
    }
    return Object.keys(map).map(key => ({ name: key, value: map[key] }));
  };

  const totalDeckCardsCount = activeDeck ? activeDeck.cards.reduce((sum, c) => sum + c.quantity, 0) : 0;
  const commanderCard = activeDeck?.cards.find(card => card.id === activeDeck.commander_card_id);
  const commanderChoices = activeDeck?.cards
    .filter(card => ['Creature', 'Planeswalker'].includes(cardGroup(card)) || card.id === activeDeck.commander_card_id)
    .sort((a, b) => displayName(a).localeCompare(displayName(b))) || [];
  const targetDeckCardsCount = activeDeck?.target_size || 60;
  const supertypeData = getSupertypeChartData();
  const colorData = getColorChartData();
  const manaCurveData = getManaCurveData();
  const neededContainers = deckContainers(deckCardLocations);
  const unavailableCopies = Math.max(0, totalDeckCardsCount - neededContainers.reduce((sum, container) => sum + container.quantity, 0));


  // --- SELECTION MENU METRICS & FILTERING ---
  const filteredDecks = decks.filter(deck => {
    if (!showGraveyardDecks && deck.inventory_type === 'graveyard') return false;
    const q = deckSearchTerm.trim().toLowerCase();
    const matchesSearch = !q ||
      deck.name.toLowerCase().includes(q) ||
      (deck.description && deck.description.toLowerCase().includes(q));

    const matchesGame = isGameEnabled(deck.game);

    let matchesStatus = true;
    if (deckStatusFilter === 'ready') matchesStatus = deck.total_cards === (deck.target_size || 60) && !(deck.missing_cards > 0);
    else if (deckStatusFilter === 'missing') matchesStatus = deck.missing_cards > 0;
    else if (deckStatusFilter === 'in_progress') matchesStatus = (deck.total_cards || 0) < (deck.target_size || 60);
    else if (deckStatusFilter === 'in_play') matchesStatus = !!deck.checked_out;

    return matchesSearch && matchesGame && matchesStatus;
  }).sort((a, b) => {
    if (deckSortBy === 'name_asc') return a.name.localeCompare(b.name);
    if (deckSortBy === 'cards_desc') return (b.total_cards || 0) - (a.total_cards || 0);
    if (deckSortBy === 'created_asc') return new Date(a.created_at) - new Date(b.created_at);
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {showAcquisitionPlanner && <AcquisitionPlanner decks={decks} onClose={() => setShowAcquisitionPlanner(false)} />}
      
      {showAiBuilder && (
        <AiDeckBuilder
          sourceDeck={aiSourceDeck}
          onPreview={setPreviewCard}
          onClose={closeAiBuilder}
          onOpenAiSettings={onOpenAiSettings}
          onSaved={async id => {
            closeAiBuilder();
            showToast(t(id === aiSourceDeck?.id ? 'aiDeck.saved' : 'deck.created'), 'success');
            await fetchDecks();
            await loadDeckDetails(id);
          }}
        />
      )}
      {/* 1. SELECTION MENU VIEW OF ALL DECKS */}
      {viewMode === 'list' && !showAiBuilder && (
        <div className="deck-gallery" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* Top Banner Header & Primary Action */}
          <div className="deck-gallery-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h2 style={{ fontSize: '1.4rem', color: 'var(--text-strong)', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                <Layers size={22} style={{ color: 'var(--accent-yellow)' }} />
                {t('deck.vaultTitle')}
              </h2>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowAcquisitionPlanner(true)}>{t('planner.title')}</button>
              {isGameEnabled('mtg') && <button className="btn btn-secondary" onClick={() => { setAiSourceDeck(null); setShowAiBuilder(true); }}>
                <Zap size={18} /> {t('aiDeck.title')}
              </button>}
            <button 
              className="btn btn-primary" 
              onClick={() => setShowCreateModal(true)}
              style={{ padding: '0.6rem 1.25rem', fontSize: '0.9rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', boxShadow: '0 4px 14px rgba(234, 179, 8, 0.25)' }}
            >
              <Plus size={18} /> {t('deck.createDeck')}
            </button>
            </div>
          </div>

          {/* Search, Filters, Sorting & View Toolbar */}
          <div className="deck-overview-toolbar" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
              
              {/* Search input */}
              <div className="deck-overview-search" style={{ position: 'relative', flex: '1 1 240px', minWidth: '220px' }}>
                <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  className="input-control"
                  placeholder={t('deck.filterPlaceholder')}
                  aria-label={t('deck.filterPlaceholder')}
                  value={deckSearchTerm}
                  onChange={e => setDeckSearchTerm(e.target.value)}
                  style={{ paddingLeft: '2.25rem', width: '100%', fontSize: '0.85rem' }}
                />
                {deckSearchTerm && (
                  <button
                    className="btn btn-secondary btn-icon-only"
                    onClick={() => setDeckSearchTerm('')}
                    aria-label={t('deck.clearFilters')}
                    style={{ position: 'absolute', right: '0.4rem', top: '50%', transform: 'translateY(-50%)', width: '20px', height: '20px', padding: 0, fontSize: '0.7rem' }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-glass)' }}>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                {/* Status Filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Filter size={14} style={{ color: 'var(--text-muted)' }} />
                  <select
                    className="select-control"
                    aria-label={t('admin.colStatus')}
                    value={deckStatusFilter}
                    onChange={e => setDeckStatusFilter(e.target.value)}
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
                  >
                    <option value="all">{t('deck.allStatuses')}</option>
                    <option value="ready">{t('deck.statusBattleReady')}</option>
                    <option value="missing">{t('deck.statusMissingCards')}</option>
                    <option value="in_progress">{t('deck.statusBuildingCount')}</option>
                    <option value="in_play">{t('deck.inPlay')}</option>
                  </select>
                </div>

                {/* Sort Order */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <SlidersHorizontal size={14} style={{ color: 'var(--text-muted)' }} />
                  <select
                    className="select-control"
                    aria-label={t('collection.sortBy')}
                    value={deckSortBy}
                    onChange={e => setDeckSortBy(e.target.value)}
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
                  >
                    <option value="created_desc">{t('deck.sortNewest')}</option>
                    <option value="created_asc">{t('deck.sortOldest')}</option>
                    <option value="name_asc">{t('collection.sort.name-asc')}</option>
                    <option value="cards_desc">{t('deck.sortMostCards')}</option>
                  </select>
                </div>
                <button type="button" role="switch" aria-checked={showGraveyardDecks} className="btn btn-secondary"
                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto', ...(showGraveyardDecks ? { background: 'var(--accent-green)', borderColor: 'var(--accent-green)', color: 'var(--bg-primary)' } : {}) }}
                  onClick={() => setShowGraveyardDecks(current => !current)}>
                  {t('deck.showGraveyard')}
                  <span aria-hidden="true" style={{ width: 28, height: 16, borderRadius: 999, background: showGraveyardDecks ? 'var(--text-on-accent)' : 'var(--text-muted)', position: 'relative', flexShrink: 0 }}>
                    <span style={{ position: 'absolute', top: 2, left: showGraveyardDecks ? 14 : 2, width: 12, height: 12, borderRadius: '50%', background: showGraveyardDecks ? 'var(--accent-green)' : 'var(--bg-primary)' }} />
                  </span>
                </button>
              </div>

              {/* View Mode Toggle: Grid vs Table */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'rgba(0,0,0,0.3)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <button
                  type="button"
                  className={`btn ${deckSelectionViewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setDeckSelectionViewMode('grid')}
                  aria-pressed={deckSelectionViewMode === 'grid'} title={t('deck.gridView')}
                >
                  <LayoutGrid size={13} /> {t('deck.gridView')}
                </button>
                <button
                  type="button"
                  className={`btn ${deckSelectionViewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setDeckSelectionViewMode('table')}
                  aria-pressed={deckSelectionViewMode === 'table'} title={t('deck.tableView')}
                >
                  <List size={13} /> {t('deck.tableView')}
                </button>
              </div>

            </div>
          </div>

          {/* Decks Display Section */}
          {loading ? (
            <div className="spinner" style={{ margin: '3rem auto' }}></div>
          ) : filteredDecks.length === 0 ? (
            <div className="glass-panel" style={{ textAlign: 'center', padding: '3.5rem 1.5rem', color: 'var(--text-secondary)' }}>
              <Layers size={36} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', opacity: 0.5 }} />
              <h3 style={{ color: 'var(--text-strong)', fontSize: '1.05rem', marginBottom: '0.25rem' }}>{t('deck.noMatches')}</h3>
              <p style={{ fontSize: '0.85rem' }}>{t('deck.noMatchesHint')}</p>
              {(deckSearchTerm || deckStatusFilter !== 'all') && (
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: '1rem', fontSize: '0.8rem' }}
                  onClick={() => { setDeckSearchTerm(''); setDeckStatusFilter('all'); }}
                >
                  {t('deck.clearFilters')}
                </button>
              )}
            </div>
          ) : deckSelectionViewMode === 'grid' ? (
            /* --- GRID VIEW --- */
            <div className="deck-overview-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: '1.25rem' }}>
              {filteredDecks.map(deck => {
                const targetSize = deck.target_size || 60;
                const totalCards = deck.total_cards || 0;
                const isComplete = totalCards >= targetSize;
                const hasMissingCards = deck.missing_cards > 0;
                const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));
                const accentColor = deck.accent_color || '#ef4444';

                return (
                  <div
                    key={deck.id}
                    className="glass-panel"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '1rem',
                      padding: '1.25rem',
                      border: deck.checked_out
                        ? '1px solid rgba(234,179,8,0.5)'
                        : `1px solid ${accentColor}40`,
                      position: 'relative',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                      background: 'linear-gradient(145deg, rgba(211,32,42,0.06), rgba(15,23,42,0.65))'
                    }}
                    onClick={() => loadDeckDetails(deck.id)}
                    onMouseEnter={e => {
                      e.currentTarget.style.transform = 'translateY(-3px)';
                      e.currentTarget.style.boxShadow = `0 12px 30px ${accentColor}25`;
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.transform = 'none';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    {/* Top Accent Line */}
                    <div style={{
                      position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
                      background: deck.checked_out
                        ? 'linear-gradient(90deg, #eab308, #f59e0b)'
                        : `linear-gradient(90deg, ${accentColor}, ${accentColor}cc)`
                    }} />

                    {/* In Play Banner */}
                    {deck.checked_out ? (
                      <div style={{
                        marginTop: '4px',
                        background: 'linear-gradient(90deg, rgba(234,179,8,0.9), rgba(245,158,11,0.85))',
                        padding: '4px 10px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '0.65rem',
                        fontWeight: 800,
                        color: '#000',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase'
                      }}>
                        <Gamepad2 size={12} />
                        <span>{t('deck.inPlay')}</span>
                        {deck.checked_out_at && (
                          <span style={{ marginLeft: 'auto', opacity: 0.8, fontWeight: 600 }}>
                            since {new Date(deck.checked_out_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    ) : null}

                    <div>
                      <div className="deck-overview-card-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.15rem', fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>
                              {deck.name}
                            </h3>
                            <span style={{
                              fontSize: '0.6rem',
                              fontWeight: 800,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              padding: '0.1rem 0.45rem',
                              borderRadius: '4px',
                              background: 'rgba(239,68,68,0.15)',
                              color: '#f87171',
                              border: '1px solid rgba(239,68,68,0.3)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '3px'
                            }}>
                              <Swords size={10} /> MTG
                            </span>

                            <span style={{
                              fontSize: '0.6rem',
                              fontWeight: 700,
                              padding: '0.1rem 0.4rem',
                              borderRadius: '4px',
                              background: deck.inventory_type === 'arena' ? 'rgba(168,85,247,0.12)' : 'rgba(74,222,128,0.12)',
                              color: deck.inventory_type === 'arena' ? '#c084fc' : '#4ade80',
                              border: deck.inventory_type === 'arena' ? '1px solid rgba(168,85,247,0.25)' : '1px solid rgba(74,222,128,0.25)'
                            }}>
                              {deck.inventory_type === 'graveyard' ? t('collection.graveyard') : deck.inventory_type === 'arena' ? t('deck.arena') : t('deck.physical')}
                            </span>

                            {deck.format && (
                              <span style={{
                                fontSize: '0.6rem',
                                fontWeight: 700,
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                                background: 'rgba(255,255,255,0.06)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-glass)'
                              }}>
                                {deck.format}
                              </span>
                            )}

                            {deck.category && (
                              <span style={{
                                fontSize: '0.6rem',
                                fontWeight: 700,
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                                background: 'rgba(59, 130, 246, 0.12)',
                                color: '#60a5fa',
                                border: '1px solid rgba(59, 130, 246, 0.25)'
                              }}>
                                {deck.category}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Status Badge */}
                        <span style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '12px',
                          backgroundColor: hasMissingCards ? 'color-mix(in srgb, var(--text-negative) 15%, transparent)' : isComplete ? 'rgba(74, 222, 128, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                          color: hasMissingCards ? 'var(--text-negative)' : isComplete ? '#4ade80' : '#60a5fa',
                          border: hasMissingCards ? '1px solid var(--text-negative)' : isComplete ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(59, 130, 246, 0.3)',
                          whiteSpace: 'nowrap'
                        }}>
                          {t(hasMissingCards ? 'deck.statusMissingCards' : isComplete ? 'deck.statusReady' : 'deck.statusBuilding')}
                        </span>
                      </div>

                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.6rem', minHeight: '34px', lineHeight: '1.4' }}>
                        {deck.description || 'No description provided.'}
                      </p>
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '0.4rem', fontVariantNumeric: 'tabular-nums' }}>
                        {t('deck.recordSummary', { wins: deck.wins ?? 0, losses: deck.losses ?? 0 })}
                      </p>
                    </div>

                    {/* Progress Bar & Details */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('deck.cardCapacity')}</span>
                        <span style={{ color: isComplete ? '#4ade80' : 'var(--text-strong)', fontWeight: 700 }}>
                          {totalCards} / {targetSize} Cards ({percent}%)
                        </span>
                      </div>
                      <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${percent}%`,
                          background: isComplete
                            ? 'linear-gradient(90deg, #4ade80, #22c55e)'
                            : 'linear-gradient(90deg, #3b82f6, #6366f1)',
                          borderRadius: '3px',
                          transition: 'width 0.3s ease'
                        }} />
                      </div>
                    </div>

                    {/* Card Footer Actions */}
                    <div className="deck-overview-card-footer" style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Created {new Date(deck.created_at).toLocaleDateString()}
                      </span>

                      <div className="deck-overview-actions" style={{ display: 'flex', gap: '0.4rem' }}>
                        {deck.inventory_type === 'collection' && (deck.checked_out ? (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
                            onClick={(e) => { e.stopPropagation(); handleReturn(deck); }}
                            disabled={checkingOut}
                          >
                            <PackageCheck size={12} /> Return
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                            onClick={(e) => { e.stopPropagation(); handleCheckout(deck); }}
                            disabled={checkingOut}
                          >
                            <LogOut size={12} /> Checkout
                          </button>
                        ))}

                        <button
                          className="btn btn-primary"
                          style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={(e) => { e.stopPropagation(); loadDeckDetails(deck.id); }}
                        >
                          Open <ArrowRight size={12} />
                        </button>


                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={(e) => { e.stopPropagation(); handleDuplicateDeck(deck.id); }}
                        >
                          <Copy size={12} /> {t('deck.duplicateDeck')}
                        </button>
                        <button
                          className="btn btn-danger btn-icon-only"
                          style={{ padding: '0.3rem' }}
                          onClick={(e) => { e.stopPropagation(); handleDeleteDeck(deck.id, deck.name); }}
                          aria-label={t('deck.deleteDeck')} title={t('deck.deleteDeck')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          ) : (
            /* --- TABLE VIEW --- */
            <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
              <table className="collection-table deck-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem', '--deck-mana-count-size': '1rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-glass)', background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.deckName')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.format')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.inventoryType')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('filter.field.color_identity')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.category')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colCapacity')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('admin.colStatus')}</th>
                    <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>{t('admin.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDecks.map(deck => {
                    const targetSize = deck.target_size || 60;
                    const totalCards = deck.total_cards || 0;
                    const isComplete = totalCards >= targetSize;
                    const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));

                    return (
                      <tr
                        key={deck.id}
                        style={{ borderBottom: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'background 0.15s' }}
                        onClick={() => loadDeckDetails(deck.id)}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td data-label={t('deck.deckName')} style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{deck.name}</span>
                          </div>
                        </td>
                        <td data-label={t('deck.format')} style={{ padding: '0.75rem 1rem' }}>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                            {deck.format}
                          </span>
                        </td>
                        <td data-label={t('deck.inventoryType')} style={{ padding: '0.75rem 1rem' }}>
                          <span style={{
                            fontSize: 'inherit',
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: deck.inventory_type === 'arena' ? 'rgba(168,85,247,0.12)' : 'rgba(74,222,128,0.12)',
                            color: deck.inventory_type === 'arena' ? '#c084fc' : '#4ade80',
                            border: deck.inventory_type === 'arena' ? '1px solid rgba(168,85,247,0.25)' : '1px solid rgba(74,222,128,0.25)'
                          }}>
                            {deck.inventory_type === 'graveyard' ? t('collection.graveyard') : deck.inventory_type === 'arena' ? t('deck.arena') : t('deck.physical')}
                          </span>
                        </td>
                        <td data-label={t('filter.field.color_identity')} style={{ padding: '0.75rem 1rem' }}>
                          <ManaCounts deck={deck} />
                        </td>
                        <td data-label={t('deck.category')} style={{ padding: '0.75rem 1rem' }}>
                          {deck.category && (
                            <span style={{ fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}>
                              {deck.category}
                            </span>
                          )}
                        </td>
                        <td data-label={t('deck.colCapacity')} style={{ padding: '0.75rem 1rem', width: '160px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <div style={{ fontWeight: 700, color: isComplete ? '#4ade80' : 'var(--text-strong)' }}>
                              {totalCards} / {targetSize} Cards
                            </div>
                            <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${percent}%`, background: isComplete ? '#4ade80' : '#3b82f6' }} />
                            </div>
                          </div>
                        </td>
                        <td data-label={t('admin.colStatus')} style={{ padding: '0.75rem 1rem' }}>
                          {deck.missing_cards > 0 ? (
                            <span style={{ fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'color-mix(in srgb, var(--text-negative) 15%, transparent)', color: 'var(--text-negative)', border: '1px solid var(--text-negative)' }}>
                              {t('deck.statusMissingCards')}
                            </span>
                          ) : deck.checked_out ? (
                            <span style={{ fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid rgba(234,179,8,0.4)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Gamepad2 size={11} /> {t('deck.inPlay')}
                            </span>
                          ) : isComplete ? (
                            <span style={{ fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                              {t('deck.statusReady')}
                            </span>
                          ) : (
                            <span style={{ fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                              {t('deck.statusBuilding')}
                            </span>
                          )}
                        </td>
                        <td data-label={t('admin.colActions')} style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                          <div className="deck-overview-actions" style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                            {deck.inventory_type === 'collection' && (deck.checked_out ? (
                              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: 'inherit', color: '#eab308' }} onClick={() => handleReturn(deck)} disabled={checkingOut}>
                                {t('deck.return')}
                              </button>
                            ) : (
                              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: 'inherit' }} onClick={() => handleCheckout(deck)} disabled={checkingOut}>
                                {t('deck.checkout')}
                              </button>
                            ))}
                            <button className="btn btn-primary" style={{ padding: '0.25rem 0.6rem', fontSize: 'inherit' }} onClick={() => loadDeckDetails(deck.id)}>
                              {t('deck.open')}
                            </button>
                            <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.25rem' }} onClick={() => handleDuplicateDeck(deck.id)} aria-label={t('deck.duplicateDeck')} title={t('deck.duplicateDeck')}>
                              <Copy size={12} />
                            </button>
                            <button className="btn btn-danger btn-icon-only" style={{ padding: '0.25rem' }} onClick={() => handleDeleteDeck(deck.id, deck.name)} aria-label={t('deck.deleteDeck')} title={t('deck.deleteDeck')}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        </div>
      )}


      {/* 2. DECK EDITOR / DETAIL VIEW */}
      {viewMode === 'detail' && activeDeck && !showAiBuilder && (
        <div className="deck-editor" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
          {/* Header */}
          {deckDraft && (
            <Modal onClose={() => { if (!refreshingInventory) setDeckDraft(null); }} aria-labelledby="deck-properties-title">
              <div className="glass-panel deck-properties-panel">
                <fieldset disabled={refreshingInventory} style={{ display: 'contents' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 id="deck-properties-title" style={{ margin: 0 }}>{t('deck.editProperties')}</h3>
                  <button className="btn btn-secondary btn-icon-only" aria-label={t('common.close')} onClick={() => setDeckDraft(null)}><X size={15} /></button>
                </div>
                <label className="form-group" style={{ margin: 0 }}>
                  {t('deck.deckName')}
                  <input className="input-control" value={deckDraft.name} onChange={(event) => setDeckDraft({ ...deckDraft, name: event.target.value })} />
                </label>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.inventoryType')}</label>
                  <div className="sub-nav-tabs" style={{ margin: 0 }}>
                    <button type="button" className={`sub-nav-tab ${deckDraft.inventory_type === 'collection' ? 'active' : ''}`} onClick={() => setDeckDraft({ ...deckDraft, inventory_type: 'collection' })}>{t('deck.physical')}</button>
                    <button type="button" className={`sub-nav-tab ${deckDraft.inventory_type === 'arena' ? 'active' : ''}`} onClick={() => setDeckDraft({ ...deckDraft, inventory_type: 'arena' })}>{t('deck.arena')}</button>
                    <button type="button" className={`sub-nav-tab ${deckDraft.inventory_type === 'graveyard' ? 'active' : ''}`} disabled={!!activeDeck.checked_out} aria-describedby={activeDeck.checked_out ? 'deck-inventory-hint' : undefined} onClick={() => setDeckDraft({ ...deckDraft, inventory_type: 'graveyard' })}>{t('collection.graveyard')}</button>
                  </div>
                  {!!activeDeck.checked_out && <p id="deck-inventory-hint" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{t('deck.returnBeforeEditing')}</p>}
                </div>
                <div className="deck-format-fields">
                  <label className="form-group" style={{ margin: 0 }}>
                    {t('deck.format')}
                    <select className="input-control" value={deckDraft.format} onChange={(event) => setDeckDraft({ ...deckDraft, format: event.target.value })}>
                      {MTG_FORMATS.map(format => <option key={format} value={format}>{format}</option>)}
                    </select>
                  </label>
                  <label className="form-group" style={{ margin: 0 }}>
                    {t('deck.targetSize')}
                    <input type="number" min="1" max="300" className="input-control" value={deckDraft.target_size} onChange={(event) => setDeckDraft({ ...deckDraft, target_size: event.target.value })} />
                  </label>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.75rem', alignItems: 'end' }}>
                  <label className="form-group" style={{ margin: 0 }}>
                    {t('deck.category')}
                    <select className="input-control" value={deckDraft.category} onChange={(event) => setDeckDraft({ ...deckDraft, category: event.target.value })}>
                      {DECK_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </label>
                  <label className="form-group" style={{ margin: 0 }}>
                    {t('deck.accentColor')}
                    <input type="color" value={deckDraft.accent_color} onChange={(event) => setDeckDraft({ ...deckDraft, accent_color: event.target.value })} style={{ display: 'block', width: '42px', height: '38px', padding: 0, border: 0, background: 'none' }} />
                  </label>
                </div>
                <label className="form-group" style={{ margin: 0 }}>
                  {t('deck.descriptionOptional')}
                  <textarea className="input-control" style={{ minHeight: '80px', resize: 'vertical' }} value={deckDraft.description} onChange={(event) => setDeckDraft({ ...deckDraft, description: event.target.value })} />
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                  <button className="btn btn-secondary" onClick={() => setDeckDraft(null)}>{t('common.cancel')}</button>
                  <button className="btn btn-primary" disabled={!deckDraft.name.trim() || !Number.isInteger(Number(deckDraft.target_size)) || Number(deckDraft.target_size) < 1 || Number(deckDraft.target_size) > 300 || editorBusy} onClick={handleApplyDeckProperties}>{t('deck.applyProperties')}</button>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>{t('deck.saveDraftHint')}</p>
                </fieldset>
              </div>
            </Modal>
          )}

          <div className="glass-panel deck-editor-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', position: 'relative', overflow: 'hidden' }}>
            
            {/* Checked out banner */}
            {activeDeck.checked_out ? (
              <div style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                height: '4px',
                background: 'linear-gradient(90deg, #eab308, #f59e0b, #eab308)',
                backgroundSize: '200% auto',
                animation: 'shimmer-gold 2s linear infinite'
              }} />
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <button className="btn btn-secondary btn-icon-only" onClick={leaveDeck} aria-label={t('deck.backToDecks')} style={{ borderRadius: '50%' }}>
                <ChevronLeft size={16} />
              </button>
              <div>
                <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {activeDeck.name}
                  {activeDeck.inventory_type === 'graveyard' && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('collection.graveyard')}</span>}
                  <span style={{ fontSize: '0.8rem', color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--accent-green)' : 'var(--accent-yellow)', fontWeight: 600 }}>
                    ({totalDeckCardsCount}/{targetDeckCardsCount} cards)
                  </span>
                  {hasUnsavedChanges && <span role="status" style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>{t('deck.unsavedChanges')}</span>}
                  {activeDeck.checked_out ? (
                    <span style={{
                      fontSize: '0.65rem',
                      background: 'rgba(234,179,8,0.15)',
                      border: '1px solid rgba(234,179,8,0.4)',
                      color: '#eab308',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}>
                      🎮 {t('deck.inPlay')}
                    </span>
                  ) : null}
                </h2>
                {!!activeDeck.checked_out && activeDeck.checked_out_at && (
                  <p style={{ color: '#eab308', fontSize: '0.7rem', marginTop: '2px' }}>
                    Checked out since {new Date(activeDeck.checked_out_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* Checkout / Return button */}
              {activeDeck.inventory_type === 'collection' && (activeDeck.checked_out ? (
                <button
                  className="btn btn-secondary"
                  onClick={() => handleReturn(activeDeck)}
                  disabled={editorBusy}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
                >
                  <PackageCheck size={14} /> Return to Storage
                </button>
              ) : (
                <button
                  className={`btn ${hasUnsavedChanges ? 'btn-secondary' : 'btn-primary'}`}
                  onClick={() => handleCheckout(activeDeck)}
                  disabled={editorBusy}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <LogOut size={14} /> Check Out for Play
                </button>
              ))}
              <button className="btn btn-primary" disabled={!hasUnsavedChanges || editorBusy || savingRecord || searching || !!deckDraft} onClick={() => handleSaveDeck()}>{t(savingDeck ? 'deck.saving' : 'common.save')}</button>
              {activeDeck.game === 'mtg' && (
                <button className="btn btn-secondary" disabled={editorBusy || savingRecord} onClick={event => {
                  shareTriggerRef.current = event.currentTarget;
                  setShowShareModal(true);
                }}>
                  <Share2 size={14} aria-hidden="true" /> {t('deck.share')}
                </button>
              )}
                <button className="btn btn-secondary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Play size={14} /> Draw Simulator
                </button>
            </div>
            <div className="deck-jump-controls">
              <button type="button" className="btn btn-secondary" onClick={() => cardsHeadingRef.current?.focus()}>
                {t('deck.jumpToCards')} <ArrowRight size={14} aria-hidden="true" />
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => addCardsInputRef.current?.focus()}>
                {t('deck.jumpToAddCards')} <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
            <div className="deck-tools">
              {activeDeck.game === 'mtg' && activeDeck.inventory_type !== 'graveyard' && (
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    if (hasUnsavedChanges) return showToast(t('deck.saveFirst'), 'error');
                    setAiSourceDeck(activeDeck);
                    setShowAiBuilder(true);
                  }}
                  disabled={editorBusy || savingRecord}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <Zap size={14} /> {t('aiDeck.improve')}
                </button>
              )}
              <button
                className="btn btn-secondary"
                disabled={editorBusy || searching}
                onClick={() => setDeckDraft({
                  name: activeDeck.name,
                  description: activeDeck.description || '',
                  format: activeDeck.format || NEW_DECK_DEFAULTS.format,
                  category: activeDeck.category || 'Competitive',
                  accent_color: activeDeck.accent_color || '#eab308',
                  target_size: activeDeck.target_size || NEW_DECK_DEFAULTS.targetSize,
                  inventory_type: activeDeck.inventory_type || 'collection'
                })}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              >
                <SlidersHorizontal size={14} /> {t('deck.editProperties')}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowExportModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title={t('deck.exportHint')}
              >
                <Upload size={14} /> Export
              </button>
              <button
                className="btn btn-secondary"
                disabled={editorBusy}
                onClick={() => setShowImportModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title={t('deck.importHint')}
              >
                <Download size={14} /> Import
              </button>
              {['collection', 'graveyard'].includes(activeDeck.inventory_type) && (
                <div>
                  <button
                    className="btn btn-secondary"
                    disabled={editorBusy || savingRecord || searching || hasUnsavedChanges || !!deckDraft || !activeDeck.cards.length}
                    aria-describedby={hasUnsavedChanges ? 'deck-container-save-first' : undefined}
                    onClick={() => setShowDeckContainerModal(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', minHeight: '44px' }}
                  >
                    <FolderPlus size={14} aria-hidden="true" /> {t('deck.createContainer')}
                  </button>
                  {hasUnsavedChanges && <p id="deck-container-save-first" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0' }}>{t('deck.saveFirst')}</p>}
                </div>
              )}
            </div>
          {saveDeckError && !previewDeckCard && <p role="alert" className="deck-source-error">{saveDeckError} {t('deck.saveRetryHint')}</p>}



          {/* Checked out info banner */}
          {!!activeDeck.checked_out && (
            <div style={{
              background: 'rgba(234,179,8,0.06)',
              border: '1px solid rgba(234,179,8,0.25)',
              borderRadius: 'var(--radius-md)',
              padding: '0.85rem 1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              fontSize: '0.85rem',
              color: '#eab308'
            }}>
              <span style={{ fontSize: '1.25rem' }}>🎮</span>
              <div>
                <strong>{t('deck.checkedOutBanner')}</strong>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {t('deck.checkedOutHint')}
                </div>
              </div>
            </div>
          )}

          <div className={`deck-summary-layout${commanderCard || activeDeck.game === 'mtg' ? ' deck-summary-layout--commander' : ''}`}>
            <div className="deck-summary-content">
            <div className="deck-overview">
              <div className="deck-overview-column">
                <section className="deck-overview-section" aria-labelledby="deck-types-heading">
                  <h3 id="deck-types-heading"><Layers size={18} aria-hidden="true" style={{ color: 'var(--accent-blue)' }} />{t('deck.supertypeBreakdown')}</h3>
                  {supertypeData.length ? (
                    <ul className="deck-distribution">
                      {supertypeData.map(entry => (
                        <li key={entry.name} style={{ '--distribution-color': DECK_DISTRIBUTION_COLORS[entry.name] || 'var(--accent-blue)' }}>
                          <span>{t(CARD_GROUP_LABELS[entry.name])}</span>
                          <strong>{entry.value}</strong>
                          <span className="deck-distribution-track" aria-hidden="true">
                            <span style={{ width: `${entry.value / totalDeckCardsCount * 100}%` }} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : <p>{t('shared.noCards')}</p>}
                </section>
                {activeDeck.inventory_type === 'collection' && (
                  <section className="deck-overview-section" aria-labelledby="deck-containers-heading">
                    <h3 id="deck-containers-heading">
                      <MapPin size={18} aria-hidden="true" style={{ color: 'var(--accent-yellow)' }} />{t('deck.containersNeeded')}
                    </h3>
                    {hasUnsavedChanges ? (
                      <p style={{ color: 'var(--text-secondary)' }}>{t('deck.saveFirst')}</p>
                    ) : deckLocationsError ? (
                      <div role="alert">
                        <p>{t('aiDeck.errContainers')}</p>
                        <button className="btn btn-secondary" disabled={editorBusy} onClick={() => loadDeckDetails(activeDeck.id)}>{t('loc.retry')}</button>
                      </div>
                    ) : (
                      <>
                        {neededContainers.length > 0 ? (
                          <ul className="deck-overview-rows">
                            {neededContainers.map(container => (
                              <li key={container.id ?? 'unassigned'}>
                                <span>{container.id === null ? t('bulk.unassignedPile') : container.name}</span>
                                <strong>{t('admin.userCards', { count: container.quantity })}</strong>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p style={{ color: 'var(--text-secondary)' }}>{t(activeDeck.cards.length ? 'deck.sourcesEmpty' : 'shared.noCards')}</p>
                        )}
                        {unavailableCopies > 0 && <p style={{ marginTop: '0.75rem', color: 'var(--accent-yellow)', fontSize: '0.85rem' }}>{t('deck.unavailableCopies', { count: unavailableCopies })}</p>}
                      </>
                    )}
                  </section>
                )}
                </div>

              <div className="deck-overview-column">
                <section className="deck-overview-section" aria-labelledby="deck-colors-heading">
                  <h3 id="deck-colors-heading"><BarChart2 size={18} aria-hidden="true" style={{ color: 'var(--accent-red)' }} />{t('deck.colorLandDist')}</h3>
                  {colorData.length ? (
                    <ul className="deck-distribution">
                      {colorData.map(entry => (
                        <li key={entry.name} style={{ '--distribution-color': DECK_DISTRIBUTION_COLORS[entry.name] || 'var(--accent-yellow)' }}>
                          <span>{entry.name}</span>
                          <strong>{entry.value}</strong>
                          <span className="deck-distribution-track" aria-hidden="true">
                            <span style={{ width: `${entry.value / totalDeckCardsCount * 100}%` }} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : <p>{t('shared.noCards')}</p>}
                </section>
                <section className="deck-overview-section" aria-labelledby="deck-health-heading">
                  <h3 id="deck-health-heading"><PackageCheck size={18} aria-hidden="true" style={{ color: 'var(--accent-green)' }} />{t('deck.healthTitle')}</h3>
                  <dl className="deck-overview-rows">
                    <div>
                      <dt>{t('deck.targetDeckSize')}</dt>
                      <dd className="deck-overview-capacity" style={{ color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                        {totalDeckCardsCount === targetDeckCardsCount
                          ? <CheckCircle size={16} aria-hidden="true" />
                          : <AlertTriangle size={16} aria-hidden="true" />}
                        {totalDeckCardsCount}/{targetDeckCardsCount}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('deck.uniqueCards')}</dt>
                      <dd>{t('deck.titlesCount', { count: activeDeck.cards.length })}</dd>
                    </div>
                    {deckGame === 'mtg' && (
                      <div>
                        <dt>{t('deck.basicLands')}</dt>
                        <dd>{t('deck.basicLandsCount', { count: activeDeck.cards.filter(c => isBasicLand(c, deckGame)).reduce((s, c) => s + c.quantity, 0) })}</dd>
                      </div>
                    )}
                  </dl>
                {activeDeck.game === 'mtg' && (
                  <div className="deck-overview-record">
                    {['win', 'loss'].map(result => {
                      const count = activeDeck[result === 'win' ? 'wins' : 'losses'] ?? 0;
                      return (
                        <div key={result} role="group" aria-label={t(result === 'win' ? 'deck.wins' : 'deck.losses')} aria-busy={savingRecord}>
                          <span aria-live="polite" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {t(result === 'win' ? 'deck.wins' : 'deck.losses')}: <strong>{count}</strong>
                          </span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-icon-only"
                            aria-label={t(result === 'win' ? 'deck.removeWin' : 'deck.removeLoss')}
                            disabled={savingRecord || savingDeck || count === 0}
                            onClick={() => handleRecordChange(result, -1)}
                          >
                            <Minus size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-icon-only"
                            aria-label={t(result === 'win' ? 'deck.addWin' : 'deck.addLoss')}
                            disabled={savingRecord || savingDeck || count === 2147483647}
                            onClick={() => handleRecordChange(result, 1)}
                          >
                            <Plus size={14} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                  <div className="deck-sleeved-field" aria-busy={savingSleeved}>
                    <label htmlFor="deck-sleeved">{t('deck.sleeved')}</label>
                    <select
                      id="deck-sleeved"
                      className="input-control"
                      value={activeDeck.sleeved ?? 0}
                      disabled={editorBusy}
                      aria-describedby={sleevedError ? 'deck-sleeved-error' : undefined}
                      onChange={event => handleSleevedChange(Number(event.target.value))}
                    >
                      <option value={0}>{t('deck.sleevedNone')}</option>
                      <option value={1}>{t('deck.sleevedOne')}</option>
                      <option value={2}>{t('deck.sleevedDouble')}</option>
                      <option value={3}>{t('deck.sleevedTriple')}</option>
                    </select>
                    {savingSleeved && <p role="status">{t('deck.saving')}</p>}
                    {sleevedError && <p id="deck-sleeved-error" className="deck-source-error" role="alert">{t('deck.errSleeved')}</p>}
                  </div>
                </section>
              </div>
            </div>
          <section className="glass-panel" aria-labelledby="deck-description-heading">
            <h3 id="deck-description-heading" style={{ marginBottom: '0.75rem' }}>{t('deck.description')}</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {activeDeck.description || '—'}
            </p>
          </section>
          <section className="glass-panel" aria-labelledby="deck-notes-heading">
            <h3 id="deck-notes-heading" style={{ marginBottom: '0.75rem' }}>
              <label htmlFor="deck-notes">{t('nav.notes')}</label>
            </h3>
            <textarea
              id="deck-notes"
              className="input-control"
              rows={6}
              style={{ display: 'block', width: '100%', fontSize: '16px', resize: 'vertical' }}
              value={activeDeck.notes || ''}
              disabled={editorBusy || !!deckDraft}
              onChange={(event) => setActiveDeck(deck => ({ ...deck, notes: event.target.value }))}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button className="btn btn-secondary" disabled={!hasUnsavedChanges || editorBusy || savingRecord || searching || !!deckDraft} onClick={() => handleSaveDeck()}>{t(savingDeck ? 'deck.saving' : 'common.save')}</button>
            </div>
          </section>
            </div>
              <div className="deck-card-previews">
                {commanderCard && (
                  <button
                    type="button"
                    onClick={() => setPreviewCard(commanderCard)}
                    aria-label={`${t('deck.commander')}: ${displayName(commanderCard)}`}
                    title={`${t('deck.commander')}: ${displayName(commanderCard)}`}
                    style={{ padding: 0, width: '100%', maxWidth: '350px', justifySelf: 'center', border: '1px solid var(--accent-yellow)', borderRadius: '8px', background: 'transparent', cursor: 'pointer' }}
                  >
                    <CardImage card={commanderCard} style={{ display: 'block', width: '100%', aspectRatio: '0.718', objectFit: 'contain', borderRadius: '7px' }} />
                  </button>
                )}
                {/commander|edh|brawl/i.test(activeDeck.format || '') && (
                  <div className="deck-commander-field">
                    <label htmlFor="deck-commander">{t('deck.commander')}</label>
                    <select id="deck-commander" className="input-control" value={activeDeck.commander_card_id || ''} disabled={editorBusy} onChange={e => handleCommanderChange(e.target.value)}>
                      <option value="">{t('deck.noCommander')}</option>
                      {commanderChoices.map(card => (
                        <option key={card.id} value={card.id}>
                          {displayName(card)}{card.set_name ? ` · ${card.set_name}` : ''}{card.number ? ` #${card.number}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {activeDeck.game === 'mtg' && <DeckCardBack
                  key={activeDeck.id}
                  deck={activeDeck}
                  disabled={editorBusy}
                  onBusy={setSavingCardBack}
                  onSaved={(deckId, back) => {
                    setActiveDeck(deck => deck?.id === deckId ? { ...deck, ...back } : deck);
                    setDecks(current => current.map(deck => deck.id === deckId ? { ...deck, ...back } : deck));
                  }}
                />}
              </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1.5rem', alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
              
              {/* Deck Card List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
                
                {/* Search & Quick Add to Deck */}
                <div className="glass-panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.addCardsTitle')}</h3>
                  </div>
                  <form onSubmit={handleSearchCards} className="deck-search-form">
                    <input
                      ref={addCardsInputRef}
                      type="text"
                      aria-label={t('deck.searchPlaceholder')}
                      className="input-control"
                      placeholder={t('deck.searchPlaceholder')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 1rem' }} title={t('shared.search')}>
                      <Search size={16} />
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={(e) => handleSearchCards(e, true)} style={{ padding: '0.5rem 0.9rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }} title={t('deck.browseHint')}>
                      {t('deck.browseCollection')}
                    </button>
                  </form>
                  {browseEntries.length > 0 && (
                    <>
                      <button type="button" className={`btn ${showBrowseFilters ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowBrowseFilters(show => !show)} aria-expanded={showBrowseFilters} aria-controls="deck-browse-filters" style={{ marginTop: '0.75rem' }}>
                        <SlidersHorizontal size={16} /> {t('collection.filters')}{Object.values(browseFilters).filter(Boolean).length > 0 && ` (${Object.values(browseFilters).filter(Boolean).length})`}
                      </button>
                      {showBrowseFilters && (
                        <div id="deck-browse-filters" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: '0.5rem', marginTop: '0.75rem' }}>
                          {browseFilterOptions.map(([key, label, options]) => (
                            <select key={key} className="select-control" aria-label={t(label)} value={browseFilters[key] || ''} onChange={e => setBrowseFilters(filters => ({ ...filters, [key]: e.target.value }))} style={{ minWidth: 0 }}>
                              <option value="">{t(label)}</option>
                              {options.map(option => <option key={option} value={option}>{key === 'color' ? t(`dash.color.${option}`) : option}</option>)}
                            </select>
                          ))}
                          <select className="select-control" aria-label={t('loc.allDeckStatuses')} value={browseFilters.deckStatus || ''} onChange={e => setBrowseFilters(filters => ({ ...filters, deckStatus: e.target.value }))} style={{ minWidth: 0 }}>
                            <option value="">{t('loc.allDeckStatuses')}</option>
                            <option value="inPlay">{t('loc.inPlay')}</option>
                            <option value="notInPlay">{t('loc.notInPlay')}</option>
                          </select>
                          <button type="button" className="btn btn-secondary" onClick={() => { setBrowseFilters({}); setSearchQuery(''); handleSearchCards(null, true, ''); }}>{t('collection.clearFilters')}</button>
                        </div>
                      )}
                    </>
                  )}

                  {/* Search results grid */}
                  {searching ? (
                    <div className="spinner" style={{ margin: '1rem auto' }}></div>
                  ) : searchResults.length > 0 && filteredSearchResults.length === 0 ? (
                    <p role="status" style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>{t('collection.noMatches')} {t('collection.noMatchesFiltered')}</p>
                  ) : filteredSearchResults.length > 0 && (
                    <div className="card-grid" style={{ marginTop: '1rem', maxHeight: '65vh', overflowY: 'auto', background: 'var(--surface-1)', padding: '0.5rem', borderRadius: 'var(--radius-sm)' }}>
                      {filteredSearchResults.map(card => {
                          const existingInDeck = activeDeck?.cards.find(c => c.id === card.id);
                          const qtyInDeck = existingInDeck ? existingInDeck.quantity : 0;
                          const ownedQty = card.owned_qty || 0;
                          const isAtMaxOwned = qtyInDeck >= ownedQty;
                          const isAtRuleMax = !isBasicLand(card, deckGame) && deckCountByName(activeDeck?.cards, card.name) >= 4;
                          const disabledAdd = editorBusy || isAtMaxOwned || isAtRuleMax;

                          return (
                            <div key={card.id} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, padding: '0.5rem', background: 'var(--surface-1)', borderRadius: '4px', border: '1px solid var(--border-glass)', gap: '0.5rem' }}>
                              <button type="button" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', cursor: 'pointer', minWidth: 0, padding: 0, border: 0, background: 'transparent', textAlign: 'left' }} onClick={() => setPreviewCard(card)} aria-label={`${t('deck.previewArt')}: ${displayName(card)}`}>
                                <CardImage card={card} loading="lazy" style={{ width: '100%', aspectRatio: '5 / 7', objectFit: 'contain', borderRadius: '4px' }} />
                                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, width: '100%' }}>
                                  <span style={{ fontSize: '0.8rem', color: 'var(--text-strong)', overflowWrap: 'anywhere' }}>{displayName(card)} ({card.set_name} • #{card.number})</span>
                                  <span style={{ fontSize: '0.65rem', color: isAtMaxOwned ? 'var(--accent-red)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Owned: {ownedQty} | In Deck: {qtyInDeck}</span>
                                </div>
                              </button>
                              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.35rem', marginTop: 'auto' }}>
                                <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => setPreviewCard(card)} title={t('deck.previewArt')}>
                                  <Eye size={12} />
                                </button>
                                <button className="btn btn-primary btn-icon-only" style={{ padding: '0.2rem' }} disabled={disabledAdd} onClick={() => handleAddCardToDeck(card)} title={isAtRuleMax ? "4-copy limit reached" : isAtMaxOwned ? "Not enough owned copies" : "Add to deck"}>
                                  <Plus size={12} />
                                </button>
                              </div>
                            </div>
                          );
                      })}
                    </div>
                  )}
                </div>

                {/* Deck Cards Header & Display Mode Toggle */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <h3 ref={cardsHeadingRef} tabIndex={-1} className="deck-cards-heading" style={{ fontSize: '1rem', color: 'var(--text-strong)', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', margin: 0 }}>
                      Deck Cards ({totalDeckCardsCount} / {targetDeckCardsCount})
                    </h3>
                    <div className="deck-display-controls">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                      <button
                        type="button"
                        className={`btn ${cardDisplayMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setCardDisplayMode('list')}
                        aria-pressed={cardDisplayMode === 'list'}
                      >
                        <List size={12} /> List
                      </button>
                      <button
                        type="button"
                        className={`btn ${cardDisplayMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setCardDisplayMode('grid')}
                        aria-pressed={cardDisplayMode === 'grid'}
                      >
                        <LayoutGrid size={12} /> Grid
                      </button>
                    </div>
                      <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                        <button
                          type="button"
                          className="btn btn-icon-only btn-secondary"
                          disabled={deckCardScale <= 0.6}
                          onClick={() => setDeckCardScale(scale => Math.max(0.6, +(scale - 0.2).toFixed(1)))}
                          aria-label={t('loc.decreaseCardScale')}
                          title={t('loc.decreaseCardScale')}
                          style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Minus size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon-only btn-secondary"
                          disabled={deckCardScale >= 2.5}
                          onClick={() => setDeckCardScale(scale => Math.min(2.5, +(scale + 0.2).toFixed(1)))}
                          aria-label={t('loc.increaseCardScale')}
                          title={t('loc.increaseCardScale')}
                          style={{ borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.35rem', width: '28px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                    <select
                      className="select-control"
                      value={deckCardSortBy}
                      onChange={(e) => setDeckCardSortBy(e.target.value)}
                      aria-label={t('collection.sortBy')}
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', height: 'auto' }}
                    >
                      <option value="type">{t('deck.sortByType')}</option>
                      <option value="color">{t('collection.fColor')}</option>
                      {activeDeck.inventory_type === 'collection' && <option value="location">{t('collection.fLocation')}</option>}
                      {activeDeck.inventory_type === 'collection' && <option value="pulled">{t('deck.pulledStatus')}</option>}
                    </select>
                    </div>
                  </div>
                  
                  {activeDeck.cards.length === 0 ? (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>{t('deck.emptyDeck')}</p>
                  ) : (
                    deckCardGroups.map(({ name: supertype, cards: list }) => {
                      if (list.length === 0) return null;
                      const sum = list.reduce((total, c) => total + c.quantity, 0);

                      return (
                        <div key={supertype} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <h4 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.25rem', display: 'flex', justifyContent: 'space-between' }}>
                            <span>{deckCardSortBy === 'type' ? t(CARD_GROUP_LABELS[supertype]) : supertype}</span>
                            <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{sum}</span>
                          </h4>

                          {/* 1. COMPACT LIST VIEW */}
                          {cardDisplayMode === 'list' && (
                            <div className="deck-card-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', zoom: deckCardScale, '--deck-card-scale': deckCardScale }}>
                              {list.map(card => (
                                <div key={card.id} className="deck-card-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', background: card.quantity > (card.owned_qty || 0) - (card.locked_qty || 0) ? 'rgba(127,29,29,0.16)' : 'rgba(255,255,255,0.01)', borderRadius: 'var(--radius-sm)', border: card.quantity > (card.owned_qty || 0) - (card.locked_qty || 0) ? '1px solid var(--accent-red)' : '1px solid var(--border-glass)', gap: '0.6rem' }}>
                                  <button type="button" aria-label={`${t('deck.previewArt')}: ${displayName(card)}`} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', minWidth: 0, flex: '1 1 14rem', padding: 0, border: 0, background: 'transparent', textAlign: 'left' }} onClick={() => setPreviewCard(card)}>
                                    <CardImage card={card} src={card.image_url?.replace(/^(https:\/\/cards\.scryfall\.io)\/normal\//, '$1/small/')} loading="lazy" style={{ width: 56 * deckListImageScale, height: 78 * deckListImageScale, objectFit: 'cover', borderRadius: '2px', flexShrink: 0 }} />
                                    <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                                      {activeDeck.commander_card_id === card.id && <div className="deck-commander-tag" style={{ backgroundColor: 'var(--accent-yellow)', color: 'var(--bg-primary)', padding: '2px 6px', fontSize: '0.7rem', fontWeight: 800 }}>{t('deck.commander')}</div>}
                                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(card)}</div>
                                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.set_name} • #{card.number}</div>
                                      {deckCardLocations[card.id]?.length > 0 && (
                                        <div title={formatCardLocations(deckCardLocations[card.id])} style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '0.68rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          <MapPin size={11} /> {formatCardLocations(deckCardLocations[card.id])}
                                        </div>
                                      )}
                                    </div>
                                  </button>

                                  <div className="deck-card-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                                    {card.quantity > (card.owned_qty || 0) - (card.locked_qty || 0) && (
                                      <span style={{ color: 'var(--accent-red)', fontSize: '0.7rem', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: '3px', whiteSpace: 'nowrap' }} title={card.locked_decks || t('deck.unavailableCopies', { count: card.quantity - ((card.owned_qty || 0) - (card.locked_qty || 0)) })}>
                                        <AlertTriangle size={13} /> {card.locked_decks ? t('deck.unavailableCopiesInDecks', { count: card.quantity - ((card.owned_qty || 0) - (card.locked_qty || 0)), decks: card.locked_decks }) : t('deck.unavailableCopies', { count: card.quantity - ((card.owned_qty || 0) - (card.locked_qty || 0)) })}
                                      </span>
                                    )}
                                    {activeDeck.inventory_type === 'collection' && (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer', color: card.checked_out ? 'var(--accent-green)' : 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: 600 }}>
                                      <input type="checkbox" role="switch" className="deck-card-toggle" checked={!!card.checked_out} disabled={editorBusy} onChange={(e) => handlePulledChange(card.id, e.target.checked)} />
                                      {t('deck.pulled')}
                                    </label>
                                    )}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
                                      <button
                                        className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`}
                                        style={{ width: '22px', height: '22px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                        disabled={editorBusy}
                                        onClick={() => handleUpdateCardQty(card.id, card.quantity - 1)}
                                        aria-label={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}
                                        title={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}
                                      >
                                        {card.quantity === 1 ? <Trash2 size={11} /> : '-'}
                                      </button>
                                      <span style={{ padding: '0 0.4rem', fontSize: '0.85rem', fontWeight: 700, minWidth: '18px', textAlign: 'center', color: 'var(--text-strong)' }}>{card.quantity}</span>
                                      <button
                                        className="btn btn-secondary btn-icon-only"
                                        style={{ width: '22px', height: '22px', padding: 0 }}
                                        disabled={editorBusy || card.quantity >= (card.owned_qty || 0) || (!isBasicLand(card, deckGame) && deckCountByName(activeDeck.cards, card.name) >= 4)}
                                        onClick={() => handleUpdateCardQty(card.id, card.quantity + 1)}
                                        aria-label={t('deck.increaseQty')}
                                      >
                                        +
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* 2. VISUAL CARD GRID VIEW */}
                          {cardDisplayMode === 'grid' && (
                            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${110 * deckCardScale}px), 1fr))`, gap: '0.75rem' }}>
                              {list.map(card => (
                                <div key={card.id} style={{ position: 'relative', borderRadius: '6px', overflow: 'hidden', border: card.quantity > (card.owned_qty || 0) - (card.locked_qty || 0) ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)', background: card.quantity > (card.owned_qty || 0) - (card.locked_qty || 0) ? 'rgba(127,29,29,0.16)' : 'rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', transition: 'transform 0.15s' }}>
                                  <button type="button" aria-label={`${t('deck.previewArt')}: ${displayName(card)}`} style={{ position: 'relative', width: '100%', aspectRatio: 0.718, cursor: 'pointer', padding: 0, border: 0, background: 'transparent' }} onClick={() => setPreviewCard(card)}>
                                    <CardImage card={card} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                    {activeDeck.commander_card_id === card.id && <div className="deck-commander-tag" style={{ position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center', backgroundColor: 'var(--accent-yellow)', color: 'var(--bg-primary)', padding: '4px', fontSize: '0.75rem', fontWeight: 800 }}>{t('deck.commander')}</div>}
                                    <span style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.85)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', border: '1px solid var(--accent-yellow)' }}>
                                      x{card.quantity}
                                    </span>
                                    {card.quantity > (card.owned_qty || 0) - (card.locked_qty || 0) && (
                                      <span style={{ position: 'absolute', top: '4px', left: '4px', background: 'rgba(127,29,29,0.92)', color: '#fff', fontSize: '0.65rem', fontWeight: 800, padding: '2px 5px', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', gap: '2px' }} title={card.locked_decks || t('deck.unavailableCopies', { count: card.quantity - ((card.owned_qty || 0) - (card.locked_qty || 0)) })}>
                                        <AlertTriangle size={10} /> {card.quantity - ((card.owned_qty || 0) - (card.locked_qty || 0))}
                                      </span>
                                    )}
                                  </button>
                                  {deckCardLocations[card.id]?.length > 0 && (
                                    <div title={formatCardLocations(deckCardLocations[card.id])} style={{ display: 'flex', alignItems: 'center', gap: '3px', padding: '4px 5px 0', fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                      <MapPin size={10} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatCardLocations(deckCardLocations[card.id])}</span>
                                    </div>
                                  )}
                                  <div style={{ padding: '4px', display: 'flex', flexWrap: 'wrap', gap: '0.35rem', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
                                    {activeDeck.inventory_type === 'collection' && (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', color: card.checked_out ? 'var(--accent-green)' : 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: 600 }}>
                                      <input type="checkbox" role="switch" className="deck-card-toggle" checked={!!card.checked_out} disabled={editorBusy} onChange={(e) => handlePulledChange(card.id, e.target.checked)} />
                                      {t('deck.pulled')}
                                    </label>
                                    )}
                                    <div style={{ display: 'flex', gap: '2px' }}>
                                      <button aria-label={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')} className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`} style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} disabled={editorBusy} onClick={() => handleUpdateCardQty(card.id, card.quantity - 1)} title={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}>
                                        {card.quantity === 1 ? <Trash2 size={10} /> : '-'}
                                      </button>
                                      <button aria-label={t('deck.increaseQty')} className="btn btn-secondary btn-icon-only" style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0 }} disabled={editorBusy || card.quantity >= (card.owned_qty || 0) || (!isBasicLand(card, deckGame) && deckCountByName(activeDeck.cards, card.name) >= 4)} onClick={() => handleUpdateCardQty(card.id, card.quantity + 1)}>+</button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                        </div>
                      );
                    })
                  )}
                </div>
                <RelatedTokens cardIds={activeDeck.cards.map(card => card.id)} title={t('tokens.title')} inventoryType={activeDeck.inventory_type} commanderCardId={activeDeck.commander_card_id} />
              </div>

              {/* Mana Curve */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
                

                {/* Bar Chart: Mana Cost Curve */}
                {manaCurveData.some(d => d.count > 0) && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: 'var(--accent-blue)' }} /> Mana Cost Curve
                    </h3>
                    <div style={{ width: '100%', height: '180px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={manaCurveData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                          <XAxis dataKey="cost" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' }} />
                          <Bar dataKey="count" fill="var(--accent-blue)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

              </div>

            </div>
          </div>
        </div>
      )}

      {/* --- POPUPS & MODALS --- */}

      {showDeckContainerModal && activeDeck && (
        <DeckContainerModal
          deck={activeDeck}
          onClose={() => setShowDeckContainerModal(false)}
          onCreated={async () => {
            const refreshed = await loadDeckDetails(activeDeck.id);
            await fetchDecks();
            return refreshed;
          }}
        />
      )}

      {/* A. Create Deck Modal */}
      {showCreateModal && (
        <Modal onClose={() => { if (!creatingDeck) closeCreateModal(); }} aria-labelledby="deck-create-title">
          <div className="glass-panel deck-create-panel">
            <button className="btn btn-secondary btn-icon-only" disabled={creatingDeck} aria-label={t('common.close')} onClick={closeCreateModal} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <h3 id="deck-create-title" style={{ fontSize: '1.25rem', color: 'var(--text-strong)', fontWeight: 800, marginBottom: '0.25rem', paddingRight: '2.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FolderPlus size={20} style={{ color: 'var(--accent-yellow)' }} />
              {t('deck.createTitle')}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              {t('deck.createSubtitle')}
            </p>

            <form onSubmit={handleCreateDeck} className="deck-create-form">
              <fieldset disabled={creatingDeck} style={{ display: 'contents' }}>
              <div className="deck-create-body">
              
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.inventoryType')}</label>
                <div className="sub-nav-tabs" style={{ margin: 0 }}>
                  <button type="button" className={`sub-nav-tab ${newDeckInventoryType === 'collection' ? 'active' : ''}`} onClick={() => setNewDeckInventoryType('collection')}>{t('deck.physical')}</button>
                  <button type="button" className={`sub-nav-tab ${newDeckInventoryType === 'arena' ? 'active' : ''}`} onClick={() => setNewDeckInventoryType('arena')}>{t('deck.arena')}</button>
                  <button type="button" className={`sub-nav-tab ${newDeckInventoryType === 'graveyard' ? 'active' : ''}`} onClick={() => setNewDeckInventoryType('graveyard')}>{t('collection.graveyard')}</button>
                </div>
                {newDeckInventoryType === 'graveyard' && <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{t('deck.graveyardCreateHint')}</p>}
              </div>
              {/* Format & Target Size Row */}
              <div className="deck-format-fields">
                <div className="form-group">
                  <label htmlFor="new-deck-format" style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.format')}</label>
                  <select
                    id="new-deck-format"
                    className="input-control"
                    value={newDeckFormat}
                    onChange={(e) => {
                      const selectedFmt = e.target.value;
                      setNewDeckFormat(selectedFmt);
                      if (selectedFmt.includes('Commander')) setNewDeckTargetSize(100);
                      else if (selectedFmt.includes('Standard') || selectedFmt.includes('Modern') || selectedFmt.includes('Pioneer')) setNewDeckTargetSize(60);
                    }}
                    style={{ fontSize: '0.85rem' }}
                  >
                    {MTG_FORMATS.map(fmt => (
                      <option key={fmt} value={fmt} style={{ background: '#1e293b', color: '#fff' }}>{fmt}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="new-deck-size" style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.targetSize')}</label>
                  <input
                    id="new-deck-size"
                    type="number"
                    min="1"
                    max="300"
                    className="input-control"
                    value={newDeckTargetSize}
                    onChange={(e) => setNewDeckTargetSize(parseInt(e.target.value, 10) || 60)}
                    style={{ fontSize: '0.85rem' }}
                  />
                </div>
              </div>

              {/* Deck Name */}
              <div className="form-group">
                <label htmlFor="new-deck-name" style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.deckName')}</label>
                <input 
                  id="new-deck-name"
                  type="text" 
                  className="input-control" 
                  placeholder={t('deck.namePlaceholder')} 
                  value={newDeckName} 
                  onChange={(e) => setNewDeckName(e.target.value)}
                  required 
                  pattern=".*\S.*"
                />
              </div>

              {/* Category Pills */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.category')}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {DECK_CATEGORIES.map(cat => {
                    const isSelected = newDeckCategory === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setNewDeckCategory(cat)}
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.3rem 0.65rem',
                          borderRadius: '12px',
                          border: isSelected ? '1px solid var(--accent-yellow)' : '1px solid var(--border-glass)',
                          background: isSelected ? 'rgba(234, 179, 8, 0.2)' : 'rgba(0,0,0,0.2)',
                          color: isSelected ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                          cursor: 'pointer',
                          transition: 'all 0.15s'
                        }}
                      >
                        {cat}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Deck Accent Color */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.accentColor')}</label>
                <div style={{ display: 'flex', itemsAlign: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {DECK_ACCENT_COLORS.map(c => {
                    const isSelected = newDeckAccentColor === c.hex;
                    return (
                      <button
                        type="button"
                        key={c.hex}
                        aria-label={c.name}
                        aria-pressed={isSelected}
                        onClick={() => setNewDeckAccentColor(c.hex)}
                        title={c.name}
                        style={{
                          width: '36px',
                          height: '36px',
                          borderRadius: '50%',
                          backgroundColor: c.hex,
                          cursor: 'pointer',
                          border: isSelected ? '2px solid #ffffff' : '2px solid transparent',
                          boxShadow: isSelected ? `0 0 10px ${c.hex}` : 'none',
                          transform: isSelected ? 'scale(1.15)' : 'scale(1)',
                          transition: 'transform 0.15s'
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Description (Optional) */}
              <div className="form-group">
                <label htmlFor="new-deck-description" style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.descriptionOptional')}</label>
                <textarea
                  id="new-deck-description"
                  className="input-control"
                  style={{ minHeight: '65px', resize: 'vertical', fontSize: '0.85rem' }}
                  placeholder={t('deck.notesPlaceholder')}
                  value={newDeckDesc}
                  onChange={(e) => setNewDeckDesc(e.target.value)}
                />
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => setShowPreconPicker(!showPreconPicker)}
                  className="btn btn-secondary"
                  aria-expanded={showPreconPicker}
                  style={{ width: '100%', minHeight: '48px', justifyContent: 'flex-start', fontSize: '1rem', borderColor: 'var(--accent-yellow)', color: 'var(--accent-yellow)' }}
                >
                  <FileText size={20} style={{ flexShrink: 0 }} />
                  {t('mtgDeck.title')}
                </button>
                {showPreconPicker && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <MtgDeckImport
                      showToast={showToast}
                      onChoose={(deck) => {
                        setNewDeckPreconFile(deck.fileName);
                        setNewDeckName(deck.name);
                        const preset = preconFormat(deck.type);
                        setNewDeckFormat(preset.format);
                        setNewDeckTargetSize(preset.targetSize);
                        setNewDeckImportText('');
                        setShowImportDecklistArea(false);
                        setShowPreconPicker(false);
                      }}
                    />
                  </div>
                )}
                {newDeckPreconFile && <p role="status" style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{t('mtgDeck.selectedHint')}</p>}
              </div>

              {/* Quick Decklist Importer Toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowImportDecklistArea(!showImportDecklistArea)}
                  className="btn btn-secondary"
                  aria-expanded={showImportDecklistArea}
                  style={{ width: '100%', minHeight: '48px', justifyContent: 'flex-start', fontSize: '1rem', borderColor: 'var(--accent-yellow)', color: 'var(--accent-yellow)' }}
                >
                  <FileText size={20} style={{ flexShrink: 0 }} />
                  {showImportDecklistArea ? t('deck.hideQuickImport') : t('deck.showQuickImport')}
                </button>

                {showImportDecklistArea && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <select
                        aria-label={t('deck.format')}
                        className="select-control"
                        value={newDeckImportFormat}
                        onChange={(e) => {
                          const format = e.target.value;
                          setNewDeckImportFormat(format);
                          setNewDeckPreconFile('');
                          if (format === 'manabox') {
                            setNewDeckFormat('Commander / EDH');
                            setNewDeckTargetSize(100);
                          }
                        }}
                        style={{ flex: '1 1 220px', minWidth: 0, minHeight: '48px', fontSize: '1rem', padding: '0.75rem' }}
                      >
                        <option value="plain">{t('deck.importFormatPlain')}</option>
                        <option value="manabox">{t('deck.importFormatManaBox')}</option>
                      </select>
                      {newDeckImportFormat === 'manabox' && (
                        <label className="btn btn-secondary" style={{ margin: 0, padding: '0.3rem 0.5rem', fontSize: '0.75rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                          <Upload size={13} /> {t('deck.chooseManaBoxFile')}
                          <input type="file" accept=".txt,text/plain" onChange={handleManaBoxDeckFile} style={{ display: 'none' }} />
                        </label>
                      )}
                    </div>
                    <textarea
                      aria-label={t('deck.showQuickImport')}
                      className="input-control"
                      style={{ width: '100%', boxSizing: 'border-box', minHeight: '90px', resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre' }}
                      placeholder={t('deck.pasteDecklistPlaceholder')}
                      value={newDeckImportText}
                      onChange={(e) => {
                        setNewDeckImportText(e.target.value);
                        setNewDeckPreconFile('');
                      }}
                    />
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.2rem' }}>
                      {t('deck.importOnCreateHint')}
                    </span>
                  </div>
                )}
              </div>

              </div>
              {createDeckError && <p role="alert" className="deck-source-error" style={{ margin: '0.75rem 0' }}>{createDeckError}</p>}
              <div className="deck-create-footer">
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={closeCreateModal}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2, fontWeight: 700 }}>{t(creatingDeck ? 'deck.saving' : 'deck.createDeck')}</button>
              </div>
              </fieldset>
            </form>
          </div>
        </Modal>
      )}

      {/* B. Draw Hand Simulator Modal */}
      {showSimulator && (
        <Modal onClose={() => setShowSimulator(false)} aria-labelledby="deck-simulator-title">
          <div className="glass-panel deck-simulator-panel">
            <button className="btn btn-secondary btn-icon-only" aria-label={t('common.close')} onClick={() => setShowSimulator(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <div style={{ paddingRight: '2.5rem' }}>
              <h3 id="deck-simulator-title" style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.handSimulator')}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                {t('deck.mulliganCountText', { mulligans: mulliganCount, handSize: hand.length })}
              </p>
            </div>

            {/* Hand Area */}
            <div className="deck-simulator-hand">
              {hand.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{t('deck.noCardsDrawn')}</div>
              ) : (
                hand.map((card, idx) => (
                  <button type="button" aria-label={displayName(card)} key={idx} style={{
                    width: '130px', maxWidth: '100%', padding: 0, flexShrink: 0,
                    aspectRatio: 0.718, 
                    borderRadius: '8px', 
                    overflow: 'hidden', 
                    boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
                    border: '1px solid var(--border-glass)',
                    position: 'relative',
                    cursor: 'pointer'
                  }} onClick={() => setPreviewCard(card)}>
                    <CardImage card={card} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </button>
                ))
              )}
            </div>

            {/* Control buttons */}
            <div className="deck-simulator-actions">
              <button className="btn btn-secondary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {t('deck.reshuffle')}
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={handleMulligan} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length === 0}
              >
                {t('deck.mulliganDraw', { count: Math.max(1, 7 - (mulliganCount + 1)) })}
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleDrawCard} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length >= simulatorDeck.length}
              >
                {t('deck.drawOne')}
              </button>
            </div>

            <style>{`
              @keyframes shimmer-gold {
                0% { background-position: 0% center; }
                100% { background-position: 200% center; }
              }
            `}</style>
          </div>
        </Modal>
      )}

      {showShareModal && activeDeck && (
        <Modal onClose={() => { if (!shareBusy) setShowShareModal(false); }} returnFocus={shareTriggerRef.current} aria-labelledby="deck-share-title" aria-describedby="deck-share-hint">
          <div className="glass-panel deck-share-panel">
            <div className="deck-share-heading">
              <h2 id="deck-share-title">{t('deck.share')}</h2>
              <button className="btn btn-secondary btn-icon-only" disabled={shareBusy} aria-label={t('common.close')} onClick={() => setShowShareModal(false)}><X size={18} aria-hidden="true" /></button>
            </div>
            <p id="deck-share-hint">{t('deck.shareHint')}</p>
            <p>{t('deck.sharePrivacy')}</p>
            {hasUnsavedChanges && <p id="deck-share-save-first" role="status">{t('deck.shareSaveFirst')}</p>}
            {shareLoading ? <p role="status">{t('common.loading')}</p> : (
              <>
                {shareUrl && (
                  <div className="form-group">
                    <label htmlFor="deck-share-url">{t('deck.shareLink')}</label>
                    <input ref={shareInputRef} id="deck-share-url" className="input-control" value={shareUrl} readOnly onFocus={event => event.target.select()} />
                    <div className="deck-share-actions">
                      <button className="btn btn-primary" disabled={shareBusy} onClick={copyShareLink}><Copy size={16} aria-hidden="true" /> {t('deck.shareCopy')}</button>
                      <a className="btn btn-secondary" href={shareUrl} target="_blank" rel="noopener noreferrer">{t('deck.shareOpen')}</a>
                    </div>
                  </div>
                )}
                {!shareUrl && !shareError && (
                  <button ref={shareCreateRef} className="btn btn-primary" disabled={shareBusy || hasUnsavedChanges} aria-describedby={hasUnsavedChanges ? 'deck-share-save-first' : undefined} onClick={() => updateShareLink()}>
                    {t(shareBusy ? 'deck.shareCreating' : 'deck.shareCreate')}
                  </button>
                )}
                {shareUrl && (
                  <div className="deck-share-revoke">
                    <p>{t('deck.shareRevokeHint')}</p>
                    <button className="btn btn-secondary" disabled={shareBusy} onClick={() => updateShareLink(false, true)}>{t(shareBusy ? 'common.loading' : 'deck.shareRegenerate')}</button>
                    <button className="btn btn-danger" disabled={shareBusy} onClick={() => updateShareLink(true)}>{t(shareBusy ? 'deck.shareRevoking' : 'deck.shareRevoke')}</button>
                  </div>
                )}
              </>
            )}
            {shareError && <div role="alert"><p>{shareError}</p>{!shareUrl && !import.meta.env.VITE_DEMO && <button className="btn btn-secondary" disabled={shareBusy || shareLoading} onClick={() => setShareRetry(value => value + 1)}>{t('deck.shareRetry')}</button>}</div>}
            <p role="status" aria-live="polite">{shareStatus}</p>
          </div>
        </Modal>
      )}

      {/* C. Export Modal */}
      {showExportModal && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '500px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowExportModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.exportTitle')}</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.exportHintBody')}</p>
            <select
              className="input-control"
              style={{ width: '100%', marginBottom: '1rem', fontSize: '0.85rem' }}
              value={exportFormat}
              onChange={e => setExportFormat(e.target.value)}
            >
              <option value="mtga">{t('deck.formatMtga')}</option>
              <option value="plain">{t('deck.formatPlain')}</option>
              <option value="buylist">{t('deck.formatBuylist')}</option>
            </select>
            {exportFormat === 'buylist' && (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '-0.5rem', marginBottom: '1rem' }}>
                {t('deck.buylistHint')}
              </p>
            )}
            <textarea
              readOnly
              className="input-control"
              style={{ width: '100%', height: '220px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              value={handleExportDeckText()}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowExportModal(false)}>{t('common.close')}</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCopyExportText}>{t('deck.copyClipboard')}</button>
              {exportFormat === 'buylist' && (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleOpenMassEntry}>{t('deck.copyOpenTcg')}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* D. Import Modal with Collection Comparison */}
      {showImportModal && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '600px', width: '100%', padding: '1.75rem', position: 'relative', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => { setShowImportModal(false); setImportComparison(null); }} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.importTitle')}</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.pasteDecklistHint')}</p>
            
            <textarea
              className="input-control"
              style={{ width: '100%', minHeight: '120px', maxHeight: '180px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              placeholder={'4 Llanowar Elves\n2 Lightning Bolt\n20 Forest'}
              value={importText}
              onChange={e => { setImportText(e.target.value); setImportComparison(null); }}
            />

            {/* Comparison results table */}
            {comparingImport ? (
              <div style={{ padding: '1.5rem', textAlign: 'center' }}>
                <div className="spinner" style={{ margin: '0 auto 0.5rem auto' }}></div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('deck.comparing')}</span>
              </div>
            ) : importComparison && (
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <span>{t('deck.availabilityBreakdown')}</span>
                  <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                    {t('deck.fullyOwnedCards', { owned: importComparison.filter(i => i.status === 'full').length, total: importComparison.length })}
                  </span>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto' }}>
                  {importComparison.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', padding: '0.25rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                      <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{item.rawName}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{t('deck.reqQuantity', { count: item.requestedQty })}</span>
                        <span style={{
                          padding: '2px 6px',
                          borderRadius: '10px',
                          fontWeight: 700,
                          fontSize: '0.65rem',
                          background: item.status === 'full' ? 'rgba(74, 222, 128, 0.15)' : item.status === 'partial' ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: item.status === 'full' ? 'var(--accent-green)' : item.status === 'partial' ? 'var(--accent-yellow)' : 'var(--accent-red)',
                          border: item.status === 'full' ? '1px solid rgba(74, 222, 128, 0.3)' : item.status === 'partial' ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)'
                        }}>
                          {item.status === 'full' ? `Owned (${item.ownedQty})` : item.status === 'partial' ? `Partial (${item.ownedQty}/${item.requestedQty})` : `Missing (0)`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { setShowImportModal(false); setImportComparison(null); }}>{t('common.cancel')}</button>
              {!importComparison ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCompareImport} disabled={!importText.trim() || editorBusy}>{t('deck.compare')}</button>
              ) : (
                <button className="btn btn-primary" style={{ flex: 1 }} disabled={editorBusy} onClick={handleImportDeck}>{t('deck.importMatched')}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {importSummary && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '600px', width: '100%', padding: '1.75rem' }}>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.importSummary')}</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.imported', { count: importSummary.addedCount })}</p>
            <p style={{ fontSize: '0.8rem', color: 'var(--accent-yellow)' }}>{t('deck.saveDraftHint')}</p>
            {importSummary.skipped.length > 0 && (
              <>
                <h4 style={{ fontSize: '0.9rem', color: 'var(--accent-yellow)', margin: '0 0 0.5rem' }}>{t('deck.notImported')}</h4>
                <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {importSummary.skipped.map((item, index) => (
                    <div key={`${item.name}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', padding: '0.5rem 0.65rem', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{item.name}</span>
                      <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{t('deck.reqQuantity', { count: item.quantity })} · {t(item.reason)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: '1rem' }} onClick={() => setImportSummary(null)}>{t('common.close')}</button>
          </div>
        </div>
      )}

      {/* E. High-Res Card Art Preview Popover */}
      {previewCard && (
        <Modal onClose={() => setPreviewCard(null)} aria-labelledby="deck-preview-title">
          <div className="glass-panel" style={{ width: '340px', maxWidth: '100%', maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', padding: '1rem', position: 'relative', textAlign: 'center' }}>
            <button className="btn btn-secondary btn-icon-only" aria-label={t('common.close')} onClick={() => setPreviewCard(null)} style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', borderRadius: '50%', zIndex: 10 }}>
              <X size={16} />
            </button>
            <CardImage
              card={previewCard}
              style={{ width: '100%', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}
            />
            <h4 id="deck-preview-title" style={{ color: 'var(--text-strong)', margin: '0.75rem 0 0.25rem 0', fontSize: '1rem' }}>{displayName(previewCard)}</h4>
            <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.75rem' }}>
              {previewCard.set_name} • #{previewCard.number} ({previewCard.rarity || 'Common'})
            </p>
            {previewDeckCard && (
              <div className="deck-source-field">
                <label htmlFor="deck-card-source">{t('deck.sourceLocation')}</label>
                <select
                  id="deck-card-source"
                  className="input-control"
                  value={selectedSourceId ?? ''}
                  disabled={editorBusy || savingRecord || searching || !!deckDraft || !!activeDeck.checked_out || !sourcesReady}
                  aria-describedby="deck-card-source-hint deck-card-source-status"
                  aria-invalid={selectedSourceUnavailable && !activeDeck.checked_out ? true : undefined}
                  onChange={event => handleSourceChange(event.target.value)}
                >
                  <option value="">{t('deck.sourceAutomatic')}</option>
                  {selectedSourceId !== null && !selectedSource && (
                    <option value={selectedSourceId} disabled>
                      {t('deck.sourceEntry', { id: selectedSourceId })}
                      {sourcesReady ? ` · ${t('deck.sourceUnavailable')}` : ''}
                    </option>
                  )}
                  {sourcesReady && cardSources.sources.map(source => (
                    <option key={source.entry_id} value={source.entry_id} disabled={source.available < previewDeckCard.quantity}>
                      {sourceLabel(source)}
                    </option>
                  ))}
                </select>
                <p id="deck-card-source-hint">{t('deck.sourceHint', { count: previewDeckCard.quantity })}</p>
                <div id="deck-card-source-status" role="status">
                  {savingDeck && <p>{t('deck.saving')}</p>}
                  {saveDeckError && <p className="deck-source-error">{saveDeckError} {t('deck.saveRetryHint')}</p>}
                  {!!activeDeck.checked_out && <p>{t('deck.sourceCheckedOut')}</p>}
                  {!sourcesReady && !sourcesError && <p>{t('deck.sourcesLoading')}</p>}
                  {sourcesError && (
                    <>
                      <p className="deck-source-error">{t('deck.errSources')} {cardSources.error !== t('deck.errSources') ? cardSources.error : ''}</p>
                      <button type="button" className="btn btn-secondary" onClick={() => setSourceRetry(value => value + 1)}>{t('loc.retry')}</button>
                    </>
                  )}
                  {sourcesReady && !activeDeck.checked_out && selectedSourceUnavailable && (
                    <p className="deck-source-error">{t('deck.sourceInsufficient', { count: previewDeckCard.quantity })}</p>
                  )}
                  {sourcesReady && cardSources.sources.length === 0 && <p>{t('deck.sourcesEmpty')}</p>}
                </div>
                <p>{t('deck.sourceSaveHint')}</p>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Checkout Locator Modal */}
      {showCheckoutModal && (
        <CheckoutWizardModal
          locationsData={checkoutLocations}
          mode={checkoutMode}
          onCancel={handleCheckoutCancel}
          onClose={() => setShowCheckoutModal(false)}
        />
      )}

    </div>
  );
}

export default DeckBuilder;
