import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { detectCard } from '../../../shared/cardDetectPure.mjs';
import { orderQuad } from '../../../shared/imgproc.mjs';
import { sharpness } from './sharpness.js';

// Execute the worker entry with its real contour code and an inert model transport.
const source = readFileSync(new URL('./detectWorker.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '');

for (const failure of ['network', '404', 'html', 'wasm', 'pending-fetch', 'pending-body']) {
  test(`detector caches ${failure} initialization failure until worker restart`, async () => {
    let failing = true, fetches = 0, creates = 0, contours = 0;
    const startWorker = () => {
      const messages = [];
      const self = { postMessage: message => messages.push(message) };
      let expire;
      vm.runInNewContext(source, {
        self, Uint8Array, Uint8ClampedArray, Float32Array, performance,
        AbortSignal: { timeout: ms => {
          assert.ok(ms > 0 && ms <= 60000, 'model transport must have a finite deadline');
          const controller = new AbortController();
          expire = () => controller.abort(new DOMException('Model download timed out', 'TimeoutError'));
          return controller.signal;
        } },
        console: { log() {}, error() {} },
        fetch: async (_url, { signal }) => {
          fetches++;
          if (failing && failure === 'network') throw new Error('offline');
          const stalled = () => new Promise((_, reject) => {
            signal.throwIfAborted();
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          if (failing && failure === 'pending-fetch') return stalled();
          return {
            ok: !(failing && failure === '404'),
            status: failing && failure === '404' ? 404 : 200,
            headers: { get: () => failing && failure === 'html' ? 'text/html' : 'application/octet-stream' },
            arrayBuffer: async () => failing && failure === 'pending-body' ? stalled() : new ArrayBuffer(8),
          };
        },
        ort: {
          env: { wasm: {} },
          Tensor: class {},
          InferenceSession: { create: async () => {
            creates++;
            if (failing && failure === 'wasm') throw new Error('wasm unavailable');
            return { run: async () => ({ corners: { data: [] }, sharpness: { data: [0] } }) };
          } },
        },
        detectCard: (...args) => { contours++; return detectCard(...args); },
        orderQuad, sharpness,
      });
      return {
        messages,
        expire: () => expire(),
        frame: seq => self.onmessage({ data: { buf: new Uint8ClampedArray(64 * 64 * 4).buffer, w: 64, h: 64, seq } }),
      };
    };
    const worker = startWorker();
    for (let seq = 1; seq <= 3; seq++) {
      const pending = worker.frame(seq);
      if (seq === 1 && failure.startsWith('pending-')) {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(worker.messages.length, 0, 'stalled transport has not answered yet');
        worker.expire();
      }
      await pending;
    }
    assert.equal(fetches, 1, 'persistent failure must not retry for every preview frame');
    assert.equal(creates, failure === 'wasm' ? 1 : 0);
    assert.equal(contours, 3, 'every fresh frame still runs the real fallback');
    for (const [index, message] of worker.messages.entries()) {
      assert.equal(message.seq, index + 1);
      assert.equal(message.engine, 'contour');
      assert.equal(message.detected, false, 'blank frames never become safe captures');
      assert.ok(message.degraded);
    }
    failing = false;
    const restarted = startWorker();
    await restarted.frame(4);
    assert.equal(fetches, 2, 'a new worker retries initialization');
    assert.equal(restarted.messages[0].engine, 'fastweb-wasm');
    assert.equal(restarted.messages[0].detected, false);
    assert.equal(contours, 3);
  });
}
