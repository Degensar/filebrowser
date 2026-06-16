// Append-only audit log of write actions (upload / replace / delete / mkdir) and
// downloads, stored as JSON Lines in data/audit.log. Rotated by size:
// when it passes config.auditMaxBytes it becomes audit.log.1, .2, … (keeping
// config.auditMaxFiles archives). Reports read across the current + rotated files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

const MAX_BYTES = config.auditMaxBytes; // 0 = no cap
const MAX_FILES = config.auditMaxFiles;

// Actions that count as "modifications" (writes). Downloads are tracked too, but
// separately, since they don't change anything.
const MOD_ACTIONS = ['upload', 'replace', 'delete', 'mkdir'];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory size of the current log file, so we don't stat() on every write.
let currentSize = 0;
try {
  currentSize = fs.statSync(AUDIT_FILE).size;
} catch {
  currentSize = 0;
}
let rotating = false;

// Rotate audit.log -> audit.log.1, shifting older archives and dropping the oldest.
function rotate() {
  if (rotating) return;
  rotating = true;
  try {
    if (MAX_FILES <= 0) {
      fs.writeFileSync(AUDIT_FILE, ''); // keep no history, just clear
    } else {
      const oldest = `${AUDIT_FILE}.${MAX_FILES}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
      for (let i = MAX_FILES - 1; i >= 1; i--) {
        const src = `${AUDIT_FILE}.${i}`;
        if (fs.existsSync(src)) fs.renameSync(src, `${AUDIT_FILE}.${i + 1}`);
      }
      if (fs.existsSync(AUDIT_FILE)) fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
    }
    currentSize = 0;
  } catch (e) {
    console.warn('[audit] 日志轮转失败：', e.message);
  } finally {
    rotating = false;
  }
}

// Record one action. Fire-and-forget — never block or fail the request.
export function logAction({ user, action, path: target, bytes = 0 }) {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), user, action, path: target, bytes }) + '\n';
    currentSize += Buffer.byteLength(line);
    fs.appendFile(AUDIT_FILE, line, () => {});
    if (MAX_BYTES > 0 && currentSize > MAX_BYTES) rotate();
  } catch {
    /* logging must never break the actual operation */
  }
}

// Log files in chronological order (oldest archive first, current file last).
function logFilesChrono() {
  const files = [];
  for (let i = MAX_FILES; i >= 1; i--) {
    const p = `${AUDIT_FILE}.${i}`;
    if (fs.existsSync(p)) files.push(p);
  }
  if (fs.existsSync(AUDIT_FILE)) files.push(AUDIT_FILE);
  return files;
}

// All log lines across current + rotated files, oldest first.
async function readAllLines() {
  const out = [];
  for (const f of logFilesChrono()) {
    let text = '';
    try {
      text = await fsp.readFile(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) if (line.trim()) out.push(line);
  }
  return out;
}

// Aggregate activity per user since `sinceMs` (0 = all time).
export async function queryActivity(sinceMs = 0) {
  const lines = await readAllLines();
  const perUser = new Map();
  let totalEvents = 0;
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (sinceMs && new Date(e.ts).getTime() < sinceMs) continue;
    totalEvents++;
    if (!perUser.has(e.user)) {
      perUser.set(e.user, {
        username: e.user,
        total: 0, // modification total (uploads+replaces+deletes+mkdirs)
        bytes: 0, // uploaded bytes
        upload: 0, replace: 0, delete: 0, mkdir: 0,
        download: 0, downloadBytes: 0,
        lastAt: null,
      });
    }
    const u = perUser.get(e.user);
    if (MOD_ACTIONS.includes(e.action)) {
      u.total++;
      u[e.action]++;
      if (e.action === 'upload' || e.action === 'replace') u.bytes += e.bytes || 0;
    } else if (e.action === 'download') {
      u.download++;
      u.downloadBytes += e.bytes || 0;
    }
    if (!u.lastAt || e.ts > u.lastAt) u.lastAt = e.ts;
  }
  const list = [...perUser.values()].sort((a, b) => b.total + b.download - (a.total + a.download));
  return { perUser: list, totalEvents };
}

// Return individual audit entries (newest first), optionally filtered by time
// window, user, and action. `limit` caps how many entries are returned; `matched`
// is the total number that matched (so the UI can show if results were truncated).
export async function queryEntries({ sinceMs = 0, user = '', action = '', limit = 500 } = {}) {
  const lines = await readAllLines(); // oldest first
  const entries = [];
  let matched = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (sinceMs && new Date(e.ts).getTime() < sinceMs) continue;
    if (user && e.user !== user) continue;
    if (action && e.action !== action) continue;
    matched++;
    if (entries.length < limit) entries.push(e); // newest-first
  }
  return { entries, matched, truncated: matched > entries.length };
}
