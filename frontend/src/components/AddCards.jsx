import { useState } from 'react';
import { Camera, Search, Award, BookOpen } from 'lucide-react';
import CameraScanner from './CameraScanner';
import CardSearch from './CardSearch';
import SlabLookup from './SlabLookup';
import MtgDeckImport from './MtgDeckImport';
import { useT } from '../utils/i18n';

function AddCards({ onAddSuccess, showToast, setActiveTab, initialMode = 'search' }) {
  const { t } = useT();
  const [mode, setMode] = useState(initialMode);

  // Demo build has no backend: the camera scanner and live card search can't
  // work, so show a notice instead of a broken UI.
  if (import.meta.env.VITE_DEMO) {
    return (
      <div className="glass-panel" style={{ maxWidth: '520px', margin: '2rem auto', padding: '2rem', textAlign: 'center' }}>
        <Camera size={40} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.75rem' }}>{t('demo.unavailableTitle')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          {t('demo.unavailableBody')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', gap: '1rem', position: 'relative' }}>
        <div className="sub-nav-tabs" style={{ width: '100%', maxWidth: '520px', margin: 0 }}>
          <button
            className={`sub-nav-tab ${mode === 'search' ? 'active' : ''}`}
            onClick={() => setMode('search')}
          >
            <Search size={18} />
            <span>{t('addCards.search')}</span>
          </button>
          {/* A slab is a third way in, not a variant of the other two: the camera
              cannot read a cert number through the plastic, and searching by name
              cannot tell you the grade. The number on the label does both. */}
          <button
            className={`sub-nav-tab ${mode === 'slab' ? 'active' : ''}`}
            onClick={() => setMode('slab')}
          >
            <Award size={18} />
            <span>{t('addCards.slab')}</span>
          </button>
          <button
            className={`sub-nav-tab ${mode === 'deck' ? 'active' : ''}`}
            onClick={() => setMode('deck')}
          >
            <BookOpen size={18} />
            <span>{t('addCards.deck')}</span>
          </button>
          <button
            className={`sub-nav-tab ${mode === 'scan' ? 'active' : ''}`}
            onClick={() => setMode('scan')}
          >
            <Camera size={18} />
            <span>{t('addCards.scan')}</span>
            <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '0.1rem 0.3rem', borderRadius: 'var(--radius-sm)', border: '1px solid currentColor', color: 'var(--accent-yellow)' }}>{t('addCards.beta')}</span>
          </button>
        </div>
      </div>

      <div>
        {mode === 'scan' && <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />}
        {mode === 'search' && <CardSearch onAddSuccess={onAddSuccess} showToast={showToast} />}
        {mode === 'slab' && <SlabLookup onAddSuccess={onAddSuccess} showToast={showToast} />}
        {mode === 'deck' && <MtgDeckImport onAddSuccess={onAddSuccess} showToast={showToast} />}
      </div>
    </div>
  );
}

export default AddCards;
