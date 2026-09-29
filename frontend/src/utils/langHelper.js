// A provider's printed name is authoritative; otherwise retain the original name.
export const getCardDisplayName = (englishName, printedName) => printedName || englishName || '';
