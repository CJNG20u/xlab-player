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
export const COOKIES_FILE = path.resolve(SECRETS_DIR, 'cookies.txt');
export const DEFAULT_MUSIC_DIR = process.env.MUSIC_DIR?.trim()
  ? path.resolve(process.env.MUSIC_DIR.trim())
  : path.resolve(ROOT_DIR, 'music_library');
export const DEFAULT_YTDLP_PATH = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
export const DEFAULT_FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

// Ensure core runtime directories exist
for (const dir of [DATA_DIR, COVERS_DIR, SECRETS_DIR]) {
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
  ytdlp_player_client: 'web,mweb,android_vr',
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
