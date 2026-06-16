// Append-only audit log of write actions (upload / replace / delete / mkdir),
// stored as JSON Lines in data/audit.log. Used for the admin "activity" report.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

// Actions that count as "modifications" (writes). Downloads are tracked too, but
// separately, since they don't change anything.
const MOD_ACTIONS = ['upload', 'replace', 'delete', 'mkdir'];

// Record one action. Fire-and-forget — never block or fail the request.
export function logAction({ user, action, path: target, bytes = 0 }) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), user, action, path: target, bytes }) + '\n';
    fs.appendFile(AUDIT_FILE, line, () => {});
  } catch {
    /* logging must never break the actual operation */
  }
}

// Aggregate activity per user since `sinceMs` (0 = all time).
export async function queryActivity(sinceMs = 0) {
  let text = '';
  try {
    text = await fsp.readFile(AUDIT_FILE, 'utf8');
  } catch {
    return { perUser: [], totalEvents: 0 };
  }
  const perUser = new Map();
  let totalEvents = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
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
  // Sort by overall activity (modifications + downloads).
  const list = [...perUser.values()].sort((a, b) => b.total + b.download - (a.total + a.download));
  return { perUser: list, totalEvents };
}

// Return individual audit entries (newest first), optionally filtered by time
// window, user, and action. `limit` caps how many entries are returned; `matched`
// is the total number that matched (so the UI can show if results were truncated).
export async function queryEntries({ sinceMs = 0, user = '', action = '', limit = 500 } = {}) {
  let text = '';
  try {
    text = await fsp.readFile(AUDIT_FILE, 'utf8');
  } catch {
    return { entries: [], matched: 0, truncated: false };
  }
  const lines = text.split('\n');
  const entries = [];
  let matched = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (sinceMs && new Date(e.ts).getTime() < sinceMs) continue;
    if (user && e.user !== user) continue;
    if (action && e.action !== action) continue;
    matched++;
    if (entries.length < limit) entries.push(e); // newest-first (iterating backward)
  }
  return { entries, matched, truncated: matched > entries.length };
}
