import {type NextFunction, type Request, type Response, Router} from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import {type AuthRequest, requireAuth, requireDownloadPermission} from '../auth.ts';
import {type AuthUser, resolveUserFromRequest} from '../auth.ts';
import {claimTrackForUser, db, getMusicDir, recordPlayHistory} from '../db.ts';
import {hasFullLibrary, scrubHiddenDuplicateHints} from '../trackAccess.ts';
import {
  getCatalogAlbumDetail,
  getCatalogArtistDetail,
  getCatalogDiscoverFeed,
  isValidDeezerId,
  searchCatalog,
} from '../catalog.ts';
import {
  planAutoplayForUser,
  type AutoplayContextTrackInput,
} from '../autoplayService.ts';
import {
  cancelPlaylistDownloadJobForUser,
  getPlaylistDownloadJobForUser,
  isValidPlaylistJobId,
  listPlaylistDownloadJobsForUser,
  startYouTubePlaylistDownload,
} from '../playlistDownloadService.ts';
import {
  cancelDownloadJob,
  downloadEvents,
  downloadTrackToNas,
  enqueueDownloadJob,
  fetchMetadataPreview,
  getDownloadJobs,
  getYoutubePlaylistDetail,
  isValidYouTubePlaylistId,
  isValidYouTubeVideoId,
  normalizeDownloadQuality,
  peekTrackMetadata,
  sanitizeNasSegment,
  searchYoutubePlaylists,
  spawnAudioPreviewStream,
  type DownloadJobRow,
} from '../downloader.ts';
import {AUDIO_EXTENSIONS, indexSingleFile} from '../scanner.ts';

export const downloadRouter = Router();
export const discoverRouter = Router();

// Search/peek results flag songs that are "already in your library". For users limited to part of
// the library, drop that hint for songs they cannot see so it does not reveal what is hidden.
function scrubForLimitedUsers(req: Request, res: Response, next: NextFunction): void {
  const user: AuthUser | null = resolveUserFromRequest(req);
  if (!user || hasFullLibrary(user)) {
    next();
    return;
  }
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => originalJson(scrubHiddenDuplicateHints(db, user, body))) as typeof res.json;
  next();
}
downloadRouter.use(scrubForLimitedUsers);
discoverRouter.use(scrubForLimitedUsers);

const PLAYLIST_SEARCH_ROUTE_TIMEOUT_MS = 5000;

async function searchYoutubePlaylistsWithTimeout(query: string, limit = 8) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      searchYoutubePlaylists(query, limit).catch(() => []),
      new Promise<Awaited<ReturnType<typeof searchYoutubePlaylists>>>((resolve) => {
        timer = setTimeout(() => resolve([]), PLAYLIST_SEARCH_ROUTE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

discoverRouter.post('/discover/history', requireAuth, (req: AuthRequest, res) => {
  const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const rawArtist = typeof req.body?.artist === 'string' ? req.body.artist.trim() : '';
  if (!rawTitle && !rawArtist) {
    res.status(400).json({error: 'Track title or artist is required'});
    return;
  }

  const rawTrackId = req.body?.trackId;
  const trackId =
    typeof rawTrackId === 'number' && Number.isInteger(rawTrackId) && rawTrackId > 0
      ? rawTrackId
      : null;

  const rawVideoId = typeof req.body?.videoId === 'string' ? req.body.videoId.trim() : '';
  const videoId = isValidYouTubeVideoId(rawVideoId) ? rawVideoId : '';

  const now = Date.now();
  const rawPlayedAt = req.body?.playedAt;
  const playedAt =
    typeof rawPlayedAt === 'number' &&
    Number.isFinite(rawPlayedAt) &&
    rawPlayedAt > 0 &&
    rawPlayedAt <= now + 60_000
      ? Math.floor(rawPlayedAt)
      : now;

  try {
    recordPlayHistory({
      userId: req.user!.id,
      title: rawTitle.slice(0, 200),
      artist: rawArtist.slice(0, 200),
      trackId,
      videoId,
      playedAt,
    });
    res.status(201).json({ok: true});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to record playback history';
    console.error('[discover-history]', msg);
    res.status(500).json({error: 'Failed to record playback history'});
  }
});

const handleGetDiscoverFeed = async (req: AuthRequest, res: import('express').Response) => {
  try {
    const refreshParam = String(req.query.refresh || '').trim().toLowerCase();
    const forceRefresh = refreshParam === '1' || refreshParam === 'true';
    const seedArtist =
      typeof req.query.seedArtist === 'string' ? req.query.seedArtist.trim().slice(0, 150) : '';
    const seedTitle =
      typeof req.query.seedTitle === 'string' ? req.query.seedTitle.trim().slice(0, 200) : '';
    const feed = await getCatalogDiscoverFeed(req.user!.id, {
      forceRefresh,
      seedArtist: seedArtist || undefined,
      seedTitle: seedTitle || undefined,
    });
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(feed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load Discover recommendations';
    console.error('[discover]', msg);
    res.status(502).json({error: msg});
  }
};

discoverRouter.get('/discover', requireAuth, handleGetDiscoverFeed);
discoverRouter.get('/discover/feed', requireAuth, handleGetDiscoverFeed);

discoverRouter.get('/discover/search', requireAuth, async (req: AuthRequest, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!rawQuery) {
    res.status(400).json({error: 'Search query parameter q is required'});
    return;
  }
  const safeQuery = rawQuery.slice(0, 120);
  try {
    const [result, playlists] = await Promise.all([
      searchCatalog(safeQuery),
      searchYoutubePlaylistsWithTimeout(safeQuery, 8),
    ]);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({...result, playlists});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to search catalog';
    console.error('[discover-search]', safeQuery, msg);
    res.status(502).json({error: msg});
  }
});

discoverRouter.get('/youtube/playlist/:id', requireAuth, async (req: AuthRequest, res) => {
  const playlistId = String(req.params.id || '').trim();
  if (!isValidYouTubePlaylistId(playlistId)) {
    res.status(400).json({error: 'Invalid playlist ID'});
    return;
  }
  try {
    const refreshParam = String(req.query.refresh || '').trim().toLowerCase();
    const forceRefresh = refreshParam === '1' || refreshParam === 'true';
    const detail = await getYoutubePlaylistDetail(playlistId, {forceRefresh});
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load YouTube playlist';
    console.error('[youtube-playlist]', playlistId, msg);
    res.status(502).json({error: msg});
  }
});

discoverRouter.post(
  '/youtube/playlist/:id/download',
  requireDownloadPermission,
  async (req: AuthRequest, res) => {
    const playlistId = String(req.params.id || '').trim();
    if (!isValidYouTubePlaylistId(playlistId)) {
      res.status(400).json({error: 'Invalid playlist ID'});
      return;
    }

    const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
    const cleanName = rawName.replace(/[\r\n]/g, '').trim();
    if (!cleanName) {
      res.status(400).json({error: 'Playlist name is required'});
      return;
    }
    if (cleanName.length > 100) {
      res.status(400).json({error: 'Playlist name must be 100 characters or fewer'});
      return;
    }

    try {
      const result = await startYouTubePlaylistDownload({
        userId: req.user!.id,
        youtubePlaylistId: playlistId,
        name: cleanName,
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start playlist download';
      console.error('[youtube-playlist-download]', playlistId, msg);
      res.status(502).json({error: msg});
    }
  }
);

discoverRouter.get('/youtube/playlist-jobs', requireAuth, (req: AuthRequest, res) => {
  const jobs = listPlaylistDownloadJobsForUser(req.user!.id, req.user!.role);
  res.setHeader('Cache-Control', 'no-store');
  res.json({jobs});
});

discoverRouter.get('/youtube/playlist-jobs/:jobId', requireAuth, (req: AuthRequest, res) => {
  const jobId = String(req.params.jobId || '').trim();
  if (!isValidPlaylistJobId(jobId)) {
    res.status(400).json({error: 'Invalid job ID'});
    return;
  }
  const outcome = getPlaylistDownloadJobForUser(jobId, req.user!.id, req.user!.role, true);
  if (outcome.status === 'not_found') {
    res.status(404).json({error: 'Playlist download job not found'});
    return;
  }
  if (outcome.status === 'forbidden') {
    res.status(403).json({error: 'Not allowed to access this download job'});
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(outcome.job);
});

discoverRouter.post('/youtube/playlist-jobs/:jobId/cancel', requireAuth, (req: AuthRequest, res) => {
  const jobId = String(req.params.jobId || '').trim();
  if (!isValidPlaylistJobId(jobId)) {
    res.status(400).json({error: 'Invalid job ID'});
    return;
  }
  const outcome = cancelPlaylistDownloadJobForUser(jobId, req.user!.id, req.user!.role);
  if (outcome.status === 'not_found') {
    res.status(404).json({error: 'Playlist download job not found'});
    return;
  }
  if (outcome.status === 'forbidden') {
    res.status(403).json({error: 'Not allowed to cancel this download job'});
    return;
  }
  res.json(outcome.job);
});

discoverRouter.get('/discover/album/:id', requireAuth, async (req: AuthRequest, res) => {
  const albumId = String(req.params.id || '').trim();
  if (!isValidDeezerId(albumId)) {
    res.status(400).json({error: 'Invalid album ID'});
    return;
  }
  try {
    const refreshParam = String(req.query.refresh || '').trim().toLowerCase();
    const forceRefresh = refreshParam === '1' || refreshParam === 'true';
    const album = await getCatalogAlbumDetail(albumId, {forceRefresh});
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.json(album);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load album details';
    console.error('[discover-album]', albumId, msg);
    res.status(msg === 'Album not found' ? 404 : 502).json({error: msg});
  }
});

discoverRouter.get('/discover/artist/:id', requireAuth, async (req: AuthRequest, res) => {
  const artistId = String(req.params.id || '').trim();
  if (!isValidDeezerId(artistId)) {
    res.status(400).json({error: 'Invalid artist ID'});
    return;
  }
  try {
    const refreshParam = String(req.query.refresh || '').trim().toLowerCase();
    const forceRefresh = refreshParam === '1' || refreshParam === 'true';
    const artist = await getCatalogArtistDetail(artistId, {forceRefresh});
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.json(artist);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load artist details';
    console.error('[discover-artist]', artistId, msg);
    res.status(msg === 'Artist not found' ? 404 : 502).json({error: msg});
  }
});

// Per-user sliding-window rate limiter for POST /api/discover/autoplay/plan (60 req/min)
const AUTOPLAY_RATE_LIMIT_MAX = 60;
const AUTOPLAY_RATE_LIMIT_WINDOW_MS = 60_000;
const autoplayRateBuckets = new Map<string, number[]>();

function checkAutoplayRateLimit(key: string): {allowed: boolean; retryAfterSec: number} {
  const now = Date.now();
  const cutoff = now - AUTOPLAY_RATE_LIMIT_WINDOW_MS;
  const prev = autoplayRateBuckets.get(key) || [];
  const active = prev.filter((ts) => ts > cutoff);
  if (active.length >= AUTOPLAY_RATE_LIMIT_MAX) {
    const oldest = active[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + AUTOPLAY_RATE_LIMIT_WINDOW_MS - now) / 1000)
    );
    autoplayRateBuckets.set(key, active);
    return {allowed: false, retryAfterSec};
  }
  active.push(now);
  autoplayRateBuckets.set(key, active);
  if (autoplayRateBuckets.size > 1000) {
    for (const [bucketKey, timestamps] of autoplayRateBuckets.entries()) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        autoplayRateBuckets.delete(bucketKey);
      }
    }
  }
  return {allowed: true, retryAfterSec: 0};
}

function parseAutoplayTrackInput(
  raw: unknown
): {ok: true; value: AutoplayContextTrackInput} | {ok: false; error: string} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {ok: false, error: 'Track entry must be an object'};
  }
  const rec = raw as Record<string, unknown>;
  const rawVideoId = typeof rec.videoId === 'string' ? rec.videoId.trim() : '';
  if (rawVideoId && !isValidYouTubeVideoId(rawVideoId)) {
    return {ok: false, error: 'Invalid YouTube video ID'};
  }

  let trackId: number | string | null = null;
  if (typeof rec.trackId === 'number') {
    if (!Number.isInteger(rec.trackId) || rec.trackId <= 0) {
      return {ok: false, error: 'Invalid trackId'};
    }
    trackId = rec.trackId;
  } else if (typeof rec.trackId === 'string' && rec.trackId.trim()) {
    const trimmedTid = rec.trackId.trim().slice(0, 64);
    if (trimmedTid.startsWith('yt-')) {
      const vid = trimmedTid.slice(3);
      if (!isValidYouTubeVideoId(vid)) {
        return {ok: false, error: 'Invalid YouTube video ID'};
      }
      trackId = trimmedTid;
    } else if (/^\d+$/.test(trimmedTid)) {
      const num = Number(trimmedTid);
      if (!Number.isSafeInteger(num) || num <= 0) {
        return {ok: false, error: 'Invalid trackId'};
      }
      trackId = num;
    } else {
      trackId = trimmedTid;
    }
  }

  const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, 200) : '';
  const artist = typeof rec.artist === 'string' ? rec.artist.trim().slice(0, 200) : '';
  const album = typeof rec.album === 'string' ? rec.album.trim().slice(0, 200) : '';
  const rawDuration = Number(rec.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.min(86400, rawDuration) : 0;

  return {
    ok: true,
    value: {
      videoId: rawVideoId || undefined,
      trackId,
      title,
      artist,
      album,
      duration,
    },
  };
}

discoverRouter.post('/discover/autoplay/plan', requireAuth, async (req: AuthRequest, res) => {
  const rateKey = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip || 'unknown'}`;
  const rate = checkAutoplayRateLimit(rateKey);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({error: 'Too many autoplay plan requests'});
    return;
  }

  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};

  // Validate seed
  const parsedSeed = parseAutoplayTrackInput(body.seed);
  if (!parsedSeed.ok) {
    res.status(400).json({error: parsedSeed.error});
    return;
  }
  const seed = parsedSeed.value;
  if (!seed.videoId && !seed.trackId && !seed.title && !seed.artist) {
    res.status(400).json({error: 'seed must include videoId, trackId, title, or artist'});
    return;
  }

  // Validate intent
  const rawIntent = body.intent === undefined ? 'autoplay' : body.intent;
  if (rawIntent !== 'autoplay' && rawIntent !== 'radio') {
    res.status(400).json({error: "intent must be 'autoplay' or 'radio'"});
    return;
  }

  // Validate context (array, max 5 entries)
  const context: AutoplayContextTrackInput[] = [];
  if (body.context !== undefined) {
    if (!Array.isArray(body.context)) {
      res.status(400).json({error: 'context must be an array'});
      return;
    }
    if (body.context.length > 20) {
      res.status(400).json({error: 'context exceeds maximum allowed size'});
      return;
    }
    for (const rawEntry of body.context.slice(-5)) {
      const parsed = parseAutoplayTrackInput(rawEntry);
      if (!parsed.ok) {
        res.status(400).json({error: parsed.error});
        return;
      }
      context.push(parsed.value);
    }
  }

  // Validate exclude (array of strings, capped at 200)
  const exclude: string[] = [];
  if (body.exclude !== undefined) {
    if (!Array.isArray(body.exclude)) {
      res.status(400).json({error: 'exclude must be an array'});
      return;
    }
    if (body.exclude.length > 200) {
      res.status(400).json({error: 'exclude exceeds maximum allowed size (200)'});
      return;
    }
    for (const rawVal of body.exclude) {
      if (typeof rawVal !== 'string') continue;
      const trimmed = rawVal.trim().slice(0, 160);
      if (trimmed) exclude.push(trimmed);
    }
  }

  // Validate limit (default 8, clamp 1..24)
  const rawLimit = body.limit === undefined ? 8 : Number(body.limit);
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    res.status(400).json({error: 'limit must be a positive number'});
    return;
  }
  const limit = Math.max(1, Math.min(24, Math.floor(rawLimit)));

  // Optional entropy for Gumbel-top-k randomization
  const entropy =
    typeof body.entropy === 'string' && body.entropy.trim()
      ? body.entropy.trim().slice(0, 128)
      : null;

  try {
    const result = await planAutoplayForUser({
      userId: req.user!.id,
      seed,
      context,
      exclude,
      intent: rawIntent,
      limit,
      entropy,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to plan autoplay queue';
    console.error('[autoplay-route]', msg);
    res.status(502).json({error: msg});
  }
});

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadsDir = path.join(getMusicDir(), 'Uploads');
    try {
      fs.mkdirSync(uploadsDir, {recursive: true});
      cb(null, uploadsDir);
    } catch (err) {
      cb(err as Error, uploadsDir);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = sanitizeNasSegment(path.basename(file.originalname, ext), 'upload');
    const uploadsDir = path.join(getMusicDir(), 'Uploads');
    let candidate = `${base}${ext}`;
    let counter = 1;
    while (fs.existsSync(path.join(uploadsDir, candidate))) {
      candidate = `${base} (${counter++})${ext}`;
    }
    cb(null, candidate);
  },
});

const audioUpload = multer({
  storage: uploadStorage,
  limits: {fileSize: 250 * 1024 * 1024, files: 25},
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio file format: ${ext}`));
    }
  },
});




downloadRouter.get("/preview-audio", requireDownloadPermission, (req, res) => { const videoUrl = String(req.query.url || "").trim(); console.log("[preview-audio] request:", videoUrl); if (!/^https?:\/\//i.test(videoUrl)) { res.status(400).json({error: "Invalid preview URL"}); return; } const {stream, cleanup} = spawnAudioPreviewStream(videoUrl); let sent = false; stream.on("data", (chunk) => { if (!sent) { sent = true; res.setHeader("Content-Type", "audio/mpeg"); res.setHeader("Cache-Control", "no-store"); } if (!res.writableEnded) res.write(chunk); }); stream.on("end", () => { cleanup(); if (!sent) { res.status(502).json({error: "Failed to stream audio preview"}); return; } if (!res.writableEnded) res.end(); }); stream.on("error", () => { cleanup(); if (!res.writableEnded) res.end(); }); req.on("close", () => cleanup()); });

downloadRouter.post('/metadata', requireAuth, async (req, res) => {
  try {
    const query = String(req.body?.query || '');
    const source = req.body?.source === 'ytmusic' ? 'ytmusic' : 'youtube';
    const preview = await fetchMetadataPreview(query, {source});
    res.json({
      ...preview,
      musicDir: getMusicDir(),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to fetch metadata',
    });
  }
});

downloadRouter.post('/peek', requireAuth, async (req, res) => {
  try {
    const target = String(req.body?.url || req.body?.videoId || '').trim();
    if (!target || (!/^https?:\/\//i.test(target) && !isValidYouTubeVideoId(target))) {
      res.status(400).json({error: 'A valid http(s) URL or YouTube videoId is required'});
      return;
    }
    const meta = await peekTrackMetadata(target);
    res.json(meta);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to peek track metadata',
    });
  }
});

// Direct NAS download endpoint: saves tagged .m4a to <music_dir>/Downloads and indexes immediately into SQLite
downloadRouter.post('/', requireDownloadPermission, async (req: AuthRequest, res) => {
  const videoId = typeof req.body?.videoId === 'string' ? req.body.videoId.trim() : '';
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const artist = typeof req.body?.artist === 'string' ? req.body.artist.trim() : '';
  const album = typeof req.body?.album === 'string' ? req.body.album.trim() : '';
  const coverUrl =
    typeof req.body?.coverUrl === 'string'
      ? req.body.coverUrl.trim()
      : typeof req.body?.thumbnail_url === 'string'
        ? req.body.thumbnail_url.trim()
        : '';
  const rawDuration = Number(req.body?.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;

  if (videoId && !isValidYouTubeVideoId(videoId)) {
    res.status(400).json({error: 'Invalid YouTube video ID'});
    return;
  }

  if (!videoId && !url && !title) {
    res.status(400).json({error: 'A videoId, url, or track title is required'});
    return;
  }

  try {
    const result = await downloadTrackToNas({
      userId: req.user!.id,
      videoId: videoId || undefined,
      url: url || undefined,
      title: title || undefined,
      artist: artist || undefined,
      album: album || undefined,
      coverUrl: coverUrl || undefined,
      duration,
    });
    res.status(result.alreadyExists ? 200 : 201).json({
      success: true,
      alreadyExists: result.alreadyExists,
      filePath: result.filePath,
      track: result.track,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to download track to NAS';
    console.error('[api/download]', artist, '-', title || videoId, msg);
    res.status(502).json({success: false, error: msg});
  }
});

downloadRouter.post('/start', requireDownloadPermission, (req: AuthRequest, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const created: DownloadJobRow[] = [];

  for (const item of items) {
    const rawUrl = typeof item?.url === 'string' ? item.url.trim() : '';
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) continue;
    const quality = normalizeDownloadQuality(item.quality ?? req.body?.quality);
    const job = enqueueDownloadJob({
      userId: req.user!.id,
      url: rawUrl,
      title: String(item.title || 'Untitled').trim(),
      artist: String(item.artist || 'Unknown Artist').trim(),
      album: String(item.album || 'Singles').trim(),
      format:
        item.format === 'opus'
          ? 'opus'
          : item.format === 'mp3'
            ? 'mp3'
            : 'm4a',
      quality,
      thumbnailUrl: String(item.thumbnail_url || item.thumbnailUrl || ''),
    });
    created.push(job);
  }

  if (created.length === 0) {
    res.status(400).json({error: 'No valid download items provided'});
    return;
  }

  res.status(201).json({jobs: created});
});

downloadRouter.get('/jobs', requireDownloadPermission, (req: AuthRequest, res) => {
  res.json({jobs: getDownloadJobs(req.user), musicDir: getMusicDir()});
});

downloadRouter.delete('/jobs/:id', requireDownloadPermission, (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({error: 'Invalid download job ID'});
    return;
  }
  const jobOwner = db.prepare('SELECT user_id FROM download_jobs WHERE id = ?').get(id) as
    | {user_id: number | null}
    | undefined;
  if (jobOwner && req.user!.role !== 'admin' && jobOwner.user_id !== req.user!.id) {
    res.status(404).json({error: 'Download job not found'});
    return;
  }
  cancelDownloadJob(id);
  db.prepare('DELETE FROM download_jobs WHERE id = ?').run(id);
  downloadEvents.emit('deleted', {id});
  res.json({ok: true});
});

downloadRouter.get('/events', requireDownloadPermission, (req: AuthRequest, res) => {
  const viewer = req.user!;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('init', {jobs: getDownloadJobs(viewer)});

  const onJob = (job: DownloadJobRow) => {
    if (viewer.role === 'admin' || job.user_id === viewer.id) send('job', job);
  };
  const onDeleted = (payload: {id: number}) => send('deleted', payload);

  downloadEvents.on('job', onJob);
  downloadEvents.on('deleted', onDeleted);

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    downloadEvents.off('job', onJob);
    downloadEvents.off('deleted', onDeleted);
  });
});

downloadRouter.post('/upload', requireDownloadPermission, (req: AuthRequest, res) => {
  audioUpload.array('files', 25)(req, res, async (err) => {
    if (err) {
      res.status(400).json({error: err instanceof Error ? err.message : 'Upload failed'});
      return;
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({error: 'No audio files uploaded'});
      return;
    }

    const musicDir = getMusicDir();
    const indexedTracks = [];
    for (const file of files) {
      try {
        const result = await indexSingleFile(file.path, musicDir);
        const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(result.id);
        if (track) indexedTracks.push(track);
        claimTrackForUser(req.user!.id, result.id);
      } catch {
        // Continue indexing remaining files
      }
    }

    res.status(201).json({
      uploadedCount: files.length,
      tracks: indexedTracks,
      destination: path.join(musicDir, 'Uploads'),
    });
  });
});
