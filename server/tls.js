// Provides the TLS key/cert for the HTTPS server.
// Priority:
//   1. Explicit files from .env (TLS_CERT_FILE / TLS_KEY_FILE) — use for a real CA cert.
//   2. A previously generated self-signed cert in data/tls/ that already covers the
//      configured hostnames/IPs.
//   3. Otherwise generate a self-signed cert (covering localhost + 127.0.0.1 + any
//      TLS_HOSTS) and save it, so it's stable across restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TLS_DIR = path.join(__dirname, '..', 'data', 'tls');
const CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const KEY_PATH = path.join(TLS_DIR, 'key.pem');
const HOSTS_PATH = path.join(TLS_DIR, 'hosts.json'); // records which names the cached cert covers

const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

// The full set of names the self-signed cert should cover.
function desiredHosts() {
  return [...new Set(['localhost', '127.0.0.1', ...config.tlsHosts])];
}

export function loadOrCreateCert() {
  // 1. Explicit cert files.
  if (config.tlsCertFile && config.tlsKeyFile) {
    return {
      cert: fs.readFileSync(config.tlsCertFile),
      key: fs.readFileSync(config.tlsKeyFile),
      source: 'configured',
    };
  }

  const hosts = desiredHosts();

  // 2. Reuse a cached self-signed cert only if it covers the same host set.
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH) && fs.existsSync(HOSTS_PATH)) {
    let cached = [];
    try {
      cached = JSON.parse(fs.readFileSync(HOSTS_PATH, 'utf8'));
    } catch {
      /* fall through to regenerate */
    }
    if (cached.length === hosts.length && hosts.every((h) => cached.includes(h))) {
      return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH), source: 'self-signed (cached)' };
    }
  }

  // 3. Generate a new self-signed cert covering all desired hosts.
  const altNames = hosts.map((h) => (isIPv4(h) ? { type: 7, ip: h } : { type: 2, value: h }));
  const pems = selfsigned.generate([{ name: 'commonName', value: hosts[0] }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(TLS_DIR, { recursive: true });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(HOSTS_PATH, JSON.stringify(hosts));
  return { cert: pems.cert, key: pems.private, source: `self-signed (generated for ${hosts.join(', ')})` };
}
