import fs from 'fs';
import {cleanArtistName} from './autoplay.ts';
import {
  getRelatedMixCacheRow,
  getSetting,
  RELATED_MIX_TTL_MS,
  setRelatedMixCacheRow,
} from './db.ts';
import {
  cacheYouTubeThumbnailUrl,
  createTempCookiesCopy,
  execYtdlp,
  extractThumbnailUrl,
  hasConfiguredCookies,
  isRecoverableCookieError,
  isValidYouTubeVideoId,
  peekTrackMetadata,
  withYtdlpResolveSlot,
} from './downloader.ts';

// ---------------------------------------------------------------------------
// Related Videos Source (RD Mix flat extraction + title/artist search fallback)
// ---------------------------------------------------------------------------

export interface RelatedVideoRow {
  videoId: string;
  title: string;
  artist: string;
  channel?: string;
  duration: number;
  thumbnail: string;
}

export interface GetRelatedVideosOptions {
  seedTitle?: string;
  seedArtist?: string;
  forceRefresh?: boolean;
}

const DEFAULT_MAX_RESULTS = 25;
const SOCKET_TIMEOUT_SEC = 12;
const YTDLP_EXEC_TIMEOUT_MS = 18_000;

// Single-flight deduplication per seedVideoId so concurrent requests or retries
// share one in-progress yt-dlp extraction.
const inFlightRelated = new Map<string, Promise<RelatedVideoRow[]>>();

function parseRelatedEntry(
  entry: Record<string, unknown>,
  seedVideoId: string
): RelatedVideoRow | null {
  const rawId = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!isValidYouTubeVideoId(rawId) || rawId === seedVideoId) {
    return null;
  }

  const rawTitle = String(entry.track || entry.title || '').trim();
  if (!rawTitle || rawTitle === '[Deleted video]' || rawTitle === '[Private video]') {
    return null;
  }

  const rawChannel = String(
    entry.artist || entry.channel || entry.uploader || entry.creator || ''
  ).trim();

  let artist = cleanArtistName(rawChannel);
  let title = rawTitle;

  // If channel is missing/generic and title is "Artist - Track", extract artist cleanly
  if (!artist) {
    const sep = /^(.{2,60}?)\s+[-–—]\s+(.+)$/.exec(rawTitle);
    if (sep) {
      artist = cleanArtistName(sep[1]);
      title = sep[2].trim() || rawTitle;
    }
  }
  if (!artist) {
    artist = 'Unknown Artist';
  }

  const rawDuration = Number(entry.duration);
  const duration =
    Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : 0;

  const thumbnail =
    extractThumbnailUrl(entry) || `https://i.ytimg.com/vi/${rawId}/hqdefault.jpg`;
  if (thumbnail) {
    cacheYouTubeThumbnailUrl(rawId, thumbnail);
  }

  return {
    videoId: rawId,
    title,
    artist,
    channel: rawChannel || undefined,
    duration,
    thumbnail,
  };
}

function parseYtdlpJsonEntries(stdout: string): Array<Record<string, unknown>> {
  const trimmed = (stdout || '').trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
    if (Array.isArray(parsed.entries)) {
      return parsed.entries.filter(
        (e): e is Record<string, unknown> => Boolean(e && typeof e === 'object')
      );
    }
    return [parsed];
  } catch {
    return [];
  }
}

async function runYtdlpFlatWithCookieFallback(
  argsBuilder: (cookiePath: string | null) => string[],
  seedVideoId: string
): Promise<Array<Record<string, unknown>>> {
  const runOnce = async (cookiePath: string | null): Promise<Array<Record<string, unknown>>> => {
    const args = argsBuilder(cookiePath);
    const {stdout} = await withYtdlpResolveSlot(
      () =>
        execYtdlp(args, {
          timeout: YTDLP_EXEC_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        }),
      'prefetch',
      seedVideoId
    );
    return parseYtdlpJsonEntries(stdout);
  };

  try {
    return await runOnce(null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isRecoverableCookieError(msg) || !hasConfiguredCookies()) {
      throw err;
    }
    const tempCookiePath = createTempCookiesCopy();
    try {
      return await runOnce(tempCookiePath);
    } finally {
      if (tempCookiePath && fs.existsSync(tempCookiePath)) {
        try {
          fs.unlinkSync(tempCookiePath);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }
}

async function extractRdMixFlat(
  seedVideoId: string,
  maxResults: number
): Promise<RelatedVideoRow[]> {
  // Fetch +1 extra entry because the RD Mix typically includes the seed video at position 0.
  const playlistEnd = Math.min(50, maxResults + 1);
  const mixUrl = `https://www.youtube.com/watch?v=${seedVideoId}&list=RD${seedVideoId}&start_radio=1`;

  const entries = await runYtdlpFlatWithCookieFallback((cookiePath) => {
    const args = [
      '--flat-playlist',
      '--yes-playlist',
      '--playlist-end',
      String(playlistEnd),
      '--dump-single-json',
      '--socket-timeout',
      String(SOCKET_TIMEOUT_SEC),
      '--quiet',
      '--no-warnings',
      '--js-runtimes',
      'node',
      '--force-ipv4',
    ];
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }
    if (getSetting('ytdlp_remote_components', 'true') === 'true') {
      args.push('--remote-components', 'ejs:github');
    }
    args.push('--', mixUrl);
    return args;
  }, seedVideoId);

  const rows: RelatedVideoRow[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = parseRelatedEntry(entry, seedVideoId);
    if (!parsed || seen.has(parsed.videoId)) continue;
    seen.add(parsed.videoId);
    rows.push(parsed);
    if (rows.length >= maxResults) break;
  }
  return rows;
}

async function fallbackSearchRelated(
  seedVideoId: string,
  maxResults: number,
  options: GetRelatedVideosOptions
): Promise<RelatedVideoRow[]> {
  let title = (options.seedTitle || '').trim();
  let artist = (options.seedArtist || '').trim();

  if (!title) {
    try {
      const meta = await withYtdlpResolveSlot(
        () => peekTrackMetadata(seedVideoId),
        'prefetch',
        seedVideoId
      );
      title = (meta.title || '').trim();
      artist = (meta.artist || '').trim();
    } catch {
      // ignore peek failure
    }
  }

  const query = `${title} ${cleanArtistName(artist)}`.replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!query) return [];

  const searchCount = Math.min(30, maxResults + 2);
  const searchSpec = `ytsearch${searchCount}:${query}`;

  const entries = await runYtdlpFlatWithCookieFallback((cookiePath) => {
    const args = [
      '--flat-playlist',
      '--no-playlist',
      '--dump-single-json',
      '--socket-timeout',
      String(SOCKET_TIMEOUT_SEC),
      '--quiet',
      '--no-warnings',
      '--js-runtimes',
      'node',
      '--force-ipv4',
    ];
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }
    if (getSetting('ytdlp_remote_components', 'true') === 'true') {
      args.push('--remote-components', 'ejs:github');
    }
    args.push('--', searchSpec);
    return args;
  }, seedVideoId);

  const rows: RelatedVideoRow[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = parseRelatedEntry(entry, seedVideoId);
    if (!parsed || seen.has(parsed.videoId)) continue;
    seen.add(parsed.videoId);
    rows.push(parsed);
    if (rows.length >= maxResults) break;
  }
  return rows;
}

/**
 * Fetch related videos for a strict 11-character YouTube video ID.
 * 1. Returns cached SQLite `related_mix` rows (6-hour TTL) immediately on hit.
 * 2. Deduplicates concurrent calls per seed (single-flight).
 * 3. Runs yt-dlp flat extraction on the YouTube RD Mix playlist, falling back to
 *    a "title artist" search excluding the seed itself.
 * 4. Limits concurrency with `withYtdlpResolveSlot`.
 */
export async function getRelatedVideos(
  seedVideoId: string,
  maxResults = DEFAULT_MAX_RESULTS,
  options: GetRelatedVideosOptions = {}
): Promise<RelatedVideoRow[]> {
  const startedAt = Date.now();
  const cleanId = (seedVideoId || '').trim();
  if (!isValidYouTubeVideoId(cleanId)) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(50, Math.floor(maxResults || DEFAULT_MAX_RESULTS)));

  if (!options.forceRefresh) {
    const cached = getRelatedMixCacheRow<RelatedVideoRow>(cleanId, RELATED_MIX_TTL_MS);
    if (cached) {
      const sliced = cached.rows
        .filter((row) => row && isValidYouTubeVideoId(row.videoId) && row.videoId !== cleanId)
        .slice(0, safeLimit);
      console.info(
        '[related]',
        JSON.stringify({
          event: 'related_fetch',
          seedVideoId: cleanId,
          cache: 'hit',
          count: sliced.length,
          ms: Date.now() - startedAt,
        })
      );
      return sliced;
    }

    const existing = inFlightRelated.get(cleanId);
    if (existing) {
      const shared = await existing;
      return shared.slice(0, safeLimit);
    }
  }

  const fetchTarget = Math.max(DEFAULT_MAX_RESULTS, safeLimit);
  const task = (async (): Promise<RelatedVideoRow[]> => {
    let rows: RelatedVideoRow[] = [];
    let source: 'rd_mix' | 'search_fallback' | 'empty' = 'empty';

    try {
      rows = await extractRdMixFlat(cleanId, fetchTarget);
      if (rows.length > 0) {
        source = 'rd_mix';
      }
    } catch {
      // Fall through to search fallback
    }

    if (rows.length === 0) {
      try {
        rows = await fallbackSearchRelated(cleanId, fetchTarget, options);
        if (rows.length > 0) {
          source = 'search_fallback';
        }
      } catch {
        // Leave empty
      }
    }

    if (rows.length > 0) {
      try {
        setRelatedMixCacheRow(cleanId, rows, Date.now());
      } catch {
        // Non-fatal cache write error
      }
    }

    console.info(
      '[related]',
      JSON.stringify({
        event: 'related_fetch',
        seedVideoId: cleanId,
        cache: 'miss',
        source,
        count: rows.length,
        ms: Date.now() - startedAt,
      })
    );
    return rows;
  })();

  if (!options.forceRefresh) {
    inFlightRelated.set(cleanId, task);
  }

  try {
    const rows = await task;
    return rows.slice(0, safeLimit);
  } finally {
    if (inFlightRelated.get(cleanId) === task) {
      inFlightRelated.delete(cleanId);
    }
  }
}
