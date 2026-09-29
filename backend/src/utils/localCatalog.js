const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function binaryPath(file, meta) {
  if (!meta.binary) return file.replace(/\.json$/, '.bin');
  const prefix = `${path.basename(file, '.json')}.`;
  if (typeof meta.binary !== 'string' || path.basename(meta.binary) !== meta.binary
      || !meta.binary.startsWith(prefix) || !meta.binary.endsWith('.bin')) {
    throw new Error('Invalid catalog binary path');
  }
  return path.join(path.dirname(file), meta.binary);
}

function readCatalog(file) {
  // A different process may retire a generation between our two reads.
  for (let attempt = 0; ; attempt++) {
    try {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bin = fs.readFileSync(binaryPath(file, meta));
      if (!Array.isArray(meta.ids) || !Number.isSafeInteger(meta.dim) || meta.dim <= 0
          || !Number.isSafeInteger(meta.ids.length * meta.dim * 4)
          || bin.length !== meta.ids.length * meta.dim * 4) {
        throw new Error('Invalid catalog dimensions or binary size');
      }
      return { meta, bin };
    } catch (e) {
      if (attempt || e.code !== 'ENOENT') throw e;
    }
  }
}

function publishCatalog(file, meta, vectors) {
  const dim = meta.dim;
  if (!Number.isSafeInteger(dim) || dim <= 0 || vectors.length !== meta.ids.length
      || !Number.isSafeInteger(vectors.length * dim * 4)
      || vectors.some(v => !(v instanceof Float32Array) || v.length !== dim)) {
    throw new Error('Invalid catalog vectors');
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const binary = `${path.basename(file, '.json')}.${randomUUID()}.bin`;
  const dest = path.join(dir, binary);
  const tmp = `${dest}.json.tmp`;
  let previous;
  let committed = false;
  try {
    const bin = Buffer.allocUnsafe(vectors.length * dim * 4);
    vectors.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, dim * 4).copy(bin, i * dim * 4));
    fs.writeFileSync(dest, bin, { flag: 'wx' });
    fs.writeFileSync(tmp, JSON.stringify({ ...meta, binary }), { flag: 'wx' });
    try { previous = binaryPath(file, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
    // This is the only commit point. No reader sees a partially replaced pair.
    fs.renameSync(tmp, file);
    committed = true;
  } finally {
    // Do not sweep unknown generations: another process may still be writing one.
    for (const obsolete of [tmp, committed ? previous : dest].filter(Boolean)) {
      try { fs.rmSync(obsolete, { force: true }); }
      catch (e) { console.warn(`catalog cleanup: ${e.message}`); }
    }
  }
}

module.exports = { binaryPath, readCatalog, publishCatalog };
