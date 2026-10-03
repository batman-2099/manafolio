import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from './Modal';
import { useT } from '../utils/i18n';
import { useBackGuard } from '../utils/useBackGuard';
import { containerLabelUrl, containerLabelQr } from '../utils/containerLabel';
import './ContainerLabel.css';

export default function ContainerLabel({ container, onClose, returnFocus }) {
  const { t } = useT();
  const [label, setLabel] = useState(null);
  const [error, setError] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  useBackGuard(true, onClose);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/settings');
        if (!response.ok) throw new Error('Settings unavailable');
        const settings = await response.json();
        const url = containerLabelUrl(container.id, settings.public_base_url, window.location.href);
        const qr = await containerLabelQr(url);
        const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }))}`;
        if (!cancelled) setLabel({ url, image });
      } catch {
        if (!cancelled) setError(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [container.id]);

  // ponytail: one native print surface, not a label designer or a public share.
  return createPortal(
    <Modal className="container-label-dialog" onClose={onClose} returnFocus={returnFocus} aria-labelledby="container-label-title">
      <section className="glass-panel container-label-preview">
        <div className="container-label-tools">
          <h2 id="container-label-title">{t('containerLabel.title')}</h2>
          <p>{t('containerLabel.privacy')}</p>
          <p>{t('containerLabel.printHint')}</p>
        </div>
        {error ? <p role="alert">{t('containerLabel.error')}</p> : !label ? <p role="status">{t('common.loading')}</p> : <>
          <article className="container-label-paper" aria-label={t('containerLabel.title')}>
            <strong>{container.name}</strong>
            <img src={label.image} width="180" height="180" alt={t('containerLabel.qrAlt')} onLoad={() => setImageReady(true)} onError={() => setError(true)} />
            <span>Manafolio</span>
          </article>
          <p className="container-label-tools container-label-destination">{t('containerLabel.destination')}<br /><a href={label.url}>{label.url}</a></p>
        </>}
        <div className="container-label-tools container-label-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
          <button type="button" className="btn btn-primary" disabled={!imageReady || error} onClick={() => window.print()}>{t('containerLabel.print')}</button>
        </div>
      </section>
    </Modal>, document.body
  );
}
