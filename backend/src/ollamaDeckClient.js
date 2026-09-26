const axios = require('axios');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 512 * 1024;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeBaseUrl(value, status = 400) {
  if (value == null) return null;
  const message = status === 503
    ? 'The server administrator must configure a valid HTTP(S) Ollama URL without credentials, query or fragment.'
    : 'Ollama URL must be an absolute HTTP(S) URL of at most 2048 characters without credentials, query or fragment.';
  if (typeof value !== 'string' || value.length > 2048) throw failure(status, message);
  const address = value.trim();
  if (!address) return null;
  let url;
  try { url = new URL(address); } catch (_) { throw failure(status, message); }
  if (!/^https?:\/\//i.test(address) || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.href.includes('?') || url.href.includes('#') ||
      /[\u0000-\u001f\u007f]/.test(address) || url.href.length > 2048) {
    throw failure(status, message);
  }
  return url.href;
}

function endpoint(path, baseUrl) {
  const address = normalizeBaseUrl(baseUrl) ??
    normalizeBaseUrl(process.env.OLLAMA_BASE_URL, 503) ?? 'http://127.0.0.1:11434';
  const url = new URL(address);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/${path}`;
  return url.href;
}

async function request(path, data, signal, baseUrl) {
  const url = endpoint(path, baseUrl);
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, data ? 180_000 : 10_000);
  timer.unref();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await axios({
      url, method: data ? 'POST' : 'GET', data, signal: controller.signal,
      maxRedirects: 0, proxy: false, maxContentLength: MAX_RESPONSE_BYTES,
      responseType: 'text', transformResponse: [],
    });
    try { return JSON.parse(response.data); } catch (_) {
      throw failure(502, 'Ollama returned an invalid JSON response.');
    }
  } catch (error) {
    if (signal?.aborted) throw failure(499, 'AI recommendation was canceled.');
    if (timedOut) throw failure(504, 'Ollama timed out. Check the service and try again.');
    if (error.status === 502 && !axios.isAxiosError(error)) throw error;
    throw failure(502, 'Unable to complete the Ollama request. Check the service and installed model, then try again.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function models(_userId, { signal, baseUrl } = {}) {
  const result = await request('tags', undefined, signal, baseUrl);
  if (!Array.isArray(result?.models) || result.models.some(model =>
    typeof model?.model !== 'string' || !model.model.trim() || model.model.length > 200 ||
    typeof model.name !== 'string' || !model.name.trim())) {
    throw failure(502, 'Ollama returned an invalid model list.');
  }
  return { models: result.models.map(model => ({
    id: model.model, name: model.name, isDefault: false,
    reasoningEfforts: [], defaultReasoningEffort: null,
  })) };
}

async function account(userId, options) {
  await models(userId, options);
  return { connected: true };
}

async function suggest(userId, prompt, outputSchema, { model, reasoning_effort, signal, baseUrl } = {}, onProgress) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure(400, 'A recommendation request is required.');
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw failure(413, 'The owned inventory is too large for one AI request. No cards were sent.');
  if (!outputSchema || outputSchema.type !== 'object' || outputSchema.additionalProperties !== false) {
    throw failure(500, 'The AI draft schema is not configured.');
  }
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || reasoning_effort != null) {
    throw failure(400, 'Choose an installed Ollama model in Settings. Ollama uses its native thinking defaults.');
  }
  const progress = event => {
    if (signal?.aborted || typeof onProgress !== 'function') return;
    try { onProgress(event); } catch (_) { /* A disconnected observer cannot fail a turn. */ }
  };
  progress({ stage: 'connecting' });
  const available = await models(userId, { signal, baseUrl });
  if (!available.models.some(item => item.id === model)) {
    throw failure(400, 'The selected Ollama model is unavailable. Refresh the model list in Settings and try again.');
  }
  progress({ stage: 'model_ready', model });
  const startedAt = Date.now();
  const waiting = typeof onProgress === 'function' ? setInterval(() => {
    progress({ stage: 'waiting', elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
  }, 10_000) : undefined;
  waiting?.unref();
  try {
    progress({ stage: 'generating' });
    const result = await request('chat', {
      model, format: outputSchema, stream: false,
      messages: [
        { role: 'system', content: `Return only JSON matching this schema, no markdown:\n${JSON.stringify(outputSchema)}` },
        { role: 'user', content: prompt },
      ],
    }, signal, baseUrl);
    if (result?.done_reason === 'length') {
      throw failure(502, 'Ollama reached its context or output limit before finishing the deck. Narrow the inventory using color/set filters or increase the model limits on your Ollama server. Nothing was saved.');
    }
    if (result?.done !== true || result.error || (result.done_reason !== undefined && result.done_reason !== 'stop') || typeof result.message?.content !== 'string') {
      throw failure(502, 'Ollama did not return a complete structured draft. Nothing was saved.');
    }
    let draft;
    try { draft = JSON.parse(result.message.content); } catch (_) {
      throw failure(502, 'Ollama did not return a valid JSON draft. Nothing was saved.');
    }
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw failure(502, 'Ollama did not return a structured draft. Nothing was saved.');
    }
    progress({ stage: 'response_received' });
    return draft;
  } finally { clearInterval(waiting); }
}

module.exports = { account, models, suggest, normalizeBaseUrl };
