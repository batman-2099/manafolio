// Self-signed TLS certificate: generated once, reused after, replaced on expiry.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { X509Certificate } = require('crypto');

const { loadOrCreateCert } = require('../src/utils/tls');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-tls-'));

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

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('tls.test.js OK');
})();
