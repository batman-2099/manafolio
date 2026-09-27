// Run: node test/cvtensor.test.js (no model files required)
const assert = require('assert');
const ort = require('onnxruntime-node');
const { toTensor } = require('../src/cvScan');

// Red, green, blue, white: channel planes must keep row-major pixel order.
const rgb = Buffer.from([
  255, 0, 0,   0, 255, 0,
  0, 0, 255,  255, 255, 255,
]);
const tensor = toTensor(rgb, 2);
assert.ok(tensor instanceof ort.Tensor);
assert.strictEqual(tensor.type, 'float32');
assert.ok(tensor.data instanceof Float32Array);
assert.deepStrictEqual(tensor.dims, [1, 3, 2, 2]);
const expected = [
  2.2489083, -2.1179039, -2.1179039, 2.2489083,
  -2.0357143, 2.4285714, -2.0357143, 2.4285714,
  -1.8044444, -1.8044444, 2.64, 2.64,
];
expected.forEach((value, i) => {
  assert.ok(Math.abs(tensor.data[i] - value) < 1e-6, `normalized channel value ${i}`);
});

console.log('cvtensor.test.js: all assertions passed');
