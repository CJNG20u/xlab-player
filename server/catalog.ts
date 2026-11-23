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

function formatYearLabel(releaseDate: string | undefined, fallback: string): string {
  if (!releaseDate) return fallback;
  const trimmed = releaseDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const monthIdx = Number(trimmed.slice(5, 7)) - 1;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${months[monthIdx]} ${year}`;
    }
    return year;
  }
  if (/^\d{4}/.test(trimmed)) {
    return trimmed.slice(0, 4);
  }
  return fallback;
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
    ? `discover:deezer:v2:hist:${seeds.map(normalizeKey).join('>')}`
    : basedOnLibrary
      ? `discover:deezer:v2:lib:${seeds.map(normalizeKey).join('>')}`
      : 'discover:deezer:v2:__chart__';

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

      // Fetch primary artist's related artists (up to 12), albums (up to 12), and top tracks (up to 10)
      let primaryRelated: RawDeezerArtist[] = [];
      let primaryAlbums: RawDeezerAlbum[] = [];
      let primaryTopTracks: RawDeezerTrack[] = [];

      if (primaryArtist?.id) {
        const [relRes, albRes, topRes] = await Promise.all([
          fetchDeezerJson<{data?: RawDeezerArtist[]}>(
            `/artist/${primaryArtist.id}/related?limit=12`
          ).catch(() => ({data: []})),
          fetchDeezerJson<{data?: RawDeezerAlbum[]}>(
            `/artist/${primaryArtist.id}/albums?limit=12`
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
          `/search/album?q=${encodeURIComponent(primarySeed)}&limit=10`
        ).catch(() => ({data: []}));
        primaryAlbums = albSearch.data || [];
      }

      // Fetch top tracks & albums from top 3 related artists of the primary seed + secondary recent seeds
      const topRelatedForExpansion = primaryRelated
        .filter((a) => a?.id && a.name && !seedKeys.has(normalizeKey(a.name)))
        .slice(0, 3);

      const [relatedExpansions, secondaryExpansions] = await Promise.all([
        Promise.all(
          topRelatedForExpansion.map(async (rel) => {
            const [topRes, albRes] = await Promise.all([
              fetchDeezerJson<{data?: RawDeezerTrack[]}>(
                `/artist/${rel.id}/top?limit=4`
              ).catch(() => ({data: []})),
              fetchDeezerJson<{data?: RawDeezerAlbum[]}>(
                `/artist/${rel.id}/albums?limit=4`
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
                related: [] as RawDeezerArtist[],
                albums: [] as RawDeezerAlbum[],
                topTracks: [] as RawDeezerTrack[],
              };
            }
            const [relRes, albRes, topRes] = await Promise.all([
              fetchDeezerJson<{data?: RawDeezerArtist[]}>(
                `/artist/${resolved.id}/related?limit=10`
              ).catch(() => ({data: []})),
              fetchDeezerJson<{data?: RawDeezerAlbum[]}>(
                `/artist/${resolved.id}/albums?limit=6`
              ).catch(() => ({data: []})),
              fetchDeezerJson<{data?: RawDeezerTrack[]}>(
                `/artist/${resolved.id}/top?limit=5`
              ).catch(() => ({data: []})),
            ]);
            return {
              seed: seedName,
              displayName: resolved.name?.trim() || seedName,
              related: relRes.data || [],
              albums: sortAlbumsNewestFirst(albRes.data || []),
              topTracks: topRes.data || [],
            };
          })
        ),
      ]);

      const primaryDisplayName = primaryArtist?.name?.trim() || primarySeed || '';
      const primaryKey = normalizeKey(primaryDisplayName);

      // Only query global Deezer chart if we have no seeds or need fallback items to reach healthy shelf sizes
      const needsChartFallback =
        !primarySeed ||
        primaryRelated.length < 8 ||
        primaryTopTracks.length < 4 ||
        primaryAlbums.length < 4;

      const chart: RawDeezerChartResponse = needsChartFallback
        ? await fetchDeezerJson<RawDeezerChartResponse>('/chart?limit=15').catch(
            () => ({}) as RawDeezerChartResponse
          )
        : {};

      // -----------------------------------------------------------------------
      // Shelf 2: Artists to discover (8 to 12 artists from primary + secondary related)
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

      // 2) Top up from secondary recent played artists' related artists if fewer than 12
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

      // 3) Only if still under 8 artists (or cold start with no history/library), fill from chart
      if (artistsToDiscover.length < 8) {
        for (const a of chart.artists?.data || []) {
          if (artistsToDiscover.length >= 12) break;
          if (seedKeys.has(normalizeKey(a.name || ''))) continue;
          pushArtist(a, 'Trending artist', null);
        }
      }

      // -----------------------------------------------------------------------
      // Shelf 1: New releases (driven by last played artist + related/recent artists)
      // -----------------------------------------------------------------------
      const lastPlayedTitleKey = normalizeKey(lastPlayed?.title || '');
      const trackBuckets: DiscoverNewReleaseItem[][] = [];

      const mapTrack = (
        t: RawDeezerTrack,
        fallbackArtist: string,
        releaseLabel: string,
        seedLabel: string | null,
        isNew: boolean
      ): DiscoverNewReleaseItem | null => {
        if (!t?.id || !t.title) return null;
        const cover = pickHighResCover(t.album as unknown as Record<string, unknown>);
        const artistName = t.artist?.name?.trim() || fallbackArtist;
        return {
          id: `dz-track-${t.id}`,
          deezerTrackId: String(t.id),
          url: '',
          title: t.title.trim(),
          artist: artistName,
          artistId: t.artist?.id ? String(t.artist.id) : undefined,
          album: t.album?.title?.trim() || 'Single',
          albumId: t.album?.id ? String(t.album.id) : undefined,
          releaseLabel: t.album?.title?.trim() || releaseLabel,
          duration: Number(t.duration) || 0,
          thumbnailUrl: cover,
          fallbackThumbnailUrl: cover,
          isNew,
          seedArtist: seedLabel,
        };
      };

      // Primary artist's tracks (defer exact just-played track so recommendations feel fresh)
      if (primaryTopTracks.length > 0 && primaryDisplayName) {
        const freshPrimary: DiscoverNewReleaseItem[] = [];
        const deferredJustPlayed: DiscoverNewReleaseItem[] = [];
        for (let i = 0; i < primaryTopTracks.length; i++) {
          const t = primaryTopTracks[i];
          const mapped = mapTrack(
            t,
            primaryDisplayName,
            `More from ${primaryDisplayName}`,
            primaryDisplayName,
            i < 2
          );
          if (!mapped) continue;
          if (lastPlayedTitleKey && normalizeKey(mapped.title) === lastPlayedTitleKey) {
            deferredJustPlayed.push(mapped);
          } else {
            freshPrimary.push(mapped);
          }
        }
        const combined = [...freshPrimary, ...deferredJustPlayed];
        if (combined.length > 0) trackBuckets.push(combined);
      }

      // Related artists' top tracks (same vibe as last played artist)
      for (const rel of relatedExpansions) {
        const bucket: DiscoverNewReleaseItem[] = [];
        for (let i = 0; i < rel.topTracks.length; i++) {
          const mapped = mapTrack(
            rel.topTracks[i],
            rel.artist.name,
            `Similar to ${primaryDisplayName}`,
            primaryDisplayName,
            i === 0
          );
          if (mapped) bucket.push(mapped);
        }
        if (bucket.length > 0) trackBuckets.push(bucket);
      }

      // Secondary recent played artists' tracks
      for (const sec of secondaryExpansions) {
        const bucket: DiscoverNewReleaseItem[] = [];
        for (const t of sec.topTracks) {
          const mapped = mapTrack(
            t,
            sec.displayName,
            `Because you played ${sec.displayName}`,
            sec.displayName,
            false
          );
          if (mapped) bucket.push(mapped);
        }
        if (bucket.length > 0) trackBuckets.push(bucket);
      }

      const seenTracks = new Set<string>();
      const newReleases: DiscoverNewReleaseItem[] = [];
      for (const item of interleaveBuckets(trackBuckets, 24)) {
        const key = `${normalizeKey(item.artist)}::${normalizeKey(item.title)}`;
        if (seenTracks.has(key)) continue;
        seenTracks.add(key);
        newReleases.push(item);
        if (newReleases.length >= 14) break;
      }

      // Fallback to chart tracks only when personalized results are empty or sparse
      if (newReleases.length < 6) {
        for (const t of chart.tracks?.data || []) {
          const mapped = mapTrack(t, 'Artist', 'Trending', null, true);
          if (!mapped) continue;
          const key = `${normalizeKey(mapped.artist)}::${normalizeKey(mapped.title)}`;
          if (seenTracks.has(key)) continue;
          seenTracks.add(key);
          newReleases.push(mapped);
          if (newReleases.length >= 14) break;
        }
      }

      // -----------------------------------------------------------------------
      // Shelf 3: Albums for you (last played artist's albums + related & recent artists' albums)
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
        const recordType = alb.record_type
          ? `${alb.record_type.charAt(0).toUpperCase()}${alb.record_type.slice(1)}`
          : 'Album';
        const yearLabel = formatYearLabel(alb.release_date, '');
        return {
          id: `dz-album-${alb.id}`,
          deezerAlbumId: String(alb.id),
          url: '',
          title: alb.title.trim(),
          artist: alb.artist?.name?.trim() || fallbackArtist,
          artistId: alb.artist?.id ? String(alb.artist.id) : fallbackArtistId,
          subtitle: yearLabel ? `${recordType} · ${yearLabel}` : subtitle,
          releaseDate: alb.release_date || undefined,
          trackCount: Number(alb.nb_tracks) || undefined,
          duration: Number(alb.duration) || 0,
          thumbnailUrl: cover,
          fallbackThumbnailUrl: cover,
          seedArtist: seedLabel,
        };
      };

      // Primary last-played artist's albums (newest first)
      if (primaryAlbums.length > 0 && primaryDisplayName) {
        const primaryAlbBucket: DiscoverAlbumItem[] = [];
        for (const alb of primaryAlbums) {
          const mapped = mapAlbum(
            alb,
            primaryDisplayName,
            primaryArtist?.id ? String(primaryArtist.id) : undefined,
            `By ${primaryDisplayName}`,
            primaryDisplayName
          );
          if (mapped) primaryAlbBucket.push(mapped);
        }
        if (primaryAlbBucket.length > 0) albumBuckets.push(primaryAlbBucket);
      }

      // Related artists' albums
      for (const rel of relatedExpansions) {
        const bucket: DiscoverAlbumItem[] = [];
        for (const alb of rel.albums) {
          const mapped = mapAlbum(
            alb,
            rel.artist.name,
            String(rel.artist.id),
            `Similar to ${primaryDisplayName}`,
            primaryDisplayName
          );
          if (mapped) bucket.push(mapped);
        }
        if (bucket.length > 0) albumBuckets.push(bucket);
      }

      // Secondary recent played artists' albums
      for (const sec of secondaryExpansions) {
        const bucket: DiscoverAlbumItem[] = [];
        for (const alb of sec.albums) {
          const mapped = mapAlbum(
            alb,
            sec.displayName,
            undefined,
            `Inspired by ${sec.displayName}`,
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
        if (albumsForYou.length >= 14) break;
      }

      // Fallback to chart albums only if personalized albums are empty or sparse
      if (albumsForYou.length < 6) {
        for (const alb of chart.albums?.data || []) {
          const mapped = mapAlbum(alb, 'Artist', undefined, 'Featured album', null);
          if (!mapped) continue;
          const idKey = mapped.deezerAlbumId || '';
          const titleKey = `${normalizeKey(mapped.artist)}::${normalizeKey(mapped.title)}`;
          if ((idKey && seenAlbums.has(idKey)) || seenAlbums.has(titleKey)) continue;
          if (idKey) seenAlbums.add(idKey);
          seenAlbums.add(titleKey);
          albumsForYou.push(mapped);
          if (albumsForYou.length >= 14) break;
        }
      }

      // Flag any newReleases whose album has a very recent release date from primary/related albums
      const recentAlbumIds = new Set(
        [...primaryAlbums, ...relatedExpansions.flatMap((r) => r.albums)]
          .filter((a) => isRecentReleaseDate(a.release_date))
          .map((a) => String(a.id))
      );
      for (const item of newReleases) {
        if (item.albumId && recentAlbumIds.has(item.albumId)) {
          item.isNew = true;
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

  const cacheKey = `deezer:album:v1:${albumId}`;
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

      const tracks: DiscoverAlbumTrack[] = rawTracks.map((t, index) => ({
        id: `dz-track-${t.id}`,
        deezerTrackId: String(t.id),
        trackNumber: Number(t.track_position) || index + 1,
        diskNumber: Number(t.disk_number) || 1,
        title: (t.title || 'Untitled').trim(),
        artist: t.artist?.name?.trim() || artistName,
        artistId: t.artist?.id ? String(t.artist.id) : artistId,
        album: alb.title.trim(),
        albumId,
        duration: Number(t.duration) || 0,
        explicit: Boolean(t.explicit_lyrics),
        coverUrl,
      }));

      return {
        id: `dz-album-${albumId}`,
        deezerAlbumId: albumId,
        title: alb.title.trim(),
        artist: artistName,
        artistId,
        artistPictureUrl,
        coverUrl,
        releaseDate: formatYearLabel(alb.release_date, ''),
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

  const cacheKey = `deezer:artist:v1:${artistId}`;
  const {data, cached} = await withCatalogCache<Omit<DiscoverArtistDetail, 'cached'>>(
    cacheKey,
    Boolean(options.forceRefresh),
    async () => {
      const [artist, topRes, albumsRes, relatedRes] = await Promise.all([
        fetchDeezerJson<RawDeezerArtist>(`/artist/${artistId}`),
        fetchDeezerJson<{data?: RawDeezerTrack[]}>(`/artist/${artistId}/top?limit=25`).catch(
          () => ({data: []})
        ),
        fetchDeezerJson<{data?: RawDeezerAlbum[]}>(`/artist/${artistId}/albums?limit=20`).catch(
          () => ({data: []})
        ),
        fetchDeezerJson<{data?: RawDeezerArtist[]}>(`/artist/${artistId}/related?limit=10`).catch(
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
        return {
          id: `dz-track-${t.id}`,
          deezerTrackId: String(t.id),
          trackNumber: index + 1,
          diskNumber: 1,
          title: (t.title || 'Untitled').trim(),
          artist: t.artist?.name?.trim() || artistName,
          artistId: t.artist?.id ? String(t.artist.id) : artistId,
          album: t.album?.title?.trim() || 'Single',
          albumId: t.album?.id ? String(t.album.id) : '',
          duration: Number(t.duration) || 0,
          explicit: Boolean(t.explicit_lyrics),
          coverUrl: trackCover,
        };
      });

      const seenAlbums = new Set<string>();
      const albums: DiscoverArtistAlbumSummary[] = [];
      for (const alb of albumsRes.data || []) {
        if (!alb?.id || !alb.title) continue;
        const key = normalizeKey(alb.title);
        if (seenAlbums.has(key)) continue;
        seenAlbums.add(key);
        albums.push({
          id: `dz-album-${alb.id}`,
          deezerAlbumId: String(alb.id),
          title: alb.title.trim(),
          releaseDate: formatYearLabel(alb.release_date, ''),
          recordType: alb.record_type
            ? `${alb.record_type.charAt(0).toUpperCase()}${alb.record_type.slice(1)}`
            : 'Album',
          coverUrl: pickHighResCover(alb as unknown as Record<string, unknown>),
        });
      }

      const relatedArtists: DiscoverArtistItem[] = (relatedRes.data || [])
        .filter((a) => a?.id && a.name)
        .slice(0, 10)
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
