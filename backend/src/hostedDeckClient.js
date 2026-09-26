const axios = require('axios');
const db = require('./db');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 512 * 1024;
const PROVIDERS = {
  gemini: { name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/', column: 'ai_gemini_api_key' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1/', column: 'ai_openrouter_api_key' },
};

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function providerSettings(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw failure(400, 'Choose Gemini or OpenRouter for an API key connection.');
  return PROVIDERS[provider];
}

async function savedKey(userId, provider) {
  const { column } = providerSettings(provider);
  const row = await db.get(`SELECT ${column} AS api_key FROM users WHERE id = ?`, [userId]);
  return row?.api_key || null;
}

async function request(provider, apiKey, path, data, signal) {
  const { base, name } = providerSettings(provider);
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, data ? 180_000 : 10_000);
  timer.unref();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let response;
  try {
    response = await axios({
      url: `${base}${path}`, method: data ? 'POST' : 'GET', data, signal: controller.signal,
      headers: provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` },
      maxRedirects: 0, proxy: false, maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: MAX_PROMPT_BYTES + 65536,
      responseType: 'text', transformResponse: [],
    });
  } catch (error) {
    if (signal?.aborted) throw failure(499, 'AI recommendation was canceled.');
    if (timedOut) throw failure(504, `${name} timed out. Please try again.`);
    const status = error.response?.status;
    if (status === 401 || status === 403) throw failure(400, `${name} rejected the API key or its permissions. Check the key in Settings.`);
    if (status === 402) throw failure(402, `${name} has insufficient credit for this request. No other model was used.`);
    if (status === 429) throw failure(429, `${name} rate or quota limit reached. Try again later. No other model was used.`);
    throw failure(502, `Unable to complete the ${name} request. Check the API key, selected model and provider availability. Nothing was saved.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  if (signal?.aborted) throw failure(499, 'AI recommendation was canceled.');
  if (typeof response.data !== 'string' || Buffer.byteLength(response.data) > MAX_RESPONSE_BYTES) {
    throw failure(502, `${name} returned an invalid or oversized response.`);
  }
  let result;
  try { result = JSON.parse(response.data); } catch (_) {
    throw failure(502, `${name} returned an invalid JSON response.`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) {
    throw failure(502, `${name} could not complete the request. Nothing was saved.`);
  }
  return result;
}

async function listModels(provider, apiKey, signal) {
  let rows;
  if (provider === 'gemini') {
    rows = [];
    let pageToken = '';
    const seen = new Set();
    do {
      const result = await request(provider, apiKey, `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, undefined, signal);
      if (!Array.isArray(result.models) || (result.nextPageToken !== undefined && typeof result.nextPageToken !== 'string')) {
        throw failure(502, 'Gemini returned an invalid model list.');
      }
      rows.push(...result.models);
      pageToken = result.nextPageToken || '';
      if (rows.length > 10000 || (pageToken && (seen.size >= 10 || pageToken.length > 4096 || seen.has(pageToken)))) {
        throw failure(502, 'Gemini returned an invalid model list.');
      }
      seen.add(pageToken);
    } while (pageToken);
    rows = rows.filter(model => typeof model?.name === 'string' && /^models\/gemini-[a-z0-9.-]+$/.test(model.name)
      && !/(?:image|audio|tts|live|robotics|computer-use)/.test(model.name)
      && Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
      .map(model => ({ id: model.name.slice('models/'.length), name: model.displayName || model.name }));
  } else {
    const result = await request(provider, apiKey, 'models?supported_parameters=structured_outputs&output_modalities=text', undefined, signal);
    if (!Array.isArray(result.data)) throw failure(502, 'OpenRouter returned an invalid model list.');
    rows = result.data.filter(model => Array.isArray(model?.supported_parameters) && model.supported_parameters.includes('structured_outputs')
      && model.architecture?.input_modalities?.includes('text') && model.architecture?.output_modalities?.includes('text'));
  }
  if (rows.some(model => typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200
    || typeof model.name !== 'string' || !model.name.trim())) {
    throw failure(502, `${PROVIDERS[provider].name} returned an invalid model list.`);
  }
  return { models: rows.map(model => ({ id: model.id, name: model.name, isDefault: false,
    reasoningEfforts: [], defaultReasoningEffort: null })) };
}

async function validateKey(provider, apiKey, signal) {
  if (provider === 'gemini') {
    await listModels(provider, apiKey, signal);
  } else {
    const result = await request(provider, apiKey, 'key', undefined, signal);
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw failure(502, 'OpenRouter returned an invalid account response.');
    }
    if (result.data.is_management_key || result.data.is_provisioning_key) {
      throw failure(400, 'Use an OpenRouter inference API key, not a management key.');
    }
  }
}

async function saveCredentials(userId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['provider', 'api_key'].includes(key))) {
    throw failure(400, 'Invalid AI credential fields.');
  }
  const { column } = providerSettings(body.provider);
  if (typeof body.api_key !== 'string' || !body.api_key.trim() || body.api_key.length > 512 || /[^\x21-\x7e]/.test(body.api_key.trim())) {
    throw failure(400, 'API key must be non-empty text of at most 512 characters without whitespace.');
  }
  const apiKey = body.api_key.trim();
  await validateKey(body.provider, apiKey);
  await db.run(`UPDATE users SET ${column} = ? WHERE id = ?`, [apiKey, userId]);
}

async function deleteCredentials(userId, provider) {
  const { column } = providerSettings(provider);
  await db.run(`UPDATE users SET ${column} = NULL WHERE id = ?`, [userId]);
}

// Gemini's JSON Schema subset omits string lengths. Keep enforcing those in the shared draft validator.
function geminiSchema(schema) {
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'minLength' || key === 'maxLength') continue;
    if (key === 'properties') result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, geminiSchema(child)]));
    else if (key === 'items') result.items = geminiSchema(value);
    else if (key === 'anyOf') result.anyOf = value.map(geminiSchema);
    else result[key] = value;
  }
  if (result.properties) result.propertyOrdering = Object.keys(result.properties);
  return result;
}

function client(provider) {
  const { name } = PROVIDERS[provider];
  async function models(userId, { signal } = {}) {
    const apiKey = await savedKey(userId, provider);
    if (!apiKey) throw failure(409, `Connect ${name} with your API key in Settings first.`);
    return listModels(provider, apiKey, signal);
  }
  async function account(userId, { signal } = {}) {
    const apiKey = await savedKey(userId, provider);
    if (!apiKey) return { connected: false };
    await validateKey(provider, apiKey, signal);
    return { connected: true };
  }
  async function suggest(userId, prompt, outputSchema, { model, reasoning_effort, signal } = {}, onProgress) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw failure(400, 'A recommendation request is required.');
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw failure(413, 'The owned inventory is too large for one AI request. No cards were sent.');
    if (!outputSchema || outputSchema.type !== 'object' || outputSchema.additionalProperties !== false) {
      throw failure(500, 'The AI draft schema is not configured.');
    }
    if (typeof model !== 'string' || !model.trim() || model.length > 200 || reasoning_effort != null) {
      throw failure(400, `Choose a ${name} model in Settings with no thinking level override.`);
    }
    const progress = event => {
      if (signal?.aborted || typeof onProgress !== 'function') return;
      try { onProgress(event); } catch (_) { /* A disconnected observer cannot fail a turn. */ }
    };
    progress({ stage: 'connecting' });
    const apiKey = await savedKey(userId, provider);
    if (!apiKey) throw failure(409, `Connect ${name} with your API key in Settings first.`);
    const available = await listModels(provider, apiKey, signal);
    if (!available.models.some(item => item.id === model)) {
      throw failure(400, `The selected ${name} model is unavailable or does not support structured output. Refresh the model list in Settings.`);
    }
    progress({ stage: 'model_ready', model });
    const startedAt = Date.now();
    const waiting = typeof onProgress === 'function' ? setInterval(() => {
      progress({ stage: 'waiting', elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
    }, 10_000) : undefined;
    waiting?.unref();
    try {
      progress({ stage: 'generating' });
      let content;
      if (provider === 'gemini') {
        const result = await request(provider, apiKey, `models/${encodeURIComponent(model)}:generateContent`, {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: geminiSchema(outputSchema) },
        }, signal);
        const candidate = result.candidates?.[0];
        const parts = candidate?.content?.parts;
        if (candidate?.finishReason === 'MAX_TOKENS') throw failure(502, `${name} reached its output limit before finishing the deck. Narrow the inventory and try again. Nothing was saved.`);
        if (result.promptFeedback?.blockReason || !Array.isArray(result.candidates) || result.candidates.length !== 1 || candidate?.finishReason !== 'STOP'
          || (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.some(rating => rating?.blocked)) || !Array.isArray(parts) || !parts.length
          || parts.some(part => !part || typeof part.text !== 'string' || Object.keys(part).some(key => !['text', 'thought', 'thoughtSignature'].includes(key)))) {
          throw failure(502, `${name} did not return a complete structured draft. Nothing was saved.`);
        }
        content = parts.filter(part => part.thought !== true).map(part => part.text).join('');
      } else {
        const result = await request(provider, apiKey, 'chat/completions', {
          model, stream: false, messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'deck_suggestion', strict: true, schema: outputSchema } },
          provider: { require_parameters: true, allow_fallbacks: false },
        }, signal);
        const choice = result.choices?.[0];
        if (choice?.finish_reason === 'length') throw failure(502, `${name} reached its output limit before finishing the deck. Narrow the inventory and try again. Nothing was saved.`);
        if (!Array.isArray(result.choices) || result.choices.length !== 1 || choice?.finish_reason !== 'stop' || choice.error || choice.message?.refusal
          || choice.message?.tool_calls?.length || choice.message?.function_call || typeof choice.message?.content !== 'string') {
          throw failure(502, `${name} did not return a complete structured draft. Nothing was saved.`);
        }
        content = choice.message.content;
      }
      let draft;
      try { draft = JSON.parse(content); } catch (_) {
        throw failure(502, `${name} did not return a valid JSON draft. Nothing was saved.`);
      }
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
        throw failure(502, `${name} did not return a structured draft. Nothing was saved.`);
      }
      progress({ stage: 'response_received' });
      return draft;
    } finally { clearInterval(waiting); }
  }
  return { account, models, suggest };
}

module.exports = { gemini: client('gemini'), openrouter: client('openrouter'), saveCredentials, deleteCredentials };
