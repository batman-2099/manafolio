import { useState } from 'react';
import Modal from './Modal';
import { useT } from '../utils/i18n';
import { useBackGuard } from '../utils/useBackGuard';
import storageUnitTypes from '../../../shared/storageUnitTypes.json';

export function StorageUnitSelect({ units, value, onChange, disabled = false }) {
  const { t } = useT();
  return <label className="form-group">
    {t('storageUnit.storedIn')}
    <select className="input-control" value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">{t('storageUnit.none')}</option>
      {units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
    </select>
  </label>;
}

export default function StorageUnitDialog({ draft, units, onClose, onSaved, onDeleted }) {
  const { t } = useT();
  const [name, setName] = useState(draft.name || '');
  const [type, setType] = useState(draft.type || 'Other');
  const [unitId, setUnitId] = useState(draft.storage_unit_id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deleting = draft.mode === 'delete';
  const moving = draft.mode === 'move';
  const title = t(`storageUnit.${draft.mode}`);
  const close = () => { if (!busy) onClose(); };
  useBackGuard(true, close);
  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(moving ? `/api/locations/${draft.id}` : `/api/storage-units${draft.id ? `/${draft.id}` : ''}`, {
        method: deleting ? 'DELETE' : draft.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(!deleting && { body: JSON.stringify(moving ? { storage_unit_id: unitId } : { name: name.trim(), type }) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('storageUnit.saveError'));
      await onSaved(deleting ? null : data);
      onClose();
      if (deleting) requestAnimationFrame(() => onDeleted?.());
    } catch (err) {
      setError(err.message || t('storageUnit.saveError'));
    } finally { setBusy(false); }
  };
  return <Modal onClose={close} aria-labelledby="storage-unit-dialog-title">
    <form className="glass-panel" onSubmit={submit} style={{ width: '440px', maxWidth: '100%', maxHeight: '90dvh', overflowY: 'auto', padding: '1.5rem', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1rem', background: 'var(--bg-secondary)' }}>
      <h3 id="storage-unit-dialog-title" style={{ margin: 0 }}>{title}</h3>
      {deleting ? <p style={{ overflowWrap: 'anywhere' }}>{t('storageUnit.deleteHint', { name: draft.name })}</p> : moving ? <>
        <p style={{ overflowWrap: 'anywhere', margin: 0 }}>{draft.name}</p>
        <StorageUnitSelect units={units} value={unitId} onChange={setUnitId} disabled={busy} />
      </> : <>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('storageUnit.helper')}</p>
        <label className="form-group">{t('storageUnit.name')}<input autoFocus className="input-control" required maxLength={200} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
        <label className="form-group">
          {t('storageUnit.type')}
          <select className="input-control" value={type} onChange={event => setType(event.target.value)} disabled={busy}>
            {storageUnitTypes.map(unitType => <option key={unitType} value={unitType}>{unitType}</option>)}
          </select>
        </label>
      </>}
      {error && <p role="alert">{error}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.5rem' }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy || (!moving && !deleting && !name.trim())} aria-busy={busy}>{busy ? t('common.loading') : deleting ? t('storageUnit.delete') : moving ? t('storageUnit.move') : t('common.save')}</button>
      </div>
    </form>
  </Modal>;
}
