// Single source of truth for how a card's printing/finish is displayed across
// every view (Collection gallery/list, Storage visualizers, inspectors).
//
// Previously each view invented its own badge text ("HOLO" vs "Holo"), colors
// (amber/blue vs amber/gray), and foil overlay treatment, so the same card
// looked different depending on where you saw it. Everything now routes here.

// Short uppercase badge label shown on card thumbnails.
export function getPrintingBadgeLabel(printing) {
  switch (printing) {
    case 'Holofoil': return 'FOIL';
    default: return '';
  }
}

// Badge background/text colors.
export function getPrintingBadgeStyle(printing) {
  switch (printing) {
    case 'Holofoil':
      return { background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', color: '#1a1206' };
    default:
      return { background: 'rgba(148, 163, 184, 0.85)', color: '#0a0f1d' };
  }
}

// Returns the CSS class for the animated foil overlay, or null for finishes
// that get no shine. Holofoil uses the rainbow prism.
export function getFoilOverlayClass(printing) {
  if (printing === 'Holofoil') return 'holo-shine-overlay';
  return null;
}
