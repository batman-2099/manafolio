// Self-signed TLS certificate: generated once, reused after, replaced on expiry.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { X509Certificate } = require('crypto');

const { loadOrCreateCert, startHttps } = require('../src/utils/tls');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-tls-'));
  const savedEnv = Object.fromEntries(['HTTPS_PORT', 'SSL_CERT_PATH', 'SSL_KEY_PATH'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  let httpServer;
  let httpsServer;
  const originalError = console.error;
  try {

  const first = await loadOrCreateCert(dir);
  assert.ok(first.selfSigned, 'generated cert is self-signed');
  assert.ok(first.key.includes('PRIVATE KEY'), 'key is PEM');
  const x509 = new X509Certificate(first.cert);
  // localhost + 127.0.0.1 must be covered, else the host itself gets a name
  // mismatch on top of the untrusted-issuer warning.
  assert.match(x509.subjectAltName, /DNS:localhost/);
  assert.match(x509.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.ok(new Date(x509.validTo) > new Date(), 'cert is valid now');

  // Reused, not regenerated: a phone that trusted the cert keeps working.
  const second = await loadOrCreateCert(dir);
  assert.strictEqual(second.cert, first.cert, 'existing cert reused');

  // Expired cert gets replaced instead of served.
  const past = new Date(Date.now() - 2 * 86400000);
  const stale = await require('selfsigned').generate(null, {
    notBeforeDate: past,
    notAfterDate: new Date(Date.now() - 86400000),
  });
  const expiredPem = stale.cert;
  fs.writeFileSync(path.join(dir, 'cert.pem'), expiredPem);
  const third = await loadOrCreateCert(dir);
  assert.notStrictEqual(third.cert, expiredPem, 'expired cert replaced');
  assert.ok(new Date(new X509Certificate(third.cert).validTo) > new Date(), 'replacement is valid');

  // A configured cert path that does not exist is an operator error, not a
  // reason to silently mint a self-signed cert they did not ask for.
  process.env.SSL_CERT_PATH = path.join(dir, 'nope.pem');
  process.env.SSL_KEY_PATH = path.join(dir, 'nope.key');
  await assert.rejects(() => loadOrCreateCert(dir), /unreadable/);
  delete process.env.SSL_CERT_PATH;
  delete process.env.SSL_KEY_PATH;

  assert.strictEqual(await startHttps(() => {}, dir), null, 'HTTPS is optional when no port is set');
  httpServer = http.createServer((req, res) => res.end('HTTP still works'));
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  process.env.HTTPS_PORT = String(port);
  const errors = [];
  console.error = message => errors.push(message);
  assert.strictEqual(await startHttps(() => {}, dir), null, 'occupied HTTPS port is a handled startup failure');
  assert(errors.some(message => message.includes('HTTPS listener failed to start:') && message.includes('EADDRINUSE')));
  assert.strictEqual(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'HTTP still works', 'optional HTTPS failure must not kill HTTP');
  httpServer.closeAllConnections();
  await new Promise(resolve => httpServer.close(resolve));

  httpsServer = await startHttps((req, res) => res.end('HTTPS works'), dir);
  assert(httpsServer?.listening, 'successful startup resolves only after listening');
  const body = await new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port, rejectUnauthorized: false, agent: false }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve(text));
      res.on('error', reject);
    }).on('error', reject);
  });
  assert.strictEqual(body, 'HTTPS works');
  console.log('tls.test.js OK');
  } finally {
    console.error = originalError;
    for (const server of [httpsServer, httpServer]) {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
