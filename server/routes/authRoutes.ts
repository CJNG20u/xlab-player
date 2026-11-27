import {Router} from 'express';
import {
  type AuthRequest,
  clearAuthCookie,
  hashPassword,
  requireAuth,
  resolveUserFromRequest,
  setAuthCookie,
  signToken,
  verifyPassword,
} from '../auth.ts';
import {db} from '../db.ts';

export const authRouter = Router();

authRouter.get('/status', (req, res) => {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM users').get() as {count: number};
  const user = resolveUserFromRequest(req);
  res.json({
    hasUsers: countRow.count > 0,
    user,
  });
});

authRouter.post('/setup', (req, res) => {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM users').get() as {count: number};
  if (countRow.count > 0) {
    res.status(409).json({error: 'Initial admin account has already been created'});
    return;
  }

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (username.length < 3 || username.length > 32) {
    res.status(400).json({error: 'Username must be between 3 and 32 characters'});
    return;
  }
  if (password.length < 6) {
    res.status(400).json({error: 'Password must be at least 6 characters'});
    return;
  }

  const hash = hashPassword(password);
  const info = db
    .prepare(
      "INSERT INTO users (username, password_hash, role, can_download) VALUES (?, ?, 'admin', 1)"
    )
    .run(username, hash);

  const user = {
    id: Number(info.lastInsertRowid),
    username,
    role: 'admin' as const,
    can_download: true,
    full_library: true,
    created_at: new Date().toISOString(),
  };

  const token = signToken(user.id);
  setAuthCookie(res, token);
  res.status(201).json({user, token});
});

authRouter.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!username || !password) {
    res.status(400).json({error: 'Username and password are required'});
    return;
  }

  const row = db
    .prepare(
      'SELECT id, username, password_hash, role, can_download, full_library, created_at FROM users WHERE username = ?'
    )
    .get(username) as
    | {
        id: number;
        username: string;
        password_hash: string;
        role: 'admin' | 'listener';
        can_download: number;
        full_library: number;
        created_at: string;
      }
    | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({error: 'Invalid username or password'});
    return;
  }

  const user = {
    id: row.id,
    username: row.username,
    role: row.role,
    can_download: Boolean(row.can_download) || row.role === 'admin',
    full_library: Boolean(row.full_library) || row.role === 'admin',
    created_at: row.created_at,
  };

  const token = signToken(user.id);
  setAuthCookie(res, token);
  res.json({user, token});
});

authRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ok: true});
});

authRouter.get('/me', requireAuth, (req: AuthRequest, res) => {
  res.json({user: req.user});
});

authRouter.post('/password', requireAuth, (req: AuthRequest, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');

  if (newPassword.length < 6) {
    res.status(400).json({error: 'New password must be at least 6 characters'});
    return;
  }

  const row = db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(req.user!.id) as {password_hash: string} | undefined;

  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({error: 'Current password is incorrect'});
    return;
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(newPassword),
    req.user!.id
  );
  res.json({ok: true});
});
