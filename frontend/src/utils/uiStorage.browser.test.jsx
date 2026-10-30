import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext, MouseSensor, useSensor, useSensors } from '@dnd-kit/core';
import CompartmentView from '../components/CompartmentView';
import CardDeckStatus from '../components/CardDeckStatus';
import CheckoutWizardModal from '../components/CheckoutWizardModal';
import { I18nProvider } from './i18n';
import en from '../locales/en.json';

// Isolated Vite page: await runUiStorageRegressions({ pressKey }).
// Optional pressKey(key) must send a trusted browser key to the focused element
// (e.g. page.keyboard.press); without it only native click activation is tested.
export async function runUiStorageRegressions({ pressKey, dragCard } = {}) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalPush = history.pushState;
  const originalBack = history.back;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalFocus = document.activeElement;
  const originalLocale = localStorage.getItem('manafolio_ui_lang');
  const originalLang = document.documentElement.lang;
  localStorage.setItem('manafolio_ui_lang', 'en');
  const host = document.createElement('div');
  host.style.maxWidth = '600px';
  const trigger = document.createElement('button');
  trigger.textContent = 'Open storage fixture';
  document.body.append(trigger, host);
  const root = createRoot(host);
  const render = node => root.render(<I18nProvider>{node}</I18nProvider>);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Preserve actual history while allowing useBackGuard's cleanup pop to drain.
  history.pushState = () => {};
  history.back = () => queueMicrotask(() => window.dispatchEvent(new PopStateEvent('popstate')));
  const cards = [1, 2].map(id => ({
    entry_id: id, card_id: `storage-fixture-${id}`, name: `Fixture card ${id}`,
    position: id * 1000, quantity: 1, printing: 'Normal', language: 'English',
    game: 'mtg', image_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  }));
  const compartment = { id: 70, capacity: 3, count: 2, display_label: 'Page 1' };
  const requests = [];
  window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || 'GET' });
    assert(!options.method || options.method === 'GET', 'storage checklist must never write to the API');
    let body;
    if (url === '/api/sets') body = [];
    else if (url === '/api/card-art/index') body = { ids: [] };
    else if (url === '/api/locations/7') body = { id: 7, type: 'Binder', sort_order: 'custom' };
    else if (url === '/api/locations/7/compartments') body = [compartment];
    else if (url === '/api/collection?compartment_id=70') body = cards.map(card => ({ ...card }));
    else throw new Error(`Unexpected storage fixture request: ${url}`);
    return { ok: true, json: async () => body };
  };
  const activate = async (element, key = 'Enter') => {
    assert(element instanceof HTMLButtonElement && !element.disabled, 'action must be an enabled native button');
    element.focus();
    await act(async () => { if (pressKey) await pressKey(key); else element.click(); });
  };
  const placements = [];
  function ArrangeFixture() {
    const [picked, setPicked] = useState(null);
    const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }));
    return <DndContext sensors={sensors} onDragEnd={({ over }) => {
      if (over) placements.push([over.data.current.compartmentId, over.data.current.slot, over.data.current.occupantEntryId]);
    }}>
      <CompartmentView compartment={compartment} cards={cards} locationType="Binder" dropEnabled
        placementMode pickedEntryId={picked} onPickCard={setPicked}
        onPlaceSlot={(...args) => { placements.push(args); setPicked(null); }} />
    </DndContext>;
  }
  let completed = 0;
  let canceled = 0;
  const locationsData = cards.map(card => ({ card_id: card.card_id, locations: [{
    entry_id: card.entry_id, location_id: 7, location_name: 'Fixture binder',
    compartment_id: 70, compartment_display: 'Page 1', position: card.position,
    card_name: card.name, image_url: card.image_url, take: 1,
  }] }));
  function WizardFixture({ mode = 'checkout' }) {
    const [open, setOpen] = useState(true);
    return open && <CheckoutWizardModal mode={mode} locationsData={locationsData}
      onClose={() => { completed++; setOpen(false); }}
      onCancel={() => { canceled++; setOpen(false); }} />;
  }
  const cases = [];
  try {
    const reserved = { ...cards[0], quantity: 4, checked_out_qty: 2, in_deck_qty: 2,
      deck_allocations: [{ deck_id: 1, name: 'Boros, skies', quantity: 2, checked_out: true }] };
    const pulledCopy = { ...cards[1], quantity: 2, checked_out_qty: 0, in_deck_qty: 1,
      deck_allocations: [{ deck_id: 2, name: 'Draft deck', quantity: 1, checked_out: false }] };
    await act(async () => render(<CardDeckStatus card={cards[0]} />));
    assert(!host.textContent, 'unallocated cards must not claim deck membership');
    await act(async () => render(<CardDeckStatus card={reserved} />));
    const summary = () => host.querySelector('.card-deck-status-summary');
    assert(summary().textContent.match(/\d+/g).join() === '2,4', 'partial status must show allocated and owned quantities');
    assert(!host.textContent.includes('Boros, skies'), 'list status must show checkout counts without deck names');
    const partialWeight = Number(getComputedStyle(summary()).fontWeight);
    await act(async () => render(<CardDeckStatus card={{ ...reserved, quantity: 2 }} />));
    assert(Number(getComputedStyle(summary()).fontWeight) > partialWeight, 'fully allocated cards must receive stronger emphasis');
    await act(async () => render(<CardDeckStatus card={{ ...reserved, quantity: 6, stack_entries: [reserved, pulledCopy] }} details />));
    assert(summary().textContent.match(/\d+/g).join() === '3,6', 'stack status must include every stored entry, not only the lead');
    const allocations = [...host.querySelectorAll('[role="listitem"]')];
    assert(allocations.length === 2 && allocations[0].textContent.includes('Boros, skies') && allocations[1].textContent.includes('Draft deck'),
      'stack details must identify both assigned decks');
    assert(allocations[0].textContent.includes('Checked out') && allocations[1].textContent.includes('Pulled'),
      'pulled checklist copies must not be presented as reservations');
    await act(async () => render(<CardDeckStatus card={{ ...reserved, quantity: 8, stack_entries: [reserved, { ...reserved, entry_id: 3 }] }} details />));
    assert(host.querySelectorAll('[role="listitem"]').length === 1
      && host.querySelector('[role="listitem"]').textContent.match(/\d+/g).join() === '4', 'one deck spanning stored entries must combine its quantities');
    const single = { ...reserved, quantity: 1, in_deck_qty: 1, checked_out_qty: 1,
      deck_allocations: [{ ...reserved.deck_allocations[0], quantity: 1 }] };
    for (const compact of [false, true]) {
      await act(async () => render(<CardDeckStatus card={single} compact={compact} />));
      assert(summary().textContent === en['deck.inPlay'], 'a single checked-out copy needs no fraction');
    }
    await act(async () => render(<CardDeckStatus card={{ ...single, quantity: 4 }} />));
    assert(summary().textContent.match(/\d+/g).join() === '1,4', 'one checked-out copy in a larger stack must retain counts');
    await act(async () => render(<CardDeckStatus card={{ ...pulledCopy, quantity: 1 }} />));
    assert(summary().textContent !== en['deck.inPlay'], 'a single Pulled copy must not be relabeled as checked out');
    cases.push('checkout counts, full emphasis, stacked sources, distinct decks and pulled status');

    const missingStack = [reserved, { ...reserved, entry_id: 3, missing: 1 }];
    await act(async () => render(<CompartmentView compartment={compartment} cards={missingStack} locationType="Binder" allowStacking />));
    assert(getComputedStyle(host.querySelector('.binder-pocket')).outlineStyle === 'solid',
      'a missing member must outline its whole stack even when the lead entry is present');
    await act(async () => render(<CompartmentView compartment={compartment} cards={missingStack.map(card => ({ ...card, missing: 0 }))} locationType="Binder" allowStacking />));
    assert(getComputedStyle(host.querySelector('.binder-pocket')).outlineStyle === 'none',
      'marking the missing copy found must clear the border even while copies remain checked out');
    cases.push('missing stack outline and found transition independent of checkout');

    const opened = [];
    await act(async () => { render(<CompartmentView compartment={compartment} cards={cards} locationType="Binder" onCardClick={card => opened.push(card.entry_id)} />); });
    await activate(host.querySelector('.binder-pocket'), 'Enter');
    assert(host.querySelector('.focused-card-info-panel')?.textContent.includes(cards[0].name), 'first binder activation must select and describe the card');
    await activate(host.querySelector('.binder-pocket'), 'Space');
    assert(opened.join() === '1', 'second binder activation must open the selected card');
    cases.push('binder Enter selects and Space opens');
    const renamed = [];
    await act(async () => { render(<CompartmentView compartment={compartment} cards={cards} locationType="Binder" onRename={name => renamed.push(name)} />); });
    const renameButton = () => host.querySelector('button[aria-label^="Rename page/row"]');
    await activate(renameButton(), 'Enter');
    const renameInput = host.querySelector('input[aria-label="Rename page/row"]');
    assert(document.activeElement === renameInput, 'renaming must focus the editable page name');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(renameInput, 'Draft page');
      renameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      if (pressKey) await pressKey('Escape');
      else renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert(renamed.length === 0 && document.activeElement === renameButton(), 'Escape must discard a rename and restore the initiating button');
    await activate(renameButton(), 'Space');
    await act(async () => {
      const input = host.querySelector('input[aria-label="Rename page/row"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Saved page');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      if (pressKey) await pressKey('Enter');
      else host.querySelector('input[aria-label="Rename page/row"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert(renamed.join() === 'Saved page' && document.activeElement === renameButton(), 'Enter must save the page name once and restore focus');
    cases.push('binder rename keyboard activation, cancellation, save and focus restoration');

    await act(async () => { render(<ArrangeFixture />); });
    if (dragCard) {
      // A real drag spans separate browser events; batching the whole gesture
      // in act prevents dnd-kit from measuring drop targets between those events.
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
      try {
        await dragCard('.binder-pocket:not(.empty)', '.binder-pocket.empty');
      } finally {
        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      }
      await act(async () => {});
      assert(JSON.stringify(placements) === '[[70,3,null]]', `pointer drag must finish on an empty pocket before any card is picked: ${JSON.stringify(placements)}`);
      placements.length = 0;
      cases.push('pointer drag completes on an inactive empty pocket');
    }
    await activate(host.querySelector('.binder-pocket'), 'Enter');
    assert(host.querySelector('.binder-pocket').getAttribute('aria-pressed') === 'true', 'arrangement must announce the picked card');
    await activate(host.querySelector('.binder-pocket.empty'), 'Space');
    assert(JSON.stringify(placements) === '[[70,3,null]]', 'keyboard arrangement must call existing placement with the destination slot');
    assert(host.querySelector('.binder-pocket').getAttribute('aria-pressed') === 'false', 'placing must clear picked state');
    cases.push('drag-enabled binder keyboard pick and empty-pocket placement');

    await act(async () => { render(<CompartmentView compartment={compartment} cards={cards} locationType="Box" onCardClick={card => opened.push(card.entry_id)} />); });
    const first = host.querySelector('.box-coverflow-card.active');
    await activate(first, 'Enter');
    assert(opened.join() === '1,1', 'centered coverflow card must open on activation');
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    const second = host.querySelector('.box-coverflow-card.active');
    assert(second !== first && document.activeElement === second, 'arrow navigation must move focus to the next active card');
    assert([...host.querySelectorAll('.box-coverflow-card')].filter(button => button.tabIndex === 0).length === 1, 'only the active coverflow card may be in the tab order');
    await activate(second, 'Space');
    assert(opened.join() === '1,1,2', 'Space must open the newly focused coverflow card');
    cases.push('coverflow active tab stop, arrow focus, and card activation');

    const pulled = [];
    await act(async () => {
      render(<CompartmentView compartment={compartment}
        cards={[cards[0], { ...cards[0], entry_id: 2 }]} locationType="Binder" allowStacking
        pullMode highlightEntryIds={[2]} pulledEntryIds={[1]} onCardClick={card => pulled.push(card.entry_id)} />);
    });
    await activate(host.querySelector('.binder-pocket'), 'Space');
    assert(pulled.join() === '2', 'stacked pocket must activate the still-to-pull copy before an already pulled copy');
    cases.push('stacked pull priority survives native activation');

    await act(async () => { render(null); });
    trigger.focus();
    await act(async () => { render(<WizardFixture />); });
    const dialog = host.querySelector('dialog');
    assert(dialog?.open && dialog.matches(':modal'), 'checkout must open a native modal');
    assert(dialog.contains(document.activeElement), 'modal must take focus');
    assert(document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent, 'modal must have its visible title as accessible name');
    assert(!host.querySelector('button button'), 'storage controls must not nest buttons');
    const row = id => [...host.querySelectorAll('button[aria-pressed]')].find(button => !button.hasAttribute('aria-label') && button.textContent.includes(`Fixture card ${id}`));
    const globalAll = host.querySelector('button[aria-pressed]');
    const progress = host.querySelector('[role="status"]');
    const initialProgress = progress.textContent;
    await activate(row(1), 'Enter');
    assert(row(1).getAttribute('aria-pressed') === 'true' && globalAll.getAttribute('aria-pressed') === 'mixed', 'individual and mixed bulk state must be exposed');
    assert(progress.textContent !== initialProgress && progress.getAttribute('aria-live') === 'polite', 'progress must update in a polite live region');
    const lastRow = row(2);
    await activate(lastRow, 'Space');
    const disclosure = host.querySelector('button[aria-controls]');
    assert(disclosure.getAttribute('aria-expanded') === 'true' && document.activeElement === lastRow, 'completing the last card must not collapse or lose focus');
    assert(globalAll.getAttribute('aria-pressed') === 'true', 'completing all rows must expose bulk checked state');
    await activate(disclosure, 'Enter');
    const panel = document.getElementById(disclosure.getAttribute('aria-controls'));
    assert(panel.hidden && disclosure.getAttribute('aria-expanded') === 'false', 'disclosure must collapse its controlled panel');
    await activate(disclosure, 'Space');
    assert(!panel.hidden, 'completed container must reopen by keyboard');
    await activate(row(2), 'Enter');
    assert(row(2).getAttribute('aria-pressed') === 'false' && globalAll.getAttribute('aria-pressed') === 'mixed', 'reopened container must allow correction');
    const doneButton = host.querySelector('.btn-primary');
    assert(doneButton.disabled, 'correcting a card must disable completion');
    await activate(globalAll, 'Space');
    assert(document.activeElement === globalAll && !doneButton.disabled, 'bulk control must retain its DOM identity and focus after state changes');
    await activate(doneButton, 'Enter');
    assert(completed === 1 && canceled === 0 && !host.querySelector('dialog'), 'Done must complete without canceling');
    assert(document.activeElement === trigger, 'closing must restore opener focus');
    cases.push('checkout modal name/focus, mixed state/live progress, completion/reopen/correction');

    await act(async () => { render(<WizardFixture key="checkin" mode="checkin" />); });
    const returnCards = host.querySelectorAll('.card-grid button');
    assert(returnCards.length === 2 && [...returnCards].every(button => button.querySelector('img')?.getAttribute('src') === cards[0].image_url), 'return guide must show each returning entry with its artwork');
    await activate(returnCards[0], 'Space');
    assert(returnCards[0].getAttribute('aria-pressed') === 'true' && host.querySelector('.btn-primary').disabled, 'return card selection must track progress without finishing early');
    await activate(returnCards[1], 'Enter');
    assert(!host.querySelector('.btn-primary').disabled, 'returning every card must enable Done');
    await activate(returnCards[0], 'Enter');
    assert(host.querySelector('.btn-primary').disabled, 'return grid must allow correcting a returned card');
    cases.push('return artwork grid keyboard selection and correction');
    await act(async () => {
      if (pressKey) await pressKey('Escape');
      else host.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    assert(canceled === 1 && completed === 1 && !host.querySelector('dialog'), 'Escape/cancel must use cancellation rather than completion');
    assert(document.activeElement === trigger, 'cancel must restore opener focus');
    assert(requests.every(request => request.method === 'GET'), 'all storage regression requests must be read-only');
    cases.push('checkin modal cancel and focus return without writes');
    return { cases, trustedKeyboard: !!pressKey, pointerDrag: !!dragCard };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    trigger.remove();
    window.fetch = originalFetch;
    history.pushState = originalPush;
    history.back = originalBack;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
    if (originalLocale === null) localStorage.removeItem('manafolio_ui_lang');
    else localStorage.setItem('manafolio_ui_lang', originalLocale);
    document.documentElement.lang = originalLang;
    if (originalFocus instanceof HTMLElement && originalFocus.isConnected) originalFocus.focus();
  }
}
