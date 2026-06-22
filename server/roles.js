// File-backed store of access ROLES. A role is a named bundle of folders.
// Users are assigned roles and receive the union of those roles' folders.
// Stored at data/roles.json (no database engine needed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normFolders } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ROLES_FILE)) fs.writeFileSync(ROLES_FILE, '[]', 'utf8');
}

function validName(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('角色名称不能为空。');
  if (n.length > 32) throw new Error('角色名称不能超过 32 个字符。');
  return n;
}

// Normalize a list of usernames: lowercase, trimmed, de-duped, sorted.
// Used for a role's `leaders` (部门主管 / department heads) and `editors`
// (members a head has granted edit rights within the department).
function normUsernames(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  for (const l of names) {
    const u = String(l || '').trim().toLowerCase();
    if (u) seen.add(u);
  }
  return [...seen].sort();
}

export function listRoles() {
  ensureStore();
  const roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
  for (const r of roles) {
    if (!Array.isArray(r.folders)) r.folders = [];
    if (typeof r.canEdit !== 'boolean') r.canEdit = false; // back-compat
    if (!Array.isArray(r.leaders)) r.leaders = []; // back-compat: department heads
    if (!Array.isArray(r.editors)) r.editors = []; // back-compat: head-granted editors
  }
  return roles;
}

function saveRoles(roles) {
  ensureStore();
  fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2), 'utf8');
}

// { name -> role } for quick lookup.
export function rolesMap() {
  const map = {};
  for (const r of listRoles()) map[r.name] = r;
  return map;
}

export function findRole(name) {
  const n = String(name || '').trim();
  return listRoles().find((r) => r.name === n) || null;
}

export function addRole(name, folders = [], canEdit = false, leaders = []) {
  const n = validName(name);
  const roles = listRoles();
  if (roles.some((r) => r.name === n)) throw new Error(`角色“${n}”已存在。`);
  roles.push({
    name: n,
    folders: normFolders(folders),
    canEdit: !!canEdit,
    leaders: normUsernames(leaders),
    editors: [],
    createdAt: new Date().toISOString(),
  });
  saveRoles(roles);
  return n;
}

// Update a role's folders, edit capability, department heads, and/or editors.
// Pass undefined to leave a field as-is. (`leaders` is admin-only; `editors` is
// managed by department heads via the /api/dept routes.)
export function updateRole(name, { folders, canEdit, leaders, editors } = {}) {
  const n = String(name || '').trim();
  const roles = listRoles();
  const role = roles.find((r) => r.name === n);
  if (!role) throw new Error(`未找到角色“${n}”。`);
  if (folders !== undefined) role.folders = normFolders(folders);
  if (canEdit !== undefined) role.canEdit = !!canEdit;
  if (leaders !== undefined) role.leaders = normUsernames(leaders);
  if (editors !== undefined) role.editors = normUsernames(editors);
  saveRoles(roles);
  return role;
}

// Rename a role in place (keeps its folders/canEdit/leaders/editors). Returns
// true on success; false if the old role is missing or the new name is taken.
export function renameRole(oldName, newName) {
  const from = String(oldName || '').trim();
  const to = validName(newName);
  const roles = listRoles();
  const role = roles.find((r) => r.name === from);
  if (!role) return false;
  if (roles.some((r) => r.name === to)) return false;
  role.name = to;
  saveRoles(roles);
  return true;
}

export function removeRole(name) {
  const n = String(name || '').trim();
  const roles = listRoles();
  const next = roles.filter((r) => r.name !== n);
  if (next.length === roles.length) throw new Error(`未找到角色“${n}”。`);
  saveRoles(next);
  return n;
}
