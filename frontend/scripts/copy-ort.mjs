// Stage onnxruntime-web's wasm into public/ort, where detectWorker points
// ort.env.wasm.wasmPaths.
//
// public/ort/ is gitignored (the wasm is regenerable), so a clean clone — which is
// what CI and every Docker build starts from — had no wasm at all: session
// creation failed, the worker fell back to the pure-JS contour detector, and the
// scanner ran at 200ms+ a frame with the CPU pegged. The files come from
// node_modules, so copying them is the whole job.
//
// ONE build, named explicitly, rather than every ort-wasm* in the package.
// detectWorker creates its session with executionProviders: ['wasm'] and nothing
// else, so the jsep (WebGPU), asyncify and jspi binaries can never be loaded — and
// copying them cost 66 MB in public/, in dist/, and in the Docker image. vite
// copies public/ verbatim, so anything staged here ships.
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const src = path.join(import.meta.dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const dst = path.join(import.meta.dirname, '..', 'public', 'ort');

// The SIMD build is the plain wasm EP — "threaded" is in the filename regardless
// of ort.env.wasm.numThreads, which detectWorker pins to 1.
const KEEP = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

mkdirSync(dst, { recursive: true });

// Prune first, so upgrading past the version that copied everything reclaims the
// space instead of leaving 66 MB of unreachable binaries to be built into dist.
let pruned = 0;
for (const f of readdirSync(dst)) {
  if (KEEP.includes(f)) continue;
  rmSync(path.join(dst, f), { recursive: true, force: true });
  pruned++;
}

let n = 0;
for (const f of KEEP) {
  const from = path.join(src, f);
  // Loudly, not silently. A miss here means ORT renamed its artifacts in a version
  // bump, and the old failure mode was the scanner quietly dropping to the 200ms
  // contour detector with nothing in the log to say why.
  if (!statSync(from).isFile()) throw new Error(`onnxruntime-web is missing ${f} — check the KEEP list against node_modules/onnxruntime-web/dist`);
  const to = path.join(dst, f);
  // Skip unchanged files: this runs before every dev start and the .wasm is 13 MB.
  try {
    if (statSync(to).size === statSync(from).size) continue;
  } catch { /* not there yet */ }
  copyFileSync(from, to);
  n++;
}
console.log(`ort wasm: ${n} file(s) copied into public/ort${pruned ? `, ${pruned} unused removed` : ''}`);
