export function getSlotNumber(c) {
  if (!c) return null;
  if (c.slot != null) return c.slot;
  if (c.slot_number != null) return c.slot_number;
  if (c.__slotNumber != null) return c.__slotNumber;
  if (typeof c.position === 'number') {
    if (c.position >= 1000) return Math.floor(c.position / 1000);
    return Math.floor(c.position) + 1;
  }
  return null;
}
