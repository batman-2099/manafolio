// Single source of truth for how a card's printing/finish is displayed across
// every view (Collection gallery/list, Storage visualizers, inspectors).
//
// Previously each view invented its own badge text ("HOLO" vs "Holo"), colors
// (amber/blue vs amber/gray), and foil overlay treatment, so the same card
// looked different depending on where you saw it. Everything now routes here.

// Short uppercase badge label shown on card thumbnails.
export function getPrintingBadgeLabel(printing, foilTreatment) {
  if (printing === 'Holofoil' && foilTreatment) return ({
    etched: 'FOIL-ETCHED', traditional: 'TRADITIONAL FOIL', textured: 'TEXTURED FOIL',
    surge: 'SURGE FOIL', galaxy: 'GALAXY FOIL', halo: 'HALO FOIL',
    raised: 'RAISED FOIL', neon_ink: 'NEON INK FOIL', double_rainbow: 'DOUBLE RAINBOW FOIL',
  })[foilTreatment] || 'FOIL';
  switch (printing) {
    case 'Holofoil': return 'FOIL';
    default: return '';
  }
}

// Badge background/text colors.
export function getPrintingBadgeStyle(printing, foilTreatment) {
  switch (printing) {
    case 'Holofoil':
      return {
        background: ({
          traditional: '#e5cf9f',
          etched: '#b9c5d2',
          textured: '#e8ac85',
          surge: '#8dcaf4',
          galaxy: '#c5acf0',
          halo: '#f4b9d6',
          raised: '#a5d6a7',
          neon_ink: '#d3e77c',
          double_rainbow: '#86dace',
        })[foilTreatment] || '#d3ba89',
        color: '#1a1206',
      };
    default:
      return { background: 'rgba(148, 163, 184, 0.85)', color: '#0a0f1d' };
  }
}

// Returns the static foil overlay class, or null for finishes without shine.
export function getFoilOverlayClass(printing) {
  if (printing === 'Holofoil') return 'holo-shine-overlay';
  return null;
}
