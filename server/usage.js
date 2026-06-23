// Computes storage usage (bytes on disk) per role and per user by walking the
// folders each one is granted. Used by the admin "storage usage" report.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listRoles } from './roles.js';
import { listUsers } from './users.js';

// Recursive size of a directory in bytes. Skips symlinks (avoids loops, and
// prevents escaping the share via a symlink) and silently ignores entries it
// can't read.
export async function dirSize(abs) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return 0; // unreadable / missing folder
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const child = path.join(abs, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(child);
      else if (e.isFile()) total += (await fsp.stat(child)).size;
    } catch {
      /* skip unreadable entry */
    }
  }
  return total;
}

// "/Sales" -> <shareRoot>/Sales ; "/" -> <shareRoot>
function absOf(rel) {
  return path.join(config.shareRoot, String(rel || '').replace(/^\/+/, ''));
}

// Compute usage for every role and user. Sizes of identical folders are computed
// once and reused within a single call.
export async function computeUsage() {
  const cache = new Map(); // rel path -> Promise<bytes>
  const sizeOf = (rel) => {
    if (!cache.has(rel)) cache.set(rel, dirSize(absOf(rel)));
    return cache.get(rel);
  };

  const roles = [];
  for (const r of listRoles()) {
    let bytes = 0;
    for (const f of r.folders) bytes += await sizeOf(f);
    roles.push({ name: r.name, folders: r.folders, bytes });
  }
  roles.sort((a, b) => b.bytes - a.bytes);

  const users = [];
  for (const u of listUsers()) {
    const folders = (u.extraFolders || []).map((f) => f.path);
    let bytes = 0;
    for (const f of folders) bytes += await sizeOf(f);
    users.push({ username: u.username, admin: !!u.admin, folders, bytes });
  }
  users.sort((a, b) => b.bytes - a.bytes);

  return { roles, users, generatedAt: new Date().toISOString() };
}
