import crypto from 'crypto';
import {type Response, Router} from 'express';
import fs from 'fs';
import path from 'path';
import {type AuthRequest, requireAuth} from '../auth.ts';
import {COVERS_DIR, db, getMusicDir} from '../db.ts';
import {hasFullLibrary, isTrackVisibleToUser, visibleTrackClause} from '../trackAccess.ts';
import {canManagePlaylist, canViewPlaylist, parseVisibility} from '../playlistAccess.ts';
import {deviceHub} from '../deviceHub.ts';
import {
  DuplicateResolveError,
  findDuplicateGroupsForUser,
  releaseBulkDedupeLock,
  resolveAllSafeDuplicatesAsync,
  resolveDuplicatePair,
  tryAcquireBulkDedupeLock,
} from '../duplicates.ts';
import {resolveTrackLyrics} from '../lyrics.ts';

export const libraryRouter = Router();

const MIME_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm; codecs=opus',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

// 2 MB default window for open-ended Range requests (`bytes=start-`) so mobile
// players can seek instantaneously across large FLAC/M4A/OPUS files.
const DEFAULT_OPEN_RANGE_CHUNK_BYTES = 2 * 1024 * 1024;
const STREAM_HIGH_WATER_MARK = 64 * 1024;
const COVER_MAX_AGE_SECONDS = 31536000;

function resolveSafeTrackPath(relPath: string): string | null {
  const musicDir = path.resolve(getMusicDir());
  const absPath = path.resolve(musicDir, relPath);
  if (absPath !== musicDir && !absPath.startsWith(musicDir + path.sep)) {
    return null;
  }
  return absPath;
}

function buildFileEtag(stat: fs.Stats): string {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

// Serve extracted cover images with aggressive immutable caching for instant local reuse
async function handleCoverRequest(req: AuthRequest, res: Response, isHead: boolean): Promise<void> {
  const safeName = path.basename(String(req.params.filename || ''));
  if (!safeName) {
    res.status(404).end();
    return;
  }

  const abs = path.join(COVERS_DIR, safeName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
    if (!stat.isFile()) {
      res.status(404).end();
      return;
    }
  } catch {
    res.status(404).end();
    return;
  }

  const etag = buildFileEtag(stat);
  res.setHeader('Cache-Control', `public, max-age=${COVER_MAX_AGE_SECONDS}, immutable`);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  if (isHead) {
    res.setHeader('Content-Length', stat.size);
    res.status(200).end();
    return;
  }

  res.sendFile(abs, {
    etag: false,
    lastModified: false,
    cacheControl: false,
  });
}

libraryRouter.get('/covers/:filename', (req, res) => {
  void handleCoverRequest(req, res, false);
});

libraryRouter.head('/covers/:filename', (req, res) => {
  void handleCoverRequest(req, res, true);
});

function handleTrackCoverById(req: AuthRequest, res: Response, isHead: boolean): void {
  const trackId = Number(req.params.trackId);
  if (!Number.isFinite(trackId)) {
    res.status(400).end();
    return;
  }
  const row = db
    .prepare('SELECT cover_file FROM tracks WHERE id = ?')
    .get(trackId) as {cover_file: string | null} | undefined;
  if (!row?.cover_file) {
    res.status(404).end();
    return;
  }
  req.params.filename = row.cover_file;
  void handleCoverRequest(req, res, isHead);
}

libraryRouter.get('/tracks/:trackId/cover', (req, res) => {
  handleTrackCoverById(req, res, false);
});

libraryRouter.head('/tracks/:trackId/cover', (req, res) => {
  handleTrackCoverById(req, res, true);
});

// HTTP 206 Partial Content byte-range streaming resolved dynamically against active music_dir
async function handleStreamRequest(
  req: AuthRequest,
  res: Response,
  isHead: boolean
): Promise<void> {
  const trackId = Number(req.params.trackId);
  if (!Number.isFinite(trackId)) {
    res.status(400).json({error: 'Invalid track ID'});
    return;
  }

  const track = db
    .prepare('SELECT id, rel_path, format FROM tracks WHERE id = ?')
    .get(trackId) as {id: number; rel_path: string; format: string} | undefined;

  if (!track || !isTrackVisibleToUser(db, req.user!, trackId)) {
    res.status(404).json({error: 'Track not found'});
    return;
  }

  const absPath = resolveSafeTrackPath(track.rel_path);
  if (!absPath) {
    res.status(404).json({error: 'Audio file not found on active music mount'});
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) {
      res.status(404).json({error: 'Audio file not found on active music mount'});
      return;
    }
  } catch {
    res.status(404).json({error: 'Audio file not found on active music mount'});
    return;
  }

  const fileSize = stat.size;
  const ext = path.extname(absPath).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const etag = buildFileEtag(stat);
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Vary', 'Range');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!match || fileSize <= 0) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const startStr = match[1];
    const endStr = match[2];
    let start: number;
    let end: number;

    if (startStr === '' && endStr !== '') {
      // Suffix byte-range (`bytes=-500`)
      const suffixLen = parseInt(endStr, 10);
      if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
        return;
      }
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    } else if (startStr !== '') {
      start = parseInt(startStr, 10);
      if (endStr !== '') {
        // Explicit end byte — clamp to fileSize - 1 per RFC 7233 §2.1
        end = Math.min(parseInt(endStr, 10), fileSize - 1);
      } else {
        // Open-ended range (`bytes=start-`) — stream a responsive 2 MB chunk for instant seeking
        end = Math.min(start + DEFAULT_OPEN_RANGE_CHUNK_BYTES - 1, fileSize - 1);
      }
    } else {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      start >= fileSize ||
      start > end
    ) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);

    if (isHead) {
      res.end();
      return;
    }

    const stream = fs.createReadStream(absPath, {
      start,
      end,
      highWaterMark: STREAM_HIGH_WATER_MARK,
    });
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  } else {
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.status(200);
    res.setHeader('Content-Length', fileSize);

    if (isHead) {
      res.end();
      return;
    }

    const stream = fs.createReadStream(absPath, {highWaterMark: STREAM_HIGH_WATER_MARK});
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  }
}

libraryRouter.get('/stream/:trackId', requireAuth, (req: AuthRequest, res) => {
  void handleStreamRequest(req, res, false);
});

libraryRouter.head('/stream/:trackId', requireAuth, (req: AuthRequest, res) => {
  void handleStreamRequest(req, res, true);
});

// List tracks with filtering & search
libraryRouter.get('/tracks', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const filter = String(req.query.filter || 'all');
  const search = String(req.query.search || '').trim();
  const artist = String(req.query.artist || '').trim();

  let sql = `
    SELECT
      t.id, t.rel_path, t.title, t.artist, t.album, t.track_number, t.year,
      t.duration, t.format, t.bitrate, t.size_bytes, t.cover_file, t.dominant_color,
      t.added_at,
      CASE WHEN lt.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked,
      ph.last_played_at AS last_played_at
    FROM tracks t
    LEFT JOIN liked_tracks lt ON lt.track_id = t.id AND lt.user_id = ?
    LEFT JOIN (
      SELECT track_id, MAX(played_at) AS last_played_at
      FROM play_history
      WHERE user_id = ? AND track_id IS NOT NULL
      GROUP BY track_id
    ) ph ON ph.track_id = t.id
  `;
  const params: unknown[] = [userId, userId];
  const conditions: string[] = [];

  const visible = visibleTrackClause(req.user!, 't');
  conditions.push(visible.sql);
  params.push(...visible.params);

  if (filter === 'liked') {
    conditions.push('lt.track_id IS NOT NULL');
  }
  if (artist) {
    conditions.push('lower(t.artist) = lower(?)');
    params.push(artist);
  }
  if (search) {
    conditions.push('(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  if (filter === 'recent') {
    sql += ' ORDER BY t.added_at DESC, t.id DESC LIMIT 100';
  } else if (filter === 'liked') {
    sql += ' ORDER BY lt.liked_at DESC';
  } else {
    sql +=
      ' ORDER BY CASE WHEN ph.last_played_at IS NULL THEN 1 ELSE 0 END ASC, ph.last_played_at DESC, t.artist COLLATE NOCASE ASC, t.album COLLATE NOCASE ASC, COALESCE(t.track_number, 9999) ASC, t.title COLLATE NOCASE ASC';
  }

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const tracks = rows.map((r) => ({...r, liked: Boolean(r.liked)}));
  res.json({tracks});
});

libraryRouter.get('/tracks/:id', requireAuth, (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(
      `SELECT t.*, CASE WHEN lt.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked
       FROM tracks t
       LEFT JOIN liked_tracks lt ON lt.track_id = t.id AND lt.user_id = ?
       WHERE t.id = ?`
    )
    .get(req.user!.id, id) as Record<string, unknown> | undefined;

  if (!row || !isTrackVisibleToUser(db, req.user!, id)) {
    res.status(404).json({error: 'Track not found'});
    return;
  }
  res.json({track: {...row, liked: Boolean(row.liked)}});
});

libraryRouter.get('/lyrics', requireAuth, async (req: AuthRequest, res) => {
  const rawTrackId = req.query.trackId ? Number(req.query.trackId) : null;
  let trackId =
    rawTrackId !== null && Number.isInteger(rawTrackId) && rawTrackId > 0 ? rawTrackId : null;
  if (trackId !== null && !isTrackVisibleToUser(db, req.user!, trackId)) {
    // Do not leak hidden-track metadata; fall back to the title/artist lookup the caller supplied.
    trackId = null;
  }
  const title = typeof req.query.title === 'string' ? req.query.title : '';
  const artist = typeof req.query.artist === 'string' ? req.query.artist : '';
  const album = typeof req.query.album === 'string' ? req.query.album : '';
  const rawDuration = req.query.duration ? Number(req.query.duration) : 0;
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;

  try {
    const result = await resolveTrackLyrics({trackId, title, artist, album, duration});
    res.json(result);
  } catch {
    res.json({
      lyrics: null,
      syncedLyrics: null,
      plainLyrics: null,
      instrumental: false,
      source: 'none',
    });
  }
});

libraryRouter.get('/tracks/:id/lyrics', requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({error: 'Invalid track ID'});
    return;
  }

  const exists = db.prepare('SELECT id FROM tracks WHERE id = ?').get(id);
  if (!exists || !isTrackVisibleToUser(db, req.user!, id)) {
    res.status(404).json({error: 'Track not found'});
    return;
  }

  try {
    const result = await resolveTrackLyrics({trackId: id});
    res.json(result);
  } catch {
    res.json({
      lyrics: null,
      syncedLyrics: null,
      plainLyrics: null,
      instrumental: false,
      source: 'none',
    });
  }
});

libraryRouter.post('/tracks/:id/like', requireAuth, (req: AuthRequest, res) => {
  const trackId = Number(req.params.id);
  const userId = req.user!.id;

  const exists = db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId);
  if (!exists || !isTrackVisibleToUser(db, req.user!, trackId)) {
    res.status(404).json({error: 'Track not found'});
    return;
  }

  const liked = db
    .prepare('SELECT 1 FROM liked_tracks WHERE user_id = ? AND track_id = ?')
    .get(userId, trackId);

  if (liked) {
    db.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?').run(userId, trackId);
    res.json({liked: false});
  } else {
    db.prepare('INSERT INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(userId, trackId);
    res.json({liked: true});
  }
});

async function removeEmptyParentDirs(startDir: string, musicDirRoot: string): Promise<void> {
  const rootResolved = path.resolve(musicDirRoot);
  let current = path.resolve(startDir);
  let depth = 0;
  // Walk up empty Album and Artist parent directories without ever touching musicDirRoot
  while (
    depth < 3 &&
    current !== rootResolved &&
    current.startsWith(rootResolved + path.sep)
  ) {
    try {
      const entries = await fs.promises.readdir(current);
      if (entries.length === 0) {
        await fs.promises.rmdir(current);
        current = path.dirname(current);
        depth++;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

async function permanentlyDeleteTracks(trackIds: number[]): Promise<{
  deletedIds: number[];
  errors: Array<{id: number; error: string}>;
}> {
  const musicDir = path.resolve(getMusicDir());
  const deletedIds: number[] = [];
  const errors: Array<{id: number; error: string}> = [];
  const candidateCovers = new Set<string>();

  const getTrackStmt = db.prepare('SELECT id, rel_path, cover_file FROM tracks WHERE id = ?');
  const deletePlaylistTracksStmt = db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?');
  const deleteLikedTracksStmt = db.prepare('DELETE FROM liked_tracks WHERE track_id = ?');
  const deleteTrackStmt = db.prepare('DELETE FROM tracks WHERE id = ?');

  for (const trackId of trackIds) {
    const track = getTrackStmt.get(trackId) as
      | {id: number; rel_path: string; cover_file: string | null}
      | undefined;

    if (!track) continue;

    const absPath = resolveSafeTrackPath(track.rel_path);
    if (!absPath) {
      errors.push({id: trackId, error: 'Resolved path outside active music directory'});
      continue;
    }

    // 1. Delete audio file from disk via fs.promises.unlink
    try {
      await fs.promises.unlink(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        errors.push({
          id: trackId,
          error: `Could not delete file on disk: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    // 2. Remove empty parent Album and Artist subdirectories inside music_dir
    await removeEmptyParentDirs(path.dirname(absPath), musicDir);

    // 3. Remove from playlist_tracks, liked_tracks, and tracks in SQLite
    const dbTx = db.transaction(() => {
      deletePlaylistTracksStmt.run(trackId);
      deleteLikedTracksStmt.run(trackId);
      deleteTrackStmt.run(trackId);
    });
    dbTx();

    if (track.cover_file) {
      candidateCovers.add(track.cover_file);
    }
    deletedIds.push(trackId);
  }

  // 4. Delete extracted cover images that are no longer referenced by any remaining track
  const countCoverStmt = db.prepare('SELECT COUNT(*) as c FROM tracks WHERE cover_file = ?');
  for (const coverFile of candidateCovers) {
    const row = countCoverStmt.get(coverFile) as {c: number};
    if (row.c === 0) {
      const coverPath = path.join(COVERS_DIR, path.basename(coverFile));
      try {
        await fs.promises.unlink(coverPath);
      } catch {
        // Ignore if cover already missing
      }
    }
  }

  return {deletedIds, errors};
}

// Bulk permanent track deletion (admin or can_download)
libraryRouter.delete('/tracks', requireAuth, async (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin' && !req.user!.can_download) {
    res.status(403).json({error: 'Only admins or users with download permission can delete tracks'});
    return;
  }

  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const trackIds = Array.from(
    new Set(rawIds.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n)))
  ) as number[];

  if (trackIds.length === 0) {
    res.status(400).json({error: 'No track IDs provided'});
    return;
  }

  const deletableIds = trackIds.filter((id) => isTrackVisibleToUser(db, req.user!, id));
  if (deletableIds.length === 0) {
    res.status(404).json({error: 'Track not found'});
    return;
  }

  const result = await permanentlyDeleteTracks(deletableIds);
  if (result.deletedIds.length === 0 && result.errors.length > 0) {
    res.status(500).json({error: result.errors[0].error, errors: result.errors});
    return;
  }

  res.json({
    ok: true,
    deletedIds: result.deletedIds,
    deletedCount: result.deletedIds.length,
    errors: result.errors,
  });
});

// Single-track permanent deletion (admin or can_download)
libraryRouter.delete('/tracks/:id', requireAuth, async (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin' && !req.user!.can_download) {
    res.status(403).json({error: 'Only admins or users with download permission can delete tracks'});
    return;
  }
  const trackId = Number(req.params.id);
  if (!Number.isFinite(trackId)) {
    res.status(400).json({error: 'Invalid track ID'});
    return;
  }

  if (!isTrackVisibleToUser(db, req.user!, trackId)) {
    res.status(404).json({error: 'Track not found'});
    return;
  }

  const result = await permanentlyDeleteTracks([trackId]);
  if (result.errors.length > 0) {
    res.status(500).json({error: result.errors[0].error});
    return;
  }
  if (result.deletedIds.length === 0) {
    res.status(404).json({error: 'Track not found'});
    return;
  }

  res.json({ok: true, deletedIds: result.deletedIds});
});

// Playlists
libraryRouter.get('/playlists', requireAuth, (req: AuthRequest, res) => {
  const playlists = db
    .prepare(
      `SELECT p.id, p.user_id, p.name, p.description, p.source, p.m3u_path, p.visibility, p.created_at, p.updated_at,
              u.username AS owner_username,
              COUNT(pt.id) AS track_count
       FROM playlists p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       WHERE p.user_id = ? OR ? = 'admin' OR p.visibility = 'public'
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.id DESC`
    )
    .all(req.user!.id, req.user!.role) as Array<{
    id: number;
    user_id: number;
    name: string;
    description: string;
    source: 'manual' | 'm3u';
    m3u_path: string | null;
    visibility: 'private' | 'public';
    created_at: string;
    updated_at: string;
    owner_username: string;
    track_count: number;
  }>;

  const coversStmt = db.prepare(`
    SELECT DISTINCT t.cover_file
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ? AND t.cover_file IS NOT NULL
    ORDER BY pt.position ASC, pt.id ASC
    LIMIT 4
  `);

  const enriched = playlists.map((p) => {
    const covers = (coversStmt.all(p.id) as Array<{cover_file: string}>).map((c) => c.cover_file);
    return {...p, covers};
  });

  // Also include summary counts for virtual collections
  const countClause = visibleTrackClause(req.user!, 't');
  const totalCount = (
    db
      .prepare(`SELECT COUNT(*) as c FROM tracks t WHERE ${countClause.sql}`)
      .get(...countClause.params) as {c: number}
  ).c;
  const likedCount = (
    db.prepare('SELECT COUNT(*) as c FROM liked_tracks WHERE user_id = ?').get(req.user!.id) as {
      c: number;
    }
  ).c;

  res.json({playlists: enriched, stats: {totalTracks: totalCount, likedTracks: likedCount}});
});

libraryRouter.post('/playlists', requireAuth, (req: AuthRequest, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const visibility = parseVisibility(req.body?.visibility) ?? 'private';

  if (!name) {
    res.status(400).json({error: 'Playlist name is required'});
    return;
  }

  const info = db
    .prepare('INSERT INTO playlists (user_id, name, description, visibility) VALUES (?, ?, ?, ?)')
    .run(req.user!.id, name.slice(0, 100), description.slice(0, 300), visibility);

  const playlist = db
    .prepare('SELECT * FROM playlists WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json({playlist});
});

libraryRouter.get('/playlists/:id', requireAuth, (req: AuthRequest, res) => {
  const playlistId = Number(req.params.id);
  const playlist = db
    .prepare(
      `SELECT p.*, u.username AS owner_username
       FROM playlists p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = ?`
    )
    .get(playlistId) as Record<string, unknown> | undefined;

  if (!playlist || !canViewPlaylist(req.user!, playlist as {user_id: number; visibility?: string})) {
    // Same answer for "missing" and "not yours" so private playlists can't be probed
    res.status(404).json({error: 'Playlist not found'});
    return;
  }

  const rows = db
    .prepare(
      `SELECT
        t.id, t.rel_path, t.title, t.artist, t.album, t.track_number, t.year,
        t.duration, t.format, t.bitrate, t.size_bytes, t.cover_file, t.dominant_color,
        t.added_at, pt.id AS playlist_track_id, pt.position,
        CASE WHEN lt.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       LEFT JOIN liked_tracks lt ON lt.track_id = t.id AND lt.user_id = ?
       WHERE pt.playlist_id = ?
       ORDER BY pt.position ASC, pt.id ASC`
    )
    .all(req.user!.id, playlistId) as Array<Record<string, unknown>>;

  const tracks = rows.map((r) => ({...r, liked: Boolean(r.liked)})) as Array<
    Record<string, unknown> & {cover_file?: string | null; liked: boolean}
  >;
  const covers = Array.from(
    new Set(tracks.map((t) => t.cover_file ?? null).filter((c): c is string => Boolean(c)))
  ).slice(0, 4);

  res.json({playlist: {...playlist, covers, track_count: tracks.length}, tracks});
});

libraryRouter.put('/playlists/:id', requireAuth, async (req: AuthRequest, res) => {
  const playlistId = Number(req.params.id);
  if (!Number.isInteger(playlistId) || playlistId <= 0) {
    res.status(400).json({error: 'Invalid playlist id'});
    return;
  }

  const existing = db
    .prepare('SELECT id, user_id, name, description, source, m3u_path, visibility FROM playlists WHERE id = ?')
    .get(playlistId) as
    | {
        id: number;
        user_id: number;
        name: string;
        description: string | null;
        source: string | null;
        m3u_path: string | null;
        visibility: string | null;
      }
    | undefined;

  if (!existing || !canViewPlaylist(req.user!, existing)) {
    res.status(404).json({error: 'Playlist not found'});
    return;
  }
  if (!canManagePlaylist(req.user!, existing)) {
    res.status(403).json({error: 'Not allowed to edit this playlist'});
    return;
  }

  const hasNameField = typeof req.body?.name === 'string';
  const hasVisibilityField =
    req.body !== null &&
    typeof req.body === 'object' &&
    Object.prototype.hasOwnProperty.call(req.body, 'visibility') &&
    req.body.visibility !== undefined;
  const nextVisibility = hasVisibilityField
    ? parseVisibility(req.body.visibility)
    : ((existing.visibility === 'public' ? 'public' : 'private') as 'public' | 'private');
  if (!nextVisibility) {
    res.status(400).json({error: 'Visibility must be "private" or "public"'});
    return;
  }

  const rawName = hasNameField ? req.body.name : existing.name;
  const name = String(rawName).replace(/[\r\n]/g, '').trim();
  if (!name || (!hasNameField && !hasVisibilityField)) {
    res.status(400).json({error: 'Playlist name is required'});
    return;
  }
  if (name.length > 100) {
    res.status(400).json({error: 'Playlist name must be 100 characters or fewer'});
    return;
  }

  const hasDescription =
    req.body !== null &&
    typeof req.body === 'object' &&
    Object.prototype.hasOwnProperty.call(req.body, 'description') &&
    req.body.description !== undefined;
  const description = hasDescription
    ? String(req.body.description ?? '').trim().slice(0, 300)
    : existing.description || '';

  if (existing.source === 'm3u' && existing.m3u_path && name !== existing.name) {
    try {
      await updateM3uPlaylistNameOnDisk(existing.m3u_path, name);
    } catch {
      res.status(409).json({
        error: 'Could not update the playlist file; the name would revert on the next scan',
      });
      return;
    }
  }

  db.prepare(
    "UPDATE playlists SET name = ?, description = ?, visibility = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(name, description, nextVisibility, playlistId);

  const updated = db
    .prepare(
      `SELECT p.id, p.user_id, p.name, p.description, p.source, p.m3u_path, p.visibility, p.created_at, p.updated_at,
              u.username AS owner_username
       FROM playlists p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = ?`
    )
    .get(playlistId);

  res.json({ok: true, playlist: updated});
});

libraryRouter.delete('/playlists/:id', requireAuth, (req: AuthRequest, res) => {
  const playlistId = Number(req.params.id);
  const existing = db
    .prepare('SELECT id, user_id, visibility FROM playlists WHERE id = ?')
    .get(playlistId) as {id: number; user_id: number; visibility: string | null} | undefined;

  if (!existing || !canViewPlaylist(req.user!, existing)) {
    res.status(404).json({error: 'Playlist not found'});
    return;
  }
  if (!canManagePlaylist(req.user!, existing)) {
    res.status(403).json({error: 'Not allowed to delete this playlist'});
    return;
  }

  db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
  res.json({ok: true});
});

const M3U_EXT_RE = /\.m3u8?$/i;

function sanitizeM3uLabel(value: string, fallback: string): string {
  const cleaned = (value || '').replace(/[\r\n]+/g, ' ').trim();
  return cleaned || fallback;
}

export function rewriteM3uPlaylistNameContent(content: string, newName: string): string {
  const safeName = newName.replace(/[\r\n]/g, '').trim();
  const hasBom = content.startsWith('\uFEFF');
  const bom = hasBom ? '\uFEFF' : '';
  const body = hasBom ? content.slice(1) : content;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const playlistDirective = `#PLAYLIST:${safeName}`;

  if (body.length === 0) {
    return `${bom}${playlistDirective}${eol}`;
  }

  const lines = body.split(/\r?\n/);
  const result: string[] = [];
  let replacedFirst = false;

  for (const line of lines) {
    if (/^#PLAYLIST:/i.test(line.trim())) {
      if (!replacedFirst) {
        result.push(playlistDirective);
        replacedFirst = true;
      }
      continue;
    }
    result.push(line);
  }

  if (!replacedFirst) {
    const extm3uIdx = result.findIndex((line) => /^#EXTM3U\b/i.test(line.trim()));
    if (extm3uIdx >= 0) {
      result.splice(extm3uIdx + 1, 0, playlistDirective);
    } else {
      result.unshift(playlistDirective);
    }
  }

  return `${bom}${result.join(eol)}`;
}

async function updateM3uPlaylistNameOnDisk(m3uRelPath: string, newName: string): Promise<void> {
  if (!m3uRelPath || !M3U_EXT_RE.test(m3uRelPath)) {
    throw new Error('Invalid M3U playlist extension');
  }
  const m3uAbsPath = resolveSafeTrackPath(m3uRelPath);
  if (!m3uAbsPath) {
    throw new Error('Invalid M3U playlist path');
  }

  const existingContent = await fs.promises.readFile(m3uAbsPath, 'utf-8');
  const nextContent = rewriteM3uPlaylistNameContent(existingContent, newName);

  const dirAbs = path.dirname(m3uAbsPath);
  const baseName = path.basename(m3uAbsPath);
  const tmpName = `.${baseName}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dirAbs, tmpName);

  try {
    await fs.promises.writeFile(tmpPath, nextContent, 'utf-8');
    await fs.promises.rename(tmpPath, m3uAbsPath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function appendTracksToM3uFile(
  m3uRelPath: string,
  tracks: Array<{rel_path: string; title: string; artist: string; duration: number}>
): Promise<boolean> {
  if (!m3uRelPath || tracks.length === 0 || !M3U_EXT_RE.test(m3uRelPath)) return false;
  const m3uAbsPath = resolveSafeTrackPath(m3uRelPath);
  if (!m3uAbsPath) return false;

  const m3uDirAbs = path.dirname(m3uAbsPath);
  const newEntryLines: string[] = [];

  for (const track of tracks) {
    const trackAbsPath = resolveSafeTrackPath(track.rel_path);
    if (!trackAbsPath) continue;
    const relFromM3u = path.relative(m3uDirAbs, trackAbsPath).split(path.sep).join('/');
    const dur = Math.max(-1, Math.round(track.duration || 0));
    const cleanArtist = sanitizeM3uLabel(track.artist, 'Unknown Artist');
    const cleanTitle = sanitizeM3uLabel(track.title, 'Untitled');
    newEntryLines.push(`#EXTINF:${dur},${cleanArtist} - ${cleanTitle}`);
    newEntryLines.push(relFromM3u);
  }

  if (newEntryLines.length === 0) return false;

  let existing = '';
  try {
    existing = await fs.promises.readFile(m3uAbsPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const normalizedExisting = existing.trim().length === 0 ? `#EXTM3U${eol}` : existing;
  const needsLeadingNewline =
    normalizedExisting.length > 0 && !normalizedExisting.endsWith('\n') && !normalizedExisting.endsWith('\r');
  const nextContent =
    normalizedExisting +
    (needsLeadingNewline ? eol : '') +
    newEntryLines.join(eol) +
    eol;

  await fs.promises.mkdir(m3uDirAbs, {recursive: true});
  await fs.promises.writeFile(m3uAbsPath, nextContent, 'utf-8');
  return true;
}

async function removeTrackFromM3uFile(
  m3uRelPath: string,
  trackRelPath: string
): Promise<boolean> {
  if (!m3uRelPath || !trackRelPath || !M3U_EXT_RE.test(m3uRelPath)) return false;
  const m3uAbsPath = resolveSafeTrackPath(m3uRelPath);
  const trackAbsPath = resolveSafeTrackPath(trackRelPath);
  if (!m3uAbsPath || !trackAbsPath) return false;

  let existing: string;
  try {
    existing = await fs.promises.readFile(m3uAbsPath, 'utf-8');
  } catch {
    return false;
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const musicDir = path.resolve(getMusicDir());
  const m3uDirAbs = path.dirname(m3uAbsPath);
  const targetRelNorm = trackRelPath.replace(/\\/g, '/').toLowerCase();
  const targetFromM3u = path
    .relative(m3uDirAbs, trackAbsPath)
    .split(path.sep)
    .join('/')
    .toLowerCase();

  const lines = existing.split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }

    const posix = trimmed.replace(/\\/g, '/');
    let matchesTarget = posix.toLowerCase() === targetFromM3u || posix.toLowerCase() === targetRelNorm;
    if (!matchesTarget && !path.isAbsolute(trimmed) && !/^[a-zA-Z]:\//.test(posix)) {
      const resolvedRel = path
        .relative(musicDir, path.resolve(m3uDirAbs, posix))
        .split(path.sep)
        .join('/')
        .toLowerCase();
      if (resolvedRel === targetRelNorm) matchesTarget = true;
    }

    if (matchesTarget) {
      removed = true;
      // Drop the immediately preceding #EXTINF line if present
      if (kept.length > 0 && /^#EXTINF:/i.test(kept[kept.length - 1].trim())) {
        kept.pop();
      }
      continue;
    }
    kept.push(line);
  }

  if (!removed) return false;
  const out = kept.join(eol).replace(/(\r?\n)*$/, '') + eol;
  await fs.promises.writeFile(m3uAbsPath, out, 'utf-8');
  return true;
}

libraryRouter.post('/playlists/:id/tracks', requireAuth, async (req: AuthRequest, res) => {
  const playlistId = Number(req.params.id);
  const incomingIds: number[] = Array.isArray(req.body?.trackIds)
    ? req.body.trackIds.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n))
    : Number.isFinite(Number(req.body?.trackId))
      ? [Number(req.body.trackId)]
      : [];

  if (incomingIds.length === 0) {
    res.status(400).json({error: 'No valid track IDs provided'});
    return;
  }

  const playlist = db
    .prepare('SELECT id, user_id, source, m3u_path, visibility FROM playlists WHERE id = ?')
    .get(playlistId) as
    | {
        id: number;
        user_id: number;
        source: 'manual' | 'm3u';
        m3u_path: string | null;
        visibility: string | null;
      }
    | undefined;
  if (!playlist || !canViewPlaylist(req.user!, playlist)) {
    res.status(404).json({error: 'Playlist not found'});
    return;
  }
  const canModifyM3u = playlist.source === 'm3u' && req.user!.can_download;
  if (!canManagePlaylist(req.user!, playlist) && !canModifyM3u) {
    res.status(403).json({error: 'Not allowed to modify this playlist'});
    return;
  }

  const getTrackStmt = db.prepare(
    'SELECT id, rel_path, title, artist, duration FROM tracks WHERE id = ?'
  );
  const maxPosRow = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM playlist_tracks WHERE playlist_id = ?')
    .get(playlistId) as {maxPos: number};
  const insertStmt = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
  );

  let nextPos = maxPosRow.maxPos + 1;
  const addedTracks: Array<{
    id: number;
    rel_path: string;
    title: string;
    artist: string;
    duration: number;
  }> = [];

  const addTx = db.transaction(() => {
    for (const trackId of incomingIds) {
      const trackRow = getTrackStmt.get(trackId) as
        | {id: number; rel_path: string; title: string; artist: string; duration: number}
        | undefined;
      if (!trackRow || !isTrackVisibleToUser(db, req.user!, trackRow.id)) continue;
      insertStmt.run(playlistId, trackRow.id, nextPos++);
      addedTracks.push(trackRow);
    }
    if (addedTracks.length > 0) {
      db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);
    }
  });
  addTx();

  if (addedTracks.length === 0) {
    res.status(404).json({error: 'Track not found'});
    return;
  }

  let m3uUpdated = false;
  if (playlist.source === 'm3u' && playlist.m3u_path) {
    try {
      m3uUpdated = await appendTracksToM3uFile(playlist.m3u_path, addedTracks);
    } catch (err) {
      console.error(
        '[playlists-m3u] Failed to append track(s) to',
        playlist.m3u_path,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  res.status(201).json({ok: true, addedCount: addedTracks.length, m3uUpdated});
});

// Export any playlist as a standard .m3u8 file inside <Active_Music_Mount>/Playlists/
libraryRouter.post('/playlists/:id/export-m3u', requireAuth, async (req: AuthRequest, res) => {
  const playlistId = Number(req.params.id);
  const playlist = db
    .prepare('SELECT id, name, user_id, visibility FROM playlists WHERE id = ?')
    .get(playlistId) as
    | {id: number; name: string; user_id: number; visibility: string | null}
    | undefined;

  if (!playlist || !canViewPlaylist(req.user!, playlist)) {
    res.status(404).json({error: 'Playlist not found'});
    return;
  }

  const tracks = db
    .prepare(
      `SELECT t.rel_path, t.title, t.artist, t.duration
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       WHERE pt.playlist_id = ?
       ORDER BY pt.position ASC, pt.id ASC`
    )
    .all(playlistId) as Array<{
    rel_path: string;
    title: string;
    artist: string;
    duration: number;
  }>;

  const musicDir = path.resolve(getMusicDir());
  const playlistsDir = path.join(musicDir, 'Playlists');
  const safeBase =
    playlist.name
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^\.+|\.+$/g, '')
      .trim()
      .slice(0, 100) || `Playlist_${playlist.id}`;
  const outPath = path.join(playlistsDir, `${safeBase}.m3u8`);

  const lines: string[] = ['#EXTM3U', `#PLAYLIST:${playlist.name}`];
  for (const t of tracks) {
    const dur = Math.max(-1, Math.round(t.duration || 0));
    lines.push(`#EXTINF:${dur},${t.artist} - ${t.title}`);
    // Relative from <music_dir>/Playlists/ to <music_dir>/<rel_path>
    const relFromPlaylists = path.posix.join('..', t.rel_path.replace(/\\/g, '/'));
    lines.push(relFromPlaylists);
  }

  try {
    await fs.promises.mkdir(playlistsDir, {recursive: true});
    await fs.promises.writeFile(outPath, lines.join('\n') + '\n', 'utf-8');
    const relPath = path.relative(musicDir, outPath).split(path.sep).join('/');
    res.json({
      ok: true,
      filePath: outPath,
      relPath,
      trackCount: tracks.length,
    });
  } catch (err) {
    res.status(500).json({
      error: `Failed to export .m3u8 file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

libraryRouter.delete(
  '/playlists/:id/tracks/:trackId',
  requireAuth,
  async (req: AuthRequest, res) => {
    const playlistId = Number(req.params.id);
    const trackId = Number(req.params.trackId);

    const playlist = db
      .prepare('SELECT id, user_id, source, m3u_path, visibility FROM playlists WHERE id = ?')
      .get(playlistId) as
      | {
          id: number;
          user_id: number;
          source: 'manual' | 'm3u';
          m3u_path: string | null;
          visibility: string | null;
        }
      | undefined;
    if (!playlist || !canViewPlaylist(req.user!, playlist)) {
      res.status(404).json({error: 'Playlist not found'});
      return;
    }
    const canModifyM3u = playlist.source === 'm3u' && req.user!.can_download;
    if (!canManagePlaylist(req.user!, playlist) && !canModifyM3u) {
      res.status(403).json({error: 'Not allowed to modify this playlist'});
      return;
    }

    const trackRow = db
      .prepare('SELECT rel_path FROM tracks WHERE id = ?')
      .get(trackId) as {rel_path: string} | undefined;

    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(
      playlistId,
      trackId
    );
    db.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?").run(playlistId);

    if (playlist.source === 'm3u' && playlist.m3u_path && trackRow?.rel_path) {
      try {
        await removeTrackFromM3uFile(playlist.m3u_path, trackRow.rel_path);
      } catch (err) {
        console.error(
          '[playlists-m3u] Failed to remove track from',
          playlist.m3u_path,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    res.json({ok: true});
  }
);

function getActivePlayingTrackIdsForUser(
  userId: number,
  clientPlayingTrackId?: unknown
): Set<number> {
  const playingIds = new Set<number>();
  const devices = deviceHub.listDevices(userId);
  for (const device of devices) {
    if (!device.online || !device.state?.isPlaying || !device.state.track) continue;
    const rawId = device.state.track.id;
    const numericId = typeof rawId === 'number' ? rawId : Number(rawId);
    if (Number.isSafeInteger(numericId) && numericId > 0) {
      playingIds.add(numericId);
    }
  }

  if (clientPlayingTrackId !== undefined && clientPlayingTrackId !== null && clientPlayingTrackId !== '') {
    const numericClientId = Number(clientPlayingTrackId);
    if (Number.isSafeInteger(numericClientId) && numericClientId > 0) {
      playingIds.add(numericClientId);
    }
  }

  return playingIds;
}

libraryRouter.get('/library/duplicates', requireAuth, (req: AuthRequest, res) => {
  if (!hasFullLibrary(req.user!)) {
    // Limited users only see part of the library, so a library-wide scan is not offered to them.
    res.json({groups: [], totalGroups: 0});
    return;
  }
  try {
    const playingTrackIds = getActivePlayingTrackIdsForUser(
      req.user!.id,
      req.query.playingTrackId
    );
    const groups = findDuplicateGroupsForUser(db, {
      userId: req.user!.id,
      userRole: req.user!.role,
      playingTrackIds,
    });
    res.json({
      groups,
      totalGroups: groups.length,
    });
  } catch (err) {
    console.error(
      '[library-dedupe] failed to list duplicates:',
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({error: 'Failed to scan library for duplicates'});
  }
});

libraryRouter.post('/library/duplicates/resolve', requireAuth, (req: AuthRequest, res) => {
  if (!hasFullLibrary(req.user!)) {
    res.status(403).json({error: 'Duplicate cleanup needs access to the whole library'});
    return;
  }
  const rawKeepId = req.body?.keepId;
  const rawRemoveId = req.body?.removeId;
  const keepId = typeof rawKeepId === 'number' ? rawKeepId : Number(rawKeepId);
  const removeId = typeof rawRemoveId === 'number' ? rawRemoveId : Number(rawRemoveId);

  if (
    !Number.isSafeInteger(keepId) ||
    keepId <= 0 ||
    !Number.isSafeInteger(removeId) ||
    removeId <= 0
  ) {
    res.status(400).json({error: 'keepId and removeId must be valid positive integers'});
    return;
  }

  try {
    const playingTrackIds = getActivePlayingTrackIdsForUser(
      req.user!.id,
      req.body?.playingTrackId
    );
    const result = resolveDuplicatePair(db, {
      userId: req.user!.id,
      userRole: req.user!.role,
      keepId,
      removeId,
      playingTrackIds,
    });
    res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    if (err instanceof DuplicateResolveError) {
      res.status(err.status).json({error: err.message});
      return;
    }
    console.error(
      '[library-dedupe] failed to resolve duplicate:',
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({error: 'Failed to remove duplicate copy'});
  }
});

libraryRouter.post('/library/duplicates/resolve-all', requireAuth, async (req: AuthRequest, res) => {
  if (!hasFullLibrary(req.user!)) {
    res.status(403).json({error: 'Duplicate cleanup needs access to the whole library'});
    return;
  }
  const userId = req.user!.id;
  if (!tryAcquireBulkDedupeLock(userId)) {
    res.status(409).json({error: 'A bulk duplicate removal is already running'});
    return;
  }

  const wantsStream =
    typeof req.headers.accept === 'string' &&
    req.headers.accept.includes('application/x-ndjson');

  const writeNdjson = (payload: unknown): void => {
    if (!wantsStream || res.writableEnded || res.destroyed) return;
    try {
      res.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // client disconnected; let remaining server-side groups finish cleanly
    }
  };

  try {
    const playingTrackIds = getActivePlayingTrackIdsForUser(userId, req.body?.playingTrackId);

    if (wantsStream) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    }

    const summary = await resolveAllSafeDuplicatesAsync(db, {
      userId,
      userRole: req.user!.role,
      playingTrackIds,
      onProgress: wantsStream ? writeNdjson : undefined,
    });

    if (wantsStream) {
      if (!res.writableEnded) {
        res.end();
      }
    } else {
      res.json({
        ok: true,
        ...summary,
      });
    }
  } catch (err) {
    console.error(
      '[library-dedupe] failed bulk duplicate removal:',
      err instanceof Error ? err.message : String(err)
    );
    if (wantsStream) {
      writeNdjson({type: 'error', error: 'Bulk duplicate removal failed'});
      if (!res.writableEnded) {
        res.end();
      }
    } else if (!res.headersSent) {
      res.status(500).json({error: 'Bulk duplicate removal failed'});
    }
  } finally {
    releaseBulkDedupeLock(userId);
  }
});


