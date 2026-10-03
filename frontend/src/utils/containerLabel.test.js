import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { containerLabelUrl, containerLabelQr } from './containerLabel.js';

test('container labels decode to a private deep link, never the current session or public share capability', async () => {
  const current = 'http://localhost:5186/?oidc_token=sample-secret&token=sample-secret#sample-secret';
  const url = containerLabelUrl(42, 'https://cards.example.test/manafolio/', current);
  assert.equal(url, 'https://cards.example.test/manafolio/?storageContainer=42');
  assert.equal(containerLabelUrl(43, '', current), 'http://localhost:5186/?storageContainer=43');
  assert.equal(containerLabelUrl(42, 'https://cards.example.test/?token=secret#secret', current), 'https://cards.example.test/?storageContainer=42');
  assert.throws(() => containerLabelUrl(42, 'https://user:secret@cards.example.test', current));
  assert.throws(() => containerLabelUrl(42, 'javascript:alert(1)', current));
  assert.throws(() => containerLabelUrl('42&token=secret', '', current));

  const qr = await containerLabelQr(url);
  const scale = 5;
  const margin = 4;
  const size = (qr.getModuleCount() + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - margin;
      const col = Math.floor(x / scale) - margin;
      if (row >= 0 && col >= 0 && row < qr.getModuleCount() && col < qr.getModuleCount() && qr.isDark(row, col)) {
        const index = (y * size + x) * 4;
        pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
      }
    }
  }
  assert.equal(jsQR(pixels, size, size)?.data, url);
});
