// CLI to manage staff accounts without a database.
//   npm run user <command> ...
import readline from 'node:readline';
import {
  addUser,
  removeUser,
  setPassword,
  listUsers,
  findUser,
  setAdmin,
  setUserRoles,
  setExtraFolders,
  describeAccess,
  describeWrite,
} from '../server/users.js';
import { provisionUser } from '../server/provision.js';
import { normRoot } from '../server/paths.js';

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      rl.input.on('keypress', () => {
        rl.output.write('\r' + question + '*'.repeat(rl.line.length));
      });
      rl._writeToOutput = () => {};
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function getPassword(provided) {
  if (provided) return provided;
  const pw = await prompt('密码：', { hidden: true });
  const pw2 = await prompt('确认密码：', { hidden: true });
  if (pw !== pw2) {
    console.error('两次输入的密码不一致。');
    process.exit(1);
  }
  return pw;
}

const [, , cmd, username, arg3, arg4] = process.argv;

// Re-read a user or throw a friendly error.
function getUser(name) {
  const u = findUser(name);
  if (!u) throw new Error(`未找到用户“${String(name).toLowerCase()}”。`);
  return u;
}

try {
  switch (cmd) {
    case 'add': {
      if (!username) throw new Error('用法：npm run user add <用户名> [密码]');
      const pw = await getPassword(arg3);
      addUser(username, pw); // non-admin, no access until roles/folders granted
      console.log(`✓ 已创建用户“${username.toLowerCase()}”（无访问权限，请分配角色或文件夹）。`);
      break;
    }
    case 'add-admin': {
      if (!username) throw new Error('用法：npm run user add-admin <用户名> [密码]');
      const pw = await getPassword(arg3);
      addUser(username, pw, { admin: true });
      console.log(`✓ 已创建管理员“${username.toLowerCase()}”。`);
      break;
    }
    case 'set-admin': {
      if (!username || !['true', 'false'].includes(arg3))
        throw new Error('用法：npm run user set-admin <用户名> <true|false>');
      setAdmin(username, arg3 === 'true');
      console.log(`✓ 已将“${username.toLowerCase()}”的管理员权限设为 ${arg3}。`);
      break;
    }
    case 'passwd': {
      if (!username) throw new Error('用法：npm run user passwd <用户名> [密码]');
      const pw = await getPassword(arg3);
      setPassword(username, pw);
      console.log(`✓ 已更新用户“${username.toLowerCase()}”的密码。`);
      break;
    }
    case 'remove':
    case 'rm': {
      if (!username) throw new Error('用法：npm run user remove <用户名>');
      removeUser(username);
      console.log(`✓ 已删除用户“${username.toLowerCase()}”。`);
      break;
    }
    case 'assign-role': {
      if (!username || !arg3) throw new Error('用法：npm run user assign-role <用户名> <角色名>');
      const user = getUser(username);
      setUserRoles(username, [...new Set([...user.roleNames, arg3])]);
      await provisionUser(username); // personal folder if the role is 員工
      console.log(`✓ 已为“${user.username}”分配角色“${arg3}”。当前可访问：${describeAccess(getUser(username))}`);
      break;
    }
    case 'unassign-role': {
      if (!username || !arg3) throw new Error('用法：npm run user unassign-role <用户名> <角色名>');
      const user = getUser(username);
      setUserRoles(username, user.roleNames.filter((r) => r !== arg3));
      console.log(`✓ 已移除“${user.username}”的角色“${arg3}”。当前可访问：${describeAccess(getUser(username))}`);
      break;
    }
    case 'grant': {
      // Add an extra individual folder. Add "edit" to also allow editing it.
      //   npm run user grant <用户名> <文件夹> [edit]
      if (!username || !arg3) throw new Error('用法：npm run user grant <用户名> <文件夹> [edit]');
      const user = getUser(username);
      const path = normRoot(arg3);
      const write = arg4 === 'edit';
      const next = [...user.extraFolders.filter((f) => f.path !== path), { path, write }];
      setExtraFolders(username, next);
      const u2 = getUser(username);
      console.log(
        `✓ 已为“${u2.username}”授予文件夹“${path}”（${write ? '可编辑' : '只读'}）。\n` +
          `  可访问：${describeAccess(u2)}\n  可编辑：${describeWrite(u2)}`
      );
      break;
    }
    case 'revoke': {
      if (!username || !arg3) throw new Error('用法：npm run user revoke <用户名> <文件夹>');
      const user = getUser(username);
      const path = normRoot(arg3);
      setExtraFolders(username, user.extraFolders.filter((f) => f.path !== path));
      console.log(`✓ 已撤销“${user.username}”的文件夹“${path}”。当前可访问：${describeAccess(getUser(username))}`);
      break;
    }
    case 'access': {
      if (!username) throw new Error('用法：npm run user access <用户名>');
      const user = getUser(username);
      const extra = user.extraFolders.length
        ? user.extraFolders.map((f) => `${f.path}${f.write ? '(可编辑)' : ''}`).join('  ')
        : '（无）';
      console.log(`用户“${user.username}”：`);
      console.log(`  管理员：${user.admin ? '是' : '否'}`);
      console.log(`  角色：${user.roleNames.length ? user.roleNames.join('、') : '（无）'}`);
      console.log(`  额外文件夹：${extra}`);
      console.log(`  有效访问：${describeAccess(user)}`);
      console.log(`  编辑权限：${describeWrite(user)}`);
      break;
    }
    case 'list':
    case 'ls': {
      const users = listUsers();
      if (users.length === 0) {
        console.log('暂无用户。请使用以下命令添加：npm run user add-admin <用户名>');
      } else {
        console.log('已注册用户：');
        for (const u of users)
          console.log(
            `  • ${u.username.padEnd(16)} ${u.admin ? '[管理员]' : '[用户]   '} ` +
              `角色：${(u.roleNames || []).join('、') || '—'}  →  ${describeAccess(u)}`
          );
      }
      break;
    }
    default:
      console.log('员工账户管理：');
      console.log('  npm run user add <用户名> [密码]            创建用户（默认无访问权限）');
      console.log('  npm run user add-admin <用户名> [密码]      创建管理员');
      console.log('  npm run user set-admin <用户名> <true|false> 设置/取消管理员');
      console.log('  npm run user passwd <用户名> [密码]         修改密码');
      console.log('  npm run user remove <用户名>                删除用户');
      console.log('  npm run user list                          列出所有用户');
      console.log('  npm run user access <用户名>                查看某用户的权限明细');
      console.log('');
      console.log('  角色与文件夹分配：');
      console.log('  npm run user assign-role <用户名> <角色名>   给用户分配一个角色');
      console.log('  npm run user unassign-role <用户名> <角色名> 移除用户的某个角色');
      console.log('  npm run user grant <用户名> <文件夹> [edit]  额外授予某文件夹（加 edit 允许编辑）');
      console.log('  npm run user revoke <用户名> <文件夹>        撤销某个额外文件夹');
      console.log('');
      console.log('  角色本身用：npm run role  管理（创建/编辑/删除角色）');
  }
} catch (e) {
  console.error('错误：', e.message);
  process.exit(1);
}
