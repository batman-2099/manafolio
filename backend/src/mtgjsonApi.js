const axios = require('axios');
const tokenContents = require('../../shared/preconTokens.json');

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
    .map(({ code, fileName, name, releaseDate, type }) => ({
      code, fileName, name, releaseDate, type,
      ...(tokenContents[fileName] ? { token_editions: tokenContents[fileName].editions.map(({ id, label }) => ({ id, label })) } : {}),
    }));
}

async function getDeck(fileName, tokenEdition = '') {
  const file = String(fileName || '');
  const listed = (await getDeckList()).find(deck => deck.fileName === file);
  if (!listed) return null;
  const edition = tokenContents[file]?.editions.find(item => item.id === tokenEdition);
  if (tokenEdition !== '' && !edition) {
    throw Object.assign(new Error('Unknown token edition for this precon'), { status: 400 });
  }
  const response = await client.get(`/decks/${encodeURIComponent(file)}.json`);
  const deck = response.data?.data || null;
  return deck && edition ? { ...deck, tokens: edition.tokens } : deck;
}

function deckCardRows(deck) {
  const rows = new Map();
  for (const section of ['commander', 'mainBoard', 'sideBoard', 'tokens']) {
    for (const card of deck[section] || []) {
      const isToken = section === 'tokens';
      if (isToken && (!Number.isSafeInteger(card.count) || card.count <= 0)) continue;
      const id = card.identifiers?.scryfallId;
      const set_id = card.setCode;
      const number = card.number;
      if (!id && !(set_id && number)) continue;
      const printing = card.isFoil ? 'Holofoil' : 'Normal';
      const language = card.language || 'English';
      const reverse_card_id = isToken ? card.reverse_card_id || null : null;
      const key = `${isToken}|${id || `${set_id}|${number}`}|${reverse_card_id || ''}|${printing}|${language}`;
      const row = rows.get(key) || { id, set_id, number, name: card.name, printing, language, quantity: 0, isToken,
        ...(reverse_card_id ? { reverse_card_id, reverse_name: card.reverse_name } : {}),
      };
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
