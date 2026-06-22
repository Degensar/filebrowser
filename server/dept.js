// Delegated department management for DEPARTMENT HEADS (部门主管), so a head can
// grant/revoke access for users *within the departments they lead* — without
// being a full administrator.
//
// Strict scoping (security): a non-admin caller may only act on roles where they
// appear in `role.leaders`, and only to (a) add/remove ordinary members and
// (b) toggle a member's edit rights within that department. Heads can NEVER:
//   - touch the admin flag, or modify any admin account,
//   - grant leadership (role.leaders) — that stays admin-only,
//   - grant folders outside their department, or act on other roles.
// A head's reach is therefore bounded by their own department's folders.
import express from 'express';
import { requireAuth } from './auth.js';
import { findUser, listUsers, isAdmin, setUserRoles } from './users.js';
import { findRole, listRoles, updateRole } from './roles.js';
import { provisionUser } from './provision.js';

export const deptRouter = express.Router();
deptRouter.use(requireAuth);

// Resolve the target role and assert the caller may manage it. Sends an error
// response and returns null on failure.
function authorizeHead(req, res) {
  const acting = findUser(req.user);
  const role = findRole(req.params.role);
  if (!role) {
    res.status(404).json({ error: '未找到该部门。' });
    return null;
  }
  if (!isAdmin(acting) && !(role.leaders || []).includes(acting.username)) {
    res.status(403).json({ error: '您不是该部门的主管，无法管理其成员。' });
    return null;
  }
  return role;
}

// A member row as seen by a head: username + their status within this department.
function memberRow(role, user) {
  return {
    username: user.username,
    isEditor: (role.editors || []).includes(user.username),
    isLeader: (role.leaders || []).includes(user.username),
  };
}

// GET /api/dept/mine -> the departments the caller heads, with members and the
// pool of users they may add. (Empty for admins — they use the admin panel.)
deptRouter.get('/mine', (req, res) => {
  const acting = findUser(req.user);
  const users = listUsers();
  const headed = listRoles().filter((r) => (r.leaders || []).includes(acting.username));
  const departments = headed.map((role) => {
    const members = users
      .filter((u) => !u.admin && (u.roleNames || []).includes(role.name))
      .map((u) => memberRow(role, u));
    const candidates = users
      .filter((u) => !u.admin && !(u.roleNames || []).includes(role.name))
      .map((u) => u.username);
    return {
      name: role.name,
      folders: role.folders,
      canEdit: !!role.canEdit,
      members,
      candidates,
    };
  });
  res.json({ departments });
});

// POST /api/dept/:role/members  { username } -> add a user to the department.
deptRouter.post('/:role/members', async (req, res) => {
  const role = authorizeHead(req, res);
  if (!role) return;
  const target = findUser((req.body || {}).username);
  if (!target) return res.status(400).json({ error: '未找到该用户。' });
  if (target.admin) return res.status(400).json({ error: '不能修改管理员账号。' });
  try {
    setUserRoles(target.username, [...new Set([...(target.roleNames || []), role.name])]);
    await provisionUser(target.username); // personal folder if this is the 員工 role
    res.json({ ok: true, member: memberRow(findRole(role.name), findUser(target.username)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/dept/:role/members/:username -> remove a user from the department.
deptRouter.delete('/:role/members/:username', (req, res) => {
  const role = authorizeHead(req, res);
  if (!role) return;
  const target = findUser(req.params.username);
  if (!target) return res.status(400).json({ error: '未找到该用户。' });
  if (target.admin) return res.status(400).json({ error: '不能修改管理员账号。' });
  // A head cannot remove a fellow head of the same department.
  if ((role.leaders || []).includes(target.username) && !isAdmin(findUser(req.user))) {
    return res.status(400).json({ error: '无法移除该部门的其他主管。' });
  }
  try {
    setUserRoles(target.username, (target.roleNames || []).filter((r) => r !== role.name));
    // Drop any edit grant they held in this department.
    if ((role.editors || []).includes(target.username)) {
      updateRole(role.name, { editors: role.editors.filter((u) => u !== target.username) });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/dept/:role/members/:username  { editor } -> grant/revoke edit rights
// for a member within this department's folders.
deptRouter.put('/:role/members/:username', (req, res) => {
  const role = authorizeHead(req, res);
  if (!role) return;
  const target = findUser(req.params.username);
  if (!target) return res.status(400).json({ error: '未找到该用户。' });
  if (target.admin) return res.status(400).json({ error: '不能修改管理员账号。' });
  if (!(target.roleNames || []).includes(role.name)) {
    return res.status(400).json({ error: '该用户不是本部门成员。' });
  }
  const editor = !!(req.body || {}).editor;
  const current = role.editors || [];
  const next = editor
    ? [...new Set([...current, target.username])]
    : current.filter((u) => u !== target.username);
  try {
    updateRole(role.name, { editors: next });
    res.json({ ok: true, member: memberRow(findRole(role.name), target) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
