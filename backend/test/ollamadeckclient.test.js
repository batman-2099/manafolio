const assert = require('assert');
const http = require('http');
const ollama = require('../src/ollamaDeckClient');

const schema = {
  type: 'object', additionalProperties: false, required: ['message', 'draft'],
  properties: {
    message: { type: 'string' },
    draft: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
      { type: 'null' },
    ] },
  },
};
const tags = { models: [{ model: 'deck:8b', name: 'Deck model' }] };
const complete = { done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ message: 'Here is your deck.', draft: { name: 'Owned deck' } }), thinking: 'Private reasoning is never deck content.' } };
let tagsReply = tags;
let generateReply = complete;
let status = 200;
let redirect = false;
let hold;
const calls = [];

async function main() {
  const previousUrl = process.env.OLLAMA_BASE_URL;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    if (redirect) { res.writeHead(302, { Location: '/unexpected-redirect-target' }); res.end(); return; }
    if (hold?.path === req.url) { hold.started(); return; }
    const reply = req.url === '/api/tags' ? tagsReply : generateReply;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const otherCalls = [];
  const otherServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    otherCalls.push({ url: req.url, body: body ? JSON.parse(body) : undefined });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/ollama/api/tags'
      ? { models: [{ model: 'other:8b', name: 'Other model' }] }
      : { ...complete, message: { role: 'assistant', content: JSON.stringify({ message: 'Here is your deck.', draft: { name: 'Other deck' } }) } }));
  });
  await new Promise(resolve => otherServer.listen(0, '127.0.0.1', resolve));
  const otherUrl = `http://127.0.0.1:${otherServer.address().port}/ollama/`;
  process.env.OLLAMA_BASE_URL = url;
  const suggest = (options = {}, progress) => ollama.suggest(1, 'Use only my supplied cards.', schema, { model: 'deck:8b', ...options }, progress);
  const rejectsSafely = async operation => assert.rejects(operation, error => error.status === 502 && !error.message.includes('provider-secret'));
  try {
    assert.deepStrictEqual(await ollama.models(1), { models: [{
      id: 'deck:8b', name: 'Deck model', isDefault: false, reasoningEfforts: [], defaultReasoningEffort: null,
    }] });
    assert.deepStrictEqual(await ollama.account(1), { connected: true });
    const [defaultModels, otherModels] = await Promise.all([
      ollama.models(1, { baseUrl: null }), ollama.models(2, { baseUrl: otherUrl }),
    ]);
    assert.strictEqual(defaultModels.models[0].id, 'deck:8b');
    assert.strictEqual(otherModels.models[0].id, 'other:8b');
    assert.deepStrictEqual(await ollama.account(2, { baseUrl: otherUrl }), { connected: true });
    const defaultCount = calls.length;
    assert.deepStrictEqual(await suggest({ baseUrl: otherUrl, model: 'other:8b' }), { message: 'Here is your deck.', draft: { name: 'Other deck' } });
    assert.strictEqual(otherCalls.at(-1).url, '/ollama/api/chat');
    assert.strictEqual(calls.length, defaultCount, 'explicit addresses never contact the operator default');
    assert.strictEqual(process.env.OLLAMA_BASE_URL, url, 'per-call addresses never mutate the operator configuration');
    const progress = [];
    assert.deepStrictEqual(await suggest({}, event => progress.push(event)), { message: 'Here is your deck.', draft: { name: 'Owned deck' } });
    assert.deepStrictEqual(calls.at(-1), { method: 'POST', url: '/api/chat', body: {
      model: 'deck:8b', format: schema, stream: false,
      messages: [
        { role: 'system', content: `Return only JSON matching this schema, no markdown:\n${JSON.stringify(schema)}` },
        { role: 'user', content: 'Use only my supplied cards.' },
      ],
    } });
    assert.deepStrictEqual(progress, [
      { stage: 'connecting' }, { stage: 'model_ready', model: 'deck:8b' },
      { stage: 'generating' }, { stage: 'response_received' },
    ]);
    const discussion = { message: 'Which play style do you prefer?', draft: null };
    generateReply = { ...complete, message: { role: 'assistant', content: JSON.stringify(discussion) } };
    assert.deepStrictEqual(await suggest(), discussion, 'nullable structured output supports discussion without a draft');
    generateReply = complete;
    const generations = () => calls.filter(call => call.url === '/api/chat').length;
    const count = generations();
    for (const options of [{ model: undefined }, { model: 'absent' }, { reasoning_effort: 'high' }]) {
      await assert.rejects(() => suggest(options), error => error.status === 400);
    }
    assert.strictEqual(generations(), count, 'invalid selection must never pull or generate another model');
    const beforePrompt = calls.length;
    await assert.rejects(() => ollama.suggest(1, 'x'.repeat(512 * 1024 + 1), schema, { model: 'deck:8b' }), error => error.status === 413);
    assert.strictEqual(calls.length, beforePrompt, 'oversized inventory is rejected before any provider request');

    for (const invalid of ['provider-secret malformed JSON', {}, { models: [{}] }, { models: [{ model: 'deck:8b' }] }]) {
      tagsReply = invalid;
      await rejectsSafely(() => ollama.models(1));
    }
    tagsReply = { models: [] };
    assert.deepStrictEqual(await ollama.account(1), { connected: true }, 'reachable service without installed models is connected');
    await assert.rejects(() => suggest(), error => error.status === 400);
    tagsReply = tags;
    for (const invalid of [
      'provider-secret malformed JSON', { ...complete, done: false },
      { ...complete, error: 'provider-secret' },
      { ...complete, done_reason: 'length' }, { done: true },
      { done: true, message: { content: 'provider-secret' } },
      { done: true, message: { content: '[]' } },
      { done: true, message: { content: 'null' } },
      { done: true, message: { content: '', thinking: '{"name":"Not a final answer"}' } },
    ]) {
      generateReply = invalid;
      await rejectsSafely(() => suggest());
    }
    generateReply = { ...complete, done_reason: 'length' };
    await assert.rejects(() => suggest(), /context or output limit/);
    generateReply = complete;
    status = 500;
    tagsReply = { error: 'provider-secret' };
    await rejectsSafely(() => ollama.account(1));
    status = 200;
    tagsReply = tags;
    redirect = true;
    const beforeRedirect = calls.length;
    await rejectsSafely(() => ollama.models(1, { baseUrl: url }));
    assert.strictEqual(calls.length, beforeRedirect + 1, 'redirects must not be followed');
    redirect = false;
    tagsReply = JSON.stringify({ models: [], padding: 'x'.repeat(1024 * 1024) });
    await rejectsSafely(() => ollama.models(1));
    tagsReply = tags;
    generateReply = { ...complete, message: { content: JSON.stringify({ name: 'x'.repeat(1024 * 1024) }) } };
    await rejectsSafely(() => suggest());
    generateReply = complete;

    for (const path of ['/api/tags', '/api/chat']) {
      const controller = new AbortController();
      const started = new Promise(resolve => { hold = { path, started: resolve }; });
      const events = [];
      const pending = suggest({ signal: controller.signal }, event => events.push(event));
      const rejected = assert.rejects(pending, error => error.status === 499);
      await started;
      controller.abort();
      await rejected;
      assert.ok(!events.some(event => event.stage === 'response_received'));
      hold = undefined;
    }
    const controller = new AbortController();
    controller.abort();
    const beforeCancel = calls.length;
    await assert.rejects(() => suggest({ signal: controller.signal }), error => error.status === 499);
    assert.strictEqual(calls.length, beforeCancel);

    const beforeInvalid = calls.length + otherCalls.length;
    for (const invalid of [
      'file:///tmp/ollama', `${url}?token=secret`, `${url}#fragment`, `${url}?`, `${url}#`,
      'http://user:secret@127.0.0.1:11434', 'not a URL', 'http:example.com',
      `http://example.com/${'a'.repeat(2048)}`, { host: url },
    ]) {
      await assert.rejects(() => ollama.models(1, { baseUrl: invalid }), error => error.status === 400 && !error.message.includes('secret'));
      if (typeof invalid === 'string') {
        process.env.OLLAMA_BASE_URL = invalid;
        await assert.rejects(() => ollama.models(1), error => error.status === 503 && !error.message.includes('secret'));
      }
    }
    assert.strictEqual(calls.length + otherCalls.length, beforeInvalid, 'invalid addresses fail before network access');
    assert.strictEqual((await ollama.models(2, { baseUrl: otherUrl })).models[0].id, 'other:8b',
      'an explicit user address does not depend on valid operator configuration');
    process.env.OLLAMA_BASE_URL = url;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rejectsSafely(() => ollama.account(1));
    console.log('Ollama HTTP protocol, structured output, bounds, cancellation and redirect checks passed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    otherServer.closeAllConnections();
    await new Promise(resolve => otherServer.close(resolve));
    if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousUrl;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
