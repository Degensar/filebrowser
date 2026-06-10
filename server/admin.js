// Admin-only API for managing users, roles, and folder permissions.
import express from 'express';
import { requireAuth, requireAdmin } from './auth.js';
import {
  listUsers,
  publicUser,
  addUser,
  removeUser,
  setPassword,
  setAdmin,
  setUserRoles,
  setExtraFolders,
  findUser,
  removeRoleFromAllUsers,
} from './users.js';
import { listRoles, addRole, updateRole, removeRole, findRole } from './roles.js';

export const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);

// ---------------- Users ----------------

adminRouter.get('/users', (req, res) => {
  res.json({ users: listUsers().map(publicUser) });
});

adminRouter.post('/users', (req, res) => {
  const { username, password, admin, roleNames, extraFolders } = req.body || {};
  try {
    const created = addUser(username, password, {
      admin: !!admin,
      roleNames: Array.isArray(roleNames) ? roleNames : [],
      extraFolders: Array.isArray(extraFolders) ? extraFolders : [],
    });
    res.json({ ok: true, user: publicUser(findUser(created)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

adminRouter.delete('/users/:username', (req, res) => {
  const target = req.params.username.toLowerCase();
  if (target === req.user) {
    return res.status(400).json({ error: '无法删除当前登录的管理员账号。' });
  }
  try {
    removeUser(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

adminRouter.post('/users/:username/password', (req, res) => {
  try {
    setPassword(req.params.username, (req.body || {}).password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Combined update of a user's access: admin flag, roles, and extra folders.
adminRouter.put('/users/:username', (req, res) => {
  const target = req.params.username.toLowerCase();
  const { admin, roleNames, extraFolders } = req.body || {};
  try {
    if (admin !== undefined) {
      if (target === req.user && admin === false) {
        return res.status(400).json({ error: '无法取消自己的管理员权限。' });
      }
      setAdmin(target, admin);
    }
    if (roleNames !== undefined) setUserRoles(target, roleNames);
    if (extraFolders !== undefined) setExtraFolders(target, extraFolders);
    res.json({ ok: true, user: publicUser(findUser(target)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- Roles ----------------

adminRouter.get('/roles', (req, res) => {
  res.json({ roles: listRoles() });
});

adminRouter.post('/roles', (req, res) => {
  const { name, folders, canEdit } = req.body || {};
  try {
    const created = addRole(name, Array.isArray(folders) ? folders : [], !!canEdit);
    res.json({ ok: true, role: findRole(created) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update a role's folders and/or its edit capability.
adminRouter.put('/roles/:name', (req, res) => {
  const { folders, canEdit } = req.body || {};
  try {
    const role = updateRole(req.params.name, { folders, canEdit });
    res.json({ ok: true, role });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

adminRouter.delete('/roles/:name', (req, res) => {
  try {
    removeRole(req.params.name);
    removeRoleFromAllUsers(req.params.name); // unassign from every user
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
