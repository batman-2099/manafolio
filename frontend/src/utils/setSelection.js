export function toggleSetCodes(selected, code, children = []) {
  const codes = [code, ...children];
  const family = new Set(codes.map(value => String(value).toLowerCase()));
  const enabled = selected.some(value => value.toLowerCase() === String(code).toLowerCase());
  const remaining = selected.filter(value => !family.has(value.toLowerCase()));
  return enabled ? remaining : [...remaining, ...codes];
}
