import cardOrder from '../../../shared/cardOrder.json';

// Single source of truth for the rarity tiers used across LocationManager's
// visualizers (card border, badge color, badge label).
function getRarityTier(rarity) {
  const r = (rarity || '').toLowerCase();
  if (r.includes('mythic') || r.includes('bonus')) return 'top';
  if (r.includes('rare') || r.includes('promo') || r.includes('special')) return 'rare';
  if (r.includes('uncommon')) return 'uncommon';
  return 'common';
}

// Scarcity rank for sorting: higher = rarer. shared/cardOrder.json lists the
// keywords rarest first, so "Uncommon" is matched before "Common" (it contains
// the substring). Unknown rarities score 0 (before Common on ascending).
export function getRarityRank(rarity) {
  const r = (rarity || '').toLowerCase();
  for (const [kw, rank] of Object.entries(cardOrder.rarity)) {
    if (r.includes(kw)) return rank;
  }
  return 0;
}

export function getCardRarityBorder(rarity) {
  switch (getRarityTier(rarity)) {
    case 'top':
      return {
        border: '1px solid #b89153',
        boxShadow: 'none'
      };
    case 'rare':
      return {
        border: '1px solid #8899ad',
        boxShadow: 'none'
      };
    case 'uncommon':
      return {
        border: '1px solid #6086ae',
        boxShadow: 'none'
      };
    default:
      return {
        border: '1px solid rgba(255, 255, 255, 0.3)',
        boxShadow: 'none'
      };
  }
}

export function getRarityBadgeStyle(rarity) {
  const tier = getRarityTier(rarity);
  const background = tier === 'top' ? '#78551f'
    : tier === 'rare' ? '#e2e8f0'
    : tier === 'uncommon' ? '#31557c'
    : '#4b5563';
  const color = tier === 'rare' ? '#000' : '#fff';
  return { background, color };
}

export function getRarityBadgeLabel(rarity) {
  const r = (rarity || '').toLowerCase();
  if (r.includes('mythic')) return 'Mythic';
  if (r.includes('bonus')) return 'Bonus';
  if (r.includes('special')) return 'Special';
  if (r.includes('rare')) return 'Rare';
  if (r.includes('promo')) return 'Promo';
  if (r.includes('uncommon')) return 'Uncommon';
  return 'Common';
}
