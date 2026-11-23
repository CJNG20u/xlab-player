import {db} from './db.ts';
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

export interface DiscoverFeedResponse {
  seeds: string[];
  basedOnLibrary: boolean;
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
// 1. Discover Feed (Deezer Chart + Personalized Library Seed Artists)
// ---------------------------------------------------------------------------

export async function getCatalogDiscoverFeed(
  userId: number,
  options: {forceRefresh?: boolean} = {}
): Promise<DiscoverFeedResponse> {
  const seeds = pickDiscoverSeedArtists(userId, 3);
  const basedOnLibrary = seeds.length > 0;
  const cacheKey = basedOnLibrary
    ? `discover:deezer:v1:${seeds.map(normalizeKey).sort().join('|')}`
    : 'discover:deezer:v1:__chart__';

  const {data, cached} = await withCatalogCache<Omit<DiscoverFeedResponse, 'cached'>>(
    cacheKey,
    Boolean(options.forceRefresh),
    async () => {
      const seedKeys = new Set(seeds.map(normalizeKey));

      // Always fetch Deezer global chart as fast baseline + fallback
      const chartPromise = fetchDeezerJson<RawDeezerChartResponse>('/chart?limit=15').catch(
        () => ({}) as RawDeezerChartResponse
      );

      // For personalized libraries, resolve seed artists -> top tracks, albums, related artists
      const seedResults = basedOnLibrary
        ? await Promise.all(
            seeds.map(async (seed) => {
              const q = encodeURIComponent(seed);
              const [artistSearch, albumSearch] = await Promise.all([
                fetchDeezerJson<{data?: RawDeezerArtist[]}>(`/search/artist?q=${q}&limit=2`).catch(
                  () => ({data: []})
                ),
                fetchDeezerJson<{data?: RawDeezerAlbum[]}>(`/search/album?q=${q}&limit=6`).catch(
                  () => ({data: []})
                ),
              ]);

              const matchedArtist = artistSearch.data?.[0];
              let topTracks: RawDeezerTrack[] = [];
              let relatedArtists: RawDeezerArtist[] = [];

              if (matchedArtist?.id) {
                const [topRes, relRes] = await Promise.all([
                  fetchDeezerJson<{data?: RawDeezerTrack[]}>(
                    `/artist/${matchedArtist.id}/top?limit=6`
                  ).catch(() => ({data: []})),
                  fetchDeezerJson<{data?: RawDeezerArtist[]}>(
                    `/artist/${matchedArtist.id}/related?limit=6`
                  ).catch(() => ({data: []})),
                ]);
                topTracks = topRes.data || [];
                relatedArtists = relRes.data || [];
              }

              return {
                seed,
                topTracks,
                relatedArtists,
                albums: albumSearch.data || [],
              };
            })
          )
        : [];

      const chart = await chartPromise;

      // Build Shelf 1: New releases / Recommended tracks
      const trackBuckets: DiscoverNewReleaseItem[][] = [];
      for (const sr of seedResults) {
        const bucket: DiscoverNewReleaseItem[] = [];
        for (const t of sr.topTracks) {
          if (!t?.id || !t.title) continue;
          const cover = pickHighResCover(t.album as unknown as Record<string, unknown>);
          const artistName = t.artist?.name?.trim() || sr.seed;
          bucket.push({
            id: `dz-track-${t.id}`,
            deezerTrackId: String(t.id),
            url: '',
            title: t.title.trim(),
            artist: artistName,
            artistId: t.artist?.id ? String(t.artist.id) : undefined,
            album: t.album?.title?.trim() || 'Single',
            albumId: t.album?.id ? String(t.album.id) : undefined,
            releaseLabel: t.album?.title?.trim() || `Because you listen to ${sr.seed}`,
            duration: Number(t.duration) || 0,
            thumbnailUrl: cover,
            fallbackThumbnailUrl: cover,
            isNew: false,
            seedArtist: sr.seed,
          });
        }
        if (bucket.length > 0) trackBuckets.push(bucket);
      }

      // Append chart tracks so shelf is always full & lively
      const chartTrackBucket: DiscoverNewReleaseItem[] = [];
      for (const t of chart.tracks?.data || []) {
        if (!t?.id || !t.title) continue;
        const cover = pickHighResCover(t.album as unknown as Record<string, unknown>);
        chartTrackBucket.push({
          id: `dz-track-${t.id}`,
          deezerTrackId: String(t.id),
          url: '',
          title: t.title.trim(),
          artist: t.artist?.name?.trim() || 'Artist',
          artistId: t.artist?.id ? String(t.artist.id) : undefined,
          album: t.album?.title?.trim() || 'Chart Hit',
          albumId: t.album?.id ? String(t.album.id) : undefined,
          releaseLabel: t.album?.title?.trim() || 'Trending',
          duration: Number(t.duration) || 0,
          thumbnailUrl: cover,
          fallbackThumbnailUrl: cover,
          isNew: true,
          seedArtist: null,
        });
      }
      if (chartTrackBucket.length > 0) trackBuckets.push(chartTrackBucket);

      const seenTracks = new Set<string>();
      const newReleases = interleaveBuckets(trackBuckets, 24)
        .filter((item) => {
          const key = `${normalizeKey(item.artist)}::${normalizeKey(item.title)}`;
          if (seenTracks.has(key)) return false;
          seenTracks.add(key);
          return true;
        })
        .slice(0, 14);

      // Build Shelf 2: Artists to discover
      const artistBuckets: DiscoverArtistItem[][] = [];
      for (const sr of seedResults) {
        const bucket: DiscoverArtistItem[] = [];
        for (const a of sr.relatedArtists) {
          if (!a?.id || !a.name) continue;
          const aKey = normalizeKey(a.name);
          if (!aKey || seedKeys.has(aKey)) continue;
          const pic = pickHighResPicture(a as unknown as Record<string, unknown>);
          bucket.push({
            id: `dz-artist-${a.id}`,
            deezerArtistId: String(a.id),
            name: a.name.trim(),
            subtitle: `Similar to ${sr.seed}`,
            fans: Number(a.nb_fan) || undefined,
            seedArtist: sr.seed,
            thumbnailUrl: pic,
            fallbackThumbnailUrl: pic,
          });
        }
        if (bucket.length > 0) artistBuckets.push(bucket);
      }

      const chartArtistBucket: DiscoverArtistItem[] = [];
      for (const a of chart.artists?.data || []) {
        if (!a?.id || !a.name) continue;
        const aKey = normalizeKey(a.name);
        if (!aKey || seedKeys.has(aKey)) continue;
        const pic = pickHighResPicture(a as unknown as Record<string, unknown>);
        chartArtistBucket.push({
          id: `dz-artist-${a.id}`,
          deezerArtistId: String(a.id),
          name: a.name.trim(),
          subtitle: 'Trending artist',
          fans: Number(a.nb_fan) || undefined,
          seedArtist: null,
          thumbnailUrl: pic,
          fallbackThumbnailUrl: pic,
        });
      }
      if (chartArtistBucket.length > 0) artistBuckets.push(chartArtistBucket);

      const seenArtists = new Set<string>();
      const artistsToDiscover = interleaveBuckets(artistBuckets, 24)
        .filter((item) => {
          const key = item.deezerArtistId || normalizeKey(item.name);
          if (seenArtists.has(key)) return false;
          seenArtists.add(key);
          return true;
        })
        .slice(0, 14);

      // Build Shelf 3: Albums for you
      const albumBuckets: DiscoverAlbumItem[][] = [];
      for (const sr of seedResults) {
        const bucket: DiscoverAlbumItem[] = [];
        for (const alb of sr.albums) {
          if (!alb?.id || !alb.title) continue;
          const cover = pickHighResCover(alb as unknown as Record<string, unknown>);
          bucket.push({
            id: `dz-album-${alb.id}`,
            deezerAlbumId: String(alb.id),
            url: '',
            title: alb.title.trim(),
            artist: alb.artist?.name?.trim() || sr.seed,
            artistId: alb.artist?.id ? String(alb.artist.id) : undefined,
            subtitle: `Inspired by ${sr.seed}`,
            releaseDate: alb.release_date || undefined,
            trackCount: Number(alb.nb_tracks) || undefined,
            duration: Number(alb.duration) || 0,
            thumbnailUrl: cover,
            fallbackThumbnailUrl: cover,
            seedArtist: sr.seed,
          });
        }
        if (bucket.length > 0) albumBuckets.push(bucket);
      }

      const chartAlbumBucket: DiscoverAlbumItem[] = [];
      for (const alb of chart.albums?.data || []) {
        if (!alb?.id || !alb.title) continue;
        const cover = pickHighResCover(alb as unknown as Record<string, unknown>);
        chartAlbumBucket.push({
          id: `dz-album-${alb.id}`,
          deezerAlbumId: String(alb.id),
          url: '',
          title: alb.title.trim(),
          artist: alb.artist?.name?.trim() || 'Artist',
          artistId: alb.artist?.id ? String(alb.artist.id) : undefined,
          subtitle: alb.record_type
            ? `${alb.record_type.charAt(0).toUpperCase()}${alb.record_type.slice(1)}`
            : 'Featured album',
          releaseDate: alb.release_date || undefined,
          trackCount: Number(alb.nb_tracks) || undefined,
          duration: Number(alb.duration) || 0,
          thumbnailUrl: cover,
          fallbackThumbnailUrl: cover,
          seedArtist: null,
        });
      }
      if (chartAlbumBucket.length > 0) albumBuckets.push(chartAlbumBucket);

      const seenAlbums = new Set<string>();
      const albumsForYou = interleaveBuckets(albumBuckets, 24)
        .filter((item) => {
          const key = item.deezerAlbumId || `${normalizeKey(item.artist)}::${normalizeKey(item.title)}`;
          if (seenAlbums.has(key)) return false;
          seenAlbums.add(key);
          return true;
        })
        .slice(0, 14);

      return {
        seeds,
        basedOnLibrary,
        source: 'deezer' as const,
        generatedAt: new Date().toISOString(),
        newReleases,
        artistsToDiscover,
        albumsForYou,
      };
    }
  );

  return {
    ...attachCachedVideoIdsToFeed(data),
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
