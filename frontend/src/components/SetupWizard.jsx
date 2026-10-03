import { useEffect, useRef, useState } from 'react';
import {
  Cpu, Download, Check, X, MapPin, Trash2, Pencil,
  ArrowLeft, ArrowRight, Camera, Database, Swords, LayoutDashboard, Settings as SettingsIcon,
  Languages,
} from 'lucide-react';
import { gameLabel } from '../utils/games';
import { containerTypeKey } from '../utils/cardOptions';
import { LOCALES, localeName, useT } from '../utils/i18n';
import Modal from './Modal';

// First-run setup.
//
// A fresh install has an empty database, no models and no catalog, so the scanner
// answers 503 and the only hint is a sentence in a server log. Everything needed
// to fix that already existed — a download endpoint, a settings form, a storage
// panel — spread across screens a new user has no reason to open. This walks the
// decisions once, in the order they depend on each other, and ends with a short
// description of what each tab is for.
//
// The language comes first, before any decision is explained, so the explanations
// themselves arrive in a language the admin reads. Picking one here is the same
// setting as Settings → Language: it writes through the i18n provider, which
// persists it per browser.
//
// Deliberately not a second copy of Admin: the wizard offers the one-click paths
// only, and points at Admin for anything with options (building a catalog from
// chosen sets, compartment layouts, sorting rules).
//
// Completion lives on the server (app_settings.setup_complete), not in
// localStorage, so an admin who starts on a laptop and finishes on a phone is not
// asked twice, and an admin who closes halfway is picked up where they left off
// after the next login.

// The three container types a first-run admin is most likely to own. The rest are
// in Storage's own create form, which also asks about layout and sorting.
const NEW_LOCATION_TYPES = ['Binder', 'Box', 'Deck Box'];
const STEPS = ['language', 'scanning', 'storage', 'tour'];

function Heading({ icon, title, sub }) {
  return (
    <div>
      <h3 id="setup-step-title" tabIndex={-1} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '1.05rem' }}>
        {icon} {title}
      </h3>
      {sub && <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0.4rem 0 0' }}>{sub}</p>}
    </div>
  );
}

const markComplete = () => fetch('/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ setup_complete: true }),
});

export default function SetupWizard({ user, onClose }) {
  const { t, locale, setLocale } = useT();
  const [step, setStep] = useState(0);
  const contentRef = useRef(null);
  const previousStep = useRef(step);
  const [modelsStatus, setModelsStatus] = useState('loading');
  const [catalogsStatus, setCatalogsStatus] = useState('loading');
  const [locationsStatus, setLocationsStatus] = useState('loading');
  const [actionError, setActionError] = useState('');
  const [finishError, setFinishError] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (previousStep.current !== step) {
      contentRef.current?.querySelector('#setup-step-title')?.focus();
      previousStep.current = step;
      setActionError('');
    }
  }, [step]);

  // Step 2: scanning
  const [engine, setEngine] = useState(null);
  const [catalogs, setCatalogs] = useState([]);


  // Step 4: storage
  const [locations, setLocations] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('Binder');

  // Sizes and counts are locale-formatted, so they go through t() rather than
  // being glued into a sentence: "9.6 MB" is "9,6 MB" in half of Europe.
  const mb = (n) => t('setup.scan.megabytes', { size: Number((n / 1024 / 1024).toFixed(1)) });

  const load = async (signal) => {
    await Promise.all([
      (async () => {
        try {
          const r = await fetch('/api/admin/models', { signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          if (signal?.aborted) return;
          setEngine(data);
          setModelsStatus('ready');
        } catch {
          if (!signal?.aborted) setModelsStatus('error');
        }
      })(),
      (async () => {
        try {
          const r = await fetch('/api/admin/catalogs', { signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          if (signal?.aborted) return;
          setCatalogs(data?.catalogs || []);
          setCatalogsStatus('ready');
        } catch {
          if (!signal?.aborted) setCatalogsStatus('error');
        }
      })(),
    ]);
  };

  const retryScanning = () => {
    setModelsStatus('loading');
    setCatalogsStatus('loading');
    load();
  };

  const loadLocations = async (signal) => {
    setLocationsStatus('loading');
    try {
      const r = await fetch('/api/locations', { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      if (signal?.aborted) return;
      setLocations(Array.isArray(rows) ? rows : []);
      setLocationsStatus('ready');
    } catch {
      if (!signal?.aborted) setLocationsStatus('error');
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    loadLocations(controller.signal);
    return () => controller.abort();
  }, []);

  // Poll while a download runs, from whatever step the user is on: these are tens
  // of megabytes, and a bar that stops moving is the only way to tell a stalled
  // download from a slow one.
  useEffect(() => {
    if (!engine?.progress) return;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        await load(controller.signal);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [engine?.progress]);

  const dl = engine?.progress;
  const modelsReady = !!engine?.models?.length && engine.models.every(m => m.present);
  const localCatalogs = catalogs.filter(c => c.built);

  const post = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };

  const download = async (what) => {
    setActionError('');
    try {
      const j = await post('/api/admin/models/download', { what });
      setEngine(prev => ({ ...(prev || {}), progress: j.progress }));
    } catch (e) { setActionError(e.message); }
  };


  const addLocation = async () => {
    const name = newName.trim();
    if (!name) return;
    setActionError('');
    try {
      await post('/api/locations', { name, type: newType });
      setNewName('');
      await loadLocations();
    } catch (e) { setActionError(e.message); }
  };

  const renameLocation = async (id) => {
    const name = editName.trim();
    if (!name) return;
    setActionError('');
    try {
      const r = await fetch(`/api/locations/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || t('setup.storage.errRename'));
      setEditingId(null);
      await loadLocations();
    } catch (e) { setActionError(e.message); }
  };

  const deleteLocation = async (loc) => {
    // Deleting a location unfiles its cards rather than deleting them, but that is
    // not obvious from a trash icon, so say it before doing it.
    const warn = loc.total_cards > 0
      ? t('setup.storage.confirmDeleteCards', { name: loc.name, count: loc.total_cards })
      : t('setup.storage.confirmDelete', { name: loc.name });
    if (!window.confirm(warn)) return;
    setActionError('');
    try {
      const r = await fetch(`/api/locations/${loc.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t('setup.storage.errDelete'));
      await loadLocations();
    } catch (e) { setActionError(e.message); }
  };

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    setFinishError(false);
    try {
      const response = await markComplete();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onClose();
    } catch {
      setFinishError(true);
    } finally {
      setFinishing(false);
    }
  };

  // A type stored by an older install may have no locale key; it keeps its stored
  // English name rather than being mislabelled.
  const typeName = (type) => {
    const key = containerTypeKey(type);
    return key ? t(`container.type.${key}`) : type;
  };

  const label = { fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-strong)' };
  const body = { fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 };
  const input = {
    width: '100%', padding: '0.45rem 0.6rem', fontSize: '0.78rem',
    background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-glass)',
    borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)',
  };
  const row = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
    padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-glass)', background: 'var(--surface-1)',
  };


  const Tip = ({ icon, title, children }) => (
    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0, marginTop: '0.15rem', color: 'var(--text-muted)' }}>{icon}</div>
      <div>
        <div style={label}>{title}</div>
        <p style={{ ...body, fontSize: '0.76rem' }}>{children}</p>
      </div>
    </div>
  );

  // One bar, reused by the recogniser and each catalog. `what` matches the job id
  // the download endpoint reports back, so only the row being downloaded moves.
  const Progress = ({ what }) => {
    if (dl?.what !== what) return null;
    const pct = dl.total ? Math.round((dl.done / dl.total) * 100) : 0;
    return (
      <div style={{ marginTop: '0.4rem' }}>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent-red)', transition: 'width 0.3s' }} />
        </div>
        <div style={{ ...body, fontSize: '0.72rem', marginTop: '0.25rem' }}>
          {t(dl.phase === 'done' ? 'setup.scan.installing' : 'setup.scan.downloading', {
            name: dl.name, done: mb(dl.done), total: mb(dl.total), pct,
          })}
        </div>
      </div>
    );
  };

  // A failed download clears `progress` and lands in `last`, so without this the
  // bar just vanishes and the row still reads "Not installed" with no reason why.
  const failed = engine?.last?.phase === 'error' ? engine.last : null;
  const Failure = ({ what }) => (failed?.what === what ? (
    <p style={{ fontSize: '0.72rem', color: '#f87171', margin: '0.35rem 0 0' }}>
      {t('setup.scan.failed', { message: failed.message })}
    </p>
  ) : null);

  const Status = ({ present }) => (
    <span style={{ fontSize: '0.74rem', color: present ? 'var(--accent-green)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
      {present ? <><Check size={13} /> {t('setup.scan.installed')}</> : t('setup.scan.notInstalled')}
    </span>
  );

  // Step 0. The picker only appears once a second locale file exists to switch to
  // (dropping one into src/locales is what makes it appear), so an English-only
  // install sees the welcome alone rather than a select with one option in it.
  const language = (
    <>
      <Heading
        icon={<Database size={18} />}
        title={t('setup.language.title', { name: user?.username || t('setup.language.fallbackName') })}
        sub={t('setup.language.sub')}
      />
      {LOCALES.length > 1 && (
        <div>
          <label htmlFor="setup-ui-lang" style={{ ...label, display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.3rem' }}>
            <Languages size={14} /> {t('setup.language.pick')}
          </label>
          <select
            id="setup-ui-lang" className="select-control" style={input}
            value={locale} onChange={(e) => setLocale(e.target.value)}
          >
            {LOCALES.map(code => (
              <option key={code} value={code}>{localeName(code)}</option>
            ))}
          </select>
          <p style={{ ...body, fontSize: '0.74rem', marginTop: '0.35rem' }}>{t('prefs.languageHint')}</p>
        </div>
      )}
      <p style={body}>{t('setup.language.body')}</p>
      <p style={body}>{t('setup.language.resume')}</p>
    </>
  );


  const scanning = (
    <>
      <Heading
        icon={<Cpu size={18} />}
        title={t('setup.scan.title')}
        sub={t('setup.scan.sub')}
      />

      {(modelsStatus === 'loading' || catalogsStatus === 'loading') && <p role="status" style={body}>{t('common.loading')}</p>}
      {(modelsStatus === 'error' || catalogsStatus === 'error') && (
        <div>
          <p role="alert" style={{ ...body, color: 'var(--accent-red)' }}>{t('setup.scan.loadError')}</p>
          <button className="btn btn-secondary btn-sm" onClick={retryScanning}>{t('common.retry')}</button>
        </div>
      )}
      {modelsStatus === 'ready' && !engine?.models?.length && <p style={body}>{t('setup.scan.noModels')}</p>}
      {modelsStatus === 'ready' && !!engine?.models?.length && <>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
          <div style={label}>
            {t('setup.scan.recogniser', {
              count: (engine?.models || []).length || 2,
              size: engine ? mb((engine.models || []).reduce((n, m) => n + m.bytes, 0)) : mb(9.6 * 1024 * 1024),
            })}
          </div>
          <Status present={modelsReady} />
        </div>
        <p style={{ ...body, fontSize: '0.75rem', margin: '0.25rem 0 0.4rem' }}>
          {t('setup.scan.recogniserBody', { license: engine?.license?.spdx || 'AGPL-3.0' })}
        </p>
        {!modelsReady && (
          <button className="btn btn-primary btn-sm" disabled={!!dl} onClick={() => download('models')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <Download size={13} /> {t('setup.scan.download')}
          </button>
        )}
        <Progress what="models" />
        <Failure what="models" />
      </div>
      </>}

      <div>
        <div style={label}>{t('setup.scan.catalog')}</div>
        <p style={{ ...body, fontSize: '0.75rem', margin: '0.25rem 0 0.5rem' }}>
          {t('setup.scan.catalogBody')}
        </p>
        {modelsStatus === 'ready' && !(engine?.catalogs || []).some(c => c.game === 'mtg') && <p style={body}>{t('setup.scan.noCatalogDownloads')}</p>}
        {catalogsStatus === 'ready' && catalogs.length === 0 && <p style={body}>{t('setup.scan.noCatalogs')}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {(modelsStatus === 'ready' ? engine?.catalogs || [] : []).filter(c => c.game === 'mtg').map(c => (
            <div key={c.name}>
              <div style={row}>
                <span style={{ fontSize: '0.76rem', color: 'var(--text-strong)' }}>
                  {gameLabel(c.game)}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {' · '}{t('setup.scan.catalogMeta', { size: mb(c.bytes), snapshot: c.snapshot })}
                  </span>
                </span>
                {c.present
                  ? <Status present />
                  : (
                    <button className="btn btn-secondary btn-sm" disabled={!!dl || !modelsReady}
                      onClick={() => download(`catalog:${c.game}`)}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                      <Download size={13} /> {t('setup.scan.download')}
                    </button>
                  )}
              </div>
              <Progress what={`catalog:${c.game}`} />
              <Failure what={`catalog:${c.game}`} />
            </div>
          ))}
        </div>
        {modelsStatus === 'ready' && !modelsReady && (
          <p style={{ fontSize: '0.72rem', color: 'var(--accent-yellow)', margin: '0.4rem 0 0' }}>
            {t('setup.scan.needModels')}
          </p>
        )}
        <p style={{ ...body, fontSize: '0.74rem', marginTop: '0.5rem' }}>
          {t('setup.scan.buildHint')}
          {localCatalogs.length > 0 && ` ${t('setup.scan.buildHintBuilt')}`}
        </p>
      </div>
    </>
  );


  const storage = (
    <>
      <Heading
        icon={<MapPin size={18} />}
        title={t('setup.storage.title')}
        sub={t('setup.storage.sub')}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {locationsStatus === 'loading' && <p role="status" style={body}>{t('common.loading')}</p>}
        {locationsStatus === 'error' && (
          <div>
            <p role="alert" style={{ ...body, color: 'var(--accent-red)' }}>{t('setup.storage.loadError')}</p>
            <button className="btn btn-secondary btn-sm" onClick={() => loadLocations()}>{t('common.retry')}</button>
          </div>
        )}
        {locationsStatus === 'ready' && locations.length === 0 && <p style={{ ...body, fontSize: '0.76rem' }}>{t('setup.storage.none')}</p>}
        {locations.map(l => (
          <div key={l.id} style={row}>
            {editingId === l.id ? (
              <>
                <input
                  type="text" value={editName} autoFocus
                  aria-label={t('setup.storage.rename', { name: l.name })}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renameLocation(l.id);
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditingId(null); }
                  }}
                  style={{ ...input, flex: 1 }}
                />
                <button className="btn btn-primary btn-sm" onClick={() => renameLocation(l.id)}>{t('common.save')}</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>{t('common.cancel')}</button>
              </>
            ) : (
              <>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-strong)', fontWeight: 600 }}>{l.name}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                    {t('setup.storage.meta', {
                      type: typeName(l.type),
                      compartments: t('setup.storage.compartments', { count: l.compartment_count }),
                      cards: l.total_cards,
                      capacity: l.total_capacity,
                    })}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
                  <button className="btn btn-secondary btn-sm" aria-label={t('setup.storage.rename', { name: l.name })}
                    onClick={() => { setEditingId(l.id); setEditName(l.name); }}>
                    <Pencil size={13} />
                  </button>
                  <button className="btn btn-secondary btn-sm" aria-label={t('setup.storage.delete', { name: l.name })}
                    onClick={() => deleteLocation(l)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div>
        <div style={{ ...label, marginBottom: '0.3rem' }}>{t('setup.storage.addAnother')}</div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label htmlFor="setup-location-name" style={{ ...label, display: 'block', marginBottom: '0.3rem' }}>{t('container.name')}</label>
            <input
              id="setup-location-name"
              type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addLocation(); }}
              placeholder={t('setup.storage.namePlaceholder')} style={{ ...input, width: '100%' }}
            />
          </div>
          <div style={{ flex: '1 1 130px', minWidth: 0 }}>
            <label htmlFor="setup-location-type" style={{ ...label, display: 'block', marginBottom: '0.3rem' }}>{t('container.step.type')}</label>
            <select id="setup-location-type" className="select-control" style={{ ...input, width: '100%' }} value={newType} onChange={(e) => setNewType(e.target.value)}>
            {NEW_LOCATION_TYPES.map(type => (
              <option key={type} value={type}>{typeName(type)}</option>
            ))}
          </select>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={addLocation} disabled={!newName.trim()}>{t('setup.storage.add')}</button>
        </div>
        <p style={{ ...body, fontSize: '0.74rem', marginTop: '0.35rem' }}>
          {t('setup.storage.addHint')}
        </p>
      </div>
    </>
  );

  const tour = (
    <>
      <Heading icon={<LayoutDashboard size={18} />} title={t('setup.tour.title')} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <Tip icon={<Camera size={15} />} title={t('nav.addCards')}>
          {t('setup.tour.addCards')}
        </Tip>
        <Tip icon={<Database size={15} />} title={t('nav.collection')}>
          {t('setup.tour.collection')}
        </Tip>
        <Tip icon={<MapPin size={15} />} title={t('nav.storage')}>
          {t('setup.tour.storage')}
        </Tip>
        <Tip icon={<Swords size={15} />} title={t('nav.deckBuilder')}>
          {t('setup.tour.decks')}
        </Tip>
        <Tip icon={<LayoutDashboard size={15} />} title={t('setup.tour.dashboardTitle')}>
          {t('setup.tour.dashboard')}
        </Tip>
        <Tip icon={<SettingsIcon size={15} />} title={t('setup.tour.settingsTitle')}>
          {t('setup.tour.settings')}
        </Tip>
      </div>
    </>
  );

  const content = [language, scanning, storage, tour][step];
  const last = step === STEPS.length - 1;

  return (
    <Modal onClose={() => { if (!finishing) onClose(); }} aria-labelledby="setup-step-title" style={{
      position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '1rem', background: 'rgba(0,0,0,0.72)',
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    }}>
      <div className="dialog-panel-spacing" style={{
        width: '100%', maxWidth: 580, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
        borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-glow)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
            {STEPS.map((s, i) => (
              <div key={s} title={t(`setup.step.${s}`)} style={{
                width: i === step ? 20 : 8, height: 8, borderRadius: 4,
                background: i === step ? 'var(--accent-red)' : i < step ? 'var(--accent-green)' : 'var(--surface-3)',
                transition: 'width 0.15s',
              }} />
            ))}
            <span aria-live="polite" aria-atomic="true" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: '0.4rem' }}>
              {t(`setup.step.${STEPS[step]}`)} · {t('setup.stepCount', { step: step + 1, total: STEPS.length })}
            </span>
          </div>
          <button type="button" onClick={onClose} disabled={finishing} aria-label={t('common.close')}
            className="btn btn-icon-only" style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div ref={contentRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', paddingRight: '0.25rem' }}>
          {content}
          {actionError && <p role="alert" style={{ ...body, color: 'var(--accent-red)' }}>{actionError}</p>}
        </div>

        {finishError && (
          <div>
            <p role="alert" style={{ ...body, color: 'var(--accent-red)' }}>{t('setup.finishError')}</p>
            <button className="btn btn-secondary btn-sm" disabled={finishing} onClick={finish}>{t('common.retry')}</button>
          </div>
        )}
        {finishing && <p role="status" style={body}>{t('common.loading')}</p>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
          <button className="btn btn-secondary btn-sm" disabled={finishing} onClick={finish}>{t('setup.skip')}</button>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {step > 0 && (
              <button className="btn btn-secondary btn-sm" disabled={finishing} onClick={() => setStep(s => s - 1)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <ArrowLeft size={13} /> {t('common.back')}
              </button>
            )}
            <button className="btn btn-primary btn-sm" disabled={finishing} onClick={() => last ? finish() : setStep(s => s + 1)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              {last ? t('setup.done') : t('common.next')} <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Whether this install still owes its admin the wizard. One server-side flag, so
// the answer is the same in every browser and survives a cleared localStorage.
//
// Lives beside the wizard rather than in its own module because it is the question
// "should the wizard open", and App.jsx is the only caller. Same trade utils/i18n
// .jsx makes for its non-component exports.
// eslint-disable-next-line react-refresh/only-export-components
export async function setupNeeded() {
  const r = await fetch('/api/settings');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const s = await r.json();
  return !s.setup_complete;
}
