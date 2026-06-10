// Provides the TLS key/cert for the HTTPS server.
// Priority:
//   1. Explicit files from .env (TLS_CERT_FILE / TLS_KEY_FILE) — use for a real CA cert.
//   2. A previously generated self-signed cert in data/tls/.
//   3. Otherwise generate a self-signed cert and save it (stable across restarts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TLS_DIR = path.join(__dirname, '..', 'data', 'tls');
const CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const KEY_PATH = path.join(TLS_DIR, 'key.pem');

export function loadOrCreateCert() {
  // 1. Explicit cert files.
  if (config.tlsCertFile && config.tlsKeyFile) {
    return {
      cert: fs.readFileSync(config.tlsCertFile),
      key: fs.readFileSync(config.tlsKeyFile),
      source: 'configured',
    };
  }

  // 2. Reuse a previously generated self-signed cert.
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH), source: 'self-signed (cached)' };
  }

  // 3. Generate a new self-signed cert valid for localhost + 127.0.0.1.
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  fs.mkdirSync(TLS_DIR, { recursive: true });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH, pems.private);
  return { cert: pems.cert, key: pems.private, source: 'self-signed (generated)' };
}
