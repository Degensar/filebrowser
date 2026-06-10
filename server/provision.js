// Folder provisioning: creates real folders under the share root to back the
// role / personal-folder features, and wires up the corresponding grants.
//
//  - Every role gets a shared folder "/<roleName>" (all members can access it).
//  - The hardcoded EMPLOYEE_ROLE ("員工") is auto-assigned to new registrants,
//    and each member gets a personal folder "/<username>" visible only to them
//    (and admins, who can see everything).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { findRole, addRole, updateRole } from './roles.js';
import { findUser, setExtraFolders } from './users.js';

// The hardcoded role whose members each get a personal folder.
export const EMPLOYEE_ROLE = '員工';

// Turn an arbitrary name into a single safe folder segment directly under the
// share root (no path separators, no traversal).
function safeSegment(name) {
  const seg = String(name || '').replace(/[\\/]/g, '').replace(/^\.+/, '').trim();
  if (!seg) throw new Error('名称无效，无法作为文件夹名。');
  return seg;
}

// Create "<shareRoot>/<name>" if it doesn't exist. Returns the "/name" rel path.
async function ensureFolder(name) {
  const seg = safeSegment(name);
  await fsp.mkdir(path.join(config.shareRoot, seg), { recursive: true });
  return '/' + seg;
}

// Make sure the hardcoded employee role exists.
export function ensureEmployeeRole() {
  if (!findRole(EMPLOYEE_ROLE)) addRole(EMPLOYEE_ROLE, [], false);
}

// Ensure a role's shared folder exists and is part of the role's folder list.
export async function ensureRoleFolder(roleName) {
  const rel = await ensureFolder(roleName);
  const role = findRole(roleName);
  if (role && !role.folders.includes(rel)) {
    updateRole(roleName, { folders: [...role.folders, rel] });
  }
  return rel;
}

// Ensure an employee's personal folder exists and is granted to them (writable).
// Only that user holds the grant, so only they (and admins) can see it.
export async function ensurePersonalFolder(username) {
  const user = findUser(username);
  if (!user) return null;
  const rel = await ensureFolder(user.username);
  if (!user.extraFolders.some((f) => f.path === rel)) {
    setExtraFolders(user.username, [...user.extraFolders, { path: rel, write: true }]);
  }
  return rel;
}

// True if the user currently belongs to the employee role.
export function isEmployee(user) {
  return !!user && (user.roleNames || []).includes(EMPLOYEE_ROLE);
}

// Called after a user is created or has their roles changed: if they are an
// employee, make sure their personal folder exists. Best-effort (never throws
// out — a share that is offline shouldn't block the operation).
export async function provisionUser(username) {
  try {
    if (isEmployee(findUser(username))) await ensurePersonalFolder(username);
  } catch (e) {
    console.warn(`[provision] 无法为用户 ${username} 创建个人文件夹：`, e.message);
  }
}

// Startup: make sure the employee role and its shared folder exist.
export async function provisionStartup() {
  ensureEmployeeRole();
  try {
    await ensureRoleFolder(EMPLOYEE_ROLE);
  } catch (e) {
    console.warn('[provision] 无法创建“員工”共享文件夹（共享目录可能离线或不可写）：', e.message);
  }
}
