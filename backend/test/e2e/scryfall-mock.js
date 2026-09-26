// Every Scryfall call in these tests is served from the fixtures below, so no
// request ever reaches api.scryfall.com. Pacing them at Scryfall's real
// 2-requests-per-second would make the rate-limit suite (350 requests) take
// minutes for no benefit. Set before scryfallApi is required — this file is
// preloaded with `node -r`.
process.env.SCRYFALL_GAP_SCALE = '0';

// Every test server gets a unique HTTP port, but HTTPS_PORT is a fixed number a
// developer's .env may set — and dotenv will not override a key already present.
// Blanking it here (before server.js loads .env) keeps a test run from fighting a
// dev server, or another test server, for the same TLS port.
process.env.HTTPS_PORT = '';

const axios = require('axios');
const originalGet = axios.Axios.prototype.get;
const originalPost = axios.Axios.prototype.post;

// POST /cards/collection — the bulk lookup the price refresh uses. Resolves each
// identifier against the same fixtures the GET branch serves, so a card findable
// by search is findable in bulk, and anything else lands in not_found.
axios.Axios.prototype.post = async function(url, body, config) {
  const fullUrl = (this.defaults.baseURL || '') + url;
  if (!fullUrl.includes('api.scryfall.com')) return originalPost.call(this, url, body, config);

  if (process.env.MOCK_SCRYFALL_ERROR === 'true') {
    const err = new Error('Request failed with status code 500');
    err.response = { status: 500 };
    throw err;
  }

  const identifiers = (body && body.identifiers) || [];
  const data = [];
  const not_found = [];
  for (const ident of identifiers) {
    // Reuse the GET fixtures by handing them the same hints in a fake URL.
    const hint = ident.name || `${ident.set || ''}-${ident.collector_number || ''}`;
    const resp = await axios.Axios.prototype.get.call(this, `/cards/search?q=${encodeURIComponent(hint)}`);
    const card = resp.data.data && resp.data.data[0];
    // The GET branch falls back to Black Lotus for anything unrecognized; only
    // count it as a hit when the fixture actually matches what was asked for.
    const matchesName = ident.name && card && card.name.toLowerCase() === ident.name.toLowerCase();
    const matchesSetNum = ident.set && card
      && card.set === ident.set && String(card.collector_number) === String(ident.collector_number);
    if (matchesName || matchesSetNum) data.push(card); else not_found.push(ident);
  }
  return { data: { object: 'list', data, not_found } };
};

axios.Axios.prototype.get = async function(url, config) {
  const fullUrl = (this.defaults.baseURL || '') + url;
  
  if (fullUrl.includes('api.scryfall.com')) {
    // Simulate API delay if requested
    if (process.env.MOCK_SCRYFALL_DELAY === 'true') {
      await new Promise(resolve => setTimeout(resolve, 7000));
    }
    
    // Simulate API error if requested
    if (process.env.MOCK_SCRYFALL_ERROR === 'true') {
      const err = new Error('Request failed with status code 500');
      err.response = { status: 500 };
      throw err;
    }

    // Determine card response based on query parameter
    let name = 'Black Lotus';
    let id = 'lea-232';
    let set = 'lea';
    let num = '232';
    let prices = { usd: '10000.00', usd_foil: null };
    let colors = [];
    let type_line = 'Artifact';
    let rarity = 'rare';
    let image_uris = { normal: 'https://images.scryfall.com/lotus.png' };
    // Real Scryfall reports the language of the printing it returned, and only
    // returns a non-English one when asked with the `lang:` KEYWORD plus
    // include_multilingual — there is no `lang` query parameter. `printed_name`
    // is the localized name; `name` stays English on every printing.
    let lang = 'en';
    let printed_name = null;
    // Matches the encoded form of `lang:ja` inside q. Deliberately NOT `lang=ja`:
    // that parameter is ignored by the real API, so accepting it here would let a
    // broken query keep passing this suite (it did — see issue #25).
    const askedForJapanese = /lang%3Aja\b/i.test(fullUrl);
    if (askedForJapanese && !/include_multilingual=true/.test(fullUrl)) {
      // Scryfall hides non-English printings without this flag.
      return { data: { object: 'list', total_cards: 0, has_more: false, data: [] } };
    }

    if (fullUrl.includes('Lightning') || fullUrl.includes('146')) {
      name = 'Lightning Bolt';
      id = '54321';
      set = 'm10';
      num = '146';
      prices = { usd: '0.50', usd_foil: '2.50' };
      colors = ['R'];
      type_line = 'Instant';
      rarity = 'common';
      image_uris = { normal: 'https://images.scryfall.com/bolt.png' };
    } else if (askedForJapanese || fullUrl.includes('jp123') || fullUrl.includes('%e9%bb%92%e3%81%8d%e8%93%ae')) {
      // The Japanese printing is its own card object: own id, own art, English
      // `name` plus the localized `printed_name`.
      name = 'Black Lotus';
      printed_name = '黒き蓮';
      lang = 'ja';
      id = 'jp123';
      set = 'lea';
      num = '232';
      prices = { usd: '12000.00', usd_foil: null };
      colors = [];
      type_line = 'Artifact';
      rarity = 'rare';
      image_uris = { normal: 'https://images.scryfall.com/lotus-ja.png' };
    } else if (fullUrl.includes('Delver')) {
      return {
        data: {
          object: 'list',
          data: [
            {
              id: 'dfc1',
              name: 'Delver of Secrets // Insectile Aberration',
              layout: 'transform',
              card_faces: [
                {
                  name: 'Delver of Secrets',
                  type_line: 'Creature - Human Wizard',
                  colors: ['U'],
                  image_uris: { normal: 'https://images.scryfall.com/delver.png' }
                },
                {
                  name: 'Insectile Aberration',
                  type_line: 'Creature - Human Insect',
                  colors: ['U'],
                  image_uris: { normal: 'https://images.scryfall.com/aberration.png' }
                }
              ],
              rarity: 'uncommon',
              set: 'isd',
              set_name: 'Innistrad',
              collector_number: '51',
              prices: { usd: '1.00', usd_foil: '5.00' }
            }
          ]
        }
      };
    } else if (fullUrl.includes('ELD') || fullUrl.includes('171')) {
      name = 'Questing Beast';
      id = 'eld-171';
      set = 'eld';
      num = '171';
      prices = { usd: '10.00', usd_foil: null };
      colors = ['G'];
      type_line = 'Creature';
      rarity = 'rare';
      image_uris = { normal: 'https://images.scryfall.com/image.png' };
    } else if (fullUrl.includes('NonExistentCardName') || fullUrl.includes('Spam')) {
      return { data: { object: 'list', data: [] } };
    }

    return {
      data: {
        object: 'list',
        total_cards: 1,
        has_more: false,
        data: [
          {
            id,
            name,
            lang,
            ...(printed_name ? { printed_name } : {}),
            type_line,
            rarity,
            set,
            set_name: 'Limited Edition Alpha',
            collector_number: num,
            image_uris,
            prices,
            colors
          }
        ]
      }
    };
  }
  
  return originalGet.call(this, url, config);
};
