import { useEffect, useRef, useState } from 'react';
import { useT } from '../utils/i18n';

export default function DeckContainerLink({ deck, disabled, onSaved, onBusy }) {
  const { t } = useT();
  const [locations, setLocations] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLocations(null);
    setLoadError(false);
    fetch(`/api/locations?inventory_type=${deck.inventory_type}`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(rows => {
        if (!controller.signal.aborted) setLocations(rows.filter(location => ['mtg', 'any'].includes(location.game)));
      })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [deck.inventory_type, retry]);

  const save = async value => {
    if (disabled || pending.current) return;
    pending.current = true;
    setSaving(true);
    setSaveError(false);
    onBusy(true);
    try {
      const response = await fetch(`/api/decks/${deck.id}/container-link`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container_id: value ? Number(value) : null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error();
      if (mounted.current) onSaved(deck.id, result);
    } catch {
      if (mounted.current) setSaveError(true);
    } finally {
      pending.current = false;
      if (mounted.current) { setSaving(false); onBusy(false); }
    }
  };

  return <div className="deck-sleeved-field" aria-busy={saving}>
    <label htmlFor="deck-linked-container">{t('deck.linkedContainer')}</label>
    <select id="deck-linked-container" className="input-control" value={deck.container_id ?? ''}
      disabled={disabled || saving || !locations} aria-describedby="deck-container-link-hint deck-container-link-status"
      onChange={event => save(event.target.value)}>
      <option value="">{t('deck.noContainer')}</option>
      {deck.container_id && !locations?.some(location => location.id === deck.container_id) && <option value={deck.container_id} disabled>{deck.container_name}</option>}
      {locations?.map(location => <option key={location.id} value={location.id}>{[location.storage_unit_name, location.name].filter(Boolean).join(' · ')}</option>)}
    </select>
    <p id="deck-container-link-hint">{t('deck.containerLinkHint')}</p>
    <div id="deck-container-link-status" role="status">
      {!locations && !loadError && <p>{t('common.loading')}</p>}
      {saving && <p>{t('deck.saving')}</p>}
    </div>
    {loadError && <p role="alert">{t('deck.containerLinkError')} <button type="button" className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button></p>}
    {saveError && <p role="alert">{t('deck.containerLinkError')}</p>}
  </div>;
}
