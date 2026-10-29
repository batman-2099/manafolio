import { useEffect, useRef, useState } from 'react';
import { X, BookOpen, Box, Package, Award, LayoutGrid, Layers, Archive, HelpCircle, ArrowLeft, ArrowRight } from 'lucide-react';
import { SortBuilder, FilterBuilder } from './SortFilterBuilder';
import { isBinderType, containerTypeKey } from '../utils/cardOptions';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';
import Modal from './Modal';
import { StorageUnitSelect } from './StorageUnitDialog';

// Container types and their default layout. Counts kept modest; the user adjusts
// them on step 2. Mirrors defaultCompartmentPlan in
// backend/src/routes/collection.js.
//
// `type` is the value stored in the database and must stay English; its label and
// blurb are looked up under containerTypeKey(type).
const TYPE_META = [
  { type: 'Binder', icon: BookOpen, plan: { count: 10, capacity: 9 } },
  { type: 'Toploader Binder', icon: LayoutGrid, plan: { count: 8, capacity: 4 } },
  { type: 'Box', icon: Box, plan: { count: 2, capacity: 400 } },
  { type: 'Toploader Box', icon: Package, plan: { count: 1, capacity: 100 } },
  { type: 'Graded Slab Box', icon: Award, plan: { count: 1, capacity: 40 } },
  { type: 'Display Shelf / Stand', icon: Layers, plan: { count: 1, capacity: 10 } },
  { type: 'Deck Box', icon: Archive, plan: { count: 1, capacity: 60 } },
  { type: 'Tin / Case', icon: Archive, plan: { count: 1, capacity: 200 } },
  { type: 'Other', icon: HelpCircle, plan: { count: 1, capacity: 500 } },
];

// Binders hold pages, everything else holds rows. Returns the key half so the
// label, the "cards per ..." label and the summary sentence all stay one phrase
// per language instead of an English noun glued into a translated sentence.
const compartmentKind = (type) => (isBinderType(type) ? 'page' : 'row');

const STEPS = ['type', 'layout', 'sort', 'filing'];

export default function CreateContainerModal({ onClose, onCreate, setsList = [], filterFieldOptions = {}, storageUnits = [], initialStorageUnitId = null, storageUnitsLoading = false, storageUnitsError = false, onRetryStorageUnits, children }) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [type, setType] = useState('Binder');
  const [name, setName] = useState('');
  const [storageUnitId, setStorageUnitId] = useState(initialStorageUnitId);
  const [sleeved, setSleeved] = useState(0);
  const game = 'mtg';
  const [count, setCount] = useState(TYPE_META[0].plan.count);
  const [capacity, setCapacity] = useState(TYPE_META[0].plan.capacity);
  const [sortDraft, setSortDraft] = useState([]);
  const [filterDraft, setFilterDraft] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const headingRef = useRef(null);
  const previousStep = useRef(step);
  const [submitError, setSubmitError] = useState(false);
  const close = () => {
    if (busy.current) return false;
    onClose();
  };
  useBackGuard(true, close);
  useEffect(() => {
    if (previousStep.current !== step) {
      headingRef.current?.focus();
      previousStep.current = step;
    }
  }, [step]);

  const pickType = (next) => {
    setType(next);
    const meta = TYPE_META.find(m => m.type === next);
    if (meta) { setCount(meta.plan.count); setCapacity(meta.plan.capacity); }
  };

  const kind = compartmentKind(type);
  const typeLabel = (meta) => t(`container.type.${containerTypeKey(meta.type)}`);

  const validLayout = name.trim().length > 0 && [count, capacity].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0);
  const next = () => {
    if (!busy.current && (step !== 1 || validLayout)) setStep(step + 1);
  };

  const submit = async () => {
    if (busy.current || !validLayout) return;
    busy.current = true;
    setSubmitting(true);
    setSubmitError(false);
    const payload = {
      name: name.trim(),
      type,
      game,
      sleeved,
      storage_unit_id: storageUnitId,
      compartmentPlan: { count: Number(count), capacity: Number(capacity) },
      sort_order: sortDraft.length > 0 ? JSON.stringify(sortDraft) : 'custom',
      rule_type: filterDraft.length > 0 ? 'compound' : 'any',
      rule_config: filterDraft.length > 0 ? JSON.stringify({ rules: filterDraft }) : null,
    };
    try {
      await onCreate(payload);
    } catch {
      setSubmitError(true);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={close} aria-labelledby="create-container-title">
      <div className="glass-panel create-container-dialog" style={{ width: '560px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }} onClick={(e) => e.stopPropagation()}>
        {/* Header + step indicator */}
        <div className="storage-dialog-heading">
          <h3 id="create-container-title" ref={headingRef} tabIndex={-1} style={{ margin: 0 }}>{t('container.newTitle')} · {t(`container.step.${STEPS[step]}`)}</h3>
          <button className="btn btn-secondary btn-icon-only" disabled={submitting} aria-label={t('common.close')} onClick={close} style={{ width: '44px', height: '44px', padding: 0 }}><X size={15} /></button>
        </div>
        {step === 0 && children}
        <div className="storage-creation-steps">
          {STEPS.map((s, i) => (
            <div key={s} aria-current={i === step ? 'step' : undefined}>
              <div style={{ height: '4px', borderRadius: '2px', background: i <= step ? 'var(--accent-red)' : 'var(--border-glass)' }} />
              <span>{i + 1}. {t(`container.step.${s}`)}</span>
            </div>
          ))}
        </div>
        <p aria-live="polite" aria-atomic="true" style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{t(`container.step.${STEPS[step]}`)} · {t('setup.stepCount', { step: step + 1, total: STEPS.length })}</p>

        {/* Step 1: Type */}
        {step === 0 && (
          <div className="storage-container-types">
            {TYPE_META.map((meta) => (
              <button
                key={meta.type}
                type="button"
                className="storage-container-type"
                onClick={() => pickType(meta.type)}
                aria-pressed={type === meta.type}
                title={t(`container.blurb.${containerTypeKey(meta.type)}`)}
              >
                <span>
                  <meta.icon size={18} aria-hidden="true" /> {typeLabel(meta)}
                </span>
                <span>{t(`container.blurb.${containerTypeKey(meta.type)}`)}</span>
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Layout */}
        {step === 1 && (
          <form id="container-layout-form" onSubmit={event => { event.preventDefault(); if (event.currentTarget.reportValidity()) next(); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="create-container-name">{t('container.name')}</label>
              <input id="create-container-name" required pattern=".*\S.*" disabled={submitting} className="input-control" placeholder={t('container.namePlaceholder', { type: typeLabel(TYPE_META.find(m => m.type === type) || TYPE_META[0]) })} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {storageUnitsLoading && <p role="status">{t('common.loading')}</p>}
            {storageUnitsError && <div role="alert"><p>{t('storageUnit.loadError')}</p><button type="button" className="btn btn-secondary" onClick={onRetryStorageUnits}>{t('loc.retry')}</button></div>}
            <StorageUnitSelect units={storageUnits} value={storageUnitId} onChange={setStorageUnitId} disabled={submitting || storageUnitsLoading || storageUnitsError} />
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="create-container-sleeved">{t('deck.sleeved')}</label>
              <select id="create-container-sleeved" className="input-control" value={sleeved} disabled={submitting} onChange={(e) => setSleeved(Number(e.target.value))}>
                <option value={0}>{t('deck.sleevedNone')}</option>
                <option value={1}>{t('deck.sleevedOne')}</option>
                <option value={2}>{t('deck.sleevedDouble')}</option>
                <option value={3}>{t('deck.sleevedTriple')}</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="create-container-count">{t(`container.${kind}.label`)}</label>
                <input id="create-container-count" type="number" required min="1" max={Number.MAX_SAFE_INTEGER} step="1" disabled={submitting} className="input-control" value={count} onChange={(e) => setCount(e.target.value)} style={{ width: '110px' }} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="create-container-capacity">{t(`container.${kind}.perLabel`)}</label>
                <input id="create-container-capacity" type="number" required min="1" max={Number.MAX_SAFE_INTEGER} step="1" disabled={submitting} className="input-control" value={capacity} onChange={(e) => setCapacity(e.target.value)} style={{ width: '110px' }} />
              </div>
            </div>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
              {t(`container.${kind}.summary`, {
                count: Number(count) || 0,
                capacity: Number(capacity) || 0,
                total: (Number(count) || 0) * (Number(capacity) || 0),
              })}
            </p>
          </form>
        )}

        {/* Step 3: Sort */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
              {t('container.sortHint')}
            </p>
            <SortBuilder value={sortDraft} onChange={setSortDraft} />
          </div>
        )}

        {/* Step 4: Filing rules */}
        {step === 3 && (
          <form id="container-filing-form" onSubmit={event => { event.preventDefault(); submit(); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
              {t('container.filingHint')}
            </p>
            <fieldset disabled={submitting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <FilterBuilder value={filterDraft} onChange={value => { if (!busy.current) setFilterDraft(value); }} setsList={setsList} fieldOptions={filterFieldOptions} />
            </fieldset>
          </form>
        )}
        {submitError && <p role="alert">{t('loc.errCreate')}</p>}
        {submitting && <p role="status">{t('container.creating')}</p>}

        {/* Footer nav */}
        <div className="storage-dialog-actions">
          <button className="btn btn-secondary" disabled={submitting} onClick={() => { if (!busy.current) { if (step === 0) close(); else setStep(step - 1); } }} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            {step === 0 ? t('common.cancel') : (<><ArrowLeft size={14} aria-hidden="true" /> {t('common.back')}</>)}
          </button>
          {step < STEPS.length - 1 ? (
            <button type={step === 1 ? 'submit' : 'button'} form={step === 1 ? 'container-layout-form' : undefined} className="btn btn-primary" disabled={submitting} onClick={step === 1 ? undefined : next} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              {t('common.next')} <ArrowRight size={14} aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" form="container-filing-form" className="btn btn-primary" disabled={submitting || !name.trim()}>
              {t(submitting ? 'container.creating' : 'container.create')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
