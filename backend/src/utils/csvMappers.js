const CONDITION_MAP = {
  'near mint': 'Near Mint', 'nm': 'Near Mint', 'near_mint': 'Near Mint',
  'lightly played': 'Lightly Played', 'lp': 'Lightly Played', 'lightly_played': 'Lightly Played',
  'moderately played': 'Moderately Played', 'mp': 'Moderately Played',
  'heavily played': 'Heavily Played', 'hp': 'Heavily Played',
  'damaged': 'Damaged', 'dmg': 'Damaged', 'poor': 'Damaged'
};

function csvQuantity(value) {
  if (value === undefined || value === '') return 1;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity : value;
}

// ponytail: only the collector-number precedence differs between these formats.
function marketplaceCsvRow(row, collector_number) {
  return {
    name: row['Card Name'] || row['Name'],
    set_code: row['Set Code'] || row['Set'],
    collector_number,
    quantity: csvQuantity(row['Quantity']),
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: (row['Printing'] === 'Foil' || row['Printing'] === 'Holofoil') ? 'Holofoil' : 'Normal',
    game: 'mtg'
  };
}

const STRATEGIES = {
  internal: (row) => ({
    name: row['Name'] || row['card_name'] || row['Name'],
    set_code: row['Set ID'] || row['set_code'] || row['Set Code'],
    set_name: row['Set Name'] || row['set_name'],
    collector_number: row['Card Number'] || row['card_number'] || row['number'],
    card_id: row['Card ID'] || row['card_id'],
    quantity: csvQuantity(row['Quantity'] === '' ? row['quantity'] : row['Quantity'] ?? row['quantity']),
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: row['Printing'] || 'Normal',
    language: row['Language'] || 'English',
    purchase_price: parseFloat(row['Purchase Price'] || row['purchase_price']) || 0,
    game: row['Game'] || row['game'] || 'mtg'
  }),
  arena: (row) => ({
    name: row['Name'],
    set_code: row['Edition'],
    collector_number: row['Collector Number'],
    quantity: csvQuantity(row['Count']),
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: (row['Foil'] === 'true' || row['Foil'] === '1') ? 'Holofoil' : 'Normal',
    language: row['Language'] || 'English',
    game: 'mtg'
  }),
  tcgplayer: (row) => marketplaceCsvRow(row, row['Number'] || row['Card Number']),
  dragonshield: (row) => marketplaceCsvRow(row, row['Card Number'] || row['Number']),
  manabox: (row) => ({
    name: row['Name'] || row['Card Name'],
    set_code: row['Set code'] || row['Set Code'] || row['Set'],
    collector_number: row['Card number'] || row['Number'],
    quantity: csvQuantity(row['Quantity']),
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    printing: (row['Foil'] === 'true' || row['Foil'] === '1' || row['Foil'] === true) ? 'Holofoil' : 'Normal',
    game: 'mtg'
  })
};
function mappedCsvRow(row, mapping) {
  const value = field => mapping[field] ? row[mapping[field]] : '';
  const printing = value('printing');
  return {
    name: value('name'),
    set_code: value('set_code'),
    collector_number: value('collector_number'),
    card_id: value('card_id'),
    quantity: csvQuantity(value('quantity')),
    condition: CONDITION_MAP[value('condition').toLowerCase()] || 'Near Mint',
    printing: /^(true|1|foil|holofoil)$/i.test(printing) ? 'Holofoil' : printing || 'Normal',
    language: value('language') || 'English',
    purchase_price: parseFloat(value('purchase_price')) || 0,
    game: 'mtg'
  };
}

function parseThirdPartyCSV(rows, formatType = 'tcgplayer', mapping) {
  if (mapping && Object.values(mapping).some(Boolean)) return rows.map(row => mappedCsvRow(row, mapping));
  const formatKey = (formatType || 'internal').toLowerCase();
  const strategy = STRATEGIES[formatKey] || STRATEGIES.internal;
  return rows.map(strategy);
}

// ManaBox's plain-text export is a decklist: `2 Card Name (SET) 123`, with
// `*F*`/star tags for foil copies. Group duplicate lines because an export may
// list the same printing in multiple sections.
function parseManaboxText(data) {
  if (typeof data !== 'string') return [];
  const items = new Map();

  for (const line of data.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s+\(([A-Za-z0-9]+)\)\s+([A-Za-z0-9]+)(.*)$/);
    if (!match) continue;

    const [, quantity, name, set_code, collector_number, tags] = match;
    const printing = /(?:\*F\*|★)/i.test(tags) ? 'Holofoil' : 'Normal';
    const key = `${set_code.toLowerCase()}|${collector_number.toLowerCase()}|${printing}`;
    const item = items.get(key) || {
      name,
      set_code,
      collector_number,
      quantity: 0,
      condition: 'Near Mint',
      printing,
      game: 'mtg'
    };
    item.quantity += parseInt(quantity, 10);
    items.set(key, item);
  }

  return [...items.values()];
}

module.exports = {
  CONDITION_MAP,
  STRATEGIES,
  parseThirdPartyCSV,
  parseManaboxText
};
