// CLI to manage access ROLES (named bundles of folders).
//   npm run role <command> ...
import { listRoles, addRole, setRoleFolders, removeRole, findRole } from '../server/roles.js';
import { removeRoleFromAllUsers } from '../server/users.js';
import { normFolders } from '../server/paths.js';

const [, , cmd, name, ...rest] = process.argv;

try {
  switch (cmd) {
    case 'add': {
      // npm run role add <角色名> [文件夹1 文件夹2 ...]
      if (!name) throw new Error('用法：npm run role add <角色名> [文件夹 ...]');
      addRole(name, rest);
      const role = findRole(name);
      console.log(`✓ 已创建角色“${role.name}”，包含文件夹：${role.folders.join('  ') || '（无）'}`);
      break;
    }
    case 'set-folders': {
      // Replace a role's folders.  npm run role set-folders <角色名> <文件夹 ...>
      if (!name) throw new Error('用法：npm run role set-folders <角色名> <文件夹 ...>');
      const saved = setRoleFolders(name, rest);
      console.log(`✓ 已更新角色“${name}”的文件夹：${saved.join('  ') || '（无）'}`);
      break;
    }
    case 'add-folder': {
      // Append a folder to a role.  npm run role add-folder <角色名> <文件夹>
      if (!name || !rest[0]) throw new Error('用法：npm run role add-folder <角色名> <文件夹>');
      const role = findRole(name);
      if (!role) throw new Error(`未找到角色“${name}”。`);
      const saved = setRoleFolders(name, normFolders([...role.folders, rest[0]]));
      console.log(`✓ 角色“${name}”现在包含：${saved.join('  ')}`);
      break;
    }
    case 'remove':
    case 'rm': {
      if (!name) throw new Error('用法：npm run role remove <角色名>');
      removeRole(name);
      removeRoleFromAllUsers(name);
      console.log(`✓ 已删除角色“${name}”，并从所有用户中移除该角色。`);
      break;
    }
    case 'list':
    case 'ls': {
      const roles = listRoles();
      if (roles.length === 0) {
        console.log('暂无角色。请使用以下命令创建：npm run role add <角色名> <文件夹 ...>');
      } else {
        console.log('已定义的角色：');
        for (const r of roles)
          console.log(`  • ${r.name.padEnd(16)} → ${r.folders.join('  ') || '（无文件夹）'}`);
      }
      break;
    }
    default:
      console.log('角色管理（角色是一组文件夹，可分配给多个用户）：');
      console.log('  npm run role add <角色名> [文件夹 ...]        创建角色');
      console.log('  npm run role add-folder <角色名> <文件夹>     给角色追加一个文件夹');
      console.log('  npm run role set-folders <角色名> <文件夹 ...> 重新设置角色的文件夹');
      console.log('  npm run role remove <角色名>                  删除角色');
      console.log('  npm run role list                            列出所有角色');
      console.log('');
      console.log('  把角色分配给用户：npm run user assign-role <用户名> <角色名>');
  }
} catch (e) {
  console.error('错误：', e.message);
  process.exit(1);
}
