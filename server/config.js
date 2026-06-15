import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

function required(name, value) {
  if (!value || value.trim() === '') {
    console.error(`\n[配置] 缺少必填项：${name}`);
    console.error('  请将 .env.example 复制为 .env 并填写相关配置。\n');
    process.exit(1);
  }
  return value;
}

const SHARE_ROOT = required('SHARE_ROOT', process.env.SHARE_ROOT);

// Resolve to an absolute, normalized path so we can safely contain users inside it.
// UNC paths (\\server\share) are preserved by path.resolve on Windows.
const shareRoot = path.resolve(SHARE_ROOT);

if (!fs.existsSync(shareRoot)) {
  console.warn(
    `\n[配置] 警告：当前无法访问共享目录 SHARE_ROOT：\n  ${shareRoot}\n` +
      '  应用仍会启动，但在共享目录挂载/上线之前将无法浏览文件。\n'
  );
}

// HTTPS is on by default. Set TLS_DISABLE=true only when something else
// terminates TLS in front of the app (e.g. IIS/Nginx reverse proxy).
const tlsDisabled = String(process.env.TLS_DISABLE).toLowerCase() === 'true';

export const config = {
  port: Number(process.env.PORT) || 3000,
  shareRoot,
  jwtSecret: required('JWT_SECRET', process.env.JWT_SECRET),
  sessionHours: Number(process.env.SESSION_HOURS) || 12,

  // --- TLS / HTTPS ---
  https: !tlsDisabled,
  // Optional explicit certificate (recommended in production with a real CA cert).
  tlsCertFile: process.env.TLS_CERT_FILE || '',
  tlsKeyFile: process.env.TLS_KEY_FILE || '',
  // Extra hostnames / IPs to include in the auto self-signed cert, so clients
  // reaching the server by LAN IP or hostname don't get a name-mismatch warning.
  // Comma- or space-separated, e.g. TLS_HOSTS=files.corp.local,192.168.1.50
  tlsHosts: (process.env.TLS_HOSTS || '')
    .split(/[,\s]+/)
    .map((h) => h.trim())
    .filter(Boolean),
  // Optional: run a tiny HTTP listener on this port that 301-redirects to HTTPS.
  httpRedirectPort: Number(process.env.HTTP_REDIRECT_PORT) || 0,

  // Cookies are marked Secure whenever we serve HTTPS.
  secureCookies: !tlsDisabled,
};
