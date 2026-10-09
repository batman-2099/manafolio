// Consumer-visible native SSO security regressions; real router, temporary SQLite, local IdP.
// Run: node backend/test/nativeauth.test.js (no external identity service or sleeps).
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-native-auth-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ALLOW_REGISTRATION = 'false';
process.env.OIDC_ENABLED = 'true';
process.env.OIDC_CLIENT_ID = 'native-auth-test';
process.env.OIDC_CLIENT_SECRET = 'server-only-secret';
process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD = 'client_secret_basic';
process.env.OIDC_AUTO_PROVISION = 'true';
process.env.OIDC_ALLOW_USERNAME_LINK = 'false';
process.env.OIDC_DEFAULT_ROLE = 'member';
process.env.OIDC_USER_CLAIM = 'preferred_username';
delete process.env.DEFAULT_ADMIN_PASSWORD;
delete process.env.OIDC_REDIRECT_URI;
const db = require('../src/db');
const oidc = require('../src/utils/oidc');
const nativeAuth = require('../src/utils/nativeAuth');
const { sanitizeUser } = require('../src/utils/authHelpers');
const router = require('../src/routes/auth');
const CALLBACK = 'app.manafolio.app://auth/callback';
const verifier = 'a'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const clientState = 's'.repeat(43);
const loginParams = { code_challenge: challenge, state: clientState, redirect_uri: CALLBACK };
const exchangeBody = code => ({ code, state: clientState, code_verifier: verifier });
const realNow = Date.now;
const originalError = console.error;
const originalWarn = console.warn;
const logs = [];
let server;
let idp;
let base;
let issuer;
let requestNumber = 0;
let providerExchanges = 0;
const authorizations = new Map();

function testHandoffStore() {
  assert.deepStrictEqual(nativeAuth.parseLogin(loginParams), { state: clientState, challenge });
  for (const value of ['', null, ['x'], 'short', 's'.repeat(129), `${clientState}\n`, 'a'.repeat(31), 'a.b'.repeat(20)]) {
    assert.strictEqual(nativeAuth.parseLogin({ ...loginParams, state: value }), null);
  }
  for (const value of ['', null, [challenge], `${challenge}=`, 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(43)]) {
    assert.strictEqual(nativeAuth.parseLogin({ ...loginParams, code_challenge: value }), null);
  }
  for (const value of ['', null, [CALLBACK], 'https://attacker.test/callback', `${CALLBACK}/`, `${CALLBACK}?x=1`, `${CALLBACK}#x`, 'app.manafolio.app://auth@attacker.test/callback']) {
    assert.strictEqual(nativeAuth.parseLogin({ ...loginParams, redirect_uri: value }), null);
  }
  let now = realNow();
  Date.now = () => now;
  try {
    const login = nativeAuth.parseLogin(loginParams);
    const code = nativeAuth.issueCode(7, login);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    for (const value of ['', null, [verifier], 'a'.repeat(42), 'a'.repeat(129), `${verifier}=`, `${verifier}\n`]) {
      assert(!nativeAuth.validExchange({ ...exchangeBody(code), code_verifier: value }));
    }
    assert(nativeAuth.validExchange({ ...exchangeBody(code), code_verifier: 'a._~-'.repeat(20) }));
    assert.strictEqual(nativeAuth.consumeCode({ ...exchangeBody(code), state: 'x'.repeat(43) }), null);
    assert.strictEqual(nativeAuth.consumeCode({ ...exchangeBody(code), code_verifier: 'b'.repeat(43) }), null);
    assert.strictEqual(nativeAuth.consumeCode(exchangeBody(code)), 7, 'bad guesses do not burn a valid code');
    assert.strictEqual(nativeAuth.consumeCode(exchangeBody(code)), null, 'one-use handoff');
    const expiring = nativeAuth.issueCode(8, login);
    now += 90000;
    assert.strictEqual(nativeAuth.consumeCode(exchangeBody(expiring)), null, 'expires exactly at 90 seconds');
    const almostExpired = nativeAuth.issueCode(8, login);
    now += 89999;
    assert.strictEqual(nativeAuth.consumeCode(exchangeBody(almostExpired)), 8);
    const codes = Array.from({ length: 1000 }, () => nativeAuth.issueCode(9, login));
    assert(codes.every(Boolean));
    assert.strictEqual(new Set(codes).size, 1000);
    assert.strictEqual(nativeAuth.issueCode(10, login), null, 'capacity rejects newcomers without eviction');
    assert.strictEqual(nativeAuth.consumeCode(exchangeBody(codes[0])), 9, 'oldest live handoff survives capacity');
    assert(nativeAuth.issueCode(10, login), 'successful consumption frees capacity');
    now += 90000;
    nativeAuth.consumeCode(null); // Prune the bounded process-local store before route tests.
  } finally {
    Date.now = realNow;
  }
}

async function request(route, { method = 'GET', body, cookie, token, ip } = {}) {
  const response = await fetch(`${base}/api/auth${route}`, {
    method, redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      // Test-only trust-proxy setting allows isolated clients and one explicit limiter test.
      'X-Forwarded-For': ip || `198.18.${Math.floor(++requestNumber / 250)}.${requestNumber % 250 + 1}`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    location: response.headers.get('location'),
    body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text,
  };
}

async function begin({ browser = false, sub = 'owner-sub', username = 'collector', fail = false } = {}) {
  const result = await request(browser ? '/oidc/login' : `/native/login?${new URLSearchParams(loginParams)}`);
  assert.strictEqual(result.status, 302);
  const url = new URL(result.location);
  assert.strictEqual(url.origin, issuer);
  assert.strictEqual(url.searchParams.get('redirect_uri'), `${base}/api/auth/oidc/callback`);
  assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  assert.notStrictEqual(url.searchParams.get('code_challenge'), challenge, 'upstream and app PKCE are independent');
  const state = url.searchParams.get('state');
  assert.notStrictEqual(state, clientState, 'app state is not upstream browser correlation');
  const cookie = result.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\/api\/auth\/oidc/i);
  const code = `provider-code-${requestNumber}`;
  authorizations.set(code, { sub, username, fail, nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge') });
  return { code, state, cookie: cookie.split(';')[0] };
}

function callback(attempt, params = {}) {
  return request(`/oidc/callback?${new URLSearchParams({ code: attempt.code, state: attempt.state, ...params })}`, { cookie: attempt.cookie });
}

function nativeResult(result, expectedKey) {
  assert.strictEqual(result.status, 302);
  assert.strictEqual(result.headers.get('cache-control'), 'no-store');
  assert.strictEqual(result.headers.get('referrer-policy'), 'no-referrer');
  const url = new URL(result.location);
  assert.strictEqual(`${url.protocol}//${url.host}${url.pathname}`, CALLBACK);
  assert.strictEqual(url.searchParams.get('state'), clientState);
  assert.deepStrictEqual([...url.searchParams.keys()].sort(), [expectedKey, 'state'].sort());
  assert(!result.location.includes('oidc_token'));
  return url.searchParams.get(expectedKey);
}

async function startServers() {
  idp = http.createServer((req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` }));
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        providerExchanges++;
        const params = new URLSearchParams(body);
        const auth = authorizations.get(params.get('code'));
        authorizations.delete(params.get('code'));
        assert(auth, 'only fixture-issued authorization codes may be exchanged');
        assert.strictEqual(req.headers.authorization, `Basic ${Buffer.from('native-auth-test:server-only-secret').toString('base64')}`);
        assert.strictEqual(params.get('redirect_uri'), `${base}/api/auth/oidc/callback`);
        assert.strictEqual(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), auth.challenge);
        res.setHeader('Content-Type', 'application/json');
        if (auth.fail) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'provider-secret-must-not-leak' }));
        }
        const claims = { iss: issuer, aud: 'native-auth-test', exp: Math.floor(realNow() / 1000) + 3600, nonce: auth.nonce, sub: auth.sub, preferred_username: auth.username };
        res.end(JSON.stringify({ id_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, access_token: 'upstream-token-must-not-leak' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${idp.address().port}`;
  process.env.OIDC_ISSUER_URL = issuer;
  oidc._resetDiscoveryCache();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
}

async function testRoutes() {
  assert.strictEqual((await request('/config')).body.nativeOidcEnabled, true);
  const badLogin = await request(`/native/login?${new URLSearchParams({ ...loginParams, redirect_uri: 'https://attacker.test' })}`);
  assert.strictEqual(badLogin.status, 400);
  assert.deepStrictEqual(badLogin.body, { error: 'invalid_request' });
  assert.strictEqual(badLogin.location, null);
  assert.strictEqual((await request(`/native/login?${new URLSearchParams(loginParams)}&state=duplicate`)).status, 400);
  const attempt = await begin();
  const exchangesBefore = providerExchanges;
  for (const cookie of [undefined, 'manafolio_oidc=unrelated-browser', `${attempt.cookie}; ${attempt.cookie}`]) {
    const rejected = await request(`/oidc/callback?${new URLSearchParams({ code: attempt.code, state: attempt.state })}`, { cookie });
    const url = new URL(rejected.location, base);
    assert.strictEqual(url.origin, base, 'untrusted callbacks cannot choose an app destination');
    assert.strictEqual(url.searchParams.get('oidc_token'), null);
    assert.match(url.searchParams.get('oidc_error'), /cookie/i);
  }
  assert.strictEqual(providerExchanges, exchangesBefore);
  const handoff = nativeResult(await callback(attempt), 'code');
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM sessions')).count, 0, 'native callback never mints a reusable bearer');
  const owner = await db.get('SELECT * FROM users');
  assert.strictEqual(owner.username, 'admin', 'native first sign-in preserves owner bootstrap');
  assert.strictEqual(owner.role, 'admin');
  const wrongVerifier = await request('/native/exchange', { method: 'POST', body: { ...exchangeBody(handoff), code_verifier: 'b'.repeat(43) } });
  assert.deepStrictEqual(wrongVerifier.body, { error: 'invalid_grant' });
  assert.strictEqual(wrongVerifier.status, 400);
  assert.strictEqual((await request('/native/exchange', { method: 'POST', body: { ...exchangeBody(handoff), state: 'x'.repeat(43) } })).status, 400);
  const results = await Promise.all([0, 1].map(() => request('/native/exchange', { method: 'POST', body: exchangeBody(handoff) })));
  assert.deepStrictEqual(results.map(value => value.status).sort(), [200, 400], 'simultaneous exchange succeeds once');
  const success = results.find(value => value.status === 200);
  assert.strictEqual(success.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual(success.body.user, sanitizeUser(owner), 'same native password-login user contract');
  assert.strictEqual(success.body.message, 'Login successful');
  assert.match(success.body.token, /^[a-f0-9]{64}$/);
  const me = await request('/me', { token: success.body.token });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.user.id, owner.id);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM sessions')).count, 1);
  const replay = new URL((await callback(attempt)).location, base);
  assert.strictEqual(replay.origin, base);
  assert.strictEqual(replay.searchParams.get('oidc_token'), null);

  const browser = await callback(await begin({ browser: true }));
  const browserUrl = new URL(browser.location, base);
  assert.strictEqual(browserUrl.origin, base);
  assert.strictEqual(browserUrl.pathname, '/');
  assert.match(browserUrl.searchParams.get('oidc_token'), /^[a-f0-9]{64}$/, 'ordinary browser return remains unchanged');

  const cancelled = await begin();
  assert.strictEqual(nativeResult(await callback(cancelled, { error: 'access_denied', error_description: 'provider-secret-must-not-leak' }), 'error'), 'access_denied');
  assert.strictEqual(new URL((await callback(cancelled)).location, base).origin, base, 'cancelled browser correlation is consumed');
  assert.strictEqual(nativeResult(await callback(await begin({ fail: true })), 'error'), 'login_failed');

  const local = await db.run('INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)', ['alice', db.hashPassword('alice-password'), 'member', 'alice-share']);
  assert.strictEqual(nativeResult(await callback(await begin({ sub: 'alice-sub', username: 'alice' })), 'error'), 'account_link_required');
  assert.strictEqual((await db.get('SELECT oidc_sub FROM users WHERE id = ?', [local.lastID])).oidc_sub, null);
  process.env.OIDC_ALLOW_USERNAME_LINK = 'true';
  const aliceCode = nativeResult(await callback(await begin({ sub: 'alice-sub', username: 'alice' })), 'code');
  const alice = await request('/native/exchange', { method: 'POST', body: exchangeBody(aliceCode) });
  assert.strictEqual(alice.body.user.username, 'alice');
  assert.strictEqual(nativeResult(await callback(await begin({ sub: 'impostor-sub', username: 'alice' })), 'error'), 'identity_conflict');
  process.env.OIDC_AUTO_PROVISION = 'false';
  assert.strictEqual(nativeResult(await callback(await begin({ sub: 'new-sub', username: 'newmember' })), 'error'), 'provisioning_disabled');
  process.env.OIDC_AUTO_PROVISION = 'true';
  const deletedCode = nativeResult(await callback(await begin({ sub: 'new-sub', username: 'newmember' })), 'code');
  const newUser = await db.get('SELECT * FROM users WHERE oidc_sub = ?', ['new-sub']);
  assert.strictEqual(newUser.role, 'member', 'existing auto-provision role policy is preserved');
  await db.run('DELETE FROM users WHERE id = ?', [newUser.id]);
  assert.strictEqual((await request('/native/exchange', { method: 'POST', body: exchangeBody(deletedCode) })).status, 400);

  const expiring = nativeResult(await callback(await begin()), 'code');
  const now = realNow();
  Date.now = () => now + 90000;
  try {
    assert.deepStrictEqual((await request('/native/exchange', { method: 'POST', body: exchangeBody(expiring) })).body, { error: 'invalid_grant' });
  } finally {
    Date.now = realNow;
  }
  assert.deepStrictEqual((await request('/native/exchange', { method: 'POST', body: { code: ['bad'] } })).body, { error: 'invalid_request' });
  for (let count = 0; count < 20; count++) {
    const limited = await request(count % 2 ? '/native/login' : '/native/exchange', {
      method: count % 2 ? 'GET' : 'POST', ip: '203.0.113.99', ...(count % 2 ? {} : { body: {} })
    });
    assert.strictEqual(limited.status, 400);
  }
  const limited = await request('/native/exchange', { method: 'POST', body: {}, ip: '203.0.113.99' });
  assert.strictEqual(limited.status, 429, 'both native endpoints use the shared auth limiter');
  assert.strictEqual(limited.headers.get('cache-control'), 'no-store');
  assert(limited.headers.get('retry-after'));
  process.env.OIDC_ENABLED = 'false';
  const disabledConfig = (await request('/config')).body;
  assert.strictEqual(disabledConfig.oidcEnabled, false);
  assert.strictEqual(disabledConfig.nativeOidcEnabled, false);
  for (const [route, options] of [
    [`/native/login?${new URLSearchParams(loginParams)}`, {}],
    ['/native/exchange', { method: 'POST', body: exchangeBody(expiring) }],
  ]) {
    const disabled = await request(route, options);
    assert.strictEqual(disabled.status, 404);
    assert.deepStrictEqual(disabled.body, { error: 'oidc_disabled' });
  }
  assert(!logs.join('\n').includes('provider-secret-must-not-leak'));
  assert(!logs.join('\n').includes('upstream-token-must-not-leak'));
  assert(!logs.join('\n').includes(success.body.token));
}

async function testPendingBound() {
  let now = realNow() + 20 * 60 * 1000;
  Date.now = () => now;
  try {
    const req = { protocol: 'http', headers: {}, get: () => 'localhost' };
    const res = { cookie() {} };
    for (let count = 0; count < 1000; count++) {
      await oidc.buildAuthorizationUrl(req, res, nativeAuth.parseLogin(loginParams));
    }
    await assert.rejects(oidc.buildAuthorizationUrl(req, res), error => error.status === 503);
    now += 10 * 60 * 1000;
    assert(await oidc.buildAuthorizationUrl(req, res), 'expired pending browser attempts free capacity');
  } finally {
    Date.now = realNow;
  }
}

async function main() {
  testHandoffStore();
  await db.initDb();
  await startServers();
  console.error = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  await testRoutes();
  await testPendingBound();
  console.log('PASS: native PKCE handoff, replay/race/expiry/capacity protection, correlation, provisioning, browser regression and rate limits');
}

async function cleanup() {
  Date.now = realNow;
  console.error = originalError;
  console.warn = originalWarn;
  for (const listener of [server, idp]) {
    if (!listener) continue;
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch(error => {
  originalError(error);
  process.exitCode = 1;
}).finally(cleanup);
