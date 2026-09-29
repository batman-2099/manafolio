import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('ORT staging replaces changed bytes even when their size is unchanged', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'manafolio-ort-stage-'));
  try {
    const source = path.join(root, 'node_modules/onnxruntime-web/dist');
    const target = path.join(root, 'public/ort');
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    mkdirSync(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts/copy-ort.mjs');
    copyFileSync(new URL('../../scripts/copy-ort.mjs', import.meta.url), script);
    const files = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
    for (const file of files) {
      writeFileSync(path.join(source, file), 'new-bytes');
      writeFileSync(path.join(target, file), 'old-bytes');
    }
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const file of files) assert.equal(readFileSync(path.join(target, file), 'utf8'), 'new-bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
