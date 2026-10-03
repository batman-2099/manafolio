export const CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'USD ($)' },
  { code: 'EUR', symbol: '€', label: 'EUR (€)' },
  { code: 'GBP', symbol: '£', label: 'GBP (£)' },
  { code: 'CAD', symbol: 'C$', label: 'CAD (C$)' },
  { code: 'AUD', symbol: 'A$', label: 'AUD (A$)' },
  { code: 'JPY', symbol: '¥', label: 'JPY (¥)' },
];

export const DEFAULT_CURRENCY = 'USD';

export const SYMBOLS = Object.fromEntries(CURRENCIES.map(({ code, symbol }) => [code, symbol]));

export const getCurrency = () => {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('manafolio_currency') : null;
    return Object.hasOwn(SYMBOLS, stored) ? stored : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
};

export const setCurrency = (code) => {
  const next = Object.hasOwn(SYMBOLS, code) ? code : DEFAULT_CURRENCY;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('manafolio_currency', next);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('manafolio_currency_change', { detail: next }));
  }
};

export const currencySymbol = (currency) => {
  const code = Object.hasOwn(SYMBOLS, currency) ? currency : getCurrency();
  return SYMBOLS[code] || '$';
};

export const formatPrice = (p) => (parseFloat(p) || 0).toFixed(2);

// An explicit source currency labels the original amount; this performs no FX.
export const priceText = (p, currency) => `${currencySymbol(currency)}${formatPrice(p)}`;
