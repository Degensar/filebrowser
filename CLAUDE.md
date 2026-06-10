# CLAUDE.md — 公司文件浏览器 (Company File Browser)

Project memory for Claude Code. Read this first when working in this repo.

## What this is

An internal web app for a **China-based company** that lets staff **browse and download**
files from a company **Windows / SMB file share**, and — where an admin has granted edit
rights — **upload, replace, and delete** files. Self-hosted, runs on Windows. The entire
**UI and all user-facing text must stay in Chinese (zh-CN)** — keep it that way for any new
strings (server error messages too).

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

## How files are accessed (SMB)

There is **no SMB library**. On Windows the UNC path *is* the binding: `SHARE_ROOT` in
`.env` points at e.g. `\\fileserver\shared`, and Node's `fs` reads it using the Windows
account that runs the server. Auth to the share is done at the OS level (`net use` or a
service account) — outside the app. The app is **read-only**; it never writes to the share.

## Permission model (important)

Two layers: **read access** (which folders you can see/download) and **write/edit access**
(upload / replace / delete inside a folder). Write is always a subset of read.

- **Roles** (`data/roles.json`): a named bundle of folders, e.g. `销售部 → [/Sales, /Reports]`,
  plus a `canEdit` boolean. If `canEdit` is true, members can edit that role's folders.
- **Users** (`data/users.json`): each has `admin` (bool), `roleNames[]`, and
  `extraFolders[]` — where each extra folder is `{ path, write }` (per-folder edit toggle).
- **Effective READ access** (non-admin) = union of all assigned roles' folders **+** the
  user's extra-folder paths. → `users.effectiveRoots()`.
- **Effective WRITE access** (non-admin) = folders of **edit-enabled roles** (`canEdit`)
  **+** extra folders where `write === true`. → `users.effectiveWriteRoots()`.
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
  index.js   Express app + static hosting
  config.js  Loads/validates .env (SHARE_ROOT, JWT_SECRET, ...)
  paths.js   normRoot / normFolders (shared path helpers)
  roles.js   roles store (data/roles.json)
  users.js   user store + effectiveRoots() + describeAccess()
  auth.js    login / register / logout, requireAuth, requireAdmin
  admin.js   admin-only API: users + roles CRUD
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
  - `GET/POST /api/admin/roles`, `PUT /api/admin/roles/:name` (`{folders?, canEdit?}`),
    `DELETE /api/admin/roles/:name`

## Running / testing

- Start: `npm start` (port from `.env`, default 3000). Stop: Ctrl+C, or kill the process on
  the port (`Get-NetTCPConnection -LocalPort 3000 ... Stop-Process`).
- On this dev machine `.env` `SHARE_ROOT` points at `C:\working` for testing; real deploys
  use the `\\fileserver\shared` UNC path. `data/*.json` is gitignored and may be reset.
- Manual end-to-end testing has been done via curl + the Preview tool (login/register,
  admin panel, role assignment, folder picker, traversal-attack 403s).

## Gotchas

- **Git Bash mangles leading-slash args** (e.g. `/Sales` → `C:/Program Files/Git/Sales`).
  Run the `npm run user/role` CLI in **PowerShell**, not Git Bash, when passing folder paths.
- Keep all new UI/error text in **Chinese**.
