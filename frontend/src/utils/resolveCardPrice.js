// Mirrors backend/src/utils/priceHelpers.js's resolveCardPrice. Card search
// results and scan results carry per-printing prices (price_normal,
// price_holofoil) alongside a generic price_trend
// (whichever finish the TCG API happened to return first — usually Normal).
// Anywhere a specific printing is selected before the card is saved, use
// this so the displayed/recorded price matches that printing instead of
// silently showing a different finish's price.
export function resolveCardPrice(card, printing) {
  if (!card) return 0;
  // Owner-set or graded-provider value for this copy. See the backend twin.
  if (card.market_value > 0) return card.market_value;
  if (printing === 'Holofoil' && card.price_holofoil > 0) return card.price_holofoil;
  if (printing === 'Normal' && card.price_normal > 0) return card.price_normal;
  return card.price_trend || 0;
}

// A finish quote must not borrow a generic trend or an owner's copy valuation.
export function getPrintingPrice(card, printing) {
  const raw = printing === 'Normal' ? card?.price_normal : printing === 'Holofoil' ? card?.price_holofoil : null;
  const price = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(price) && price > 0 ? price : null;
}
