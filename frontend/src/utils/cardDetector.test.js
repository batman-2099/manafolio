import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDetect, stopDetect } from './cardDetector.js';

test('detection transfers fresh pixels without copying and skips frames while pending', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let worker;
  class DetectionWorker {
    constructor() { worker = this; }
    postMessage(message, transfer) {
      this.frame = structuredClone(message, { transfer });
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: DetectionWorker });
  const frames = [];
  const canvas = {
    width: 1, height: 1,
    getContext: () => ({
      getImageData: () => {
        const data = new Uint8ClampedArray([frames.length + 1, 2, 3, 255]);
        frames.push(data);
        return { data };
      },
    }),
  };
  try {
    assert.equal(requestDetect(canvas, () => {}), true);
    assert.equal(frames[0].byteLength, 0, 'the original pixel buffer leaves the main thread');
    assert.deepEqual([...new Uint8ClampedArray(worker.frame.buf)], [1, 2, 3, 255]);
    assert.equal(requestDetect(canvas, () => {}), false);
    assert.equal(frames.length, 1, 'a pending frame must not read another canvas image');
    // Even if a worker returns its previous pixels, the next fresh image must
    // be transferred, not copied into those returned pixels.
    worker.onmessage({ data: structuredClone({ seq: worker.frame.seq, detected: false, buf: worker.frame.buf }, { transfer: [worker.frame.buf] }) });
    assert.equal(requestDetect(canvas, () => {}), true);
    assert.equal(frames[1].byteLength, 0, 'the second fresh buffer is transferred too');
    assert.deepEqual([...new Uint8ClampedArray(worker.frame.buf)], [2, 2, 3, 255]);
  } finally {
    stopDetect();
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else delete globalThis.Worker;
  }
});
