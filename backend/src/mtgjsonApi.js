const axios = require('axios');

const client = axios.create({
  baseURL: 'https://mtgjson.com/api/v5',
  timeout: 15000,
  headers: { 'User-Agent': 'Manafolio/1.0', Accept: 'application/json' },
});

const DECK_LIST_TTL = 1000 * 60 * 60 * 24;
let deckList;
let deckListExpiresAt = 0;

async function getDeckList() {
  if (deckList && Date.now() < deckListExpiresAt) return deckList;
  const response = await client.get('/DeckList.json');
  const data = Array.isArray(response.data?.data) ? response.data.data : null;
  if (!data) throw new Error('MTGJSON returned an invalid deck list.');
  deckList = data;
  deckListExpiresAt = Date.now() + DECK_LIST_TTL;
  return deckList;
}

async function searchDecks(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  return (await getDeckList())
    .filter(deck => [deck.name, deck.code, deck.type].some(value => String(value || '').toLowerCase().includes(needle)))
    .slice(0, 20)
    .map(({ code, fileName, name, releaseDate, type }) => ({ code, fileName, name, releaseDate, type }));
}

async function getDeck(fileName) {
  const file = String(fileName || '');
  const listed = (await getDeckList()).find(deck => deck.fileName === file);
  if (!listed) return null;
  const response = await client.get(`/decks/${encodeURIComponent(file)}.json`);
  return response.data?.data || null;
}

function deckCardRows(deck) {
  const rows = new Map();
  for (const section of ['commander', 'mainBoard', 'sideBoard']) {
    for (const card of deck[section] || []) {
      const id = card.identifiers?.scryfallId;
      const set_id = card.setCode;
      const number = card.number;
      if (!id && !(set_id && number)) continue;
      const printing = card.isFoil ? 'Holofoil' : 'Normal';
      const language = card.language || 'English';
      const key = `${id || `${set_id}|${number}`}|${printing}|${language}`;
      const row = rows.get(key) || { id, set_id, number, name: card.name, printing, language, quantity: 0 };
      row.quantity += Math.max(1, parseInt(card.count, 10) || 1);
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

function resetDeckListCache() {
  deckList = undefined;
  deckListExpiresAt = 0;
}

module.exports = { client, searchDecks, getDeck, deckCardRows, resetDeckListCache };
