import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authRouter } from './auth.js';
import { filesRouter } from './files.js';
import { adminRouter } from './admin.js';
import { listUsers } from './users.js';
import { loadOrCreateCert } from './tls.js';
import { provisionStartup } from './provision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(cookieParser());

// API routes
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', filesRouter);

// Static frontend
app.use(express.static(PUBLIC_DIR));

// Fallback to index.html for the single-page app
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function banner(scheme, certNote) {
  const userCount = listUsers().length;
  console.log(`\n  公司文件浏览器已启动`);
  console.log(`  → ${scheme}://localhost:${config.port}`);
  if (certNote) console.log(`  → TLS 证书：${certNote}`);
  console.log(`  → 共享目录：${config.shareRoot}`);
  if (userCount === 0) {
    console.log(
      `\n  ℹ  尚无用户。打开网页点击“注册”，第一个注册的账号将自动成为管理员。\n` +
        `     （也可用命令创建管理员：npm run user add-admin <用户名>）\n`
    );
  } else {
    console.log(`  → 已注册用户数：${userCount}\n`);
  }
}

async function start() {
  // Ensure the hardcoded "員工" role and its shared folder exist.
  await provisionStartup();

  if (config.https) {
    let creds;
    try {
      creds = loadOrCreateCert();
    } catch (e) {
      console.error('\n[TLS] 加载/生成证书失败：', e.message);
      console.error('  可在 .env 中通过 TLS_CERT_FILE / TLS_KEY_FILE 指定证书，或设置 TLS_DISABLE=true 回退到 HTTP。\n');
      process.exit(1);
    }
    https.createServer({ key: creds.key, cert: creds.cert }, app).listen(config.port, () =>
      banner('https', creds.source)
    );

    // Optional: redirect plain HTTP to HTTPS.
    if (config.httpRedirectPort) {
      http
        .createServer((req, res) => {
          const host = (req.headers.host || `localhost:${config.port}`).replace(/:\d+$/, '');
          res.writeHead(301, { Location: `https://${host}:${config.port}${req.url}` });
          res.end();
        })
        .listen(config.httpRedirectPort, () =>
          console.log(`  → HTTP ${config.httpRedirectPort} 端口将自动跳转到 HTTPS`)
        );
    }
  } else {
    http.createServer(app).listen(config.port, () => banner('http'));
  }
}

start();
