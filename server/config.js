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

export const config = {
  port: Number(process.env.PORT) || 3000,
  shareRoot,
  jwtSecret: required('JWT_SECRET', process.env.JWT_SECRET),
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  secureCookies: String(process.env.SECURE_COOKIES).toLowerCase() === 'true',
};
