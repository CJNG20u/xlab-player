import fs from 'fs';
import path from 'path';
import {db, getMusicDir} from './db.ts';
import {readTrackLyricsLive} from './scanner.ts';

const LRCLIB_BASE_URL = 'https://lrclib.net';
const LRCLIB_USER_AGENT = 'xlabplayer/1.0 (https://github.com/xlabplayer)';
const LRCLIB_TIMEOUT_MS = 6_500;
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h for tracks with no match

export interface LyricsLookupInput {
  trackId?: number | null;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
}

export interface LyricsLookupResult {
  lyrics: string | null;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
  source: 'local' | 'cache' | 'lrclib' | 'none';
  savedSidecar?: boolean;
}

interface LyricsCacheRow {
  cache_key: string;
  artist: string;
  title: string;
  album: string;
  duration: number;
  synced_lyrics: string | null;
  plain_lyrics: string | null;
  instrumental: number;
  source: string;
  updated_at: number;
}

interface TrackLyricsRow {
  id: number;
  rel_path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  lyrics: string | null;
}

interface LrcLibRecord {
  id?: number;
  name?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const getCacheStmt = db.prepare('SELECT * FROM lyrics_cache WHERE cache_key = ?');
const upsertCacheStmt = db.prepare(`
  INSERT INTO lyrics_cache (
    cache_key, artist, title, album, duration, synced_lyrics, plain_lyrics, instrumental, source, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    artist = excluded.artist,
    title = excluded.title,
    album = excluded.album,
    duration = excluded.duration,
    synced_lyrics = excluded.synced_lyrics,
    plain_lyrics = excluded.plain_lyrics,
    instrumental = excluded.instrumental,
    source = excluded.source,
    updated_at = excluded.updated_at
`);
const getTrackRowStmt = db.prepare(
  'SELECT id, rel_path, title, artist, album, duration, lyrics FROM tracks WHERE id = ?'
);
const updateTrackLyricsIfEmptyStmt = db.prepare(
  "UPDATE tracks SET lyrics = ?, updated_at = datetime('now') WHERE id = ? AND (lyrics IS NULL OR trim(lyrics) = '')"
);

const inFlightLookups = new Map<string, Promise<LyricsLookupResult>>();

const LRC_TIMESTAMP_RE = /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/;

function hasLrcTimestamps(text: string): boolean {
  return LRC_TIMESTAMP_RE.test(text);
}

function stripLrcTimestamps(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((line) => line.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim())
    .filter((line) => line.length > 0 && !/^\[(ar|ti|al|by|offset|re|ve|length|la|id|au):/i.test(line))
    .join('\n');
}

function normalizeLookupToken(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function cleanArtistForLyrics(rawArtist: string): string {
  let artist = (rawArtist || '').trim();
  if (!artist) return '';

  // Remove common YouTube auto-channel suffixes
  artist = artist.replace(/\s*-\s*topic$/i, '');
  artist = artist.replace(/\s+official\s*(artist\s*channel|music|channel)?$/i, '');
  artist = artist.replace(/vevo$/i, (m, offset) => (offset > 2 ? '' : m));

  // Strip featured collaborator tails so LRCLIB matches primary artist cleanly
  artist = artist.replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^\)\]]+[\)\]]/gi, '');
  artist = artist.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '');

  // If multiple artists are separated by comma / semicolon / slash, keep primary
  const primaryMatch = /^([^,;\/]+)/.exec(artist);
  if (primaryMatch && primaryMatch[1].trim().length >= 2) {
    artist = primaryMatch[1].trim();
  }

  return artist.replace(/\s+/g, ' ').trim();
}

export function cleanTitleForLyrics(rawTitle: string, rawArtist = ''): string {
  let title = (rawTitle || '').trim();
  if (!title) return '';

  // If YouTube title starts with "Artist - Track Title", strip the leading artist prefix
  const cleanedArtist = cleanArtistForLyrics(rawArtist);
  if (cleanedArtist) {
    const escaped = cleanedArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRe = new RegExp(`^${escaped}\\s*[-–—:|]\\s+`, 'i');
    const stripped = title.replace(prefixRe, '').trim();
    if (stripped.length >= 2) {
      title = stripped;
    }
  }

  // Strip noisy video/audio/edition tags in parentheses or brackets
  const noisyTagPattern =
    /\s*[\(\[]\s*(?:official(?:\s+(?:music|lyric|lyrics|audio|hd|4k|visualizer|mv|video|performance|live))*\s*(?:video|audio|mv|visualizer)?|music\s+video|lyric\s+video|lyrics(?:\s+video)?|audio(?:\s+only)?|visualizer|visualiser|hd|4k|hq|explicit|clean(?:\s+version)?|radio\s+edit|album\s+version|single\s+version|original\s+mix|extended\s+mix|bonus\s+track|live(?:\s+[^\)\]]*)?|acoustic(?:\s+[^\)\]]*)?|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|feat\.?\s+[^\)\]]+|ft\.?\s+[^\)\]]+|featuring\s+[^\)\]]+|with\s+[^\)\]]+|prod\.?\s+[^\)\]]+|from\s+[^\)\]]+)\s*[\)\]]/gi;

  let prev = '';
  while (prev !== title) {
    prev = title;
    title = title.replace(noisyTagPattern, '').trim();
  }

  // Strip bare trailing featured artist clauses & vertical-bar/pipe video suffixes
  title = title.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '').trim();
  title = title.replace(/\s+\|\s+.+$/, '').trim();
  title = title.replace(/\s+-\s+(?:official\s+(?:video|audio|music\s+video)|lyrics?|live|remaster(?:ed)?).*$/i, '').trim();

  // Strip wrapping quotes if any
  title = title.replace(/^["'“”]+|["'“”]+$/g, '').trim();

  return title.replace(/\s+/g, ' ').trim();
}

function cleanAlbumForLyrics(rawAlbum: string): string {
  const album = (rawAlbum || '').trim();
  if (!album) return '';
  if (/^(unknown album|singles|youtube stream|youtube music|unknown)$/i.test(album)) {
    return '';
  }
  return album;
}

function buildLyricsCacheKey(cleanArtist: string, cleanTitle: string): string {
  return `${normalizeLookupToken(cleanArtist)}::${normalizeLookupToken(cleanTitle)}`;
}

function isGenericArtist(artist: string): boolean {
  return !artist || /^(unknown artist|various artists|unknown)$/i.test(artist.trim());
}

function scoreLrcLibCandidate(
  candidate: LrcLibRecord,
  targetTitleNorm: string,
  targetArtistNorm: string,
  targetDuration: number
): number {
  const synced = (candidate.syncedLyrics || '').trim();
  const plain = (candidate.plainLyrics || '').trim();
  const isInstrumental = Boolean(candidate.instrumental);
  if (!synced && !plain && !isInstrumental) return -1000;

  const candTitleNorm = normalizeLookupToken(
    cleanTitleForLyrics(candidate.trackName || candidate.name || '')
  );
  const candArtistNorm = normalizeLookupToken(cleanArtistForLyrics(candidate.artistName || ''));

  let score = 0;

  // Title match scoring
  if (candTitleNorm === targetTitleNorm) {
    score += 55;
  } else if (
    targetTitleNorm.length >= 3 &&
    (candTitleNorm.includes(targetTitleNorm) || targetTitleNorm.includes(candTitleNorm))
  ) {
    score += 32;
  } else {
    // Check token overlap for partial title match
    const targetWords = new Set(targetTitleNorm.split(' ').filter((w) => w.length >= 2));
    const candWords = candTitleNorm.split(' ').filter((w) => w.length >= 2);
    let overlap = 0;
    for (const w of candWords) {
      if (targetWords.has(w)) overlap++;
    }
    const ratio = targetWords.size > 0 ? overlap / targetWords.size : 0;
    if (ratio < 0.5) return -500;
    score += Math.round(ratio * 25);
  }

  // Artist match scoring
  if (targetArtistNorm) {
    if (candArtistNorm === targetArtistNorm) {
      score += 45;
    } else if (
      candArtistNorm.includes(targetArtistNorm) ||
      targetArtistNorm.includes(candArtistNorm)
    ) {
      score += 28;
    } else {
      const targetWords = new Set(targetArtistNorm.split(' ').filter((w) => w.length >= 2));
      const candWords = candArtistNorm.split(' ').filter((w) => w.length >= 2);
      let overlap = 0;
      for (const w of candWords) {
        if (targetWords.has(w)) overlap++;
      }
      if (overlap === 0) return -500;
      score += 12;
    }
  }

  // Prefer synced LRC over plain lyrics
  if (synced) {
    score += 24;
  } else if (plain) {
    score += 8;
  }

  // Duration proximity scoring when track duration is known
  const candDur = typeof candidate.duration === 'number' ? candidate.duration : 0;
  if (targetDuration > 0 && candDur > 0) {
    const diff = Math.abs(candDur - targetDuration);
    if (diff <= 3) score += 22;
    else if (diff <= 8) score += 14;
    else if (diff <= 15) score += 4;
    else if (diff <= 30) score -= 12;
    else score -= 35;
  }

  return score;
}

async function fetchJsonFromLrcLib<T>(pathname: string, params: URLSearchParams): Promise<T | null> {
  const url = `${LRCLIB_BASE_URL}${pathname}?${params.toString()}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': LRCLIB_USER_AGENT,
      },
      signal: AbortSignal.timeout(LRCLIB_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function queryLrcLib(params: {
  artist: string;
  title: string;
  album: string;
  duration: number;
}): Promise<{syncedLyrics: string | null; plainLyrics: string | null; instrumental: boolean} | null> {
  const {artist, title, album, duration} = params;
  if (!title) return null;

  // 1. Exact lookup via /api/get when artist & title are available
  if (artist && !isGenericArtist(artist)) {
    const getParams = new URLSearchParams();
    getParams.set('artist_name', artist);
    getParams.set('track_name', title);
    if (album) {
      getParams.set('album_name', album);
    }
    if (Number.isFinite(duration) && duration > 0) {
      getParams.set('duration', String(Math.round(duration)));
    }

    const exact = await fetchJsonFromLrcLib<LrcLibRecord>('/api/get', getParams);
    if (exact) {
      const synced = (exact.syncedLyrics || '').trim() || null;
      const plain = (exact.plainLyrics || '').trim() || null;
      const instrumental = Boolean(exact.instrumental) && !synced && !plain;
      if (synced || plain || instrumental) {
        return {syncedLyrics: synced, plainLyrics: plain, instrumental};
      }
    }
  }

  // 2. Fallback search via /api/search?track_name=...&artist_name=...
  const targetTitleNorm = normalizeLookupToken(title);
  const targetArtistNorm = isGenericArtist(artist) ? '' : normalizeLookupToken(artist);

  let candidates: LrcLibRecord[] | null = null;
  if (artist && !isGenericArtist(artist)) {
    const searchParams = new URLSearchParams();
    searchParams.set('track_name', title);
    searchParams.set('artist_name', artist);
    candidates = await fetchJsonFromLrcLib<LrcLibRecord[]>('/api/search', searchParams);
  }

  // 3. Broad query fallback if structured search returned empty
  if (!candidates || candidates.length === 0) {
    const qParams = new URLSearchParams();
    qParams.set('q', artist && !isGenericArtist(artist) ? `${artist} ${title}` : title);
    candidates = await fetchJsonFromLrcLib<LrcLibRecord[]>('/api/search', qParams);
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  let best: LrcLibRecord | null = null;
  let bestScore = -Infinity;

  for (const cand of candidates) {
    const score = scoreLrcLibCandidate(cand, targetTitleNorm, targetArtistNorm, duration);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  if (!best || bestScore < 40) {
    return null;
  }

  const synced = (best.syncedLyrics || '').trim() || null;
  const plain = (best.plainLyrics || '').trim() || null;
  const instrumental = Boolean(best.instrumental) && !synced && !plain;
  if (!synced && !plain && !instrumental) {
    return null;
  }

  return {syncedLyrics: synced, plainLyrics: plain, instrumental};
}

function trySaveSidecarLrc(relPath: string, lyricsContent: string): boolean {
  if (!relPath || !lyricsContent.trim()) return false;
  try {
    const musicDir = path.resolve(getMusicDir());
    const audioAbs = path.resolve(musicDir, relPath);
    if (audioAbs !== musicDir && !audioAbs.startsWith(musicDir + path.sep)) {
      return false;
    }
    if (!fs.existsSync(audioAbs)) {
      return false;
    }
    const parsed = path.parse(audioAbs);
    const lrcAbs = path.join(parsed.dir, `${parsed.name}.lrc`);
    if (lrcAbs !== musicDir && !lrcAbs.startsWith(musicDir + path.sep)) {
      return false;
    }
    if (fs.existsSync(lrcAbs)) {
      return false;
    }
    // Check directory writability before attempting to write
    fs.accessSync(parsed.dir, fs.constants.W_OK);
    fs.writeFileSync(lrcAbs, `${lyricsContent.trim()}\n`, {encoding: 'utf8', flag: 'wx'});
    return true;
  } catch {
    // Ignore read-only NAS mounts, EEXIST, or permission errors cleanly
    return false;
  }
}

export async function resolveTrackLyrics(input: LyricsLookupInput): Promise<LyricsLookupResult> {
  const trackId =
    typeof input.trackId === 'number' && Number.isInteger(input.trackId) && input.trackId > 0
      ? input.trackId
      : null;

  let trackRow: TrackLyricsRow | undefined;
  if (trackId !== null) {
    trackRow = getTrackRowStmt.get(trackId) as TrackLyricsRow | undefined;
  }

  // Step 1: Check embedded tags & sidecar .lrc for local library tracks
  if (trackRow) {
    const localLyrics = readTrackLyricsLive(trackRow.rel_path, trackRow.lyrics);
    if (localLyrics && localLyrics.trim()) {
      const trimmed = localLyrics.trim();
      const synced = hasLrcTimestamps(trimmed);
      return {
        lyrics: trimmed,
        syncedLyrics: synced ? trimmed : null,
        plainLyrics: synced ? stripLrcTimestamps(trimmed) : trimmed,
        instrumental: false,
        source: 'local',
      };
    }
  }

  // Merge metadata from query params and local DB row
  const rawArtist = (input.artist || trackRow?.artist || '').trim();
  const rawTitle = (input.title || trackRow?.title || '').trim();
  const rawAlbum = (input.album || trackRow?.album || '').trim();
  const rawDuration =
    typeof input.duration === 'number' && Number.isFinite(input.duration) && input.duration > 0
      ? input.duration
      : trackRow?.duration || 0;

  // If title has "Artist - Title" and artist is missing/generic, split them cleanly
  let workingArtist = rawArtist;
  let workingTitle = rawTitle;
  if (isGenericArtist(workingArtist) && /\s+[-–—]\s+/.test(workingTitle)) {
    const parts = workingTitle.split(/\s+[-–—]\s+/);
    if (parts.length >= 2 && parts[0].trim().length >= 2) {
      workingArtist = parts[0].trim();
      workingTitle = parts.slice(1).join(' - ').trim();
    }
  }

  const cleanArtist = cleanArtistForLyrics(workingArtist);
  const cleanTitle = cleanTitleForLyrics(workingTitle, workingArtist);
  const cleanAlbum = cleanAlbumForLyrics(rawAlbum);

  if (!cleanTitle) {
    return {
      lyrics: null,
      syncedLyrics: null,
      plainLyrics: null,
      instrumental: false,
      source: 'none',
    };
  }

  const cacheKey = buildLyricsCacheKey(cleanArtist, cleanTitle);

  // Step 2: Check persistent SQLite lyrics_cache keyed by normalized (artist, title)
  const cached = getCacheStmt.get(cacheKey) as LyricsCacheRow | undefined;
  if (cached) {
    const hasPayload = Boolean(cached.synced_lyrics || cached.plain_lyrics || cached.instrumental);
    const ageMs = Date.now() - (cached.updated_at || 0);
    if (hasPayload) {
      const preferred = cached.synced_lyrics || cached.plain_lyrics || null;
      let savedSidecar = false;
      if (trackRow && preferred) {
        try {
          updateTrackLyricsIfEmptyStmt.run(preferred, trackRow.id);
        } catch {
          // ignore
        }
        savedSidecar = trySaveSidecarLrc(trackRow.rel_path, preferred);
      }
      return {
        lyrics: preferred,
        syncedLyrics: cached.synced_lyrics || null,
        plainLyrics: cached.plain_lyrics || null,
        instrumental: Boolean(cached.instrumental),
        source: 'cache',
        savedSidecar,
      };
    }

    if (ageMs < NEGATIVE_CACHE_TTL_MS) {
      return {
        lyrics: null,
        syncedLyrics: null,
        plainLyrics: null,
        instrumental: false,
        source: 'none',
      };
    }
  }

  // Step 3: Deduplicated online lookup via LRCLIB
  const inflightKey = trackRow ? `${cacheKey}:track:${trackRow.id}` : cacheKey;
  const existing = inFlightLookups.get(inflightKey);
  if (existing) {
    return existing;
  }

  const lookupPromise = (async (): Promise<LyricsLookupResult> => {
    const fetched = await queryLrcLib({
      artist: cleanArtist,
      title: cleanTitle,
      album: cleanAlbum,
      duration: rawDuration,
    });

    const now = Date.now();
    if (!fetched) {
      // Negative cache for 24h so repeated plays don't hammer LRCLIB
      try {
        upsertCacheStmt.run(
          cacheKey,
          cleanArtist,
          cleanTitle,
          cleanAlbum,
          rawDuration,
          null,
          null,
          0,
          'none',
          now
        );
      } catch {
        // ignore cache write failure
      }
      return {
        lyrics: null,
        syncedLyrics: null,
        plainLyrics: null,
        instrumental: false,
        source: 'none',
      };
    }

    const syncedLyrics = fetched.syncedLyrics;
    const plainLyrics =
      fetched.plainLyrics || (syncedLyrics ? stripLrcTimestamps(syncedLyrics) : null);
    const preferred = syncedLyrics || plainLyrics || null;

    // Step 4: Persist to SQLite lyrics_cache & optionally save sidecar .lrc for local tracks
    try {
      upsertCacheStmt.run(
        cacheKey,
        cleanArtist,
        cleanTitle,
        cleanAlbum,
        rawDuration,
        syncedLyrics,
        plainLyrics,
        fetched.instrumental ? 1 : 0,
        'lrclib',
        now
      );
    } catch {
      // ignore cache write failure
    }

    let savedSidecar = false;
    if (trackRow && preferred) {
      try {
        updateTrackLyricsIfEmptyStmt.run(preferred, trackRow.id);
      } catch {
        // ignore
      }
      savedSidecar = trySaveSidecarLrc(trackRow.rel_path, preferred);
    }

    return {
      lyrics: preferred,
      syncedLyrics,
      plainLyrics,
      instrumental: fetched.instrumental,
      source: 'lrclib',
      savedSidecar,
    };
  })().finally(() => {
    inFlightLookups.delete(inflightKey);
  });

  inFlightLookups.set(inflightKey, lookupPromise);
  return lookupPromise;
}
