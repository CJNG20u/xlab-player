import {db, getRecentPlayHistory} from './db.ts';
import {
  getCachedTrackVideoId,
  pickDiscoverSeedArtists,
} from './downloader.ts';

const DEEZER_API_BASE = 'https://api.deezer.com';
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MEMORY_CACHE_MAX_ENTRIES = 200;

const ALLOWED_CATALOG_IMAGE_HOSTS = [
  'cdn-images.dzcdn.net',
  'e-cdns-images.dzcdn.net',
  'e-cdn-images.dzcdn.net',
  'api.deezer.com',
];

const DEEZER_NUMERIC_ID_RE = /^\d{1,15}$/;

export interface DiscoverNewReleaseItem {
  id: string;
  deezerTrackId?: string;
  videoId?: string;
  url: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  recordType?: string;
  releaseDate?: string;
  releaseLabel: string;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  isNew: boolean;
  seedArtist: string | null;
}

export interface DiscoverArtistItem {
  id: string;
  deezerArtistId?: string;
  name: string;
  subtitle: string;
  fans?: number;
  seedArtist: string | null;
  videoId?: string;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
}

export interface DiscoverAlbumItem {
  id: string;
  deezerAlbumId?: string;
  videoId?: string;
  url: string;
  title: string;
  artist: string;
  artistId?: string;
  subtitle: string;
  recordType?: string;
  releaseDate?: string;
  trackCount?: number;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  seedArtist: string | null;
}

export interface DiscoverLastPlayed {
  artist: string;
  title: string;
  playedAt?: number;
}

export interface DiscoverFeedResponse {
  seeds: string[];
  basedOnLibrary: boolean;
  basedOnHistory: boolean;
  lastPlayed: DiscoverLastPlayed | null;
  cached: boolean;
  source: 'deezer';
  generatedAt: string;
  newReleases: DiscoverNewReleaseItem[];
  artistsToDiscover: DiscoverArtistItem[];
  albumsForYou: DiscoverAlbumItem[];
}

export interface DiscoverAlbumTrack {
  id: string;
  deezerTrackId: string;
  trackNumber: number;
  diskNumber: number;
  title: string;
  artist: string;
  featuredArtists?: string;
  artistId?: string;
  album: string;
  albumId: string;
  duration: number;
  explicit: boolean;
  coverUrl: string;
  videoId?: string;
}

export interface DiscoverAlbumDetail {
  id: string;
  deezerAlbumId: string;
  title: string;
  artist: string;
  artistId?: string;
  artistPictureUrl: string;
  coverUrl: string;
  releaseDate: string;
  releaseYear?: string;
  recordType?: string;
  label: string;
  genre: string;
  trackCount: number;
  duration: number;
  tracks: DiscoverAlbumTrack[];
  cached: boolean;
}

export interface DiscoverArtistAlbumSummary {
  id: string;
  deezerAlbumId: string;
  title: string;
  releaseDate: string;
  rawReleaseDate?: string;
  recordType: string;
  coverUrl: string;
}

export interface DiscoverArtistDetail {
  id: string;
  deezerArtistId: string;
  name: string;
  pictureUrl: string;
  fans: number;
  albumCount: number;
  latestRelease: DiscoverArtistAlbumSummary | null;
  topTracks: DiscoverAlbumTrack[];
  albums: DiscoverArtistAlbumSummary[];
  relatedArtists: DiscoverArtistItem[];
  cached: boolean;
}

// ---------------------------------------------------------------------------
// 2-tier cache (in-memory Map + SQLite catalog_cache) with single-flight dedup
// ---------------------------------------------------------------------------

const memoryCache = new Map<string, {payload: unknown; expiresAt: number}>();
const inFlightRequests = new Map<string, Promise<unknown>>();

const getCatalogCacheStmt = db.prepare(
  'SELECT payload_json, expires_at FROM catalog_cache WHERE cache_key = ?'
);
const upsertCatalogCacheStmt = db.prepare(
  `INSERT INTO catalog_cache (cache_key, payload_json, expires_at, updated_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(cache_key) DO UPDATE SET
     payload_json = excluded.payload_json,
     expires_at = excluded.expires_at,
     updated_at = excluded.updated_at`
);
const pruneCatalogCacheStmt = db.prepare('DELETE FROM catalog_cache WHERE expires_at <= ?');

function pruneMemoryCache(now: number): void {
  for (const [k, v] of memoryCache.entries()) {
    if (v.expiresAt <= now) memoryCache.delete(k);
  }
  if (memoryCache.size > MEMORY_CACHE_MAX_ENTRIES) {
    const excess = memoryCache.size - MEMORY_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const k of memoryCache.keys()) {
      memoryCache.delete(k);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

function readCatalogCache<T>(cacheKey: string): T | null {
  const now = Date.now();
  const mem = memoryCache.get(cacheKey);
  if (mem) {
    if (mem.expiresAt > now) {
      return mem.payload as T;
    }
    memoryCache.delete(cacheKey);
  }

  try {
    const row = getCatalogCacheStmt.get(cacheKey) as
      | {payload_json: string; expires_at: number}
      | undefined;
    if (row && row.expires_at > now) {
      const parsed = JSON.parse(row.payload_json) as T;
      pruneMemoryCache(now);
      memoryCache.set(cacheKey, {payload: parsed, expiresAt: row.expires_at});
      return parsed;
    }
  } catch {
    // Ignore corrupted cache rows
  }
  return null;
}

function writeCatalogCache<T>(cacheKey: string, payload: T, ttlMs = CATALOG_CACHE_TTL_MS): void {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  pruneMemoryCache(now);
  memoryCache.set(cacheKey, {payload, expiresAt});
  try {
    upsertCatalogCacheStmt.run(cacheKey, JSON.stringify(payload), expiresAt, now);
    if (Math.random() < 0.05) {
      pruneCatalogCacheStmt.run(now);
    }
  } catch {
    // Non-fatal if disk cache write fails
  }
}

async function withCatalogCache<T>(
  cacheKey: string,
  forceRefresh: boolean,
  fetcher: () => Promise<T>
): Promise<{data: T; cached: boolean}> {
  if (!forceRefresh) {
    const hit = readCatalogCache<T>(cacheKey);
    if (hit !== null) {
      return {data: hit, cached: true};
    }
    const existing = inFlightRequests.get(cacheKey);
    if (existing) {
      const data = (await existing) as T;
      return {data, cached: false};
    }
  }

  const promise = (async () => {
    const data = await fetcher();
    writeCatalogCache(cacheKey, data);
    return data;
  })();

  if (!forceRefresh) {
    inFlightRequests.set(cacheKey, promise);
  }
  try {
    const data = await promise;
    return {data, cached: false};
  } finally {
    if (inFlightRequests.get(cacheKey) === promise) {
      inFlightRequests.delete(cacheKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Deezer API helpers & validation
// ---------------------------------------------------------------------------

export function isValidDeezerId(raw: string): boolean {
  return DEEZER_NUMERIC_ID_RE.test(raw.trim());
}

export function sanitizeCatalogImageUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    const host = parsed.hostname.toLowerCase();
    const allowed =
      ALLOWED_CATALOG_IMAGE_HOSTS.includes(host) ||
      host.endsWith('.dzcdn.net') ||
      host.endsWith('.deezer.com');
    if (!allowed) return '';
    // Upgrade http Deezer image links to https
    parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return '';
  }
}

function pickHighResCover(obj: Record<string, unknown> | undefined | null): string {
  if (!obj) return '';
  for (const key of ['cover_xl', 'cover_big', 'cover_medium', 'cover']) {
    const url = sanitizeCatalogImageUrl(obj[key]);
    if (url) return url;
  }
  return '';
}

function pickHighResPicture(obj: Record<string, unknown> | undefined | null): string {
  if (!obj) return '';
  for (const key of ['picture_xl', 'picture_big', 'picture_medium', 'picture']) {
    const url = sanitizeCatalogImageUrl(obj[key]);
    if (url) return url;
  }
  return '';
}

function normalizeKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatRecordType(raw: string | undefined): string {
  const lower = (raw || '').trim().toLowerCase();
  if (!lower) return 'Album';
  if (lower === 'ep') return 'EP';
  if (lower === 'single') return 'Single';
  if (lower === 'compile' || lower === 'compilation') return 'Compilation';
  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
}

function formatYearLabel(releaseDate: string | undefined, fallback: string): string {
  if (!releaseDate) return fallback;
  const trimmed = releaseDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const monthIdx = Number(trimmed.slice(5, 7)) - 1;
    const day = Number(trimmed.slice(8, 10));
    if (monthIdx >= 0 && monthIdx < 12 && day >= 1 && day <= 31) {
      return `${SHORT_MONTHS[monthIdx]} ${day}, ${year}`;
    }
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${SHORT_MONTHS[monthIdx]} ${year}`;
    }
    return year;
  }
  if (/^\d{4}/.test(trimmed)) {
    return trimmed.slice(0, 4);
  }
  return fallback;
}

function formatShortReleaseDate(releaseDate: string | undefined): string {
  if (!releaseDate) return '';
  const trimmed = releaseDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const monthIdx = Number(trimmed.slice(5, 7)) - 1;
    const day = Number(trimmed.slice(8, 10));
    if (monthIdx >= 0 && monthIdx < 12 && day >= 1 && day <= 31) {
      const currentYear = new Date().getFullYear();
      if (year >= currentYear - 1) {
        return `${SHORT_MONTHS[monthIdx]} ${day}`;
      }
      return `${SHORT_MONTHS[monthIdx]} ${year}`;
    }
    return String(year);
  }
  if (/^\d{4}/.test(trimmed)) {
    return trimmed.slice(0, 4);
  }
  return '';
}

function extractReleaseYear(releaseDate: string | undefined): string {
  if (!releaseDate) return '';
  const m = /^(\d{4})/.exec(releaseDate.trim());
  return m ? m[1] : '';
}

async function fetchDeezerJson<T>(endpointPath: string): Promise<T> {
  const url = `${DEEZER_API_BASE}${endpointPath}`;
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'xlabplayer/1.0',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) {
    throw new Error(`Deezer API returned HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as T & {error?: {message?: string; code?: number}};
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(data.error.message || 'Deezer API error');
  }
  return data;
}

// Raw Deezer payload shapes (only fields we consume)
interface RawDeezerArtist {
  id: number;
  name: string;
  nb_fan?: number;
  nb_album?: number;
  picture?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
}

interface RawDeezerAlbum {
  id: number;
  title: string;
  cover?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  release_date?: string;
  record_type?: string;
  nb_tracks?: number;
  duration?: number;
  label?: string;
  genres?: {data?: Array<{name?: string}>};
  artist?: RawDeezerArtist;
  tracks?: {data?: RawDeezerTrack[]};
}

interface RawDeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  duration?: number;
  track_position?: number;
  disk_number?: number;
  explicit_lyrics?: boolean;
  artist?: RawDeezerArtist;
  contributors?: Array<{id?: number; name?: string; role?: string}>;
  album?: RawDeezerAlbum;
}

interface RawDeezerChartResponse {
  tracks?: {data?: RawDeezerTrack[]};
  albums?: {data?: RawDeezerAlbum[]};
  artists?: {data?: RawDeezerArtist[]};
}

function attachCachedVideoIdsToFeed(
  feed: Omit<DiscoverFeedResponse, 'cached'>
): Omit<DiscoverFeedResponse, 'cached'> {
  return {
    ...feed,
    newReleases: feed.newReleases.map((item) => {
      if (item.videoId) return item;
      const cachedVid = getCachedTrackVideoId(item.artist, item.title);
      return cachedVid ? {...item, videoId: cachedVid} : item;
    }),
  };
}

function attachCachedVideoIdsToTracks(tracks: DiscoverAlbumTrack[]): DiscoverAlbumTrack[] {
  return tracks.map((t) => {
    if (t.videoId) return t;
    const cachedVid = getCachedTrackVideoId(t.artist, t.title);
    return cachedVid ? {...t, videoId: cachedVid} : t;
  });
}

function interleaveBuckets<T>(buckets: T[][], limit: number): T[] {
  const out: T[] = [];
  let idx = 0;
  while (out.length < limit) {
    let added = false;
    for (const bucket of buckets) {
      if (idx < bucket.length && out.length < limit) {
        out.push(bucket[idx]);
        added = true;
      }
    }
    if (!added) break;
    idx += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Discover Feed (Dynamic Last-Played Song/Artist Seeding + Deezer Catalog)
// ---------------------------------------------------------------------------

const GENERIC_ARTIST_NAMES = new Set([
  '',
  'unknown',
  'unknown artist',
  'youtube',
  'various artists',
  'various',
  'va',
  'none',
  'untitled',
  'music',
  'official',
]);

function stripArtistNoise(raw: string): string {
  return raw
    .trim()
    .replace(/\s*[-–—]\s*topic$/i, '')
    .replace(/\s+official\s*(music\s*)?(channel|video|audio)?$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPrimaryArtistName(rawArtist: string, rawTitle = ''): string {
  const cleaned = stripArtistNoise(rawArtist);
  const norm = normalizeKey(cleaned);

  if (norm && !GENERIC_ARTIST_NAMES.has(norm)) {
    return cleaned;
  }

  // Try extracting "Artist - Title" from noisy YouTube titles when artist is generic
  const titleTrimmed = rawTitle.trim();
  const sepMatch = /^(.{2,60}?)\s+[-–—]\s+(.+)$/.exec(titleTrimmed);
  if (sepMatch) {
    const candidate = stripArtistNoise(sepMatch[1]);
    const candNorm = normalizeKey(candidate);
    if (candNorm && !GENERIC_ARTIST_NAMES.has(candNorm)) {
      return candidate;
    }
  }

  return '';
}

function getSearchableArtistQuery(artist: string): string {
  const cleaned = stripArtistNoise(artist);
  // Strip featured collaborations ("Artist feat. Guest", "A, B & C") for cleaner Deezer artist lookup
  const primary = cleaned
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|x)\s+|,\s*|\s*&\s*/i)[0]
    ?.trim();
  return primary && primary.length >= 2 ? primary : cleaned;
}

function isRecentReleaseDate(releaseDate: string | undefined): boolean {
  if (!releaseDate) return false;
  const yearMatch = /^(\d{4})/.exec(releaseDate.trim());
  if (!yearMatch) return false;
  const year = Number(yearMatch[1]);
  const currentYear = new Date().getFullYear();
  return Number.isFinite(year) && year >= currentYear - 1;
}

function sortAlbumsNewestFirst(albums: RawDeezerAlbum[]): RawDeezerAlbum[] {
  return [...albums].sort((a, b) => {
    const da = a.release_date || '';
    const dbDate = b.release_date || '';
    if (da === dbDate) return 0;
    return dbDate.localeCompare(da);
  });
}

async function resolveDeezerArtist(
  artistName: string,
  trackTitleHint?: string
): Promise<RawDeezerArtist | null> {
  const query = getSearchableArtistQuery(artistName);
  if (!query) return null;

  const searchRes = await fetchDeezerJson<{data?: RawDeezerArtist[]}>(
    `/search/artist?q=${encodeURIComponent(query)}&limit=5`
  ).catch(() => ({data: []}));

  const candidates = searchRes.data || [];
  if (candidates.length > 0) {
    const targetNorm = normalizeKey(query);
    const exact = candidates.find((c) => normalizeKey(c.name || '') === targetNorm);
    return exact || candidates[0];
  }

  // Fallback: look up by "<artist> <trackTitle>" if artist-only search didn't hit
  if (trackTitleHint && trackTitleHint.trim()) {
    const trackSearch = await fetchDeezerJson<{data?: RawDeezerTrack[]}>(
      `/search/track?q=${encodeURIComponent(`${query} ${trackTitleHint.trim()}`)}&limit=3`
    ).catch(() => ({data: []}));
    const firstArtist = trackSearch.data?.[0]?.artist;
    if (firstArtist?.id && firstArtist.name) {
      return firstArtist;
    }
  }

  return null;
}

export async function getCatalogDiscoverFeed(
  userId: number,
  options: {forceRefresh?: boolean; seedArtist?: string; seedTitle?: string} = {}
): Promise<DiscoverFeedResponse> {
  const historyRows = getRecentPlayHistory(userId, 40);

  // Merge optional live client hint (avoids race right after playTrack before POST /history commits)
  const combinedHistory: Array<{artist: string; title: string; playedAt?: number}> = [];
  const hintArtistRaw = (options.seedArtist || '').trim().slice(0, 200);
  const hintTitleRaw = (options.seedTitle || '').trim().slice(0, 200);
  if (hintArtistRaw || hintTitleRaw) {
    combinedHistory.push({
      artist: hintArtistRaw,
      title: hintTitleRaw,
      playedAt: Date.now(),
    });
  }
  for (const row of historyRows) {
    combinedHistory.push({
      artist: row.artist,
      title: row.title,
      playedAt: row.played_at,
    });
  }

  // Extract ordered unique recent artists + most recently played song/artist
  const orderedHistorySeeds: string[] = [];
  const seenSeedKeys = new Set<string>();
  let lastPlayed: DiscoverLastPlayed | null = null;

  for (const entry of combinedHistory) {
    const cleanArtist = extractPrimaryArtistName(entry.artist, entry.title);
    if (!cleanArtist) continue;
    const key = normalizeKey(cleanArtist);
    if (!key) continue;

    if (!lastPlayed) {
      lastPlayed = {
        artist: cleanArtist,
        title: entry.title.trim(),
        playedAt: entry.playedAt,
      };
    }

    if (!seenSeedKeys.has(key)) {
      seenSeedKeys.add(key);
      orderedHistorySeeds.push(cleanArtist);
      if (orderedHistorySeeds.length >= 3) break;
    }
  }

  const basedOnHistory = orderedHistorySeeds.length > 0;
  const librarySeeds = basedOnHistory ? [] : pickDiscoverSeedArtists(userId, 3);
  const basedOnLibrary = !basedOnHistory && librarySeeds.length > 0;
  const seeds = basedOnHistory ? orderedHistorySeeds : librarySeeds;

  // Preserve recency order in cache key so changing the most recently played artist refreshes immediately
  const cacheKey = basedOnHistory
    ? `discover:deezer:v3:hist:${seeds.map(normalizeKey).join('>')}`
    : basedOnLibrary
      ? `discover:deezer:v3:lib:${seeds.map(normalizeKey).join('>')}`
      : 'discover:deezer:v3:__chart__';

  const {data, cached} = await withCatalogCache<Omit<DiscoverFeedResponse, 'cached'>>(
    cacheKey,
    Boolean(options.forceRefresh),
    async () => {
      const seedKeys = new Set(seeds.map(normalizeKey));
      const primarySeed = seeds[0] || null;
      const secondarySeeds = seeds.slice(1, 3);

      // Resolve primary seed artist (most recently played) & secondary recent artists in parallel
      const [primaryArtist, ...secondaryArtists] = await Promise.all([
        primarySeed
          ? resolveDeezerArtist(primarySeed, lastPlayed?.title)
          : Promise.resolve(null),
        ...secondarySeeds.map((s) => resolveDeezerArtist(s)),
      ]);

      // Fetch primary artist's related artists (up to 12), albums/singles (up to 16), and top tracks (up to 10)
      let primaryRelated: RawDeezerArtist[] = [];
      let primaryAlbums: RawDeezerAlbum[] = [];
      let primaryTopTracks: RawDeezerTrack[] = [];

      if (primaryArtist?.id) {
        const [relRes, albRes, topRes] = await Promise.all([
          fetchDeezerJson<{data?: RawDeezerArtist[]}>(
            `/artist/${primaryArtist.id}/related?limit=12`
          ).catch(() => ({data: []})),
          fetchDeezerJson<{data?: RawDeezerAlbum[]}>(
            `/artist/${primaryArtist.id}/albums?limit=16`
          ).catch(() => ({data: []})),
          fetchDeezerJson<{data?: RawDeezerTrack[]}>(
            `/artist/${primaryArtist.id}/top?limit=10`
          ).catch(() => ({data: []})),
        ]);
        primaryRelated = relRes.data || [];
        primaryAlbums = sortAlbumsNewestFirst(albRes.data || []);
        primaryTopTracks = topRes.data || [];
      } else if (primarySeed) {
        // Fallback if artist lookup missed: search albums directly by artist name
        const albSearch = await fetchDeezerJson<{data?: RawDeezerAlbum[]}>(
          `/search/album?q=${encodeURIComponent(primarySeed)}&limit=12`
        ).catch(() => ({data: []}));
        primaryAlbums = sortAlbumsNewestFirst(albSearch.data || []);
      }

      // Fetch albums & top tracks from top 4 related artists of the primary seed + secondary recent seeds
      const topRelatedForExpansion = primaryRelated
        .filter((a) => a?.id && a.name && !seedKeys.has(normalizeKey(a.name)))
        .slice(0, 4);

      const [relatedExpansions, secondaryExpansions] = await Promise.all([
        Promise.all(
          topRelatedForExpansion.map(async (rel) => {
            const [topRes, albRes] = await Promise.all([
              fetchDeezerJson<{data?: RawDeezerTrack[]}>(
                `/artist/${rel.id}/top?limit=4`
              ).catch(() => ({data: []})),
              fetchDeezerJson<{data?: RawDeezerAlbum[]}>(
                `/artist/${rel.id}/albums?limit=6`
              ).catch(() => ({data: []})),
            ]);
            return {
              artist: rel,
              topTracks: topRes.data || [],
              albums: sortAlbumsNewestFirst(albRes.data || []),
            };
          })
        ),
        Promise.all(
          secondarySeeds.map(async (seedName, idx) => {
            const resolved = secondaryArtists[idx];
            if (!resolved?.id) {
              return {
                seed: seedName,
                displayName: seedName,
                artistId: undefined as string | undefined,
                related: [] as RawDeezerArtist[],
                albums: [] as RawDeezerAlbum[],
                topTracks: [] as RawDeezerTrack[],
              };
            }
            const [relRes, albRes, topRes] = await Promise.all([
              fetchDeezerJson<{data?: RawDeezerArtist[]}>(
                `/artist/${resolved.id}/related?limit=12`
              ).catch(() => ({data: []})),
              fetchDeezerJson<{data?: RawDeezerAlbum[]}>(
                `/artist/${resolved.id}/albums?limit=8`
              ).catch(() => ({data: []})),
              fetchDeezerJson<{data?: RawDeezerTrack[]}>(
                `/artist/${resolved.id}/top?limit=5`
              ).catch(() => ({data: []})),
            ]);
            return {
              seed: seedName,
              displayName: resolved.name?.trim() || seedName,
              artistId: String(resolved.id),
              related: relRes.data || [],
              albums: sortAlbumsNewestFirst(albRes.data || []),
              topTracks: topRes.data || [],
            };
          })
        ),
      ]);

      const primaryDisplayName = primaryArtist?.name?.trim() || primarySeed || '';
      const primaryKey = normalizeKey(primaryDisplayName);

      // Query global Deezer chart when we have no seeds or need fallback items to reach 10-12 per shelf
      const needsChartFallback =
        !primarySeed ||
        primaryRelated.length < 10 ||
        primaryAlbums.length < 6;

      const chart: RawDeezerChartResponse = needsChartFallback
        ? await fetchDeezerJson<RawDeezerChartResponse>('/chart?limit=15').catch(
            () => ({}) as RawDeezerChartResponse
          )
        : {};

      // -----------------------------------------------------------------------
      // Shelf 2: Artists to discover (10 to 12 circular artist avatar cards)
      // -----------------------------------------------------------------------
      const artistsToDiscover: DiscoverArtistItem[] = [];
      const seenArtists = new Set<string>();
      if (primaryArtist?.id) seenArtists.add(String(primaryArtist.id));
      if (primaryKey) seenArtists.add(primaryKey);

      const pushArtist = (
        a: RawDeezerArtist,
        subtitle: string,
        seedLabel: string | null
      ) => {
        if (!a?.id || !a.name) return;
        const idKey = String(a.id);
        const nameKey = normalizeKey(a.name);
        if (!nameKey || seenArtists.has(idKey) || seenArtists.has(nameKey)) return;
        seenArtists.add(idKey);
        seenArtists.add(nameKey);
        const pic = pickHighResPicture(a as unknown as Record<string, unknown>);
        artistsToDiscover.push({
          id: `dz-artist-${a.id}`,
          deezerArtistId: idKey,
          name: a.name.trim(),
          subtitle,
          fans: Number(a.nb_fan) || undefined,
          seedArtist: seedLabel,
          thumbnailUrl: pic,
          fallbackThumbnailUrl: pic,
        });
      };

      // 1) Primary last-played artist's related artists (up to 12)
      for (const a of primaryRelated) {
        if (artistsToDiscover.length >= 12) break;
        pushArtist(a, `Similar to ${primaryDisplayName}`, primaryDisplayName);
      }

      // 2) Top up from secondary recent played artists' related artists to reach 12
      if (artistsToDiscover.length < 12) {
        for (const sec of secondaryExpansions) {
          for (const a of sec.related) {
            if (artistsToDiscover.length >= 12) break;
            if (seedKeys.has(normalizeKey(a.name || ''))) continue;
            pushArtist(a, `Similar to ${sec.displayName}`, sec.displayName);
          }
          if (artistsToDiscover.length >= 12) break;
        }
      }

      // 3) If still under 10 artists (or cold start), fill from Deezer chart artists
      if (artistsToDiscover.length < 10) {
        for (const a of chart.artists?.data || []) {
          if (artistsToDiscover.length >= 12) break;
          if (seedKeys.has(normalizeKey(a.name || ''))) continue;
          pushArtist(
            a,
            primaryDisplayName ? `Similar to ${primaryDisplayName}` : 'Trending artist',
            primaryDisplayName || null
          );
        }
      }

      // -----------------------------------------------------------------------
      // Shelf 1: New releases (newest singles/EPs/albums with release type + date & "New" badge)
      // -----------------------------------------------------------------------
      const releaseCandidates: Array<{
        album: RawDeezerAlbum;
        artistName: string;
        artistId?: string;
        seedLabel: string | null;
      }> = [];

      if (primaryDisplayName) {
        for (const alb of primaryAlbums.slice(0, 4)) {
          releaseCandidates.push({
            album: alb,
            artistName: alb.artist?.name?.trim() || primaryDisplayName,
            artistId: alb.artist?.id
              ? String(alb.artist.id)
              : primaryArtist?.id
                ? String(primaryArtist.id)
                : undefined,
            seedLabel: primaryDisplayName,
          });
        }
      }

      for (const rel of relatedExpansions) {
        for (const alb of rel.albums.slice(0, 3)) {
          releaseCandidates.push({
            album: alb,
            artistName: alb.artist?.name?.trim() || rel.artist.name,
            artistId: alb.artist?.id ? String(alb.artist.id) : String(rel.artist.id),
            seedLabel: primaryDisplayName || rel.artist.name,
          });
        }
      }

      for (const sec of secondaryExpansions) {
        for (const alb of sec.albums.slice(0, 2)) {
          releaseCandidates.push({
            album: alb,
            artistName: alb.artist?.name?.trim() || sec.displayName,
            artistId: alb.artist?.id ? String(alb.artist.id) : sec.artistId,
            seedLabel: sec.displayName,
          });
        }
      }

      // Sort newest-first by release_date so freshest singles/albums appear first
      releaseCandidates.sort((a, b) =>
        (b.album.release_date || '').localeCompare(a.album.release_date || '')
      );

      const seenReleaseIds = new Set<string>();
      const newReleases: DiscoverNewReleaseItem[] = [];

      for (const cand of releaseCandidates) {
        const alb = cand.album;
        if (!alb?.id || !alb.title) continue;
        const idKey = String(alb.id);
        const titleKey = `${normalizeKey(cand.artistName)}::${normalizeKey(alb.title)}`;
        if (seenReleaseIds.has(idKey) || seenReleaseIds.has(titleKey)) continue;
        seenReleaseIds.add(idKey);
        seenReleaseIds.add(titleKey);

        const cover = pickHighResCover(alb as unknown as Record<string, unknown>);
        const recType = formatRecordType(alb.record_type);
        const shortDate = formatShortReleaseDate(alb.release_date);
        const releaseLabel = shortDate ? `${recType} · ${shortDate}` : recType;
        const isFresh = isRecentReleaseDate(alb.release_date);

        newReleases.push({
          id: `dz-release-${alb.id}`,
          url: '',
          title: alb.title.trim(),
          artist: cand.artistName,
          artistId: cand.artistId,
          album: alb.title.trim(),
          albumId: idKey,
          recordType: recType,
          releaseDate: alb.release_date || undefined,
          releaseLabel,
          duration: Number(alb.duration) || 0,
          thumbnailUrl: cover,
          fallbackThumbnailUrl: cover,
          isNew: isFresh || newReleases.length < 3,
          seedArtist: cand.seedLabel,
        });

        if (newReleases.length >= 12) break;
      }

      // Fallback to top tracks / chart tracks when personalized release list has fewer than 10 items
      if (newReleases.length < 10) {
        const fallbackTracks: Array<{
          track: RawDeezerTrack;
          fallbackArtist: string;
          seedLabel: string | null;
        }> = [
          ...primaryTopTracks.map((track) => ({
            track,
            fallbackArtist: primaryDisplayName || 'Artist',
            seedLabel: primaryDisplayName || null,
          })),
          ...relatedExpansions.flatMap((rel) =>
            rel.topTracks.map((track) => ({
              track,
              fallbackArtist: rel.artist.name,
              seedLabel: primaryDisplayName || null,
            }))
          ),
          ...(chart.tracks?.data || []).map((track) => ({
            track,
            fallbackArtist: 'Artist',
            seedLabel: null,
          })),
        ];

        for (const item of fallbackTracks) {
          const t = item.track;
          if (!t?.id || !t.title) continue;
          const artistName = t.artist?.name?.trim() || item.fallbackArtist;
          const albId = t.album?.id ? String(t.album.id) : '';
          const titleKey = `${normalizeKey(artistName)}::${normalizeKey(t.title)}`;
          if ((albId && seenReleaseIds.has(albId)) || seenReleaseIds.has(titleKey)) continue;
          if (albId) seenReleaseIds.add(albId);
          seenReleaseIds.add(titleKey);

          const cover = pickHighResCover(t.album as unknown as Record<string, unknown>);
          const recType = formatRecordType(t.album?.record_type || 'single');
          const shortDate = formatShortReleaseDate(t.album?.release_date);
          newReleases.push({
            id: `dz-track-${t.id}`,
            deezerTrackId: String(t.id),
            url: '',
            title: t.title.trim(),
            artist: artistName,
            artistId: t.artist?.id ? String(t.artist.id) : undefined,
            album: t.album?.title?.trim() || 'Single',
            albumId: albId || undefined,
            recordType: recType,
            releaseDate: t.album?.release_date || undefined,
            releaseLabel: shortDate ? `${recType} · ${shortDate}` : recType,
            duration: Number(t.duration) || 0,
            thumbnailUrl: cover,
            fallbackThumbnailUrl: cover,
            isNew: newReleases.length < 4,
            seedArtist: item.seedLabel,
          });
          if (newReleases.length >= 12) break;
        }
      }

      // -----------------------------------------------------------------------
      // Shelf 3: Albums for you (10 to 12 square album cards with "Similar to <Seed>" subtitle)
      // -----------------------------------------------------------------------
      const albumBuckets: DiscoverAlbumItem[][] = [];

      const mapAlbum = (
        alb: RawDeezerAlbum,
        fallbackArtist: string,
        fallbackArtistId: string | undefined,
        subtitle: string,
        seedLabel: string | null
      ): DiscoverAlbumItem | null => {
        if (!alb?.id || !alb.title) return null;
        const cover = pickHighResCover(alb as unknown as Record<string, unknown>);
        const recordType = formatRecordType(alb.record_type);
        return {
          id: `dz-album-${alb.id}`,
          deezerAlbumId: String(alb.id),
          url: '',
          title: alb.title.trim(),
          artist: alb.artist?.name?.trim() || fallbackArtist,
          artistId: alb.artist?.id ? String(alb.artist.id) : fallbackArtistId,
          subtitle,
          recordType,
          releaseDate: alb.release_date || undefined,
          trackCount: Number(alb.nb_tracks) || undefined,
          duration: Number(alb.duration) || 0,
          thumbnailUrl: cover,
          fallbackThumbnailUrl: cover,
          seedArtist: seedLabel,
        };
      };

      // Prioritize full albums/EPs first for Albums for you, then singles if needed
      const preferFullAlbums = (list: RawDeezerAlbum[]) => [
        ...list.filter((a) => (a.record_type || '').toLowerCase() === 'album'),
        ...list.filter((a) => (a.record_type || '').toLowerCase() === 'ep'),
        ...list.filter(
          (a) =>
            (a.record_type || '').toLowerCase() !== 'album' &&
            (a.record_type || '').toLowerCase() !== 'ep'
        ),
      ];

      // Related artists' albums first ("Similar to <Seed Artist>")
      for (const rel of relatedExpansions) {
        const bucket: DiscoverAlbumItem[] = [];
        for (const alb of preferFullAlbums(rel.albums)) {
          const mapped = mapAlbum(
            alb,
            rel.artist.name,
            String(rel.artist.id),
            primaryDisplayName ? `Similar to ${primaryDisplayName}` : 'Recommended album',
            primaryDisplayName || null
          );
          if (mapped) bucket.push(mapped);
        }
        if (bucket.length > 0) albumBuckets.push(bucket);
      }

      // Primary last-played artist's albums
      if (primaryAlbums.length > 0 && primaryDisplayName) {
        const primaryAlbBucket: DiscoverAlbumItem[] = [];
        for (const alb of preferFullAlbums(primaryAlbums)) {
          const mapped = mapAlbum(
            alb,
            primaryDisplayName,
            primaryArtist?.id ? String(primaryArtist.id) : undefined,
            `More from ${primaryDisplayName}`,
            primaryDisplayName
          );
          if (mapped) primaryAlbBucket.push(mapped);
        }
        if (primaryAlbBucket.length > 0) albumBuckets.push(primaryAlbBucket);
      }

      // Secondary recent played artists' albums
      for (const sec of secondaryExpansions) {
        const bucket: DiscoverAlbumItem[] = [];
        for (const alb of preferFullAlbums(sec.albums)) {
          const mapped = mapAlbum(
            alb,
            sec.displayName,
            sec.artistId,
            `Similar to ${sec.displayName}`,
            sec.displayName
          );
          if (mapped) bucket.push(mapped);
        }
        if (bucket.length > 0) albumBuckets.push(bucket);
      }

      const seenAlbums = new Set<string>();
      const albumsForYou: DiscoverAlbumItem[] = [];
      for (const item of interleaveBuckets(albumBuckets, 28)) {
        const idKey = item.deezerAlbumId || '';
        const titleKey = `${normalizeKey(item.artist)}::${normalizeKey(item.title)}`;
        if ((idKey && seenAlbums.has(idKey)) || seenAlbums.has(titleKey)) continue;
        if (idKey) seenAlbums.add(idKey);
        seenAlbums.add(titleKey);
        albumsForYou.push(item);
        if (albumsForYou.length >= 12) break;
      }

      // Fallback to chart albums when personalized albums are under 10
      if (albumsForYou.length < 10) {
        for (const alb of chart.albums?.data || []) {
          const mapped = mapAlbum(
            alb,
            'Artist',
            undefined,
            primaryDisplayName ? `Similar to ${primaryDisplayName}` : 'Featured album',
            primaryDisplayName || null
          );
          if (!mapped) continue;
          const idKey = mapped.deezerAlbumId || '';
          const titleKey = `${normalizeKey(mapped.artist)}::${normalizeKey(mapped.title)}`;
          if ((idKey && seenAlbums.has(idKey)) || seenAlbums.has(titleKey)) continue;
          if (idKey) seenAlbums.add(idKey);
          seenAlbums.add(titleKey);
          albumsForYou.push(mapped);
          if (albumsForYou.length >= 12) break;
        }
      }

      return {
        seeds,
        basedOnLibrary,
        basedOnHistory,
        lastPlayed,
        source: 'deezer' as const,
        generatedAt: new Date().toISOString(),
        newReleases,
        artistsToDiscover,
        albumsForYou,
      };
    }
  );

  // Always return the freshest lastPlayed track/artist metadata even on a same-artist cache hit
  return {
    ...attachCachedVideoIdsToFeed(data),
    lastPlayed: lastPlayed || data.lastPlayed || null,
    basedOnHistory,
    cached,
  };
}

// ---------------------------------------------------------------------------
// 2. Album Detail (GET /api/discover/album/:id) — instant full tracklist
// ---------------------------------------------------------------------------

export async function getCatalogAlbumDetail(
  rawAlbumId: string,
  options: {forceRefresh?: boolean} = {}
): Promise<DiscoverAlbumDetail> {
  const albumId = rawAlbumId.trim();
  if (!isValidDeezerId(albumId)) {
    throw new Error('Invalid album ID');
  }

  const cacheKey = `deezer:album:v2:${albumId}`;
  const {data, cached} = await withCatalogCache<Omit<DiscoverAlbumDetail, 'cached'>>(
    cacheKey,
    Boolean(options.forceRefresh),
    async () => {
      const alb = await fetchDeezerJson<RawDeezerAlbum>(`/album/${albumId}`);
      if (!alb?.id || !alb.title) {
        throw new Error('Album not found');
      }
      const coverUrl = pickHighResCover(alb as unknown as Record<string, unknown>);
      const artistName = alb.artist?.name?.trim() || 'Unknown Artist';
      const artistId = alb.artist?.id ? String(alb.artist.id) : undefined;
      const artistPictureUrl = pickHighResPicture(alb.artist as unknown as Record<string, unknown>);
      const rawTracks = alb.tracks?.data || [];

      const tracks: DiscoverAlbumTrack[] = rawTracks.map((t, index) => {
        const primaryTrackArtist = t.artist?.name?.trim() || artistName;
        const contributorNames = (t.contributors || [])
          .map((c) => (c?.name || '').trim())
          .filter(Boolean);
        const uniqueArtists = Array.from(new Set(contributorNames));
        const featuredArtists =
          uniqueArtists.length > 1 ? uniqueArtists.join(', ') : primaryTrackArtist;

        return {
          id: `dz-track-${t.id}`,
          deezerTrackId: String(t.id),
          trackNumber: Number(t.track_position) || index + 1,
          diskNumber: Number(t.disk_number) || 1,
          title: (t.title || 'Untitled').trim(),
          artist: primaryTrackArtist,
          featuredArtists,
          artistId: t.artist?.id ? String(t.artist.id) : artistId,
          album: alb.title.trim(),
          albumId,
          duration: Number(t.duration) || 0,
          explicit: Boolean(t.explicit_lyrics),
          coverUrl,
        };
      });

      return {
        id: `dz-album-${albumId}`,
        deezerAlbumId: albumId,
        title: alb.title.trim(),
        artist: artistName,
        artistId,
        artistPictureUrl,
        coverUrl,
        releaseDate: formatYearLabel(alb.release_date, ''),
        releaseYear: extractReleaseYear(alb.release_date) || undefined,
        recordType: formatRecordType(alb.record_type),
        label: alb.label?.trim() || '',
        genre: alb.genres?.data?.[0]?.name?.trim() || '',
        trackCount: Number(alb.nb_tracks) || tracks.length,
        duration:
          Number(alb.duration) || tracks.reduce((sum, item) => sum + (item.duration || 0), 0),
        tracks,
      };
    }
  );

  return {
    ...data,
    tracks: attachCachedVideoIdsToTracks(data.tracks),
    cached,
  };
}

// ---------------------------------------------------------------------------
// 3. Artist Detail (GET /api/discover/artist/:id) — top tracks + discography
// ---------------------------------------------------------------------------

export async function getCatalogArtistDetail(
  rawArtistId: string,
  options: {forceRefresh?: boolean} = {}
): Promise<DiscoverArtistDetail> {
  const artistId = rawArtistId.trim();
  if (!isValidDeezerId(artistId)) {
    throw new Error('Invalid artist ID');
  }

  const cacheKey = `deezer:artist:v2:${artistId}`;
  const {data, cached} = await withCatalogCache<Omit<DiscoverArtistDetail, 'cached'>>(
    cacheKey,
    Boolean(options.forceRefresh),
    async () => {
      const [artist, topRes, albumsRes, relatedRes] = await Promise.all([
        fetchDeezerJson<RawDeezerArtist>(`/artist/${artistId}`),
        fetchDeezerJson<{data?: RawDeezerTrack[]}>(`/artist/${artistId}/top?limit=20`).catch(
          () => ({data: []})
        ),
        fetchDeezerJson<{data?: RawDeezerAlbum[]}>(`/artist/${artistId}/albums?limit=25`).catch(
          () => ({data: []})
        ),
        fetchDeezerJson<{data?: RawDeezerArtist[]}>(`/artist/${artistId}/related?limit=12`).catch(
          () => ({data: []})
        ),
      ]);

      if (!artist?.id || !artist.name) {
        throw new Error('Artist not found');
      }

      const pictureUrl = pickHighResPicture(artist as unknown as Record<string, unknown>);
      const artistName = artist.name.trim();

      const topTracks: DiscoverAlbumTrack[] = (topRes.data || []).map((t, index) => {
        const trackCover =
          pickHighResCover(t.album as unknown as Record<string, unknown>) || pictureUrl;
        const primaryTrackArtist = t.artist?.name?.trim() || artistName;
        const contributorNames = (t.contributors || [])
          .map((c) => (c?.name || '').trim())
          .filter(Boolean);
        const uniqueArtists = Array.from(new Set(contributorNames));

        return {
          id: `dz-track-${t.id}`,
          deezerTrackId: String(t.id),
          trackNumber: index + 1,
          diskNumber: 1,
          title: (t.title || 'Untitled').trim(),
          artist: primaryTrackArtist,
          featuredArtists:
            uniqueArtists.length > 1 ? uniqueArtists.join(', ') : primaryTrackArtist,
          artistId: t.artist?.id ? String(t.artist.id) : artistId,
          album: t.album?.title?.trim() || 'Single',
          albumId: t.album?.id ? String(t.album.id) : '',
          duration: Number(t.duration) || 0,
          explicit: Boolean(t.explicit_lyrics),
          coverUrl: trackCover,
        };
      });

      const sortedAlbums = sortAlbumsNewestFirst(albumsRes.data || []);
      const seenAlbums = new Set<string>();
      const albums: DiscoverArtistAlbumSummary[] = [];
      for (const alb of sortedAlbums) {
        if (!alb?.id || !alb.title) continue;
        const key = `${normalizeKey(alb.title)}::${(alb.record_type || '').toLowerCase()}`;
        if (seenAlbums.has(key)) continue;
        seenAlbums.add(key);
        albums.push({
          id: `dz-album-${alb.id}`,
          deezerAlbumId: String(alb.id),
          title: alb.title.trim(),
          releaseDate: formatYearLabel(alb.release_date, ''),
          rawReleaseDate: alb.release_date || undefined,
          recordType: formatRecordType(alb.record_type),
          coverUrl: pickHighResCover(alb as unknown as Record<string, unknown>),
        });
      }

      const latestRelease = albums.length > 0 ? albums[0] : null;

      const relatedArtists: DiscoverArtistItem[] = (relatedRes.data || [])
        .filter((a) => a?.id && a.name)
        .slice(0, 12)
        .map((a) => {
          const pic = pickHighResPicture(a as unknown as Record<string, unknown>);
          return {
            id: `dz-artist-${a.id}`,
            deezerArtistId: String(a.id),
            name: a.name.trim(),
            subtitle: `Similar to ${artistName}`,
            fans: Number(a.nb_fan) || undefined,
            seedArtist: artistName,
            thumbnailUrl: pic,
            fallbackThumbnailUrl: pic,
          };
        });

      return {
        id: `dz-artist-${artistId}`,
        deezerArtistId: artistId,
        name: artistName,
        pictureUrl,
        fans: Number(artist.nb_fan) || 0,
        albumCount: Number(artist.nb_album) || albums.length,
        latestRelease,
        topTracks,
        albums,
        relatedArtists,
      };
    }
  );

  return {
    ...data,
    topTracks: attachCachedVideoIdsToTracks(data.topTracks),
    cached,
  };
}
