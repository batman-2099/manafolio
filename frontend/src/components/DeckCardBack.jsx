import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { useT } from '../utils/i18n';
import { useBackGuard } from '../utils/useBackGuard';
import { prepareImage } from '../utils/prepareImage';
import dragonShieldSleeves from '../data/dragonShieldSleeves.json';
import ultimateGuardSleeves from '../data/ultimateGuardSleeves.json';
import ultraProSleeves from '../data/ultraProSleeves.json';

// Magic artwork © Wizards of the Coast. Bundled from Scryfall's standard card back:
// https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg
const DEFAULT_BACK = `${import.meta.env.BASE_URL}mtg-card-back.webp`;
const sleeves = [
  ...dragonShieldSleeves,
  ...ultimateGuardSleeves.map(sleeve => ({ ...sleeve, image: `${import.meta.env.BASE_URL}${sleeve.image}` })),
  ...ultraProSleeves,
];
const sleeveGroups = [
  { provider: 'Dragon Shield', plain: [], art: [] },
  { provider: 'Ultimate Guard', plain: [], art: [] },
  { provider: 'Ultra PRO', plain: [], art: [] },
];
for (const sleeve of sleeves) {
  const provider = sleeve.id.startsWith('ultimate-guard-') ? 1 : sleeve.id.startsWith('ultra-pro-') ? 2 : 0;
  const group = sleeve.group || (/(?:Classic|Matte|Matte Dual) Sleeves$/.test(sleeve.name) ? 'plain' : 'art');
  sleeveGroups[provider][group].push(sleeve);
}

function BackPreview({ color, image, label }) {
  return color
    ? <span className="deck-back-image" role="img" aria-label={label} style={{ backgroundColor: color }} />
    : <img className="deck-back-image" src={image || DEFAULT_BACK} alt={label} width="488" height="680" />;
}

export default function DeckCardBack({ deck, disabled, onSaved, onBusy }) {
  const { t } = useT();
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [selectedSleeve, setSelectedSleeve] = useState(null);
  const generation = useRef(0);
  const download = useRef(null);
  useEffect(() => () => { generation.current += 1; download.current?.abort(); }, []);
  const close = () => {
    if (saving) return false;
    generation.current += 1;
    download.current?.abort();
    setDraft(null);
    setProcessing(false);
    setError(null);
  };
  useBackGuard(!!draft, close);

  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const current = ++generation.current;
    setSelectedSleeve(null);
    setProcessing(true);
    setError(null);
    try {
      const image = await prepareImage(file);
      if (current === generation.current) setDraft({ color: null, image });
    } catch {
      if (current === generation.current) setError(t('deck.cardBackImageError'));
    } finally {
      if (current === generation.current) setProcessing(false);
    }
  };

  const importUrl = async (source, sleeve = null) => {
    const current = ++generation.current;
    download.current?.abort();
    download.current = new AbortController();
    setSelectedSleeve(sleeve);
    setProcessing(true);
    setError(null);
    try {
      const url = new URL(source);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('url');
      const response = await fetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: download.current.signal });
      if (!response.ok) throw new Error('download');
      const image = await prepareImage(await response.blob(), sleeve?.crop);
      if (current === generation.current) setDraft({ color: null, image });
    } catch {
      if (current === generation.current) {
        setSelectedSleeve(null);
        setError(t(sleeve ? 'deck.cardBackSleeveError' : 'deck.cardBackUrlError'));
      }
    } finally {
      if (current === generation.current) setProcessing(false);
    }
  };

  const save = async event => {
    event.preventDefault();
    if (saving || processing) return;
    setSaving(true);
    onBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/decks/${deck.id}/card-back`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft)
      });
      const data = await response.json();
      if (!response.ok) throw new Error('save');
      onSaved(deck.id, { card_back_color: data.card_back_color, card_back_image: data.card_back_image });
      setDraft(null);
    } catch {
      setError(t('deck.cardBackSaveError'));
    } finally {
      setSaving(false);
      onBusy(false);
    }
  };

  return <>
    <button type="button" className="deck-back-button" disabled={disabled} aria-label={t('deck.cardBackEdit')} onClick={() => {
      setDraft({ color: deck.card_back_color ?? null, image: deck.card_back_image ?? null });
      setError(null);
      setImageUrl('');
      setSelectedSleeve(null);
    }}>
      <BackPreview color={deck.card_back_color} image={deck.card_back_image} label={t('deck.cardBack')} />
      <span>{t('deck.cardBackEdit')}</span>
    </button>
    {draft && <Modal onClose={close} aria-labelledby="deck-back-title">
      <form className="glass-panel deck-back-panel" onSubmit={save} aria-busy={saving || processing}>
        <h3 id="deck-back-title">{t('deck.cardBackEdit')}</h3>
        <div className="deck-back-preview"><BackPreview {...draft} label={t('deck.cardBackPreview')} /></div>
        <p>{t('deck.cardBackHint')}</p>
        <fieldset disabled={saving || processing}>
          <label htmlFor="deck-back-sleeve">{t('deck.cardBackSleeve')}</label>
          <select id="deck-back-sleeve" className="select-control" value={selectedSleeve?.id || ''} onChange={event => {
            const sleeve = sleeves.find(({ id }) => id === event.target.value);
            if (sleeve) {
              setImageUrl('');
              importUrl(new URL(sleeve.image, window.location.href).href, sleeve);
            }
          }}>
            <option value="" disabled>{t('deck.cardBackSleeveChoose')}</option>
            {sleeveGroups.flatMap(({ provider, plain, art }) => [
              plain.length > 0 && <optgroup key={`${provider}-plain`} label={`${provider} — ${t('deck.cardBackSleevePlain')}`}>
                {plain.map(sleeve => <option key={sleeve.id} value={sleeve.id}>{sleeve.name}</option>)}
              </optgroup>,
              art.length > 0 && <optgroup key={`${provider}-art`} label={`${provider} — ${t('deck.cardBackSleeveArt')}`}>
                {art.map(sleeve => <option key={sleeve.id} value={sleeve.id}>{sleeve.name}</option>)}
              </optgroup>,
            ])}
          </select>
          {selectedSleeve && <a href={selectedSleeve.url} target="_blank" rel="noopener noreferrer">{t('deck.cardBackSleeveSource')}</a>}
          <label htmlFor="deck-back-color">{t('deck.cardBackColor')}</label>
          <input id="deck-back-color" type="color" value={draft.color || '#334155'} onChange={event => { setDraft({ color: event.target.value, image: null }); setSelectedSleeve(null); setError(null); }} />
          <label htmlFor="deck-back-upload">{t('deck.cardBackUpload')}</label>
          <input id="deck-back-upload" className="input-control" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="deck-back-upload-hint" onChange={upload} />
          <p id="deck-back-upload-hint">{t('deck.cardBackUploadHint')}</p>
          <label htmlFor="deck-back-url">{t('deck.cardBackUrl')}</label>
          <input id="deck-back-url" className="input-control" type="url" value={imageUrl} onChange={event => { setImageUrl(event.target.value); setSelectedSleeve(null); }} placeholder="https://…" aria-describedby="deck-back-url-hint" />
          <p id="deck-back-url-hint">{t('deck.cardBackUrlHint')}</p>
          <button type="button" className="btn btn-secondary" disabled={!imageUrl.trim()} onClick={() => importUrl(imageUrl)}>{t('deck.cardBackUrlLoad')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => { setDraft({ color: null, image: null }); setSelectedSleeve(null); setError(null); }}>{t('deck.cardBackReset')}</button>
        </fieldset>
        {processing && <p role="status">{t('deck.cardBackProcessing')}</p>}
        {selectedSleeve && !processing && !saving && !error && <p role="status">{t('deck.cardBackSleeveReady')}</p>}
        {saving && <p role="status">{t('deck.saving')}</p>}
        {error && <p className="deck-source-error" role="alert">{error}</p>}
        <div className="deck-back-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={close}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving || processing}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>}
  </>;
}
