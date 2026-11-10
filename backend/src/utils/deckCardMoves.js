const db = require('../db');
const { planCardSources, sourceEntries, checkedOutSources, deckCardSources, moveContainerCopies, resolveCompartmentAndPosition } = require('./collectionHelpers');
const { rebalanceCompartmentByScheme } = require('./compartmentSort');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const total = plan => [...plan.values()].reduce((sum, quantity) => sum + quantity, 0);

function counts(cards) {
  if (!Array.isArray(cards)) fail('card_moves.before_cards must be an array.');
  const result = new Map();
  for (const card of cards) {
    if (!card || typeof card.card_id !== 'string' || !card.card_id.trim()
      || !positiveId(card.quantity) || result.has(card.card_id)) {
      fail('Card snapshots must contain unique card IDs and positive integer quantities.');
    }
    result.set(card.card_id, card.quantity);
  }
  return result;
}

// The caller owns the save transaction and supplies the original saved rows.
// In particular, AI replacement may already have deleted its old deck_cards.
async function moveDeckCardChanges({ userId, deck, beforeCards, afterCards, moves }) {
  const result = afterCards.map(card => ({ ...card }));
  if (moves === undefined) return result;
  if (!moves || typeof moves !== 'object' || Array.isArray(moves)
    || !positiveId(moves.container_id)
    || !Object.hasOwn(moves, 'removed_location_id')
    || (moves.removed_location_id !== null && !positiveId(moves.removed_location_id))) {
    fail('Invalid card_moves request.');
  }
  const inventory = deck.inventory_type || 'collection';
  if (deck.user_id !== userId || !['collection', 'graveyard'].includes(inventory)) {
    fail('Only linked Physical and Graveyard decks can move saved card changes.');
  }
  if (!deck.container_id || moves.container_id !== deck.container_id) {
    fail('The linked container changed. Reload the deck before saving.', 409);
  }
  const before = counts(beforeCards);
  const snapshot = counts(moves.before_cards);
  const after = counts(afterCards);
  if (before.size !== snapshot.size || [...before].some(([id, quantity]) => snapshot.get(id) !== quantity)) {
    fail('The saved cards changed. Reload the deck before saving.', 409);
  }
  async function container(id) {
    const location = await db.get('SELECT * FROM locations WHERE id = ? AND user_id = ?', [id, userId]);
    if (!location || location.inventory_type !== inventory || (location.game !== 'any' && location.game !== deck.game)) {
      fail('Choose a compatible container in the same inventory.');
    }
    if (location.locked) fail('A selected container is locked.');
    return location;
  }
  await container(deck.container_id);
  if (moves.removed_location_id !== null) await container(moves.removed_location_id);

  const retained = result.filter(card => before.has(card.card_id)).map(card => ({
    ...card, quantity: Math.min(before.get(card.card_id), card.quantity), kind: 'retained',
    source_entry_id: inventory === 'collection' ? card.source_entry_id : null,
  }));
  const removed = beforeCards.filter(card => card.quantity > (after.get(card.card_id) || 0)).map(card => ({
    card_id: card.card_id, quantity: card.quantity - (after.get(card.card_id) || 0), kind: 'removed',
  }));
  const added = result.filter(card => card.quantity > (before.get(card.card_id) || 0)).map(card => ({
    ...card, quantity: card.quantity - (before.get(card.card_id) || 0), kind: 'added',
    source_entry_id: inventory === 'collection' ? card.source_entry_id : null,
  }));
  if (removed.length && moves.removed_location_id === deck.container_id) {
    fail('Removed cards must leave the linked container.');
  }
  if (!removed.length && !added.length) return result;

  const reservations = await checkedOutSources(userId);
  const reserved = new Set(reservations.map(source => source.entry_id));
  const entries = (await db.all(`
    SELECT c.*, c.id AS entry_id, l.locked AS location_locked, cp.locked AS compartment_locked
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id AND cc.game = c.game
    LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
    LEFT JOIN compartments cp ON cp.id = c.compartment_id AND cp.location_id = l.id
    WHERE c.user_id = ? AND c.list_type = ? AND c.game = ? AND c.quantity > 0
      AND COALESCE(c.missing, 0) = 0
      AND (c.location_id IS NULL OR (l.id IS NOT NULL AND l.inventory_type = ?))
      AND (c.compartment_id IS NULL OR cp.id IS NOT NULL)
    ORDER BY (c.location_id = ?) DESC, c.location_id, c.compartment_id, c.position, c.id
  `, [userId, inventory, deck.game, inventory, deck.container_id]))
    .filter(entry => !reserved.has(entry.id) && !(entry.quantity > 1 && entry.cert_number));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const selectable = (candidates, card, game) => {
    if (card.kind === 'removed') {
      return sourceEntries(candidates, card, game).filter(entry => entry.location_id === deck.container_id
        && !entry.location_locked && !entry.compartment_locked);
    }
    // A preference already inside the linked container must not prevent an
    // increase from using spare copies elsewhere. Outside selections stay exact.
    const preferred = byId.get(card.source_entry_id);
    const request = card.kind === 'added' && preferred?.location_id === deck.container_id
      ? { ...card, source_entry_id: null } : card;
    return sourceEntries(candidates, request, game).filter(entry => card.kind === 'retained'
      || (!entry.location_locked && !entry.compartment_locked));
  };
  const originalRequests = [...retained, ...removed];
  const originalPlans = planCardSources(entries, originalRequests, deck.game, new Map(), selectable);
  const allocated = new Map();
  for (const plan of originalPlans) {
    for (const [id, quantity] of plan) allocated.set(id, (allocated.get(id) || 0) + quantity);
  }
  const additionPlans = planCardSources(entries, added, deck.game, allocated, selectable);
  const removalPlans = originalPlans.slice(retained.length);
  if (removed.some((card, index) => total(removalPlans[index]) !== card.quantity)
    || added.some((card, index) => total(additionPlans[index]) !== card.quantity)) {
    fail('Not enough eligible copies for these changes. Check linked storage, selected sources, missing cards, locks and deck reservations.');
  }

  // Freeze every legacy reservation before the first move changes source order.
  for (const source of reservations) {
    await db.run('INSERT OR IGNORE INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)',
      [source.deck_id, source.card_id, source.entry_id, source.quantity]);
  }
  const touched = new Set();
  async function rebalance(compartmentId) {
    if (!compartmentId) return;
    const location = await db.get(`SELECT l.sort_order, l.foil_sorting FROM locations l
      JOIN compartments cp ON cp.location_id = l.id WHERE cp.id = ? AND l.user_id = ?`, [compartmentId, userId]);
    await rebalanceCompartmentByScheme(db, compartmentId, location.sort_order, location.foil_sorting);
  }
  async function movePlan(plan, destination) {
    const movedIds = [];
    for (const [id, quantity] of plan) {
      if (!quantity) continue;
      if (byId.get(id).location_id === destination) {
        movedIds.push(id);
        continue;
      }
      for (let copy = 0; copy < quantity; copy++) {
        const entry = await db.get('SELECT * FROM collection WHERE id = ? AND user_id = ?', [id, userId]);
        const placement = await resolveCompartmentAndPosition({
          locationId: destination, userId, cardId: entry.card_id, printing: entry.printing,
          foilTreatment: entry.foil_treatment, reverseCardId: entry.reverse_card_id,
          language: entry.language, listType: inventory, quantity: 1,
        });
        if (placement.rejected) fail('The selected container has no eligible space for these cards.');
        const moved = await moveContainerCopies(userId, destination, placement.compartment_id,
          [{ ...entry, available: 1 }], 1, placement);
        movedIds.push(...moved.get(id));
        if (entry.compartment_id) touched.add(entry.compartment_id);
        await rebalance(placement.compartment_id);
      }
    }
    return movedIds;
  }
  for (const plan of removalPlans) await movePlan(plan, moves.removed_location_id);
  const addedIds = new Map();
  for (let index = 0; index < added.length; index++) {
    addedIds.set(added[index].card_id, await movePlan(additionPlans[index], deck.container_id));
  }
  for (const compartmentId of touched) await rebalance(compartmentId);

  // A stack split leaves its old ID outside. Follow the actual linked copies,
  // not the now-smaller original stack or an entry moved out with a removed face.
  for (const card of result) {
    if (inventory === 'graveyard') {
      card.source_entry_id = null;
    } else if (card.source_entry_id != null) {
      const index = retained.findIndex(row => row.card_id === card.card_id);
      const plan = originalPlans[index];
      const linked = addedIds.get(card.card_id);
      const originalSource = card.source_entry_id;
      const retainedLinkedSource = plan?.get(originalSource) && byId.get(originalSource)?.location_id === deck.container_id;
      if (!retainedLinkedSource && linked?.length) card.source_entry_id = linked.includes(originalSource) ? originalSource : linked[0];
      else if (!retainedLinkedSource && plan && !plan.get(originalSource)) {
        card.source_entry_id = [...plan].find(([, quantity]) => quantity > 0)?.[0] ?? originalSource;
      }
      // A source preference covers one compartment, not the whole container.
      // Split filing must remain checkoutable, so use Automatic if necessary.
      if (linked?.length || card.source_entry_id !== originalSource) {
        const sources = await deckCardSources(userId, deck.id, card.card_id, card.source_entry_id);
        const source = sources.find(entry => entry.entry_id === card.source_entry_id);
        if (!source || source.available < card.quantity) card.source_entry_id = null;
      }
    }
  }
  return result;
}

module.exports = { moveDeckCardChanges };
