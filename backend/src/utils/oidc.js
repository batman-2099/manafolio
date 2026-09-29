const crypto = require('crypto');

// Secret for HMAC state token signing — stable per process lifetime if not explicitly set
const STATE_SECRET = process.env.OIDC_SESSION_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let discoveryCache = null;
let discoveryExpiresAt = 0;

function isOidcEnabled() {
  return process.env.OIDC_ENABLED === 'true' || process.env.OIDC_ENABLED === '1';
}

function getProviderName() {
  return (process.env.OIDC_PROVIDER_NAME || 'Single Sign-On').trim();
}

function isAutoProvisionEnabled() {
  if (process.env.OIDC_AUTO_PROVISION === 'false' || process.env.OIDC_AUTO_PROVISION === '0') {
    return false;
  }
  return true;
}

// Whether an IdP identity may attach itself to a Manafolio account that already
// exists, purely because the two share a username.
//
// Off unless the operator turns it on, and that is the whole point. The username
// comes from a claim the IdP sends (OIDC_USER_CLAIM, preferred_username by
// default) and extractUserIdentity lower-cases it, while the Manafolio owner
// account is always created as "admin". So on any IdP where a person can choose
// or edit their own username — self-registration, or a profile page that lets
// them — setting it to "admin" and signing in once used to bind their identity
// to the owner account and log them straight in as it. No password involved.
//
// It cannot simply be deleted: an install that predates SSO has real accounts
// with real collections behind them, and linking by username is how those
// accounts keep working. So it stays available, and the operator says whether
// their IdP's usernames are trustworthy enough for it — which is a fact only
// they have.
function isUsernameLinkEnabled() {
  return process.env.OIDC_ALLOW_USERNAME_LINK === 'true' || process.env.OIDC_ALLOW_USERNAME_LINK === '1';
}

function getDefaultRole() {
  return process.env.OIDC_DEFAULT_ROLE === 'admin' ? 'admin' : 'member';
}

function getUserClaimName() {
  return (process.env.OIDC_USER_CLAIM || 'preferred_username').trim();
}

function getScopes() {
  return (process.env.OIDC_SCOPES || 'openid profile email').trim();
}

function getClientId() {
  return (process.env.OIDC_CLIENT_ID || '').trim();
}

function getClientSecret() {
  return (process.env.OIDC_CLIENT_SECRET || '').trim();
}

function getIssuerUrl() {
  return (process.env.OIDC_ISSUER_URL || '').trim().replace(/\/+$/, '');
}

// Everything below trusts the transport instead of a signature: the ID token is
// accepted because it came straight from the token endpoint over TLS, which is
// what OIDC Core 3.1.3.7 allows in place of verifying it. Over plain http that
// reasoning is worth nothing -- anything on the path can serve the discovery
// document, be the token endpoint, and mint whatever identity it likes.
//
// Loopback is exempt because it never leaves the machine, and it is what the
// test suite and a local IdP actually use.
function assertIssuerTransport(issuer) {
  let url;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`OIDC_ISSUER_URL is not a valid URL: ${issuer}`);
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) return;
  throw new Error(
    `OIDC_ISSUER_URL must be https (got ${url.protocol}//${url.hostname}). ` +
    'Identity is only as trustworthy as the connection it arrives over.'
  );
}

// Bounded skew for exp. Clocks in a self-hosted stack drift, and refusing a
// token that expired half a second ago by the container's reckoning is a
// support ticket, not security.
const CLOCK_SKEW_SECONDS = 60;

// The checks the code flow still needs once the signature is taken on trust.
//
// Each one answers a question TLS does not:
//   iss    -- did this come from the issuer we configured, or one whose discovery
//             document happened to name someone else's token endpoint?
//   aud    -- was it minted for THIS client, or replayed from another client of
//             the same IdP that the caller also has an account with?
//   exp    -- is it still current?
//   nonce  -- is it the token minted for THIS login, or one captured earlier?
//             buildAuthorizationUrl has always generated a nonce, sent it to the
//             IdP and sealed it into the state token. Nothing ever compared it to
//             the claim coming back, which meant it read as replay protection in
//             review and was none.
//
// Throws on the first failure; the caller turns that into an oidc_error redirect.
function validateIdTokenClaims(claims, { issuer, clientId, nonce, now = Date.now() } = {}) {
  if (!claims || typeof claims !== 'object' || !Object.keys(claims).length) {
    throw new Error('OIDC provider returned no ID token. The authorization code flow requires one.');
  }

  const strip = (v) => String(v || '').replace(/\/+$/, '');
  if (issuer && strip(claims.iss) !== strip(issuer)) {
    throw new Error(`OIDC ID token was issued by "${claims.iss}", not by the configured issuer.`);
  }

  // aud is a string, or an array when the IdP issues to several clients at once.
  const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
  if (clientId && !audiences.includes(clientId)) {
    throw new Error('OIDC ID token was not issued for this client.');
  }
  // With more than one audience the spec requires azp, and requires it to be us.
  if (audiences.length > 1 && claims.azp && String(claims.azp) !== clientId) {
    throw new Error('OIDC ID token was authorized for a different client.');
  }

  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) {
    throw new Error('OIDC ID token has no expiry.');
  }
  if (exp * 1000 + CLOCK_SKEW_SECONDS * 1000 < now) {
    throw new Error('OIDC ID token has expired. Please try logging in again.');
  }

  if (nonce && String(claims.nonce || '') !== String(nonce)) {
    throw new Error('OIDC ID token nonce does not match this login attempt.');
  }

  return claims;
}

function resolveRedirectUri(req) {
  if (process.env.OIDC_REDIRECT_URI) {
    return process.env.OIDC_REDIRECT_URI.trim();
  }
  if (process.env.PUBLIC_BASE_URL) {
    const base = process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '');
    return `${base}/api/auth/oidc/callback`;
  }
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}/api/auth/oidc/callback`;
  }
  return 'http://localhost:3001/api/auth/oidc/callback';
}

function getTokenEndpointAuthMethod() {
  const method = (
    process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD || 'client_secret_basic'
  ).trim();

  const supported = [
    'client_secret_basic',
    'client_secret_post',
    'none'
  ];

  if (!supported.includes(method)) {
    throw new Error(
      `Unsupported OIDC_TOKEN_ENDPOINT_AUTH_METHOD: ${method}. ` +
      `Supported values: ${supported.join(', ')}`
    );
  }

  return method;
}

/**
 * Fetch and cache OpenID Connect Discovery document (.well-known/openid-configuration).
 */
async function getDiscovery(forceRefresh = false) {
  const issuer = getIssuerUrl();
  if (!issuer) {
    throw new Error('OIDC_ISSUER_URL is not configured');
  }
  assertIssuerTransport(issuer);

  const now = Date.now();
  if (!forceRefresh && discoveryCache && discoveryExpiresAt > now) {
    return discoveryCache;
  }

  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC discovery from ${discoveryUrl} (HTTP ${res.status})`);
  }

  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error(`Invalid OIDC discovery response from ${discoveryUrl}: missing endpoints`);
  }
  // OIDC Discovery 4.3: the issuer the document claims must be the one we asked.
  // Without this a redirect -- or anything that can answer for the host once --
  // can hand back a document naming a token endpoint it controls, and every
  // later check would then be measured against the attacker's own issuer.
  if (String(doc.issuer || '').replace(/\/+$/, '') !== issuer) {
    throw new Error(
      `OIDC discovery at ${discoveryUrl} declares issuer "${doc.issuer}", which is not ${issuer}.`
    );
  }

  discoveryCache = doc;
  discoveryExpiresAt = now + 60 * 60 * 1000; // Cache discovery for 1 hour
  return discoveryCache;
}

/**
 * Generate PKCE code_verifier and code_challenge (RFC 7636, S256).
 */
function generatePkce() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Create a signed, tamper-proof state token for CSRF protection and PKCE storage.
 */
function createStateToken(data = {}) {
  const payload = {
    ...data,
    t: Date.now(),
    r: crypto.randomBytes(8).toString('hex')
  };
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(jsonStr, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Verify and decode state token.
 */
function verifyStateToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadStr);
    if (!payload.t || Date.now() - payload.t > STATE_TTL_MS) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Build the full IdP authorization URL.
 */
async function buildAuthorizationUrl(req) {
  const discovery = await getDiscovery();
  const clientId = getClientId();
  if (!clientId) {
    throw new Error('OIDC_CLIENT_ID is not configured');
  }

  const { codeVerifier, codeChallenge } = generatePkce();
  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = resolveRedirectUri(req);

  const stateToken = createStateToken({
    cv: codeVerifier,
    n: nonce,
    ru: redirectUri
  });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', getScopes());
  url.searchParams.set('state', stateToken);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return url.toString();
}

/**
 * Decode JWT payload without verification (verification done by TLS + token_endpoint exchange).
 */
function parseJwtPayload(token) {
  if (!token || typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Exchange authorization code at token_endpoint and fetch user claims.
 */
async function exchangeCode({ code, stateToken, req }) {
  const stateData = verifyStateToken(stateToken);
  if (!stateData) {
    throw new Error('Invalid or expired OIDC state token. Please try logging in again.');
  }

  const discovery = await getDiscovery();
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const authMethod = getTokenEndpointAuthMethod();
  const redirectUri = stateData.ru || resolveRedirectUri(req);

  if (!clientId) {
    throw new Error('OIDC_CLIENT_ID is not configured');
  }

  if (
    ['client_secret_basic', 'client_secret_post'].includes(authMethod) &&
    !clientSecret
  ) {
    throw new Error(
      `OIDC_CLIENT_SECRET is required when using ${authMethod}`
    );
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: stateData.cv
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  };

  switch (authMethod) {
    case 'client_secret_basic':
      headers.Authorization =
        `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      break;

    case 'client_secret_post':
      params.set('client_id', clientId);
      params.set('client_secret', clientSecret);
      break;

    case 'none':
      params.set('client_id', clientId);
      break;
  }

  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: AbortSignal.timeout(15000)
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text().catch(() => '');
    throw new Error(`OIDC token exchange failed (HTTP ${tokenRes.status}): ${errorBody}`);
  }

  const tokens = await tokenRes.json();
  const idTokenClaims = tokens.id_token ? parseJwtPayload(tokens.id_token) : {};
  validateIdTokenClaims(idTokenClaims, {
    issuer: discovery.issuer,
    clientId,
    // Sealed into the state token by buildAuthorizationUrl and carried through
    // the IdP, so a token minted for some earlier login cannot be replayed here.
    nonce: stateData.n
  });

  // Fetch from userinfo endpoint if available to ensure all profile claims are present
  let userInfoClaims = {};
  if (discovery.userinfo_endpoint && tokens.access_token) {
    try {
      const userinfoRes = await fetch(discovery.userinfo_endpoint, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (userinfoRes.ok) {
        userInfoClaims = await userinfoRes.json();
      }
    } catch (err) {
      console.warn('OIDC userinfo fetch failed, falling back to ID token claims:', err.message);
    }
  }

  const mergedClaims = { ...idTokenClaims, ...userInfoClaims };
  return {
    tokens,
    claims: mergedClaims,
    extracted: extractUserIdentity(mergedClaims)
  };
}

/**
 * Extract clean username and sub claim from claims object.
 */
function extractUserIdentity(claims) {
  const sub = claims.sub ? String(claims.sub).trim() : null;
  if (!sub) {
    throw new Error('OIDC response is missing the required "sub" claim.');
  }

  const configuredClaim = getUserClaimName();
  let rawUsername = claims[configuredClaim]
    || claims.preferred_username
    || claims.nickname
    || claims.name
    || (claims.email ? String(claims.email).split('@')[0] : null)
    || sub;

  rawUsername = String(rawUsername).trim().toLowerCase();
  // Sanitize username to alphanumeric, underscore, hyphen
  let cleanUsername = rawUsername.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (cleanUsername.length < 3) {
    cleanUsername = `user-${cleanUsername || 'oidc'}-${crypto.randomBytes(3).toString('hex')}`;
  }
  if (cleanUsername.length > 32) {
    cleanUsername = cleanUsername.slice(0, 32);
  }

  return {
    sub,
    username: cleanUsername,
    email: claims.email || null,
    displayName: claims.name || claims.preferred_username || cleanUsername
  };
}

module.exports = {
  isOidcEnabled,
  getProviderName,
  isAutoProvisionEnabled,
  getDefaultRole,
  getUserClaimName,
  isUsernameLinkEnabled,
  assertIssuerTransport,
  validateIdTokenClaims,
  getTokenEndpointAuthMethod,
  getDiscovery,
  generatePkce,
  createStateToken,
  verifyStateToken,
  buildAuthorizationUrl,
  exchangeCode,
  extractUserIdentity,
  resolveRedirectUri,
  _resetDiscoveryCache: () => { discoveryCache = null; discoveryExpiresAt = 0; }
};
