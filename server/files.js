import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { findUser, effectiveRoots } from './users.js';
import { normRoot } from './paths.js';

export const filesRouter = express.Router();
filesRouter.use(requireAuth);

// ---- Permission helpers -------------------------------------------------

// The folders the current user may browse, normalized to "/a/b" form.
// This is the union of their roles' folders and their extra direct grants
// (admins always get the whole share). Computed in users.effectiveRoots().
function rootsFor(username) {
  return effectiveRoots(findUser(username));
}

const hasFullAccess = (roots) => roots.includes('/');

// Is the relative path "/a/b" inside at least one allowed root?
function isAllowed(relPath, roots) {
  if (hasFullAccess(roots)) return true;
  const p = normRoot(relPath);
  return roots.some((r) => p === r || p.startsWith(r + '/'));
}

// ---- Path resolution (containment guard) --------------------------------

// Resolve a user-supplied relative path against the share root and guarantee
// the result stays INSIDE the root. Returns the absolute path or throws.
function resolveSafe(relPath) {
  const rel = (relPath || '').replace(/\\/g, '/');
  const cleaned = rel.replace(/^\/+/, '');
  const abs = path.resolve(config.shareRoot, cleaned);
  const rootWithSep = config.shareRoot.endsWith(path.sep)
    ? config.shareRoot
    : config.shareRoot + path.sep;
  if (abs !== config.shareRoot && !abs.startsWith(rootWithSep)) {
    const err = new Error('路径超出了允许访问的共享范围。');
    err.code = 'EACCESS_OUTSIDE_ROOT';
    throw err;
  }
  return abs;
}

// Turn an absolute path back into the "/relative" form shown to the client.
function toRelative(abs) {
  const rel = path.relative(config.shareRoot, abs).replace(/\\/g, '/');
  return rel ? '/' + rel : '/';
}

// ---- Breadcrumb (computed server-side so parents are never exposed) ------

function buildBreadcrumb(relPath, roots) {
  const crumbs = [{ label: '主目录', path: '/', home: true }];
  if (hasFullAccess(roots)) {
    let acc = '';
    for (const part of relPath.split('/').filter(Boolean)) {
      acc += '/' + part;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  // Restricted: never show segments above the user's allowed root.
  const r = roots.find((x) => relPath === x || relPath.startsWith(x + '/'));
  if (r) {
    crumbs.push({ label: path.basename(r), path: r });
    let acc = r;
    for (const part of relPath.slice(r.length).split('/').filter(Boolean)) {
      acc += '/' + part;
      crumbs.push({ label: part, path: acc });
    }
  }
  return crumbs;
}

// ---- Virtual home for restricted users ----------------------------------

// Lists the user's allowed folders as top-level entries.
async function virtualHome(roots) {
  const entries = await Promise.all(
    roots.map(async (r) => {
      let mtime = null;
      try {
        const s = await fsp.stat(resolveSafe(r));
        mtime = s.mtimeMs;
      } catch {
        // Folder offline or removed — still list it so the user knows it exists.
      }
      return { name: path.basename(r) || r, type: 'dir', size: 0, mtime, path: r };
    })
  );
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return {
    path: '/',
    entries,
    breadcrumb: [{ label: '主目录', path: '/', home: true }],
  };
}

// ---- Routes -------------------------------------------------------------

// GET /api/files?path=/sub/folder  -> directory listing + breadcrumb
filesRouter.get('/files', async (req, res) => {
  const roots = rootsFor(req.user);

  // Canonicalize FIRST (resolves any "../") and keep inside the share root,
  // then check permissions against the resolved path. Doing the permission
  // check on the raw string would let "/Sales/../HR" slip through.
  let abs;
  try {
    abs = resolveSafe(req.query.path || '/');
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }
  const relReq = toRelative(abs);

  // Restricted users at "/" get the virtual home (their allowed folders).
  if (!hasFullAccess(roots) && relReq === '/') {
    try {
      return res.json(await virtualHome(roots));
    } catch (e) {
      console.error('[files] virtual home error:', e);
      return res.status(500).json({ error: '无法加载可访问的文件夹。' });
    }
  }

  if (!isAllowed(relReq, roots)) {
    return res.status(403).json({ error: '您没有访问该文件夹的权限。' });
  }

  try {
    const stat = await fsp.stat(abs);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '该路径不是文件夹。' });
    }
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d) => {
        const childAbs = path.join(abs, d.name);
        let size = 0;
        let mtime = null;
        try {
          const s = await fsp.stat(childAbs);
          size = s.size;
          mtime = s.mtimeMs;
        } catch {
          // Unreadable entry (permissions / broken link) — list with no stats.
        }
        return {
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
          path: toRelative(childAbs),
        };
      })
    );
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    res.json({
      path: toRelative(abs),
      entries,
      breadcrumb: buildBreadcrumb(toRelative(abs), roots),
    });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: '未找到该文件夹。' });
    if (e.code === 'EPERM' || e.code === 'EACCES')
      return res.status(403).json({ error: '没有读取该文件夹的权限。' });
    console.error('[files] list error:', e);
    res.status(500).json({ error: '无法读取该文件夹。' });
  }
});

// GET /api/download?path=/sub/file.pdf  -> streams the file as an attachment
filesRouter.get('/download', async (req, res) => {
  const roots = rootsFor(req.user);

  // Canonicalize before the permission check (see note in /files).
  let abs;
  try {
    abs = resolveSafe(req.query.path || '/');
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  if (!isAllowed(toRelative(abs), roots)) {
    return res.status(403).json({ error: '您没有下载该文件的权限。' });
  }

  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) return res.status(400).json({ error: '该路径不是文件。' });

    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`
    );

    const stream = fs.createReadStream(abs);
    stream.on('error', (err) => {
      console.error('[files] download stream error:', err);
      if (!res.headersSent) res.status(500).end('下载失败。');
      else res.destroy();
    });
    stream.pipe(res);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: '未找到该文件。' });
    if (e.code === 'EPERM' || e.code === 'EACCES')
      return res.status(403).json({ error: '没有读取该文件的权限。' });
    console.error('[files] download error:', e);
    res.status(500).json({ error: '无法下载该文件。' });
  }
});
