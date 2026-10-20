import { act } from 'react';
import { createRoot } from 'react-dom/client';
import CameraScanner from '../components/CameraScanner';
import CardEntryFields from '../components/CardEntryFields';
import en from '../locales/en.json';

// Run on an isolated styled Vite page; camera, detector and every API are mocked.
// await (await import('/src/utils/uiScanner.browser.test.jsx')).runUiScannerRegressions()
export async function runUiScannerRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const restore = [];
  const patch = (object, key, descriptor) => {
    const original = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, ...descriptor });
    restore.push(() => original ? Object.defineProperty(object, key, original) : delete object[key]);
  };
  const storage = { ...localStorage };
  const historyState = history.state;
  const historyUrl = location.href;
  const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const card = { id: 'mtg-scanner-en', name: 'Scanner fixture', set_id: 'tst', set_name: 'Test set', number: '1', game: 'mtg', language: 'English', image_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' };
  const token = { ...card, id: 'mtg-scanner-token', name: 'Scanner token', subtypes: ['Token'] };
  const reverse = { ...token, id: 'mtg-scanner-reverse', name: 'Reverse token', number: '2' };
  let matchedCard = card;
  let queuedDrafts = [];
  let commitFailure = false;
  let patchFailure = false;
  const committed = [];
  const patched = [];
  let cameraCalls = 0;
  let stopped = 0;
  let detectorHasCard = false;
  let scanRequests = 0;
  let detectorRequests = 0;
  let videoDraws = 0;
  let printingReply;
  let saveFailure = false;
  const saved = [];
  const unexpected = [];
  let frame = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settle = async (ms = 40) => { await act(async () => { await sleep(ms); }); };
  const until = async (predicate, message) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`${message}; ${JSON.stringify({
      scanRequests, detectorRequests, videoDraws, frame, unexpected,
      video: host.querySelector('video')?.getBoundingClientRect().toJSON(),
      guide: host.querySelector('.scan-card-guide')?.getBoundingClientRect().toJSON(),
      status: [...host.querySelectorAll('[role="status"], [role="alert"]')].map(element => element.textContent),
      dialogs: [...host.querySelectorAll('dialog')].map(element => element.textContent),
      text: host.textContent,
    })}`);
  };
  const closeGuard = async effect => {
    const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    await act(effect);
    await popped;
    await act(async () => {});
  };
  const click = async (element, closingDialog = null) => {
    assert(element && !element.matches(':disabled'), 'click target must be enabled');
    if (closingDialog) await closeGuard(async () => element.click());
    else await act(async () => element.click());
    await settle();
  };
  const change = async (element, value) => {
    assert(element && !element.matches(':disabled'), 'change target must be enabled');
    if (element instanceof HTMLSelectElement) assert([...element.options].some(option => option.value === value), `select must offer ${value}`);
    await act(async () => {
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  };
  const button = (text, scope = host) => [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === text);
  const drawer = () => host.querySelector('dialog[aria-labelledby="scan-drawer-title"]');
  const countdown = () => host.querySelector('dialog[aria-labelledby="scan-countdown-title"]');
  const duplicate = () => host.querySelector('dialog[aria-labelledby="scan-duplicate-title"]');
  const prompt = () => [...host.querySelectorAll('dialog')].find(dialog => dialog.querySelector('h2')?.textContent === en['token.promptTitle']);
  const quantity = () => host.querySelector('[id$="-quantity"]');
  const language = () => drawer()?.querySelector('[id$="-language"]');
  const submit = async () => { await act(async () => drawer().querySelector('form').requestSubmit()); };
  const present = async target => {
    detectorHasCard = false;
    await settle(650);
    detectorHasCard = true;
    await until(target, 'a safe two-frame scan must open the expected review surface');
    detectorHasCard = false;
  };
  const dismiss = async dialog => {
    const effect = async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    if ([prompt(), countdown(), duplicate()].includes(dialog)) await closeGuard(effect);
    else await act(effect);
    await settle();
  };
  const chooseReverse = async () => {
    await click(button(en['shared.search'], prompt()));
    await change(prompt().querySelector('select'), reverse.id);
    await click(button(en['token.useReverse'], prompt()), prompt());
  };
  try {
    for (const key of Object.keys(storage)) if (key.startsWith('scan_') || key.startsWith('scanner_')) localStorage.removeItem(key);
    localStorage.setItem('scan_auto_add', '0');
    localStorage.setItem('scanner_lang', 'en');
    patch(window, 'AudioContext', { value: undefined });
    patch(window, 'webkitAudioContext', { value: undefined });
    patch(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
      cameraCalls++;
      if (cameraCalls === 1) throw new DOMException('Fixture permission denial', 'NotAllowedError');
      const track = { stop: () => { stopped++; }, getCapabilities: () => ({ exposureCompensation: { min: -2, max: 2, step: 0.5 } }), getSettings: () => ({ exposureCompensation: 0 }), applyConstraints: async () => {} };
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    } } });
    patch(HTMLMediaElement.prototype, 'srcObject', { get() { return this.fixtureStream; }, set(value) { this.fixtureStream = value; } });
    patch(HTMLMediaElement.prototype, 'play', { value: async () => {} });
    patch(HTMLMediaElement.prototype, 'readyState', { get: () => 4 });
    patch(HTMLMediaElement.prototype, 'paused', { get: () => false });
    patch(HTMLMediaElement.prototype, 'currentTime', { get: () => frame });
    patch(HTMLVideoElement.prototype, 'videoWidth', { get: () => 640 });
    patch(HTMLVideoElement.prototype, 'videoHeight', { get: () => 480 });
    patch(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { value(callback) { return setTimeout(() => callback(performance.now(), { mediaTime: ++frame }), 0); } });
    patch(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { value(handle) { window.clearTimeout(handle); } });
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    patch(CanvasRenderingContext2D.prototype, 'drawImage', { value(image, ...args) {
      if (image instanceof HTMLVideoElement) { videoDraws++; this.fillStyle = '#888'; this.fillRect(0, 0, this.canvas.width, this.canvas.height); }
      else drawImage.call(this, image, ...args);
    } });
    patch(window, 'Worker', { value: class {
      postMessage() { detectorRequests++; queueMicrotask(() => { if (!this.stopped) this.onmessage?.({ data: detectorHasCard ? { detected: true, quad: [{ x: 0.05, y: 0.05 }, { x: 0.95, y: 0.05 }, { x: 0.95, y: 0.95 }, { x: 0.05, y: 0.95 }], pick: { fill: 0.81 } } : { detected: false } }); }); }
      terminate() { this.stopped = true; }
    } });
    patch(window, 'fetch', { value: async (url, options = {}) => {
      if (url === '/api/card-art/index') return response([]);
      if (url === '/api/scan-drafts' && !options.method) return response(queuedDrafts);
      if (String(url).startsWith('/api/sets?')) return response([]);
      if (String(url).startsWith('/api/scan-sets?')) return response({ game: 'mtg', builtLangs: ['English'], local: true, sets: { tst: { cached: 1, embedded: 1 } } });
      if (url === '/api/scan-match') {
        scanRequests++;
        return response({ game: 'mtg', verified: true, candidates: [{ name: matchedCard.name, set: 'tst', number: '1', score: 0.99, inliers: 40, card: matchedCard }], safety: { autoAddSafe: true } });
      }
      if (String(url).includes('/printing?')) return new Promise(resolve => { printingReply = (body, status = 200) => resolve(response(body, status)); });
      if (String(url).startsWith('/api/search?')) return response([token, reverse]);
      if (url === '/api/scan-drafts/commit') {
        const payload = JSON.parse(options.body);
        committed.push(payload);
        if (commitFailure) return response({ error: 'Sample commit failure' }, 503);
        queuedDrafts = queuedDrafts.filter(draft => !payload.draft_ids.includes(draft.draft_id));
        return response({ added: payload.draft_ids.length });
      }
      if (String(url).startsWith('/api/scan-drafts/') && options.method === 'PATCH') {
        const payload = JSON.parse(options.body);
        patched.push(payload);
        if (patchFailure) return response({ error: 'Sample patch failure' }, 503);
        const draftId = Number(url.split('/').at(-1));
        const draft = { ...queuedDrafts.find(item => item.draft_id === draftId), ...payload };
        queuedDrafts = queuedDrafts.map(item => item.draft_id === draftId ? draft : item);
        return response(draft);
      }
      if (url === '/api/scan-drafts' && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        saved.push(payload);
        if (saveFailure) return response({ error: 'quantity must be an integer from 1 to 250' }, 400);
        const draft = { ...matchedCard, ...payload, id: payload.card_id, draft_id: saved.length };
        queuedDrafts = [draft, ...queuedDrafts];
        return response(draft);
      }
      unexpected.push(String(url));
      throw new Error(`Unexpected fixture request: ${url}`);
    } });
    await act(async () => root.render(<CameraScanner showToast={() => {}} onAddSuccess={() => {}} />));
    await click(button('Activate Camera'));
    assert(cameraCalls === 1 && button('Retry Camera'), 'permission failure must offer native retry');
    await click(button('Retry Camera'));
    assert(cameraCalls === 2, 'one retry click must request exactly one camera stream');
    await click(host.querySelector('button[aria-label="Scan settings"]'));
    for (const id of ['scan-fill', 'scan-steady', 'scan-exposure']) {
      const input = host.querySelector(`#${id}`);
      assert(input?.labels.length === 1 && input.labels[0].textContent.trim(), `${id} must have an associated visible label`);
    }
    await present(drawer);
    assert(scanRequests === 2, 'opening a review must retain independent two-frame safety checks');
    for (const [body, status] of [[{ error: 'Unavailable' }, 503], [{}, 200]]) {
      await change(language(), 'German');
      assert(language().matches(':disabled'), 'printing lookup must lock submission fields');
      await act(async () => printingReply(body, status));
      assert(language().value === 'English' && drawer().querySelector('[role="alert"]')?.textContent.includes('previous language'), 'failed or empty localization must restore language and announce recovery');
    }
    await change(language(), 'German');
    await dismiss(drawer());
    assert(!drawer(), 'Escape must allow abandoning a pending read');
    await present(drawer);
    await act(async () => printingReply({ ...card, id: 'mtg-stale-de', language: 'German' }));
    assert(language().value === 'English', 'late language response must not mutate a replacement drawer');
    await change(language(), 'German');
    await act(async () => printingReply({ ...card, id: 'mtg-scanner-de', language: 'German' }));
    assert(language().value === 'German', 'language retry must succeed');
    for (const invalid of ['251', '1.5', '0']) {
      await change(quantity(), invalid);
      assert(!quantity().checkValidity(), 'scanner quantity must enforce integer 1..250');
      const before = saved.length;
      await submit();
      assert(saved.length === before, 'invalid native form must not queue a card');
    }
    await change(quantity(), '250');
    await click(host.querySelector('button[aria-label="Increase quantity"]'));
    assert(quantity().value === '250', 'scanner increment must respect its maximum');
    saveFailure = true;
    await submit();
    assert(drawer() && drawer().querySelector('[role="alert"]')?.textContent.includes('1 to 250'), 'server rejection must preserve the form and expose actionable validation details');
    saveFailure = false;
    await submit();
    assert(!drawer() && saved.at(-1).card_id === 'mtg-scanner-de' && saved.at(-1).language === 'German', 'retry must queue the matching localized printing and language');
    await click(host.querySelector('[role="switch"][aria-describedby="scan-auto-queue-hint"]'));
    const trigger = host.querySelector('button[aria-label="Scan settings"]');
    trigger.focus();
    await present(countdown);
    assert(countdown().open && countdown().contains(document.activeElement), 'countdown must own native modal focus');
    const beforeCancel = saved.length;
    await dismiss(countdown());
    assert(document.activeElement === trigger, 'countdown cancellation must restore focus');
    await settle(2200);
    assert(!countdown() && saved.length === beforeCancel, 'Escape must cancel the countdown without a delayed draft');
    await present(countdown);
    await click(button('Queue now'), countdown());
    assert(saved.length === beforeCancel + 1, 'explicit countdown action must queue once');
    trigger.focus();
    await present(duplicate);
    assert(duplicate().open && duplicate().contains(document.activeElement), 'duplicate confirmation must own native modal focus');
    const beforeDuplicate = saved.length;
    await dismiss(duplicate());
    assert(!duplicate() && saved.length === beforeDuplicate && document.activeElement === trigger, 'duplicate Escape must discard without adding and restore focus');
    matchedCard = token;
    await click(host.querySelector('[role="switch"][aria-describedby="scan-auto-queue-hint"]'));
    await present(drawer);
    await change(quantity(), '3');
    const beforeToken = saved.length;
    await submit();
    assert(prompt() && saved.length === beforeToken, 'manual token queue must ask before writing a draft');
    await submit();
    assert(saved.length === beforeToken && host.querySelectorAll('dialog').length === 2, 'pending prompt blocks repeat submits');
    await dismiss(prompt());
    assert(drawer() && quantity().value === '3' && saved.length === beforeToken, 'cancel preserves the editable token and quantity');
    await submit();
    await chooseReverse();
    assert(!drawer() && saved.at(-1).reverse_card_id === reverse.id && saved.at(-1).quantity === 3, 'manual queue saves the selected reverse with the original quantity');
    await click(button(en['common.edit'], host.querySelector('.scan-review-card')));
    await change(drawer().querySelector('select[id$="-choice"]'), '');
    await submit();
    assert(!prompt() && !drawer() && patched.at(-1).reverse_card_id === null, 'editing an existing draft can clear its reverse without another prompt');
    commitFailure = true;
    await click(button(en['search.addToCollection']));
    assert(!prompt() && host.querySelector('.scan-review-card'), 'failed commit preserves reviewed drafts without asking twice');
    commitFailure = false;
    await click(button(en['search.addToCollection']));
    assert(!prompt() && !host.querySelector('.scan-review-card'), 'retry commits the reviewed batch without another reverse prompt');
    await click(host.querySelector('[role="switch"][aria-describedby="scan-auto-queue-hint"]'));
    await present(countdown);
    await click(button('Queue now'), countdown());
    const beforeAutoToken = saved.length;
    const pausedRequests = scanRequests;
    detectorHasCard = true;
    await settle(650);
    assert(prompt() && saved.length === beforeAutoToken && scanRequests === pausedRequests, 'automatic token prompt pauses capture and draft writes');
    await dismiss(prompt());
    await settle(3200);
    assert(!prompt() && !duplicate() && !countdown() && saved.length === beforeAutoToken, 'cancelled token lingering in view never enters a repeat-prompt loop');
    await present(countdown);
    await click(button('Queue now'), countdown());
    await click(button(en['token.continueWithout'], prompt()), prompt());
    assert(saved.length === beforeAutoToken + 1 && saved.at(-1).reverse_card_id === null, 'a newly presented cancelled token can explicitly queue without a reverse');
    await click(button(en['search.addToCollection']));
    assert(!prompt() && !host.querySelector('.scan-review-card'), 'explicitly skipped automatic drafts are not prompted again at commit');
    await act(async () => root.render(null));
    await settle();
    queuedDrafts = [
      { ...token, draft_id: 101, card_id: token.id, quantity: 4, location_id: 9, condition: 'Near Mint', printing: 'Normal', purchase_price: 0 },
      { ...reverse, draft_id: 102, card_id: reverse.id, quantity: 2, location_id: null, condition: 'Near Mint', printing: 'Normal', purchase_price: 0 },
      { ...token, draft_id: 103, card_id: token.id, reverse_card_id: reverse.id, quantity: 1, condition: 'Near Mint', printing: 'Normal', purchase_price: 0 },
    ];
    await act(async () => root.render(<CameraScanner showToast={() => {}} onAddSuccess={() => {}} />));
    const beforeOldCommit = committed.length;
    const beforeOldPatch = patched.length;
    await click(button(en['search.addToCollection']));
    await dismiss(prompt());
    assert(committed.length === beforeOldCommit && patched.length === beforeOldPatch, 'cancelling review of older token drafts never commits inventory');
    patchFailure = true;
    await click(button(en['search.addToCollection']));
    await chooseReverse();
    assert(committed.length === beforeOldCommit && queuedDrafts.length === 3, 'failed reverse patch prevents commit and retains the queued batch');
    patchFailure = false;
    await click(button(en['search.addToCollection']));
    await chooseReverse();
    assert(prompt()?.textContent.includes(reverse.name), 'each older unpaired draft receives its own decision');
    await dismiss(prompt());
    const updatedDraft = queuedDrafts.find(draft => draft.draft_id === 101);
    assert(committed.length === beforeOldCommit && updatedDraft.reverse_card_id === reverse.id && updatedDraft.quantity === 4 && updatedDraft.location_id === 9, 'partial review only patches reverse metadata, preserving quantity and location without committing inventory');
    await click(button(en['search.addToCollection']));
    assert(prompt()?.textContent.includes(reverse.name), 'retry skips the already paired draft and resumes the undecided token');
    commitFailure = true;
    await click(button(en['token.continueWithout'], prompt()), prompt());
    assert(!prompt() && committed.length === beforeOldCommit + 1 && queuedDrafts.length === 3, 'failed final commit preserves all paired and explicitly skipped drafts');
    commitFailure = false;
    const beforeRetryPatch = patched.length;
    await click(button(en['search.addToCollection']));
    assert(!prompt() && queuedDrafts.length === 0 && patched.length === beforeRetryPatch, 'commit retry neither repeats token decisions nor patches existing pairs');
    await act(async () => root.render(<CardEntryFields quantity="251" purchasePrice={0} condition="Near Mint" printing="Normal" language="English" game="mtg" onQuantity={() => {}} onPurchasePrice={() => {}} onCondition={() => {}} onPrinting={() => {}} onLanguage={() => {}} />));
    assert(quantity().max === '' && quantity().checkValidity(), 'non-scanner collection fields must not inherit the scan-only cap');
    assert(stopped === 1 && unexpected.length === 0, `camera tracks must stop and all network must stay in the fixture: stopped=${stopped}, requests=${unexpected.join(', ')}`);
    return { passed: true, cases: ['single native camera retry', 'associated tuning labels', 'two-frame recognition preserved', 'failed and empty language rollback', 'stale language response after dismissal', 'language retry identity', 'scan-only integer quantity limit', 'server rejection and recovery', 'countdown focus/Escape cancellation', 'explicit queue once', 'duplicate focus/Escape discard', 'manual token prompt and cancellation', 'token quantity and reverse persistence', 'existing reverse removal', 'automatic prompt capture pause', 'cancelled token repeat suppression', 'explicit unpaired continuation', 'older draft review before commit', 'reverse patch and commit recovery', 'session decisions skip repeat prompts', 'uncapped collection quantity'] };
  } finally {
    detectorHasCard = false;
    await act(async () => root.unmount());
    await settle();
    host.remove();
    for (const undo of restore.reverse()) undo();
    localStorage.clear();
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    history.replaceState(historyState, '', historyUrl);
    globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
}
