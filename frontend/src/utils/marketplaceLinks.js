// Links to the marketplaces a card's price comes from.
//
// The rule: a "view this card" link resolves to THAT CARD or it does not exist.
// Only two things satisfy that — a TCGplayer product id, or a Cardmarket product
// id — so those are the only things these functions will build one from.
//
// A search is still offered — see searchUrl — but as its own separately labelled
// action, so the reader knows which one they are getting.
function cardGame(card) {
  if (card?.game) return card.game;
  if (card?.supertype === 'MTG' || String(card?.id).startsWith('mtg-')) return 'mtg';
  return null;
}

// Does this name stand a chance in an English-language marketplace search?
// Both sites index English names, so a name with no Latin letters cannot match.
function searchable(card) {
  return /[a-z]/i.test(card?.name || '');
}

// True when the stored provider URL is a product page rather than a name search.
//
// Scryfall wraps both forms in the same affiliate redirect
// (partner.tcgplayer.com/c/...?u=<encoded>), so the only way to tell them apart is
// to look for the product path inside the encoded URL. '%2Fproduct%2F' is a product
// page; '%2Fsearch%2Fmagic%2Fproduct%3F' is a search — one character apart at the
// end, which is why this matches the trailing separator too.
const isProductUrl = (url) => /%2Fproduct%2F|\/product\//.test(String(url || ''));

// The card's page on TCGplayer, or null.
export function tcgplayerUrl(card) {
  // The id first. It exists only when the card is genuinely listed, and unlike a
  // stored URL it cannot quietly be a search. MTG gets it from Scryfall's `tcgplayer_id`.
  if (card?.tcgplayer_product_id) {
    return `https://www.tcgplayer.com/product/${card.tcgplayer_product_id}`;
  }
  // A stored URL is honoured only if it actually points at a product. This is what
  // covers rows cached before tcgplayer_product_id existed.
  if (isProductUrl(card?.tcgplayer_url)) return card.tcgplayer_url;
  return null;
}

// The card's page on Cardmarket, or null.
//
// Cardmarket has no public API and blocks automated requests, so there is no id to
// look up and no way to verify a URL from here — every shape below is one a provider
// handed us:
//   - Scryfall's `purchase_uris.cardmarket`, which is the '?idProduct=' form.
// A search fallback is deliberately absent for the same reason as above.
export function cardmarketUrl(card) {
  const url = card?.cardmarket_url;
  return /idProduct=/.test(String(url || '')) ? url : null;
}

// A marketplace SEARCH for the card's name. Never presented as a link to the card —
// the caller labels it as a search, because that is what it is and it may well
// return nothing.
//
// Null for a name with no Latin letters: English-name searches cannot match it.
export function searchUrl(card) {
  if (!searchable(card)) return null;
  if (cardGame(card) !== 'mtg') return null;
  // Name only. Appending set name + number narrowed a lot of searches to zero
  // hits — Scryfall's own links search the bare name for the same reason.
  return `https://www.tcgplayer.com/search/magic/product?q=${encodeURIComponent(card.name)}`;
}

// Which marketplace the displayed price came from, and in what currency.
//
// Read the source and currency off the row rather than guessing from its language.
const SOURCE_NAMES = {
  scryfall: 'TCGplayer',
};
export function priceSource(card) {
  // No price means no source to name.
  if (!(Number(card?.price_trend) > 0)) return null;
  const currency = card.price_currency || 'USD';
  // Scryfall quotes two marketplaces and the currency says which: `usd` is
  // TCGplayer's number, `eur` is Cardmarket's. A non-English printing is usually the
  // second one, so the table's default would name the wrong shop for exactly the
  // cards this label is worth showing on.
  const name = (card.price_source === 'scryfall' && currency === 'EUR')
    ? 'Cardmarket'
    : SOURCE_NAMES[card.price_source] || null;
  if (!name) return null;
  // USD is the app's display currency, so the extra label is only useful otherwise.
  if (currency === 'USD') return null;
  return { name, currency };
}

// Why there is no link to the card, when there isn't one.
export function noLinkReason(card) {
  if (tcgplayerUrl(card) || cardmarketUrl(card)) return null;
  return 'No marketplace product found for this printing. It may not be sold individually, or its set may not be matched to a TCGplayer group yet.';
}
