const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// A controlled JSONL child, never the real Codex binary or a real OAuth account.
// State lives under the CODEX_HOME supplied by the client, so restarts and logout
// exercise the actual per-user storage boundary rather than a shared mock map.
function fakeServer() {
  const fs = require('fs');
  const path = require('path');
  const home = process.env.CODEX_HOME;
  const user = path.basename(home);
  const marker = path.join(home, 'fixture-connected');
  let initialized = false;
  let threadModel;
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const notify = (method, params) => send({ method, params });
  const privatePaths = [home, process.env.HOME, process.cwd()];
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.NODE_OPTIONS ||
      privatePaths.some(p => (fs.statSync(p).mode & 0o077) !== 0) ||
      process.cwd().startsWith(process.env.CODEX_HOME)) process.exit(3);
  require('readline').createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params = {} } = JSON.parse(line);
    const reply = result => send({ id, result });
    if (method === 'initialize') return reply({ userAgent: 'fixture' });
    if (method === 'initialized') { initialized = true; return; }
    if (!initialized) return process.exit(4);
    switch (method) {
      case 'config/read': return reply({ layers: [{ name: { type: 'sessionFlags' }, config: {} }] });
      case 'configRequirements/read': return reply({ requirements: null });
      case 'account/read': return reply({ account: fs.existsSync(marker) ? { type: 'chatgpt', email: `${user}@example.test`, accessToken: 'fixture-must-not-leak' } : null });
      case 'model/list': {
        const entry = (model, isDefault, efforts, hidden = false) => ({
          id: `picker-${model}`, model, displayName: model, isDefault, hidden,
          defaultReasoningEffort: efforts[0],
          supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
        });
        if (params.cursor === null) {
          return reply({ data: [entry(`default-${user}`, true, ['medium', 'low']), entry('hidden', false, ['high'], true)], nextCursor: 'next-page' });
        }
        if (params.cursor !== 'next-page') return process.exit(8);
        return reply({ data: [entry(`precise-${user}`, false, ['high', 'xhigh'])], nextCursor: null });
      }
      case 'account/login/start': {
        if (user !== '3') {
          fs.writeFileSync(marker, 'fixture', { mode: 0o600 });
          // Completion can race ahead of the login/start response on the same pipe.
          notify('account/login/completed', { loginId: `login-${user}`, success: true });
        }
        return reply({ type: 'chatgptDeviceCode', loginId: `login-${user}`, verificationUrl: 'https://auth.openai.com/codex/device', userCode: `USER-${user}` });
      }
      case 'account/login/cancel':
        notify('account/login/completed', { loginId: params.loginId, success: false });
        return reply({ status: 'canceled' });
      case 'account/logout': fs.rmSync(marker, { force: true }); return reply({});
      case 'thread/start':
        if (params.environments?.length !== 0 || params.dynamicTools?.length !== 0 || !params.ephemeral) return process.exit(5);
        threadModel = params.model;
        fs.appendFileSync(path.join(home, 'fixture-inference'), 'thread\n');
        return reply({ thread: { id: `thread-${user}`, environments: [] } });
      case 'turn/start': {
        const text = params.input[0].text;
        if (params.environments?.length !== 0 || params.outputSchema?.additionalProperties !== false) return process.exit(6);
        if (text === 'selected' && (threadModel !== `precise-${user}` || params.effort !== 'xhigh')) return process.exit(9);
        if (text === 'effort-only' && (threadModel !== `default-${user}` || params.effort !== 'low')) return process.exit(9);
        if (text === 'model-only' && (threadModel !== `precise-${user}` || Object.hasOwn(params, 'effort'))) return process.exit(9);
        if (['first', 'second'].includes(text) && (threadModel !== undefined || Object.hasOwn(params, 'effort'))) return process.exit(9);
        reply({ turn: { id: `turn-${user}`, status: 'inProgress' } });
        if (text === 'timeout') return;
        if (text === 'server-request') return send({ id: 990, method: 'item/commandExecution/requestApproval', params: { command: 'read host secrets' } });
        if (text === 'upstream-error') return notify('turn/completed', { threadId: `thread-${user}`, turn: { id: `turn-${user}`, status: 'failed', error: { message: 'fixture-secret' } } });
        if (text === 'hold') return;
        return setTimeout(() => {
          notify('item/reasoning/textDelta', { threadId: `thread-${user}`, delta: 'fixture-private-reasoning' });
          notify('item/completed', { threadId: `thread-${user}`, item: { type: 'agentMessage', phase: 'commentary', text: 'fixture-private-commentary' } });
          // Unrelated thread events must not become the returned deck draft.
          notify('item/completed', { threadId: 'unrelated', turnId: `turn-${user}`, item: { type: 'agentMessage', text: '{"owner":"other"}' } });
          notify('item/completed', { threadId: `thread-${user}`, turnId: `turn-${user}`, item: { type: 'agentMessage', phase: 'final_answer', text: text === 'invalid-json' ? '```json\n{}\n```' : JSON.stringify({ message: 'Response', draft: text === 'discussion' ? null : { owner: user } }) } });
          notify('turn/completed', { threadId: `thread-${user}`, turn: { id: `turn-${user}`, status: 'completed' } });
        }, user === '1' ? 20 : 1);
      }
      default: process.exit(7);
    }
  });
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-codex-test-'));
  const dbModule = require.resolve('../src/db');
  const previousDb = require.cache[dbModule];
  require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: { dbPath: path.join(dir, 'test.db') } };
  const spawn = childProcess.spawn;
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const activeIntervals = new Set();
  global.setInterval = (callback, delay, ...args) => {
    assert.strictEqual(delay, 10000, 'waiting updates must not become a busy polling loop');
    const timer = originalInterval(callback, 2, ...args);
    activeIntervals.add(timer);
    return timer;
  };
  global.clearInterval = timer => { activeIntervals.delete(timer); originalClearInterval(timer); };
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-parent-secret';
  const children = [];
  childProcess.spawn = (executable, args, options) => {
    assert.strictEqual(executable, process.execPath);
    const child = spawn(process.execPath, ['-e', `(${fakeServer.toString()})();`], options);
    children.push(child);
    return child;
  };
  const client = require('../src/codexDeckClient');
  const schema = {
    type: 'object', additionalProperties: false, required: ['message', 'draft'],
    properties: {
      message: { type: 'string' },
      draft: { anyOf: [
        { type: 'object', additionalProperties: false, required: ['owner'], properties: { owner: { type: 'string' } } },
        { type: 'null' },
      ] },
    },
  };
  try {
    assert.deepStrictEqual(await client.account(1), { connected: false });
    const login = await client.login(1);
    assert.deepStrictEqual(Object.keys(login).sort(), ['userCode', 'verificationUrl']);
    assert.deepStrictEqual(await client.account(1), { connected: true, email: '1@example.test' });
    assert.deepStrictEqual(await client.account(2), { connected: false }, 'another user must never inherit an account');
    await client.login(2);
    assert.deepStrictEqual(await client.models(1), { models: [
      { id: 'default-1', name: 'default-1', isDefault: true, defaultReasoningEffort: 'medium', reasoningEfforts: ['medium', 'low'] },
      { id: 'precise-1', name: 'precise-1', isDefault: false, defaultReasoningEffort: 'high', reasoningEfforts: ['high', 'xhigh'] },
    ] }, 'all pages expose inference identifiers and exclude hidden picker entries');
    for (const selection of [
      { model: 'precise-1', reasoning_effort: 'low' },
      { model: 'hidden', reasoning_effort: 'high' },
      { model: 'precise-2', reasoning_effort: 'xhigh' },
      { model: 'picker-precise-1', reasoning_effort: 'xhigh' },
      { reasoning_effort: 'xhigh' },
    ]) {
      await assert.rejects(client.suggest(1, 'invalid-selection', schema, selection), error => error.status === 400);
      await assert.rejects(fs.stat(path.join(dir, 'codex', '1', 'fixture-inference')), error => error.code === 'ENOENT',
        'unsupported combinations must be rejected before inference starts');
    }
    const progress = [];
    assert.deepStrictEqual(await client.suggest(1, 'selected', schema, { model: 'precise-1', reasoning_effort: 'xhigh' }, event => {
      progress.push(event);
      throw new Error('observer failure must not crash the worker');
    }), { message: 'Response', draft: { owner: '1' } });
    assert.deepStrictEqual(progress.filter(event => event.stage !== 'waiting'), [
      { stage: 'connecting' }, { stage: 'model_ready', model: 'precise-1', reasoning_effort: 'xhigh' },
      { stage: 'generating' }, { stage: 'response_received' },
    ]);
    assert.ok(progress.some(event => event.stage === 'waiting' && Number.isInteger(event.elapsedSeconds) && event.elapsedSeconds >= 0));
    assert.ok(!JSON.stringify(progress).includes('fixture-private'));
    assert.strictEqual(activeIntervals.size, 0, 'successful generation clears its waiting heartbeat');
    const finishedCount = progress.length;
    await new Promise(resolve => originalTimeout(resolve, 10));
    assert.strictEqual(progress.length, finishedCount, 'no progress may arrive after completion');
    assert.deepStrictEqual(await client.suggest(1, 'effort-only', schema, { reasoning_effort: 'low' }), { message: 'Response', draft: { owner: '1' } });
    assert.deepStrictEqual(await client.suggest(1, 'model-only', schema, { model: 'precise-1' }), { message: 'Response', draft: { owner: '1' } });
    const drafts = await Promise.all([client.suggest(1, 'first', schema), client.suggest(2, 'second', schema)]);
    assert.deepStrictEqual(drafts, [{ message: 'Response', draft: { owner: '1' } }, { message: 'Response', draft: { owner: '2' } }]);
    assert.deepStrictEqual(await client.suggest(1, 'discussion', schema), { message: 'Response', draft: null });
    assert.deepStrictEqual(await client.account(1), { connected: true, email: '1@example.test' }, 'credentials persist across process restarts');
    await client.logout(1);
    assert.deepStrictEqual(await client.account(1), { connected: false });
    assert.deepStrictEqual(await client.account(2), { connected: true, email: '2@example.test' }, 'logout affects only the selected account');
    await client.login(3);
    await client.logout(3);
    await assert.rejects(fs.stat(path.join(dir, 'codex', '3')), error => error.code === 'ENOENT', 'cancel must remove account storage despite login/completed(false) arriving before its response');
    assert.deepStrictEqual(await client.account(3), { connected: false });
    await assert.rejects(client.suggest(1, 'missing-account', schema), error => error.status === 409);
    await assert.rejects(client.models(1), error => error.status === 409);
    await assert.rejects(client.account('../2'), error => error.status === 400);
    await assert.rejects(client.suggest(2, 'é'.repeat(262145), schema), error => error.status === 413);
    for (const prompt of ['server-request', 'upstream-error', 'invalid-json']) {
      const failedProgress = [];
      await assert.rejects(client.suggest(2, prompt, schema, {}, event => failedProgress.push(event)), error => error.status === 502 && !error.message.includes('fixture-secret'));
      assert.ok(!failedProgress.some(event => event.stage === 'response_received'));
      assert.strictEqual(activeIntervals.size, 0, 'failed generation clears its waiting heartbeat');
    }
    const controller = new AbortController();
    const canceledProgress = [];
    await assert.rejects(client.suggest(2, 'hold', schema, { signal: controller.signal }, event => {
      canceledProgress.push(event);
      if (event.stage === 'waiting') controller.abort();
    }), error => error.status === 499);
    assert.ok(canceledProgress.some(event => event.stage === 'waiting'));
    assert.ok(!canceledProgress.some(event => event.stage === 'response_received'));
    assert.strictEqual(activeIntervals.size, 0, 'disconnect clears its waiting heartbeat');
    // A second mutation is rejected, never queued into the same account's turn.
    const held = client.suggest(2, 'hold', schema);
    held.catch(() => {});
    await assert.rejects(client.login(2), error => error.status === 409);
    await assert.rejects(client.logout(2), error => error.status === 409);
    await client.shutdown();
    await assert.rejects(held, error => error.status === 503);
    global.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 180000 ? 20 : delay, ...args);
    const timedOutProgress = [];
    await assert.rejects(client.suggest(2, 'timeout', schema, {}, event => timedOutProgress.push(event)), error => error.status === 504);
    assert.ok(timedOutProgress.some(event => event.stage === 'waiting'));
    assert.ok(!timedOutProgress.some(event => event.stage === 'response_received'));
    assert.strictEqual(activeIntervals.size, 0, 'timed-out generation clears its waiting heartbeat');
    global.setTimeout = originalTimeout;
    await client.shutdown();
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'closed sessions must not leave child processes alive');
    console.log('Codex client isolation, lifecycle, bounded generation, and refusal checks passed.');
  } finally {
    global.setTimeout = originalTimeout;
    await client.shutdown();
    for (const timer of activeIntervals) originalClearInterval(timer);
    global.setInterval = originalInterval;
    global.clearInterval = originalClearInterval;
    childProcess.spawn = spawn;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (previousDb) require.cache[dbModule] = previousDb;
    else delete require.cache[dbModule];
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
