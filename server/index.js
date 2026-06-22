import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authRouter } from './auth.js';
import { filesRouter } from './files.js';
import { adminRouter } from './admin.js';
import { listUsers } from './users.js';
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

async function start() {
  // Ensure the hardcoded "員工" role and its shared folder exist.
  await provisionStartup();

  app.listen(config.port, () => {
    const userCount = listUsers().length;
    console.log(`\n  公司文件浏览器已启动`);
    console.log(`  → http://localhost:${config.port}`);
    console.log(`  → 共享目录：${config.shareRoot}`);
    if (userCount === 0) {
      console.log(
        `\n  ℹ  尚无用户。打开网页点击“注册”，第一个注册的账号将自动成为管理员。\n` +
          `     （也可用命令创建管理员：npm run user add-admin <用户名>）\n`
      );
    } else {
      console.log(`  → 已注册用户数：${userCount}\n`);
    }
  });
}

start();
