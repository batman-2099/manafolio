const db = require('../db');

function composition(deck, cards) {
  return {
    format: deck.format,
    target_size: deck.target_size,
    inventory_type: deck.inventory_type,
    commander_card_id: deck.commander_card_id ?? null,
    cards: cards.map(card => ({ card_id: card.card_id, quantity: card.quantity, source_entry_id: card.source_entry_id ?? null }))
      .sort((a, b) => a.card_id.localeCompare(b.card_id))
  };
}

async function recordRevision(deckId, before, after, kind = 'save') {
  const previous = JSON.stringify(before);
  const next = JSON.stringify(after);
  if (previous === next) return;
  const latest = await db.get('SELECT snapshot FROM deck_revisions WHERE deck_id = ? ORDER BY id DESC LIMIT 1', [deckId]);
  // Capture only the state observed now, never fabricate earlier dates or edits.
  if (latest?.snapshot !== previous) {
    await db.run("INSERT INTO deck_revisions (deck_id, kind, snapshot) VALUES (?, 'baseline', ?)", [deckId, previous]);
  }
  await db.run('INSERT INTO deck_revisions (deck_id, kind, snapshot) VALUES (?, ?, ?)', [deckId, kind, next]);
}

module.exports = { composition, recordRevision };
