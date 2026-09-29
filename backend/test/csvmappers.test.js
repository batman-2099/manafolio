const assert = require('assert');
const { parseThirdPartyCSV } = require('../src/utils/csvMappers');

const row = {
  'Card Name': 'Lightning Bolt', Name: 'Wrong name', 'Set Code': 'lea', Set: 'Wrong set',
  Number: '161', 'Card Number': '162', Quantity: '3', Condition: 'LP', Printing: 'Foil',
};
for (const [format, number] of [['tcgplayer', '161'], ['dragonshield', '162']]) {
  assert.deepStrictEqual(parseThirdPartyCSV([row], format), [{
    name: 'Lightning Bolt', set_code: 'lea', collector_number: number,
    quantity: 3, condition: 'Lightly Played', printing: 'Holofoil', game: 'mtg',
  }], `${format} must keep its own precedence when both collector columns exist`);
  const fallback = { Name: 'Sol Ring', Set: 'cmd', Number: '246', 'Card Number': '247' };
  fallback[format === 'tcgplayer' ? 'Number' : 'Card Number'] = '';
  assert.strictEqual(parseThirdPartyCSV([fallback], format)[0].collector_number,
    format === 'tcgplayer' ? '247' : '246', 'an empty preferred column falls back to the other');
}
for (const format of ['internal', 'arena', 'tcgplayer', 'dragonshield', 'manabox', 'custom']) {
  const mapping = format === 'custom' ? { name: 'Name', quantity: 'Count' } : undefined;
  for (const [raw, expected] of [['0', 0], ['-2', -2], ['1.5', 1.5], ['2junk', '2junk'], ['Infinity', 'Infinity'], ['NaN', 'NaN'], ['3', 3], ['', 1], [undefined, 1]]) {
    const item = parseThirdPartyCSV([{ Name: 'Bolt', Quantity: raw, Count: raw }], format, mapping)[0];
    assert.strictEqual(item.quantity, expected, `${format} must preserve malformed quantities for validation, not truncate or default them`);
  }
}
assert.strictEqual(parseThirdPartyCSV([{ Quantity: '', quantity: '4' }], 'internal')[0].quantity, 4);
console.log('csvmappers.test.js: conflicting and empty collector-number columns passed');
