import type Database from 'better-sqlite3';
import {hasWholeWordMarker} from './downloader.ts';
import {normalizeIgnoredRelPath} from './db.ts';

// Mirrors WRONG_VERSION_MARKERS from server/downloader.ts so version-marker
// separation stays identical without modifying downloader.ts.
export const DUPLICATE_VERSION_MARKERS = [
  'live',
  'cover',
  'karaoke',
  'instrumental',
  'remix',
  'acoustic',
  'unplugged',
  'sped up',
  'slowed',
  'nightcore',
  '8d',
  'reverb',
  'tribute',
  'medley',
  'mashup',
  'parody',
  'backing track',
] as const;

const LOSSLESS_FORMATS = new Set(['flac', 'wav', 'alac', 'aiff', 'aif', 'ape', 'wv', 'pcm']);

const EDITION_SUFFIX_CORE =
  '(?:\\d{4}\\s+)?(?:' +
  'remaster(?:ed)?(?:\\s+\\d{4})?' +
  '|single\\s+version' +
  '|album\\s+version' +
  '|radio\\s+edit' +
  '|explicit(?:\\s+version)?' +
  '|clean(?:\\s+version)?' +
  '|deluxe(?:\\s+edition)?' +
  '|bonus\\s+track' +
  '|official(?:\\s+(?:music\\s+)?(?:video|audio|lyric\\s+video|visualizer))?' +
  '|lyric\\s+video' +
  '|lyrics' +
  '|audio' +
  '|visualizer' +
  '|hd|hq|mono|stereo' +
  '|original(?:\\s+(?:mix|version))?' +
  '|anniversary(?:\\s+edition)?' +
  '|mastered(?:\\s+for\\s+itunes)?' +
  ')';

const BRACKET_FEAT_RE = /[\[(]\s*(?:feat\.?|ft\.?|featuring|with)\b[^)\]]*[\])]/gi;
const BRACKET_EDITION_RE = new RegExp(`[\\[\\(]\\s*${EDITION_SUFFIX_CORE}\\s*[\\]\\)]`, 'gi');
const TRAILING_DASH_EDITION_RE = new RegExp(`\\s+[-–—|]\\s+${EDITION_SUFFIX_CORE}\\s*$`, 'i');
const TRAILING_FEAT_RE = /\s+(?:feat\.?|ft\.?|featuring)\b.*$/i;

export type DuplicateSourceKind = 'local' | 'youtube' | 'catalog';

export interface DuplicateInputTrack {
  id: number;
  rel_path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  format: string;
  bitrate: number;
  size_bytes: number;
  cover_file: string | null;
  dominant_color: string;
  added_at: string;
  file_hash?: string | null;
  youtube_video_id?: string | null;
  catalog_track_id?: string | null;
  playlistCount?: number;
  liked?: boolean;
  isPlaying?: boolean;
}

export interface DuplicateCopy {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  source: DuplicateSourceKind;
  sourceLabel: string;
  format: string;
  bitrate: number;
  qualityLabel: string;
  cover_file: string | null;
  dominant_color: string;
  added_at: string;
  playlistCount: number;
  liked: boolean;
  isPlaying: boolean;
  suggestedKeep: boolean;
}

export interface DuplicateGroup {
  id: string;
  matchType: 'definite' | 'likely';
  label: 'Same song' | 'Probably the same';
  suggestedKeepId: number;
  copies: DuplicateCopy[];
  safeForBulk: boolean;
  bulkSkipReason: string | null;
  bulkRemovableCount: number;
}

export interface BulkSafetyEvaluation {
  safe: boolean;
  skipReason: string | null;
}

export interface ResolvedKeepTrackSummary {
  id: number;
  rel_path: string;
  title: string;
  artist: string;
  album: string;
  track_number: number | null;
  year: number | null;
  duration: number;
  format: string;
  bitrate: number;
  size_bytes: number;
  cover_file: string | null;
  dominant_color: string;
  added_at: string;
  liked: boolean;
}

export interface ResolveDuplicateResult {
  keepId: number;
  removeId: number;
  playlistsUpdated: number;
  keepLiked: boolean;
  keepTrack: ResolvedKeepTrackSummary;
  remainingGroup: DuplicateGroup | null;
}

export interface BulkResolvedReplacement {
  removeId: number;
  keepId: number;
  keepLiked: boolean;
  playlistsUpdated: number;
  keepTrack: ResolvedKeepTrackSummary;
}

export interface BulkSkippedGroup {
  groupId: string;
  title: string;
  artist: string;
  copyCount: number;
  reason: string;
}

export interface BulkFailedGroup {
  groupId: string;
  title: string;
  artist: string;
  copyCount: number;
  reason: string;
}

export interface BulkResolveSummary {
  totalPlanned: number;
  removedCount: number;
  resolvedGroupCount: number;
  skippedCount: number;
  failedCount: number;
  replacements: BulkResolvedReplacement[];
  skipped: BulkSkippedGroup[];
  failed: BulkFailedGroup[];
}

export type BulkProgressEvent =
  | {
      type: 'start';
      totalPlanned: number;
      safeGroupCount: number;
      skippedGroupCount: number;
    }
  | {
      type: 'progress';
      removedCount: number;
      totalPlanned: number;
      groupId: string;
      status: 'resolved' | 'failed';
      replacements?: BulkResolvedReplacement[];
      error?: string;
    }
  | {
      type: 'done';
      summary: BulkResolveSummary;
    };

export class DuplicateResolveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'DuplicateResolveError';
  }
}

function stripAccentsLower(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extracts all whole-word version markers present in a title using the exact
 * same marker list and whole-word matching as server/downloader.ts.
 */
export function extractVersionMarkers(rawTitle: string): string[] {
  const markers: string[] = [];
  for (const marker of DUPLICATE_VERSION_MARKERS) {
    if (hasWholeWordMarker(rawTitle, marker)) {
      markers.push(marker);
    }
  }
  return markers;
}

/**
 * Normalizes a song title for duplicate detection:
 * - lowercases and removes accents
 * - strips (feat. ...), ft. ..., - Remastered, - Single Version, and similar suffixes
 * - removes remaining punctuation and collapses whitespace
 */
export function normalizeDuplicateTitle(rawTitle: string): string {
  let text = stripAccentsLower(rawTitle);
  text = text.replace(BRACKET_FEAT_RE, ' ');
  text = text.replace(BRACKET_EDITION_RE, ' ');

  // Repeatedly strip trailing dash/pipe edition suffixes (e.g. "Song - Single Version - Remastered")
  let prev = '';
  while (prev !== text) {
    prev = text;
    text = text.replace(TRAILING_DASH_EDITION_RE, '').trim();
  }

  text = text.replace(TRAILING_FEAT_RE, ' ');

  return text
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts and normalizes the primary artist name from an artist string.
 */
export function extractPrimaryArtist(rawArtist: string): string {
  let text = stripAccentsLower(rawArtist).trim();
  text = text.replace(/\s*[-–—]\s*topic\s*$/i, '').trim();
  if (!text) return '';

  // Split on collaboration delimiters and take the first non-empty primary artist
  const primary = text.split(
    /\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+|\s*[,;&/+]\s*/i
  )[0];

  return (primary || text)
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyTrackSource(track: {
  rel_path?: string | null;
  youtube_video_id?: string | null;
  catalog_track_id?: string | null;
}): DuplicateSourceKind {
  const rel = normalizeIgnoredRelPath(track.rel_path || '');
  const ytId = String(track.youtube_video_id || '').trim();
  const catalogId = String(track.catalog_track_id || '').trim();
  if (ytId || /^youtube\//i.test(rel)) {
    return 'youtube';
  }
  if (catalogId && !rel) {
    return 'catalog';
  }
  return 'local';
}

export function getSourceLabel(source: DuplicateSourceKind): string {
  switch (source) {
    case 'youtube':
      return 'YouTube';
    case 'catalog':
      return 'Catalog';
    default:
      return 'Local file';
  }
}

export function isLosslessFormat(format: string): boolean {
  return LOSSLESS_FORMATS.has(String(format || '').trim().toLowerCase());
}

export function formatQualityLabel(format: string, bitrate: number): string {
  const fmt = String(format || '').trim().toUpperCase();
  const kbps = Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : 0;
  if (isLosslessFormat(format)) {
    return fmt || 'Lossless';
  }
  if (kbps > 0 && fmt) {
    return `${kbps} kbps ${fmt}`;
  }
  if (kbps > 0) {
    return `${kbps} kbps`;
  }
  return fmt || 'Audio';
}

function compareCopiesForKeep(a: DuplicateCopy, b: DuplicateCopy): number {
  const aLossless = isLosslessFormat(a.format) ? 1 : 0;
  const bLossless = isLosslessFormat(b.format) ? 1 : 0;
  if (aLossless !== bLossless) return bLossless - aLossless;

  const aLocal = a.source === 'local' ? 1 : 0;
  const bLocal = b.source === 'local' ? 1 : 0;

  if (aLossless && bLossless) {
    if (aLocal !== bLocal) return bLocal - aLocal;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
  } else {
    // Prefer meaningfully higher bitrate; when equal/unknown, prefer local file
    const bothHaveBitrate = a.bitrate > 0 && b.bitrate > 0;
    if (bothHaveBitrate && Math.abs(a.bitrate - b.bitrate) >= 16) {
      return b.bitrate - a.bitrate;
    }
    if (aLocal !== bLocal) return bLocal - aLocal;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
  }

  // Next preference: copy present in the most playlists
  if (a.playlistCount !== b.playlistCount) {
    return b.playlistCount - a.playlistCount;
  }

  // Next preference: oldest added_at
  const aTime = a.added_at || '';
  const bTime = b.added_at || '';
  if (aTime !== bTime) {
    if (!aTime) return 1;
    if (!bTime) return -1;
    return aTime < bTime ? -1 : 1;
  }

  // Deterministic final tiebreaker: lowest id
  return a.id - b.id;
}

export function pickSuggestedKeepId(copies: DuplicateCopy[]): number {
  if (copies.length === 0) return -1;
  const sorted = [...copies].sort(compareCopiesForKeep);
  return sorted[0].id;
}

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({length: size}, (_, i) => i);
  }
  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    let cur = i;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      if (ra < rb) this.parent[rb] = ra;
      else this.parent[ra] = rb;
    }
  }
}

function durationsMatchLikely(aDuration: number, bDuration: number): boolean {
  const a = Number.isFinite(aDuration) ? aDuration : 0;
  const b = Number.isFinite(bDuration) ? bDuration : 0;
  if (a > 0 && b > 0) {
    return Math.abs(a - b) <= 3;
  }
  return a <= 0 && b <= 0;
}

/**
 * Pure duplicate detection over a list of library tracks.
 * Groups definite matches (same videoId, file path, file hash, or catalog id)
 * and likely matches (same normalized title + primary artist + version markers
 * and duration within +/- 3 seconds).
 */
export function detectDuplicateGroups(tracks: DuplicateInputTrack[]): DuplicateGroup[] {
  const n = tracks.length;
  if (n < 2) return [];

  const uf = new UnionFind(n);
  const definitePairs: Array<[number, number]> = [];

  const byVideoId = new Map<string, number>();
  const byFileHash = new Map<string, number>();
  const byRelPath = new Map<string, number>();
  const byCatalogId = new Map<string, number>();
  const likelyBuckets = new Map<string, number[]>();

  for (let i = 0; i < n; i++) {
    const t = tracks[i];

    // 1. Definite matching keys
    const videoId = String(t.youtube_video_id || '').trim();
    if (videoId) {
      const prev = byVideoId.get(videoId);
      if (prev !== undefined) {
        uf.union(prev, i);
        definitePairs.push([prev, i]);
      } else {
        byVideoId.set(videoId, i);
      }
    }

    const fileHash = String(t.file_hash || '').trim().toLowerCase();
    if (fileHash) {
      const prev = byFileHash.get(fileHash);
      if (prev !== undefined) {
        uf.union(prev, i);
        definitePairs.push([prev, i]);
      } else {
        byFileHash.set(fileHash, i);
      }
    }

    const normPath = normalizeIgnoredRelPath(t.rel_path || '').toLowerCase();
    if (normPath) {
      const prev = byRelPath.get(normPath);
      if (prev !== undefined) {
        uf.union(prev, i);
        definitePairs.push([prev, i]);
      } else {
        byRelPath.set(normPath, i);
      }
    }

    const catalogId = String(t.catalog_track_id || '').trim();
    if (catalogId) {
      const prev = byCatalogId.get(catalogId);
      if (prev !== undefined) {
        uf.union(prev, i);
        definitePairs.push([prev, i]);
      } else {
        byCatalogId.set(catalogId, i);
      }
    }

    // 2. Bucket for likely matches: normalized title + primary artist + version markers
    const normTitle = normalizeDuplicateTitle(t.title);
    const primaryArtist = extractPrimaryArtist(t.artist);
    if (normTitle && primaryArtist) {
      const versionKey = extractVersionMarkers(t.title).join('|');
      const bucketKey = `${primaryArtist}::${normTitle}::${versionKey}`;
      let bucket = likelyBuckets.get(bucketKey);
      if (!bucket) {
        bucket = [];
        likelyBuckets.set(bucketKey, bucket);
      }
      bucket.push(i);
    }
  }

  // Pairwise duration check inside each likely bucket (+/- 3s)
  for (const indices of likelyBuckets.values()) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const idxA = indices[a];
        const idxB = indices[b];
        if (durationsMatchLikely(tracks[idxA].duration, tracks[idxB].duration)) {
          uf.union(idxA, idxB);
        }
      }
    }
  }

  // Collect clusters with >= 2 tracks
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    let list = clusters.get(root);
    if (!list) {
      list = [];
      clusters.set(root, list);
    }
    list.push(i);
  }

  const definiteRoots = new Set<number>();
  for (const [a] of definitePairs) {
    definiteRoots.add(uf.find(a));
  }

  const groups: DuplicateGroup[] = [];

  for (const [root, memberIndices] of clusters.entries()) {
    if (memberIndices.length < 2) continue;

    const matchType: 'definite' | 'likely' = definiteRoots.has(root) ? 'definite' : 'likely';
    const label = matchType === 'definite' ? 'Same song' : 'Probably the same';

    const rawCopies: DuplicateCopy[] = memberIndices.map((idx) => {
      const t = tracks[idx];
      const source = classifyTrackSource(t);
      const bitrate = Number(t.bitrate) || 0;
      const format = String(t.format || '').trim().toLowerCase();
      return {
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: Number(t.duration) || 0,
        source,
        sourceLabel: getSourceLabel(source),
        format,
        bitrate,
        qualityLabel: formatQualityLabel(format, bitrate),
        cover_file: t.cover_file ?? null,
        dominant_color: t.dominant_color || '#1f3a2e',
        added_at: t.added_at || '',
        playlistCount: Number(t.playlistCount) || 0,
        liked: Boolean(t.liked),
        isPlaying: Boolean(t.isPlaying),
        suggestedKeep: false,
      };
    });

    const suggestedKeepId = pickSuggestedKeepId(rawCopies);
    const copies = rawCopies
      .map((copy) => ({
        ...copy,
        suggestedKeep: copy.id === suggestedKeepId,
      }))
      .sort((a, b) => {
        if (a.suggestedKeep !== b.suggestedKeep) return a.suggestedKeep ? -1 : 1;
        return compareCopiesForKeep(a, b);
      });

    const safety = evaluateBulkSafety(copies);
    const sortedIds = copies.map((c) => c.id).sort((a, b) => a - b);
    groups.push({
      id: `dup-${sortedIds.join('-')}`,
      matchType,
      label,
      suggestedKeepId,
      copies,
      safeForBulk: safety.safe,
      bulkSkipReason: safety.skipReason,
      bulkRemovableCount: safety.safe ? Math.max(0, copies.length - 1) : 0,
    });
  }

  groups.sort((a, b) => {
    if (a.matchType !== b.matchType) {
      return a.matchType === 'definite' ? -1 : 1;
    }
    const titleCmp = (a.copies[0]?.title || '').localeCompare(b.copies[0]?.title || '', undefined, {
      sensitivity: 'base',
    });
    if (titleCmp !== 0) return titleCmp;
    return (a.copies[0]?.artist || '').localeCompare(b.copies[0]?.artist || '', undefined, {
      sensitivity: 'base',
    });
  });

  return groups;
}

interface TrackDbRow {
  id: number;
  rel_path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  format: string;
  bitrate: number;
  size_bytes: number;
  cover_file: string | null;
  dominant_color: string;
  added_at: string;
  file_hash: string | null;
  youtube_video_id: string | null;
  playlist_count: number;
  liked: number;
}

export function findDuplicateGroupsForUser(
  database: Database.Database,
  options: {
    userId: number;
    userRole?: string;
    playingTrackIds?: ReadonlySet<number>;
  }
): DuplicateGroup[] {
  const {userId, userRole = 'listener', playingTrackIds} = options;

  const rows = database
    .prepare(
      `SELECT
         t.id,
         t.rel_path,
         t.title,
         t.artist,
         t.album,
         t.duration,
         t.format,
         t.bitrate,
         t.size_bytes,
         t.cover_file,
         t.dominant_color,
         t.added_at,
         t.file_hash,
         t.youtube_video_id,
         COALESCE(pc.cnt, 0) AS playlist_count,
         CASE WHEN lt.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked
       FROM tracks t
       LEFT JOIN (
         SELECT pt.track_id, COUNT(DISTINCT pt.playlist_id) AS cnt
         FROM playlist_tracks pt
         JOIN playlists p ON p.id = pt.playlist_id
         WHERE p.user_id = ? OR ? = 'admin' OR p.source = 'm3u'
         GROUP BY pt.track_id
       ) pc ON pc.track_id = t.id
       LEFT JOIN liked_tracks lt
         ON lt.track_id = t.id AND lt.user_id = ?
       ORDER BY t.id ASC`
    )
    .all(userId, userRole, userId) as TrackDbRow[];

  const inputs: DuplicateInputTrack[] = rows.map((row) => ({
    id: row.id,
    rel_path: row.rel_path,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    format: row.format,
    bitrate: row.bitrate,
    size_bytes: row.size_bytes,
    cover_file: row.cover_file,
    dominant_color: row.dominant_color,
    added_at: row.added_at,
    file_hash: row.file_hash,
    youtube_video_id: row.youtube_video_id,
    playlistCount: row.playlist_count,
    liked: Boolean(row.liked),
    isPlaying: Boolean(playingTrackIds?.has(row.id)),
  }));

  return detectDuplicateGroups(inputs);
}

export function evaluateBulkSafety(
  copies: DuplicateCopy[],
  playingTrackIds?: ReadonlySet<number>
): BulkSafetyEvaluation {
  if (copies.length < 2) {
    return {safe: false, skipReason: 'Skipped, review manually (only one copy)'};
  }

  // 1. No copy in the group may be playing right now
  if (copies.some((c) => c.isPlaying || Boolean(playingTrackIds?.has(c.id)))) {
    return {safe: false, skipReason: 'Skipped, review manually (currently playing)'};
  }

  // 2. Normalized title, primary artist, and version markers must match across all copies
  const firstTitle = normalizeDuplicateTitle(copies[0].title);
  const firstArtist = extractPrimaryArtist(copies[0].artist);
  const firstVersion = extractVersionMarkers(copies[0].title).join('|');
  if (!firstTitle || !firstArtist) {
    return {safe: false, skipReason: 'Skipped, review manually (missing title or artist)'};
  }
  for (let i = 1; i < copies.length; i++) {
    const t = normalizeDuplicateTitle(copies[i].title);
    const a = extractPrimaryArtist(copies[i].artist);
    const v = extractVersionMarkers(copies[i].title).join('|');
    if (t !== firstTitle || a !== firstArtist || v !== firstVersion) {
      return {safe: false, skipReason: 'Skipped, review manually (title or artist differs)'};
    }
  }

  // 3. Durations must all be known (> 0) and within 1 second of each other
  let minDur = Infinity;
  let maxDur = -Infinity;
  for (const copy of copies) {
    const dur = Number(copy.duration);
    if (!Number.isFinite(dur) || dur <= 0) {
      return {safe: false, skipReason: 'Skipped, review manually (missing track duration)'};
    }
    if (dur < minDur) minDur = dur;
    if (dur > maxDur) maxDur = dur;
  }
  if (maxDur - minDur > 1) {
    return {
      safe: false,
      skipReason: 'Skipped, review manually (durations differ by more than 1s)',
    };
  }

  return {safe: true, skipReason: null};
}

/**
 * Shared per-copy merge mutations executed inside an active SQLite transaction.
 * Used identically by both single removal and bulk removal.
 */
function mergeSingleCopyInTransaction(
  database: Database.Database,
  params: {keepId: number; removeId: number; removeRelPath: string}
): {playlistsUpdated: number} {
  const {keepId, removeId, removeRelPath} = params;
  let playlistsUpdated = 0;

  // 1. Update playlist_tracks across all playlists referencing removeId
  const affectedPlaylists = database
    .prepare('SELECT DISTINCT playlist_id FROM playlist_tracks WHERE track_id = ?')
    .all(removeId) as Array<{playlist_id: number}>;

  const getPlaylistRowsStmt = database.prepare(
    `SELECT id, track_id, position
     FROM playlist_tracks
     WHERE playlist_id = ?
     ORDER BY position ASC, id ASC`
  );
  const updatePlaylistRowTrackStmt = database.prepare(
    'UPDATE playlist_tracks SET track_id = ? WHERE id = ?'
  );
  const deletePlaylistRowStmt = database.prepare('DELETE FROM playlist_tracks WHERE id = ?');
  const updatePlaylistRowPositionStmt = database.prepare(
    'UPDATE playlist_tracks SET position = ? WHERE id = ?'
  );
  const touchPlaylistStmt = database.prepare(
    "UPDATE playlists SET updated_at = datetime('now') WHERE id = ?"
  );

  for (const {playlist_id: playlistId} of affectedPlaylists) {
    const rows = getPlaylistRowsStmt.all(playlistId) as Array<{
      id: number;
      track_id: number;
      position: number;
    }>;

    let seenTarget = false;
    const survivingRowIds: number[] = [];

    for (const row of rows) {
      if (row.track_id === removeId || row.track_id === keepId) {
        if (!seenTarget) {
          seenTarget = true;
          if (row.track_id === removeId) {
            updatePlaylistRowTrackStmt.run(keepId, row.id);
          }
          survivingRowIds.push(row.id);
        } else {
          // Collapse duplicate occurrence so only the first slot survives
          deletePlaylistRowStmt.run(row.id);
        }
      } else {
        survivingRowIds.push(row.id);
      }
    }

    for (let pos = 0; pos < survivingRowIds.length; pos++) {
      updatePlaylistRowPositionStmt.run(pos, survivingRowIds[pos]);
    }
    touchPlaylistStmt.run(playlistId);
    playlistsUpdated += 1;
  }

  // 2. Carry over liked_tracks (if either copy was liked, keepId is liked)
  const removedLikes = database
    .prepare('SELECT user_id, liked_at FROM liked_tracks WHERE track_id = ?')
    .all(removeId) as Array<{user_id: number; liked_at: string}>;

  const insertLikeStmt = database.prepare(
    'INSERT OR IGNORE INTO liked_tracks (user_id, track_id, liked_at) VALUES (?, ?, ?)'
  );
  for (const likeRow of removedLikes) {
    insertLikeStmt.run(likeRow.user_id, keepId, likeRow.liked_at);
  }
  database.prepare('DELETE FROM liked_tracks WHERE track_id = ?').run(removeId);

  // 3. Reassign play_history & listening_events so play counts/history carry over
  database
    .prepare('UPDATE play_history SET track_id = ? WHERE track_id = ?')
    .run(keepId, removeId);
  database
    .prepare('UPDATE listening_events SET track_id = ? WHERE track_id = ?')
    .run(String(keepId), String(removeId));

  // 4. Reassign download_jobs and youtube_playlist_job_items references
  database
    .prepare('UPDATE download_jobs SET track_id = ? WHERE track_id = ?')
    .run(keepId, removeId);
  database
    .prepare('UPDATE youtube_playlist_job_items SET track_id = ? WHERE track_id = ?')
    .run(keepId, removeId);

  // 5. Record ignored local path so future rescans never re-import this file
  //    (Never delete files on disk or in the audio cache.)
  const normalizedRelPath = normalizeIgnoredRelPath(removeRelPath || '');
  if (normalizedRelPath) {
    database
      .prepare(
        "INSERT OR IGNORE INTO library_ignored_paths (rel_path, reason) VALUES (?, 'duplicate')"
      )
      .run(normalizedRelPath);
  }

  // 6. Remove the duplicate track record from the library table
  database.prepare('DELETE FROM tracks WHERE id = ?').run(removeId);

  return {playlistsUpdated};
}

function loadKeepTrackSummary(
  database: Database.Database,
  userId: number,
  keepId: number
): ResolvedKeepTrackSummary | null {
  const keepTrackRow = database
    .prepare(
      `SELECT
         t.id, t.rel_path, t.title, t.artist, t.album, t.track_number, t.year,
         t.duration, t.format, t.bitrate, t.size_bytes, t.cover_file,
         t.dominant_color, t.added_at,
         CASE WHEN lt.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked
       FROM tracks t
       LEFT JOIN liked_tracks lt ON lt.track_id = t.id AND lt.user_id = ?
       WHERE t.id = ?`
    )
    .get(userId, keepId) as
    | (Omit<ResolvedKeepTrackSummary, 'liked'> & {liked: number})
    | undefined;

  if (!keepTrackRow) return null;
  return {
    ...keepTrackRow,
    liked: Boolean(keepTrackRow.liked),
  };
}

/**
 * Merges a duplicate pair inside a single SQLite transaction:
 * - Replaces removeId with keepId in all playlists, collapsing duplicates into
 *   one entry at the position of whichever copy appeared first.
 * - Carries over liked_tracks, play_history, listening_events, and job references.
 * - Records removeTrack.rel_path in library_ignored_paths so rescans skip it
 *   without ever deleting any file from disk or cache.
 * - Deletes the removed track row from tracks.
 */
export function resolveDuplicatePair(
  database: Database.Database,
  options: {
    userId: number;
    userRole?: string;
    keepId: number;
    removeId: number;
    playingTrackIds?: ReadonlySet<number>;
    beforeCommitHook?: () => void;
    silentLog?: boolean;
  }
): ResolveDuplicateResult {
  const {
    userId,
    userRole = 'listener',
    keepId,
    removeId,
    playingTrackIds,
    beforeCommitHook,
    silentLog,
  } = options;

  if (
    !Number.isSafeInteger(keepId) ||
    keepId <= 0 ||
    !Number.isSafeInteger(removeId) ||
    removeId <= 0
  ) {
    throw new DuplicateResolveError(400, 'keepId and removeId must be valid positive integers');
  }

  if (keepId === removeId) {
    throw new DuplicateResolveError(400, 'keepId and removeId must be different tracks');
  }

  if (playingTrackIds?.has(removeId)) {
    throw new DuplicateResolveError(409, 'Cannot remove a track that is currently playing');
  }

  const existingKeep = database
    .prepare('SELECT id, rel_path FROM tracks WHERE id = ?')
    .get(keepId) as {id: number; rel_path: string} | undefined;
  const existingRemove = database
    .prepare('SELECT id, rel_path FROM tracks WHERE id = ?')
    .get(removeId) as {id: number; rel_path: string} | undefined;

  if (!existingKeep || !existingRemove) {
    throw new DuplicateResolveError(404, 'Track not found');
  }

  // Verify both tracks belong to the same duplicate group before mutating anything
  const currentGroups = findDuplicateGroupsForUser(database, {
    userId,
    userRole,
    playingTrackIds,
  });
  const matchingGroup = currentGroups.find(
    (g) => g.copies.some((c) => c.id === keepId) && g.copies.some((c) => c.id === removeId)
  );
  if (!matchingGroup) {
    throw new DuplicateResolveError(400, 'Selected tracks do not belong to the same duplicate group');
  }

  let playlistsUpdated = 0;

  const runMergeTx = database.transaction(() => {
    const res = mergeSingleCopyInTransaction(database, {
      keepId,
      removeId,
      removeRelPath: existingRemove.rel_path,
    });
    playlistsUpdated = res.playlistsUpdated;

    // Optional hook for transactional rollback tests
    if (beforeCommitHook) {
      beforeCommitHook();
    }
  });

  runMergeTx();

  if (!silentLog) {
    console.log(
      `[library-dedupe] removed ${removeId}, kept ${keepId}, playlists updated ${playlistsUpdated}`
    );
  }

  const keepTrack = loadKeepTrackSummary(database, userId, keepId);
  if (!keepTrack) {
    throw new DuplicateResolveError(500, 'Kept track could not be loaded after merge');
  }

  const nextGroups = findDuplicateGroupsForUser(database, {
    userId,
    userRole,
    playingTrackIds,
  });
  const remainingGroup =
    nextGroups.find((g) => g.copies.some((c) => c.id === keepId)) ?? null;

  return {
    keepId,
    removeId,
    playlistsUpdated,
    keepLiked: keepTrack.liked,
    keepTrack,
    remainingGroup,
  };
}

// ---------------------------------------------------------------------------
// Per-User Concurrency Lock for Bulk Duplicate Removal
// ---------------------------------------------------------------------------

const activeBulkUsers = new Set<number>();

export function tryAcquireBulkDedupeLock(userId: number): boolean {
  if (activeBulkUsers.has(userId)) return false;
  activeBulkUsers.add(userId);
  return true;
}

export function releaseBulkDedupeLock(userId: number): void {
  activeBulkUsers.delete(userId);
}

export function isBulkDedupeRunning(userId: number): boolean {
  return activeBulkUsers.has(userId);
}

interface PreparedSafeGroup {
  group: DuplicateGroup;
  keepId: number;
  removeIds: number[];
}

function executeSingleSafeGroupTx(
  database: Database.Database,
  options: {
    userId: number;
    prepared: PreparedSafeGroup;
    beforeGroupCommitHook?: (group: DuplicateGroup) => void;
    silentLog?: boolean;
  }
): {replacements: BulkResolvedReplacement[]} {
  const {userId, prepared, beforeGroupCommitHook, silentLog} = options;
  const {group, keepId, removeIds} = prepared;

  const selectTrackRelPathStmt = database.prepare('SELECT id, rel_path FROM tracks WHERE id = ?');
  const mergedItems: Array<{removeId: number; playlistsUpdated: number}> = [];

  const runGroupTx = database.transaction(() => {
    const keepRow = selectTrackRelPathStmt.get(keepId) as {id: number; rel_path: string} | undefined;
    if (!keepRow) {
      throw new Error('Kept track no longer exists');
    }

    for (const removeId of removeIds) {
      const remRow = selectTrackRelPathStmt.get(removeId) as
        | {id: number; rel_path: string}
        | undefined;
      if (!remRow) {
        throw new Error(`Track ${removeId} no longer exists`);
      }
      const res = mergeSingleCopyInTransaction(database, {
        keepId,
        removeId,
        removeRelPath: remRow.rel_path,
      });
      mergedItems.push({removeId, playlistsUpdated: res.playlistsUpdated});
    }

    if (beforeGroupCommitHook) {
      beforeGroupCommitHook(group);
    }
  });

  runGroupTx();

  const keepTrack = loadKeepTrackSummary(database, userId, keepId);
  if (!keepTrack) {
    throw new Error('Kept track could not be loaded after group merge');
  }

  const replacements: BulkResolvedReplacement[] = mergedItems.map((item) => {
    if (!silentLog) {
      console.log(
        `[library-dedupe] removed ${item.removeId}, kept ${keepId}, playlists updated ${item.playlistsUpdated}`
      );
    }
    return {
      removeId: item.removeId,
      keepId,
      keepLiked: keepTrack.liked,
      playlistsUpdated: item.playlistsUpdated,
      keepTrack,
    };
  });

  return {replacements};
}

function planBulkGroups(
  database: Database.Database,
  options: {
    userId: number;
    userRole?: string;
    playingTrackIds?: ReadonlySet<number>;
  }
): {
  safeGroups: PreparedSafeGroup[];
  skipped: BulkSkippedGroup[];
  totalPlanned: number;
} {
  const groups = findDuplicateGroupsForUser(database, options);
  const safeGroups: PreparedSafeGroup[] = [];
  const skipped: BulkSkippedGroup[] = [];
  let totalPlanned = 0;

  for (const group of groups) {
    const safety = evaluateBulkSafety(group.copies, options.playingTrackIds);
    const lead = group.copies[0];
    if (!safety.safe) {
      skipped.push({
        groupId: group.id,
        title: lead?.title || 'Unknown Title',
        artist: lead?.artist || 'Unknown Artist',
        copyCount: group.copies.length,
        reason: safety.skipReason || 'Skipped, review manually',
      });
      continue;
    }

    const keepId = group.suggestedKeepId;
    const removeIds = group.copies.filter((c) => c.id !== keepId).map((c) => c.id);
    if (removeIds.length === 0) continue;

    safeGroups.push({group, keepId, removeIds});
    totalPlanned += removeIds.length;
  }

  return {safeGroups, skipped, totalPlanned};
}

/**
 * Resolves all safe duplicate groups synchronously (each group in its own SQLite
 * transaction so one failure rolls back only that group and the rest continue).
 */
export function resolveAllSafeDuplicates(
  database: Database.Database,
  options: {
    userId: number;
    userRole?: string;
    playingTrackIds?: ReadonlySet<number>;
    onProgress?: (event: BulkProgressEvent) => void;
    beforeGroupCommitHook?: (group: DuplicateGroup) => void;
    silentLog?: boolean;
  }
): BulkResolveSummary {
  const {userId, userRole = 'listener', playingTrackIds, onProgress, beforeGroupCommitHook, silentLog} =
    options;

  const {safeGroups, skipped, totalPlanned} = planBulkGroups(database, {
    userId,
    userRole,
    playingTrackIds,
  });

  onProgress?.({
    type: 'start',
    totalPlanned,
    safeGroupCount: safeGroups.length,
    skippedGroupCount: skipped.length,
  });

  const replacements: BulkResolvedReplacement[] = [];
  const failed: BulkFailedGroup[] = [];
  let removedCount = 0;
  let resolvedGroupCount = 0;

  for (const prepared of safeGroups) {
    const lead = prepared.group.copies[0];
    try {
      const groupResult = executeSingleSafeGroupTx(database, {
        userId,
        prepared,
        beforeGroupCommitHook,
        silentLog,
      });
      replacements.push(...groupResult.replacements);
      removedCount += groupResult.replacements.length;
      resolvedGroupCount += 1;
      onProgress?.({
        type: 'progress',
        removedCount,
        totalPlanned,
        groupId: prepared.group.id,
        status: 'resolved',
        replacements: groupResult.replacements,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Transaction failed';
      failed.push({
        groupId: prepared.group.id,
        title: lead?.title || 'Unknown Title',
        artist: lead?.artist || 'Unknown Artist',
        copyCount: prepared.group.copies.length,
        reason,
      });
      onProgress?.({
        type: 'progress',
        removedCount,
        totalPlanned,
        groupId: prepared.group.id,
        status: 'failed',
        error: reason,
      });
    }
  }

  const summary: BulkResolveSummary = {
    totalPlanned,
    removedCount,
    resolvedGroupCount,
    skippedCount: skipped.length,
    failedCount: failed.length,
    replacements,
    skipped,
    failed,
  };

  if (!silentLog) {
    console.log(
      `[library-dedupe] bulk complete: removed ${summary.removedCount}, groups resolved ${summary.resolvedGroupCount}, skipped ${summary.skippedCount}, failed ${summary.failedCount}`
    );
  }

  onProgress?.({type: 'done', summary});
  return summary;
}

/**
 * Async variant that yields between per-group transactions so streaming HTTP
 * responses flush real-time progress and overlapping requests see the lock.
 */
export async function resolveAllSafeDuplicatesAsync(
  database: Database.Database,
  options: {
    userId: number;
    userRole?: string;
    playingTrackIds?: ReadonlySet<number>;
    onProgress?: (event: BulkProgressEvent) => void;
    beforeGroupCommitHook?: (group: DuplicateGroup) => void;
    silentLog?: boolean;
  }
): Promise<BulkResolveSummary> {
  const {userId, userRole = 'listener', playingTrackIds, onProgress, beforeGroupCommitHook, silentLog} =
    options;

  const {safeGroups, skipped, totalPlanned} = planBulkGroups(database, {
    userId,
    userRole,
    playingTrackIds,
  });

  onProgress?.({
    type: 'start',
    totalPlanned,
    safeGroupCount: safeGroups.length,
    skippedGroupCount: skipped.length,
  });

  const replacements: BulkResolvedReplacement[] = [];
  const failed: BulkFailedGroup[] = [];
  let removedCount = 0;
  let resolvedGroupCount = 0;

  for (const prepared of safeGroups) {
    const lead = prepared.group.copies[0];
    try {
      const groupResult = executeSingleSafeGroupTx(database, {
        userId,
        prepared,
        beforeGroupCommitHook,
        silentLog,
      });
      replacements.push(...groupResult.replacements);
      removedCount += groupResult.replacements.length;
      resolvedGroupCount += 1;
      onProgress?.({
        type: 'progress',
        removedCount,
        totalPlanned,
        groupId: prepared.group.id,
        status: 'resolved',
        replacements: groupResult.replacements,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Transaction failed';
      failed.push({
        groupId: prepared.group.id,
        title: lead?.title || 'Unknown Title',
        artist: lead?.artist || 'Unknown Artist',
        copyCount: prepared.group.copies.length,
        reason,
      });
      onProgress?.({
        type: 'progress',
        removedCount,
        totalPlanned,
        groupId: prepared.group.id,
        status: 'failed',
        error: reason,
      });
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const summary: BulkResolveSummary = {
    totalPlanned,
    removedCount,
    resolvedGroupCount,
    skippedCount: skipped.length,
    failedCount: failed.length,
    replacements,
    skipped,
    failed,
  };

  if (!silentLog) {
    console.log(
      `[library-dedupe] bulk complete: removed ${summary.removedCount}, groups resolved ${summary.resolvedGroupCount}, skipped ${summary.skippedCount}, failed ${summary.failedCount}`
    );
  }

  onProgress?.({type: 'done', summary});
  return summary;
}
