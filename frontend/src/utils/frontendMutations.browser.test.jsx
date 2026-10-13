import { act } from 'react';
import { createRoot } from 'react-dom/client';
import CardInspectorModal from '../components/CardInspectorModal';
import AddToDeckSelect from '../components/AddToDeckSelect';
import PackPriceSplitter from '../components/PackPriceSplitter';
import { useMultiSelect } from './useMultiSelect';

// Run on an isolated Vite page, with no application mounted:
// await (await import('/src/utils/frontendMutations.browser.test.jsx')).runFrontendMutationRegressions()
// All API requests are intercepted here; no server or real collection is used.
export async function runFrontendMutationRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalFetch = window.fetch;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalConfirm = window.confirm;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const requests = [];
  const putTargets = [];
  const storedEntries = new Map();
  const changes = [];
  let settleBulk;
  let selection;
  // Keep fixture JSON on the microtask queue so act drains the complete read.
  // Native Response.json() can finish its body stream after act has returned,
  // leaving a select without its fetched options when the test changes it.
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  window.fetch = async (url, options = {}) => {
    if (url === '/api/collection/bulk') {
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { settleBulk = (status = 200) => resolve(response({ message: 'Saved', error: 'Rejected' }, status)); });
    }
    if (options.method === 'PUT' && String(url).startsWith('/api/collection/')) {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      const entryId = Number(String(url).split('/').at(-1));
      putTargets.push(entryId);
      if (storedEntries.has(entryId)) Object.assign(storedEntries.get(entryId), payload);
      return response({});
    }
    if (String(url).startsWith('/api/locations?')) return response([
      { id: 7, name: 'Custom binder', type: 'binder', locked: true },
      { id: 8, name: 'Other binder', type: 'binder' },
    ]);
    if (url === '/api/decks') return response([{ id: 9, name: 'Test deck' }]);
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const changeValue = async (element, value) => {
    assert(!element.matches(':disabled'), 'test must wait for an enabled input before editing');
    if (element instanceof HTMLSelectElement) {
      assert([...element.options].some(option => option.value === value), `select must contain requested option ${value} before editing`);
    }
    await act(async () => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
    assert(element.value === value, `controlled field must retain the requested value ${value}`);
  };
  function SelectionFixture() {
    selection = useMultiSelect({
      showToast: () => {},
      onChanged: change => { changes.push(change); selection.exitSelectMode(); },
    });
    return <>
      <AddToDeckSelect disabled={selection.bulkPending} onAdd={id => selection.runBulk('add_to_deck', id)} />
      <PackPriceSplitter entryIds={[...selection.selectedIds]} pending={selection.bulkPending} runBulk={selection.runBulk} showToast={() => {}} />
    </>;
  }
  try {
    await act(async () => { root.render(<SelectionFixture />); });
    await act(async () => { selection.arm(1); selection.setBulkMoveTarget('7'); });
    const originalSetter = selection.setSelectedIds;
    let pending;
    let duplicate;
    await act(async () => {
      pending = selection.runBulk('add_to_deck', '9');
      duplicate = selection.runBulk('add_to_deck', '9');
      selection.toggleSelect(2);
      selection.selectAt(3, [1, 2, 3], true);
      selection.arm(4);
      selection.clearSelection();
      selection.exitSelectMode();
      selection.setSelectedIds(new Set([5]));
      selection.setSelectMode(false);
      selection.setBulkMoveTarget('8');
    });
    assert(await duplicate === false && requests.length === 1, 'same-tick duplicate bulk request must be rejected');
    assert(selection.bulkPending && selection.selectMode, 'pending action owns select mode');
    assert([...selection.selectedIds].join() === '1', 'all selection-changing APIs must be frozen synchronously');
    assert(selection.bulkMoveTarget === '7', 'pending action owns move target');
    assert(selection.setSelectedIds === originalSetter, 'public setters must retain stable effect dependencies');
    assert(host.querySelector('select').disabled, 'deck picker must be disabled while pending');
    assert(host.querySelector('input').disabled, 'price splitter must be disabled while pending');
    await act(async () => { settleBulk(); await pending; });
    assert(!selection.bulkPending && !selection.selectMode && selection.selectedIds.size === 0, 'successful completion clears submitted selection and allows owner to exit');
    assert(changes.length === 1 && changes[0].ids.join() === '1', 'completion belongs to submitted IDs exactly once');

    await act(async () => { selection.arm(2); });
    await act(async () => { pending = selection.runBulk('trade'); });
    await act(async () => { settleBulk(409); await pending; });
    assert(!selection.bulkPending && selection.selectedIds.has(2) && changes.length === 1, 'failure releases guard but preserves retry selection');
    window.confirm = () => false;
    const beforeCancel = requests.length;
    await act(async () => { await selection.runBulk('delete', null, 'Delete?'); });
    assert(requests.length === beforeCancel && !selection.bulkPending, 'cancelled confirmation must not submit or acquire pending ownership');

    await changeValue(host.querySelector('input'), '12');
    await act(async () => { host.querySelector('button').click(); });
    assert(requests.at(-1).action === 'purchase_split' && requests.at(-1).value.total === 12 && selection.bulkPending, 'price splitter must use shared pending mutation boundary');
    await act(async () => { settleBulk(); });
    assert(!selection.bulkPending && changes.length === 2, 'price split completion must refresh once through shared owner');
    await act(async () => { root.render(null); });

    const card = {
      entry_id: 42, card_id: 'mtg-fixture', game: 'mtg', name: 'Fixture card',
      quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English',
      list_type: 'collection', location_id: 7, compartment_id: 70, position: 3,
      notes: '', types: [], subtypes: [],
    };
    const inspectorCase = async (entry, edit, check) => {
      await act(async () => { root.render(<CardInspectorModal card={entry} startInEdit onClose={() => {}} showToast={() => {}} />); });
      await edit();
      const before = requests.length;
      await act(async () => { host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      assert(requests.length === before + 1, 'inspector must submit exactly one PUT');
      check(requests.at(-1));
      // The real modal owns a history entry; wait for its cleanup before the next case.
      const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
      await act(async () => { root.render(null); });
      await popped;
    };
    await inspectorCase(card, () => changeValue(host.querySelector('#inspector-notes'), 'Keep placement'), payload => {
      assert(payload.notes === 'Keep placement', 'notes draft must be submitted');
      assert(!('location_id' in payload) && !('compartment_id' in payload) && !('quantity' in payload), 'metadata-only save must not move filed/locked copy or touch unchanged quantity');
    });
    await inspectorCase(card, async () => {
      await changeValue(host.querySelector('#inspector-location'), '8');
      await changeValue(host.querySelector('#inspector-location'), '7');
    }, payload => assert(!('location_id' in payload), 'numeric saved ID and string selected ID must compare equally'));
    await inspectorCase(card, () => changeValue(host.querySelector('#inspector-location'), '8'), payload => assert(payload.location_id === 8, 'intentional move must submit chosen location'));
    await inspectorCase(card, () => changeValue(host.querySelector('#inspector-location'), ''), payload => assert(payload.location_id === null, 'intentional unassign must submit null'));
    await inspectorCase({ ...card, list_type: 'wishlist' }, async () => {
      await act(async () => { host.querySelector('#markOwned').click(); });
    }, payload => assert(payload.list_type === 'collection' && payload.location_id === 7, 'explicit inventory change must preserve chosen-container resolution'));

    const second = { ...card, entry_id: 43, quantity: 2, condition: 'Lightly Played', printing: 'Holofoil', language: 'German', location_id: 8, location_name: 'Other binder', position: 5000, notes: 'Second entry' };
    const stack = { ...card, quantity: 3, stack_entries: [card, second] };
    storedEntries.set(card.entry_id, { ...card });
    storedEntries.set(second.entry_id, { ...second });
    const trigger = document.createElement('button');
    host.before(trigger);
    try {
      for (const startInEdit of [false, true]) {
        let closed = 0;
        trigger.focus();
        const before = requests.length;
        await act(async () => { root.render(<CardInspectorModal card={stack} startInEdit={startInEdit} onClose={() => { closed++; }} />); });
        assert(!host.querySelector('form') && !host.querySelector('input'), 'aggregate must not expose entry controls before explicit selection, including startInEdit');
        const buttons = host.querySelectorAll('button');
        assert(buttons.length === 3, 'aggregate must offer its two original entries and cancel only');
        assert(buttons[1].textContent.includes('Holofoil') && buttons[1].textContent.includes('German') && buttons[1].textContent.includes('×2') && buttons[1].textContent.includes('Other binder') && buttons[1].textContent.includes('5') && buttons[1].textContent.includes('43'), 'choice must identify member metadata, quantity, placement and entry ID');
        await act(async () => {
          if (startInEdit) host.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
          else buttons[2].click();
        });
        assert(closed === 1 && requests.length === before, 'cancel and Escape must close the picker without mutation');
        await act(async () => { root.render(null); });
        assert(document.activeElement === trigger, 'picker dismissal must restore trigger focus');
      }
      const chooseSecond = async () => {
        await act(async () => { host.querySelectorAll('button')[1].click(); });
        assert(host.querySelector('[id$="-quantity"]').value === '2', 'selected quantity must be the original member quantity, never aggregate total');
        assert(host.querySelector('[id$="-condition"]').value === second.condition && host.querySelector('[id$="-printing"]').value === second.printing && host.querySelector('[id$="-language"]').value === second.language, 'draft metadata must come from selected member');
        assert(host.querySelector('#inspector-location').value === '8' && host.querySelector('#inspector-notes').value === second.notes, 'draft placement and notes must come from selected member');
      };
      await inspectorCase(stack, async () => {
        await chooseSecond();
        await changeValue(host.querySelector('#inspector-notes'), 'Only second entry');
      }, payload => {
        assert(putTargets.at(-1) === 43 && payload.notes === 'Only second entry' && payload.printing === 'Holofoil' && payload.language === 'German' && !('quantity' in payload), 'metadata-only stack save must target selected original entry only');
      });
      await inspectorCase(stack, async () => {
        await chooseSecond();
        await changeValue(host.querySelector('[id$="-quantity"]'), '4');
        await act(async () => { host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        assert(putTargets.at(-1) === 43 && requests.at(-1).quantity === 4, 'quantity edit must submit selected entry absolute quantity');
      }, payload => {
        assert(putTargets.at(-1) === 43 && payload.quantity === 4 && storedEntries.get(43).quantity === 4, 'repeat save must retain absolute selected-entry quantity');
        assert(storedEntries.get(42).quantity === 1 && storedEntries.get(42).notes === '' && card.quantity === 1 && second.quantity === 2, 'other copies and original aggregate members must remain untouched');
      });
      await inspectorCase({ ...stack, quantity: 99, stack_entries: [second] }, async () => {
        assert(host.querySelector('[id$="-quantity"]').value === '2', 'single-member aggregate must directly edit its original row, not presentation quantity');
      }, payload => assert(putTargets.at(-1) === 43 && !('quantity' in payload), 'single-member aggregate saves its original row'));
    } finally {
      trigger.remove();
    }
    return { passed: true, cases: ['bulk duplicate guard', 'pending selection ownership', 'failure retry', 'cancelled confirmation', 'shared price split', 'metadata placement', 'normalized unchanged location', 'intentional move', 'unassign', 'inventory change', 'aggregate choice gate', 'picker cancel and Escape', 'picker focus restoration', 'mixed-stack member draft', 'selected-entry payload', 'repeat absolute quantity save', 'single-member aggregate'] };
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    window.fetch = originalFetch;
    window.confirm = originalConfirm;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  }
}
