import {Router} from 'express';
import fs from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import {type AuthRequest, hashPassword, requireAdmin, requireAuth} from '../auth.ts';
import {COOKIES_FILE, db, getAllSettings, getMusicDir, setSetting} from '../db.ts';
import {checkBinariesStatus, testCookiesFile, updateYtdlpBinary} from '../downloader.ts';
import {getScanState, runLibraryScan, scanEvents, type ScanProgress} from '../scanner.ts';

export const adminRouter = Router();
const memoryUpload = multer({storage: multer.memoryStorage(), limits: {fileSize: 5 * 1024 * 1024}});

function inspectMountHealth(targetPath: string) {
  const resolved = path.resolve(targetPath);
  let status: 'ok' | 'read-only' | 'not-found' = 'not-found';
  let exists = false;
  let readable = false;
  let writable = false;
  let freeBytes: number | null = null;
  let totalBytes: number | null = null;

  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      exists = true;
      try {
        fs.accessSync(resolved, fs.constants.R_OK);
        readable = true;
      } catch {
        readable = false;
      }
      try {
        fs.accessSync(resolved, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }

      if (readable && writable) status = 'ok';
      else if (readable) status = 'read-only';
      else status = 'not-found';

      if (typeof fs.statfsSync === 'function') {
        try {
          const statfs = fs.statfsSync(resolved);
          freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
          totalBytes = Number(statfs.blocks) * Number(statfs.bsize);
        } catch {
          // statfs optional on some virtual filesystems
        }
      }
    }
  } catch {
    status = 'not-found';
  }

  return {
    path: resolved,
    exists,
    readable,
    writable,
    status,
    freeBytes,
    totalBytes,
  };
}

// Lightweight system info available to authenticated users (for Downloader banner & Settings)
adminRouter.get('/public-info', requireAuth, async (_req, res) => {
  const binaries = await checkBinariesStatus();
  res.json({
    musicDir: getMusicDir(),
    ytdlpInstalled: binaries.ytdlp.installed,
    ffmpegInstalled: binaries.ffmpeg.installed,
  });
});

adminRouter.get('/settings', requireAdmin, (_req, res) => {
  res.json({settings: getAllSettings()});
});

const ALLOWED_SETTINGS_KEYS = new Set([
  'music_dir',
  'ytdlp_path',
  'ffmpeg_path',
  'ytdlp_remote_components',
  'ytdlp_player_client',
  'ytdlp_sleep_interval',
  'ytdlp_max_sleep_interval',
  'ytdlp_force_ipv4',
  'ytdlp_extra_flags',
  'ytdlp_crop_cover',
]);

adminRouter.put('/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  for (const [key, val] of Object.entries(body)) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) continue;
    let strVal = String(val ?? '').trim();
    if (key === 'music_dir' && strVal) {
      strVal = path.resolve(strVal);
    }
    setSetting(key, strVal);
  }
  res.json({
    settings: getAllSettings(),
    mountHealth: inspectMountHealth(getMusicDir()),
  });
});

adminRouter.get('/mount-health', requireAdmin, (req, res) => {
  const queryPath = typeof req.query.path === 'string' && req.query.path.trim()
    ? req.query.path.trim()
    : getMusicDir();
  res.json(inspectMountHealth(queryPath));
});

adminRouter.get('/browse-dirs', requireAdmin, (req, res) => {
  const requested = typeof req.query.path === 'string' && req.query.path.trim()
    ? req.query.path.trim()
    : getMusicDir();

  let currentPath = path.resolve(requested);
  if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) {
    currentPath = fs.existsSync('/mnt') ? '/mnt' : os.homedir();
  }

  const parentPath = path.dirname(currentPath) !== currentPath ? path.dirname(currentPath) : null;
  const entries: Array<{name: string; path: string; readable: boolean; writable: boolean}> = [];

  try {
    const dirents = fs.readdirSync(currentPath, {withFileTypes: true});
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith('.') && currentPath === '/') continue;
      const full = path.join(currentPath, d.name);
      let readable = false;
      let writable = false;
      try {
        fs.accessSync(full, fs.constants.R_OK);
        readable = true;
      } catch {
        readable = false;
      }
      try {
        fs.accessSync(full, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
      entries.push({name: d.name, path: full, readable, writable});
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    res.status(400).json({
      error: `Cannot read directory ${currentPath}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const quickPaths = [
    {label: 'Active Mount', path: getMusicDir()},
    {label: '/mnt', path: '/mnt'},
    {label: '/media', path: '/media'},
    {label: 'App Library', path: path.resolve(process.cwd(), 'music_library')},
    {label: '/', path: '/'},
  ].filter((q, idx, arr) => fs.existsSync(q.path) && arr.findIndex((x) => x.path === q.path) === idx);

  res.json({
    currentPath,
    parentPath,
    entries,
    quickPaths,
    health: inspectMountHealth(currentPath),
  });
});

adminRouter.post('/scan', requireAdmin, (req, res) => {
  const fullReindex = Boolean(req.body?.fullReindex);
  void runLibraryScan(fullReindex);
  res.json({scan: getScanState()});
});

adminRouter.get('/scan/events', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (state: ScanProgress) => {
    res.write(`event: progress\ndata: ${JSON.stringify(state)}\n\n`);
  };

  send(getScanState());

  scanEvents.on('progress', send);
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    scanEvents.off('progress', send);
  });
});

adminRouter.get('/system-status', requireAdmin, async (_req, res) => {
  const binaries = await checkBinariesStatus();
  const trackCount = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as {c: number}).c;
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as {c: number}).c;
  res.json({
    ...binaries,
    musicDir: getMusicDir(),
    mountHealth: inspectMountHealth(getMusicDir()),
    trackCount,
    userCount,
    scan: getScanState(),
  });
});

// Cookies management
adminRouter.post('/cookies', requireAdmin, memoryUpload.single('file'), (req, res) => {
  let content = '';
  if (req.file && req.file.buffer) {
    content = req.file.buffer.toString('utf-8');
  } else if (typeof req.body?.content === 'string') {
    content = req.body.content;
  }

  content = content.trim();
  if (!content) {
    res.status(400).json({error: 'Cookies content is empty'});
    return;
  }

  // Basic Netscape cookies format check (allow header or tab-separated lines)
  const hasNetscapeLines =
    content.includes('# Netscape HTTP Cookie File') ||
    content.split('\n').some((line) => line.split('\t').length >= 6);
  if (!hasNetscapeLines) {
    res.status(400).json({
      error: 'Invalid format. Please provide a valid Netscape-format cookies.txt file.',
    });
    return;
  }

  fs.writeFileSync(COOKIES_FILE, content + '\n', {mode: 0o600});
  try {
    fs.chmodSync(COOKIES_FILE, 0o600);
  } catch {
    // Ignore chmod errors on non-POSIX filesystems
  }
  setSetting('cookies_status', 'untested');
  res.json({ok: true, status: 'untested'});
});

adminRouter.delete('/cookies', requireAdmin, (_req, res) => {
  if (fs.existsSync(COOKIES_FILE)) {
    fs.unlinkSync(COOKIES_FILE);
  }
  setSetting('cookies_status', 'missing');
  setSetting('cookies_tested_at', '');
  res.json({ok: true});
});

adminRouter.post('/cookies/test', requireAdmin, async (_req, res) => {
  const result = await testCookiesFile();
  res.json(result);
});

adminRouter.post('/ytdlp/update', requireAdmin, async (_req, res) => {
  const result = await updateYtdlpBinary();
  res.json(result);
});

// User management
adminRouter.get('/users', requireAdmin, (_req, res) => {
  const rows = db
    .prepare('SELECT id, username, role, can_download, created_at FROM users ORDER BY id ASC')
    .all() as Array<{
    id: number;
    username: string;
    role: 'admin' | 'listener';
    can_download: number;
    created_at: string;
  }>;
  res.json({
    users: rows.map((u) => ({
      ...u,
      can_download: Boolean(u.can_download) || u.role === 'admin',
    })),
  });
});

adminRouter.post('/users', requireAdmin, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const role = req.body?.role === 'admin' ? 'admin' : 'listener';
  const canDownload = role === 'admin' ? 1 : req.body?.can_download ? 1 : 0;

  if (username.length < 3 || username.length > 32) {
    res.status(400).json({error: 'Username must be between 3 and 32 characters'});
    return;
  }
  if (password.length < 6) {
    res.status(400).json({error: 'Password must be at least 6 characters'});
    return;
  }

  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role, can_download) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password), role, canDownload);
    const created = db
      .prepare('SELECT id, username, role, can_download, created_at FROM users WHERE id = ?')
      .get(info.lastInsertRowid) as {
      id: number;
      username: string;
      role: 'admin' | 'listener';
      can_download: number;
      created_at: string;
    };
    res.status(201).json({
      user: {...created, can_download: Boolean(created.can_download) || created.role === 'admin'},
    });
  } catch {
    res.status(409).json({error: 'A user with that username already exists'});
  }
});

adminRouter.put('/users/:id', requireAdmin, (req: AuthRequest, res) => {
  const targetId = Number(req.params.id);
  const existing = db
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .get(targetId) as {id: number; role: string} | undefined;

  if (!existing) {
    res.status(404).json({error: 'User not found'});
    return;
  }

  if (typeof req.body?.newPassword === 'string' && req.body.newPassword.length > 0) {
    if (req.body.newPassword.length < 6) {
      res.status(400).json({error: 'Password must be at least 6 characters'});
      return;
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(req.body.newPassword),
      targetId
    );
  }

  if (req.body?.role === 'admin' || req.body?.role === 'listener') {
    if (targetId === req.user!.id && req.body.role !== 'admin') {
      res.status(400).json({error: 'You cannot demote your own admin account'});
      return;
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, targetId);
  }

  if (typeof req.body?.can_download === 'boolean') {
    db.prepare('UPDATE users SET can_download = ? WHERE id = ?').run(
      req.body.can_download ? 1 : 0,
      targetId
    );
  }

  res.json({ok: true});
});

adminRouter.delete('/users/:id', requireAdmin, (req: AuthRequest, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user!.id) {
    res.status(400).json({error: 'You cannot delete your own account'});
    return;
  }
  const target = db
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .get(targetId) as {id: number; role: string} | undefined;
  if (!target) {
    res.status(404).json({error: 'User not found'});
    return;
  }
  if (target.role === 'admin') {
    const adminCount = (
      db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as {c: number}
    ).c;
    if (adminCount <= 1) {
      res.status(400).json({error: 'Cannot delete the last admin account'});
      return;
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ok: true});
});
