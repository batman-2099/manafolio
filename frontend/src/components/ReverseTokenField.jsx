import { useEffect, useId, useRef, useState } from 'react';
import CardImage from './CardImage';
import SetCodeField from './SetCodeField';
import { isMtgToken } from '../utils/tokenFaces';
import { useT } from '../utils/i18n';

export default function ReverseTokenField({ card, value, onChange, disabled = false }) {
  const { t } = useT();
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [setCode, setSetCode] = useState(value?.set_id || card.set_id || '');
  const [number, setNumber] = useState('');
  const [status, setStatus] = useState('idle');
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  async function search() {
    if (disabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus('loading');
    try {
      const params = new URLSearchParams({ game: 'mtg', name: query.trim(), prints: '1', scope: 'internet', limit: '100' });
      if (setCode.trim()) params.set('set', setCode.trim().toLowerCase());
      if (number.trim()) params.set('number', number.trim());
      const response = await fetch(`/api/search?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!controller.signal.aborted) {
        const matches = data.filter(candidate => isMtgToken(candidate) && candidate.id !== (card.card_id || card.id));
        setResults(matches);
        if (number.trim() && matches.length === 1) onChange(matches[0]);
        setStatus('ready');
      }
    } catch {
      if (!controller.signal.aborted) setStatus('error');
    }
  }

  return <div className="form-group quick-add-full-width" style={{ minWidth: 0 }} onKeyDown={event => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); search(); } }}>
    <label htmlFor={`${id}-search`}>{t('token.reverse')}</label>
    <p id={`${id}-hint`} style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{t('token.pairHint')}</p>
    <div className="card-entry-fields-row-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.75rem' }}>
      <SetCodeField id={`${id}-set`} label={t('collection.fSet')} value={setCode} onChange={setSetCode} disabled={disabled} />
      <label style={{ minWidth: 0 }}>{t('search.cardNumber')}<input className="input-control" style={{ width: '100%', minWidth: 0 }} value={number} disabled={disabled} onChange={event => setNumber(event.target.value)} /></label>
    </div>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <input id={`${id}-search`} className="input-control" style={{ width: '100%', minWidth: 0, flex: 1 }} value={query} disabled={disabled} aria-describedby={`${id}-hint`} onChange={event => setQuery(event.target.value)} />
      <button type="button" className="btn btn-secondary" disabled={disabled || status === 'loading'} onClick={search}>{t(status === 'loading' ? 'common.loading' : 'shared.search')}</button>
    </div>
    {status === 'error' && <p role="alert">{t('token.searchError')}</p>}
    {status === 'loading' && <p role="status">{t('common.loading')}</p>}
    {status === 'ready' && !results.length && <p role="status">{t('token.noResults')}</p>}
    {(results.length > 0 || value) && <>
      <label htmlFor={`${id}-choice`}>{t('token.reversePrinting')}</label>
      <select id={`${id}-choice`} className="select-control" style={{ width: '100%', minWidth: 0 }} disabled={disabled} value={value?.id || ''} onChange={event => onChange(results.find(candidate => candidate.id === event.target.value) || null)}>
        <option value="">{t('token.none')}</option>
        {value && !results.some(candidate => candidate.id === value.id) && <option value={value.id}>{value.name} · {value.set_name} #{value.number}</option>}
        {results.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.printed_name || candidate.name} · {candidate.set_name} #{candidate.number} · {candidate.language}</option>)}
      </select>
      {value && <CardImage card={value} style={{ width: '100%', maxWidth: '120px', aspectRatio: '5 / 7', objectFit: 'contain', marginTop: '0.5rem' }} />}
    </>}
  </div>;
}
