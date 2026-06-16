# Company File Browser

A simple, clean web app for staff to **browse and download** files from a company
Windows / SMB file share. Each person logs in with their own account.

- 🔒 **HTTPS** out of the box (auto self-signed cert, or bring your own)
- 🔐 Login required (app-managed accounts, bcrypt-hashed passwords)
- 📁 Browse folders with breadcrumb navigation
- 🔎 Filter files in the current folder
- ⬇️ One-click downloads (streamed, so large files are fine)
- ✏️ Optional **edit rights** — upload, replace, and delete files where the admin grants it
- 👥 **Roles** + per-user permissions, managed from a built-in admin panel
- 🗂️ **Auto-folders** — every role gets a shared folder; every employee gets a private one
- 🛡️ Path-traversal protection — users can never escape the share folder
- 🧩 No database engine and no frontend build step to maintain

---

## Requirements

- **Node.js 16+.** On **CentOS 7 / RHEL 7** (glibc 2.17) you **must use Node 16** — the
  official Node 18+ binaries require glibc 2.28 and will not start there. Node 16 runs the
  app fully. On newer systems, any current LTS is fine.
- **Client browsers:** the UI is plain ES2017 (no build step) — works on Firefox 60+
  (incl. RHEL 7's Firefox ESR), modern Chrome/Edge, etc. HTTPS needs the client to support
  TLS 1.2 (anything from ~2014 onward).

## Quick start

```powershell
cd C:\working\filebrowser

# 1. Install dependencies
npm install

# 2. Create your config
copy .env.example .env
#    then edit .env — at minimum set SHARE_ROOT and JWT_SECRET

# 3. Start the app
npm start
```

Open http://localhost:3000, click **注册新账号 (Register)**, and create your account —
**the first account to register automatically becomes the administrator.** From there you
can manage everyone else in the admin panel. (Prefer the command line? See
[Creating an admin account](#creating-an-admin-account).)

---

## Starting and stopping the server

**Start it** (from the `filebrowser` folder):

```powershell
npm start
```

**Stop it:**

- If it's running in the foreground (you can see its log in the terminal), press
  **`Ctrl + C`** in that terminal.

- If it's running in the background, or you closed the terminal, stop it by the port it
  listens on (default `3000`):

  ```powershell
  # Find and stop whatever is listening on port 3000
  Get-NetTCPConnection -LocalPort 3000 -State Listen |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```

  Change `3000` if you set a different `PORT` in `.env`.

> Tip: if you run it as a Windows service (see [Always-on](#running-it-as-an-always-on-service-optional)),
> start/stop it with your process manager instead — e.g. `pm2 stop filebrowser` or
> `nssm stop filebrowser`.

---

## Creating an admin account

An admin can log in, open the **管理后台 (Admin)** panel, and manage all users and their
folder permissions. There are three ways to get an admin account:

**1. Register the first account (easiest).**
The very first account that registers through the web page automatically becomes the
admin. If `data/users.json` is empty, just open the app, click **注册新账号 (Register)**,
and create your account.

**2. Create one from the command line** (works any time, even if users already exist):

```powershell
npm run user add-admin <username>
#    e.g.  npm run user add-admin boss
#    (you'll be prompted to set a password)
```

**3. Promote an existing user to admin:**

```powershell
npm run user set-role <username> admin    # make them an admin
npm run user set-role <username> user     # demote back to a normal user
```

Once you have one admin, you can create and promote more admins directly from the
**Admin panel** in the browser (新建用户 → role *管理员*, or the **设为管理员** button on
any user). Safety guard: the app will not let you delete or demote the **last** remaining
admin.

---

## Configuration (`.env`)

| Setting             | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `PORT`              | Port the web app listens on (default `3000`).                            |
| `SHARE_ROOT`        | The folder to expose. Use the UNC path for an SMB share, e.g. `\\fileserver\shared`. |
| `JWT_SECRET`        | Long random string used to sign login cookies. **Must be changed.**      |
| `SESSION_HOURS`     | How long a login stays valid (default `12`).                            |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Optional paths to a real PEM cert/key. If unset, a self-signed cert is generated. |
| `HTTP_REDIRECT_PORT`| Optional. Run an HTTP listener on this port that 301-redirects to HTTPS (e.g. `80`). |
| `TLS_DISABLE`       | Set `true` only if a reverse proxy (IIS/Nginx) terminates TLS and the app should serve plain HTTP. |

Generate a strong `JWT_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## HTTPS

The app serves **HTTPS by default** — open it at **`https://<host>:3000`**.

- **No cert configured?** On first start it generates a **self-signed** certificate and
  caches it in `data/tls/`. Browsers show a one-time "not private" warning for self-signed
  certs — click through to proceed (or, better, install the cert as trusted on staff machines).
- **Production:** point `TLS_CERT_FILE` / `TLS_KEY_FILE` at a real certificate (e.g. from your
  internal CA or Let's Encrypt) for a warning-free experience.
- **Behind a reverse proxy** that already does TLS? Set `TLS_DISABLE=true` so the app serves
  HTTP locally and the proxy handles HTTPS.

Login cookies are automatically marked `Secure` whenever HTTPS is on.

---

## Managing users

```powershell
npm run user add <username>              # create a user (no access until granted)
npm run user add-admin <username>        # create an admin user
npm run user set-admin <username> true   # promote to admin (or: ... false to demote)
npm run user assign-role <username> <role>   # give the user a role
npm run user grant <username> <folder>       # grant an extra folder (read-only)
npm run user grant <username> <folder> edit  # ...or grant it with edit rights
npm run user passwd <username>           # change a user's password
npm run user remove <username>           # delete a user
npm run user list                        # list users + roles + effective access
```

Run `npm run user` (and `npm run role`) with no arguments to see every command. Accounts are
stored in `data/users.json` (passwords are bcrypt-hashed, never plaintext); roles in
`data/roles.json`.

---

## First-time setup & the admin panel

The app has **self-registration** and a built-in **admin panel** — you don't have to use
the command line for day-to-day user management.

1. Start the app and open it in a browser.
2. Click **注册新账号 (Register)** and create your account. **The very first account that
   registers automatically becomes the administrator** (full access).
3. After that, anyone else who registers gets a normal account with **no folder access
   until you grant it** — they'll see a "暂无可访问的文件夹" (no access yet) message.
4. As admin, click **管理后台 (Admin)** in the top bar to manage **roles** and **users**
   (create/delete, reset passwords, assign roles, grant extra folders). See the next section.

> Prefer the command line? You can still create the first admin with
> `npm run user add-admin <username>` and manage everything via the `npm run user` /
> `npm run role` commands. The admin panel is just a friendlier front end for the same stores.

---

## Roles & per-user folder permissions

Access is built from **roles** plus optional **per-user extra folders**:

- A **role** is a *named bundle of folders* — e.g. role `销售部` → `/Sales`, `/Reports` —
  optionally flagged as **editable** (members can upload/replace/delete in those folders).
- A user can be assigned **multiple roles** and gets the **union** of all their folders.
- A user can **also** be granted **extra individual folders** directly, each optionally
  **editable**, on top of their roles.
- **Effective read access = (all roles' folders) ∪ (extra folders).**
  **Effective edit access = (edit-enabled roles' folders) ∪ (extra folders marked editable).**
  Admins always see and can edit the whole share. A user with nothing assigned sees nothing.

So you can, for example, give someone read-only access via the `销售部` role *and*
additionally open one specific project folder for them with **edit** rights — at the same time.

A restricted user gets a **virtual home** listing only their allowed folders, and **cannot
navigate above them** — parent directories are never shown and are blocked server-side
(including `../` tricks).

### Automatic folders

The app creates folders under the share root automatically so structure follows permissions:

- **Every role → a shared folder `/<role name>`.** When you create a role (panel or CLI), a
  folder named after it is created under the share root and added to the role, so **everyone
  with that role can use it** as a shared space. (Deleting a role does **not** delete its
  folder, to avoid data loss.)
- **The `員工` (employee) role is built in.** New self-registered accounts get **no access at
  all** until an **admin verifies them by assigning the `員工` role** (or any other role/folder).
  This stops anyone who registers from reaching company files. The moment an admin adds a user
  to `員工`, they receive the shared **`/員工`** folder **and a private folder named after their
  username** (`/<username>`) that **only they and admins can see** — their own space to store
  files. (The first-ever account is the admin and is exempt.)
- Admins keep **full manual control** on top of all this: you can still add or remove any
  role's folders, assign extra folders to individual users, and toggle edit rights — the
  automatic folders are just sensible defaults, not a restriction.
- Once a user has a personal folder, a **📁 我的文件夹** button appears in the top bar that
  jumps straight to it. (Hidden for admins and for users without one.)

### Admin reports: storage usage & activity

The admin panel header has two report buttons:

- **📊 存储用量** — how much disk space is used, broken down **per role** (the role's shared
  folders) and **per user** (their personal folder + any individually-granted folders). Shared
  role space is counted under the role, not double-counted onto each member.
- **🕒 活动统计** — per user: modification counts (uploads / replaces / deletes / new folders),
  a separate **download** count, bytes uploaded, and last-activity time, over a selectable
  window (24 hours / 7 days / 30 days / all time).
- **📜 审计日志** — the full audit trail: the individual events (newest first) showing **who**,
  **when**, **what action** (incl. **downloads**), the **file/folder path**, and the **size**.
  Filter by time window, by action type, and by username.

Both reports are backed by an append-only log at `data/audit.log` that records every write
**and download** action. (Downloads are tracked separately from modifications, since they
don't change anything.)

> Personal folders are named exactly after the username. Avoid creating a user whose name
> collides with an existing top-level folder (e.g. a department folder), or they'd be given
> that folder as their "personal" one.

### In the admin panel (easiest)

- **角色管理 (Roles):** click **新建角色**, name it, and add folders with **浏览并添加文件夹**
  (browse the real share to pick them). Tick **允许该角色编辑其文件夹** to make the role's
  folders editable. Edit or delete roles anytime — deleting a role automatically removes it
  from every user.
- **用户管理 (Users):** click **编辑权限** on a user to toggle admin, tick the **roles** they
  should have, and add any **extra folders** — each extra folder has a **可编辑** checkbox to
  grant edit on just that folder. The table shows each user's effective access.

### From the command line

```powershell
# Roles ("edit" makes the role's folders editable)
npm run role add 销售部 /Sales /Reports        # create a read-only role
npm run role add 编辑组 /Sales edit            # create a role whose folder is editable
npm run role set-edit 销售部 true              # turn edit on/off for an existing role
npm run role list                              # list roles (shows [可编辑] / [只读])

# Assign to users (paths/roles relative to SHARE_ROOT, forward slashes)
npm run user assign-role alice 销售部           # give alice a role
npm run user grant alice /Projects/Acme        # extra folder, read-only
npm run user grant alice /Projects/Acme edit   # extra folder, editable
npm run user access alice                      # show alice's roles, folders, read + edit access
```

> **Run the CLI in PowerShell, not Git Bash** — Git Bash rewrites a leading-slash argument
> like `/Sales` into a Windows path. PowerShell passes it through correctly.

## Editing files (upload / replace / delete)

Where a user has **edit rights** on a folder (via an edit-enabled role, or an extra folder
marked editable), the file browser shows extra controls inside that folder:

- **⬆ 上传文件** — upload one or more files into the current folder (streamed, large files OK).
- **＋ 新建文件夹** — create a subfolder.
- **替换** (on a file) — overwrite it with a newly chosen file.
- **删除** (on a file or folder) — delete it (folders are removed with their contents).

Users without edit rights on a folder simply don't see these controls, and the server
rejects any write attempt there. **Edit access is always a subset of read access**, and is
enforced server-side (with the same `../` traversal protection as reads). To **take back**
edit rights, untick the role's edit flag or the user's per-folder **可编辑** box.

**Note:** these app permissions sit *on top of* Windows/NTFS share permissions. The app can
only ever read/write what the Windows account running the server can — so that account needs
**write** permission on the share for editing to work (for read-only deployments, simply
grant no edit rights). App permissions let you show each user a **narrower** slice — they
cannot grant access the underlying account doesn't have.

---

## Binding the server to the SMB share

The app reads the share through its **UNC path** (`\\server\share`) using Node's file
APIs. There is no separate "SMB library" to configure — on Windows, the path *is* the
binding. Two things must line up:

**1. Point `SHARE_ROOT` at the UNC path** in your `.env`:

```ini
SHARE_ROOT=\\fileserver\shared
```

(Use the share's UNC path, not a mapped drive letter like `Z:` — drive mappings are
per-interactive-session and won't exist when the app runs as a service.)

**2. Make sure the Windows account that runs `npm start` can reach that share.**
SMB authentication happens at the OS level, not in the app, so you authenticate the
share *before*/*outside* the app:

- **Domain-joined server (simplest):** run the app under a Windows account that already
  has read access to `\\fileserver\shared`. Nothing else to do — it just works.

- **Need explicit credentials:** establish the connection once before starting the app:

  ```powershell
  net use \\fileserver\shared /user:DOMAIN\svc_fileapp *
  # (prompts for the password; omit * to be prompted differently)
  npm start
  ```

  To verify the binding is good before launching, list the share:

  ```powershell
  Get-ChildItem \\fileserver\shared
  ```

  If that lists files, the app will too. If it errors with "access denied", fix the
  Windows-side credentials first — the app cannot bypass them.

- **Always-on / service:** run the service under a dedicated Windows service account
  that has standing read access to the share (recommended), or persist the credential
  with `net use \\fileserver\shared /user:DOMAIN\svc_fileapp <pwd> /persistent:yes`.

> **Recommended setup:** create a dedicated, **read-only** domain account (e.g.
> `svc_fileapp`) with NTFS read access to the share, and run the app under it. The app
> never writes to the share, so it never needs write permission — and per-user app
> permissions then carve out who sees which subfolder.

---

## Running it as an always-on service (optional)

For production on Windows, wrap `npm start` with a process manager such as
[`pm2`](https://pm2.keymetrics.io/) or [NSSM](https://nssm.cc/) so it restarts on
reboot. Put it behind IIS/Nginx with HTTPS and set `SECURE_COOKIES=true`.

---

## Project layout

```
filebrowser/
  CLAUDE.md      Project memory / architecture notes
  server/
    index.js     HTTPS/HTTP server + static hosting + startup provisioning
    config.js    Loads/validates .env (incl. TLS settings)
    tls.js       Loads a real cert or generates/caches a self-signed one
    provision.js Auto-creates role/personal folders (員工 role logic)
    paths.js     Shared path-normalization helpers (normRoot / normFolders)
    roles.js     Role store (data/roles.json) — named bundles of folders
    users.js     User store (bcrypt) + effective-access computation
    auth.js      Login, register (auto-員工), logout, auth + admin guards
    admin.js     Admin-only API: users + roles CRUD + usage/activity reports
    audit.js     Append-only write-action log (data/audit.log) + activity aggregation
    usage.js     Storage-usage computation (bytes per role / per user)
    files.js     Directory listing + file download/upload/delete (permission-checked)
  scripts/
    manage-users.js   CLI: accounts, role assignment, extra folders (npm run user)
    manage-roles.js   CLI: create/edit/delete roles (npm run role)
  public/
    index.html   Login/register + file browser + admin panel
    styles.css   Clean UI styling
    app.js       Frontend logic
  data/          users.json + roles.json (gitignored)
```
