export function deckContainers(cardLocations) {
  const containers = new Map();
  for (const locations of Object.values(cardLocations)) {
    for (const location of locations) {
      if (location.take <= 0) continue;
      const id = location.location_id ?? null;
      const container = containers.get(id);
      if (container) container.quantity += location.take;
      else containers.set(id, { id, name: location.location_name, quantity: location.take });
    }
  }
  return [...containers.values()].sort((a, b) =>
    a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}
