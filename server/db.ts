import 'dotenv/config';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const ROOT_DIR = process.cwd();
export const DATA_DIR = process.env.DATA_DIR?.trim()
  ? path.resolve(process.env.DATA_DIR.trim())
  : path.resolve(ROOT_DIR, 'data');
export const COVERS_DIR = path.resolve(DATA_DIR, 'covers');
export const SECRETS_DIR = path.resolve(DATA_DIR, 'secrets');
export const YTDLP_CACHE_DIR = process.env.YTDLP_CACHE_DIR?.trim()
  ? path.resolve(process.env.YTDLP_CACHE_DIR.trim())
  : path.resolve(DATA_DIR, 'ytdlp-cache');
export const AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR?.trim()
  ? path.resolve(process.env.AUDIO_CACHE_DIR.trim())
  : path.resolve(DATA_DIR, 'audio-cache');
export const COOKIES_FILE = path.resolve(SECRETS_DIR, 'cookies.txt');
export const DEFAULT_MUSIC_DIR = process.env.MUSIC_DIR?.trim()
  ? path.resolve(process.env.MUSIC_DIR.trim())
  : path.resolve(ROOT_DIR, 'music_library');
export const DEFAULT_YTDLP_PATH = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
export const DEFAULT_FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

// Ensure core runtime directories exist
for (const dir of [DATA_DIR, COVERS_DIR, SECRETS_DIR, YTDLP_CACHE_DIR, AUDIO_CACHE_DIR]) {
  fs.mkdirSync(dir, {recursive: true});
}
if (!process.env.MUSIC_DIR?.trim()) {
  fs.mkdirSync(DEFAULT_MUSIC_DIR, {recursive: true});
}

const DB_PATH = path.resolve(DATA_DIR, 'xlabplayer.db');
export const db = new Database(DB_PATH);

// Enable WAL mode and foreign keys for reliability and concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'listener')) DEFAULT 'listener',
    can_download INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT 'Unknown Artist',
    album TEXT NOT NULL DEFAULT 'Unknown Album',
    track_number INTEGER,
    year INTEGER,
    duration REAL NOT NULL DEFAULT 0,
    format TEXT NOT NULL DEFAULT '',
    bitrate INTEGER DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    cover_file TEXT,
    dominant_color TEXT NOT NULL DEFAULT '#1f3a2e',
    lyrics TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
  CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
  CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at DESC);

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pid ON playlist_tracks(playlist_id, position);

  CREATE TABLE IF NOT EXISTS liked_tracks (
    user_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    liked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS download_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'm4a',
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'Queued',
    track_id INTEGER,
    error_log TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalog_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_catalog_cache_expires ON catalog_cache(expires_at);

  CREATE TABLE IF NOT EXISTS track_video_map (
    match_key TEXT PRIMARY KEY,
    artist TEXT NOT NULL,
    title TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    video_id TEXT NOT NULL,
    matched_title TEXT NOT NULL DEFAULT '',
    matched_duration INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_track_video_map_updated ON track_video_map(updated_at);

  CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    track_id INTEGER,
    video_id TEXT NOT NULL DEFAULT '',
    played_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_play_history_user_time ON play_history(user_id, played_at DESC);

  CREATE TABLE IF NOT EXISTS lyrics_cache (
    cache_key TEXT PRIMARY KEY,
    artist TEXT NOT NULL,
    title TEXT NOT NULL,
    album TEXT NOT NULL DEFAULT '',
    duration REAL NOT NULL DEFAULT 0,
    synced_lyrics TEXT,
    plain_lyrics TEXT,
    instrumental INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'lrclib',
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lyrics_cache_updated ON lyrics_cache(updated_at);

  CREATE TABLE IF NOT EXISTS stream_url_cache (
    video_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    egress TEXT NOT NULL DEFAULT 'direct',
    resolved_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    headers_json TEXT NOT NULL DEFAULT '{}',
    strategy TEXT NOT NULL DEFAULT 'default',
    content_type TEXT NOT NULL DEFAULT 'audio/mp4',
    content_length INTEGER,
    duration INTEGER,
    client_param TEXT,
    format_id TEXT,
    used_format_headers INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_stream_url_cache_expires ON stream_url_cache(expires_at);

  CREATE TABLE IF NOT EXISTS related_mix (
    video_id TEXT PRIMARY KEY,
    rows_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_related_mix_fetched ON related_mix(fetched_at);

  CREATE TABLE IF NOT EXISTS listening_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    track_id TEXT NOT NULL DEFAULT '',
    video_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    listened_sec REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_listening_events_user_time
    ON listening_events(user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS youtube_playlist_jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    playlist_id INTEGER NOT NULL,
    youtube_playlist_id TEXT NOT NULL,
    playlist_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'cancelled', 'failed')) DEFAULT 'running',
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_yt_pl_jobs_user
    ON youtube_playlist_jobs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_yt_pl_jobs_playlist
    ON youtube_playlist_jobs(playlist_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS youtube_playlist_job_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    duration REAL NOT NULL DEFAULT 0,
    thumbnail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('pending', 'downloading', 'done', 'failed', 'cancelled')) DEFAULT 'pending',
    track_id INTEGER,
    error TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (job_id) REFERENCES youtube_playlist_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_yt_pl_job_items_job
    ON youtube_playlist_job_items(job_id, position ASC);

  CREATE TABLE IF NOT EXISTS video_audio_facts (
    videoId TEXT PRIMARY KEY,
    lufs REAL,
    truePeakDb REAL,
    durationSec REAL NOT NULL DEFAULT 0,
    lowRunPct REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('ok', 'bad')) DEFAULT 'ok',
    reason TEXT NOT NULL DEFAULT '',
    measuredAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS track_video_rejects (
    trackKey TEXT NOT NULL,
    videoId TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (trackKey, videoId)
  );

  CREATE INDEX IF NOT EXISTS idx_track_video_rejects_created
    ON track_video_rejects(createdAt DESC);
`);

// Safe incremental migrations for existing databases
const playlistColumns = db.prepare('PRAGMA table_info(playlists)').all() as Array<{name: string}>;
const playlistColNames = new Set(playlistColumns.map((c) => c.name));
if (!playlistColNames.has('source')) {
  db.exec("ALTER TABLE playlists ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
}
if (!playlistColNames.has('m3u_path')) {
  db.exec('ALTER TABLE playlists ADD COLUMN m3u_path TEXT');
}
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_m3u_path ON playlists(m3u_path) WHERE m3u_path IS NOT NULL'
);

const trackColumns = db.prepare('PRAGMA table_info(tracks)').all() as Array<{name: string}>;
const trackColNames = new Set(trackColumns.map((c) => c.name));
if (!trackColNames.has('file_hash')) {
  db.exec('ALTER TABLE tracks ADD COLUMN file_hash TEXT');
}
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_tracks_file_hash ON tracks(file_hash) WHERE file_hash IS NOT NULL'
);
if (!trackColNames.has('youtube_video_id')) {
  db.exec('ALTER TABLE tracks ADD COLUMN youtube_video_id TEXT');
}
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_tracks_youtube_video_id ON tracks(youtube_video_id) WHERE youtube_video_id IS NOT NULL'
);

const downloadJobColumns = db
  .prepare('PRAGMA table_info(download_jobs)')
  .all() as Array<{name: string}>;
const downloadJobColNames = new Set(downloadJobColumns.map((c) => c.name));
if (!downloadJobColNames.has('quality')) {
  db.exec("ALTER TABLE download_jobs ADD COLUMN quality TEXT NOT NULL DEFAULT 'ultra'");
}

// Seed default settings on first boot
const defaultSettings: Record<string, string> = {
  music_dir: DEFAULT_MUSIC_DIR,
  ytdlp_path: DEFAULT_YTDLP_PATH,
  ffmpeg_path: DEFAULT_FFMPEG_PATH,
  ytdlp_remote_components: 'true',
  ytdlp_player_client: '',
  ytdlp_resolve_timeout_ms: '35000',
  ytdlp_resolve_fallback_timeout_ms: '30000',
  ytdlp_sleep_interval: '2',
  ytdlp_max_sleep_interval: '5',
  ytdlp_force_ipv4: 'true',
  ytdlp_extra_flags: '',
  ytdlp_crop_cover: 'true',
  ytdlp_download_quality: 'ultra',
  cookies_status: 'missing',
  cookies_tested_at: '',
  jwt_secret:
    process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16
      ? process.env.JWT_SECRET.trim()
      : crypto.randomBytes(32).toString('hex'),
};

const insertSettingStmt = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
const upsertSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const getAllSettingsStmt = db.prepare('SELECT key, value FROM settings');

const seedTx = db.transaction(() => {
  for (const [key, value] of Object.entries(defaultSettings)) {
    insertSettingStmt.run(key, value);
  }
});
seedTx();

export function getSetting(key: string, fallback = ''): string {
  const row = getSettingStmt.get(key) as {value: string} | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  upsertSettingStmt.run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getAllSettingsStmt.all() as Array<{key: string; value: string}>;
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.key === 'jwt_secret') continue; // Never expose JWT secret to API
    out[row.key] = row.value;
  }
  return out;
}

export function getMusicDir(): string {
  return getSetting('music_dir', DEFAULT_MUSIC_DIR).trim() || DEFAULT_MUSIC_DIR;
}

export function getYtdlpPath(): string {
  return getSetting('ytdlp_path', DEFAULT_YTDLP_PATH).trim() || DEFAULT_YTDLP_PATH;
}

export function getFfmpegPath(): string {
  return getSetting('ffmpeg_path', DEFAULT_FFMPEG_PATH).trim() || DEFAULT_FFMPEG_PATH;
}

export function getJwtSecret(): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16) {
    return process.env.JWT_SECRET.trim();
  }
  return getSetting('jwt_secret');
}

export interface PlayHistoryRow {
  id: number;
  user_id: number;
  title: string;
  artist: string;
  track_id: number | null;
  video_id: string;
  played_at: number;
}

const insertPlayHistoryStmt = db.prepare(
  `INSERT INTO play_history (user_id, title, artist, track_id, video_id, played_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const getRecentPlayHistoryStmt = db.prepare(
  `SELECT id, user_id, title, artist, track_id, video_id, played_at
   FROM play_history
   WHERE user_id = ?
   ORDER BY played_at DESC, id DESC
   LIMIT ?`
);
const prunePlayHistoryStmt = db.prepare(
  `DELETE FROM play_history
   WHERE user_id = ?
     AND id NOT IN (
       SELECT id FROM play_history
       WHERE user_id = ?
       ORDER BY played_at DESC, id DESC
       LIMIT 200
     )`
);

const STRICT_YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function recordPlayHistory(entry: {
  userId: number;
  title: string;
  artist: string;
  trackId?: number | null;
  videoId?: string;
  playedAt?: number;
}): void {
  const title = entry.title.trim().slice(0, 200);
  const artist = entry.artist.trim().slice(0, 200);
  if (!title && !artist) return;

  const playedAt =
    typeof entry.playedAt === 'number' && Number.isFinite(entry.playedAt) && entry.playedAt > 0
      ? Math.floor(entry.playedAt)
      : Date.now();
  const trackId =
    typeof entry.trackId === 'number' && Number.isInteger(entry.trackId) && entry.trackId > 0
      ? entry.trackId
      : null;
  const rawVideoId = (entry.videoId || '').trim();
  const videoId = STRICT_YOUTUBE_VIDEO_ID_RE.test(rawVideoId) ? rawVideoId : '';

  insertPlayHistoryStmt.run(
    entry.userId,
    title || 'Unknown Title',
    artist || 'Unknown Artist',
    trackId,
    videoId,
    playedAt
  );

  // Periodically cap history to the latest 200 plays per user
  if (Math.random() < 0.1) {
    prunePlayHistoryStmt.run(entry.userId, entry.userId);
  }
}

export function getRecentPlayHistory(userId: number, limit = 30): PlayHistoryRow[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return getRecentPlayHistoryStmt.all(userId, safeLimit) as PlayHistoryRow[];
}

// ---------------------------------------------------------------------------
// Durable Resolved Stream URL Cache
// ---------------------------------------------------------------------------

export interface StreamUrlCacheRow {
  video_id: string;
  url: string;
  egress: string;
  resolved_at: number;
  expires_at: number;
  headers_json: string;
  strategy: string;
  content_type: string;
  content_length: number | null;
  duration: number | null;
  client_param: string | null;
  format_id: string | null;
  used_format_headers: number;
}

const getStreamUrlCacheStmt = db.prepare(
  `SELECT video_id, url, egress, resolved_at, expires_at,
          headers_json, strategy, content_type, content_length,
          duration, client_param, format_id, used_format_headers
   FROM stream_url_cache
   WHERE video_id = ? AND egress = ? AND expires_at > ?`
);

const upsertStreamUrlCacheStmt = db.prepare(
  `INSERT INTO stream_url_cache (
     video_id, url, egress, resolved_at, expires_at,
     headers_json, strategy, content_type, content_length,
     duration, client_param, format_id, used_format_headers
   )
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(video_id) DO UPDATE SET
     url = excluded.url,
     egress = excluded.egress,
     resolved_at = excluded.resolved_at,
     expires_at = excluded.expires_at,
     headers_json = excluded.headers_json,
     strategy = excluded.strategy,
     content_type = excluded.content_type,
     content_length = excluded.content_length,
     duration = excluded.duration,
     client_param = excluded.client_param,
     format_id = excluded.format_id,
     used_format_headers = excluded.used_format_headers`
);

const deleteStreamUrlCacheStmt = db.prepare(
  'DELETE FROM stream_url_cache WHERE video_id = ?'
);

const pruneStreamUrlCacheStmt = db.prepare(
  'DELETE FROM stream_url_cache WHERE expires_at <= ?'
);

export function getCachedStreamUrlRow(
  videoId: string,
  egress: string,
  safetyMarginSec = 60
): StreamUrlCacheRow | null {
  if (!videoId || !STRICT_YOUTUBE_VIDEO_ID_RE.test(videoId) || !egress) return null;
  const nowSec = Date.now() / 1000 + Math.max(0, safetyMarginSec);
  const row = getStreamUrlCacheStmt.get(videoId, egress, nowSec) as StreamUrlCacheRow | undefined;
  return row ?? null;
}

export function setCachedStreamUrlRow(entry: {
  videoId: string;
  url: string;
  egress: string;
  resolvedAtSec: number;
  expiresAtSec: number;
  headers: Record<string, string>;
  strategy: string;
  contentType: string;
  contentLength: number | null;
  duration: number | null;
  clientParam: string | null;
  formatId: string | null;
  usedFormatHeaders: boolean;
}): void {
  if (!entry.videoId || !STRICT_YOUTUBE_VIDEO_ID_RE.test(entry.videoId) || !entry.url || !entry.egress) {
    return;
  }
  if (!Number.isFinite(entry.expiresAtSec) || entry.expiresAtSec <= Date.now() / 1000) return;
  upsertStreamUrlCacheStmt.run(
    entry.videoId,
    entry.url,
    entry.egress,
    entry.resolvedAtSec,
    entry.expiresAtSec,
    JSON.stringify(entry.headers || {}),
    entry.strategy || 'default',
    entry.contentType || 'audio/mp4',
    entry.contentLength,
    entry.duration,
    entry.clientParam,
    entry.formatId,
    entry.usedFormatHeaders ? 1 : 0
  );
}

export function invalidateCachedStreamUrlRow(videoId: string): void {
  if (!videoId || !STRICT_YOUTUBE_VIDEO_ID_RE.test(videoId)) return;
  deleteStreamUrlCacheStmt.run(videoId);
}

export function pruneExpiredStreamUrlCache(): number {
  const result = pruneStreamUrlCacheStmt.run(Date.now() / 1000);
  return result.changes || 0;
}

// ---------------------------------------------------------------------------
// Related Mix Cache (6-hour TTL)
// ---------------------------------------------------------------------------

export const RELATED_MIX_TTL_MS = 6 * 60 * 60 * 1000;

export interface RelatedMixCacheRow {
  video_id: string;
  rows_json: string;
  fetched_at: number;
}

const getRelatedMixStmt = db.prepare(
  `SELECT video_id, rows_json, fetched_at
   FROM related_mix
   WHERE video_id = ? AND fetched_at > ?`
);

const upsertRelatedMixStmt = db.prepare(
  `INSERT INTO related_mix (video_id, rows_json, fetched_at)
   VALUES (?, ?, ?)
   ON CONFLICT(video_id) DO UPDATE SET
     rows_json = excluded.rows_json,
     fetched_at = excluded.fetched_at`
);

const pruneRelatedMixStmt = db.prepare(
  'DELETE FROM related_mix WHERE fetched_at <= ?'
);

export function getRelatedMixCacheRow<T = unknown>(
  videoId: string,
  ttlMs = RELATED_MIX_TTL_MS
): {videoId: string; rows: T[]; fetchedAt: number} | null {
  if (!videoId || !STRICT_YOUTUBE_VIDEO_ID_RE.test(videoId)) return null;
  const cutoff = Date.now() - Math.max(1000, ttlMs);
  const row = getRelatedMixStmt.get(videoId, cutoff) as RelatedMixCacheRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.rows_json);
    if (!Array.isArray(parsed)) return null;
    return {videoId: row.video_id, rows: parsed as T[], fetchedAt: row.fetched_at};
  } catch {
    return null;
  }
}

export function setRelatedMixCacheRow(
  videoId: string,
  rows: unknown[],
  fetchedAt = Date.now()
): void {
  if (!videoId || !STRICT_YOUTUBE_VIDEO_ID_RE.test(videoId)) return;
  if (!Array.isArray(rows)) return;
  const ts = Number.isFinite(fetchedAt) && fetchedAt > 0 ? Math.floor(fetchedAt) : Date.now();
  upsertRelatedMixStmt.run(videoId, JSON.stringify(rows), ts);
  if (Math.random() < 0.05) {
    pruneRelatedMixStmt.run(ts - RELATED_MIX_TTL_MS);
  }
}

export function pruneExpiredRelatedMixCache(ttlMs = RELATED_MIX_TTL_MS): number {
  const cutoff = Date.now() - Math.max(1000, ttlMs);
  const result = pruneRelatedMixStmt.run(cutoff);
  return result.changes || 0;
}

// ---------------------------------------------------------------------------
// Per-User Listening Signals (capped at 5,000 events per user)
// ---------------------------------------------------------------------------

export const LISTENING_EVENTS_MAX_PER_USER = 5000;

export type ListeningEventName =
  | 'played_30s'
  | 'generated_completed'
  | 'generated_skipped_early';

export interface ListeningEventRow {
  id: number;
  user_id: number;
  event: ListeningEventName;
  track_id: string;
  video_id: string;
  title: string;
  artist: string;
  album: string;
  source: string;
  listened_sec: number;
  created_at: string;
}

const insertListeningEventStmt = db.prepare(
  `INSERT INTO listening_events (
     user_id, event, track_id, video_id, title, artist, album, source, listened_sec
   )
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const countListeningEventsStmt = db.prepare(
  'SELECT COUNT(*) AS cnt FROM listening_events WHERE user_id = ?'
);

const pruneListeningEventsStmt = db.prepare(
  `DELETE FROM listening_events
   WHERE user_id = ?
     AND id NOT IN (
       SELECT id FROM listening_events
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?
     )`
);

const getUserListeningEventsStmt = db.prepare(
  `SELECT id, user_id, event, track_id, video_id, title, artist, album, source, listened_sec, created_at
   FROM listening_events
   WHERE user_id = ?
   ORDER BY created_at DESC, id DESC
   LIMIT ?`
);

const clearUserListeningEventsStmt = db.prepare(
  'DELETE FROM listening_events WHERE user_id = ?'
);

export function recordListeningEvent(entry: {
  userId: number;
  event: ListeningEventName;
  trackId?: string;
  videoId?: string;
  title?: string;
  artist?: string;
  album?: string;
  source?: string;
  listenedSec?: number;
}): void {
  const trackId = String(entry.trackId ?? '').trim().slice(0, 80);
  const rawVideoId = String(entry.videoId ?? '').trim();
  const videoId = STRICT_YOUTUBE_VIDEO_ID_RE.test(rawVideoId) ? rawVideoId : '';
  const title = String(entry.title ?? '').trim().slice(0, 200);
  const artist = String(entry.artist ?? '').trim().slice(0, 200);
  const album = String(entry.album ?? '').trim().slice(0, 200);
  const source = String(entry.source ?? '').trim().slice(0, 32);
  const listenedSec =
    typeof entry.listenedSec === 'number' && Number.isFinite(entry.listenedSec) && entry.listenedSec >= 0
      ? Math.min(86400, Math.round(entry.listenedSec * 100) / 100)
      : 0;

  insertListeningEventStmt.run(
    entry.userId,
    entry.event,
    trackId,
    videoId,
    title,
    artist,
    album,
    source,
    listenedSec
  );

  const row = countListeningEventsStmt.get(entry.userId) as {cnt?: number} | undefined;
  if ((row?.cnt ?? 0) > LISTENING_EVENTS_MAX_PER_USER) {
    pruneListeningEventsStmt.run(entry.userId, entry.userId, LISTENING_EVENTS_MAX_PER_USER);
  }
}

export function getUserListeningEvents(
  userId: number,
  limit = LISTENING_EVENTS_MAX_PER_USER
): ListeningEventRow[] {
  const safeLimit = Math.max(1, Math.min(LISTENING_EVENTS_MAX_PER_USER, Math.floor(limit)));
  return getUserListeningEventsStmt.all(userId, safeLimit) as ListeningEventRow[];
}

export function clearUserListeningEvents(userId: number): number {
  const result = clearUserListeningEventsStmt.run(userId);
  return result.changes || 0;
}




