import {Router} from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import {type AuthRequest, requireAuth, requireDownloadPermission} from '../auth.ts';
import {db, getMusicDir, recordPlayHistory} from '../db.ts';
import {
  getCatalogAlbumDetail,
  getCatalogArtistDetail,
  getCatalogDiscoverFeed,
  isValidDeezerId,
  searchCatalog,
} from '../catalog.ts';
import {
  cancelDownloadJob,
  downloadEvents,
  downloadTrackToNas,
  enqueueDownloadJob,
  fetchMetadataPreview,
  getDownloadJobs,
  isValidYouTubeVideoId,
  normalizeDownloadQuality,
  peekTrackMetadata,
  sanitizeNasSegment,
  spawnAudioPreviewStream,
  type DownloadJobRow,
} from '../downloader.ts';
import {AUDIO_EXTENSIONS, indexSingleFile} from '../scanner.ts';

export const downloadRouter = Router();
export const discoverRouter = Router();

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
    const result = await searchCatalog(safeQuery);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to search catalog';
    console.error('[discover-search]', safeQuery, msg);
    res.status(502).json({error: msg});
  }
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

downloadRouter.get('/jobs', requireDownloadPermission, (_req, res) => {
  res.json({jobs: getDownloadJobs(), musicDir: getMusicDir()});
});

downloadRouter.delete('/jobs/:id', requireDownloadPermission, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({error: 'Invalid download job ID'});
    return;
  }
  cancelDownloadJob(id);
  db.prepare('DELETE FROM download_jobs WHERE id = ?').run(id);
  downloadEvents.emit('deleted', {id});
  res.json({ok: true});
});

downloadRouter.get('/events', requireDownloadPermission, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('init', {jobs: getDownloadJobs()});

  const onJob = (job: DownloadJobRow) => send('job', job);
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
