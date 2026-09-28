// Contour fallback for the browser's card detector.
//
// It runs on shared/imgproc.mjs rather than OpenCV. Every prebuilt OpenCV.js is
// 11-22 MB and phones could not instantiate it at all, which pinned detection to
// the server and cost a network round trip per preview frame. The dozen
// operations this needs are small enough to own outright, and owning them is
// what lets the outline run locally and continuously.
//
// The geometry and scoring below are carried over unchanged from the OpenCV
// version: they encode a long list of decisions that were each measured against
// test/crop.test.js, and re-deriving them would only lose that history.
//
// Pure pixel work on typed arrays — no handles to free, no network, no
// filesystem, and none of the wasm-heap leaks the previous version kept
// producing.
import {
  rgbaToGray, gaussianBlur5, otsuThreshold, morphClose, dilate, canny,
  connectedRegions, arcLength, approxPolyDP,
  isContourConvex, minAreaRect, orderQuad,
} from './imgproc.mjs';

const CARD_ASPECT = 2.5 / 3.5;

// Geometry of an ordered quad, or null if it is too small to judge. Used to throw
// out candidates that are not plausibly a card seen at an angle.
function quadMetrics(pts) {
  const [tl, tr, br, bl] = orderQuad(pts);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const top = d(tl, tr), bottom = d(bl, br), left = d(tl, bl), right = d(tr, br);
  if (Math.min(top, bottom, left, right) < 20) return null;
  const w = (top + bottom) / 2, h = (left + right) / 2;
  // How much the opposite sides agree. A real card (even in perspective) keeps
  // this high; a blob merging the card with a hand or a neighbouring card does not.
  const parallelism = (Math.min(top, bottom) / Math.max(top, bottom)) * (Math.min(left, right) / Math.max(left, right));

  // Corner orthogonality: check that corner angles stay close to 90 degrees (prevents shear/trapezoid distortion).
  const corners = [tl, tr, br, bl];
  let maxCos = 0;
  for (let i = 0; i < 4; i++) {
    const pPrev = corners[(i + 3) % 4];
    const pCurr = corners[i];
    const pNext = corners[(i + 1) % 4];
    const v1x = pPrev.x - pCurr.x, v1y = pPrev.y - pCurr.y;
    const v2x = pNext.x - pCurr.x, v2y = pNext.y - pCurr.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 > 0 && l2 > 0) {
      const cosVal = Math.abs((v1x * v2x + v1y * v2y) / (l1 * l2));
      if (cosVal > maxCos) maxCos = cosVal;
    }
  }
  const orthogonality = Math.max(0, 1 - maxCos);

  return { corners: [tl, tr, br, bl], w, h, ar: w / h, parallelism, orthogonality };
}

// Is this quad plausibly a portrait card?
//
// Portrait is required rather than rotated into place: the scanner's guide box is
// portrait and every indexed reference image is portrait upright, so a landscape
// quad means the detector merged the card with something else. Rotating it would
// be a coin flip on which way is up, and dHash recall is rotation-sensitive — so a
// landscape candidate is rejected instead of guessed at.
function isCardQuad(m) {
  return !!m && m.ar <= 0.95 && m.ar >= 0.5 && m.parallelism >= 0.6 && m.orthogonality >= 0.55;
}

// Simplify the region's existing convex hull to four perspective corners.
function findCardQuad(hull) {
  const peri = arcLength(hull);
  for (let epsScale = 0.015; epsScale <= 0.12; epsScale += 0.005) {
    const approx = approxPolyDP(hull, epsScale * peri);
    if (approx.length === 4 && isContourConvex(approx)) {
      return approx.map((p) => ({ x: p.x, y: p.y }));
    }
  }
  return null;
}

// Canny thresholds from the frame's own median intensity, not fixed.
//
// 50/150 suits a well-lit photo. In a dim room the histogram slides down,
// gradients across the card border shrink with it, and a fixed 50 rejects them
// — Canny returns almost nothing and the card's outline never enters the
// candidate list. The 0.66/1.33 spread is the standard auto-Canny rule; the
// floor on `hi` stops a nearly-black frame calling every sensor speckle an edge.
function cannyThresholds(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const half = gray.length / 2;
  let cum = 0, median = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= half) { median = v; break; } }
  return [Math.max(10, Math.round(0.66 * median)), Math.max(40, Math.round(1.33 * median))];
}

// Every way we know of turning a photo into "regions that might be a card".
// One segmentation is not enough:
//   - OTSU (both polarities) is cheapest and wins on a plain table, but merges
//     the card with anything of similar brightness touching it.
//   - Canny keys on the card's BORDER instead of its brightness, so it survives
//     a hand, glare, and a background close to the card's tone.
// Two Canny passes: fixed thresholds suit a bright scene, median-derived ones a
// dim scene, and each fails where the other works. All four compete on the same
// card-likeness score, so a wrong region still has to beat a right one.
function segmentations(blur, w, h) {
  const closeK = Math.max(15, Math.round(Math.min(w, h) * 0.035));
  const masks = [];
  for (const invert of [true, false]) {
    masks.push(morphClose(otsuThreshold(blur, invert), w, h, closeK, closeK));
  }
  const fillK = Math.max(5, Math.round(Math.min(w, h) * 0.01));
  for (const [lo, hi] of [[50, 150], cannyThresholds(blur)]) {
    const edges = canny(blur, w, h, lo, hi);
    // Light dilate closes the small gaps a card border picks up over busy art;
    // the fill kernel is deliberately much smaller than the OTSU one, because a
    // big kernel is exactly what bridges the card to a hand resting against it.
    masks.push(morphClose(dilate(edges, w, h, 3, 3), w, h, fillK, fillK));
  }
  return masks;
}

// Card must cover at least this fraction of the frame. Low on purpose: a card
// held back from the camera is small, and rejecting it means matching the whole
// photo, which is far worse than a slightly loose crop.
const MIN_AREA_FRAC = 0.04;
// Upper cap earns its keep: with the wrong OTSU polarity the BACKGROUND becomes
// the blob, and "the whole frame" sails through the aspect gate and scores
// enormously on area. Keep this comfortably below 1.
const MAX_AREA_FRAC = 0.85;

export function detectCard(rgbaData, w, h) {
  const gray = rgbaToGray(rgbaData, w, h);
  const blur = gaussianBlur5(gray, w, h);

  const imgArea = w * h, cx = w / 2, cy = h / 2, halfDiag = Math.hypot(w, h) / 2;
  let best = null; // { score, pts }

  // Is a point sitting on the capture's own boundary? Tolerance scales with the
  // frame so it means the same thing at any upload resolution.
  const edgeTol = Math.max(2, Math.round(Math.min(w, h) * 0.01));
  const atFrameEdge = (p) =>
    p.x <= edgeTol || p.y <= edgeTol || p.x >= w - 1 - edgeTol || p.y >= h - 1 - edgeTol;

  const masks = segmentations(blur, w, h);
  for (const mask of masks) {
    // Regions INCLUDING holes: the card is not always the outermost thing in
    // the frame. On a playmat or binder page the whole surface is one region
    // and the card's outline is a hole inside it.
    //
    // `area` is an exact pixel count rather than the polygon area of a traced
    // boundary — the same quantity, measured directly.
    for (const region of connectedRegions(mask, w, h, MIN_AREA_FRAC * imgArea)) {
      const area = region.area;
      if (area > MAX_AREA_FRAC * imgArea) continue;
      // Consume the region's hull directly; no raw boundary pixels are needed.
      const c = region.hull;
      const rect = minAreaRect(c);
      let rw = rect.size.width, rh = rect.size.height;
      if (rw > rh) { const t = rw; rw = rh; rh = t; }   // ensure portrait
      const ar = rw / rh;                               // ideal card aspect = 0.714
      if (ar < 0.55 || ar > 0.88) continue;

      const centrality = 1 - Math.min(1, Math.hypot(rect.center.x - cx, rect.center.y - cy) / halfDiag);
      const aspectFit = 1 - Math.min(1, Math.abs(ar - CARD_ASPECT) / 0.15);
      const boxPts = rect.points.map((p) => ({ x: p.x, y: p.y }));

      // The hull quad follows real perspective, so it beats the bounding box
      // when it is trustworthy — but only then. An unvalidated quad preferred
      // outright is how a hand-merged blob's garbage quad won over its own sane
      // bounding box and sheared the crop.
      const hullQuad = findCardQuad(c);
      const hullMetrics = hullQuad && quadMetrics(hullQuad);
      const rectArea = rect.size.width * rect.size.height;
      // A trustworthy quad also has to explain the region it came from: a sliver
      // cutting across the blob does not.
      const hullOk = isCardQuad(hullMetrics) && hullMetrics.w * hullMetrics.h >= 0.7 * rectArea;

      const candidates = [];
      const boxMetrics = quadMetrics(boxPts);
      if (hullOk) candidates.push({ pts: hullMetrics.corners, bonus: 1.2, par: hullMetrics.parallelism, m: hullMetrics });
      if (isCardQuad(boxMetrics)) candidates.push({ pts: boxMetrics.corners, bonus: 1.0, par: boxMetrics.parallelism, m: boxMetrics });

      for (const cand of candidates) {
        // A quad spanning essentially the whole frame is the background, not a
        // card; cropping to it is a no-op that still pays for a warp.
        if (cand.m.w >= 0.95 * w && cand.m.h >= 0.95 * h) continue;
        // And a quad whose corners ARE the frame's corners is the frame,
        // whatever its aspect says — the mat-merged hull that pinned three
        // corners to the bounds and sheared the crop. A genuine card inside the
        // guide box never has a corner AT the image bound; one that bleeds off
        // the edge is not croppable anyway.
        if (cand.m.corners.filter(atFrameEdge).length >= 3) continue;
        // How much of the quad the region actually fills. A card fills its own
        // outline almost completely; a region that merged the card with a hand
        // is L-shaped, so the quad drawn around it is mostly empty.
        const fill = Math.min(1, area / Math.max(1, cand.m.w * cand.m.h));
        const score = (area / imgArea) * (aspectFit * aspectFit) * (0.4 + 0.6 * centrality) * cand.bonus * (0.5 + 0.5 * cand.par) * fill;
        if (!best || score > best.score) best = { score, pts: cand.pts };
      }
    }
  }

  if (!best || !best.pts) return null;
  return {
    quad: orderQuad(best.pts).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
  };
}
