import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CardInspectorModal from '../components/CardInspectorModal';
import { I18nProvider, useT } from './i18n';
import { noteArtChanged } from './cardArt';
import en from '../locales/en.json';

// Run on an isolated Vite page; no provider or personal collection is contacted.
export async function runCardAiExplainRegressions() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalLocale = localStorage.getItem('manafolio_ui_lang');
  const originalLang = document.documentElement.lang;
  localStorage.setItem('manafolio_ui_lang', 'en');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cards = [1, 2].map(id => ({
    id: id + 100, entry_id: id + 100, card_id: `explain-printing-${id}`, name: `Explanation sample ${id}`,
    game: 'mtg', language: id === 1 ? 'German' : 'English', list_type: 'collection', quantity: 1,
    image_url: '/logo.svg', deck_allocations: [], notes: 'Private note never sent', location_id: 77,
  }));
  const requests = [];
  const accounts = [];
  let settleArt;
  let selectCard;
  let selectLocale;
  const response = (data, ok = true) => ({ ok, json: async () => data });
  window.fetch = async (url, options = {}) => {
    if (url === '/api/ai-decks/account') return new Promise(resolve => accounts.push({ resolve, signal: options.signal }));
    if (url === '/api/ai-decks/explain') return new Promise(resolve => requests.push({ resolve, ...options, payload: JSON.parse(options.body) }));
    if (options.method === 'DELETE' && url.startsWith('/api/card-art/')) return new Promise(resolve => { settleArt = resolve; });
    if (url === '/api/card-art/index') return response({ ids: [] });
    if (url === '/api/sets?game=mtg' || url === '/api/decks' || url.startsWith('/api/locations?') || url.includes('price-history')) return response([]);
    throw new Error(`Unexpected explanation fixture request: ${url}`);
  };
  function Preview() {
    const [card, setCard] = useState(cards[0]);
    selectCard = setCard;
    selectLocale = useT().setLocale;
    return <CardInspectorModal card={card} cards={cards} onNavigate={setCard} onClose={() => setCard(null)} />;
  }
  const button = text => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.getAttribute('aria-label') === text);
  const explainButton = () => button(en['aiExplain.button']);
  const dialog = () => [...host.querySelectorAll('dialog[open]')].find(node => node.querySelector('h3')?.textContent === en['aiExplain.button']);
  const click = async node => { assert(node, 'expected control exists'); node.focus(); await act(async () => node.click()); };
  const settleAccount = async (connected = true, ok = true) => act(async () => accounts.at(-1).resolve(response({ connected, provider: 'ollama' }, ok)));
  const flushBack = () => new Promise(resolve => setTimeout(resolve, 50));
  try {
    await act(async () => root.render(<I18nProvider><Preview key="disconnected" /></I18nProvider>));
    assert(!explainButton() && requests.length === 0, 'pending connection hides the action and never generates');
    await settleAccount(false);
    assert(!explainButton() && requests.length === 0, 'disconnected selected provider hides the action');
    await act(async () => root.render(<I18nProvider><Preview key="failed" /></I18nProvider>));
    await settleAccount(true, false);
    assert(!explainButton(), 'failed account status cannot expose the action');
    await act(async () => root.render(<I18nProvider><Preview key="connected" /></I18nProvider>));
    await settleAccount();
    assert(explainButton() && requests.length === 0, 'connected account shows the action without sending card data');
    await act(async () => noteArtChanged(cards[0].card_id, true));
    assert(explainButton().previousElementSibling.textContent.trim() === en['art.replace']
      && explainButton().nextElementSibling.textContent.trim() === en['art.contribute'], 'AI Explain sits immediately after art and before contribution controls');
    assert(explainButton().title === en['aiExplain.notice'], 'trigger discloses provider transfer before clicking');

    await click(button(en['art.remove']));
    assert(explainButton().disabled && button(en['inspector.nextCard']).disabled, 'art mutation still guards AI action and navigation');
    await click(explainButton());
    assert(requests.length === 0, 'busy artwork cannot start explanation');
    await act(async () => settleArt(response({ hasBundled: false })));
    await click(explainButton());
    assert(dialog() && dialog().querySelector('[role="status"]').textContent === en['aiExplain.loading'], 'click opens a named native dialog immediately with announced loading');
    assert(dialog().getAttribute('aria-labelledby') === dialog().querySelector('h3').id && dialog().contains(document.activeElement), 'dialog has an accessible title and takes focus');
    assert(dialog().textContent.includes(en['aiExplain.notice']) && dialog().textContent.includes(en['aiExplain.caution']), 'privacy notice and AI caution remain visible while loading');
    assert(JSON.stringify(requests[0].payload) === JSON.stringify({ card_id: cards[0].card_id, locale: 'en' }) && requests[0].method === 'POST', 'only selected printing identity and UI locale are sent, not entry ID, printed language or private fields');
    await act(async () => explainButton().click());
    assert(requests.length === 1 && !requests[0].signal.aborted, 'duplicate activation cannot restart a pending paid request');
    await act(async () => requests[0].resolve(response({ explanation: 'Tap this card.\n<img src=x onerror=alert(1)>' })));
    assert(dialog().textContent.includes('<img src=x onerror=alert(1)>') && !dialog().querySelector('img'), 'provider output is text, never HTML');
    assert(dialog().querySelector('[role="status"]').style.whiteSpace === 'pre-wrap', 'explanation preserves whitespace');
    await click([...dialog().querySelectorAll('button')].find(node => node.textContent === en['common.close']));
    await flushBack();
    assert(!dialog() && document.activeElement === explainButton(), 'closing restores focus and retains inspector');

    await click(explainButton());
    await act(async () => requests[1].resolve(response({ error: 'Selected model cannot read images' }, false)));
    assert(dialog().querySelector('[role="alert"]').textContent === 'Selected model cannot read images', 'image/provider failures are shown inline');
    await click(button(en['common.retry']));
    assert(requests.length === 3 && requests[2].payload.card_id === cards[0].card_id, 'Retry repeats only the selected printing request');
    await act(async () => requests[2].resolve(response({ explanation: 'Retry explanation' })));
    assert(dialog().textContent.includes('Retry explanation'), 'Retry can recover');
    await act(async () => dialog().dispatchEvent(new Event('cancel', { cancelable: true })));
    await flushBack();
    assert(!dialog() && host.querySelector('dialog[open]'), 'Escape cancellation closes only the explanation');

    await click(explainButton());
    const canceled = requests.at(-1);
    await act(async () => dialog().dispatchEvent(new Event('cancel', { cancelable: true })));
    await flushBack();
    assert(canceled.signal.aborted, 'cancel aborts in-flight generation');
    await click(explainButton());
    const reopened = requests.at(-1);
    await act(async () => canceled.resolve(response({ explanation: 'Stale canceled answer' })));
    assert(!dialog().textContent.includes('Stale canceled answer') && dialog().textContent.includes(en['aiExplain.loading']), 'late canceled response cannot overwrite reopened dialog');
    await act(async () => selectCard(cards[1]));
    await flushBack();
    assert(reopened.signal.aborted && !dialog(), 'card navigation unmounts explanation and aborts its request');
    await settleAccount();
    await click(explainButton());
    const second = requests.at(-1);
    assert(second.payload.card_id === cards[1].card_id, 'navigation uses the newly selected printing');
    await act(async () => reopened.resolve(response({ explanation: 'Stale previous card' })));
    assert(!dialog().textContent.includes('Stale previous card'), 'previous card response cannot leak into new printing');
    await act(async () => { window.history.back(); await flushBack(); });
    assert(second.signal.aborted && !dialog() && host.querySelector('dialog[open]'), 'browser Back cancels only the topmost explanation');

    await click(explainButton());
    const localized = requests.at(-1);
    await act(async () => selectLocale('de'));
    // Locale dictionaries are Vite dynamic imports, not fixture API requests.
    for (let attempt = 0; attempt < 100 && document.documentElement.lang !== 'de'; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    }
    assert(document.documentElement.lang === 'de' && localized.signal.aborted && !dialog(), 'UI locale changes reset and cancel explanation');
    await settleAccount();
    const translatedButton = host.querySelector('input[type="file"]').nextElementSibling.nextElementSibling;
    await click(translatedButton);
    assert(requests.at(-1).payload.locale === 'de', 'new explanations use the current UI locale');
    const unmounted = requests.at(-1);
    await act(async () => root.render(null));
    await flushBack();
    assert(unmounted.signal.aborted && accounts.at(-1).signal.aborted, 'unmount aborts generation and account lookup');
    await act(async () => unmounted.resolve(response({ explanation: 'Unmounted answer' })));
    assert(!host.textContent, 'late unmounted responses render nothing');
    return { passed: ['connection visibility', 'art order and mutation guard', 'printing identity and locale privacy', 'safe accessible explanation', 'error and retry', 'close/cancel/back abort', 'stale reopen/card/locale responses', 'unmount cleanup'] };
  } finally {
    await act(async () => root.unmount());
    await flushBack();
    noteArtChanged(cards[0].card_id, false);
    host.remove();
    window.fetch = originalFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
    if (originalLocale === null) localStorage.removeItem('manafolio_ui_lang');
    else localStorage.setItem('manafolio_ui_lang', originalLocale);
    document.documentElement.lang = originalLang;
  }
}
