const crypto = require('crypto');

const CALLBACK_URI = 'app.manafolio.app://auth/callback';
const HANDOFF_TTL_MS = 90 * 1000;
const MAX_HANDOFFS = 1000;
// ponytail: process-local like OIDC correlation; use a shared atomic store before running multiple workers.
const handoffs = new Map();

function validState(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function validDigest(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

function parseLogin(query) {
  if (!query || query.redirect_uri !== CALLBACK_URI || !validState(query.state) ||
      !validDigest(query.code_challenge)) return null;
  return { state: query.state, challenge: query.code_challenge };
}

function validExchange(body) {
  return body && !Array.isArray(body) && validDigest(body.code) && validState(body.state) &&
    typeof body.code_verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier);
}

function prune() {
  const now = Date.now();
  for (const [code, handoff] of handoffs) {
    if (handoff.expires <= now) handoffs.delete(code);
  }
}

function issueCode(userId, login) {
  prune();
  // Do not evict another legitimate login to make room for a new one.
  if (handoffs.size >= MAX_HANDOFFS) return null;
  const code = crypto.randomBytes(32).toString('base64url');
  handoffs.set(code, {
    userId,
    stateHash: crypto.createHash('sha256').update(login.state).digest(),
    challenge: Buffer.from(login.challenge, 'base64url'),
    expires: Date.now() + HANDOFF_TTL_MS,
  });
  return code;
}

function consumeCode(body) {
  prune();
  if (!validExchange(body)) return null;
  const handoff = handoffs.get(body.code);
  if (!handoff) return null;
  const stateHash = crypto.createHash('sha256').update(body.state).digest();
  const challenge = crypto.createHash('sha256').update(body.code_verifier).digest();
  const stateMatches = crypto.timingSafeEqual(stateHash, handoff.stateHash);
  const challengeMatches = crypto.timingSafeEqual(challenge, handoff.challenge);
  // Random guesses must not burn a legitimate code. The routes rate-limit attempts.
  if (!stateMatches || !challengeMatches) return null;
  // Synchronous consumption precedes any session/database await, preventing double exchange.
  handoffs.delete(body.code);
  return handoff.userId;
}

function callbackUrl(state, result) {
  const url = new URL(CALLBACK_URI);
  url.search = new URLSearchParams({ ...result, state }).toString();
  return url.toString();
}

module.exports = { parseLogin, validExchange, issueCode, consumeCode, callbackUrl };
