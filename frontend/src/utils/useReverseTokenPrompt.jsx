import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Modal from '../components/Modal';
import ReverseTokenField from '../components/ReverseTokenField';
import { useBackGuard } from './useBackGuard';
import { useT } from './i18n';
import { isMtgToken, reverseFace } from './tokenFaces';

export function useReverseTokenPrompt() {
  const { t } = useT();
  const titleId = useId();
  const [card, setCard] = useState(null);
  const [reverseCard, setReverseCard] = useState(null);
  const pending = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.(null);
      pending.current = null;
    };
  }, []);

  const finish = useCallback(result => {
    const resolve = pending.current;
    pending.current = null;
    setCard(null);
    resolve?.(result);
  }, []);
  useBackGuard(!!card, () => finish(null));

  const requestReverse = useCallback((front, { inventoryType = 'collection', reverseCard: selected = null } = {}) => {
    if (!mounted.current || pending.current) return Promise.resolve(null);
    if (inventoryType === 'arena') return Promise.resolve({ reverseCard: null });
    if (!isMtgToken(front) || selected || front.reverse_card_id) {
      return Promise.resolve({ reverseCard: selected || (front.reverse_card_id ? reverseFace(front) : null) });
    }
    return new Promise(resolve => {
      pending.current = resolve;
      setReverseCard(null);
      setCard(front);
    });
  }, []);

  const reversePrompt = card && (
    <Modal onClose={() => finish(null)} aria-labelledby={titleId} style={{ padding: '1rem' }}>
      <div className="glass-panel" style={{ width: 'min(520px, 100%)', maxHeight: '90dvh', overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h2 id={titleId}>{t('token.promptTitle')}</h2>
        <p>{card.printed_name || card.name}</p>
        <p style={{ color: 'var(--text-secondary)' }}>{t('token.promptHint')}</p>
        <ReverseTokenField key={card.card_id || card.id} card={card} value={reverseCard} onChange={setReverseCard} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <button type="button" className="btn btn-secondary" onClick={() => finish(null)}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => finish({ reverseCard: null })}>{t('token.continueWithout')}</button>
          <button type="button" className="btn btn-primary" disabled={!reverseCard} onClick={() => finish({ reverseCard })}>{t('token.useReverse')}</button>
        </div>
      </div>
    </Modal>
  );
  return { requestReverse, reversePrompt };
}
