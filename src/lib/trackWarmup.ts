import type {Track} from '../types';
import {getStoredToken, getYouTubeVideoId} from './api';

export type TrackWarmthState = 'warm' | 'matched-only' | 'cold';

export interface WarmTrackTarget {
  videoId?: string;
  artist?: string;
  title?: string;
  duration?: number;
}

const BG_WARMUP_STORAGE_KEY = 'xlabplayer_bg_warmup_enabled';
const WARM_TTL_MS = 4 * 60 * 1000; // 4 minutes, matching server stream URL memo
const MATCHED_TTL_MS = 30 * 60 * 1000; // 30 minutes client memory for track->videoId match
const MAX_CACHE_ENTRIES = 600;
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const POINTER_MOVE_CANCEL_PX = 8;

const warmByVideoId = new Map<string, number>();
const warmByMetaKey = new Map<string, number>();
const inFlightWarmKeys = new Set<string>();
const matchedByMetaKey = new Map<string, {videoId: string; matchedAt: number}>();
const bgWarmupListeners = new Set<(enabled: boolean) => void>();

export function isBackgroundWarmupEnabled(): boolean {
  try {
    const raw = localStorage.getItem(BG_WARMUP_STORAGE_KEY);
    if (raw === null) return true; // default ON
    return raw !== 'false' && raw !== '0';
  } catch {
    return true;
  }
}

export function setBackgroundWarmupEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(BG_WARMUP_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage quota/privacy failures
  }
  for (const listener of bgWarmupListeners) {
    try {
      listener(enabled);
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function subscribeBackgroundWarmup(listener: (enabled: boolean) => void): () => void {
  bgWarmupListeners.add(listener);
  return () => {
    bgWarmupListeners.delete(listener);
  };
}

export function normalizeTrackWarmKey(artist?: string, title?: string): string {
  const cleanTitle = (title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!cleanTitle) return '';
  const cleanArtist = (artist || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${cleanArtist}::${cleanTitle}`;
}

function pruneMapByAge<T>(map: Map<string, T>, getTs: (v: T) => number, ttlMs: number): void {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (now - getTs(v) > ttlMs) {
      map.delete(k);
    }
  }
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function extractVideoIdFromTarget(target: WarmTrackTarget): string | null {
  const vid = typeof target.videoId === 'string' ? target.videoId.trim() : '';
  return YT_VIDEO_ID_RE.test(vid) ? vid : null;
}

export function extractVideoIdFromTrack(track: Track | null | undefined): string | null {
  return getYouTubeVideoId(track);
}

export function isVideoIdWarm(videoId: string): boolean {
  if (!YT_VIDEO_ID_RE.test(videoId)) return false;
  const ts = warmByVideoId.get(videoId);
  if (ts === undefined) return false;
  if (Date.now() - ts > WARM_TTL_MS) {
    warmByVideoId.delete(videoId);
    return false;
  }
  return true;
}

export function getMatchedVideoId(artist?: string, title?: string): string | null {
  const key = normalizeTrackWarmKey(artist, title);
  if (!key) return null;
  const entry = matchedByMetaKey.get(key);
  if (!entry) return null;
  if (Date.now() - entry.matchedAt > MATCHED_TTL_MS) {
    matchedByMetaKey.delete(key);
    return null;
  }
  return entry.videoId;
}

export function markTrackMatched(artist?: string, title?: string, videoId?: string): void {
  const vid = typeof videoId === 'string' ? videoId.trim() : '';
  if (!YT_VIDEO_ID_RE.test(vid)) return;
  const key = normalizeTrackWarmKey(artist, title);
  if (!key) return;
  matchedByMetaKey.set(key, {videoId: vid, matchedAt: Date.now()});
  if (matchedByMetaKey.size > MAX_CACHE_ENTRIES) {
    pruneMapByAge(matchedByMetaKey, (v) => v.matchedAt, MATCHED_TTL_MS);
  }
}

export function markTargetWarm(target: WarmTrackTarget): void {
  const now = Date.now();
  const vid = extractVideoIdFromTarget(target);
  if (vid) {
    warmByVideoId.set(vid, now);
    if (warmByVideoId.size > MAX_CACHE_ENTRIES) {
      pruneMapByAge(warmByVideoId, (v) => v, WARM_TTL_MS);
    }
  }
  const key = normalizeTrackWarmKey(target.artist, target.title);
  if (key) {
    warmByMetaKey.set(key, now);
    if (warmByMetaKey.size > MAX_CACHE_ENTRIES) {
      pruneMapByAge(warmByMetaKey, (v) => v, WARM_TTL_MS);
    }
    if (vid) {
      matchedByMetaKey.set(key, {videoId: vid, matchedAt: now});
    }
  }
}

export function markTrackWarm(track: Track | null | undefined): void {
  if (!track) return;
  const videoId = extractVideoIdFromTrack(track) ?? undefined;
  markTargetWarm({
    videoId,
    artist: track.artist,
    title: track.title,
    duration: track.duration,
  });
}

export function isTargetWarm(target: WarmTrackTarget): boolean {
  const vid = extractVideoIdFromTarget(target) || getMatchedVideoId(target.artist, target.title);
  if (vid && isVideoIdWarm(vid)) {
    return true;
  }
  const key = normalizeTrackWarmKey(target.artist, target.title);
  if (!key) return false;
  const ts = warmByMetaKey.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > WARM_TTL_MS) {
    warmByMetaKey.delete(key);
    return false;
  }
  return true;
}

export function getTrackWarmthState(
  track: Track | null | undefined,
  hasPrewarmedBlob = false
): TrackWarmthState {
  if (hasPrewarmedBlob) return 'warm';
  if (!track) return 'cold';
  if (!track.isYouTubeStream) {
    return 'cold';
  }
  const videoId = extractVideoIdFromTrack(track);
  if (videoId && isVideoIdWarm(videoId)) {
    return 'warm';
  }
  const matchedVid = getMatchedVideoId(track.artist, track.title);
  if (matchedVid && isVideoIdWarm(matchedVid)) {
    return 'warm';
  }
  const metaKey = normalizeTrackWarmKey(track.artist, track.title);
  if (metaKey) {
    const metaWarmTs = warmByMetaKey.get(metaKey);
    if (metaWarmTs !== undefined && Date.now() - metaWarmTs <= WARM_TTL_MS) {
      return 'warm';
    }
  }
  if (matchedVid) {
    return 'matched-only';
  }
  return 'cold';
}

export interface WarmYouTubeStreamsOptions {
  maxItems?: number;
  priority?: 'prefetch' | 'playback';
  signal?: AbortSignal;
}

export async function warmYouTubeStreams(
  items: WarmTrackTarget[],
  options: WarmYouTubeStreamsOptions = {}
): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (!isBackgroundWarmupEnabled()) return;
  if (!Array.isArray(items) || items.length === 0) return;

  const priority = options.priority ?? 'prefetch';
  const maxItems = Math.max(1, Math.min(8, options.maxItems ?? 8));

  const payload: WarmTrackTarget[] = [];
  const payloadKeys: string[] = [];
  const seenKeys = new Set<string>();

  for (const raw of items) {
    if (payload.length >= maxItems) break;
    const rawVid = extractVideoIdFromTarget(raw);
    const artist = typeof raw.artist === 'string' ? raw.artist.trim() : '';
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const duration =
      raw.duration !== undefined && Number.isFinite(Number(raw.duration))
        ? Math.max(0, Math.round(Number(raw.duration)))
        : undefined;

    const resolvedVid = rawVid || getMatchedVideoId(artist, title) || undefined;
    if (!resolvedVid && !title) continue;

    const target: WarmTrackTarget = {
      videoId: resolvedVid,
      artist: artist || undefined,
      title: title || undefined,
      duration,
    };

    if (isTargetWarm(target)) continue;

    const dedupeKey = resolvedVid ? `v:${resolvedVid}` : `m:${normalizeTrackWarmKey(artist, title)}`;
    if (!dedupeKey || seenKeys.has(dedupeKey)) continue;
    // Allow playback-priority pointer intent to promote an in-flight prefetch, otherwise deduplicate
    if (priority !== 'playback' && inFlightWarmKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    payload.push(target);
    payloadKeys.push(dedupeKey);
  }

  if (payload.length === 0) return;

  for (const key of payloadKeys) {
    inFlightWarmKeys.add(key);
  }

  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch('/api/yt-stream/prefetch', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({items: payload, priority}),
      signal: options.signal,
    });
    if (!res.ok) return;
    if (priority === 'playback') {
      const data = (await res.json().catch(() => null)) as {
        videoId?: string;
        warmed?: boolean;
      } | null;
      if (data?.warmed && payload[0]) {
        const vid = data.videoId || payload[0].videoId;
        markTargetWarm({...payload[0], videoId: vid});
      }
    } else {
      const data = (await res.json().catch(() => null)) as {accepted?: number} | null;
      if (!data || data.accepted === undefined || data.accepted > 0) {
        for (const item of payload) {
          markTargetWarm(item);
        }
      }
    }
  } catch {
    // Best-effort warming; silently ignore network/abort errors
  } finally {
    for (const key of payloadKeys) {
      inFlightWarmKeys.delete(key);
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

/**
 * Lowest-priority background track->videoId matcher for an open album/playlist.
 * Runs 1 track at a time with ~1.5s spacing, matching only (never resolves stream URLs).
 * Stops immediately on abort, offline, disabled setting, or server backoff/rate-limit.
 */
export async function runBackgroundTrackMatcher(
  tracks: WarmTrackTarget[],
  signal: AbortSignal,
  spacingMs = 1500
): Promise<void> {
  if (signal.aborted) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (!isBackgroundWarmupEnabled()) return;

  const unmatched: Array<{artist: string; title: string; duration?: number}> = [];
  const seen = new Set<string>();

  for (const t of tracks) {
    if (extractVideoIdFromTarget(t)) continue;
    const artist = (t.artist || '').trim();
    const title = (t.title || '').trim();
    if (!title) continue;
    const key = normalizeTrackWarmKey(artist, title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (getMatchedVideoId(artist, title)) continue;
    if (isTargetWarm({artist, title})) continue;
    unmatched.push({artist, title, duration: t.duration});
  }

  if (unmatched.length === 0) return;

  // Initial delay so first-3 warm-up and initial render settle before low-priority matching starts
  const ready = await abortableDelay(spacingMs, signal);
  if (!ready) return;

  for (let i = 0; i < unmatched.length; i++) {
    if (signal.aborted) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!isBackgroundWarmupEnabled()) return;

    const item = unmatched[i];
    if (getMatchedVideoId(item.artist, item.title) || isTargetWarm(item)) {
      continue;
    }

    const headers: Record<string, string> = {'Content-Type': 'application/json'};
    const token = getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch('/api/yt-stream/resolve', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          artist: item.artist,
          title: item.title,
          duration: item.duration,
          priority: 'low',
        }),
        signal,
      });

      if (res.status === 429 || res.status === 503) {
        // Rate-limited or server backing off: stop background matching for this view
        return;
      }

      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          videoId?: string;
          skipped?: boolean;
          reason?: string;
        } | null;
        if (data?.skipped) {
          // Circuit open or resolver busy: pause longer then retry next or exit on backoff
          if (data.reason === 'circuit_open' || data.reason === 'backoff') {
            return;
          }
          const ok = await abortableDelay(spacingMs * 2, signal);
          if (!ok) return;
          continue;
        }
        if (data?.videoId) {
          markTrackMatched(item.artist, item.title, data.videoId);
        }
      }
    } catch {
      if (signal.aborted) return;
    }

    if (i < unmatched.length - 1) {
      const ok = await abortableDelay(spacingMs, signal);
      if (!ok) return;
    }
  }
}

export interface RowWarmIntentController {
  start: (
    target: WarmTrackTarget,
    coords: {clientX: number; clientY: number},
    eventTarget?: EventTarget | null
  ) => void;
  cancel: () => void;
}

/**
 * Starts a playback-priority match+resolve on pointerdown/touchstart and aborts it
 * immediately if the pointer moves beyond a small scroll threshold or is cancelled.
 */
export function createRowWarmIntentController(): RowWarmIntentController {
  let activeAbort: AbortController | null = null;
  let cleanupListeners: (() => void) | null = null;
  let lastStartTs = 0;

  const cancel = () => {
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
  };

  const start = (
    target: WarmTrackTarget,
    coords: {clientX: number; clientY: number},
    eventTarget?: EventTarget | null
  ) => {
    if (typeof window === 'undefined') return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (!isBackgroundWarmupEnabled()) return;

    // Deduplicate pointerdown + touchstart fired for the same touch
    const now = Date.now();
    if (now - lastStartTs < 80 && activeAbort) return;

    // Ignore presses on secondary buttons/inputs (e.g. Download / Add to Queue / Checkbox)
    if (eventTarget && eventTarget instanceof Element) {
      const interactive = eventTarget.closest('button, input, a, select, textarea');
      if (interactive && interactive.getAttribute('data-warm-play') !== 'true') {
        return;
      }
    }

    if (isTargetWarm(target)) return;

    cancel();
    lastStartTs = now;

    const startX = coords.clientX;
    const startY = coords.clientY;
    const controller = new AbortController();
    activeAbort = controller;

    const detach = () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('touchend', onRelease, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('touchcancel', onCancel, true);
      cleanupListeners = null;
    };

    const abortNow = () => {
      detach();
      if (activeAbort === controller) {
        activeAbort = null;
      }
      controller.abort();
    };

    const onPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > POINTER_MOVE_CANCEL_PX) {
        abortNow();
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.hypot(dx, dy) > POINTER_MOVE_CANCEL_PX) {
        abortNow();
      }
    };

    const onCancel = () => {
      abortNow();
    };

    const onRelease = () => {
      // User completed a tap without scrolling; let the playback-priority warm request finish
      detach();
    };

    window.addEventListener('pointermove', onPointerMove, {capture: true, passive: true});
    window.addEventListener('touchmove', onTouchMove, {capture: true, passive: true});
    window.addEventListener('pointerup', onRelease, {capture: true, passive: true});
    window.addEventListener('touchend', onRelease, {capture: true, passive: true});
    window.addEventListener('pointercancel', onCancel, {capture: true, passive: true});
    window.addEventListener('touchcancel', onCancel, {capture: true, passive: true});
    cleanupListeners = detach;

    void warmYouTubeStreams([target], {
      maxItems: 1,
      priority: 'playback',
      signal: controller.signal,
    }).finally(() => {
      if (activeAbort === controller) {
        activeAbort = null;
      }
    });
  };

  return {start, cancel};
}
