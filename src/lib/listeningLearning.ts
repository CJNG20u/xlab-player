// Listening signal rules adapted from Soundsible's ListeningLearning (MIT, (c) 2026 Arzuparreta)
import type {RecommendationSource, TrackId} from '../types';

export type ListeningEventType =
  | 'played_30s'
  | 'generated_completed'
  | 'generated_skipped_early';

export interface ListeningTrackSnapshot {
  id: TrackId;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  youtubeUrl?: string;
  streamUrl?: string;
  queueSource?: 'autoplay' | 'radio';
  recommendation?: {source: RecommendationSource};
}

export interface ListeningEventPayload {
  track_id: string;
  video_id: string | null;
  title: string;
  artist: string;
  album: string;
  source: RecommendationSource | null;
  listened_sec: number;
}

export type ListeningEventEmitter = (
  event: ListeningEventType,
  payload: ListeningEventPayload
) => void;

const GENERATED_SOURCES = new Set<RecommendationSource>(['autoplay', 'radio', 'discover']);
const MAX_FORWARD_STEP_SEC = 3;
const PLAYED_THRESHOLD_SEC = 30;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const TOKEN_STORAGE_KEY = 'xlabplayer_token';
const LISTENING_LEARNING_STORAGE_PREFIX = 'xlabplayer_listening_learning_v1';

function extractTrackVideoId(track: ListeningTrackSnapshot): string | null {
  if (typeof track.id === 'string' && track.id.startsWith('yt-')) {
    const id = track.id.slice(3);
    if (YOUTUBE_VIDEO_ID_RE.test(id)) return id;
  }
  if (track.streamUrl) {
    const match = /\/api\/yt-stream\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(track.streamUrl);
    if (match) return match[1];
  }
  if (track.youtubeUrl) {
    try {
      const parsed = new URL(track.youtubeUrl);
      const v = parsed.searchParams.get('v');
      if (v && YOUTUBE_VIDEO_ID_RE.test(v)) return v;
      if (parsed.hostname === 'youtu.be') {
        const seg = parsed.pathname.replace(/^\//, '').split('/')[0];
        if (YOUTUBE_VIDEO_ID_RE.test(seg)) return seg;
      }
    } catch {
      // ignore invalid URL
    }
  }
  return null;
}

function resolveTrackSource(track: ListeningTrackSnapshot): RecommendationSource | null {
  if (track.recommendation?.source) return track.recommendation.source;
  if (track.queueSource === 'autoplay' || track.queueSource === 'radio') {
    return track.queueSource;
  }
  return null;
}

function resolveEffectiveDuration(track: ListeningTrackSnapshot, durationSec: number): number {
  if (Number.isFinite(durationSec) && durationSec > 0) return durationSec;
  if (typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0) {
    return track.duration;
  }
  return 0;
}

function buildEventPayload(
  track: ListeningTrackSnapshot,
  listenedSec: number
): ListeningEventPayload {
  return {
    track_id: String(track.id ?? '').slice(0, 80),
    video_id: extractTrackVideoId(track),
    title: String(track.title ?? '').trim().slice(0, 200),
    artist: String(track.artist ?? '').trim().slice(0, 200),
    album: String(track.album ?? '').trim().slice(0, 200),
    source: resolveTrackSource(track),
    listened_sec: Math.round(Math.max(0, listenedSec) * 100) / 100,
  };
}

export class ListeningLearning {
  private readonly emit: ListeningEventEmitter;
  private currentTrackKey: string | null = null;
  private lastPositionSec: number | null = null;
  private _listenedSeconds = 0;
  private emittedPlayed30s = false;
  private emittedGeneratedOutcome = false;

  constructor(emit: ListeningEventEmitter) {
    this.emit = emit;
  }

  get listenedSeconds(): number {
    return this._listenedSeconds;
  }

  reset(trackKey: string | null = null): void {
    this.currentTrackKey = trackKey;
    this.lastPositionSec = null;
    this._listenedSeconds = 0;
    this.emittedPlayed30s = false;
    this.emittedGeneratedOutcome = false;
  }

  update(
    track: ListeningTrackSnapshot | null | undefined,
    positionSec: number,
    isPlaying: boolean
  ): void {
    if (!track) {
      this.reset(null);
      return;
    }

    const trackKey = String(track.id);
    if (trackKey !== this.currentTrackKey) {
      this.reset(trackKey);
    }

    if (!Number.isFinite(positionSec) || positionSec < 0) return;

    if (this.lastPositionSec !== null && isPlaying) {
      const delta = positionSec - this.lastPositionSec;
      if (delta > 0 && delta <= MAX_FORWARD_STEP_SEC) {
        this._listenedSeconds += delta;
      }
    }
    this.lastPositionSec = positionSec;

    if (!this.emittedPlayed30s && this._listenedSeconds >= PLAYED_THRESHOLD_SEC) {
      this.emittedPlayed30s = true;
      this.emit('played_30s', buildEventPayload(track, this._listenedSeconds));
    }
  }

  complete(track: ListeningTrackSnapshot | null | undefined, durationSec: number): void {
    if (!track) return;
    const trackKey = String(track.id);
    if (trackKey !== this.currentTrackKey) {
      this.reset(trackKey);
    }

    const source = resolveTrackSource(track);
    if (!source || !GENERATED_SOURCES.has(source)) return;
    if (this.emittedGeneratedOutcome) return;

    const duration = resolveEffectiveDuration(track, durationSec);
    const threshold = Math.min(60, Math.max(12, duration * 0.6));
    if (this._listenedSeconds >= threshold) {
      this.emittedGeneratedOutcome = true;
      this.emit('generated_completed', buildEventPayload(track, this._listenedSeconds));
    }
  }

  skip(track: ListeningTrackSnapshot | null | undefined, durationSec: number): void {
    if (!track) return;
    const trackKey = String(track.id);
    if (trackKey !== this.currentTrackKey) {
      this.reset(trackKey);
    }

    const source = resolveTrackSource(track);
    if (!source || !GENERATED_SOURCES.has(source)) return;
    if (this.emittedGeneratedOutcome) return;

    const duration = resolveEffectiveDuration(track, durationSec);
    const threshold = Math.min(60, Math.max(12, duration * 0.3));
    if (this._listenedSeconds < threshold) {
      this.emittedGeneratedOutcome = true;
      this.emit('generated_skipped_early', buildEventPayload(track, this._listenedSeconds));
    }
  }
}

function getListeningPrefStorageKey(userId: number | null | undefined): string {
  return typeof userId === 'number' && Number.isInteger(userId) && userId > 0
    ? `${LISTENING_LEARNING_STORAGE_PREFIX}:user:${userId}`
    : `${LISTENING_LEARNING_STORAGE_PREFIX}:default`;
}

export function getListeningLearningEnabled(userId: number | null | undefined): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const saved = localStorage.getItem(getListeningPrefStorageKey(userId));
    if (saved === 'false' || saved === '0') return false;
    if (saved === 'true' || saved === '1') return true;
  } catch {
    // ignore storage access errors
  }
  return true;
}

export function setListeningLearningEnabled(
  userId: number | null | undefined,
  enabled: boolean
): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getListeningPrefStorageKey(userId), enabled ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
}

export function sendListeningEvent(
  event: ListeningEventType,
  payload: ListeningEventPayload
): void {
  if (typeof fetch !== 'function') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  let token: string | null = null;
  try {
    if (typeof localStorage !== 'undefined') {
      token = localStorage.getItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    token = null;
  }

  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    void fetch('/api/listening/events', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        event,
        track_id: payload.track_id,
        video_id: payload.video_id ?? '',
        title: payload.title,
        artist: payload.artist,
        album: payload.album,
        source: payload.source ?? '',
        listened_sec: payload.listened_sec,
      }),
      keepalive: true,
    }).catch(() => {
      // Listening signals are best-effort; failures stay silent
    });
  } catch {
    // Ignore synchronous fetch errors
  }
}
