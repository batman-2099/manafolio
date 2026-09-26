import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';

// Full-screen card art viewer, shared by the collection inspector and the
// Search & Add quick-add drawer so "tap the art to enlarge" works the same
// everywhere. Callers own the open/closed flag and render this when open.
//
// Takes the whole card rather than a URL so a card with no art enlarges to its
// card back instead of to a broken image at full screen size.
//
// stopPropagation on every click: both callers sit inside an overlay whose own
// click handler dismisses the popup, so without it, closing the zoom would
// dismiss the popup underneath as well.
export default function CardImageZoom({ card, onClose }) {
  const { t } = useT();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('inspector.fullScreen')}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="modal-overlay"
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.92)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        cursor: 'zoom-out',
        padding: 'max(1rem, env(safe-area-inset-top, 0px)) 1rem max(1rem, env(safe-area-inset-bottom, 0px)) 1rem'
      }}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label={t('common.close')}
        className="btn btn-secondary btn-icon-only"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          position: 'absolute',
          top: 'max(1rem, env(safe-area-inset-top, 0px))',
          right: '1rem',
          borderRadius: '50%',
          zIndex: 10,
          background: 'rgba(0,0,0,0.6)',
          color: '#fff'
        }}
      >
        <X size={20} />
      </button>
      <CardImage
        card={card}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxHeight: '88vh',
          maxWidth: '88vw',
          objectFit: 'contain',
          /* No border-radius: the card art already has its own rounded
             corners, so a CSS radius here clips them. drop-shadow follows
             the image's own shape instead of a rounded box. */
          filter: 'drop-shadow(0 20px 60px rgba(0,0,0,0.8))'
        }}
      />
    </dialog>
  );
}
