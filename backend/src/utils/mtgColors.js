const BASIC_LAND_COLORS = {
  Plains: 'White',
  Island: 'Blue',
  Swamp: 'Black',
  Mountain: 'Red',
  Forest: 'Green',
};

const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

function normalizeMtgColorIdentity(colorIdentity, typeLine = '', name = '') {
  const colors = (colorIdentity || []).map(color => COLOR_NAMES[color] || color);
  if (colors.length) return colors;
  const landType = Object.keys(BASIC_LAND_COLORS).find(type => new RegExp(`\\b${type}\\b`, 'i').test(`${typeLine} ${name}`));
  return landType ? [BASIC_LAND_COLORS[landType]] : [];
}

module.exports = { BASIC_LAND_COLORS, normalizeMtgColorIdentity };
