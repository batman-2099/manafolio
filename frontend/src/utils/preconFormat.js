export function preconFormat(type) {
  if (/commander/i.test(type || '')) return { format: 'Commander / EDH', targetSize: 100 };
  if (/brawl/i.test(type || '')) return { format: 'Brawl', targetSize: /historic/i.test(type) ? 100 : 60 };
  if (type === 'Pioneer Challenger Deck') return { format: 'Pioneer', targetSize: 60 };
  if (type === 'Modern Event Deck') return { format: 'Modern', targetSize: 60 };
  if (type === 'Challenger Deck') return { format: 'Standard', targetSize: 60 };
  return { format: 'Casual', targetSize: 60 };
}
