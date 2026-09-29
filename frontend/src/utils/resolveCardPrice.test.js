import test from 'node:test';
import assert from 'node:assert/strict';
import { getPrintingPrice } from './resolveCardPrice.js';

test('finish quotes stay distinct and never substitute another finish or copy valuation', () => {
  const card = { price_normal: 4.25, price_holofoil: 9.5, price_trend: 4.25, market_value: 100 };
  assert.equal(getPrintingPrice(card, 'Normal'), 4.25);
  assert.equal(getPrintingPrice(card, 'Holofoil'), 9.5);
  assert.equal(getPrintingPrice({ ...card, price_holofoil: '9.50' }, 'Holofoil'), 9.5);
  for (const missing of [undefined, null, 0, -1, NaN, Infinity, 'Infinity', '', 'invalid', true]) {
    assert.equal(getPrintingPrice({ ...card, price_holofoil: missing }, 'Holofoil'), null);
    assert.equal(getPrintingPrice({ ...card, price_normal: missing }, 'Normal'), null);
  }
  assert.equal(getPrintingPrice(null, 'Normal'), null);
  assert.equal(getPrintingPrice(card, 'Unknown'), null);
});
