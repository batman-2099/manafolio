import { useSyncExternalStore } from 'react';

// Client half of the contributed-art system. The backend holds art for cards the
// upstream APIs have no image for, in two layers (this instance's uploads, then
// whatever has been contributed back and committed to the repo); see
// backend/src/cardArt.js.

export const artUrl = (cardId) => `/api/card-art/${encodeURIComponent(cardId)}.png`;

// Which cards have art, fetched once per page load. Without this, the only way to
// find out would be to request the art and see if it 404s — which for a grid of a
// few hundred artless cards means a few hundred pointless requests, every scroll.
let ids = new Set();
let started = false;
const listeners = new Set();

// useSyncExternalStore compares snapshots by identity, so the Set object must be
// swapped wholesale on load and stay frozen otherwise — mutating it in place
// would leave every subscriber convinced nothing changed.
const emit = (next) => {
  ids = next;
  listeners.forEach(fn => fn());
};

function start() {
  if (started) return;
  started = true;
  fetch('/api/card-art/index')
    .then(r => (r.ok ? r.json() : null))
    // Demo mode answers un-captured GETs with {}, and a self-hosted instance that
    // has never had an upload answers with []. Both mean "no contributed art",
    // which is the common case and must not be an error.
    .then(d => { if (Array.isArray(d?.ids) && d.ids.length) emit(new Set(d.ids)); })
    .catch(() => {}); // art is decoration; a failed index just means card backs
}

const subscribe = (fn) => { start(); listeners.add(fn); return () => listeners.delete(fn); };
const snapshot = () => ids;

// Subscribe to the index. Returns a Set, so callers ask `index.has(cardId)`.
export function useCardArtIndex() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// Fold a just-uploaded (or just-deleted) card into the index so the change shows
// up everywhere immediately instead of after a reload.
export function noteArtChanged(cardId, present) {
  const next = new Set(ids);
  if (present) next.add(cardId); else next.delete(cardId);
  emit(next);
}
