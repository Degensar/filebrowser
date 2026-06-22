import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { findUser, effectiveRoots, effectiveWriteRoots, driveSections } from './users.js';
import { normRoot } from './paths.js';
import { logAction } from './audit.js';

export const filesRouter = express.Router();
filesRouter.use(requireAuth);

// ---- Permission helpers -------------------------------------------------

// The folders the current user may browse, normalized to "/a/b" form.
// This is the union of their roles' folders and their extra direct grants
// (admins always get the whole share). Computed in users.effectiveRoots().
function rootsFor(username) {
  return effectiveRoots(findUser(username));
}

// The folders the current user may edit (upload / replace / delete).
function writeRootsFor(username) {
  return effectiveWriteRoots(findUser(username));
}

const hasFullAccess = (roots) => roots.includes('/');

// Is the relative path "/a/b" inside at least one root in the list?
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

// ---- Virtual home for restricted users (Synology-style "drives") ---------

// Build one folder card entry: stat for mtime, mark whether the user may edit it.
async function driveEntry(rel, writeRoots) {
  let mtime = null;
  try {
    const s = await fsp.stat(resolveSafe(rel));
    mtime = s.mtimeMs;
  } catch {
    // Folder offline or removed — still list it so the user knows it exists.
  }
  return {
    name: path.basename(rel) || rel,
    type: 'dir',
    size: 0,
    mtime,
    path: rel,
    write: isAllowed(rel, writeRoots),
  };
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Lists the user's allowed folders grouped into 我的文件 / 部门文件夹 / 共享文件夹,
// like Synology Drive. Each section's entries carry a `write` flag so the UI can
// show a "可管理" badge (e.g. for a department head).
async function virtualHome(user) {
  const writeRoots = effectiveWriteRoots(user);
  const { personal, team, shared } = driveSections(user);
  const sections = [];

  if (personal) {
    sections.push({
      key: 'personal',
      title: '我的文件',
      icon: '🗂️',
      hint: '只有您和管理员可以看到',
      entries: [await driveEntry(personal, writeRoots)],
    });
  }
  if (team.length) {
    const entries = (await Promise.all(team.map((r) => driveEntry(r, writeRoots)))).sort(byName);
    sections.push({
      key: 'team',
      title: '部门 / 团队文件夹',
      icon: '👥',
      hint: '通过您的角色共享给团队成员',
      entries,
    });
  }
  if (shared.length) {
    const entries = (await Promise.all(shared.map((r) => driveEntry(r, writeRoots)))).sort(byName);
    sections.push({
      key: 'shared',
      title: '共享文件夹',
      icon: '🔗',
      hint: '管理员单独授予您的文件夹',
      entries,
    });
  }

  return {
    path: '/',
    drives: sections,
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

  // Restricted users at "/" get the virtual home (their allowed folders,
  // grouped into Synology-style drives).
  if (!hasFullAccess(roots) && relReq === '/') {
    try {
      return res.json(await virtualHome(findUser(req.user)));
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
      // Whether the user may upload/replace/delete inside THIS folder.
      canWrite: isAllowed(toRelative(abs), writeRootsFor(req.user)),
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

    logAction({ user: req.user, action: 'download', path: toRelative(abs), bytes: stat.size });

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

// ---- Write operations (upload / replace / delete) -----------------------

// Resolve + authorize a write target. Returns the absolute path, or sends an
// error response and returns null.
function authorizeWrite(req, res, { mustNotBeRoot = true } = {}) {
  let abs;
  try {
    abs = resolveSafe(req.query.path || '/');
  } catch (e) {
    res.status(403).json({ error: e.message });
    return null;
  }
  const rel = toRelative(abs);
  if (mustNotBeRoot && rel === '/') {
    res.status(400).json({ error: '不允许对共享根目录执行此操作。' });
    return null;
  }
  if (!isAllowed(rel, writeRootsFor(req.user))) {
    res.status(403).json({ error: '您没有编辑该位置的权限。' });
    return null;
  }
  return abs;
}

// PUT /api/file?path=/dir/name.ext  -> create or overwrite a file.
// Body is the raw file bytes (streamed). Used for both upload and replace.
filesRouter.put('/file', async (req, res) => {
  const abs = authorizeWrite(req, res);
  if (!abs) return;
  try {
    // Parent folder must already exist and be a directory.
    const parent = path.dirname(abs);
    const pstat = await fsp.stat(parent).catch(() => null);
    if (!pstat || !pstat.isDirectory()) {
      return res.status(400).json({ error: '目标文件夹不存在。' });
    }
    // Refuse to overwrite a directory with a file.
    const existing = await fsp.stat(abs).catch(() => null);
    if (existing && existing.isDirectory()) {
      return res.status(400).json({ error: '同名文件夹已存在，无法作为文件覆盖。' });
    }

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(abs);
      out.on('error', reject);
      out.on('finish', resolve);
      req.on('error', reject);
      req.pipe(out);
    });
    const written = await fsp.stat(abs).catch(() => null);
    logAction({
      user: req.user,
      action: existing ? 'replace' : 'upload',
      path: toRelative(abs),
      bytes: written ? written.size : 0,
    });
    res.json({ ok: true, path: toRelative(abs), replaced: !!existing });
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES')
      return res.status(403).json({ error: '没有写入该位置的权限（请检查共享目录的写权限）。' });
    console.error('[files] upload error:', e);
    res.status(500).json({ error: '保存文件失败。' });
  }
});

// DELETE /api/file?path=/dir/name.ext  -> delete a file or folder.
filesRouter.delete('/file', async (req, res) => {
  const abs = authorizeWrite(req, res);
  if (!abs) return;
  try {
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      await fsp.rm(abs, { recursive: true, force: true });
    } else {
      await fsp.unlink(abs);
    }
    logAction({
      user: req.user,
      action: 'delete',
      path: toRelative(abs),
      bytes: stat.isFile() ? stat.size : 0,
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: '未找到要删除的文件或文件夹。' });
    if (e.code === 'EPERM' || e.code === 'EACCES')
      return res.status(403).json({ error: '没有删除该项目的权限。' });
    console.error('[files] delete error:', e);
    res.status(500).json({ error: '删除失败。' });
  }
});

// POST /api/folder?path=/dir/newfolder  -> create a folder.
filesRouter.post('/folder', async (req, res) => {
  const abs = authorizeWrite(req, res);
  if (!abs) return;
  try {
    await fsp.mkdir(abs, { recursive: false });
    logAction({ user: req.user, action: 'mkdir', path: toRelative(abs), bytes: 0 });
    res.json({ ok: true, path: toRelative(abs) });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(400).json({ error: '该文件夹已存在。' });
    if (e.code === 'ENOENT') return res.status(400).json({ error: '上级文件夹不存在。' });
    if (e.code === 'EPERM' || e.code === 'EACCES')
      return res.status(403).json({ error: '没有在此处创建文件夹的权限。' });
    console.error('[files] mkdir error:', e);
    res.status(500).json({ error: '创建文件夹失败。' });
  }
});
