import assert from 'node:assert';
import { arenaCardKey, buildDeckExport, parseDeckLine, ownedImportIndex, findOwnedImportCard } from './deckText.js';

const cards = [
  { quantity: 4, name: 'Lightning Bolt', set_id: '2x2', number: '117', supertype: 'MTG' },
  { quantity: 2, name: 'Llanowar Elves', set_id: 'fdn', number: '227', supertype: 'MTG' },
  { quantity: 6, name: 'Forest', set_id: 'fdn', number: '280', supertype: 'MTG' },
];

const mtga = buildDeckExport(cards, 'mtga');
assert.ok(mtga.startsWith('Deck\n'), 'mtga header');
assert.ok(mtga.includes('4 Lightning Bolt (2X2) 117'), 'mtga card line');

assert.strictEqual(buildDeckExport(cards, 'plain').split('\n')[0], '4 Lightning Bolt', 'plain line');

assert.deepStrictEqual(parseDeckLine('4 Lightning Bolt (2X2) 117'), { qty: 4, name: 'Lightning Bolt', setCode: '2x2', number: '117' });
assert.deepStrictEqual(parseDeckLine('2 Forest (FDN) #280'), { qty: 2, name: 'Forest', setCode: 'fdn', number: '280' });
assert.deepStrictEqual(parseDeckLine('4 Llanowar Elves'), { qty: 4, name: 'Llanowar Elves' });
assert.strictEqual(parseDeckLine('not a card line'), null);

const arenaLines = `3 Llanowar Elves (FDN) 227
4 Druid of the Cowl (FDN) 554
3 Nessian Hornbeetle (FDN) 229
2 Beast-Kin Ranger (FDN) 100
2 Eager Trufflesnout (FDN) 102
2 Needletooth Pack (FDN) 108
2 Magnigoth Sentry (FDN) 556
1 Scavenging Ooze (FDN) 232
1 Ashroot Animist (FDN) 117
1 Loot, Exuberant Explorer (FDN) 106
1 Mossborn Hydra (FDN) 107
1 Spinner of Souls (FDN) 112
1 Vizier of the Menagerie (FDN) 769
1 Quilled Greatwurm (FDN) 111
1 Rampaging Baloths (FDN) 645
1 Rip, Spawn Hunter (DSK) 228
2 Snakeskin Veil (FDN) 233
2 Snakeskin Veil (TDM) 159
2 Giant Growth (FDN) 223
1 Giant Growth (MSH) 167
1 Garruk's Uprising (FDN) 220
1 Primeval Bounty (FDN) 644
1 Bushwhack (FDN) 215
1 Over the Edge (LCI) 205
1 Forest (AFR) 278
1 Forest (AFR) 279
1 Forest (AFR) 280
1 Forest (AFR) 281
1 Forest (DFT) 289
1 Forest (DFT) 290
1 Forest (DFT) 291
1 Forest (DMU) 274
1 Forest (DMU) 275
1 Forest (DMU) 276
1 Forest (SIR) 289
1 Forest (SIR) 290
1 Forest (SIR) 291
1 Forest (STX) 374
1 Forest (STX) 375
1 Forest (WOE) 275
1 Forest (WOE) 276
1 Forest (DSK) 285
1 Forest (DSK) 286
1 Forest (OTJ) 285
1 Forest (OTJ) 286
1 Forest (FDN) 280`;
const parsedArenaLines = arenaLines.split('\n').map(parseDeckLine);
assert.ok(parsedArenaLines.every(Boolean), 'all supplied Arena lines parse');
assert.strictEqual(parsedArenaLines.reduce((total, card) => total + card.qty, 0), 60, 'Arena deck quantity');
assert.strictEqual(
  new Set(parsedArenaLines.filter(card => card.name === 'Forest').map(card => arenaCardKey(card.name, card.setCode, card.number))).size,
  22,
  'Forest printings with the same name remain distinct'
);

const arenaForests = new Map(parsedArenaLines
  .filter(card => card.name === 'Forest')
  .map(card => [arenaCardKey(card.name, card.setCode, card.number), card.number]));
assert.strictEqual(arenaForests.get(arenaCardKey('Forest', 'AFR', '278')), '278');
assert.strictEqual(arenaForests.get(arenaCardKey('Forest', 'AFR', '279')), '279');

const owned = [
  { id: 'first', name: 'Forest', set_id: 'mtg-afr', number: '278', owned_qty: 5 },
  { id: 'second', name: 'Forest', printed_name: 'Wald', set_id: 'mtg-afr', number: '279', owned_qty: 1 },
];
const index = ownedImportIndex(owned);
assert.strictEqual(findOwnedImportCard(parseDeckLine('1 Forest (AFR) 279'), index), owned[1]);
assert.strictEqual(findOwnedImportCard(parseDeckLine('1 Wald (AFR) 279'), index), owned[1]);
assert.strictEqual(findOwnedImportCard(parseDeckLine('1 Forest'), index), owned[0]);
assert.strictEqual(findOwnedImportCard(parseDeckLine('1 Forest (AFR) 280'), index), null);
assert.strictEqual(findOwnedImportCard(parseDeckLine('1 Forest (FDN) 279'), index), null);

console.log('deckText self-check passed');

// buylist: only shortfall vs owned, TCGplayer mass-entry lines
const bl = buildDeckExport([
  { quantity: 4, name: 'Lightning Bolt', owned_qty: 1 },
  { quantity: 2, name: 'Llanowar Elves', owned_qty: 2 },
  { quantity: 3, name: 'Forest', owned_qty: 0 },
], 'buylist');
assert.strictEqual(bl, '3 Lightning Bolt\n3 Forest', 'buylist shortfall lines');

console.log('deckText buylist check passed');
