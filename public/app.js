// ---- File browser SPA: login/register + file browsing + admin panel ----
const $ = (id) => document.getElementById(id);

const state = {
  account: null, // { username, role, isAdmin, hasAccess }
  path: '/',
  entries: [],
  authMode: 'login', // 'login' | 'register'
};

// ---------- API helper ----------
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    state.account = null;
    showLogin();
    throw new Error('未登录');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

// ---------- View switching ----------
function show(view) {
  for (const v of ['login-view', 'app-view', 'admin-view']) {
    $(v).classList.toggle('hidden', v !== view);
  }
}

function showLogin() {
  show('login-view');
  $('login-username').focus();
}

function showApp() {
  show('app-view');
  $('who').textContent = state.account ? `当前用户：${state.account.username}` : '';
  $('admin-btn').classList.toggle('hidden', !state.account?.isAdmin);
}

// ---------- Auth (login / register toggle) ----------
function setAuthMode(mode) {
  state.authMode = mode;
  const isLogin = mode === 'login';
  $('auth-sub').textContent = isLogin ? '登录以浏览和下载文件' : '注册一个新账号';
  $('login-btn').textContent = isLogin ? '登录' : '注册';
  $('switch-text').textContent = isLogin ? '还没有账号？' : '已有账号？';
  $('switch-link').textContent = isLogin ? '注册新账号' : '返回登录';
  $('login-error').classList.add('hidden');
  $('login-password').setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
}

$('switch-link').addEventListener('click', (e) => {
  e.preventDefault();
  setAuthMode(state.authMode === 'login' ? 'register' : 'login');
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  const errEl = $('login-error');
  const isLogin = state.authMode === 'login';
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = isLogin ? '登录中…' : '注册中…';
  try {
    const data = await api(`/api/auth/${isLogin ? 'login' : 'register'}`, {
      method: 'POST',
      body: JSON.stringify({
        username: $('login-username').value,
        password: $('login-password').value,
      }),
    });
    state.account = data;
    $('login-password').value = '';
    if (!isLogin && data.bootstrap) {
      alert('注册成功！您是第一个账号，已被设为管理员。');
    } else if (!isLogin && !data.hasAccess) {
      alert('注册成功！请联系管理员为您开通文件夹访问权限。');
    }
    enterAppropriateView();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    setAuthMode(state.authMode);
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  state.account = null;
  setAuthMode('login');
  showLogin();
});

function enterAppropriateView() {
  showApp();
  navigate('/');
}

// ---------- File browser ----------
async function navigate(path) {
  state.path = path;
  $('search').value = '';
  setState('loading');
  $('toolbar').classList.add('hidden');
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
    state.path = data.path;
    state.entries = data.entries;
    state.canWrite = !!data.canWrite;
    renderBreadcrumb(data.breadcrumb);
    renderList(data.entries);
    // Show the upload toolbar wherever the user may edit. The server only sets
    // canWrite on real folder listings (a restricted user's virtual home never
    // does), so this correctly includes the real share root for admins.
    $('toolbar').classList.toggle('hidden', !state.canWrite);
    $('upload-status').textContent = '';
  } catch (err) {
    showError(err.message);
  }
}

function setState(which) {
  for (const id of ['loading', 'error', 'empty', 'no-access', 'file-table']) {
    $(id).classList.add('hidden');
  }
  if (which) $(which).classList.remove('hidden');
}

function showError(msg) {
  setState('error');
  $('error').textContent = msg;
}

function renderBreadcrumb(crumbs) {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  const list = crumbs || [{ label: '主目录', path: '/', home: true }];
  list.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      bc.appendChild(sep);
    }
    const text = (crumb.home ? '🏠 ' : '') + crumb.label;
    if (i === list.length - 1) {
      const cur = document.createElement('span');
      cur.className = 'current';
      cur.textContent = text;
      bc.appendChild(cur);
    } else {
      const link = document.createElement('a');
      const target = crumb.path;
      link.textContent = text;
      link.addEventListener('click', () => navigate(target));
      bc.appendChild(link);
    }
  });
}

function renderList(entries) {
  const tbody = $('file-list');
  tbody.innerHTML = '';
  if (entries.length === 0) {
    // At home with no entries + restricted account = no access granted yet.
    if (state.path === '/' && state.account && !state.account.isAdmin && !state.account.hasAccess) {
      setState('no-access');
    } else {
      $('empty').textContent = '此文件夹为空。';
      setState('empty');
    }
    return;
  }
  setState('file-table');

  for (const entry of entries) {
    const tr = document.createElement('tr');
    tr.dataset.name = entry.name.toLowerCase();

    const nameTd = document.createElement('td');
    nameTd.className = 'name-cell ' + (entry.type === 'dir' ? 'folder' : 'file');
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = entry.type === 'dir' ? '📁' : iconForFile(entry.name);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.name;
    label.title = entry.name;
    nameTd.append(icon, label);
    if (entry.type === 'dir') label.addEventListener('click', () => navigate(entry.path));

    const sizeTd = document.createElement('td');
    sizeTd.className = 'col-size';
    sizeTd.textContent = entry.type === 'dir' ? '—' : formatSize(entry.size);

    const dateTd = document.createElement('td');
    dateTd.className = 'col-date';
    dateTd.textContent = entry.mtime ? formatDate(entry.mtime) : '';

    const actTd = document.createElement('td');
    actTd.className = 'col-action';
    if (entry.type === 'file') {
      const a = document.createElement('a');
      a.className = 'download-link';
      a.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
      a.innerHTML = '⬇ 下载';
      actTd.appendChild(a);
    }
    if (state.canWrite) {
      if (entry.type === 'file') {
        actTd.appendChild(mkBtn('替换', 'btn-mini', () => replaceFile(entry)));
      }
      actTd.appendChild(mkBtn('删除', 'btn-mini btn-danger', () => deleteEntry(entry)));
    }

    tr.append(nameTd, sizeTd, dateTd, actTd);
    tbody.appendChild(tr);
  }
}

// ---------- Write operations in the file browser ----------
$('upload-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = ''; // allow re-selecting the same file later
  if (files.length) await uploadFiles(files);
});
$('mkdir-btn').addEventListener('click', createFolder);

async function uploadFiles(files) {
  const status = $('upload-status');
  let done = 0;
  for (const file of files) {
    status.textContent = `正在上传 ${file.name}（${++done}/${files.length}）…`;
    const dest = joinPath(state.path, file.name);
    try {
      await fetch(`/api/file?path=${encodeURIComponent(dest)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      }).then(checkOk);
    } catch (err) {
      status.textContent = '';
      alert(`上传“${file.name}”失败：${err.message}`);
      break;
    }
  }
  status.textContent = done ? `已上传 ${done} 个文件。` : '';
  await navigate(state.path);
}

// Replace one existing file with a newly chosen file (overwrites in place).
function replaceFile(entry) {
  const input = el('input', { type: 'file' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (!confirm(`用所选文件覆盖“${entry.name}”？原文件将被替换。`)) return;
    try {
      await fetch(`/api/file?path=${encodeURIComponent(entry.path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      }).then(checkOk);
      await navigate(state.path);
    } catch (err) {
      alert(`替换失败：${err.message}`);
    }
  });
  input.click();
}

async function deleteEntry(entry) {
  const what = entry.type === 'dir' ? '文件夹（及其全部内容）' : '文件';
  if (!confirm(`确定要删除${what}“${entry.name}”吗？此操作不可撤销。`)) return;
  try {
    await api(`/api/file?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
    await navigate(state.path);
  } catch (err) {
    alert(`删除失败：${err.message}`);
  }
}

async function createFolder() {
  const name = prompt('请输入新文件夹的名称：');
  if (!name) return;
  try {
    await api(`/api/folder?path=${encodeURIComponent(joinPath(state.path, name))}`, { method: 'POST' });
    await navigate(state.path);
  } catch (err) {
    alert(`创建失败：${err.message}`);
  }
}

// fetch() doesn't throw on HTTP errors; surface the server's message.
async function checkOk(res) {
  if (res.ok) return res;
  let msg = `请求失败（${res.status}）`;
  try {
    msg = (await res.json()).error || msg;
  } catch {
    /* ignore */
  }
  throw new Error(msg);
}

function joinPath(dir, name) {
  return (dir === '/' ? '' : dir) + '/' + name;
}

$('search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  let visible = 0;
  for (const tr of $('file-list').children) {
    const match = !q || tr.dataset.name.includes(q);
    tr.style.display = match ? '' : 'none';
    if (match) visible++;
  }
  if (state.entries.length > 0) {
    if (visible === 0) {
      $('empty').textContent = `没有匹配“${q}”的文件。`;
      setState('empty');
    } else {
      setState('file-table');
    }
  }
});

// ======================= ADMIN PANEL =======================
// All roles, cached for the duration of the admin session, so user modals can
// render the list of assignable roles.
let adminRoles = [];

$('admin-btn').addEventListener('click', openAdmin);
$('admin-back-btn').addEventListener('click', () => {
  showApp();
  navigate('/');
});
$('admin-new-btn').addEventListener('click', openNewUserModal);
$('admin-new-role-btn').addEventListener('click', () => openRoleModal(null));

async function openAdmin() {
  show('admin-view');
  await loadAdmin();
}

async function loadAdmin() {
  const errEl = $('admin-error');
  errEl.classList.add('hidden');
  try {
    const [{ roles }, { users }] = await Promise.all([
      api('/api/admin/roles'),
      api('/api/admin/users'),
    ]);
    adminRoles = roles;
    renderRoles(roles);
    renderUsers(users);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

function renderRoles(roles) {
  const tbody = $('admin-role-list');
  tbody.innerHTML = '';
  if (roles.length === 0) {
    const tr = el('tr', {}, el('td', { colSpan: 3, className: 'admin-empty', textContent: '还没有角色。点击右上角“新建角色”来创建第一个。' }));
    tbody.appendChild(tr);
    return;
  }
  for (const r of roles) {
    const tr = document.createElement('tr');
    const nameTd = el('td', { className: 'admin-username' }, el('span', { textContent: r.name }));
    if (r.canEdit) nameTd.append(el('span', { className: 'edit-badge', textContent: '可编辑' }));
    const foldersTd = el('td', { className: 'admin-access', textContent: r.folders.length ? r.folders.join('  ') : '（未指定文件夹）' });
    const actTd = el('td', { className: 'col-admin-actions' });
    actTd.append(
      mkBtn('编辑', 'btn-mini', () => openRoleModal(r)),
      mkBtn('删除', 'btn-mini btn-danger', () => deleteRole(r))
    );
    tr.append(nameTd, foldersTd, actTd);
    tbody.appendChild(tr);
  }
}

function renderUsers(users) {
  const tbody = $('admin-user-list');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');

    const nameTd = el('td', { className: 'admin-username', textContent: u.username });

    const adminTd = el('td', { className: 'col-role' });
    if (u.admin) {
      adminTd.append(el('span', { className: 'role-badge role-admin', textContent: '管理员' }));
    } else {
      adminTd.append(el('span', { className: 'admin-dim', textContent: '—' }));
    }

    const rolesTd = el('td', { className: 'admin-access' });
    rolesTd.textContent = u.admin ? '（管理员：全部）' : u.roleNames.length ? u.roleNames.join('、') : '—';

    const accessTd = el('td', { className: 'admin-access', textContent: u.access });

    const actTd = el('td', { className: 'col-admin-actions' });
    actTd.append(
      mkBtn('编辑权限', 'btn-mini', () => openUserEditModal(u)),
      mkBtn('改密', 'btn-mini', () => openPasswordModal(u)),
      mkBtn('删除', 'btn-mini btn-danger', () => deleteUser(u))
    );

    tr.append(nameTd, adminTd, rolesTd, accessTd, actTd);
    tbody.appendChild(tr);
  }
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

async function deleteRole(r) {
  if (!confirm(`确定要删除角色“${r.name}”吗？该角色会从所有用户中移除。`)) return;
  try {
    await api(`/api/admin/roles/${encodeURIComponent(r.name)}`, { method: 'DELETE' });
    await loadAdmin();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteUser(u) {
  if (!confirm(`确定要删除用户“${u.username}”吗？此操作不可撤销。`)) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
    await loadAdmin();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Modal infrastructure ----------
function openModal(title, bodyEl, footerEl) {
  $('modal-title').textContent = title;
  const body = $('modal-body');
  const footer = $('modal-footer');
  body.innerHTML = '';
  footer.innerHTML = '';
  body.appendChild(bodyEl);
  if (footerEl) footer.appendChild(footerEl);
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  $('modal-overlay').classList.add('hidden');
}
$('modal-close').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('modal-overlay')) closeModal();
});

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

// A reusable editor for a list of folders, each with a "writable" toggle.
// `initial` is an array of { path, write }. Returns { element, getFolders }
// where getFolders() yields the same shape.
function makeFolderEditor(initial = []) {
  let folders = initial.map((f) => ({ path: f.path, write: !!f.write }));
  const box = el('div', { className: 'folder-list' });

  function render() {
    box.innerHTML = '';
    if (folders.length === 0) {
      box.append(el('div', { className: 'folder-empty', textContent: '尚未添加任何文件夹。' }));
    }
    for (const f of folders) {
      const writeCb = el('input', { type: 'checkbox', checked: f.write });
      writeCb.addEventListener('change', () => { f.write = writeCb.checked; });
      const editToggle = el('label', { className: 'chip-edit', title: '允许在此文件夹中上传/替换/删除' },
        writeCb, el('span', { textContent: '可编辑' }));

      const rm = el('button', { className: 'folder-chip-remove', textContent: '✕' });
      rm.addEventListener('click', () => {
        folders = folders.filter((x) => x !== f);
        render();
      });

      box.append(el('div', { className: 'folder-chip' },
        el('span', { className: 'folder-chip-icon', textContent: '📁' }),
        el('span', { className: 'folder-chip-path', textContent: f.path }),
        editToggle,
        rm
      ));
    }
  }
  const addBtn = el('button', { className: 'btn-mini', textContent: '+ 浏览并添加文件夹' });
  addBtn.addEventListener('click', () => {
    openFolderPicker((picked) => {
      if (!folders.some((f) => f.path === picked)) folders.push({ path: picked, write: false });
      render();
    });
  });
  render();
  const element = el('div', { className: 'restricted-section' }, box, addBtn);
  return { element, getFolders: () => folders.map((f) => ({ path: f.path, write: f.write })) };
}

// A reusable list of role checkboxes. Returns { element, getSelected }.
function makeRoleChecklist(selected = []) {
  const box = el('div', { className: 'role-checklist' });
  if (adminRoles.length === 0) {
    box.append(el('div', { className: 'folder-empty', textContent: '还没有任何角色。可先在上方“角色管理”中创建。' }));
    return { element: box, getSelected: () => [] };
  }
  const boxes = [];
  for (const r of adminRoles) {
    const cb = el('input', { type: 'checkbox', checked: selected.includes(r.name) });
    cb.value = r.name;
    boxes.push(cb);
    const nameRow = el('span', { className: 'role-check-name' }, el('span', { textContent: r.name }));
    if (r.canEdit) nameRow.append(el('span', { className: 'edit-badge', textContent: '可编辑' }));
    const label = el('label', { className: 'role-check' },
      cb,
      nameRow,
      el('span', { className: 'role-check-folders', textContent: r.folders.join('  ') || '（无文件夹）' })
    );
    box.append(label);
  }
  return { element: box, getSelected: () => boxes.filter((c) => c.checked).map((c) => c.value) };
}

// ---------- New user modal ----------
function openNewUserModal() {
  const username = el('input', { type: 'text', className: 'modal-input', placeholder: '用户名（字母/数字/.-_）' });
  const password = el('input', { type: 'password', className: 'modal-input', placeholder: '密码（至少 6 位）' });
  const adminCb = el('input', { type: 'checkbox' });
  const adminLabel = el('label', { className: 'check-row' }, adminCb, el('span', { textContent: '设为管理员（拥有全部访问权限）' }));
  const roleList = makeRoleChecklist([]);
  const folderEditor = makeFolderEditor([]);
  const err = el('div', { className: 'modal-error hidden' });

  const body = el('div', {},
    labelWrap('用户名', username),
    labelWrap('密码', password),
    adminLabel,
    el('p', { className: 'modal-note', textContent: '分配角色（可多选）：' }),
    roleList.element,
    el('p', { className: 'modal-note', textContent: '额外授予的文件夹（在角色之外）：' }),
    folderEditor.element,
    err
  );

  const save = el('button', { className: 'btn-primary', textContent: '创建' });
  save.addEventListener('click', async () => {
    err.classList.add('hidden');
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: username.value,
          password: password.value,
          admin: adminCb.checked,
          roleNames: roleList.getSelected(),
          extraFolders: folderEditor.getFolders(),
        }),
      });
      closeModal();
      await loadAdmin();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  });
  openModal('新建用户', body, save);
}

// ---------- Reset password modal ----------
function openPasswordModal(u) {
  const password = el('input', { type: 'password', className: 'modal-input', placeholder: '新密码（至少 6 位）' });
  const err = el('div', { className: 'modal-error hidden' });
  const body = el('div', {}, el('p', { textContent: `为用户“${u.username}”设置新密码：` }), password, err);
  const save = el('button', { className: 'btn-primary', textContent: '保存' });
  save.addEventListener('click', async () => {
    err.classList.add('hidden');
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.username)}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: password.value }),
      });
      closeModal();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  });
  openModal('重置密码', body, save);
}

// ---------- User edit modal (admin flag + roles + extra folders) ----------
function openUserEditModal(u) {
  const adminCb = el('input', { type: 'checkbox', checked: u.admin });
  const adminLabel = el('label', { className: 'check-row' }, adminCb, el('span', { textContent: '管理员（拥有全部访问权限）' }));
  const roleList = makeRoleChecklist(u.roleNames);

  const fullEntry = (u.extraFolders || []).find((f) => f.path === '/');
  const folderEditor = makeFolderEditor((u.extraFolders || []).filter((f) => f.path !== '/'));
  const fullFolderCb = el('input', { type: 'checkbox', checked: !!fullEntry });
  const fullWriteCb = el('input', { type: 'checkbox', checked: !!fullEntry?.write });
  const fullFolderLabel = el('label', { className: 'check-row' }, fullFolderCb,
    el('span', { textContent: '额外授予“整个共享目录”（等同完全访问，慎用）' }));
  const fullWriteLabel = el('label', { className: 'check-row check-indent' }, fullWriteCb,
    el('span', { textContent: '并允许编辑整个共享目录' }));
  const err = el('div', { className: 'modal-error hidden' });

  // When "admin" is on, role/folder choices don't matter — dim them.
  const detail = el('div', {},
    el('p', { className: 'modal-note', textContent: '分配角色（可多选，用户将获得这些角色的所有文件夹；带“可编辑”标记的角色还可上传/替换/删除）：' }),
    roleList.element,
    el('p', { className: 'modal-note', textContent: '额外授予的文件夹（在角色之外单独开放）。勾选“可编辑”即可在该文件夹内上传/替换/删除：' }),
    folderEditor.element,
    fullFolderLabel,
    fullWriteLabel
  );
  function syncAdmin() {
    detail.style.opacity = adminCb.checked ? '0.45' : '1';
    detail.style.pointerEvents = adminCb.checked ? 'none' : 'auto';
  }
  adminCb.addEventListener('change', syncAdmin);
  syncAdmin();

  const body = el('div', {},
    el('p', { textContent: `编辑用户“${u.username}”的权限：` }),
    adminLabel,
    detail,
    err
  );

  const save = el('button', { className: 'btn-primary', textContent: '保存' });
  save.addEventListener('click', async () => {
    err.classList.add('hidden');
    const extra = [...folderEditor.getFolders()];
    if (fullFolderCb.checked) extra.push({ path: '/', write: fullWriteCb.checked });
    try {
      await api(`/api/admin/users/${encodeURIComponent(u.username)}`, {
        method: 'PUT',
        body: JSON.stringify({
          admin: adminCb.checked,
          roleNames: roleList.getSelected(),
          extraFolders: extra,
        }),
      });
      closeModal();
      await loadAdmin();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  });
  openModal('编辑用户权限', body, save);
}

// ---------- Role create / edit modal ----------
function openRoleModal(role) {
  const isEdit = !!role;
  const nameInput = el('input', {
    type: 'text', className: 'modal-input', placeholder: '角色名称，如：销售部',
    value: isEdit ? role.name : '', disabled: isEdit,
  });
  // Role folders are read-granted to members; the role's canEdit flag decides
  // whether those folders are also editable. So the per-folder write toggle in
  // the editor is not used here — we hide it and use one role-wide checkbox.
  const folderEditor = makeFolderEditor(
    isEdit ? role.folders.filter((f) => f !== '/').map((p) => ({ path: p, write: false })) : []
  );
  folderEditor.element.classList.add('hide-chip-edit');
  const canEditCb = el('input', { type: 'checkbox', checked: isEdit ? !!role.canEdit : false });
  const canEditLabel = el('label', { className: 'check-row' }, canEditCb,
    el('span', { textContent: '允许该角色编辑其文件夹（上传 / 替换 / 删除）' }));
  const err = el('div', { className: 'modal-error hidden' });

  const body = el('div', {},
    labelWrap('角色名称', nameInput),
    el('p', { className: 'modal-note', textContent: '该角色包含的文件夹（拥有此角色的用户都能访问）：' }),
    folderEditor.element,
    canEditLabel,
    err
  );

  const save = el('button', { className: 'btn-primary', textContent: isEdit ? '保存' : '创建' });
  save.addEventListener('click', async () => {
    err.classList.add('hidden');
    const folders = folderEditor.getFolders().map((f) => f.path);
    try {
      if (isEdit) {
        await api(`/api/admin/roles/${encodeURIComponent(role.name)}`, {
          method: 'PUT',
          body: JSON.stringify({ folders, canEdit: canEditCb.checked }),
        });
      } else {
        await api('/api/admin/roles', {
          method: 'POST',
          body: JSON.stringify({ name: nameInput.value, folders, canEdit: canEditCb.checked }),
        });
      }
      closeModal();
      await loadAdmin();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  });
  openModal(isEdit ? `编辑角色：${role.name}` : '新建角色', body, save);
}

// ---------- Folder picker (browses the real share) ----------
function openFolderPicker(onPick) {
  let current = '/';
  const pathLabel = el('div', { className: 'picker-path' });
  const listBox = el('div', { className: 'picker-list' });
  const err = el('div', { className: 'modal-error hidden' });

  async function load(path) {
    current = path;
    pathLabel.textContent = '当前位置：' + (path === '/' ? '主目录' : path);
    listBox.innerHTML = '加载中…';
    err.classList.add('hidden');
    try {
      const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
      listBox.innerHTML = '';
      if (path !== '/') {
        const up = el('div', { className: 'picker-item picker-up' },
          el('span', { textContent: '⬆ 上一级' }));
        up.addEventListener('click', () => load(parentOf(path)));
        listBox.append(up);
      }
      const dirs = data.entries.filter((e) => e.type === 'dir');
      if (dirs.length === 0) {
        listBox.append(el('div', { className: 'folder-empty', textContent: '（此处没有子文件夹）' }));
      }
      for (const d of dirs) {
        const item = el('div', { className: 'picker-item' },
          el('span', { className: 'picker-item-name' },
            el('span', { textContent: '📁 ' }),
            el('span', { textContent: d.name })
          )
        );
        const pickThis = el('button', { className: 'btn-mini', textContent: '选择此文件夹' });
        pickThis.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onPick(d.path);
          closeNested();
        });
        item.addEventListener('click', () => load(d.path));
        item.append(pickThis);
        listBox.append(item);
      }
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
      listBox.innerHTML = '';
    }
  }

  // Nested modal: we reuse the same overlay by stacking content. Simplest is a
  // second lightweight overlay.
  const overlay = el('div', { className: 'modal-overlay nested' });
  const pickHere = el('button', { className: 'btn-primary', textContent: '选择当前文件夹' });
  pickHere.addEventListener('click', () => {
    if (current === '/') {
      err.textContent = '请进入一个具体的文件夹，或从列表中选择。';
      err.classList.remove('hidden');
      return;
    }
    onPick(current);
    closeNested();
  });
  const closeBtn = el('button', { className: 'btn-ghost', textContent: '取消' });
  closeBtn.addEventListener('click', closeNested);

  const modal = el('div', { className: 'modal' },
    el('div', { className: 'modal-header' },
      el('h3', { textContent: '选择文件夹' }),
      (() => { const x = el('button', { className: 'modal-close', textContent: '✕' }); x.addEventListener('click', closeNested); return x; })()
    ),
    el('div', { className: 'modal-body' }, pathLabel, listBox, err),
    el('div', { className: 'modal-footer' }, pickHere, closeBtn)
  );
  overlay.append(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeNested(); });
  document.body.append(overlay);
  function closeNested() { overlay.remove(); }

  load('/');
}

function parentOf(path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function labelWrap(text, input) {
  return el('label', { className: 'modal-label' }, el('span', { textContent: text }), input);
}

// ---------- Formatting ----------
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  return (
    d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) +
    ' ' +
    d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  );
}

function iconForFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    pdf: '📕',
    doc: '📘', docx: '📘',
    xls: '📗', xlsx: '📗', csv: '📗',
    ppt: '📙', pptx: '📙',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', bmp: '🖼️',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', gz: '🗜️', tar: '🗜️',
    txt: '📄', md: '📄', rtf: '📄',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵',
    exe: '⚙️', msi: '⚙️',
  };
  return map[ext] || '📄';
}

// ---------- Boot ----------
(async function init() {
  setAuthMode('login');
  try {
    const me = await api('/api/auth/me');
    state.account = me;
    enterAppropriateView();
  } catch {
    showLogin();
  }
})();
