// Shared <select> option lists for collection entry fields, previously
// copy-pasted across LocationManager, CollectionList, CardSearch, and
// CameraScanner's quick-add/edit forms.
import foilTreatments from '../../../shared/foilTreatments.json';

export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const MTG_FORMATS = ['Commander / EDH', 'Standard', 'Modern', 'Pioneer', 'Legacy', 'Vintage', 'Pauper', 'Alchemy', 'Historic', 'Explorer', 'Timeless', 'Brawl', 'Casual'];
export { getLanguageNamesForGame } from './languages';

export const BASE_PRINTINGS = [{ value: 'Normal', label: 'Nonfoil' }, { value: 'Holofoil', label: 'Foil' }];
const PRINTINGS = [...BASE_PRINTINGS, ...Object.entries(foilTreatments).filter(([key]) => key !== 'traditional').map(([key, label]) => ({ value: `foil:${key}`, label })).sort((a, b) => a.label.localeCompare(b.label))];

export function getPrintings() {
  return PRINTINGS;
}

export function decodePrinting(value) {
  return value?.startsWith('foil:')
    ? { printing: 'Holofoil', foil_treatment: value.slice(5) }
    : { printing: value || 'Normal', foil_treatment: null };
}

export function encodePrinting(printing, treatment) {
  return printing === 'Holofoil' && treatment && treatment !== 'traditional' ? `foil:${treatment}` : printing || 'Normal';
}

export function matchesPrinting(card, value) {
  return value.startsWith('foil:') ? encodePrinting(card.printing, card.foil_treatment) === value : card.printing === value;
}

// Grading companies, mirroring the collection.grader CHECK constraint in
// backend/src/db.js. 'Raw' is the default and means ungraded — not unknown, so it
// is a real option in the picker rather than an empty one.
export const GRADERS = ['Raw', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG'];

// Grades a slab can carry, highest first because that is the order a collector
// reads them in. PSA issues whole numbers plus 10; BGS and CGC add half grades, so
// the list is the union and the picker is shared.
export const GRADES = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4, 3, 2, 1];

// A binder-family container lays out fixed pockets (Pages); other container
// types (boxes, deck boxes) are continuous (Rows). Kept here so the several
// UI spots that branch on it share one definition.
export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';

// Which two pages face each other on the desktop spread holding a given page.
// A binder opens on page 1 alone against the inside cover, so pages pair up 2-3,
// 4-5 and so on — and a binder with an even page count ends on a page sitting
// alone on the left. leftIdx is -1 on the opening spread: nothing faces page 1.
export function binderSpread(pageIndex) {
  const spread = Math.floor((Math.max(0, pageIndex) + 1) / 2);
  return { spread, leftIdx: spread * 2 - 1, rightIdx: spread * 2 };
}

// Container type labels are translated, but the type itself is the English string
// stored in the database, so the two are paired here rather than in each screen
// that renders one. The label is t(`container.type.${containerTypeKey(type)}`);
// 'misc' is keyed that way and not 'other' because a key ending in a plural
// category is read as a counted phrase by check-locales.mjs.
const CONTAINER_TYPE_KEYS = {
  'Binder': 'binder',
  'Toploader Binder': 'toploaderBinder',
  'Box': 'box',
  'Toploader Box': 'toploaderBox',
  'Graded Slab Box': 'gradedSlabBox',
  'Display Shelf / Stand': 'displayShelf',
  'Deck Box': 'deckBox',
  'Tin / Case': 'tinCase',
  'Other': 'misc',
};

// A type from an older install (or a hand-edited row) has no key; callers fall
// back to showing the stored English rather than mislabelling it "Other".
export const containerTypeKey = (type) => CONTAINER_TYPE_KEYS[type] || null;
