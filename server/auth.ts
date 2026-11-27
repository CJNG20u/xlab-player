import bcrypt from 'bcryptjs';
import type {NextFunction, Request, Response} from 'express';
import jwt from 'jsonwebtoken';
import {db, getJwtSecret} from './db.ts';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'listener';
  can_download: boolean;
  full_library: boolean;
  created_at: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

const COOKIE_NAME = 'xlab_token';
const TOKEN_TTL = '30d';

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function signToken(userId: number): string {
  return jwt.sign({sub: userId}, getJwtSecret(), {expiresIn: TOKEN_TTL});
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {path: '/'});
}

export function extractToken(req: Request): string | null {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  // 2. HTTP-only cookie
  if (req.cookies && typeof req.cookies[COOKIE_NAME] === 'string') {
    return req.cookies[COOKIE_NAME];
  }
  // 3. Query param fallback for <audio> / EventSource in cross-origin contexts
  if (typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return null;
}

export function resolveUserFromRequest(req: Request): AuthUser | null {
  const token = extractToken(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret()) as unknown as {sub?: number | string};
    const userId = Number(payload?.sub);
    if (!Number.isFinite(userId)) return null;
    const row = db
      .prepare('SELECT id, username, role, can_download, full_library, created_at FROM users WHERE id = ?')
      .get(userId) as
      | {
          id: number;
          username: string;
          role: 'admin' | 'listener';
          can_download: number;
          full_library: number;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      can_download: Boolean(row.can_download) || row.role === 'admin',
      full_library: Boolean(row.full_library) || row.role === 'admin',
      created_at: row.created_at,
    };
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({error: 'Admin privileges required'});
    return;
  }
  req.user = user;
  next();
}

export function requireDownloadPermission(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const user = resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  if (user.role !== 'admin' && !user.can_download) {
    res.status(403).json({error: 'Download permission is not enabled for your account'});
    return;
  }
  req.user = user;
  next();
}
