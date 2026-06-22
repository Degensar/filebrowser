import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import {
  verifyCredentials,
  findUser,
  addUser,
  countUsers,
  isAdmin,
  effectiveRoots,
  headedRoles,
} from './users.js';

const COOKIE_NAME = 'fb_session';

export const authRouter = express.Router();

function issueSession(res, username) {
  const token = jwt.sign({ sub: username }, config.jwtSecret, {
    expiresIn: `${config.sessionHours}h`,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: config.sessionHours * 60 * 60 * 1000,
  });
}

// Shape of the "who am I" response used by the frontend to decide what to show.
function accountInfo(user) {
  const admin = isAdmin(user);
  // The personal folder "/<username>" exists only if it was granted (i.e. the
  // user has been added to the 員工 role). Admins don't get a personal folder.
  const personal = '/' + user.username;
  const personalFolder =
    !admin && (user.extraFolders || []).some((f) => f.path === personal) ? personal : null;
  return {
    username: user.username,
    isAdmin: admin,
    // A non-admin has access only if their roles/extra folders resolve to something.
    hasAccess: admin || effectiveRoots(user).length > 0,
    personalFolder,
    // Departments this user heads (主管) — non-empty enables the 部门管理 button.
    headOf: headedRoles(user),
  };
}

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码。' });
  }
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: '用户名或密码错误。' });
  }
  const user = findUser(username);
  issueSession(res, user.username);
  res.json({ ok: true, ...accountInfo(user) });
});

// Self-registration. The first account becomes the admin. Everyone else is
// created with NO access and NO role — an admin must verify them by adding the
// "員工" role (or other roles/folders) before they can see any content. This
// prevents anyone who registers from reaching company files.
authRouter.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码。' });
  }
  const bootstrap = countUsers() === 0;
  try {
    const created = addUser(username, password, { admin: bootstrap });
    const user = findUser(created);
    issueSession(res, user.username);
    res.json({ ok: true, bootstrap, ...accountInfo(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = findUser(req.user);
  if (!user) return res.status(401).json({ error: '未登录。' });
  res.json(accountInfo(user));
});

// Middleware: rejects unauthenticated requests.
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: '未登录。' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = payload.sub;
    next();
  } catch {
    res.clearCookie(COOKIE_NAME);
    res.status(401).json({ error: '登录已过期，请重新登录。' });
  }
}

// Middleware: requires the authenticated user to be an admin.
export function requireAdmin(req, res, next) {
  const user = findUser(req.user);
  if (!isAdmin(user)) {
    return res.status(403).json({ error: '需要管理员权限。' });
  }
  next();
}
