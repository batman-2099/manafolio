import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import Modal from './Modal';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

export default function CardAiExplain({ cardId, disabled, style }) {
  const { locale, t } = useT();
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState('');
  const request = useRef(null);
  const trigger = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/ai-decks/account', { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(account => { if (!controller.signal.aborted) setConnected(account.connected === true); })
      .catch(() => {}); // Pending, disconnected and failed status all keep the action hidden.
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, []);

  const close = () => {
    request.current?.abort();
    setOpen(false);
    setExplanation('');
    setError('');
  };
  useBackGuard(open, close);

  const explain = async () => {
    if (disabled || !connected || (request.current && !request.current.signal.aborted)) return;
    const controller = new AbortController();
    request.current = controller;
    setOpen(true);
    setLoading(true);
    setExplanation('');
    setError('');
    try {
      const response = await fetch('/api/ai-decks/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ card_id: cardId, locale }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('aiExplain.failed'));
      if (typeof data.explanation !== 'string' || !data.explanation.trim()) throw new Error(t('aiExplain.failed'));
      if (!controller.signal.aborted) setExplanation(data.explanation);
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message || t('aiExplain.failed'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  };

  if (!connected) return null;
  return <>
    <button ref={trigger} type="button" className="btn btn-secondary" style={style} disabled={disabled} title={t('aiExplain.notice')} onClick={explain}>
      {t('aiExplain.button')}
    </button>
    {open && <Modal onClose={close} returnFocus={trigger.current} aria-labelledby={titleId}>
      <div className="glass-panel" style={{ width: '640px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', textAlign: 'left', overflowWrap: 'anywhere' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
          <h3 id={titleId} style={{ margin: 0 }}>{t('aiExplain.button')}</h3>
          <button type="button" className="btn btn-secondary" onClick={close}>{t('common.close')}</button>
        </div>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('aiExplain.notice')}</p>
        {loading && <p role="status" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <LoaderCircle size={24} className="spin-animation ai-waiting-icon" aria-hidden="true" />
          {t('aiExplain.loading')}
        </p>}
        {error && <div>
          <p role="alert" style={{ color: 'var(--accent-red)' }}>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={explain} disabled={disabled}>{t('common.retry')}</button>
        </div>}
        {explanation && <div role="status" style={{ whiteSpace: 'pre-wrap' }}>{explanation}</div>}
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('aiExplain.caution')}</p>
      </div>
    </Modal>}
  </>;
}
