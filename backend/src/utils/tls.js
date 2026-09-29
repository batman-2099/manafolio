// Optional HTTPS listener.
//
// Browsers only hand out the camera (getUserMedia) in a secure context, so an
// install reached over the LAN at http://<host>:3001 — the normal Docker setup —
// can never scan cards, and shows no permission prompt to accept because the
// browser never asks (issue #27). Set HTTPS_PORT and the same app is also served
// over TLS, which makes the scanner work from phones without a reverse proxy.
//
// SSL_CERT_PATH + SSL_KEY_PATH use a real certificate. With neither set, a
// self-signed one is generated beside the database on first start and reused on
// every later boot, so the certificate the phone trusted stays valid.
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { X509Certificate } = require('crypto');

// Safari refuses server certificates with a lifetime over 398 days, so stay
// under it and regenerate on expiry instead of minting one long-lived cert.
const CERT_DAYS = 397;

// SANs so one certificate covers however the box is reached: localhost plus
// every non-internal address the host currently has. A LAN IP that changes later
// only costs the user the same click-through warning they already get.
function altNames() {
  const names = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }];
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (!iface.internal) names.push({ type: 7, ip: iface.address });
  }
  return names;
}

function expired(pem) {
  try {
    return new Date(new X509Certificate(pem).validTo) <= new Date();
  } catch {
    return true; // unparseable cert is as good as no cert
  }
}

// { key, cert, selfSigned } — reads the configured pair, else the generated one,
// else generates it.
async function loadOrCreateCert(dir) {
  const provided = Boolean(process.env.SSL_CERT_PATH || process.env.SSL_KEY_PATH);
  const keyPath = process.env.SSL_KEY_PATH || path.join(dir, 'key.pem');
  const certPath = process.env.SSL_CERT_PATH || path.join(dir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const cert = fs.readFileSync(certPath, 'utf8');
    // A provided certificate is the operator's to renew — never overwrite it.
    if (provided || !expired(cert)) {
      return { key: fs.readFileSync(keyPath, 'utf8'), cert, selfSigned: !provided };
    }
    console.log('Self-signed TLS certificate expired — generating a new one.');
  } else if (provided) {
    throw new Error(`SSL_CERT_PATH/SSL_KEY_PATH set but unreadable: ${certPath}, ${keyPath}`);
  }

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + CERT_DAYS * 86400000);
  const pems = await require('selfsigned').generate([{ name: 'commonName', value: 'manafolio' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: altNames() },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert);
  console.log(`Generated self-signed TLS certificate: ${certPath}`);
  return { key: pems.private, cert: pems.cert, selfSigned: true };
}

// Starts the TLS listener when HTTPS_PORT is set. A failure here must not take
// the HTTP server down with it — the app still works, just without scanning.
async function startHttps(app, dir) {
  const port = Number(process.env.HTTPS_PORT);
  if (!port) return null;
  try {
    const { key, cert, selfSigned } = await loadOrCreateCert(dir);
    const server = https.createServer({ key, cert }, app).listen(port, '0.0.0.0', () => {
      console.log(`HTTPS on port ${port}${selfSigned ? ' (self-signed — expect a one-time browser warning)' : ''}`);
      console.log(`Card scanning from phones needs this https:// address, not http://`);
    });
    return server;
  } catch (err) {
    console.error(`HTTPS listener failed to start: ${err.message}`);
    return null;
  }
}

// True while we are the ones terminating TLS with an untrusted certificate.
// HSTS then has to stay off: it pins the host to HTTPS, which makes the
// self-signed warning unbypassable in Chrome and locks the user out of the
// plain-HTTP port too. TRUST_PROXY means a reverse proxy is the real front door,
// so its HSTS policy wins and the header stays on.
const selfSignedTls = () => (
  Boolean(process.env.HTTPS_PORT) && !process.env.SSL_CERT_PATH && !process.env.TRUST_PROXY
);

module.exports = { startHttps, loadOrCreateCert, selfSignedTls };
