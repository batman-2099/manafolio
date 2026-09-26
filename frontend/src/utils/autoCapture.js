// When auto-scan takes the picture.
//
// The rule is ONE SCAN PER CARD PRESENTED, not a scan every N milliseconds.
// Interval capture rescanned a card that was simply sitting there while the user
// reached for the next one, and made a card placed just after a tick wait out the
// rest of the beat for nothing.
//
// So this is an edge trigger with an explicit armed/disarmed state:
//
//   armed --(steady, well-framed card)--> CAPTURE --> disarmed
//   disarmed --(frame empties, or a visibly different quad appears)--> armed
//
// Pure on purpose: the component owns the refs and the camera, this owns the
// decision, and the decision is the part worth testing.

// Consecutive empty frames before re-arming. At ~60ms per detection this is
// about a fifth of a second of clear mat — long enough that a hand crossing the
// frame is not mistaken for the card being taken away.
export const REARM_EMPTY_FRAMES = 3;
// How far the quad must move from the captured one to count as a different card.
// Well above the ~0.012 jitter of a card lying still.
export const REARM_DRIFT = 0.09;
// Floor between two captures, against a double fire while the first request is
// still being assembled. NOT a cadence: nothing fires just because it elapses.
export const MIN_RECAPTURE_MS = 600;

// WORST corner movement between two quads, in normalised units — deliberately not
// the mean that cardDetector.meanCornerDrift returns. One corner slipping off the
// card is a different card even when the other three sit still, and the mean
// divides that signal by four. REARM_DRIFT is tuned against this metric; the two
// are not interchangeable, which is why neither is called just "quadDrift" any
// more.
export function worstCornerDrift(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return Infinity;
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    worst = Math.max(worst, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  }
  return worst;
}

// Should a disarmed scanner become ready again?
//
// `emptyFrames` counts consecutive no-card readings. `quad` is the current
// detection (null when there is none) and `capturedQuad` the one that was last
// photographed. Comparing against the CAPTURED quad rather than the previous
// frame matters: drift compared frame-to-frame never accumulates while a user
// holds a card still, so a slow hand would re-arm on the same card.
export function shouldRearm({ armed, emptyFrames, quad, capturedQuad }) {
  if (armed) return true;
  if (emptyFrames >= REARM_EMPTY_FRAMES) return true;
  if (!quad) return false;
  if (!capturedQuad) return true;
  return worstCornerDrift(capturedQuad, quad) > REARM_DRIFT;
}

// Should the shutter fire right now?
//
// `reading` is the latest detector result: { none, steady, fill, at }. A missing
// reading is NOT permission — the old code answered "yes" when it had no opinion,
// which was survivable only because the old contour detector always returned
// something. A detector that can say "there is no card" has to be believed.
export function shouldCapture({
  armed, busy, blocked, reading, now, lastCaptureAt,
  minSteady, minFill, staleMs = 1500,
}) {
  if (!armed || busy || blocked) return false;
  if (now - lastCaptureAt < MIN_RECAPTURE_MS) return false;
  if (!reading || reading.none) return false;
  if (now - reading.at > staleMs) return false;      // detection loop has stalled
  return reading.steady >= minSteady && reading.fill >= minFill;
}

// What auto-scan is waiting for, as a label key + severity. Derived from the same
// inputs as shouldCapture so the badge can never claim "Ready" while the trigger
// is declining, which is how a user ends up thinking the scanner is broken.
export function autoStatusKey({ armed, busy, blocked, reading, now, minSteady, minFill, staleMs = 1500 }) {
  if (busy) return 'scanning';
  if (blocked) return 'waiting';
  if (!armed) return 'lift';
  if (!reading || reading.none || now - reading.at > staleMs) return 'nocard';
  if (reading.fill < minFill) return 'closer';
  if (reading.steady < minSteady) return 'hold';
  return 'ready';
}

export const SCAN_MATCH_MIN_SCORE = 0.55;
export const SCAN_MATCH_MIN_INLIERS = 12;
export const SCAN_MATCH_MIN_MARGIN = 0.02;

// Server safety is required as well as the existing visual confidence gates.
export function scanMatchReasons({ verified, candidates = [], notInCatalog, safety }) {
  const reasons = new Set(safety?.reasons || []);
  const [top, second] = candidates;
  if (!top || !(verified ? top.inliers >= SCAN_MATCH_MIN_INLIERS : top.score >= SCAN_MATCH_MIN_SCORE)
      || (!verified && second && top.score - second.score < SCAN_MATCH_MIN_MARGIN)) reasons.add('low_confidence');
  if (top && second && top.name === second.name
      && (top.set !== second.set || top.number !== second.number)
      && (verified ? second.inliers >= top.inliers * 0.7 : second.score >= top.score - 0.02)) {
    reasons.add('ambiguous_printing');
  }
  if (notInCatalog) reasons.add('not_in_catalog');
  if (safety?.quality?.blurry) reasons.add('blur');
  if (safety?.quality?.glare) reasons.add('glare');
  if (safety?.context?.setFallback) reasons.add('set_fallback');
  if (safety?.context?.languageFallback) reasons.add('language_fallback');
  if (['conflict', 'unavailable', 'error'].includes(safety?.ocr?.status)) {
    reasons.add(`ocr_${safety.ocr.status}`);
  }
  if (safety?.autoAddSafe !== true && reasons.size === 0) reasons.add('review_required');
  return [...reasons];
}

// A disagreement or unsafe pass cannot be outvoted later in the same scan.
// A new capture session starts with null, never with the previous card's count.
export function recordScanPass(previous, { frame, cardId, safe }) {
  const changed = !!previous && previous.cardId !== cardId;
  const fresh = Number.isFinite(frame) && (!previous || frame > previous.frame);
  const blocked = !!previous?.blocked || !safe || !cardId || !fresh;
  const disagreed = !!previous?.disagreed || changed;
  const count = safe && fresh && cardId ? (changed ? 1 : (previous?.count || 0) + 1) : 0;
  return { frame, cardId, count, blocked, disagreed, ready: count >= 2 && !blocked && !disagreed };
}

// Wait for a decoded video frame, not merely another render of the same pixels.
export function waitForVideoFrame(video, signal) {
  return new Promise((resolve, reject) => {
    const startTime = video.currentTime;
    const videoCallback = typeof video.requestVideoFrameCallback === 'function';
    let callback;
    let timer;
    const finish = (error, time) => {
      clearTimeout(timer);
      if (callback !== undefined) {
        if (videoCallback) video.cancelVideoFrameCallback(callback);
        else cancelAnimationFrame(callback);
      }
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(time);
    };
    const abort = () => finish(new DOMException('Scan cancelled', 'AbortError'));
    const schedule = () => {
      callback = videoCallback ? video.requestVideoFrameCallback(check) : requestAnimationFrame(check);
    };
    const check = (_, metadata) => {
      const time = metadata?.mediaTime ?? video.currentTime;
      if (video.readyState >= 2 && !video.paused && time > startTime) finish(null, time);
      else schedule();
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('fresh_frame_unavailable')), 2500);
    schedule();
  });
}
