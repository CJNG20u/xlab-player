import crypto from 'crypto';
import {EventEmitter} from 'events';
import fs from 'fs';
import path from 'path';
import {parseFile} from 'music-metadata';
import {COVERS_DIR, db, getMusicDir} from './db.ts';

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.opus',
  '.flac',
  '.ogg',
  '.wav',
  '.webm',
  '.aac',
]);
export const PLAYLIST_EXTENSIONS = new Set(['.m3u', '.m3u8']);

export function computeFileSha256(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface ScanProgress {
  status: 'idle' | 'scanning' | 'done' | 'error';
  found: number;
  scanned: number;
  imported: number;
  updated: number;
  removed: number;
  playlistsImported: number;
  currentFile: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export const scanEvents = new EventEmitter();
scanEvents.setMaxListeners(50);

let currentScan: ScanProgress = {
  status: 'idle',
  found: 0,
  scanned: 0,
  imported: 0,
  updated: 0,
  removed: 0,
  playlistsImported: 0,
  currentFile: '',
};

export function getScanState(): ScanProgress {
  return {...currentScan};
}

function emitScan(patch: Partial<ScanProgress>): void {
  currentScan = {...currentScan, ...patch};
  scanEvents.emit('progress', {...currentScan});
}

// Curated dark-friendly fallback tints for tracks without embedded artwork
const FALLBACK_PALETTE = [
  '#1b4332',
  '#2b3a4a',
  '#3f2e3e',
  '#4a2c2a',
  '#2c3e50',
  '#3d342b',
  '#1f3b4d',
  '#352f44',
];

function deterministicColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
}

// Compute a muted dark tint color from raw image bytes without native imaging dependencies
function deriveTintFromCover(buffer: Uint8Array, seed: string): string {
  const hash = crypto
    .createHash('md5')
    .update(buffer.subarray(0, Math.min(buffer.length, 4096)))
    .digest();
  const hue = Math.round(((hash[0] << 8) | hash[1]) % 360);
  const sat = 36 + (hash[2] % 22);
  const light = 22 + (hash[3] % 10);
  return hslToHex(hue, sat, light) || deterministicColor(seed);
}

function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function extractSidecarLyrics(absAudioPath: string): string | null {
  const ext = path.extname(absAudioPath);
  const lrcPath = absAudioPath.slice(0, absAudioPath.length - ext.length) + '.lrc';
  try {
    if (fs.existsSync(lrcPath)) {
      const content = fs.readFileSync(lrcPath, 'utf-8').trim();
      return content || null;
    }
  } catch {
    // Ignore unreadable sidecar
  }
  return null;
}

function extractEmbeddedLyrics(common: {
  lyrics?: Array<string | {text?: string; syncText?: Array<{text?: string}>}>;
}): string | null {
  if (!common.lyrics || common.lyrics.length === 0) return null;
  const parts: string[] = [];
  for (const item of common.lyrics) {
    if (typeof item === 'string' && item.trim()) {
      parts.push(item.trim());
    } else if (item && typeof item === 'object') {
      if (item.text && item.text.trim()) {
        parts.push(item.text.trim());
      } else if (Array.isArray(item.syncText)) {
        const lines = item.syncText
          .map((s) => (s.text || '').trim())
          .filter(Boolean)
          .join('\n');
        if (lines) parts.push(lines);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function collectMediaFiles(
  dir: string,
  audioFiles: string[] = [],
  playlistFiles: string[] = []
): {audioFiles: string[]; playlistFiles: string[]} {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return {audioFiles, playlistFiles};
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMediaFiles(fullPath, audioFiles, playlistFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        audioFiles.push(fullPath);
      } else if (PLAYLIST_EXTENSIONS.has(ext)) {
        playlistFiles.push(fullPath);
      }
    }
  }
  return {audioFiles, playlistFiles};
}

const upsertTrackStmt = db.prepare(`
  INSERT INTO tracks (
    rel_path, title, artist, album, track_number, year,
    duration, format, bitrate, size_bytes, cover_file, dominant_color, lyrics, file_hash,
    added_at, updated_at
  ) VALUES (
    @rel_path, @title, @artist, @album, @track_number, @year,
    @duration, @format, @bitrate, @size_bytes, @cover_file, @dominant_color, @lyrics, @file_hash,
    datetime('now'), datetime('now')
  )
  ON CONFLICT(rel_path) DO UPDATE SET
    title = excluded.title,
    artist = excluded.artist,
    album = excluded.album,
    track_number = excluded.track_number,
    year = excluded.year,
    duration = excluded.duration,
    format = excluded.format,
    bitrate = excluded.bitrate,
    size_bytes = excluded.size_bytes,
    cover_file = COALESCE(excluded.cover_file, tracks.cover_file),
    dominant_color = excluded.dominant_color,
    lyrics = COALESCE(excluded.lyrics, tracks.lyrics),
    file_hash = COALESCE(excluded.file_hash, tracks.file_hash),
    updated_at = datetime('now')
`);

export interface IndexSingleFileOverrides {
  fileHash?: string;
  title?: string;
  artist?: string;
  album?: string;
  coverFilePath?: string | null;
}

const SHA256_BASENAME_RE = /^[a-f0-9]{64}$/i;

export async function indexSingleFile(
  absPath: string,
  musicDir = getMusicDir(),
  overrides: IndexSingleFileOverrides = {}
): Promise<{id: number; isNew: boolean; fileHash: string | null}> {
  const relPath = path.relative(musicDir, absPath).split(path.sep).join('/');
  const stat = fs.statSync(absPath);
  const existing = db
    .prepare(
      'SELECT id, title, artist, album, cover_file, dominant_color, file_hash FROM tracks WHERE rel_path = ?'
    )
    .get(relPath) as
    | {
        id: number;
        title: string;
        artist: string;
        album: string;
        cover_file: string | null;
        dominant_color: string;
        file_hash: string | null;
      }
    | undefined;

  const baseName = path.basename(absPath, path.extname(absPath));
  const ext = path.extname(absPath).replace('.', '').toLowerCase();
  const isHashNamedFile = SHA256_BASENAME_RE.test(baseName);

  let title =
    overrides.title?.trim() ||
    (isHashNamedFile && existing?.title && !SHA256_BASENAME_RE.test(existing.title)
      ? existing.title
      : baseName);
  let artist =
    overrides.artist?.trim() ||
    (isHashNamedFile && existing?.artist ? existing.artist : 'Unknown Artist');
  let album =
    overrides.album?.trim() ||
    (isHashNamedFile && existing?.album ? existing.album : 'Unknown Album');
  let trackNumber: number | null = null;
  let year: number | null = null;
  let duration = 0;
  let bitrate = 0;
  let detectedFormat = ext;
  let coverFile: string | null = existing?.cover_file || null;
  let dominantColor = existing?.dominant_color || deterministicColor(relPath);
  let lyrics: string | null = extractSidecarLyrics(absPath);

  if (!isHashNamedFile && !overrides.artist) {
    const segments = relPath.split('/');
    if (segments.length >= 3) {
      artist = segments[segments.length - 3] || artist;
      album = segments[segments.length - 2] || album;
    } else if (
      segments.length === 2 &&
      segments[0].toLowerCase() !== 'uploads' &&
      segments[0].toLowerCase() !== 'tracks' &&
      segments[0].toLowerCase() !== 'downloads'
    ) {
      artist = segments[0] || artist;
    }
  }

  let hasEmbeddedCover = false;
  try {
    const metadata = await parseFile(absPath, {duration: true});
    const {common, format} = metadata;
    if (common.title?.trim() && !overrides.title?.trim()) title = common.title.trim();
    if (common.artist?.trim() && !overrides.artist?.trim()) artist = common.artist.trim();
    else if (common.albumartist?.trim() && !overrides.artist?.trim()) artist = common.albumartist.trim();
    if (common.album?.trim() && !overrides.album?.trim()) album = common.album.trim();
    if (common.track?.no) trackNumber = common.track.no;
    if (common.year) year = common.year;
    if (format.duration) duration = Math.round(format.duration * 100) / 100;
    if (format.bitrate) bitrate = Math.round(format.bitrate / 1000);
    if (!detectedFormat && format.codec) {
      detectedFormat = format.codec.toLowerCase().slice(0, 16);
    }

    if (!lyrics) {
      lyrics = extractEmbeddedLyrics(common as Parameters<typeof extractEmbeddedLyrics>[0]);
    }

    const picture = common.picture && common.picture[0];
    if (picture && picture.data && picture.data.length > 0) {
      const hash = crypto.createHash('sha1').update(picture.data).digest('hex');
      const imgExt = picture.format?.includes('png')
        ? 'png'
        : picture.format?.includes('webp')
          ? 'webp'
          : 'jpg';
      const fileName = `${hash}.${imgExt}`;
      const destPath = path.join(COVERS_DIR, fileName);
      if (!fs.existsSync(destPath)) {
        fs.writeFileSync(destPath, picture.data);
      }
      coverFile = fileName;
      dominantColor = deriveTintFromCover(picture.data, `${artist}-${album}`);
      hasEmbeddedCover = true;
    }
  } catch {
    // Fall back to overrides / computed values below
  }

  // Fallback cover ingestion for containers like Opus/WebM that may not carry embedded artwork
  if (!hasEmbeddedCover && overrides.coverFilePath && fs.existsSync(overrides.coverFilePath)) {
    try {
      const coverBytes = fs.readFileSync(overrides.coverFilePath);
      if (coverBytes.length > 0) {
        const hash = crypto.createHash('sha1').update(coverBytes).digest('hex');
        const coverExt = path.extname(overrides.coverFilePath).replace('.', '').toLowerCase();
        const safeCoverExt =
          coverExt === 'png' || coverExt === 'webp' || coverExt === 'jpeg' || coverExt === 'jpg'
            ? coverExt === 'jpeg'
              ? 'jpg'
              : coverExt
            : 'jpg';
        const fileName = `${hash}.${safeCoverExt}`;
        const destPath = path.join(COVERS_DIR, fileName);
        if (!fs.existsSync(destPath)) {
          fs.writeFileSync(destPath, coverBytes);
        }
        coverFile = fileName;
        dominantColor = deriveTintFromCover(coverBytes, `${artist}-${album}`);
        hasEmbeddedCover = true;
      }
    } catch {
      // Ignore unreadable external cover
    }
  }

  if (!hasEmbeddedCover && !existing?.cover_file) {
    dominantColor = deterministicColor(`${artist}-${album}`);
  }

  // Estimate bitrate if container metadata omitted it
  if (!bitrate && duration > 0 && stat.size > 0) {
    bitrate = Math.round((stat.size * 8) / duration / 1000);
  }

  let fileHash = overrides.fileHash || existing?.file_hash || null;
  if (!fileHash && isHashNamedFile) {
    fileHash = baseName.toLowerCase();
  }
  if (!fileHash) {
    try {
      fileHash = await computeFileSha256(absPath);
    } catch {
      fileHash = null;
    }
  }

  upsertTrackStmt.run({
    rel_path: relPath,
    title,
    artist,
    album,
    track_number: trackNumber,
    year,
    duration,
    format: detectedFormat || ext,
    bitrate,
    size_bytes: stat.size,
    cover_file: coverFile,
    dominant_color: dominantColor,
    lyrics,
    file_hash: fileHash,
  });

  const row = db
    .prepare('SELECT id FROM tracks WHERE rel_path = ?')
    .get(relPath) as {id: number};
  return {id: row.id, isNew: !existing, fileHash};
}

interface ParsedM3uEntry {
  rawPath: string;
  extInfTitle?: string;
}

function parseM3uContent(content: string): {playlistName: string | null; entries: ParsedM3uEntry[]} {
  const clean = content.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  let playlistName: string | null = null;
  const entries: ParsedM3uEntry[] = [];
  let pendingExtInf: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#PLAYLIST:/i.test(line)) {
        const val = line.slice('#PLAYLIST:'.length).trim();
        if (val) playlistName = val;
      } else if (/^#EXTINF:/i.test(line)) {
        const commaIdx = line.indexOf(',');
        if (commaIdx !== -1) {
          pendingExtInf = line.slice(commaIdx + 1).trim();
        }
      }
      continue;
    }

    entries.push({rawPath: line, extInfTitle: pendingExtInf});
    pendingExtInf = undefined;
  }

  return {playlistName, entries};
}

function syncM3uPlaylists(playlistFiles: string[], musicDir: string): number {
  const ownerRow = db
    .prepare("SELECT id FROM users ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id ASC LIMIT 1")
    .get() as {id: number} | undefined;

  if (!ownerRow) return 0;

  const allTracks = db
    .prepare('SELECT id, rel_path, title, artist FROM tracks')
    .all() as Array<{id: number; rel_path: string; title: string; artist: string}>;

  const byRelExact = new Map<string, number>();
  const byRelLower = new Map<string, number>();
  const byBaseLower = new Map<string, Array<{id: number; rel_path: string; title: string; artist: string}>>();

  for (const t of allTracks) {
    const normRel = t.rel_path.replace(/\\/g, '/');
    byRelExact.set(normRel, t.id);
    byRelLower.set(normRel.toLowerCase(), t.id);
    const base = path.posix.basename(normRel).toLowerCase();
    const list = byBaseLower.get(base) || [];
    list.push(t);
    byBaseLower.set(base, list);
  }

  const resolveTrackId = (entry: ParsedM3uEntry, m3uDirAbs: string): number | null => {
    let raw = entry.rawPath.trim();
    if (!raw || /^https?:\/\//i.test(raw)) return null;

    // Decode file:// URLs if present
    if (/^file:\/\//i.test(raw)) {
      try {
        raw = decodeURIComponent(raw.replace(/^file:\/\//i, ''));
      } catch {
        raw = raw.replace(/^file:\/\//i, '');
      }
    }

    const posixRaw = raw.replace(/\\/g, '/');

    // 1. Resolve relative to the M3U file's directory (e.g. ../Artist/Album/Song.m4a)
    if (!path.isAbsolute(raw) && !/^[a-zA-Z]:\//.test(posixRaw)) {
      const candidateAbs = path.resolve(m3uDirAbs, posixRaw);
      const candidateRel = path.relative(musicDir, candidateAbs).split(path.sep).join('/');
      const exact = byRelExact.get(candidateRel) ?? byRelLower.get(candidateRel.toLowerCase());
      if (exact !== undefined) return exact;

      // Also check relative to musicDir root directly
      const stripped = posixRaw.replace(/^\.?\//, '');
      const fromRoot = byRelExact.get(stripped) ?? byRelLower.get(stripped.toLowerCase());
      if (fromRoot !== undefined) return fromRoot;
    } else {
      // 2. Absolute path on same mount
      const relFromMount = path.relative(musicDir, raw).split(path.sep).join('/');
      if (!relFromMount.startsWith('..')) {
        const hit = byRelExact.get(relFromMount) ?? byRelLower.get(relFromMount.toLowerCase());
        if (hit !== undefined) return hit;
      }
    }

    // 3. Suffix match for full paths exported from another OS/mount (e.g. /Volumes/NAS/music/Artist/Album/Song.m4a)
    const lowerPosix = posixRaw.toLowerCase();
    for (const [relLower, id] of byRelLower.entries()) {
      if (lowerPosix.endsWith('/' + relLower) || lowerPosix === relLower) {
        return id;
      }
    }

    // 4. Filename match fallback (using #EXTINF hint to disambiguate duplicates)
    const baseName = path.posix.basename(posixRaw).toLowerCase();
    const candidates = byBaseLower.get(baseName);
    if (candidates && candidates.length === 1) {
      return candidates[0].id;
    }
    if (candidates && candidates.length > 1) {
      if (entry.extInfTitle) {
        const hint = entry.extInfTitle.toLowerCase();
        const best = candidates.find(
          (c) =>
            hint.includes(c.artist.toLowerCase()) || hint.includes(c.title.toLowerCase())
        );
        if (best) return best.id;
      }
      return candidates[0].id;
    }

    return null;
  };

  const seenM3uRelPaths = new Set<string>();
  let syncedCount = 0;

  const findExistingStmt = db.prepare('SELECT id FROM playlists WHERE m3u_path = ?');
  const insertPlaylistStmt = db.prepare(
    "INSERT INTO playlists (user_id, name, description, source, m3u_path, created_at, updated_at) VALUES (?, ?, ?, 'm3u', ?, datetime('now'), datetime('now'))"
  );
  const updatePlaylistStmt = db.prepare(
    "UPDATE playlists SET name = ?, description = ?, source = 'm3u', updated_at = datetime('now') WHERE id = ?"
  );
  const clearTracksStmt = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?');
  const insertPlaylistTrackStmt = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
  );

  const syncTx = db.transaction(() => {
    for (const absM3u of playlistFiles) {
      const m3uRelPath = path.relative(musicDir, absM3u).split(path.sep).join('/');
      seenM3uRelPaths.add(m3uRelPath);

      let content = '';
      try {
        content = fs.readFileSync(absM3u, 'utf-8');
      } catch {
        continue;
      }

      const parsed = parseM3uContent(content);
      const fallbackName = path.basename(absM3u, path.extname(absM3u));
      const playlistName = (parsed.playlistName || fallbackName).slice(0, 100);
      const description = `Imported from ${m3uRelPath}`;

      const m3uDirAbs = path.dirname(absM3u);
      const matchedTrackIds: number[] = [];
      for (const entry of parsed.entries) {
        const trackId = resolveTrackId(entry, m3uDirAbs);
        if (trackId !== null) {
          matchedTrackIds.push(trackId);
        }
      }

      const existing = findExistingStmt.get(m3uRelPath) as {id: number} | undefined;
      let playlistId: number;
      if (existing) {
        playlistId = existing.id;
        updatePlaylistStmt.run(playlistName, description, playlistId);
      } else {
        const info = insertPlaylistStmt.run(ownerRow.id, playlistName, description, m3uRelPath);
        playlistId = Number(info.lastInsertRowid);
      }

      clearTracksStmt.run(playlistId);
      matchedTrackIds.forEach((trackId, position) => {
        insertPlaylistTrackStmt.run(playlistId, trackId, position);
      });
      syncedCount++;
    }

    // Remove stale M3U playlists whose .m3u/.m3u8 file no longer exists on disk
    const existingM3uRows = db
      .prepare("SELECT id, m3u_path FROM playlists WHERE source = 'm3u' AND m3u_path IS NOT NULL")
      .all() as Array<{id: number; m3u_path: string}>;
    const deletePlaylistStmt = db.prepare('DELETE FROM playlists WHERE id = ?');
    for (const row of existingM3uRows) {
      if (!seenM3uRelPaths.has(row.m3u_path)) {
        deletePlaylistStmt.run(row.id);
      }
    }
  });

  syncTx();
  return syncedCount;
}

export async function runLibraryScan(fullReindex = false): Promise<ScanProgress> {
  if (currentScan.status === 'scanning') {
    return getScanState();
  }

  const musicDir = getMusicDir();
  if (!fs.existsSync(musicDir)) {
    emitScan({
      status: 'error',
      found: 0,
      scanned: 0,
      imported: 0,
      updated: 0,
      removed: 0,
      playlistsImported: 0,
      currentFile: '',
      error: `Music directory not found: ${musicDir}`,
      finishedAt: new Date().toISOString(),
    });
    return getScanState();
  }

  emitScan({
    status: 'scanning',
    found: 0,
    scanned: 0,
    imported: 0,
    updated: 0,
    removed: 0,
    playlistsImported: 0,
    currentFile: 'Discovering audio files & M3U playlists...',
    error: undefined,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
  });

  try {
    const {audioFiles: absFiles, playlistFiles} = collectMediaFiles(musicDir);
    const existingRows = db
      .prepare('SELECT id, rel_path, size_bytes FROM tracks')
      .all() as Array<{id: number; rel_path: string; size_bytes: number}>;
    const existingMap = new Map(existingRows.map((r) => [r.rel_path, r]));

    emitScan({found: absFiles.length});

    const seenRelPaths = new Set<string>();
    let scanned = 0;
    let imported = 0;
    let updated = 0;

    for (const absPath of absFiles) {
      const relPath = path.relative(musicDir, absPath).split(path.sep).join('/');
      seenRelPaths.add(relPath);
      const existing = existingMap.get(relPath);

      let shouldParse = fullReindex || !existing;
      if (!shouldParse && existing) {
        try {
          const stat = fs.statSync(absPath);
          if (stat.size !== existing.size_bytes) {
            shouldParse = true;
          }
        } catch {
          shouldParse = true;
        }
      }

      if (shouldParse) {
        try {
          const res = await indexSingleFile(absPath, musicDir);
          if (res.isNew) imported++;
          else updated++;
        } catch {
          // Skip corrupted file without aborting scan
        }
      }

      scanned++;
      if (scanned % 3 === 0 || scanned === absFiles.length) {
        emitScan({
          scanned,
          imported,
          updated,
          currentFile: path.basename(absPath),
        });
      }
    }

    // Remove database records for tracks whose files are missing from the active mount
    let removed = 0;
    const deleteStmt = db.prepare('DELETE FROM tracks WHERE id = ?');
    const cleanupTx = db.transaction(() => {
      for (const row of existingRows) {
        if (!seenRelPaths.has(row.rel_path)) {
          deleteStmt.run(row.id);
          removed++;
        }
      }
    });
    cleanupTx();

    // Discover & sync .m3u / .m3u8 playlists inside music_dir and Playlists/
    if (playlistFiles.length > 0) {
      emitScan({currentFile: `Syncing ${playlistFiles.length} M3U playlist(s)...`});
    }
    const playlistsImported = syncM3uPlaylists(playlistFiles, musicDir);

    emitScan({
      status: 'done',
      found: absFiles.length,
      scanned,
      imported,
      updated,
      removed,
      playlistsImported,
      currentFile: '',
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    emitScan({
      status: 'error',
      error: err instanceof Error ? err.message : 'Scan failed',
      finishedAt: new Date().toISOString(),
    });
  }

  return getScanState();
}

export function readTrackLyricsLive(relPath: string, storedLyrics: string | null): string | null {
  const musicDir = getMusicDir();
  const absPath = path.resolve(musicDir, relPath);
  const sidecar = extractSidecarLyrics(absPath);
  if (sidecar) return sidecar;
  return storedLyrics;
}
