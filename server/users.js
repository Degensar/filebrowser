// File-backed user store. Passwords are bcrypt-hashed.
// Stored at data/users.json so there is no database engine to install.
//
// Each user record:
//   {
//     username, passwordHash, createdAt,
//     admin:        boolean   -> system administrator (always full access)
//     roleNames:    string[]  -> assigned access roles (see roles.js)
//     extraFolders: string[]  -> individual folders granted directly to this user
//   }
//
// A non-admin user's EFFECTIVE access = (folders of all assigned roles)
//                                       ∪ (their extra folders).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { normFolders } from './paths.js';
import { rolesMap } from './roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

// Migrate a record from any older shape to the current one.
function migrate(u) {
  if (u.admin === undefined) u.admin = u.role === 'admin';
  if (!Array.isArray(u.roleNames)) u.roleNames = [];
  if (!Array.isArray(u.extraFolders)) {
    // Older versions stored a single "roots" list directly on the user.
    u.extraFolders = Array.isArray(u.roots) ? normFolders(u.roots) : [];
  }
  delete u.role;
  delete u.roots;
  return u;
}

export function listUsers() {
  ensureStore();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).map(migrate);
}

function saveUsers(users) {
  ensureStore();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

export function countUsers() {
  return listUsers().length;
}

export function findUser(username) {
  const u = String(username || '').trim().toLowerCase();
  return listUsers().find((x) => x.username === u) || null;
}

export const isAdmin = (user) => !!user && user.admin === true;

// The effective set of allowed folders for a user, as normalized roots.
// Admins get the whole share. Otherwise: union of role folders + extra folders.
export function effectiveRoots(user) {
  if (!user) return [];
  if (user.admin) return ['/'];
  const map = rolesMap();
  const all = [];
  for (const rn of user.roleNames || []) {
    const role = map[rn];
    if (role) all.push(...role.folders);
  }
  all.push(...(user.extraFolders || []));
  return normFolders(all); // collapses to ["/"] if any entry is the whole share
}

// Human-readable access summary (Chinese) for CLI / admin display.
export function describeAccess(user) {
  if (user.admin) return '全部访问（管理员）';
  const roots = effectiveRoots(user);
  if (roots.includes('/')) return '全部访问';
  if (roots.length === 0) return '无访问权限';
  return roots.join('  ');
}

// Strip the password hash before sending a user to the client.
export function publicUser(u) {
  return {
    username: u.username,
    admin: !!u.admin,
    roleNames: u.roleNames || [],
    extraFolders: u.extraFolders || [],
    effective: effectiveRoots(u),
    access: describeAccess(u),
    createdAt: u.createdAt,
  };
}

export function addUser(username, password, opts = {}) {
  const { admin = false, roleNames = [], extraFolders = [] } = opts;
  const u = String(username || '').trim().toLowerCase();
  if (!u) throw new Error('用户名不能为空。');
  if (!/^[a-z0-9._-]{2,32}$/.test(u))
    throw new Error('用户名只能包含字母、数字、点、下划线或连字符（2-32 个字符）。');
  if (!password || password.length < 6)
    throw new Error('密码长度至少为 6 个字符。');
  const users = listUsers();
  if (users.some((x) => x.username === u)) throw new Error(`用户“${u}”已存在。`);
  users.push({
    username: u,
    passwordHash: bcrypt.hashSync(password, 10),
    admin: !!admin,
    roleNames: Array.isArray(roleNames) ? [...new Set(roleNames)] : [],
    extraFolders: normFolders(extraFolders),
    createdAt: new Date().toISOString(),
  });
  saveUsers(users);
  return u;
}

export function removeUser(username) {
  const u = String(username).trim().toLowerCase();
  const users = listUsers();
  const target = users.find((x) => x.username === u);
  if (!target) throw new Error(`未找到用户“${u}”。`);
  if (target.admin && users.filter((x) => x.admin).length <= 1)
    throw new Error('无法删除最后一名管理员。');
  saveUsers(users.filter((x) => x.username !== u));
  return u;
}

export function setPassword(username, password) {
  if (!password || password.length < 6) throw new Error('密码长度至少为 6 个字符。');
  return updateUser(username, (user) => {
    user.passwordHash = bcrypt.hashSync(password, 10);
  });
}

export function setAdmin(username, admin) {
  const u = String(username).trim().toLowerCase();
  const users = listUsers();
  const user = users.find((x) => x.username === u);
  if (!user) throw new Error(`未找到用户“${u}”。`);
  if (user.admin && !admin && users.filter((x) => x.admin).length <= 1)
    throw new Error('无法降级最后一名管理员。请先指定另一名管理员。');
  user.admin = !!admin;
  saveUsers(users);
  return user.admin;
}

export function setUserRoles(username, roleNames) {
  const valid = new Set(Object.keys(rolesMap()));
  const filtered = (Array.isArray(roleNames) ? roleNames : []).filter((r) => valid.has(r));
  return updateUser(username, (user) => {
    user.roleNames = [...new Set(filtered)];
  });
}

export function setExtraFolders(username, folders) {
  return updateUser(username, (user) => {
    user.extraFolders = normFolders(folders);
  });
}

// Apply a mutation to one user and persist.
function updateUser(username, mutate) {
  const u = String(username).trim().toLowerCase();
  const users = listUsers();
  const user = users.find((x) => x.username === u);
  if (!user) throw new Error(`未找到用户“${u}”。`);
  mutate(user);
  saveUsers(users);
  return user;
}

// When a role is deleted, drop it from every user's assignments.
export function removeRoleFromAllUsers(roleName) {
  const users = listUsers();
  let changed = false;
  for (const user of users) {
    if (user.roleNames?.includes(roleName)) {
      user.roleNames = user.roleNames.filter((r) => r !== roleName);
      changed = true;
    }
  }
  if (changed) saveUsers(users);
}

export function verifyCredentials(username, password) {
  const user = findUser(username);
  if (!user) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}
