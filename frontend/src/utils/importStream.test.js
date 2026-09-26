import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProgressStream } from './importStream.js';

const messages = { failed: 'Failed', incomplete: 'Incomplete', invalid: 'Invalid' };
const response = text => new Response(new ReadableStream({
  start(controller) {
    for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  },
}), { headers: { 'Content-Type': 'application/x-ndjson' } });

test('import progress survives split UTF-8 and completes only on terminal data', async () => {
  const progress = { type: 'progress', stage: 'lookup', set: 'é日本', current: 1, total: 2 };
  const data = { success: true, summary: { added: { copies: 2 } } };
  const received = [];
  assert.deepEqual(await readProgressStream(response(`${JSON.stringify(progress)}\n${JSON.stringify({ type: 'complete', data })}`), event => received.push(event), messages), data);
  assert.deepEqual(received, [progress]);
});

test('incomplete or failed imports never report success', async () => {
  await assert.rejects(readProgressStream(response('{"type":"progress","stage":"saving"}\n'), () => {}, messages), /Incomplete/);
  await assert.rejects(readProgressStream(response('{"type":"error","error":"Import failed"}\n'), () => {}, messages), /Import failed/);
  await assert.rejects(readProgressStream(new Response('{"error":"Unauthorized"}', { status: 401 }), () => {}, messages), /Unauthorized/);
});

test('completion accepts a draft without an import summary but rejects non-object data', async () => {
  const draft = { name: 'Deck', cards: [{ card_id: 'one', quantity: 1 }] };
  assert.deepEqual(await readProgressStream(response(JSON.stringify({ type: 'complete', data: draft })), () => {}, messages), draft);
  for (const data of [null, [], 'draft', 1, true]) {
    await assert.rejects(readProgressStream(response(JSON.stringify({ type: 'complete', data })), () => {}, messages), /Invalid/);
  }
});

test('malformed and truncated events cannot complete a stream', async () => {
  await assert.rejects(readProgressStream(response('{"type":"complete","data":'), () => {}, messages), /Invalid/);
  await assert.rejects(readProgressStream(response('{"type":"unexpected"}\n'), () => {}, messages), /Invalid/);
});
