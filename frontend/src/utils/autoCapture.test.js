import assert from 'node:assert';
import {
  shouldCapture, shouldRearm, autoStatusKey, worstCornerDrift,
  REARM_EMPTY_FRAMES, REARM_DRIFT, MIN_RECAPTURE_MS,
  recordScanPass, scanMatchReasons,
} from './autoCapture.js';

const GATE = { minSteady: 3, minFill: 0.55 };
const NOW = 1_000_000;
const quad = (x, y) => [
  { x, y }, { x: x + 0.6, y }, { x: x + 0.6, y: y + 0.8 }, { x, y: y + 0.8 },
];
const good = { none: false, steady: 4, fill: 0.8, at: NOW };
const base = { armed: true, busy: false, blocked: false, reading: good, now: NOW, lastCaptureAt: 0, ...GATE };

// --- the whole point: a card present and still fires exactly once ------------
assert.strictEqual(shouldCapture(base), true, 'steady framed card captures');
assert.strictEqual(shouldCapture({ ...base, armed: false }), false, 'disarmed does not re-fire on the same card');

// --- no card must NEVER fire. This is the regression that photographed desks --
assert.strictEqual(shouldCapture({ ...base, reading: { none: true, at: NOW } }), false, 'explicit no-card');
assert.strictEqual(shouldCapture({ ...base, reading: null }), false, 'no reading yet is not permission');
assert.strictEqual(shouldCapture({ ...base, reading: { ...good, at: NOW - 5000 } }), false, 'stale reading');

// --- quality gates -----------------------------------------------------------
assert.strictEqual(shouldCapture({ ...base, reading: { ...good, steady: 1 } }), false, 'still moving');
assert.strictEqual(shouldCapture({ ...base, reading: { ...good, fill: 0.2 } }), false, 'card too small in frame');

// --- busy / blocked ----------------------------------------------------------
assert.strictEqual(shouldCapture({ ...base, busy: true }), false, 'scan in flight');
assert.strictEqual(shouldCapture({ ...base, blocked: true }), false, 'modal up');
assert.strictEqual(shouldCapture({ ...base, lastCaptureAt: NOW - 100 }), false, 'debounce floor');
assert.strictEqual(shouldCapture({ ...base, lastCaptureAt: NOW - MIN_RECAPTURE_MS - 1 }), true, 'past the floor');

// --- re-arming ---------------------------------------------------------------
const held = quad(0.2, 0.1);
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: held, capturedQuad: held }), false,
  'same card held still stays disarmed');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: REARM_EMPTY_FRAMES, quad: null, capturedQuad: held }), true,
  'card lifted re-arms');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 1, quad: null, capturedQuad: held }), false,
  'one empty frame is not enough (a hand passing over)');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: quad(0.2, 0.1 + REARM_DRIFT + 0.02), capturedQuad: held }), true,
  'card swapped without the frame emptying re-arms');
assert.strictEqual(
  shouldRearm({ armed: false, emptyFrames: 0, quad: quad(0.2, 0.105), capturedQuad: held }), false,
  'small drift while holding does not re-arm');

// Drift is measured against the CAPTURED quad, so creeping frame-by-frame never
// accumulates into a false re-arm.
let creeping = held;
for (let i = 0; i < 20; i++) {
  creeping = quad(0.2, 0.1 + i * 0.002);
  if (worstCornerDrift(held, creeping) > REARM_DRIFT) break;
}
assert.ok(worstCornerDrift(held, quad(0.2, 0.1 + 0.002)) < REARM_DRIFT, 'one creep step is below the threshold');

// --- status never disagrees with the trigger --------------------------------
assert.strictEqual(autoStatusKey({ ...base }), 'ready');
assert.strictEqual(autoStatusKey({ ...base, busy: true }), 'scanning');
assert.strictEqual(autoStatusKey({ ...base, blocked: true }), 'waiting');
assert.strictEqual(autoStatusKey({ ...base, armed: false }), 'lift');
assert.strictEqual(autoStatusKey({ ...base, reading: { none: true, at: NOW } }), 'nocard');
assert.strictEqual(autoStatusKey({ ...base, reading: { ...good, fill: 0.2 } }), 'closer');
assert.strictEqual(autoStatusKey({ ...base, reading: { ...good, steady: 1 } }), 'hold');

// If the badge says ready, the trigger must agree — the two are read off the
// same inputs and a mismatch is what makes a scanner look broken.
for (const reading of [good, { ...good, steady: 1 }, { ...good, fill: 0.1 }, { none: true, at: NOW }, null]) {
  const args = { ...base, reading };
  assert.strictEqual(
    autoStatusKey(args) === 'ready', shouldCapture(args),
    `status and trigger agree for ${JSON.stringify(reading)}`);
}

const safeResponse = {
  candidates: [{ name: 'Island', set: 'tst', number: '1', score: 0.9 }],
  safety: { autoAddSafe: true, reasons: [], ocr: { status: 'unreadable' } },
};
const firstPass = recordScanPass(null, { frame: 1, cardId: 'tst-1', safe: scanMatchReasons(safeResponse).length === 0 });
assert.strictEqual(firstPass.ready, false, 'one photo never authorizes auto-add, including Turbo');
assert.strictEqual(recordScanPass(firstPass, { frame: 2, cardId: 'tst-1', safe: true }).ready, true,
  'two fresh safe photos agree on one printing; unreadable footer alone does not exclude legacy cards');
assert.strictEqual(recordScanPass(firstPass, { frame: 1, cardId: 'tst-1', safe: true }).ready, false,
  'reusing the same decoded frame cannot confirm a printing');
const changedPass = recordScanPass(firstPass, { frame: 2, cardId: 'tst-2', safe: true });
assert.strictEqual(changedPass.count, 1, 'a changed printing resets agreement');
assert.strictEqual(recordScanPass(changedPass, { frame: 3, cardId: 'tst-2', safe: true }).ready, false,
  'a disagreement cannot be outvoted within the same scan');
assert.strictEqual(recordScanPass(null, { frame: 3, cardId: 'tst-1', safe: true }).ready, false,
  'a new context does not inherit the previous scan agreement');

const ambiguous = { ...safeResponse, candidates: [
  safeResponse.candidates[0], { name: 'Island', set: 'old', number: '2', score: 0.89 },
] };
assert.ok(scanMatchReasons(ambiguous).includes('ambiguous_printing'), 'similar printings require manual selection');
assert.strictEqual(recordScanPass(firstPass, { frame: 2, cardId: 'tst-1', safe: scanMatchReasons(ambiguous).length === 0 }).ready, false);
for (const status of ['conflict', 'unavailable', 'error']) {
  const unsafe = { ...safeResponse, safety: { ...safeResponse.safety, ocr: { status } } };
  assert.ok(scanMatchReasons(unsafe).includes(`ocr_${status}`));
  assert.strictEqual(recordScanPass(firstPass, { frame: 2, cardId: 'tst-1', safe: scanMatchReasons(unsafe).length === 0 }).ready, false,
    `OCR ${status} cannot be averaged away by an earlier safe response`);
}
const unsafeFirst = recordScanPass(null, { frame: 1, cardId: 'tst-1', safe: false });
assert.strictEqual(recordScanPass(unsafeFirst, { frame: 2, cardId: 'tst-1', safe: true }).ready, false,
  'a later safe response cannot erase an unsafe first pass');
assert.strictEqual(recordScanPass(firstPass, {
  frame: 2, cardId: 'tst-1', safe: scanMatchReasons({ ...safeResponse, safety: { autoAddSafe: false } }).length === 0,
}).ready, false, 'an explicit server veto is respected without reason codes');
assert.strictEqual(recordScanPass(firstPass, {
  frame: 2, cardId: 'tst-1', safe: scanMatchReasons({ ...safeResponse, safety: undefined }).length === 0,
}).ready, false, 'missing safety cannot authorize auto-add');

console.log('PASS: autoCapture.test.js');
