import { useEffect, useRef } from 'react';

export default function Modal({ onClose, returnFocus, children, className = '', style, ...props }) {
  const dialogRef = useRef(null);
  const triggerRef = useRef(returnFocus || null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = triggerRef.current || document.activeElement;
    triggerRef.current = trigger;
    dialog.showModal();
    dialog.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      {...props}
      ref={dialogRef}
      tabIndex={-1}
      className={`modal-overlay ${className}`}
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)', ...style }}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      {children}
    </dialog>
  );
}
