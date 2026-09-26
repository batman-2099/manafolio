// Minimal .npz reader: a ZIP of .npy members. Enough for Milo's catalogs.
// numpy writes STORED (savez) or DEFLATE (savez_compressed); handle both.
const fs = require('fs');
const zlib = require('zlib');

function readZipEntries(buf) {
  // Locate End Of Central Directory (scan back over the max 64k comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no EOCD');
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  // Zip64 fallback: 0xffffffff sentinels mean the real values live in the
  // zip64 EOCD record, which npz hits once a catalog passes 4 GB or 65k members.
  if (off === 0xffffffff || count === 0xffff) {
    let z = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) { z = i; break; }
    }
    if (z < 0) throw new Error('zip64 sentinel but no locator');
    const z64 = Number(buf.readBigUInt64LE(z + 8));
    count = Number(buf.readBigUInt64LE(z64 + 32));
    off = Number(buf.readBigUInt64LE(z64 + 48));
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central header');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryData(buf, e) {
  // The local header repeats the name/extra lengths, and they can differ from
  // the central copy — always re-read them here rather than reusing the above.
  const lnameLen = buf.readUInt16LE(e.localOff + 26);
  const lextraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + lnameLen + lextraLen;
  const raw = buf.subarray(start, start + e.compSize);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}

const DTYPES = {
  '<f4': Float32Array, '<f8': Float64Array,
  '<i4': Int32Array, '<i8': BigInt64Array,
  '|i1': Int8Array, '|u1': Uint8Array, '<u4': Uint32Array,
};

function parseNpy(b) {
  if (b.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('not npy');
  const major = b[6];
  const hlen = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hstart = major === 1 ? 10 : 12;
  const header = b.toString('latin1', hstart, hstart + hlen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)[1] === 'True';
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)[1].match(/\d+/g) || []).map(Number);
  const body = b.subarray(hstart + hlen);

  if (descr.startsWith('<U')) {           // fixed-width UTF-32 strings
    const w = parseInt(descr.slice(2), 10);
    const n = shape.reduce((a, c) => a * c, 1);
    const arr = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = '';
      for (let j = 0; j < w; j++) {
        const cp = body.readUInt32LE((i * w + j) * 4);
        if (cp === 0) break;
        s += String.fromCodePoint(cp);
      }
      arr[i] = s;
    }
    return { shape, data: arr, descr, fortran };
  }
  if (descr.startsWith('|S')) {           // fixed-width bytes
    const w = parseInt(descr.slice(2), 10);
    const n = shape.reduce((a, c) => a * c, 1);
    const arr = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = body.subarray(i * w, (i + 1) * w);
      const z = s.indexOf(0);
      arr[i] = s.toString('utf8', 0, z < 0 ? w : z);
    }
    return { shape, data: arr, descr, fortran };
  }
  if (descr === '|O') throw new Error('pickled object array (needs allow_pickle)');

  const T = DTYPES[descr];
  if (!T) throw new Error(`unsupported dtype ${descr}`);
  const n = shape.reduce((a, c) => a * c, 1);
  // Copy: the zip payload is not guaranteed to be aligned to the element size,
  // and a TypedArray view over a misaligned offset throws.
  const copy = Buffer.allocUnsafe(n * T.BYTES_PER_ELEMENT);
  body.copy(copy, 0, 0, n * T.BYTES_PER_ELEMENT);
  return { shape, data: new T(copy.buffer, copy.byteOffset, n), descr, fortran };
}

function loadNpz(file) {
  const buf = fs.readFileSync(file);
  const out = {};
  for (const e of readZipEntries(buf)) {
    const key = e.name.replace(/\.npy$/, '');
    try { out[key] = parseNpy(entryData(buf, e)); }
    catch (err) { out[key] = { error: err.message }; }
  }
  return out;
}

module.exports = { loadNpz, parseNpy };

if (require.main === module) {
  const z = loadNpz(process.argv[2]);
  for (const [k, v] of Object.entries(z)) {
    if (v.error) { console.log(`${k}: ERROR ${v.error}`); continue; }
    const sample = Array.isArray(v.data) ? JSON.stringify(v.data.slice(0, 3))
      : JSON.stringify(Array.from(v.data.slice(0, 4)).map(x => typeof x === 'bigint' ? String(x) : x));
    console.log(`${k}: shape=[${v.shape}] dtype=${v.descr} fortran=${v.fortran} head=${sample}`);
  }
}
