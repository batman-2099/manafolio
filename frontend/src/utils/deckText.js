// Deck decklist text <-> card list. Export builds standard formats that paste
// into MTG Arena (mtga) or a plain generic list.
// parseDeckLine is the inverse used by import so the app round-trips its own
// export (and tolerates lists copied out of those tools).

// Set codes are exported as the stored provider abbreviation.
function cardLine(c, format) {
  const set = String(c.set_id || c.set_code || '').toUpperCase();
  const num = c.number || '';
  if (format === 'mtga') return `${c.quantity} ${c.name}${set ? ` (${set})` : ''}${num ? ` ${num}` : ''}`;
  return `${c.quantity} ${c.name}`; // plain
}

export function buildDeckExport(cards, format = 'plain') {
  if (!cards || !cards.length) return '';

  // Buylist: only the copies the deck needs beyond what's already owned,
  // as TCGplayer Mass Entry lines ("2 Card Name"). owned_qty comes from the
  // deck detail query.
  if (format === 'buylist') {
    return cards
      .map(c => ({ name: c.name, need: Math.max(0, (c.quantity || 0) - (c.owned_qty || 0)) }))
      .filter(c => c.need > 0)
      .map(c => `${c.need} ${c.name}`)
      .join('\n');
  }

  if (format === 'mtga') {
    return 'Deck\n' + cards.map(c => cardLine(c, 'mtga')).join('\n');
  }

  return cards.map(c => cardLine(c, 'plain')).join('\n');
}

// Pull quantity, name, and (when present) the exact Arena printing out of one
// decklist line. Name-only input remains supported for generic decklists.
export function parseDeckLine(line) {
  const m = String(line).trim().match(/^(\d+)x?\s+(.+)$/i);
  if (!m) return null;
  const qty = parseInt(m[1], 10);
  let name = m[2];
  const arena = name.match(/^(.+?)\s+\(([A-Za-z0-9]{2,6})\)\s+#?(\d+[a-zA-Z]?)\s*$/);
  const printing = arena && { setCode: arena[2].toLowerCase(), number: arena[3].toLowerCase() };

  name = name
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*#\d+[a-zA-Z]?\s*$/, '')
    .replace(/\s+\d+[a-zA-Z]?$/, '')
    .trim();

  return name ? { qty, name, ...printing } : null;
}

export function arenaCardKey(name, setId, number) {
  return `${String(name).trim().toLowerCase()}\0${String(setId).replace(/^mtg-/i, '').toLowerCase()}\0${String(number).toLowerCase()}`;
}
