import {Router} from 'express';
import {type AuthRequest, requireAuth} from '../auth.ts';
import {
  clearUserListeningEvents,
  recordListeningEvent,
  type ListeningEventName,
} from '../db.ts';
import {isValidYouTubeVideoId} from '../downloader.ts';
import {getListeningProfileForUser} from '../listeningProfile.ts';

export const listeningRouter = Router();

const ALLOWED_EVENTS = new Set<ListeningEventName>([
  'played_30s',
  'generated_completed',
  'generated_skipped_early',
]);

const ALLOWED_SOURCES = new Set<string>([
  'autoplay',
  'radio',
  'discover',
  'library',
  'search',
]);

// Per-user sliding-window rate limiter for POST /api/listening/events (60 req/min/user)
const LISTENING_RATE_LIMIT_MAX = 60;
const LISTENING_RATE_LIMIT_WINDOW_MS = 60_000;
const listeningRateBuckets = new Map<string, number[]>();

function checkListeningRateLimit(key: string): {allowed: boolean; retryAfterSec: number} {
  const now = Date.now();
  const cutoff = now - LISTENING_RATE_LIMIT_WINDOW_MS;
  const prev = listeningRateBuckets.get(key) || [];
  const active = prev.filter((ts) => ts > cutoff);
  if (active.length >= LISTENING_RATE_LIMIT_MAX) {
    const oldest = active[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + LISTENING_RATE_LIMIT_WINDOW_MS - now) / 1000)
    );
    listeningRateBuckets.set(key, active);
    return {allowed: false, retryAfterSec};
  }
  active.push(now);
  listeningRateBuckets.set(key, active);
  if (listeningRateBuckets.size > 1000) {
    for (const [bucketKey, timestamps] of listeningRateBuckets.entries()) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        listeningRateBuckets.delete(bucketKey);
      }
    }
  }
  return {allowed: true, retryAfterSec: 0};
}

listeningRouter.post('/listening/events', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const rate = checkListeningRateLimit(`user:${userId}`);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({error: 'Too many listening events'});
    return;
  }

  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  if (!body) {
    res.status(400).json({error: 'Request body must be a JSON object'});
    return;
  }

  const rawEvent = typeof body.event === 'string' ? body.event.trim() : '';
  if (!ALLOWED_EVENTS.has(rawEvent as ListeningEventName)) {
    res.status(400).json({error: 'Unsupported listening event'});
    return;
  }

  const rawSource = typeof body.source === 'string' ? body.source.trim().toLowerCase() : '';
  if (rawSource && !ALLOWED_SOURCES.has(rawSource)) {
    res.status(400).json({error: 'Invalid listening source'});
    return;
  }

  const rawVideoIdValue = body.video_id ?? body.videoId;
  let videoId = '';
  if (rawVideoIdValue !== undefined && rawVideoIdValue !== null && rawVideoIdValue !== '') {
    if (typeof rawVideoIdValue !== 'string') {
      res.status(400).json({error: 'Invalid video_id'});
      return;
    }
    const trimmedVideoId = rawVideoIdValue.trim();
    if (trimmedVideoId && !isValidYouTubeVideoId(trimmedVideoId)) {
      res.status(400).json({error: 'Invalid YouTube video_id'});
      return;
    }
    videoId = trimmedVideoId;
  }

  const rawTrackId = body.track_id ?? body.trackId;
  let trackId = '';
  if (typeof rawTrackId === 'number' && Number.isSafeInteger(rawTrackId) && rawTrackId > 0) {
    trackId = String(rawTrackId);
  } else if (typeof rawTrackId === 'string') {
    trackId = rawTrackId.trim().slice(0, 80);
  }

  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
  const artist = typeof body.artist === 'string' ? body.artist.trim().slice(0, 200) : '';
  const album = typeof body.album === 'string' ? body.album.trim().slice(0, 200) : '';

  const rawListened = body.listened_sec ?? body.listenedSec;
  let listenedSec = 0;
  if (rawListened !== undefined && rawListened !== null) {
    const parsed = Number(rawListened);
    if (!Number.isFinite(parsed) || parsed < 0) {
      res.status(400).json({error: 'Invalid listened_sec'});
      return;
    }
    listenedSec = Math.min(86400, parsed);
  }

  try {
    recordListeningEvent({
      userId,
      event: rawEvent as ListeningEventName,
      trackId,
      videoId,
      title,
      artist,
      album,
      source: rawSource,
      listenedSec,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ok: true});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to record listening event';
    console.error('[listening-events]', msg);
    res.status(500).json({error: 'Failed to record listening event'});
  }
});

listeningRouter.get('/listening/profile', requireAuth, (req: AuthRequest, res) => {
  try {
    const profile = getListeningProfileForUser(req.user!.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load listening profile';
    console.error('[listening-profile]', msg);
    res.status(500).json({error: 'Failed to load listening profile'});
  }
});

listeningRouter.delete('/listening', requireAuth, (req: AuthRequest, res) => {
  try {
    const deleted = clearUserListeningEvents(req.user!.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ok: true, deleted});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to clear listening data';
    console.error('[listening-clear]', msg);
    res.status(500).json({error: 'Failed to clear listening data'});
  }
});
