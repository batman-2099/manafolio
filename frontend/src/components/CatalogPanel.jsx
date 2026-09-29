import { useEffect, useState } from 'react';
import { Database, Play, Square, RefreshCw, Check, AlertTriangle, Cpu, Download, ListFilter, Zap } from 'lucide-react';
import SetTree from './SetTree';
import { useT } from '../utils/i18n';
import { toggleSetCodes } from '../utils/setSelection';

// Scan catalogs.
//
// This replaced a panel that asked the user to reason about per-set ORB indexes,
// whole-game rollups, recall depth and set scoping in order to get a working
// scanner. There is one thing to build now — a catalog, which is one game in one
// language — and building it does both halves of the job:
//
//   1. cache every set's cards, so the app knows the cards exist at all
//   2. embed their artwork, so the scanner can recognise them
//
// Card data is cached before artwork is indexed, including sets not yet scanned.
const GAME_LABEL = { mtg: 'Magic: The Gathering' };
const POLL_MS = 1000;

// The house style, so this panel reads as part of Admin rather than its own app.
//
// It had grown a private type scale (0.6rem to 0.85rem, six sizes), pill badges
// nothing else uses, and hand-rolled inputs beside the shared .input-control —
// which is what "formatted differently from the rest of the menus" was. Everything
// below is lifted from the neighbouring admin panels: 1.1rem section head with an
// accent-red icon over a rule, 0.95rem sub-heads, 0.8rem body, the shared control
// classes, and .collection-table for anything that is a list of rows.
const H3 = { color: 'var(--text-strong)', fontSize: '1.1rem', margin: 0, borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' };
const H4 = { margin: 0, fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' };
const SUB = { background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' };
const INNER = { background: 'rgba(0, 0, 0, 0.18)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.75rem 0.9rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' };
const HINT = { color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.45 };
const NOTE = { color: 'var(--text-muted)', fontSize: '0.75rem', margin: 0, lineHeight: 1.4 };
const ROW = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' };
const BTN = { display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0, height: '34px' };

function pct(a, b) {
  if (!b) return null;
  return Math.min(100, Math.round((a / b) * 100));
}

function Bar({ value, tone = 'var(--accent-green)' }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: '100%', background: tone, transition: 'width 0.3s' }} />
    </div>
  );
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const num = (n) => Number(n || 0).toLocaleString();

// An always-open sub-panel, for the things a user has to see rather than find.
//
// The engine and the ready-made catalogs were both <details> — the engine one
// collapsed as soon as the models were installed, and the ready-made list was a
// disclosure nested INSIDE it. So the two steps that get a scanner working in five
// minutes were two clicks deep, while the hours-long local build was the only
// thing on screen. That is backwards, and it is why installs sat unable to scan.
function Step({ n, icon, title, status, tone, children }) {
  return (
    <div style={SUB}>
      <div style={ROW}>
        <h4 style={H4}>{icon} {n}. {title}</h4>
        {status && <span style={{ fontSize: '0.8rem', fontWeight: 600, color: tone || 'var(--text-secondary)' }}>{status}</span>}
      </div>
      {children}
    </div>
  );
}

// Step one: the two model files. Nothing else on this screen does anything until
// they are installed, so this states that and offers the one button.
function EngineCard({ engine, onDownload, busy }) {
  const { t } = useT();
  if (!engine) return null;
  const models = engine.models || [];
  const missing = models.filter(m => !m.present);

  return (
    <Step
      n="1"
      icon={<Cpu size={16} style={{ color: 'var(--accent-red)' }} />}
      title={t('catalog.scanEngine')}
      status={missing.length ? t('catalog.requiredNotInstalled') : t('catalog.installed')}
      tone={missing.length ? 'var(--accent-yellow)' : 'var(--accent-green)'}
    >
      <div style={ROW}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: '1 1 20rem' }}>
          <p style={HINT}>
            {t('catalog.engineDesc', { size: mb(models.reduce((n, m) => n + m.bytes, 0)) })}
          </p>
          {/* Said plainly, because it is the reason this is a button at all. */}
          <p style={NOTE}>
            {t('catalog.engineLicense', { spdx: engine.license?.spdx || '' })}{' '}
            {(engine.license?.urls || []).map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-blue, #60a5fa)' }}>
                {i === 0 ? 'cornelius' : 'milo'}
              </a>
            )).reduce((acc, el) => acc.length ? [...acc, ', ', el] : [el], [])}
          </p>
        </div>
        {!!missing.length && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy}
            onClick={() => onDownload('models')} style={BTN}>
            <Download size={14} /> {t('catalog.download')}
          </button>
        )}
      </div>
    </Step>
  );
}

// Step two, and the answer for most installs: a published catalog is one download
// away from a working scanner, against the hours a local build takes. The
// tradeoffs are real and stated, but they are stated in a panel that is OPEN.
function ReadyMadeCard({ engine, onDownload, busy, enginePresent }) {
  const { t } = useT();
  if (!engine) return null;
  const cats = (engine.catalogs || []).filter(c => c.game === 'mtg');
  if (!cats.length) return null;
  const have = cats.filter(c => c.present).length;

  return (
    <Step
      n="2"
      icon={<Download size={16} style={{ color: 'var(--accent-red)' }} />}
      title={t('catalog.readyMadeTitle')}
      status={have ? t('catalog.nInstalled', { count: have }) : t('catalog.fastestWay')}
      tone={have ? 'var(--accent-green)' : 'var(--accent-blue, #60a5fa)'}
    >
      <p style={HINT}>
        {t('catalog.readyMadeDesc')}
      </p>
      <p style={HINT}>The Magic catalog uses Scryfall card IDs, so a scan can fetch and cache a matching printing directly.</p>
      <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
        <table className="collection-table">
          <thead>
            <tr>
              <th>{t('catalog.thGame')}</th>
              <th>{t('catalog.thSize')}</th>
              <th className="hide-mobile">{t('catalog.thSnapshot')}</th>
              <th style={{ textAlign: 'right' }}>{t('catalog.thStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {cats.map(c => (
              <tr key={c.name}>
                <td style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{GAME_LABEL[c.game] || c.game}</td>
                <td>{mb(c.bytes)}</td>
                <td className="hide-mobile">{c.snapshot}</td>
                <td style={{ textAlign: 'right' }}>
                  {c.present
                    ? <span style={{ color: 'var(--accent-green)', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Check size={14} /> {t('catalog.installed')}</span>
                    : (
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                        onClick={() => onDownload(`catalog:${c.game}`)}
                        style={{ ...BTN, marginLeft: 'auto' }}>
                        <Download size={14} /> {t('catalog.get')}
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!enginePresent && (
        <p style={{ ...NOTE, color: 'var(--accent-yellow)' }}>
          {t('catalog.engineRequiredNote')}
        </p>
      )}

    </Step>
  );
}

// Pick the sets to build, instead of committing to a whole game.
//
// This is the difference between minutes and hours: a full MTG build is a ~10
// minute set walk plus ~110k embeddings, while the two boxes actually in front of
// you are a couple of minutes. Scoped builds MERGE (see catalog.js keptFromPrev),
// so this is additive — build what you opened this week, build more next week.
function BuildPicker({ game, lang, disabled, onBuild, showToast, label }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState([]);
  const [counts, setCounts] = useState(null);
  const [picked, setPicked] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const codeOf = (s) => (s.id || '').replace(/^mtg-/, '');

  useEffect(() => {
    if (!open || sets.length) return;
    setLoading(true);
    const l = encodeURIComponent(lang);
    Promise.all([
      fetch(`/api/sets?game=${game}&lang=${l}&tree=1`).then(r => r.ok ? r.json() : []),
      fetch(`/api/scan-sets?game=${game}&lang=${l}`).then(r => r.ok ? r.json() : null),
    ]).then(([tree, sc]) => {
      setSets(tree);
      setCounts(sc?.sets || null);
    }).catch(() => showToast?.(t('catalog.errListSets'), 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleCode = (code) => setPicked(p => toggleSetCodes(p, code));
  const toggleFamily = (s) => setPicked(p => toggleSetCodes(p, codeOf(s), (s.children || []).map(c => c.code)));

  // Closed, this is the RECOMMENDED action rather than an afterthought next to
  // "Build all": picking the sets you actually own is minutes of work, and a whole
  // game is hours. It used to be a secondary button labelled "Build only certain
  // sets", which reads like a restriction on the obvious choice instead of the
  // cheaper one.
  if (!open) {
    return (
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled}
        onClick={() => setOpen(true)} style={BTN}>
        <ListFilter size={14} /> {label || t('catalog.chooseSets')}
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', width: '100%', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
      <div style={ROW}>
        <p style={{ ...HINT, flex: '1 1 18rem' }}>
          {picked.length
            ? t('catalog.setsSelected', { count: picked.length })
            : t('catalog.setsSelectHint')}
        </p>
        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
          {!!picked.length && (
            <button type="button" className="btn btn-secondary btn-sm" style={BTN}
              onClick={() => setPicked([])}>{t('bulk.clear')}</button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" style={BTN}
            onClick={() => { setOpen(false); setPicked([]); setQuery(''); }}>{t('common.cancel')}</button>
        </div>
      </div>
      <input
        type="text"
        className="input-control"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('catalog.searchMtgPlaceholder')}
        style={{ padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
      />
      {loading
        ? <p style={HINT}>{t('catalog.loadingSets')}</p>
        : (
          <SetTree
            sets={[...sets].reverse()}
            codeOf={codeOf}
            selected={picked}
            onToggleCode={toggleCode}
            onToggleFamily={toggleFamily}
            counts={counts}
            showCounts={!!counts}
            query={query}
            maxHeight={220}
            emptyLabel={t('scan.noSetMatches')}
          />
        )}
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !picked.length}
        onClick={() => { onBuild(picked); setOpen(false); setPicked([]); setQuery(''); }}
        style={{ ...BTN, alignSelf: 'flex-start' }}>
        <Play size={14} /> {t('catalog.buildNSelected', { count: picked.length || '' })}
      </button>
    </div>
  );
}

// Other languages — only the ones that exist to download, with the numbers.
//

export default function CatalogPanel({ showToast }) {
  const { t } = useT();
  const [catalogs, setCatalogs] = useState([]);
  const [progress, setProgress] = useState(null);
  const [last, setLast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [engine, setEngine] = useState(null);

  const load = async (signal) => {
    try {
      const r = await fetch('/api/admin/catalogs', { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      // Engine state is optional; a failed read must not discard running progress.
      let models;
      try {
        const e = await fetch('/api/admin/models', { signal });
        if (e.ok) models = await e.json();
      } catch { /* the panel still lists catalogs without it */ }
      if (signal.aborted) return;
      setCatalogs(j.catalogs || []);
      setProgress(j.progress || null);
      setLast(j.last || null);
      if (models) setEngine(models);
    } catch (e) {
      if (!signal.aborted) showToast?.(t('catalog.errLoadCatalogs', { message: e.message }), 'error');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  };

  // Poll only while something is running.
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One timer for both jobs. A build and a download are never both running (each
  // refuses while the other holds its slot), so a single poll covers whichever is.
  useEffect(() => {
    if (!progress && !engine?.progress) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer;
    const poll = async () => {
      try {
        if (progress) {
          const r = await fetch('/api/admin/catalogs/progress', { signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json();
          if (signal.aborted) return;
          // Refresh installed counts before committing the terminal progress.
          if (!j.progress) await load(signal);
          if (signal.aborted) return;
          setProgress(j.progress || null);
          setLast(j.last || null);
        }
        if (engine?.progress) {
          const e = await fetch('/api/admin/models', { signal });
          if (!e.ok) throw new Error(`HTTP ${e.status}`);
          const ej = await e.json();
          if (signal.aborted) return;
          if (!ej.progress) await load(signal);
          if (!signal.aborted) setEngine(ej);
        }
      } catch { /* a dropped poll retries without discarding the last progress */ }
      finally {
        if (!signal.aborted) timer = setTimeout(poll, POLL_MS);
      }
    };
    timer = setTimeout(poll, POLL_MS);
    return () => { controller.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, engine?.progress]);

  const download = async (what) => {
    try {
      const r = await fetch('/api/admin/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ what }),
      });
      const j = await r.json();
      if (!r.ok) return showToast?.(j.error || t('catalog.errStartDownloadGeneric'), 'error');
      setEngine(prev => ({ ...(prev || {}), progress: j.progress }));
    } catch (e) {
      showToast?.(t('catalog.errStartDownload', { message: e.message }), 'error');
    }
  };


  // `sets` scopes the build. A scoped build MERGES into the existing catalog, so
  // building the two sets you just opened does not discard last week's work.
  const build = async (game, lang, sets = []) => {
    try {
      const r = await fetch('/api/admin/catalogs/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, lang, sets }),
      });
      const j = await r.json();
      if (!r.ok) return showToast?.(j.error || t('catalog.errStartBuildGeneric'), 'error');
      setProgress(j.progress);
    } catch (e) {
      showToast?.(t('catalog.errStartBuild', { message: e.message }), 'error');
    }
  };

  const stop = async () => {
    try {
      const r = await fetch('/api/admin/catalogs/stop', { method: 'POST' });
      const j = await r.json();
      setProgress(j.progress);
      showToast?.(t('catalog.stoppingToast'), 'status');
    } catch (e) {
      showToast?.(t('catalog.errStop', { message: e.message }), 'error');
    }
  };

  const running = progress;

  // English rows only, plus any language that has a catalog of its OWN.
  //
  // Deliberately NOT keyed on `published`: cvScan.isBuilt falls back to the English
  // catalog for any language, so that flag is true for every row and means
  // 'something can answer', not 'this language is built'. The languages this
  // install merely holds a card or two of are not rows at all any more — they were
  // fifteen near-empty entries invented by one imported card each, and the ones
  // worth building now live in OtherLanguages with their real numbers.
  const rows = catalogs.filter(c => c.game === 'mtg' && (!!c.built || c.lang === 'English'));

  // One collapsed line per catalog. The summary carries everything needed to decide
  // whether to open it — state, counts, and any warning — because a row that hides
  // "cards from 46 sets will be misidentified" behind a click is worse than the wall
  // of rows this replaced.
  const renderRow = (c) => {
    // Only English has a real denominator — the set catalogue is one list, not one
    // per language — so other languages report what they hold rather than a
    // percentage measured against the wrong total.
    const coverage = c.claimed ? pct(c.cached, c.claimed) : null;
    const indexed = c.built ? c.built.rows : 0;
    const busy = running && running.game === c.game && running.lang === c.lang;
    const indexable = c.withArt ?? c.cached;
    const warn = (c.built && indexable > indexed) || !!c.newSets;
    return (
      <details key={`${c.game}|${c.lang}`} style={INNER}>
        <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-strong)' }}>
            {GAME_LABEL[c.game] || c.game}
            <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}> · {c.lang}</span>
          </span>
          <span style={{ fontSize: '0.8rem', color: c.built ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
            {c.built ? t('catalog.nIndexed', { count: num(indexed) }) : c.published ? t('catalog.readyMadeInUse') : t('catalog.notBuilt')}
          </span>
          {warn && <AlertTriangle size={14} color="var(--accent-yellow)" />}
        </summary>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', paddingTop: '0.75rem' }}>
          <p style={HINT}>
            {c.claimed
              ? t('catalog.nOfKnownDownloaded', { cached: num(c.cached), claimed: num(c.claimed) })
              : t('catalog.nDownloaded', { cached: num(c.cached) })}
          </p>
          {coverage != null && <Bar value={coverage} />}
          {/* Picking sets comes FIRST and is the primary button; the whole-game
              build is the expensive fallback and now says so. The two used to be
              the other way round, with "Build all" the only visible action and the
              set picker hidden behind a secondary button below it — so the default
              path was the one that takes hours. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            <BuildPicker
              game={c.game}
              lang={c.lang}
              disabled={!!running}
              onBuild={(sets) => build(c.game, c.lang, sets)}
              showToast={showToast}
            />
            <button
              type="button"
              className={warn ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              disabled={!!running}
              onClick={() => build(c.game, c.lang)}
              style={BTN}
            >
              {c.built ? <RefreshCw size={14} /> : <Play size={14} />}
              {busy ? t('catalog.btnBuilding') : c.built ? t('catalog.updateEverythingBuilt') : t('catalog.buildWholeGame')}
            </button>
            {!c.built && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {t('catalog.wholeGameHint')}
              </span>
            )}
          </div>
          {/* The number that actually predicts whether a scan can answer: a catalog
              can be perfectly built and still only cover the cards this install has
              downloaded. */}
          {/* withArt, not cached: a card with no artwork can never be embedded, so
              counting it here told the user to re-run a build that would change
              nothing. Measured: 68 by the old count, 53 of which were real — the
              other 15 have no image at all. */}
          {c.built && indexable > indexed && (
            <p style={{ ...NOTE, color: 'var(--accent-yellow)' }}>
              {t('catalog.notIndexedYet', { count: num(indexable - indexed) })}
            </p>
          )}
          {/* The warning above compares downloaded against indexed, so it stays
              silent for a set released since the last build: those cards are not
              downloaded either. Scanning one returns the nearest wrong card. */}
          {/* Sets a build has already found to be empty upstream are excluded by the
              backend, so what is left really is buildable. Before that, this counted
              46 unbuildable promo/sample sets and told the user to build them. */}
          {!!c.newSets && (
            <p style={{ ...NOTE, color: 'var(--accent-yellow)' }}>
              {t('catalog.newSetsWarning', { count: num(c.newSets) })}
            </p>
          )}
        </div>
      </details>
    );
  };

  if (loading) return <p style={{ ...HINT, padding: '0.5rem 0' }}>{t('catalog.loadingCatalogs')}</p>;

  const phaseLabel = running && (running.phase === 'cache'
    ? t('catalog.downloadingCardLists')
    : running.phase === 'embed' ? t('catalog.buildingImageIndex') : running.phase);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <h3 style={H3}>
        <Database size={18} style={{ color: 'var(--accent-red)' }} />
        {t('catalog.title')}
      </h3>
      <p style={HINT}>
        {t('catalog.intro')}
      </p>

      <EngineCard
        engine={engine}
        onDownload={download}
        busy={!!engine?.progress || !!running}
      />

      <ReadyMadeCard
        engine={engine}
        onDownload={download}
        busy={!!engine?.progress || !!running}
        enginePresent={!(engine?.models || []).some(m => !m.present)}
      />

      {/* One progress bar for both downloads: models and published catalogs share a
          single slot on the server, so only one of them can ever be running. */}
      {engine?.progress && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <div style={{ ...ROW, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span>{engine.progress.phase === 'error' ? engine.progress.message : t('catalog.downloadingWithName', { name: engine.progress.name })}</span>
            <span>{mb(engine.progress.done)} / {mb(engine.progress.total)}</span>
          </div>
          <Bar value={pct(engine.progress.done, engine.progress.total) ?? 0} tone="var(--accent-blue, #60a5fa)" />
        </div>
      )}

      {/* Same <Step> as 1 and 2 — head, status on the right, one bordered box. It
          was a bare h4 with the note inline, which put the third step in a different
          visual class from the two above it. */}
      <Step
        n="3"
        icon={<Database size={16} style={{ color: 'var(--accent-red)' }} />}
        title={t('catalog.buildYourOwn')}
        status={t('catalog.buildYourOwnStatus')}
      >
        <p style={HINT}>
          {t('catalog.buildYourOwnDesc')}
        </p>
        {/* The speed argument, with the numbers, because it is the one benefit
            nobody can see from this panel. A ready-made catalog names cards by a
            PROVIDER id, so a scan of a card this install has never cached has to
            fetch it before it can show anything. A local catalog is keyed by
            card_cache ids, so the same step is a primary-key read. */}
        <div style={{ ...INNER, flexDirection: 'row', alignItems: 'flex-start', gap: '0.5rem' }}>
          <Zap size={15} style={{ color: 'var(--accent-blue, #60a5fa)', flexShrink: 0, marginTop: '0.1rem' }} />
          <p style={{ ...HINT, flex: 1 }}>
            <strong style={{ color: 'var(--text-strong)' }}>{t('catalog.speedTitle')}</strong>{' '}
            {t('catalog.speedDesc')}
          </p>
        </div>

        {running && (
          <div style={INNER}>
            <div style={ROW}>
              <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-strong)' }}>
                {GAME_LABEL[running.game] || running.game} · {running.lang}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={stop} disabled={running.cancelled}
                style={BTN}>
                <Square size={14} /> {running.cancelled ? t('catalog.stopping') : t('common.stop')}
              </button>
            </div>
            <div style={{ ...ROW, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <span>{phaseLabel}{running.message ? ` · ${running.message}` : ''}</span>
              <span>{running.done}/{running.total || '?'}</span>
            </div>
            <Bar value={pct(running.done, running.total) ?? 0} tone="var(--accent-red)" />
          </div>
        )}

        {!running && last && (
          <p style={{ ...HINT, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            {last.phase === 'error'
              ? <><AlertTriangle size={15} color="var(--accent-red)" /> {t('catalog.lastBuildFailed', { message: last.message })}</>
              : <><Check size={15} color="var(--accent-green)" /> {GAME_LABEL[last.game] || last.game} · {last.lang}: {last.message}</>}
          </p>
        )}

        {rows.map(renderRow)}

      </Step>
    </div>
  );
}
