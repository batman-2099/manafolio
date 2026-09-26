// Single source of truth for the rarity tiers used across LocationManager's
// visualizers (card border, badge color, badge label).
export function getRarityTier(rarity) {
  const r = (rarity || '').toLowerCase();
  if (r.includes('mythic') || r.includes('enchanted') || r.includes('legendary') || r.includes('super rare')) {
    return 'top';
  }
  if (r.includes('rare') || r.includes('promo')) return 'rare';
  if (r.includes('uncommon')) return 'uncommon';
  return 'common';
}

// Scarcity rank for sorting: higher = rarer. Checked rarest-keyword first so
// "Super Rare" scores above plain rare, and "Uncommon" before
// "Common" (it contains the substring). Unknown rarities score 0 (before
// Common on ascending). Must stay aligned with RARITY_RANK in
// backend/src/utils/compartmentSort.js so display order matches placement.
const RARITY_RANK = [
  { kw: 'enchanted', rank: 9 },
  { kw: 'legendary', rank: 8 },
  { kw: 'super rare', rank: 7 },
  { kw: 'mythic', rank: 6 },
  { kw: 'promo', rank: 4 },
  { kw: 'rare', rank: 3 },
  { kw: 'uncommon', rank: 2 },
  { kw: 'common', rank: 1 },
];

export function getRarityRank(rarity) {
  const r = (rarity || '').toLowerCase();
  for (const { kw, rank } of RARITY_RANK) {
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
  if (r.includes('mythic')) return 'MYTHIC';
  if (r.includes('enchanted')) return 'ENCH';
  if (r.includes('legendary')) return 'LEG';
  if (r.includes('super rare')) return 'SR';
  if (r.includes('rare')) return 'RARE';
  if (r.includes('promo')) return 'PROMO';
  if (r.includes('uncommon')) return 'UNC';
  return 'COM';
}
