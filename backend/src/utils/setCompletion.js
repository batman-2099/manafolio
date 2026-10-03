// Set + collector number defines a printing across languages. Oracle identity
// groups alternate art, never names. Only copies from this set satisfy its goals.
function setCompletion(catalog, entries, inventory) {
  const printings = new Map();
  for (const card of catalog) {
    if (!card.games.includes(inventory === 'arena' ? 'arena' : 'paper')) continue;
    const key = `${card.set_id}:${card.number}`;
    if (!printings.has(key)) printings.set(key, { ...card, recorded: 0, owned: 0, available: 0, foil: 0, foil_recorded: 0, foil_available: 0 });
  }
  for (const entry of entries) {
    if (entry.list_type !== inventory || entry.quantity <= 0) continue;
    const card = printings.get(`${entry.set_id}:${entry.number}`);
    if (!card) continue;
    card.recorded += entry.quantity;
    if (entry.printing === 'Holofoil') card.foil_recorded += entry.quantity;
    if (entry.missing) continue;
    card.owned += entry.quantity;
    card.available += Math.max(0, entry.available ?? entry.quantity);
    if (entry.printing === 'Holofoil') {
      card.foil += entry.quantity;
      card.foil_available += Math.max(0, entry.available ?? entry.quantity);
    }
  }
  const exact = [...printings.values()];
  const identities = new Map();
  for (const card of exact) {
    if (!identities.has(card.oracle_id)) identities.set(card.oracle_id, []);
    identities.get(card.oracle_id).push(card);
  }
  const summarize = groups => {
    const rows = groups.map(cards => ({
      id: cards[0].id, name: cards[0].name, printings: cards,
      owned: cards.some(card => card.owned > 0),
    }));
    return { total: rows.length, owned: rows.filter(row => row.owned).length, rows };
  };
  return {
    cards: summarize([...identities.values()]),
    printings: summarize(exact.map(card => [card])),
    foil: summarize(inventory === 'arena' ? [] : exact.filter(card => card.finishes.includes('foil')).map(card => [{
      ...card, owned: card.foil, recorded: card.foil_recorded, available: card.foil_available,
    }])),
  };
}
module.exports = { setCompletion };
