const axios = require('axios');

const client = axios.create({
  baseURL: 'https://archidekt.com',
  timeout: 15000,
  maxContentLength: 5 * 1024 * 1024,
  maxRedirects: 0,
  headers: { 'User-Agent': 'Manafolio/1.0', Accept: 'application/json' },
});

async function getDeck(value) {
  let url;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch { /* rejected below */ }
  const match = url?.pathname.match(/^\/decks\/([1-9]\d*)(?:\/[a-zA-Z0-9_-]+)?\/?$/);
  if (!url || url.protocol !== 'https:' || !['archidekt.com', 'www.archidekt.com'].includes(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || !match || !Number.isSafeInteger(Number(match[1]))
    || !/^https:\/\/(?:www\.)?archidekt\.com\/decks\/[1-9]\d*(?:\/[a-zA-Z0-9_-]+)?\/?$/i.test(value.trim())) {
    throw Object.assign(new Error('Enter a public HTTPS Archidekt deck URL.'), { status: 400 });
  }
  let data;
  try {
    ({ data } = await client.get(`/api/decks/${match[1]}/`));
  } catch (error) {
    const unavailable = [401, 403, 404].includes(error.response?.status);
    throw Object.assign(new Error(unavailable
      ? 'Archidekt deck not found or private. Use a publicly accessible deck.'
      : 'Unable to load the Archidekt deck. Please try again.'), { status: unavailable ? 422 : 502 });
  }
  const invalid = () => Object.assign(new Error('Archidekt returned invalid or incomplete deck data.'), { status: 502 });
  if (!data || typeof data.name !== 'string' || !data.name.trim() || !Array.isArray(data.cards) || !Array.isArray(data.categories)) throw invalid();
  const categories = new Map();
  for (const category of data.categories) {
    if (!category || typeof category.name !== 'string' || typeof category.includedInDeck !== 'boolean') throw invalid();
    categories.set(category.name, category.includedInDeck);
  }
  const rows = [];
  let cardCount = 0;
  for (const entry of data.cards) {
    if (!entry || typeof entry !== 'object') throw invalid();
    if (entry.deletedAt) continue;
    if (!Array.isArray(entry.categories) || entry.categories.some(name => !categories.has(name))) throw invalid();
    if (entry.categories.length && !entry.categories.some(name => categories.get(name))) continue;
    const oracle = entry.card?.oracleCard;
    if (oracle?.types?.includes('Token') || /token/.test(oracle?.layout || '')) continue;
    const id = entry.card?.uid;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1) throw invalid();
    cardCount += entry.quantity;
    if (!Number.isSafeInteger(cardCount)) throw invalid();
    rows.push({ id, quantity: entry.quantity, isCommander: entry.categories.includes('Commander') });
  }
  if (!rows.length) throw Object.assign(new Error('This Archidekt deck has no importable cards.'), { status: 422 });
  return { name: data.name, description: typeof data.description === 'string' ? data.description : '', card_count: cardCount, commander: rows.some(row => row.isCommander), rows };
}

module.exports = { client, getDeck };
