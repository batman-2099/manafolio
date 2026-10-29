import { useRef, useState } from 'react';
import './CatalogueWorkbench.css';
import { Camera, Search, Award, BookOpen } from 'lucide-react';
import CameraScanner from './CameraScanner';
import CardSearch from './CardSearch';
import SlabLookup from './SlabLookup';
import MtgDeckImport from './MtgDeckImport';
import { useT } from '../utils/i18n';

function AddCards({ onAddSuccess, showToast, setActiveTab, navigationGuardRef, initialMode = 'search' }) {
  const { t } = useT();
  const [mode, setMode] = useState(initialMode);
  const localNavigationGuardRef = useRef(null);
  const modeGuardRef = navigationGuardRef || localNavigationGuardRef;
  const changeMode = nextMode => {
    if (nextMode !== mode && modeGuardRef.current?.() === false) return;
    setMode(nextMode);
  };

  // Demo build has no backend: the camera scanner and live card search can't
  // work, so show a notice instead of a broken UI.
  if (import.meta.env.VITE_DEMO) {
    return (
      <div className="glass-panel" style={{ maxWidth: '520px', margin: '2rem auto', padding: '2rem', textAlign: 'center' }}>
        <Camera size={40} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
        <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text-strong)', marginBottom: '0.75rem' }}>{t('demo.unavailableTitle')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          {t('demo.unavailableBody')}
        </p>
      </div>
    );
  }

  return (
    <div className="add-cards-workbench">
      <div className="add-cards-navigation">
        <div className="sub-nav-tabs" role="group" aria-label={t('addCards.mode')}>
          <button
            className={`sub-nav-tab ${mode === 'search' ? 'active' : ''}`}
            aria-pressed={mode === 'search'}
            onClick={() => changeMode('search')}
          >
            <Search size={18} />
            <span>{t('addCards.search')}</span>
          </button>
          <button
            className={`sub-nav-tab ${mode === 'deck' ? 'active' : ''}`}
            aria-pressed={mode === 'deck'}
            onClick={() => changeMode('deck')}
          >
            <BookOpen size={18} />
            <span>{t('addCards.deck')}</span>
          </button>
          <button
            className={`sub-nav-tab ${mode === 'scan' ? 'active' : ''}`}
            aria-pressed={mode === 'scan'}
            onClick={() => changeMode('scan')}
          >
            <Camera size={18} />
            <span>{t('addCards.scan')}</span>
          </button>
          <button
            className={`sub-nav-tab ${mode === 'slab' ? 'active' : ''}`}
            aria-pressed={mode === 'slab'}
            onClick={() => changeMode('slab')}
          >
            <Award size={18} />
            <span>{t('addCards.slab')}</span>
          </button>
        </div>
      </div>

      <div>
        {mode === 'scan' && <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />}
        {mode === 'search' && <CardSearch onAddSuccess={onAddSuccess} showToast={showToast} navigationGuardRef={modeGuardRef} />}
        {mode === 'slab' && <SlabLookup onAddSuccess={onAddSuccess} showToast={showToast} />}
        {mode === 'deck' && <MtgDeckImport onAddSuccess={onAddSuccess} showToast={showToast} navigationGuardRef={modeGuardRef} />}
      </div>
    </div>
  );
}

export default AddCards;
