// Folder provisioning: creates real folders under the share root to back the
// role / personal-folder features, and wires up the corresponding grants.
//
//  - Every role gets a shared folder "/<roleName>" (all members can access it).
//  - The hardcoded EMPLOYEE_ROLE ("员工") is auto-assigned to new registrants,
//    and each member gets a personal folder "/<username>" visible only to them
//    (and admins, who can see everything).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { findRole, addRole, updateRole, renameRole } from './roles.js';
import { findUser, setExtraFolders, renameRoleInUsers } from './users.js';

// The hardcoded role whose members each get a personal folder.
export const EMPLOYEE_ROLE = '员工';
// Legacy (Traditional-Chinese) spelling of the employee role, migrated to the
// Simplified form above on startup. See migrateEmployeeRoleName().
const LEGACY_EMPLOYEE_ROLE = '員工';

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

// Make sure the hardcoded employee role exists. It is created editable so every
// verified employee can edit the shared "/员工" folder (upload/replace/delete).
export function ensureEmployeeRole() {
  if (!findRole(EMPLOYEE_ROLE)) addRole(EMPLOYEE_ROLE, [], true);
}

// Classify a path on the share: 'exists' | 'absent' (ENOENT) | 'error' (e.g. the
// share is offline — distinguished so migration never destroys data when unsure).
async function statKind(abs) {
  try {
    await fsp.stat(abs);
    return 'exists';
  } catch (e) {
    return e.code === 'ENOENT' ? 'absent' : 'error';
  }
}

// One-time, idempotent migration of the employee role from its old Traditional
// spelling ("員工") to the Simplified one ("员工"): renames the shared folder on
// disk, the role, its folder path, and every member's role assignment.
//
// Returns true if startup should proceed to ensure the (simplified) role, or
// false if it should skip this round (share offline / name conflict) and retry
// on the next boot — avoiding a duplicate "员工" role or orphaned content.
export async function migrateEmployeeRoleName() {
  if (EMPLOYEE_ROLE === LEGACY_EMPLOYEE_ROLE) return true;
  const legacy = findRole(LEGACY_EMPLOYEE_ROLE);
  if (!legacy) return true; // nothing to migrate
  if (findRole(EMPLOYEE_ROLE)) {
    console.warn('[provision] “員工”与“员工”角色同时存在，跳过自动迁移（请管理员手动处理）。');
    return true;
  }

  const oldAbs = path.join(config.shareRoot, LEGACY_EMPLOYEE_ROLE);
  const newAbs = path.join(config.shareRoot, EMPLOYEE_ROLE);
  const oldKind = await statKind(oldAbs);
  const newKind = await statKind(newAbs);

  if (oldKind === 'error' || newKind === 'error') {
    console.warn('[provision] 共享目录暂不可用，稍后重试“員工”→“员工”迁移。');
    return false;
  }
  if (oldKind === 'exists' && newKind === 'exists') {
    console.warn('[provision] “员工”文件夹已存在，无法自动合并“員工”，跳过迁移。');
    return false;
  }
  if (oldKind === 'exists' && newKind === 'absent') {
    try {
      await fsp.rename(oldAbs, newAbs); // preserves the folder's contents
    } catch (e) {
      console.warn('[provision] 重命名“員工”文件夹失败，稍后重试：', e.message);
      return false;
    }
  }
  // Folder is now at "/员工" (or neither existed — ensureRoleFolder will create it).
  const oldRel = '/' + LEGACY_EMPLOYEE_ROLE;
  const newRel = '/' + EMPLOYEE_ROLE;
  updateRole(LEGACY_EMPLOYEE_ROLE, { folders: legacy.folders.map((f) => (f === oldRel ? newRel : f)) });
  renameRole(LEGACY_EMPLOYEE_ROLE, EMPLOYEE_ROLE);
  renameRoleInUsers(LEGACY_EMPLOYEE_ROLE, EMPLOYEE_ROLE);
  console.log('[provision] 已将“員工”角色及其成员迁移为“员工”。');
  return true;
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

// Startup: migrate the legacy role name if needed, then make sure the employee
// role and its shared folder exist.
export async function provisionStartup() {
  let proceed = true;
  try {
    proceed = await migrateEmployeeRoleName();
  } catch (e) {
    console.warn('[provision] “員工”→“员工”迁移出错，稍后重试：', e.message);
    return; // leave existing state untouched; retry next startup
  }
  if (!proceed) return; // share offline / conflict — don't create a duplicate role
  ensureEmployeeRole();
  try {
    await ensureRoleFolder(EMPLOYEE_ROLE);
  } catch (e) {
    console.warn('[provision] 无法创建“员工”共享文件夹（共享目录可能离线或不可写）：', e.message);
  }
}
