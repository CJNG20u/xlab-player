import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {
  apiFetch,
  appendLocalPlayHistory,
  getLocalPlayHistory,
  getStoredToken,
  getStreamUrl,
  getTrackCoverUrl,
  getTrackStreamUrl,
  getYouTubeVideoId,
  prefetchVideoIds,
  prefetchYouTubeStreams,
  recordPlaybackHistory,
} from '../lib/api';
import {
  getCachedCanvasArtwork,
  getImmediateTrackMediaArtwork,
  getTrackArtworkCacheKey,
  resolveGuaranteedMediaArtwork,
  trackHasRealArtwork,
} from '../lib/mediaSessionArtwork';
import type {PlayHistoryEntry, RepeatMode, Track, TrackId} from '../types';
import {
  getCachedTrackIds,
  getOfflineAudioBlob,
  getOfflineTracks,
  removeOfflineTrack,
  subscribeOfflineStore,
} from '../utils/offlineStore';

interface PlayerContextValue {
  currentTrack: Track | null;
  lastPlayed: PlayHistoryEntry | null;
  queue: Track[];
  currentIndex: number;
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  queueOpen: boolean;
  lyricsOpen: boolean;
  playTrack: (track: Track, list?: Track[]) => void;
  playTrackById: (trackId: number) => Promise<void>;
  togglePlay: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  seek: (time: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  addToQueue: (track: Track) => void;
  addManyToQueue: (tracks: Track[]) => void;
  playNextInQueue: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  clearUpcomingQueue: () => void;
  handleDeletedTracks: (deletedIds: number[]) => void;
  toggleLikeTrack: (trackId: TrackId) => Promise<boolean | null>;
  setQueueOpen: (open: boolean) => void;
  setLyricsOpen: (open: boolean) => void;
  syncTrackLikeState: (trackId: TrackId, liked: boolean) => void;
  libraryRefreshVersion: number;
  bumpLibraryRefresh: () => void;
  recentlyDownloadedTracks: Track[];
  saveYouTubeTrackToLibrary: (
    track: Track,
    format?: 'm4a' | 'opus'
  ) => Promise<{ok: boolean; message: string; track?: Track}>;
  getYouTubeSaveStatus: (trackId: TrackId) => 'idle' | 'saving' | 'saved';
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

// Module-level singleton HTMLAudioElement: never recreated or unmounted between songs or routes,
// preserving iOS Safari & Android Chrome background/lock-screen audio session permission.
let persistentAudioElement: HTMLAudioElement | null = null;
let persistentAudioUnlocked = false;

// Minimal valid 44-byte silent PCM WAV used to unlock the persistent <audio> element synchronously
// during the user's very first play gesture whenever the first track requires async resolution.
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

// Next-track preload thresholds & memory caps for mobile devices
const PREFETCH_PROGRESS_THRESHOLD = 0.5;
const PREFETCH_REMAINING_SECONDS = 15;
const MAX_FULL_PREFETCH_BYTES = 25 * 1024 * 1024; // 25 MB full blob prefetch cap
const PARTIAL_PREFETCH_BYTES = 2 * 1024 * 1024; // 2 MB Range warm-up for large FLAC files

function getPersistentAudioElement(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  if (!persistentAudioElement) {
    const audio = document.createElement('audio');
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.setAttribute('x-webkit-airplay', 'allow');
    audio.preload = 'auto';
    audio.style.display = 'none';
    if (document.body) {
      document.body.appendChild(audio);
    }
    persistentAudioElement = audio;
  } else if (document.body && !persistentAudioElement.isConnected) {
    document.body.appendChild(persistentAudioElement);
  }
  return persistentAudioElement;
}

function unlockPersistentAudioElement(
  audio: HTMLAudioElement | null,
  primeWithSilentAudio = false
): void {
  if (!audio || persistentAudioUnlocked) return;
  persistentAudioUnlocked = true;

  if (primeWithSilentAudio && !audio.getAttribute('src')) {
    try {
      audio.src = SILENT_WAV_DATA_URI;
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // Ignore AbortError when real track src immediately replaces the silent primer
        });
      }
    } catch {
      // Ignore unlock priming errors
    }
  }
}

function getTrackMetadataKey(track: Track): string {
  return `${track.title || ''}|${track.artist || ''}|${track.album || ''}|${getTrackArtworkCacheKey(track)}`;
}

export const PlayerProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current) {
    audioRef.current = getPersistentAudioElement();
  }

  const [queue, setQueue] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('xlabplayer_volume');
      if (saved !== null) {
        const parsed = parseFloat(saved);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
      }
    } catch {
      // ignore
    }
    return 0.85;
  });
  const [isMuted, setIsMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [queueOpen, setQueueOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [libraryRefreshVersion, setLibraryRefreshVersion] = useState(0);
  const [offlineStoreVersion, setOfflineStoreVersion] = useState(0);
  const [youtubeSaveStates, setYoutubeSaveStates] = useState<
    Record<string, 'saving' | 'saved'>
  >({});
  const [recentlyDownloadedTracks, setRecentlyDownloadedTracks] = useState<Track[]>([]);
  const [lastPlayed, setLastPlayed] = useState<PlayHistoryEntry | null>(
    () => getLocalPlayHistory()[0] ?? null
  );

  const currentTrack =
    currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  // Synchronous state refs so native audio / MediaSession callbacks never read stale state
  const stateRef = useRef({queue, currentIndex, shuffle, repeat, currentTrack, isPlaying, duration});
  stateRef.current = {queue, currentIndex, shuffle, repeat, currentTrack, isPlaying, duration};

  // Playback intent, user-pause tracking, lock-screen recovery & offline ObjectURL pre-warming refs
  const wantPlayingRef = useRef(false);
  const userPausedRef = useRef(false);
  const lastUnexpectedPauseAtRef = useRef(0);
  const lockAutoResumeAttemptsRef = useRef(0);
  const visibilityResumeTimersRef = useRef<number[]>([]);
  const transitioningTrackRef = useRef(false);
  const transitionTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryAttemptsRef = useRef(0);
  const lastMetadataKeyRef = useRef<string | null>(null);
  const lastMetadataArtworkModeRef = useRef<'none' | 'url' | 'canvas'>('none');
  const artworkResolutionAttemptedKeyRef = useRef<string | null>(null);
  const metadataArtworkReqIdRef = useRef(0);
  const cachedTrackIdsRef = useRef<Set<number>>(new Set());
  const prewarmedObjectUrlsRef = useRef<Map<number, string>>(new Map());
  const prefetchedObjectUrlsRef = useRef<Map<number, string>>(new Map());
  const prefetchedTrackIdsRef = useRef<Set<number>>(new Set());
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const prefetchInFlightIdRef = useRef<number | null>(null);
  const loadRequestIdRef = useRef(0);
  const lastRecordedPlayRef = useRef<{key: string; at: number} | null>(null);

  const recordTrackPlay = useCallback((track: Track) => {
    const title = (track.title || '').trim();
    const artist = (track.artist || '').trim();
    if (!title && !artist) return;

    const now = Date.now();
    const playKey = `${String(track.id)}::${artist.toLowerCase()}::${title.toLowerCase()}`;
    const prev = lastRecordedPlayRef.current;
    if (prev && prev.key === playKey && now - prev.at < 4000) {
      return;
    }
    lastRecordedPlayRef.current = {key: playKey, at: now};

    const entry: PlayHistoryEntry = {
      title,
      artist,
      trackId: !track.isYouTubeStream && typeof track.id === 'number' ? track.id : null,
      videoId: getYouTubeVideoId(track) || undefined,
      playedAt: now,
    };

    appendLocalPlayHistory(entry);
    setLastPlayed(entry);
    recordPlaybackHistory(entry);
  }, []);

  const clearVisibilityResumeTimers = useCallback(() => {
    if (visibilityResumeTimersRef.current.length > 0) {
      for (const timerId of visibilityResumeTimersRef.current) {
        window.clearTimeout(timerId);
      }
      visibilityResumeTimersRef.current = [];
    }
  }, []);

  const bumpLibraryRefresh = useCallback(() => {
    setLibraryRefreshVersion((v) => v + 1);
  }, []);

  // Keep cachedTrackIdsRef synchronized with offlineStore so playback can decide
  // immediately whether to load from Cache Storage ('xlabplayer-audio-v1')
  useEffect(() => {
    let active = true;
    const syncCachedIds = async () => {
      const ids = await getCachedTrackIds();
      if (!active) return;
      cachedTrackIdsRef.current = ids;

      // Revoke any prewarmed ObjectURL whose track was evicted from offline storage
      const activeAudioSrc = audioRef.current?.getAttribute('src') || '';
      for (const [trackId, blobUrl] of prewarmedObjectUrlsRef.current.entries()) {
        if (!ids.has(trackId) && blobUrl !== activeAudioSrc) {
          URL.revokeObjectURL(blobUrl);
          prewarmedObjectUrlsRef.current.delete(trackId);
        }
      }
      setOfflineStoreVersion((v) => v + 1);
    };

    void syncCachedIds();
    const unsub = subscribeOfflineStore(() => {
      void syncCachedIds();
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  // Pre-warm ObjectURLs for current + adjacent cached tracks so lock-screen `ended` / `nexttrack`
  // transitions assign `audio.src = blobUrl` and invoke `audio.play()` 100% synchronously on iOS/Android
  useEffect(() => {
    let cancelled = false;
    const keepIds = new Set<number>();
    const addIfLocal = (t: Track | undefined) => {
      if (t && !t.isYouTubeStream && typeof t.id === 'number') {
        keepIds.add(t.id);
      }
    };

    if (currentIndex >= 0 && currentIndex < queue.length) {
      addIfLocal(queue[currentIndex]);
      if (currentIndex + 1 < queue.length) {
        addIfLocal(queue[currentIndex + 1]);
      } else if (repeat === 'all' && queue.length > 0) {
        addIfLocal(queue[0]);
      }
      if (currentIndex - 1 >= 0) {
        addIfLocal(queue[currentIndex - 1]);
      }
    }

    const activeAudioSrc = audioRef.current?.getAttribute('src') || '';
    for (const [trackId, blobUrl] of prewarmedObjectUrlsRef.current.entries()) {
      if (!keepIds.has(trackId) && blobUrl !== activeAudioSrc) {
        URL.revokeObjectURL(blobUrl);
        prewarmedObjectUrlsRef.current.delete(trackId);
      }
    }

    // Also evict stale next-track prefetched ObjectURLs outside the active/adjacent window
    for (const [trackId, blobUrl] of prefetchedObjectUrlsRef.current.entries()) {
      if (!keepIds.has(trackId) && blobUrl !== activeAudioSrc) {
        URL.revokeObjectURL(blobUrl);
        prefetchedObjectUrlsRef.current.delete(trackId);
      }
    }
    for (const trackId of Array.from(prefetchedTrackIdsRef.current)) {
      if (!keepIds.has(trackId)) {
        prefetchedTrackIdsRef.current.delete(trackId);
      }
    }
    if (
      prefetchInFlightIdRef.current !== null &&
      !keepIds.has(prefetchInFlightIdRef.current)
    ) {
      prefetchAbortRef.current?.abort();
      prefetchAbortRef.current = null;
      prefetchInFlightIdRef.current = null;
    }

    for (const trackId of keepIds) {
      if (
        cachedTrackIdsRef.current.has(trackId) &&
        !prewarmedObjectUrlsRef.current.has(trackId)
      ) {
        void getOfflineAudioBlob(trackId).then((blob) => {
          if (cancelled || !blob) return;
          if (!prewarmedObjectUrlsRef.current.has(trackId)) {
            prewarmedObjectUrlsRef.current.set(trackId, URL.createObjectURL(blob));
          }
        });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [queue, currentIndex, repeat, offlineStoreVersion]);

  // Immediately prefetch the next 1-2 queued online tracks when a track starts playing
  // so ad-gate polling and disk cache warm-up complete before auto-advance or Skip.
  const lastPrefetchedStreamKeyRef = useRef<string>('');
  useEffect(() => {
    if (!currentTrack || currentIndex < 0 || queue.length <= 1) return;
    if (repeat === 'one' || shuffle) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const upcomingOnline: Track[] = [];
    const seenTrackKeys = new Set<string>([String(currentTrack.id)]);
    for (let offset = 1; offset <= 2; offset += 1) {
      let candidateIdx = currentIndex + offset;
      if (candidateIdx >= queue.length) {
        if (repeat === 'all') {
          candidateIdx = candidateIdx % queue.length;
        } else {
          break;
        }
      }
      if (candidateIdx === currentIndex) break;
      const item = queue[candidateIdx];
      if (!item || !item.isYouTubeStream) continue;
      const key = String(item.id);
      if (seenTrackKeys.has(key)) continue;
      seenTrackKeys.add(key);
      upcomingOnline.push(item);
    }

    if (upcomingOnline.length === 0) return;

    const directVideoIds: string[] = [];
    const metadataTargets: Array<{artist: string; title: string; duration?: number}> = [];
    const sigParts: string[] = [];

    for (const item of upcomingOnline) {
      const vid = getYouTubeVideoId(item);
      if (vid) {
        directVideoIds.push(vid);
        sigParts.push(`vid:${vid}`);
      } else if (item.title?.trim()) {
        metadataTargets.push({
          artist: item.artist,
          title: item.title,
          duration: item.duration,
        });
        sigParts.push(`meta:${item.artist}::${item.title}`);
      }
    }

    if (sigParts.length === 0) return;
    const dedupKey = `${String(currentTrack.id)}=>${sigParts.join('|')}`;
    if (lastPrefetchedStreamKeyRef.current === dedupKey) return;
    lastPrefetchedStreamKeyRef.current = dedupKey;

    if (directVideoIds.length > 0) {
      prefetchVideoIds(directVideoIds, true);
    }
    if (metadataTargets.length > 0) {
      prefetchYouTubeStreams(metadataTargets);
    }
  }, [currentTrack, currentIndex, queue, repeat, shuffle]);

  // Silently prefetch the next track in the queue once the current track reaches 50% playback
  // or <= 15 seconds remaining so auto-advance and album-cover swipes start without buffering.
  const prefetchNextTrackIfReady = useCallback((pos: number, dur: number) => {
    if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(pos) || pos < 0) return;

    const reachedHalfway = pos / dur >= PREFETCH_PROGRESS_THRESHOLD;
    const withinRemainingWindow = dur - pos <= PREFETCH_REMAINING_SECONDS;
    if (!reachedHalfway && !withinRemainingWindow) return;

    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const {queue: q, currentIndex: idx, repeat: rep, shuffle: isShuf} = stateRef.current;
    if (rep === 'one' || isShuf || q.length === 0 || idx < 0) return;

    let nextItem: Track | null = null;
    if (idx + 1 < q.length) {
      nextItem = q[idx + 1];
    } else if (rep === 'all' && q.length > 1) {
      nextItem = q[0];
    }

    if (!nextItem) return;

    // Warm the next track's cover image & 512x512 MediaSession canvas artwork for instant lock-screen transitions
    const nextCoverUrl = getTrackCoverUrl(nextItem);
    if (nextCoverUrl && typeof Image !== 'undefined') {
      const preloadImg = new Image();
      preloadImg.decoding = 'async';
      preloadImg.src = nextCoverUrl;
    }
    if (trackHasRealArtwork(nextItem) && !getCachedCanvasArtwork(nextItem)) {
      void resolveGuaranteedMediaArtwork(nextItem);
    }

    // Skip full-blob audio prefetching for streamed YouTube tracks (handled by server URL cache)
    if (nextItem.isYouTubeStream || typeof nextItem.id !== 'number') {
      return;
    }

    const nextId = nextItem.id;
    if (
      cachedTrackIdsRef.current.has(nextId) ||
      prewarmedObjectUrlsRef.current.has(nextId) ||
      prefetchedObjectUrlsRef.current.has(nextId) ||
      prefetchedTrackIdsRef.current.has(nextId) ||
      prefetchInFlightIdRef.current === nextId
    ) {
      return;
    }

    // Abort any obsolete prefetch targeting a different track
    if (prefetchAbortRef.current) {
      prefetchAbortRef.current.abort();
      prefetchAbortRef.current = null;
    }

    const controller = new AbortController();
    prefetchAbortRef.current = controller;
    prefetchInFlightIdRef.current = nextId;

    const streamUrl = getStreamUrl(nextId);
    const token = getStoredToken();
    const headers = new Headers();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const canPrefetchFullBlob =
      typeof nextItem.size_bytes === 'number' &&
      nextItem.size_bytes > 0 &&
      nextItem.size_bytes <= MAX_FULL_PREFETCH_BYTES;

    if (!canPrefetchFullBlob) {
      // For large lossless FLACs (>25 MB), warm the opening 2 MB chunk via Range request
      // to keep mobile RAM low while priming HTTP cache & NAS read-ahead.
      headers.set('Range', `bytes=0-${PARTIAL_PREFETCH_BYTES - 1}`);
    }

    const fetchInit = {
      method: 'GET',
      headers,
      credentials: 'include',
      signal: controller.signal,
      priority: 'low',
    } as RequestInit;

    void fetch(streamUrl, fetchInit)
      .then(async (res) => {
        if (!res.ok || controller.signal.aborted) return;

        if (canPrefetchFullBlob) {
          const contentLenHeader = res.headers.get('content-length');
          const contentLen = contentLenHeader ? parseInt(contentLenHeader, 10) : 0;
          if (contentLen > MAX_FULL_PREFETCH_BYTES) return;

          const blob = await res.blob();
          if (controller.signal.aborted || blob.size === 0) return;

          if (!prefetchedObjectUrlsRef.current.has(nextId)) {
            prefetchedObjectUrlsRef.current.set(nextId, URL.createObjectURL(blob));
          }
          prefetchedTrackIdsRef.current.add(nextId);
        } else {
          // Consume the opening 2 MB Range chunk so the browser/proxy caches it cleanly
          await res.arrayBuffer();
          if (!controller.signal.aborted) {
            prefetchedTrackIdsRef.current.add(nextId);
          }
        }
      })
      .catch(() => {
        // Ignore AbortError or transient mobile background fetch errors
      })
      .finally(() => {
        if (prefetchInFlightIdRef.current === nextId) {
          prefetchInFlightIdRef.current = null;
        }
        if (prefetchAbortRef.current === controller) {
          prefetchAbortRef.current = null;
        }
      });
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const beginTrackTransition = useCallback(() => {
    transitioningTrackRef.current = true;
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    // Safety guard so transient track-switch pause suppression can never get stuck
    transitionTimerRef.current = window.setTimeout(() => {
      transitioningTrackRef.current = false;
      transitionTimerRef.current = null;
    }, 1500);
  }, []);

  const endTrackTransition = useCallback(() => {
    transitioningTrackRef.current = false;
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  }, []);

  const setMediaSessionPlaybackState = useCallback((state: MediaSessionPlaybackState) => {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // Ignore unsupported playbackState updates
    }
  }, []);

  const syncMediaSessionMetadata = useCallback((track: Track | null, force = false) => {
    if (!('mediaSession' in navigator)) return;

    if (!track) {
      lastMetadataKeyRef.current = null;
      lastMetadataArtworkModeRef.current = 'none';
      artworkResolutionAttemptedKeyRef.current = null;
      metadataArtworkReqIdRef.current += 1;
      try {
        navigator.mediaSession.metadata = null;
      } catch {
        // ignore
      }
      return;
    }

    const key = getTrackMetadataKey(track);
    const cachedCanvasArtwork = getCachedCanvasArtwork(track);
    const hasRealArt = trackHasRealArtwork(track);
    const sameTrackAlreadyApplied =
      lastMetadataKeyRef.current === key && Boolean(navigator.mediaSession.metadata);

    if (
      !force &&
      sameTrackAlreadyApplied &&
      (lastMetadataArtworkModeRef.current === 'canvas' || !cachedCanvasArtwork)
    ) {
      return;
    }

    const immediateArtwork = cachedCanvasArtwork ?? getImmediateTrackMediaArtwork(track);

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Unknown Title',
        artist: track.artist || 'Unknown Artist',
        album: track.album || '',
        artwork: immediateArtwork,
      });
      lastMetadataKeyRef.current = key;
      lastMetadataArtworkModeRef.current = cachedCanvasArtwork ? 'canvas' : 'url';
    } catch {
      // Ignore MediaMetadata errors on unsupported environments
    }

    // Asynchronously bake a guaranteed 512x512 & 256x256 JPEG canvas data URI (covering local
    // library tracks behind mTLS/auth, offline IndexedDB covers, and Discover/YouTube streams)
    // once per track and upgrade MediaMetadata without ever reverting to the default app logo.
    if (hasRealArt && !cachedCanvasArtwork && artworkResolutionAttemptedKeyRef.current !== key) {
      artworkResolutionAttemptedKeyRef.current = key;
      const reqId = ++metadataArtworkReqIdRef.current;
      void resolveGuaranteedMediaArtwork(track).then((canvasArtwork) => {
        if (!canvasArtwork || canvasArtwork.length === 0) return;
        if (metadataArtworkReqIdRef.current !== reqId) return;
        const activeTrack = stateRef.current.currentTrack;
        if (!activeTrack || getTrackMetadataKey(activeTrack) !== key) return;
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: activeTrack.title || 'Unknown Title',
            artist: activeTrack.artist || 'Unknown Artist',
            album: activeTrack.album || '',
            artwork: canvasArtwork,
          });
          lastMetadataKeyRef.current = key;
          lastMetadataArtworkModeRef.current = 'canvas';
        } catch {
          // Ignore MediaMetadata errors on unsupported environments
        }
      });
    }
  }, []);

  const syncMediaSessionPositionState = useCallback((audio: HTMLAudioElement | null) => {
    if (
      !audio ||
      !('mediaSession' in navigator) ||
      typeof navigator.mediaSession.setPositionState !== 'function'
    ) {
      return;
    }
    const rawAudioDuration = audio.duration;
    const fallbackDuration =
      stateRef.current.currentTrack?.duration || stateRef.current.duration || 0;
    const resolvedDuration =
      Number.isFinite(rawAudioDuration) && rawAudioDuration > 0
        ? rawAudioDuration
        : Number.isFinite(fallbackDuration) && fallbackDuration > 0
          ? fallbackDuration
          : 0;
    if (resolvedDuration <= 0) return;

    const rawRate = audio.playbackRate;
    const playbackRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
    const rawPos = audio.currentTime;
    const position = Number.isFinite(rawPos)
      ? Math.max(0, Math.min(rawPos, resolvedDuration))
      : 0;

    try {
      navigator.mediaSession.setPositionState({
        duration: resolvedDuration,
        playbackRate,
        position,
      });
    } catch {
      // Ignore transient MediaSession position errors
    }
  }, []);

  // Forward-declared ref for stable MediaSession action handlers so they can be registered
  // synchronously on playback start AND kept stable across renders without tearing down listeners.
  const mediaActionsRef = useRef<{
    play: () => void;
    pause: () => void;
    prevTrack: () => void;
    nextTrack: () => void;
    seek: (time: number, fastSeek?: boolean) => void;
  }>({
    play: () => {},
    pause: () => {},
    prevTrack: () => {},
    nextTrack: () => {},
    seek: () => {},
  });

  const registerMediaSessionHandlers = useCallback(() => {
    if (!('mediaSession' in navigator)) return;

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => mediaActionsRef.current.play()],
      ['pause', () => mediaActionsRef.current.pause()],
      ['previoustrack', () => mediaActionsRef.current.prevTrack()],
      ['nexttrack', () => mediaActionsRef.current.nextTrack()],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') {
            mediaActionsRef.current.seek(details.seekTime, Boolean(details.fastSeek));
          }
        },
      ],
      [
        'seekbackward',
        (details) => {
          const offset = details.seekOffset || 10;
          mediaActionsRef.current.seek((audioRef.current?.currentTime || 0) - offset);
        },
      ],
      [
        'seekforward',
        (details) => {
          const offset = details.seekOffset || 10;
          mediaActionsRef.current.seek((audioRef.current?.currentTime || 0) + offset);
        },
      ],
    ];

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Ignore unsupported MediaSession action handlers on older browsers
      }
    }
  }, []);

  // Immediately activate MediaSession metadata, action handlers, and 'playing' state
  const activateMediaSessionForPlayback = useCallback(
    (track: Track | null, forceMetadata = false) => {
      registerMediaSessionHandlers();
      syncMediaSessionMetadata(track, forceMetadata);
      setMediaSessionPlaybackState('playing');
    },
    [registerMediaSessionHandlers, setMediaSessionPlaybackState, syncMediaSessionMetadata]
  );

  // Synchronously assign audio.src and call audio.play() on the persistent HTMLAudioElement
  // without awaiting React state updates or network calls (critical for iOS/Android lock-screen continuity).
  // If a track is cached in Cache Storage ('xlabplayer-audio-v1'), load from its ObjectURL so
  // playback and scrubbing work instantly in Airplane Mode without hitting the network or mTLS proxy.
  const loadAndPlayTrackSync = useCallback(
    (track: Track, options: {resetIfSame?: boolean} = {}) => {
      const audio = audioRef.current ?? getPersistentAudioElement();
      if (!audio) return;
      audioRef.current = audio;

      const reqId = ++loadRequestIdRef.current;
      const isSameLoadedTrack =
        audio.dataset.trackId === String(track.id) &&
        Boolean(audio.getAttribute('src')) &&
        audio.getAttribute('src') !== SILENT_WAV_DATA_URI;

      userPausedRef.current = false;
      wantPlayingRef.current = true;
      lockAutoResumeAttemptsRef.current = 0;
      stateRef.current.isPlaying = true;
      stateRef.current.currentTrack = track;
      clearRecoveryTimer();
      clearVisibilityResumeTimers();
      recoveryAttemptsRef.current = 0;

      // Immediately register MediaSession handlers, metadata & playbackState = 'playing'
      activateMediaSessionForPlayback(track, true);

      const invokePlay = () => {
        unlockPersistentAudioElement(audio, false);
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err: unknown) => {
            // Ignore AbortError caused by rapid track switching
            if (err instanceof DOMException && err.name === 'AbortError') return;
            endTrackTransition();
            wantPlayingRef.current = false;
            stateRef.current.isPlaying = false;
            setIsPlaying(false);
            setIsBuffering(false);
            setMediaSessionPlaybackState('paused');
          });
        }
      };

      if (isSameLoadedTrack) {
        if (options.resetIfSame) {
          audio.currentTime = 0;
        }
        invokePlay();
      } else {
        const localTrackId =
          !track.isYouTubeStream && typeof track.id === 'number' ? track.id : null;
        const prewarmedBlobUrl =
          localTrackId !== null
            ? (prewarmedObjectUrlsRef.current.get(localTrackId) ??
              prefetchedObjectUrlsRef.current.get(localTrackId))
            : undefined;
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        const shouldUseOfflineCache =
          localTrackId !== null &&
          (Boolean(prewarmedBlobUrl) || cachedTrackIdsRef.current.has(localTrackId) || isOffline);

        beginTrackTransition();
        audio.dataset.trackId = String(track.id);

        if (prewarmedBlobUrl) {
          // Synchronous ObjectURL assignment from pre-warmed offline cache or next-track prefetch
          audio.src = prewarmedBlobUrl;
          invokePlay();
        } else if (shouldUseOfflineCache && localTrackId !== null) {
          // Synchronously unlock persistent <audio> inside the user's very first play click gesture
          // before awaiting Cache Storage so iOS Safari retains background audio permission.
          unlockPersistentAudioElement(audio, true);

          // Load blob directly from Cache Storage (`xlabplayer-audio-v1`) -> ObjectURL
          setIsBuffering(true);
          void getOfflineAudioBlob(localTrackId).then((blob) => {
            if (loadRequestIdRef.current !== reqId) return;
            if (blob) {
              let blobUrl = prewarmedObjectUrlsRef.current.get(localTrackId);
              if (!blobUrl) {
                blobUrl = URL.createObjectURL(blob);
                prewarmedObjectUrlsRef.current.set(localTrackId, blobUrl);
              }
              beginTrackTransition();
              audio.src = blobUrl;
              invokePlay();
              return;
            }

            // Not present in Cache Storage: fall back to network only if online
            if (typeof navigator === 'undefined' || navigator.onLine) {
              beginTrackTransition();
              audio.src = getTrackStreamUrl(track);
              invokePlay();
            } else {
              endTrackTransition();
              wantPlayingRef.current = false;
              stateRef.current.isPlaying = false;
              setIsPlaying(false);
              setIsBuffering(false);
              setMediaSessionPlaybackState('paused');
            }
          });
        } else {
          if (track.isYouTubeStream) {
            setIsBuffering(true);
          }
          audio.src = getTrackStreamUrl(track);
          invokePlay();
        }
      }

      if (!isSameLoadedTrack || options.resetIfSame) {
        recordTrackPlay(track);
      }

      setIsPlaying(true);
      setCurrentTime(0);
      setDuration(track.duration || 0);
    },
    [
      activateMediaSessionForPlayback,
      beginTrackTransition,
      clearRecoveryTimer,
      clearVisibilityResumeTimers,
      endTrackTransition,
      recordTrackPlay,
      setMediaSessionPlaybackState,
    ]
  );

  // Automatic recovery across brief buffering gaps (stalled / waiting) while playing
  const scheduleBufferRecovery = useCallback(
    (reason: 'waiting' | 'stalled') => {
      if (!wantPlayingRef.current) return;
      if (recoveryTimerRef.current !== null) return;
      if (recoveryAttemptsRef.current >= 5) return;

      const attempt = recoveryAttemptsRef.current + 1;
      const delayMs = reason === 'stalled' ? 1000 * attempt : 1500 * attempt;

      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        const audio = audioRef.current;
        if (!audio || !wantPlayingRef.current || audio.ended) return;

        // Already recovered and playing smoothly
        if (!audio.paused && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          recoveryAttemptsRef.current = 0;
          setIsBuffering(false);
          return;
        }

        recoveryAttemptsRef.current = attempt;
        setMediaSessionPlaybackState('playing');

        if (audio.paused) {
          audio.play().catch(() => {});
        } else if (
          reason === 'stalled' &&
          attempt >= 2 &&
          audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA &&
          !audio.src.startsWith('blob:')
        ) {
          const track = stateRef.current.currentTrack;
          if (!track) return;
          const resumePos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
          beginTrackTransition();
          audio.src = getTrackStreamUrl(track);
          if (resumePos > 0) {
            const restorePosition = () => {
              audio.removeEventListener('loadedmetadata', restorePosition);
              if (Number.isFinite(audio.duration) && resumePos < audio.duration) {
                audio.currentTime = resumePos;
              }
            };
            audio.addEventListener('loadedmetadata', restorePosition);
          }
          audio.play().catch(() => {});
        }
      }, delayMs);
    },
    [beginTrackTransition, setMediaSessionPlaybackState]
  );

  // Fallback sync for queue mutations (e.g. removing active track, clearing queue, or adding first track)
  const currentTrackId = currentTrack?.id ?? null;
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (currentTrackId === null) {
      endTrackTransition();
      clearRecoveryTimer();
      clearVisibilityResumeTimers();
      userPausedRef.current = true;
      wantPlayingRef.current = false;
      stateRef.current.isPlaying = false;
      audio.pause();
      audio.removeAttribute('src');
      delete audio.dataset.trackId;
      audio.load();
      setIsPlaying(false);
      setIsBuffering(false);
      setCurrentTime(0);
      setDuration(0);
      syncMediaSessionMetadata(null);
      setMediaSessionPlaybackState('none');
      return;
    }

    if (audio.dataset.trackId !== String(currentTrackId) && stateRef.current.currentTrack) {
      loadAndPlayTrackSync(stateRef.current.currentTrack, {resetIfSame: false});
    }
  }, [
    clearRecoveryTimer,
    clearVisibilityResumeTimers,
    currentTrackId,
    endTrackTransition,
    loadAndPlayTrackSync,
    setMediaSessionPlaybackState,
    syncMediaSessionMetadata,
  ]);

  // Keep volume synced on the persistent audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    if (clamped > 0) setIsMuted(false);
    try {
      localStorage.setItem('xlabplayer_volume', String(clamped));
    } catch {
      // ignore
    }
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((m) => !m);
  }, []);

  const seek = useCallback(
    (time: number, fastSeek = false) => {
      const audio = audioRef.current;
      if (!audio) return;
      const maxDur =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : stateRef.current.duration || 0;
      const clamped = Math.max(0, Math.min(maxDur, time));
      if (fastSeek && typeof audio.fastSeek === 'function') {
        audio.fastSeek(clamped);
      } else {
        audio.currentTime = clamped;
      }
      setCurrentTime(clamped);
      syncMediaSessionPositionState(audio);
    },
    [syncMediaSessionPositionState]
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current ?? getPersistentAudioElement();
    const activeTrack = stateRef.current.currentTrack;
    if (!audio || !activeTrack) return;
    audioRef.current = audio;

    if (audio.paused) {
      userPausedRef.current = false;
      wantPlayingRef.current = true;
      lockAutoResumeAttemptsRef.current = 0;
      stateRef.current.isPlaying = true;
      clearVisibilityResumeTimers();
      unlockPersistentAudioElement(audio, false);
      activateMediaSessionForPlayback(activeTrack, false);
      audio
        .play()
        .then(() => {
          setIsPlaying(true);
          syncMediaSessionPositionState(audio);
        })
        .catch(() => {
          wantPlayingRef.current = false;
          stateRef.current.isPlaying = false;
          setIsPlaying(false);
          setMediaSessionPlaybackState('paused');
        });
    } else {
      endTrackTransition();
      clearRecoveryTimer();
      clearVisibilityResumeTimers();
      userPausedRef.current = true;
      wantPlayingRef.current = false;
      stateRef.current.isPlaying = false;
      audio.pause();
      setIsPlaying(false);
      setMediaSessionPlaybackState('paused');
      syncMediaSessionPositionState(audio);
    }
  }, [
    activateMediaSessionForPlayback,
    clearRecoveryTimer,
    clearVisibilityResumeTimers,
    endTrackTransition,
    setMediaSessionPlaybackState,
    syncMediaSessionPositionState,
  ]);

  // Synchronous next-track transition shared by native `ended` event, MediaSession `nexttrack`, and UI button
  const advanceToNextTrack = useCallback(
    (fromEndedEvent: boolean) => {
      const audio = audioRef.current;
      const {queue: q, currentIndex: idx, shuffle: isShuf, repeat: rep} = stateRef.current;
      if (!audio || q.length === 0) return;

      if (rep === 'one') {
        const activeTrack = q[idx] ?? stateRef.current.currentTrack;
        userPausedRef.current = false;
        wantPlayingRef.current = true;
        lockAutoResumeAttemptsRef.current = 0;
        stateRef.current.isPlaying = true;
        audio.currentTime = 0;
        activateMediaSessionForPlayback(activeTrack, false);
        audio.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          wantPlayingRef.current = false;
          stateRef.current.isPlaying = false;
          setIsPlaying(false);
          setMediaSessionPlaybackState('paused');
        });
        setCurrentTime(0);
        setIsPlaying(true);
        syncMediaSessionPositionState(audio);
        return;
      }

      let nextIdx = -1;
      if (isShuf && q.length > 1) {
        nextIdx = idx;
        while (nextIdx === idx) {
          nextIdx = Math.floor(Math.random() * q.length);
        }
      } else if (idx + 1 < q.length) {
        nextIdx = idx + 1;
      } else if (rep === 'all') {
        nextIdx = 0;
      }

      if (nextIdx < 0 || !q[nextIdx]) {
        endTrackTransition();
        clearRecoveryTimer();
        clearVisibilityResumeTimers();
        userPausedRef.current = true;
        wantPlayingRef.current = false;
        stateRef.current.isPlaying = false;
        setIsPlaying(false);
        setMediaSessionPlaybackState('paused');
        if (fromEndedEvent) {
          syncMediaSessionPositionState(audio);
        }
        return;
      }

      const nextItem = q[nextIdx];
      stateRef.current.currentIndex = nextIdx;
      stateRef.current.currentTrack = nextItem;

      // Immediately assign audio.src and invoke audio.play() inside this synchronous tick
      loadAndPlayTrackSync(nextItem, {resetIfSame: true});
      setCurrentIndex(nextIdx);
    },
    [
      activateMediaSessionForPlayback,
      clearRecoveryTimer,
      clearVisibilityResumeTimers,
      endTrackTransition,
      loadAndPlayTrackSync,
      setMediaSessionPlaybackState,
      syncMediaSessionPositionState,
    ]
  );

  const nextTrack = useCallback(() => {
    advanceToNextTrack(false);
  }, [advanceToNextTrack]);

  const prevTrack = useCallback(() => {
    const audio = audioRef.current;
    const {queue: q, currentIndex: idx, repeat: rep} = stateRef.current;
    if (!audio || q.length === 0) return;

    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      setCurrentTime(0);
      syncMediaSessionPositionState(audio);
      return;
    }

    let prevIdx = -1;
    if (idx > 0) {
      prevIdx = idx - 1;
    } else if (rep === 'all') {
      prevIdx = q.length - 1;
    }

    if (prevIdx >= 0 && q[prevIdx]) {
      const prevItem = q[prevIdx];
      stateRef.current.currentIndex = prevIdx;
      stateRef.current.currentTrack = prevItem;
      loadAndPlayTrackSync(prevItem, {resetIfSame: true});
      setCurrentIndex(prevIdx);
    } else {
      audio.currentTime = 0;
      setCurrentTime(0);
      syncMediaSessionPositionState(audio);
    }
  }, [loadAndPlayTrackSync, syncMediaSessionPositionState]);

  const playTrack = useCallback(
    (track: Track, list?: Track[]) => {
      if (list && list.length > 0) {
        const idx = list.findIndex((t) => t.id === track.id);
        const resolvedIdx = idx >= 0 ? idx : 0;
        const resolvedTrack = list[resolvedIdx] ?? track;
        stateRef.current.queue = list;
        stateRef.current.currentIndex = resolvedIdx;
        stateRef.current.currentTrack = resolvedTrack;
        loadAndPlayTrackSync(resolvedTrack, {resetIfSame: true});
        setQueue(list);
        setCurrentIndex(resolvedIdx);
        return;
      }

      const prevQueue = stateRef.current.queue;
      const existingIdx = prevQueue.findIndex((t) => t.id === track.id);
      if (existingIdx >= 0) {
        const resolvedTrack = prevQueue[existingIdx];
        stateRef.current.currentIndex = existingIdx;
        stateRef.current.currentTrack = resolvedTrack;
        loadAndPlayTrackSync(resolvedTrack, {resetIfSame: true});
        setCurrentIndex(existingIdx);
        return;
      }

      const nextQueue = [...prevQueue, track];
      const nextIdx = nextQueue.length - 1;
      stateRef.current.queue = nextQueue;
      stateRef.current.currentIndex = nextIdx;
      stateRef.current.currentTrack = track;
      loadAndPlayTrackSync(track, {resetIfSame: true});
      setQueue(nextQueue);
      setCurrentIndex(nextIdx);
    },
    [loadAndPlayTrackSync]
  );

  const playTrackById = useCallback(
    async (trackId: number) => {
      // Unlock persistent <audio> synchronously inside user gesture before awaiting track metadata
      unlockPersistentAudioElement(audioRef.current ?? getPersistentAudioElement(), true);
      try {
        const data = await apiFetch<{track: Track}>(`/api/tracks/${trackId}`);
        if (data.track) {
          playTrack(data.track, [data.track]);
          return;
        }
      } catch {
        const offlineTracks = await getOfflineTracks();
        const cached = offlineTracks.find((t) => t.id === trackId);
        if (cached) {
          playTrack(cached, [cached]);
        }
      }
    },
    [playTrack]
  );

  const addToQueue = useCallback((track: Track) => {
    setQueue((prev) => {
      if (prev.length === 0) {
        setCurrentIndex(0);
        return [track];
      }
      return [...prev, track];
    });
  }, []);

  const addManyToQueue = useCallback((tracksToAdd: Track[]) => {
    if (tracksToAdd.length === 0) return;
    setQueue((prev) => {
      if (prev.length === 0) {
        setCurrentIndex(0);
        return [...tracksToAdd];
      }
      return [...prev, ...tracksToAdd];
    });
  }, []);

  const handleDeletedTracks = useCallback(
    (deletedIds: number[]) => {
      if (deletedIds.length === 0) return;
      const deletedSet = new Set(deletedIds);
      const {currentTrack: activeTrack, currentIndex: currIdx, queue: prevQueue} = stateRef.current;

      const activeWasDeleted = Boolean(
        activeTrack && typeof activeTrack.id === 'number' && deletedSet.has(activeTrack.id)
      );
      if (activeWasDeleted && audioRef.current) {
        endTrackTransition();
        clearRecoveryTimer();
        clearVisibilityResumeTimers();
        userPausedRef.current = true;
        wantPlayingRef.current = false;
        stateRef.current.isPlaying = false;
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
        delete audioRef.current.dataset.trackId;
        audioRef.current.load();
        setIsPlaying(false);
        setIsBuffering(false);
        setCurrentTime(0);
        setDuration(0);
        syncMediaSessionMetadata(null);
        setMediaSessionPlaybackState('none');
      }

      // Clean up any offline cached copies & ObjectURLs for permanently deleted tracks
      for (const id of deletedIds) {
        const blobUrl = prewarmedObjectUrlsRef.current.get(id);
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
          prewarmedObjectUrlsRef.current.delete(id);
        }
        const prefetchedUrl = prefetchedObjectUrlsRef.current.get(id);
        if (prefetchedUrl) {
          URL.revokeObjectURL(prefetchedUrl);
          prefetchedObjectUrlsRef.current.delete(id);
        }
        prefetchedTrackIdsRef.current.delete(id);
        if (prefetchInFlightIdRef.current === id) {
          prefetchAbortRef.current?.abort();
          prefetchAbortRef.current = null;
          prefetchInFlightIdRef.current = null;
        }
        void removeOfflineTrack(id);
      }

      const nextQueue = prevQueue.filter(
        (t) => !(typeof t.id === 'number' && deletedSet.has(t.id))
      );
      setQueue(nextQueue);
      setRecentlyDownloadedTracks((prev) =>
        prev.filter((t) => !(typeof t.id === 'number' && deletedSet.has(t.id)))
      );

      if (activeWasDeleted || nextQueue.length === 0) {
        setCurrentIndex(-1);
      } else if (currIdx >= 0) {
        let removedBefore = 0;
        for (let i = 0; i < currIdx && i < prevQueue.length; i++) {
          const itemId = prevQueue[i].id;
          if (typeof itemId === 'number' && deletedSet.has(itemId)) removedBefore++;
        }
        setCurrentIndex(Math.max(0, currIdx - removedBefore));
      }
    },
    [clearRecoveryTimer, endTrackTransition, setMediaSessionPlaybackState, syncMediaSessionMetadata]
  );

  const playNextInQueue = useCallback((track: Track) => {
    setQueue((prev) => {
      const idx = stateRef.current.currentIndex;
      if (prev.length === 0 || idx < 0) {
        setCurrentIndex(0);
        return [track];
      }
      const copy = [...prev];
      copy.splice(idx + 1, 0, track);
      return copy;
    });
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    setQueue((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const copy = [...prev];
      copy.splice(index, 1);
      setCurrentIndex((curr) => {
        if (copy.length === 0) return -1;
        if (index < curr) return curr - 1;
        if (index === curr) return Math.min(curr, copy.length - 1);
        return curr;
      });
      return copy;
    });
  }, []);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue((prev) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return prev;
      }
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);

      setCurrentIndex((curr) => {
        if (curr === fromIndex) return toIndex;
        if (fromIndex < curr && toIndex >= curr) return curr - 1;
        if (fromIndex > curr && toIndex <= curr) return curr + 1;
        return curr;
      });
      return copy;
    });
  }, []);

  const clearUpcomingQueue = useCallback(() => {
    setQueue((prev) => {
      const idx = stateRef.current.currentIndex;
      if (idx < 0 || idx >= prev.length) return [];
      return prev.slice(0, idx + 1);
    });
  }, []);

  const syncTrackLikeState = useCallback((trackId: TrackId, liked: boolean) => {
    if (typeof trackId !== 'number') return;
    setQueue((prev) => prev.map((t) => (t.id === trackId ? {...t, liked} : t)));
  }, []);

  const toggleLikeTrack = useCallback(
    async (trackId: TrackId) => {
      if (typeof trackId !== 'number') return null;
      try {
        const res = await apiFetch<{liked: boolean}>(`/api/tracks/${trackId}/like`, {
          method: 'POST',
        });
        syncTrackLikeState(trackId, res.liked);
        bumpLibraryRefresh();
        return res.liked;
      } catch {
        return null;
      }
    },
    [syncTrackLikeState, bumpLibraryRefresh]
  );

  const getYouTubeSaveStatus = useCallback(
    (trackId: TrackId): 'idle' | 'saving' | 'saved' => {
      return youtubeSaveStates[String(trackId)] || 'idle';
    },
    [youtubeSaveStates]
  );

  const saveYouTubeTrackToLibrary = useCallback(
    async (
      track: Track,
      _format: 'm4a' | 'opus' = 'm4a'
    ): Promise<{ok: boolean; message: string; track?: Track}> => {
      const videoId = getYouTubeVideoId(track);
      const saveKeys = Array.from(
        new Set(
          [
            String(track.id),
            track.deezerTrackId ? `dz-track-${track.deezerTrackId}` : null,
            videoId ? `yt-${videoId}` : null,
          ].filter((k): k is string => Boolean(k))
        )
      );

      if (saveKeys.some((k) => youtubeSaveStates[k] === 'saving')) {
        return {ok: false, message: 'Already downloading to library'};
      }

      setYoutubeSaveStates((prev) => {
        const next = {...prev};
        for (const k of saveKeys) next[k] = 'saving';
        return next;
      });

      try {
        const cleanAlbum =
          track.album &&
          track.album !== 'YouTube Stream' &&
          track.album !== 'Online Stream'
            ? track.album
            : 'Downloads';

        const res = await apiFetch<{
          success: boolean;
          alreadyExists?: boolean;
          filePath?: string;
          track?: Track;
        }>('/api/download', {
          method: 'POST',
          body: JSON.stringify({
            videoId: videoId || undefined,
            url:
              track.youtubeUrl ||
              (videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined),
            title: track.title || 'Untitled Track',
            artist: track.artist || 'Unknown Artist',
            album: cleanAlbum,
            coverUrl: track.coverUrl || '',
            duration: track.duration || 0,
          }),
        });

        const savedTrack: Track | undefined = res.track
          ? {
              ...res.track,
              filePath: res.filePath || res.track.filePath,
            }
          : undefined;

        if (savedTrack) {
          setRecentlyDownloadedTracks((prev) => [
            savedTrack,
            ...prev.filter((item) => String(item.id) !== String(savedTrack.id)),
          ]);
        }

        setYoutubeSaveStates((prev) => {
          const next = {...prev};
          for (const k of saveKeys) next[k] = 'saved';
          return next;
        });

        bumpLibraryRefresh();

        return {
          ok: true,
          track: savedTrack,
          message: res.alreadyExists
            ? `"${savedTrack?.title || track.title}" is already in your library`
            : `Downloaded "${savedTrack?.title || track.title}" to library`,
        };
      } catch (err) {
        setYoutubeSaveStates((prev) => {
          const next = {...prev};
          for (const k of saveKeys) delete next[k];
          return next;
        });
        return {
          ok: false,
          message: err instanceof Error ? err.message : 'Could not download track',
        };
      }
    },
    [youtubeSaveStates, bumpLibraryRefresh]
  );

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
  }, []);

  // Keep MediaSession action handlers pointed at the latest callbacks without tearing down listeners
  mediaActionsRef.current = {
    play: () => {
      const audio = audioRef.current;
      if (!audio) return;
      userPausedRef.current = false;
      wantPlayingRef.current = true;
      lockAutoResumeAttemptsRef.current = 0;
      stateRef.current.isPlaying = true;
      clearVisibilityResumeTimers();
      activateMediaSessionForPlayback(stateRef.current.currentTrack, false);
      audio
        .play()
        .then(() => {
          setIsPlaying(true);
          syncMediaSessionPositionState(audio);
        })
        .catch(() => {
          wantPlayingRef.current = false;
          stateRef.current.isPlaying = false;
          setIsPlaying(false);
          setMediaSessionPlaybackState('paused');
        });
    },
    pause: () => {
      const audio = audioRef.current;
      if (!audio) return;
      endTrackTransition();
      clearRecoveryTimer();
      clearVisibilityResumeTimers();
      userPausedRef.current = true;
      wantPlayingRef.current = false;
      stateRef.current.isPlaying = false;
      audio.pause();
      setIsPlaying(false);
      setMediaSessionPlaybackState('paused');
      syncMediaSessionPositionState(audio);
    },
    prevTrack,
    nextTrack,
    seek,
  };

  // Stable ref for internal lifecycle callbacks so native DOM & visibilitychange listeners
  // attach ONCE on mount and never pause/reset the persistent HTMLAudioElement on re-render.
  const lifecycleRef = useRef({
    advanceToNextTrack,
    clearRecoveryTimer,
    clearVisibilityResumeTimers,
    endTrackTransition,
    prefetchNextTrackIfReady,
    scheduleBufferRecovery,
    activateMediaSessionForPlayback,
    registerMediaSessionHandlers,
    setMediaSessionPlaybackState,
    syncMediaSessionMetadata,
    syncMediaSessionPositionState,
  });
  lifecycleRef.current = {
    advanceToNextTrack,
    clearRecoveryTimer,
    clearVisibilityResumeTimers,
    endTrackTransition,
    prefetchNextTrackIfReady,
    scheduleBufferRecovery,
    activateMediaSessionForPlayback,
    registerMediaSessionHandlers,
    setMediaSessionPlaybackState,
    syncMediaSessionMetadata,
    syncMediaSessionPositionState,
  };

  // Attach native DOM audio event listeners & lock-screen visibilitychange recovery ONCE
  // directly to the single persistent HTMLAudioElement so `ended`, `stalled`, `waiting`,
  // screen-lock auto-resume, and MediaSession sync run immediately even while locked/backgrounded.
  useEffect(() => {
    const audio = audioRef.current ?? getPersistentAudioElement();
    if (!audio) return;
    audioRef.current = audio;

    // Register MediaSession handlers initially as well
    lifecycleRef.current.registerMediaSessionHandlers();

    const handlePlay = () => {
      lifecycleRef.current.endTrackTransition();
      userPausedRef.current = false;
      wantPlayingRef.current = true;
      stateRef.current.isPlaying = true;
      setIsPlaying(true);
      lifecycleRef.current.activateMediaSessionForPlayback(stateRef.current.currentTrack, true);
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handlePlaying = () => {
      lifecycleRef.current.endTrackTransition();
      lifecycleRef.current.clearRecoveryTimer();
      lifecycleRef.current.clearVisibilityResumeTimers();
      recoveryAttemptsRef.current = 0;
      lockAutoResumeAttemptsRef.current = 0;
      setIsBuffering(false);
      userPausedRef.current = false;
      wantPlayingRef.current = true;
      stateRef.current.isPlaying = true;
      setIsPlaying(true);
      lifecycleRef.current.activateMediaSessionForPlayback(stateRef.current.currentTrack, false);
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handlePause = () => {
      // Ignore synthetic pause events fired mid-transition when swapping audio.src or reaching ended
      if (transitioningTrackRef.current || audio.ended) return;

      // Ignore silent primer pause if real track hasn't started yet
      if (audio.getAttribute('src') === SILENT_WAV_DATA_URI) return;

      // If the browser paused audio without an explicit user pause action (e.g. phone screen lock),
      // immediately resume while locked and keep MediaSession playbackState = 'playing'.
      if (!userPausedRef.current && wantPlayingRef.current && stateRef.current.currentTrack) {
        lastUnexpectedPauseAtRef.current = Date.now();
        if (document.visibilityState === 'hidden' && lockAutoResumeAttemptsRef.current < 3) {
          lockAutoResumeAttemptsRef.current += 1;
          lifecycleRef.current.activateMediaSessionForPlayback(
            stateRef.current.currentTrack,
            false
          );
          const resumePromise = audio.play();
          if (resumePromise && typeof resumePromise.catch === 'function') {
            resumePromise.catch((err: unknown) => {
              if (err instanceof DOMException && err.name === 'AbortError') return;
              wantPlayingRef.current = false;
              stateRef.current.isPlaying = false;
              setIsPlaying(false);
              lifecycleRef.current.setMediaSessionPlaybackState('paused');
            });
          }
          return;
        }
      }

      lifecycleRef.current.clearRecoveryTimer();
      wantPlayingRef.current = false;
      stateRef.current.isPlaying = false;
      setIsPlaying(false);
      lifecycleRef.current.syncMediaSessionMetadata(stateRef.current.currentTrack, false);
      lifecycleRef.current.setMediaSessionPlaybackState('paused');
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handleWaiting = () => {
      setIsBuffering(true);
      if (wantPlayingRef.current && !audio.ended) {
        lifecycleRef.current.setMediaSessionPlaybackState('playing');
        lifecycleRef.current.scheduleBufferRecovery('waiting');
      }
    };

    const handleStalled = () => {
      setIsBuffering(true);
      if (wantPlayingRef.current && !audio.ended) {
        lifecycleRef.current.setMediaSessionPlaybackState('playing');
        lifecycleRef.current.scheduleBufferRecovery('stalled');
      }
    };

    const handleCanPlay = () => {
      lifecycleRef.current.clearRecoveryTimer();
      recoveryAttemptsRef.current = 0;
      setIsBuffering(false);
      if (wantPlayingRef.current && !userPausedRef.current && audio.paused && !audio.ended) {
        audio.play().catch(() => {});
      }
    };

    const handleLoadedMetadata = () => {
      if (audio.getAttribute('src') === SILENT_WAV_DATA_URI) return;
      const d = audio.duration;
      if (Number.isFinite(d) && d > 0) {
        stateRef.current.duration = d;
        setDuration(d);
      }
      lifecycleRef.current.syncMediaSessionMetadata(stateRef.current.currentTrack, true);
      lifecycleRef.current.setMediaSessionPlaybackState(
        wantPlayingRef.current || !audio.paused ? 'playing' : 'paused'
      );
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handleDurationChange = () => {
      if (audio.getAttribute('src') === SILENT_WAV_DATA_URI) return;
      const d = audio.duration;
      if (Number.isFinite(d) && d > 0) {
        stateRef.current.duration = d;
        setDuration(d);
      }
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handleTimeUpdate = () => {
      if (audio.getAttribute('src') === SILENT_WAV_DATA_URI) return;
      const pos = audio.currentTime;
      const dur =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : stateRef.current.duration;
      setCurrentTime(pos);
      lifecycleRef.current.prefetchNextTrackIfReady(pos, dur);
      lifecycleRef.current.syncMediaSessionMetadata(stateRef.current.currentTrack, false);
      if (!transitioningTrackRef.current) {
        lifecycleRef.current.setMediaSessionPlaybackState(audio.paused ? 'paused' : 'playing');
      }
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handleSeeked = () => {
      const pos = audio.currentTime;
      const dur =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : stateRef.current.duration;
      setCurrentTime(pos);
      lifecycleRef.current.prefetchNextTrackIfReady(pos, dur);
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handleRateChange = () => {
      lifecycleRef.current.syncMediaSessionPositionState(audio);
    };

    const handleEnded = () => {
      if (audio.getAttribute('src') === SILENT_WAV_DATA_URI) return;
      lifecycleRef.current.advanceToNextTrack(true);
    };

    const handleError = () => {
      lifecycleRef.current.endTrackTransition();
      setIsBuffering(false);
      if (
        wantPlayingRef.current &&
        !userPausedRef.current &&
        stateRef.current.currentTrack &&
        recoveryAttemptsRef.current < 2
      ) {
        lifecycleRef.current.scheduleBufferRecovery('stalled');
      }
    };

    // Recover immediately if mobile browser/OS pauses audio when locking the screen (first lock or later)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        const hadRecentBrowserPause =
          !userPausedRef.current && Date.now() - lastUnexpectedPauseAtRef.current < 600;
        const shouldKeepPlaying =
          (wantPlayingRef.current || stateRef.current.isPlaying || hadRecentBrowserPause) &&
          !userPausedRef.current &&
          !audio.ended &&
          Boolean(stateRef.current.currentTrack);

        if (!shouldKeepPlaying) return;

        // Restore playing intent in case the browser fired `pause` milliseconds before `visibilitychange`
        wantPlayingRef.current = true;
        stateRef.current.isPlaying = true;
        setIsPlaying(true);

        const enforceBackgroundPlayback = () => {
          if (
            !wantPlayingRef.current ||
            userPausedRef.current ||
            audio.ended ||
            !stateRef.current.currentTrack
          ) {
            return;
          }
          lifecycleRef.current.activateMediaSessionForPlayback(
            stateRef.current.currentTrack,
            false
          );
          lifecycleRef.current.syncMediaSessionPositionState(audio);
          if (audio.paused && lockAutoResumeAttemptsRef.current < 3) {
            lockAutoResumeAttemptsRef.current += 1;
            const p = audio.play();
            if (p && typeof p.catch === 'function') {
              p.catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                wantPlayingRef.current = false;
                stateRef.current.isPlaying = false;
                setIsPlaying(false);
                lifecycleRef.current.setMediaSessionPlaybackState('paused');
              });
            }
          }
        };

        // Run synchronously on lock + short follow-ups in case iOS/Android pauses slightly after hidden
        enforceBackgroundPlayback();
        lifecycleRef.current.clearVisibilityResumeTimers();
        visibilityResumeTimersRef.current = [
          window.setTimeout(enforceBackgroundPlayback, 50),
          window.setTimeout(enforceBackgroundPlayback, 250),
        ];
      } else if (document.visibilityState === 'visible') {
        lifecycleRef.current.clearVisibilityResumeTimers();
        lockAutoResumeAttemptsRef.current = 0;

        // Reconcile React & MediaSession state when returning from lock screen
        const actuallyPlaying = !audio.paused && !audio.ended;
        setIsPlaying(actuallyPlaying);
        stateRef.current.isPlaying = actuallyPlaying;
        if (stateRef.current.currentTrack) {
          lifecycleRef.current.syncMediaSessionMetadata(stateRef.current.currentTrack, false);
          lifecycleRef.current.setMediaSessionPlaybackState(
            actuallyPlaying ? 'playing' : 'paused'
          );
          lifecycleRef.current.syncMediaSessionPositionState(audio);
        }
      }
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('stalled', handleStalled);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('seeked', handleSeeked);
    audio.addEventListener('ratechange', handleRateChange);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('playing', handlePlaying);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('stalled', handleStalled);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('seeked', handleSeeked);
      audio.removeEventListener('ratechange', handleRateChange);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      // Pause cleanly if PlayerProvider unmounts (e.g. user logs out), while keeping singleton element intact
      lifecycleRef.current.endTrackTransition();
      lifecycleRef.current.clearRecoveryTimer();
      lifecycleRef.current.clearVisibilityResumeTimers();
      userPausedRef.current = true;
      wantPlayingRef.current = false;
      audio.pause();
      audio.removeAttribute('src');
      delete audio.dataset.trackId;
      for (const blobUrl of prewarmedObjectUrlsRef.current.values()) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // ignore
        }
      }
      prewarmedObjectUrlsRef.current.clear();
      prefetchAbortRef.current?.abort();
      prefetchAbortRef.current = null;
      prefetchInFlightIdRef.current = null;
      for (const blobUrl of prefetchedObjectUrlsRef.current.values()) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // ignore
        }
      }
      prefetchedObjectUrlsRef.current.clear();
      prefetchedTrackIdsRef.current.clear();
      lifecycleRef.current.syncMediaSessionMetadata(null);
      lifecycleRef.current.setMediaSessionPlaybackState('none');

      if ('mediaSession' in navigator) {
        const actions: MediaSessionAction[] = [
          'play',
          'pause',
          'previoustrack',
          'nexttrack',
          'seekto',
          'seekbackward',
          'seekforward',
        ];
        for (const action of actions) {
          try {
            navigator.mediaSession.setActionHandler(action, null);
          } catch {
            // ignore
          }
        }
      }
    };
  }, []);

  // Keep MediaSession metadata synced whenever track info changes
  useEffect(() => {
    syncMediaSessionMetadata(currentTrack, false);
    if (currentTrack) {
      syncMediaSessionPositionState(audioRef.current);
    }
  }, [currentTrack, syncMediaSessionMetadata, syncMediaSessionPositionState]);

  // Keep MediaSession playbackState aligned with playing state
  useEffect(() => {
    if (!currentTrack) {
      setMediaSessionPlaybackState('none');
      return;
    }
    setMediaSessionPlaybackState(isPlaying ? 'playing' : 'paused');
    syncMediaSessionPositionState(audioRef.current);
  }, [currentTrack, isPlaying, setMediaSessionPlaybackState, syncMediaSessionPositionState]);

  return (
    <PlayerContext.Provider
      value={{
        currentTrack,
        lastPlayed,
        queue,
        currentIndex,
        isPlaying,
        isBuffering,
        currentTime,
        duration,
        volume,
        isMuted,
        shuffle,
        repeat,
        queueOpen,
        lyricsOpen,
        playTrack,
        playTrackById,
        togglePlay,
        nextTrack,
        prevTrack,
        seek,
        setVolume,
        toggleMute,
        toggleShuffle,
        cycleRepeat,
        addToQueue,
        addManyToQueue,
        playNextInQueue,
        removeFromQueue,
        reorderQueue,
        clearUpcomingQueue,
        handleDeletedTracks,
        toggleLikeTrack,
        setQueueOpen,
        setLyricsOpen,
        syncTrackLikeState,
        libraryRefreshVersion,
        bumpLibraryRefresh,
        recentlyDownloadedTracks,
        saveYouTubeTrackToLibrary,
        getYouTubeSaveStatus,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
};

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider');
  return ctx;
}
