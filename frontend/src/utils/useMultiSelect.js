import { useCallback, useRef, useState } from 'react';
import { useLongPress } from './useLongPress';

// Long-press-to-arm multi-select + bulk actions over collection entries. Shared
// by CollectionList and the scanner's recent-scans strip so both get the same
// UX and hit the same /api/collection/bulk endpoint. onChanged({ ids, action,
// value }) runs after a successful bulk action; the caller refreshes its own
// data (refetch, or prune a local list). Selection is cleared before onChanged,
// so the acted-on ids are passed along. Optional `guard()` returns a message
// string to block arming/bulk (e.g. a locked container) or a falsy value to
// allow it; the message is shown as a toast.
export function useMultiSelect({ showToast, onChanged, guard } = {}) {
  const [selectMode, updateSelectMode] = useState(false);
  const [selectedIds, updateSelectedIds] = useState(() => new Set());
  const [bulkMoveTarget, updateBulkMoveTarget] = useState('');
  const [bulkPending, setBulkPending] = useState(false);
  const pendingRef = useRef(false);
  // Keep setter identities stable: callers also use them in reset effects.
  const setSelectMode = useCallback(value => {
    if (!pendingRef.current) updateSelectMode(value);
  }, []);
  const setSelectedIds = useCallback(value => {
    if (!pendingRef.current) updateSelectedIds(value);
  }, []);
  const setBulkMoveTarget = useCallback(value => {
    if (!pendingRef.current) updateBulkMoveTarget(value);
  }, []);

  // Last plainly-clicked id: the far end of a shift-click range.
  const anchorId = useRef(null);

  const toggleSelect = (entryId) => {
    if (pendingRef.current) return;
    anchorId.current = entryId;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };

  // Click-to-toggle with shift-click range, over `orderedIds` as currently
  // displayed — so a range is exactly what sits between the two cards on
  // screen, whatever sort or filter is active. Shift only ever extends, so
  // several shift-clicks build a selection out of separate blocks.
  const selectAt = (entryId, orderedIds, withShift) => {
    if (pendingRef.current) return;
    const anchor = anchorId.current;
    if (!withShift || anchor == null || anchor === entryId) {
      toggleSelect(entryId);
      return;
    }
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(entryId);
    if (from === -1 || to === -1) { toggleSelect(entryId); return; }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      return next;
    });
  };

  const clearSelection = () => {
    if (pendingRef.current) return;
    anchorId.current = null;
    setSelectedIds(new Set());
  };
  const exitSelectMode = () => {
    if (pendingRef.current) return;
    setSelectMode(false);
    clearSelection();
    setBulkMoveTarget('');
  };

  // Enter select mode and select `entryId`. Exposed so callers that own the
  // long-press elsewhere (CompartmentView) can arm the same state.
  const arm = (entryId) => {
    if (pendingRef.current) return;
    const blocked = guard && guard();
    if (blocked) { showToast(blocked, 'error'); return; }
    setSelectMode(true);
    anchorId.current = entryId;
    setSelectedIds(prev => new Set(prev).add(entryId));
  };

  // Long-press arms select mode and selects the held card (shared gesture).
  const { handlers: pressHandlers, fired: longPressFired } = useLongPress(arm);

  // Runs one bulk action against every selected entry via the bulk endpoint.
  const runBulk = async (action, value, confirmMsg) => {
    if (pendingRef.current) return false;
    const blocked = guard && guard();
    if (blocked) { showToast(blocked, 'error'); return; }
    const ids = Array.from(selectedIds);
    if (ids.length === 0) { showToast('No cards selected.', 'error'); return; }
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    pendingRef.current = true;
    setBulkPending(true);
    let changed = false;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: ids, action, value })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(data.message || 'Done.', 'success');
        anchorId.current = null;
        updateSelectedIds(prev => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
        changed = true;
      } else {
        showToast(data.error || 'Bulk action failed.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error performing bulk action.', 'error');
    } finally {
      pendingRef.current = false;
      setBulkPending(false);
    }
    // The owning action clears only its snapshot, then allows the caller to
    // exit selection mode. Failed actions leave the selection available to retry.
    if (changed) onChanged && onChanged({ ids, action, value });
    return changed;
  };

  return {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode, arm,
    bulkMoveTarget, setBulkMoveTarget, bulkPending, pressHandlers, longPressFired, runBulk,
  };
}
