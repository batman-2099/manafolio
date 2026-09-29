const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const VERSION = '0.155.1';
const RPC_TIMEOUT = 30_000;
const TURN_TIMEOUT = 180_000;
const LOGIN_TIMEOUT = 15 * 60_000;
const IDLE_TIMEOUT = 60_000;
const MAX_SESSIONS = 8;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const sessions = new Map();
const operations = new Map();
const disposedUsers = new Set();

// Security-sensitive: reviewed against rust-v0.155.1, not the moving CLI defaults.
// thread/start + turn/start environments:[] removes shell/apply_patch/view_image
// in core/src/tools/spec_plan.rs. Read-only sandbox alone does NOT prevent reads.
// Code Mode can be selected by model metadata: its V8 runtime rejects imports and
// exposes only registered tools and in-memory helpers (code-mode-runtime/src/runtime).
const DISABLED_FEATURES = [
  'shell_tool', 'shell_snapshot', 'shell_snapshot_v2', 'view_image',
  'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use',
  'standalone_web_search', 'image_generation', 'multi_agent', 'multi_agent_v2',
  'memory_tool', 'memories', 'hooks', 'codex_hooks', 'plugin_hooks', 'js_repl',
  'code_mode', 'code_mode_only', 'code_mode_prewarm', 'remote_control',
  'skill_search', 'skill_mcp_dependency_install', 'skill_env_var_dependency_prompt',
  'tool_suggest', 'request_permissions_tool', 'deferred_executor', 'token_budget',
  'sleep_tool', 'goals',
];
const CONFIG = [
  'cli_auth_credentials_store="file"',
  'model_provider="openai"',
  'approval_policy="never"',
  'approvals_reviewer="user"',
  'sandbox_mode="read-only"',
  'web_search="disabled"',
  'agents.enabled=false',
  'apps._default.enabled=false',
  'orchestrator.mcp.enabled=false',
  'orchestrator.skills.enabled=false',
  'skills.bundled.enabled=false',
  'skills.include_instructions=false',
  'features.skip_host_skill_discovery=true',
  'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false',
  'project_doc_max_bytes=0',
  'include_environment_context=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'include_permissions_instructions=false',
  'shell_environment_policy.inherit="none"',
  'history.persistence="none"',
  'analytics.enabled=false',
  ...DISABLED_FEATURES.map(feature => `features.${feature}=false`),
];

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function userKey(userId) {
  const value = Number(userId);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== String(userId)) {
    throw failure(400, 'Invalid user account.');
  }
  return String(value);
}

function userHome(key) {
  return path.resolve(path.dirname(require('./db').dbPath), 'codex', key);
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(503, 'Unsafe AI account storage.');
  await fs.chmod(directory, 0o700);
}

async function createSession(key) {
  if (process.platform === 'win32') {
    throw failure(503, 'AI recommendations require a Unix server for isolated process cleanup.');
  }
  const pkgPath = require.resolve('@openai/codex/package.json');
  const pkg = require(pkgPath);
  if (pkg.version !== VERSION) throw failure(503, 'The installed Codex version needs a security review.');
  const executable = path.resolve(path.dirname(pkgPath), pkg.bin.codex);
  const home = userHome(key);
  const root = path.dirname(home);
  await privateDirectory(root);
  await privateDirectory(home);
  // A fresh runtime lives outside the application tree: no repository config or
  // AGENTS.md is discovered, and HOME never points at the server operator's home.
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-codex-'));
  let child;
  try {
    await fs.chmod(runtime, 0o700);
    for (const name of ['home', 'work', 'tmp']) await privateDirectory(path.join(runtime, name));
    child = childProcess.spawn(process.execPath, [
      executable, 'app-server', '--listen', 'stdio://', '--strict-config',
      ...CONFIG.flatMap(value => ['-c', value]),
    ], {
      cwd: path.join(runtime, 'work'),
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: path.join(runtime, 'home'),
        XDG_CONFIG_HOME: path.join(runtime, 'home'),
        XDG_DATA_HOME: path.join(runtime, 'home'),
        XDG_CACHE_HOME: path.join(runtime, 'tmp'),
        TMPDIR: path.join(runtime, 'tmp'),
        CODEX_HOME: home,
        LANG: 'C.UTF-8',
      },
    });
  } catch (error) {
    await fs.rm(runtime, { recursive: true, force: true });
    throw error;
  }

  let nextId = 1;
  let buffer = '';
  let idleTimer;
  let loginTimer;
  let dead = false;
  let turn;
  let loginCompletion;
  const pending = new Map();
  const session = { home, runtime, login: null, ready: null, close, request, touch, runTurn };
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  closed.catch(error => console.error('Codex runtime cleanup failed:', error.message));
  let cleanupStarted = false;

  function cleanup() {
    if (cleanupStarted) return;
    cleanupStarted = true;
    fs.rm(runtime, { recursive: true, force: true }).then(() => {
      if (sessions.get(key) === session) sessions.delete(key);
      resolveClosed();
    }, rejectClosed);
  }

  function close(error = failure(503, 'The AI connection closed. Please try again.')) {
    if (dead) return closed;
    dead = true;
    clearTimeout(idleTimer);
    clearTimeout(loginTimer);
    session.login = null;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    if (turn) {
      clearTimeout(turn.timer);
      clearInterval(turn.waitingTimer);
      turn.reject(error);
      turn = null;
    }
    child.stdin.destroy();
    // Own detached process group includes the npm launcher, native server, and
    // Code Mode host. Killing only the launcher can leave credentials in memory.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
    return closed;
  }

  function touch() {
    clearTimeout(idleTimer);
    if (!dead && !turn && !session.login) {
      idleTimer = setTimeout(() => close(), IDLE_TIMEOUT);
      idleTimer.unref();
    }
  }

  function send(message) {
    if (dead) throw failure(503, 'The AI connection closed. Please try again.');
    child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error) close();
    });
  }

  function request(method, params = {}) {
    if (dead) return Promise.reject(failure(503, 'The AI connection closed. Please try again.'));
    if (pending.size >= 16) return Promise.reject(failure(429, 'Too many AI requests. Please wait.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => close(failure(504, 'The AI service did not respond in time.')), RPC_TIMEOUT);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { close(error); }
    });
  }

  function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return close();
    if (message.method && message.id !== undefined) {
      // Never execute server requests, answer approvals, open URLs, or provide
      // external auth tokens. Unknown future requests are denied too.
      send({ id: message.id, error: { code: -32601, message: 'Client requests are disabled.' } });
      return close(failure(502, 'The AI service requested an unsupported action.'));
    }
    if (message.id !== undefined) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(failure(502, 'The AI service could not complete the request. Please reconnect or try again.'));
      else if ('result' in message) item.resolve(message.result);
      else item.reject(failure(502, 'The AI service returned an invalid response.'));
      return;
    }
    const params = message.params || {};
    if (message.method === 'account/login/completed') {
      loginCompletion = { id: params.loginId, success: params.success === true };
      if (params.loginId === session.login?.id) {
        clearTimeout(loginTimer);
        session.login = null;
        if (!params.success) close();
        else touch();
      }
    }
    if (!turn || params.threadId !== turn.threadId) return;
    if (params.turnId && turn.turnId && params.turnId !== turn.turnId) return;
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (typeof params.item.text === 'string' && params.item.phase !== 'commentary') {
        turn.text = params.item.text;
      }
    }
    if (message.method === 'turn/completed') {
      if (turn.turnId && params.turn?.id !== turn.turnId) return;
      const active = turn;
      turn = null;
      clearTimeout(active.timer);
      clearInterval(active.waitingTimer);
      if (params.turn?.status !== 'completed') {
        active.reject(failure(502, 'AI recommendation failed or was interrupted. Please try again.'));
      } else {
        try {
          const result = JSON.parse(active.text);
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
          active.resolve(result);
        } catch (_) {
          active.reject(failure(502, 'The AI service did not return a valid deck draft.'));
        }
      }
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (dead) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
      close(failure(502, 'The AI response exceeded the supported size.'));
      return;
    }
    let newline;
    while (!dead && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { handle(JSON.parse(line)); } catch (_) { close(failure(502, 'The AI service returned an invalid response.')); }
    }
  });
  child.stdin.on('error', () => close());
  child.stdout.on('error', () => close());
  child.on('error', () => { close(); cleanup(); });
  child.on('close', () => { close(); cleanup(); });

  session.startLogin = async () => {
    if (session.login) return session.login.public;
    loginCompletion = null;
    const result = await request('account/login/start', { type: 'chatgptDeviceCode' });
    if (result?.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' ||
        result.verificationUrl !== 'https://auth.openai.com/codex/device' ||
        typeof result.userCode !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(result.userCode)) {
      throw failure(502, 'The AI service returned an invalid login request.');
    }
    const publicLogin = { verificationUrl: result.verificationUrl, userCode: result.userCode };
    if (loginCompletion?.id === result.loginId) {
      if (!loginCompletion.success) throw failure(502, 'ChatGPT connection was not completed. Please try again.');
      return publicLogin;
    }
    session.login = { id: result.loginId, public: publicLogin };
    clearTimeout(idleTimer);
    // Polling account status must not extend the device authorization lifetime.
    loginTimer = setTimeout(() => close(), LOGIN_TIMEOUT);
    loginTimer.unref();
    return session.login.public;
  };

  session.cancelLogin = async () => {
    const pendingLogin = session.login;
    session.login = null;
    clearTimeout(loginTimer);
    // Cancel emits login/completed(false); it is not a connection failure.
    if (pendingLogin) await request('account/login/cancel', { loginId: pendingLogin.id });
  };

  async function runTurn(prompt, outputSchema, { model, reasoning_effort } = {}, onProgress) {
    const started = await request('thread/start', {
      ...(model !== undefined ? { model } : {}),
      cwd: path.join(runtime, 'work'),
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: 'You help build and discuss Magic: The Gathering decks from the supplied owned inventory. Return only the requested JSON response with a message and a complete draft or null for discussion. Never use tools or request access to anything outside the supplied input.',
    });
    if (typeof started?.thread?.id !== 'string' ||
        !Array.isArray(started.thread.environments) || started.thread.environments.length) {
      throw failure(503, 'Codex did not confirm an isolated recommendation environment.');
    }
    clearTimeout(idleTimer);
    const result = new Promise((resolve, reject) => {
      turn = { threadId: started.thread.id, turnId: null, text: '', resolve, reject };
      turn.timer = setTimeout(() => close(failure(504, 'AI recommendation exceeded three minutes. Please try again.')), TURN_TIMEOUT);
    });
    // Attach a handler before awaiting turn/start: completion can precede its RPC response.
    result.catch(() => {});
    try {
      if (onProgress) {
        const startedAt = Date.now();
        turn.waitingTimer = setInterval(() => onProgress({ stage: 'waiting', elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }), 10_000);
        turn.waitingTimer.unref();
      }
      onProgress?.({ stage: 'generating' });
      const response = await request('turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: prompt }],
        ...(reasoning_effort !== undefined ? { effort: reasoning_effort } : {}),
        environments: [],
        approvalPolicy: 'never',
        outputSchema,
      });
      if (typeof response?.turn?.id !== 'string') throw failure(502, 'The AI service returned an invalid turn.');
      if (turn) turn.turnId = response.turn.id;
      return await result;
    } catch (error) {
      close(error);
      throw error;
    }
  }

  session.ready = (async () => {
    await request('initialize', {
      clientInfo: { name: 'manafolio_deck_builder', title: 'Manafolio deck builder', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized', params: {} });
    const loaded = await request('config/read', { includeLayers: true, cwd: path.join(runtime, 'work') });
    // Do not inherit operator/project/MCP/provider configuration. Empty default
    // system/user layers are normal; enterprise-managed policy must fail closed.
    if (!Array.isArray(loaded?.layers) || loaded.layers.some(layer =>
      !['packagedDefaults', 'sessionFlags'].includes(layer.name?.type) &&
      Object.keys(layer.config || {}).length > 0)) {
      throw failure(503, 'AI recommendations cannot use inherited Codex configuration.');
    }
    const policy = await request('configRequirements/read');
    if (policy?.requirements != null) {
      throw failure(503, 'Managed Codex requirements are not supported for isolated recommendations.');
    }
    touch();
  })().catch(error => { close(error); throw error; });
  return session;
}

async function getSession(key) {
  let entry = sessions.get(key);
  if (!entry) {
    if (sessions.size >= MAX_SESSIONS) throw failure(503, 'AI service is busy. Please try again shortly.');
    // Keep the creation promise in the same map to prevent simultaneous status
    // and login calls spawning two processes against one user's credential file.
    entry = createSession(key);
    sessions.set(key, entry);
    try {
      const session = await entry;
      sessions.set(key, session);
      entry = session;
    } catch (_) {
      sessions.delete(key);
      throw failure(503, 'Could not start the isolated AI connection.');
    }
  } else entry = await entry;
  try { await entry.ready; }
  catch (error) { await entry.close(error); throw error; }
  entry.touch();
  return entry;
}

async function withOperation(userId, action) {
  const key = userKey(userId);
  if (disposedUsers.has(key)) throw failure(410, 'This AI account has been deleted.');
  if (operations.has(key)) throw failure(409, 'Another AI action is in progress. Please wait.');
  let finish;
  operations.set(key, new Promise(resolve => { finish = resolve; }));
  let session;
  try {
    session = await getSession(key);
    if (disposedUsers.has(key)) throw failure(410, 'This AI account has been deleted.');
    return await action(session);
  } catch (error) {
    if (session && error.status !== 409) await session.close(error);
    if (error.status) throw error;
    throw failure(503, 'The isolated AI connection is unavailable.');
  } finally {
    operations.delete(key);
    finish();
    session?.touch();
  }
}

async function account(userId) {
  return withOperation(userId, async session => {
    const result = await session.request('account/read', { refreshToken: false });
    if (result?.account?.type !== 'chatgpt') return { connected: false };
    return {
      connected: true,
      ...(typeof result.account.email === 'string' ? { email: result.account.email } : {}),
    };
  });
}

async function login(userId) {
  return withOperation(userId, session => session.startLogin());
}

async function logout(userId) {
  return withOperation(userId, async session => {
    await session.cancelLogin();
    await session.request('account/logout');
    await session.close();
    // Remove persisted auth and any account-scoped cache without ever reading tokens.
    await fs.rm(session.home, { recursive: true, force: true });
  });
}

// Administrative deletion is local-only, even if Codex is unavailable or offline.
async function disposeUser(userId) {
  const key = userKey(userId);
  disposedUsers.add(key);
  const operation = operations.get(key);
  const entry = sessions.get(key);
  if (entry) {
    const session = await entry;
    await session.close(failure(410, 'This AI account has been deleted.'));
  }
  // Creation and an already-running operation must finish before removing auth:
  // neither may recreate directories after this function returns.
  if (operation) await operation;
  await fs.rm(userHome(key), { recursive: true, force: true });
}

// rust-v0.155.1 ModelListResponse uses data/nextCursor; Model.model is the
// inference identifier, which need not match the picker entry's Model.id.
async function listModels(session) {
  const models = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const page = await session.request('model/list', { cursor, includeHidden: false });
    if (!Array.isArray(page?.data) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
      throw failure(502, 'The AI service returned an invalid model list.');
    }
    for (const model of page.data) {
      if (model?.hidden === true) continue;
      if (typeof model?.model !== 'string' || !model.model ||
          typeof model.displayName !== 'string' || typeof model.isDefault !== 'boolean' ||
          typeof model.defaultReasoningEffort !== 'string' || !Array.isArray(model.supportedReasoningEfforts) ||
          model.supportedReasoningEfforts.some(option => typeof option?.reasoningEffort !== 'string')) {
        throw failure(502, 'The AI service returned an invalid model list.');
      }
      models.push({
        id: model.model, name: model.displayName, isDefault: model.isDefault,
        defaultReasoningEffort: model.defaultReasoningEffort,
        reasoningEfforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort),
      });
    }
    cursor = page.nextCursor;
    if (cursor !== null && cursors.has(cursor)) throw failure(502, 'The AI service returned an invalid model list.');
    cursors.add(cursor);
  } while (cursor !== null);
  return models;
}

async function models(userId) {
  return withOperation(userId, async session => {
    const result = await session.request('account/read', { refreshToken: false });
    if (result?.account?.type !== 'chatgpt' || session.login) {
      throw failure(409, 'Connect your ChatGPT account before choosing an AI model.');
    }
    return { models: await listModels(session) };
  });
}

async function suggest(userId, prompt, outputSchema, { model, reasoning_effort, signal } = {}, onProgress) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure(400, 'A recommendation request is required.');
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw failure(413, 'The owned inventory is too large for one AI request. No cards were sent.');
  if (!outputSchema || outputSchema.type !== 'object' || outputSchema.additionalProperties !== false) {
    throw failure(500, 'The AI draft schema is not configured.');
  }
  if ((model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) ||
      (reasoning_effort !== undefined && (typeof reasoning_effort !== 'string' || !reasoning_effort.trim() || reasoning_effort.length > 40))) {
    throw failure(400, 'Choose a supported AI model and thinking level.');
  }
  // Progress is public lifecycle metadata, never provider messages or reasoning.
  const progress = typeof onProgress === 'function' ? event => {
    if (signal?.aborted) return;
    try { onProgress(event); } catch (_) { /* A disconnected observer cannot fail a turn. */ }
  } : undefined;
  progress?.({ stage: 'connecting' });
  return withOperation(userId, async session => {
    const abort = () => session.close(failure(499, 'AI recommendation was canceled.'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) {
        await abort();
        throw failure(499, 'AI recommendation was canceled.');
      }
      const result = await session.request('account/read', { refreshToken: false });
      if (result?.account?.type !== 'chatgpt') throw failure(409, 'Connect your ChatGPT account before requesting a recommendation.');
      if (session.login) throw failure(409, 'Finish connecting ChatGPT before requesting a recommendation.');
      if (model !== undefined || reasoning_effort !== undefined) {
        const available = await listModels(session);
        const selected = model === undefined ? available.find(item => item.isDefault) : available.find(item => item.id === model);
        if (!selected) throw failure(400, 'The selected AI model is unavailable. Refresh the model list and try again.');
        if (reasoning_effort !== undefined && !selected.reasoningEfforts.includes(reasoning_effort)) {
          throw failure(400, 'The selected thinking level is not supported by this AI model.');
        }
        model = selected.id;
      }
      progress?.({ stage: 'model_ready', ...(model !== undefined ? { model } : {}), ...(reasoning_effort !== undefined ? { reasoning_effort } : {}) });
      try {
        const draft = await session.runTurn(prompt, outputSchema, { model, reasoning_effort }, progress);
        progress?.({ stage: 'response_received' });
        return draft;
      } finally { await session.close(); }
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  });
}

async function shutdown() {
  await Promise.allSettled([...sessions.values()].map(async entry => (await entry).close()));
}

module.exports = { account, login, logout, models, suggest, disposeUser, shutdown };
