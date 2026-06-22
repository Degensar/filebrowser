# CLAUDE.md — 公司文件浏览器 (Company File Browser)

Project memory for Claude Code. Read this first when working in this repo.

## What this is

An internal web app for a **China-based company** that lets staff **browse and download**
files from a company **Windows / SMB file share**, and — where an admin has granted edit
rights — **upload, replace, and delete** files. Self-hosted, runs on Windows. The entire
**UI and all user-facing text must stay in Chinese (zh-CN)** — keep it that way for any new
strings (server error messages too).

## Deployment targets / compatibility constraints (do not regress)

- **Server runs on CentOS 7 (glibc 2.17) → must stay Node-16-compatible.** Official Node 18+
  won't run on CentOS 7. Don't use runtime features newer than Node 16 (e.g. `node --watch`,
  `structuredClone`, `Array.fromAsync`). `package.json` engines = `>=16`.
- **Clients include RHEL 7.6 (Firefox ESR, possibly v60) → frontend must stay ES2017.** No
  build step. **Do not use optional chaining (`?.`), nullish coalescing (`??`), `replaceAll`,**
  or other ES2020+ syntax in `public/*.js` — it white-screens old Firefox. `fetch`, `async`,
  arrow fns, template literals are fine. (Server-side `?.` is OK — Node 16 supports it.)
- Distributed storage works if mounted as a filesystem (CephFS/NFS/JuiceFS/SMB); point
  `SHARE_ROOT` at the mount. Object-storage-only (S3 API) would need a storage-layer rewrite.
  Multiple app instances would need shared/DB-backed user+role state (currently local JSON).

## Stack & conventions

- **Backend:** Node.js + Express (ES modules, `"type": "module"`). All dependencies are
  pure-JS (no native builds): `express`, `bcryptjs`, `jsonwebtoken`, `cookie-parser`,
  `dotenv`.
- **Frontend:** plain HTML/CSS/JS in `public/` — **no build step, no framework**. Keep it
  that way; it's served statically by Express.
- **No database:** state is JSON files in `data/` (`users.json`, `roles.json`).
- **China accessibility:** **never add external CDNs / Google Fonts / remote assets** — they
  are blocked in China. Everything must be self-hosted. Fonts use a Chinese-friendly system
  stack (Microsoft YaHei / PingFang). Dates use the `zh-CN` locale.

## Auto-provisioned folders (roles & employees)

`server/provision.js` creates real folders under the share root and wires up grants:

- **`EMPLOYEE_ROLE = "員工"`** is hardcoded. **New registrants do NOT auto-join it** — they
  register with zero access; an **admin must add them to `員工`** (panel/CLI) to verify them.
  This is deliberate: self-registration must not grant access to company files. When a user is
  added to `員工` (or any role change), `provisionUser` (called from `admin.js` and the
  `assign-role` CLI) creates their personal **`/<username>`** folder, granted only to them
  (writable) — so only they + admins see it. They also get the role's shared **`/員工`** folder.
- `auth.accountInfo()` exposes a **`personalFolder`** field (`/<username>` or `null`); the
  frontend renders a **📁 我的文件夹** top-bar button that jumps there (hidden when `null`).
- **Every role** gets a shared folder **`/<roleName>`** auto-created and added to the role's
  folder list (`ensureRoleFolder`), so all members can access it. Called from role creation
  in `admin.js` and `manage-roles.js`, and at startup for `員工` (`provisionStartup`).
- Folder names are sanitized to a single safe segment (no separators / traversal).
- Provisioning is **best-effort**: a failure (offline/read-only share) logs a warning but
  never blocks registration or role creation. Deleting a role does **not** delete its folder
  (avoid data loss); admins still fully control grants on top of all this.
- **Caveat:** a personal folder is `/<username>`; if a username collides with an existing
  top-level folder name, the user would gain access to it. Usernames are `[a-z0-9._-]`.

## Home view — Synology-style "drives" (non-admin)

A non-admin user's home (`GET /api/files?path=/`) is a **virtual home** that groups their
accessible top-level folders into Synology-Drive-style sections instead of a flat list:
**我的文件** (personal `/<username>` folder), **部门 / 团队文件夹** (folders from their
roles), and **共享文件夹** (extra folders granted directly, outside any role). The split is
computed by `users.driveSections(user)` (paths only); `files.js` stats each for mtime and adds
a `write` flag (`isAllowed(path, effectiveWriteRoots)`). The response carries a `drives` array
(`{key,title,icon,hint,entries[]}`); `app.js` `renderDrives()` draws each section as a grid of
folder cards, with a **可管理** badge on cards the user may edit (e.g. a department head's
folder). Empty for everyone ⇒ the existing 🔒 no-access state. **Admins keep the full-share
table at `/`** (they browse everything; the grouping is for ordinary users).

## Delegated department management (department heads)

A **department head** (主管 — a non-admin in `role.leaders`) can manage access *for the
departments they lead*, without being a full admin. `server/dept.js` exposes `/api/dept/*`
(auth required, **not** admin-only); each route re-checks that the caller heads the target
role (`authorizeHead`). A head can: add/remove **ordinary members** (assign/unassign the
role) and toggle a member's **editor** status (`role.editors`, granting write on the
department's folders). The frontend shows a **👑 部门管理** top-bar button when
`accountInfo.headOf` (= `users.headedRoles`) is non-empty; it opens a modal (`openDeptModal`
in `app.js`) listing each headed department with its members and an add-member picker.

**Security scoping — heads cannot escalate.** A head may only touch roles they lead, and only
membership + the editor flag. They **cannot**: change the admin flag or modify any admin
account (every dept route rejects admin targets), grant leadership (`role.leaders` is
admin-only), grant folders outside the department, remove a fellow head, or act on roles they
don't head. A head's reach is bounded by their own department's folders — so a head is only
as powerful as the folders an admin assigned to that department (caveat: a department whose
folders include `/` would let its head grant broad access; don't put `/` on a led role).

API: `GET /api/dept/mine`, `POST /api/dept/:role/members` (`{username}`),
`DELETE /api/dept/:role/members/:username`, `PUT /api/dept/:role/members/:username`
(`{editor}`).

## How files are accessed (SMB)

There is **no SMB library**. On Windows the UNC path *is* the binding: `SHARE_ROOT` in
`.env` points at e.g. `\\fileserver\shared`, and Node's `fs` reads it using the Windows
account that runs the server. Auth to the share is done at the OS level (`net use` or a
service account) — outside the app. The app is **read-only**; it never writes to the share.

## Permission model (important)

Two layers: **read access** (which folders you can see/download) and **write/edit access**
(upload / replace / delete inside a folder). Write is always a subset of read.

- **Roles** (`data/roles.json`): a named bundle of folders, e.g. `销售部 → [/Sales, /Reports]`,
  plus a `canEdit` boolean and a `leaders[]` list. If `canEdit` is true, **all** members can
  edit that role's folders. `leaders[]` (部门主管 / department heads) is a list of usernames
  who can manage (upload/replace/delete) the role's folders **even when `canEdit` is false** —
  this is how a head of department gets write rights to their department folder while ordinary
  members stay read-only. Managed in the role modal (a non-admin user checklist) and via
  `npm run role set-heads <role> [users...]`. Roles also carry `editors[]` — members a
  **department head** has granted edit rights to (see *Delegated department management* below);
  they too get write on the role's folders.
- **Users** (`data/users.json`): each has `admin` (bool), `roleNames[]`, and
  `extraFolders[]` — where each extra folder is `{ path, write }` (per-folder edit toggle).
- **Effective READ access** (non-admin) = union of all assigned roles' folders **+** the
  user's extra-folder paths. → `users.effectiveRoots()`.
- **Effective WRITE access** (non-admin) = folders of **edit-enabled roles** (`canEdit`)
  **+** folders of roles where the user is a **department head** (`role.leaders`) **or a
  head-granted editor** (`role.editors`) **+** extra folders where `write === true`.
  → `users.effectiveWriteRoots()`.
- Admins always get the whole share (`["/"]`) for both read and write.
- These two functions in `users.js` are the single source of truth used by `files.js`.
- Folder paths are normalized to `/a/b` by `paths.js` (`normRoot`, `normFolders`); `/` means
  the whole share. Extra folders are normalized by `users.normExtra()` (handles legacy
  `string[]` → `{path, write}` migration).
- **Self-registration:** the **first** account to register becomes the admin; everyone else
  registers with **no access** until an admin grants roles/folders.
- Admin "takes back" edit rights by unchecking a role's `canEdit` or a user folder's `write`.

## Security invariants — do not regress

- `files.js` **canonicalizes the path first** (`resolveSafe` resolves `..` and confines to
  `SHARE_ROOT`) and **only then** checks permission against the canonical relative path.
  A previous bug let `/Sales/../HR` escape a grant — keep the canonicalize-before-check order.
  This applies to **write routes too** (`authorizeWrite` resolves before checking write roots).
- Write/delete operations refuse to act on the share root itself (`mustNotBeRoot`).
- The breadcrumb is computed **server-side** so restricted users never see parent folders
  above their allowed roots.
- Guards: cannot delete/demote the **last admin**; cannot delete/demote **yourself**.
- New registrants get zero access by default (registration cannot self-grant files).
- Uploads are **streamed** (`req.pipe` → write stream) — no extra dependency, handles large
  files. `express.json()` ignores the `application/octet-stream` body so the stream is intact.

## Layout

```
server/
  index.js   HTTP server, static hosting, startup provisioning
  config.js  Loads/validates .env (SHARE_ROOT, JWT_SECRET, ...)
  provision.js  Auto-creates role/personal folders + grants (員工 role logic)
  paths.js   normRoot / normFolders (shared path helpers)
  roles.js   roles store (data/roles.json)
  users.js   user store + effectiveRoots() + describeAccess()
  auth.js    login / register / logout, requireAuth, requireAdmin
  admin.js   admin-only API: users + roles CRUD
  dept.js    delegated department management API for department heads (主管)
  files.js   listing + download, per-user permission checks, traversal guard
scripts/
  manage-users.js   `npm run user ...`  (accounts, role assignment, extra folders)
  manage-roles.js   `npm run role ...`  (create/edit/delete roles)
public/      index.html + styles.css + app.js  (login/register, browser, admin panel)
```

## API surface

- `POST /api/auth/{login,register,logout}`, `GET /api/auth/me`
- `GET /api/files?path=` (returns `canWrite` for the folder), `GET /api/download?path=`
- Write (auth + write-permission on target):
  - `PUT /api/file?path=` — create/overwrite a file (raw body = bytes; upload & replace)
  - `DELETE /api/file?path=` — delete a file or folder (recursive for folders)
  - `POST /api/folder?path=` — create a folder
- Admin (admin only):
  - `GET/POST /api/admin/users`, `PUT/DELETE /api/admin/users/:username`,
    `POST /api/admin/users/:username/password`
    (`PUT` body: `{ admin?, roleNames?, extraFolders:[{path,write}] }`)
  - `GET/POST /api/admin/roles`, `PUT /api/admin/roles/:name` (`{folders?, canEdit?, leaders?}`),
    `DELETE /api/admin/roles/:name`
  - `GET /api/admin/usage` — storage bytes per role + per user (`usage.js`, walks the share)
  - `GET /api/admin/activity?days=1|7|30|all` — write-action counts per user (`audit.js`)
  - `GET /api/admin/audit?days=&user=&action=&limit=` — full audit trail, newest-first,
    filterable (`audit.queryEntries`); returns `{entries, matched, truncated}`

## Reports (storage usage + activity)

- `server/audit.js` appends every write (upload/replace/delete/mkdir) **and download** to
  `data/audit.log` (JSON Lines: `{ts,user,action,path,bytes}`), fire-and-forget from `files.js`
  (the `GET /download` handler logs `action:'download'`). `queryActivity` aggregates per user
  over a window — downloads are counted **separately** (`download` / `downloadBytes`), not in
  the modification `total`. **Rotated by size**: when the file passes `config.auditMaxBytes`
  (`AUDIT_MAX_SIZE_MB`, default 10 MB) it becomes `audit.log.1`, `.2`, … keeping
  `config.auditMaxFiles` archives (`AUDIT_MAX_FILES`, default 5). `logAction` tracks size
  in-memory (no per-write `stat`) and calls a synchronous `rotate()` when over cap.
  `queryActivity`/`queryEntries` read across current + rotated files (`readAllLines`), so
  reports keep recent history. `AUDIT_MAX_SIZE_MB=0` disables the cap.
- `server/usage.js` `computeUsage()` walks folders (recursive `dirSize`, skips symlinks) to
  total bytes **per role** (role.folders) and **per user** (their extraFolders / personal
  folder). Shared role space is attributed to the role, not duplicated onto each member.
  On-demand and uncached — can be slow on a huge share.
- Admin UI: **📊 存储用量**, **🕒 活动统计**, and **📜 审计日志** buttons in the admin header
  open `.modal.wide` report tables (`openUsageModal` / `openActivityModal` / `openAuditModal`
  in `app.js`). The audit view has period/action/user filters and colour-coded action badges.

## Running / testing

- Start: `npm start` (port from `.env`, default 3000). Stop: Ctrl+C, or kill the process on
  the port (`Get-NetTCPConnection -LocalPort 3000 ... Stop-Process`).
- On this dev machine `.env` `SHARE_ROOT` points at `C:\working\testing folder`; real deploys
  use the `\\fileserver\shared` UNC path. `data/*.json` is gitignored and may be reset.
- **Do NOT wipe `data/users.json` / `data/roles.json`** — they hold the user's real accounts.
  Clean up only the specific test users/roles you create (via `npm run user/role remove`).
- Manual end-to-end testing has been done via curl + the Preview tool (login/register,
  admin panel, role assignment, folder picker, traversal-attack 403s).

## Gotchas

- **Git Bash mangles leading-slash args** (e.g. `/Sales` → `C:/Program Files/Git/Sales`).
  Run the `npm run user/role` CLI in **PowerShell**, not Git Bash, when passing folder paths.
- Keep all new UI/error text in **Chinese**.
