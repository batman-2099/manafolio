const assert = require('assert');
const { parseNpy } = require('../src/utils/npz');
function npy(descr, shape, body, major = 1) {
  const header = Buffer.from(`{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape}), }\n`);
  const start = major === 1 ? 10 : 12;
  const prefix = Buffer.alloc(start);
  prefix.write('\x93NUMPY', 0, 'latin1');
  prefix[6] = major;
  if (major === 1) prefix.writeUInt16LE(header.length, 8);
  else prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, body]);
}
const floats = Buffer.from(new Float32Array([1.25, -2]).buffer);
for (const version of [1, 2, 3]) {
  const parsed = parseNpy(npy('<f4', '1, 2', floats, version));
  assert.deepStrictEqual(parsed.shape, [1, 2]);
  assert.deepStrictEqual(Array.from(parsed.data), [1.25, -2]);
  assert.throws(() => parseNpy(npy('<f4', '1, 2', floats.subarray(0, 7), version)), /payload/);
}
assert.deepStrictEqual(parseNpy(npy('|S3', '2,', Buffer.from('abcde\0'))).data, ['abc', 'de']);
const unicode = Buffer.alloc(8);
unicode.writeUInt32LE(0x1f004);
assert.deepStrictEqual(parseNpy(npy('<U2', '1,', unicode)).data, ['\u{1f004}']);
for (const [dtype, bytes] of [['|S3', Buffer.alloc(2)], ['<U2', Buffer.alloc(7)]]) {
  assert.throws(() => parseNpy(npy(dtype, '1,', bytes)), /payload/);
}
for (const shape of ['-1,', '1.5,', '9007199254740992,', '9007199254740991, 2', '2, nope']) {
  assert.throws(() => parseNpy(npy('<f4', shape, Buffer.alloc(0))), /dimension/);
}
assert.throws(() => parseNpy(npy('<f4', '1000000000,', Buffer.alloc(4))), /payload/);
assert.throws(() => parseNpy(npy('<f4', '1,', floats).subarray(0, 15)), /header/);
assert.deepStrictEqual(Array.from(parseNpy(npy('<f4', '0, 2', Buffer.alloc(0))).data), []);
assert.deepStrictEqual(Array.from(parseNpy(npy('<f4', '', floats.subarray(0, 4))).data), [1.25]);
console.log('npz.test.js: numeric/string payloads, versions, scalar/empty arrays and malformed dimensions passed');
