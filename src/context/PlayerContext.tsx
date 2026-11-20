import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {apiFetch, getCoverUrl, getStreamUrl} from '../lib/api';
import type {RepeatMode, Track} from '../types';

interface PlayerContextValue {
  currentTrack: Track | null;
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
  toggleLikeTrack: (trackId: number) => Promise<boolean | null>;
  setQueueOpen: (open: boolean) => void;
  setLyricsOpen: (open: boolean) => void;
  syncTrackLikeState: (trackId: number, liked: boolean) => void;
  libraryRefreshVersion: number;
  bumpLibraryRefresh: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

// Module-level singleton HTMLAudioElement: never recreated or unmounted between songs or routes,
// preserving iOS Safari & Android Chrome background/lock-screen audio session permission.
let persistentAudioElement: HTMLAudioElement | null = null;

function getPersistentAudioElement(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  if (!persistentAudioElement) {
    const audio = document.createElement('audio');
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
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

function buildTrackArtwork(track: Track): MediaImage[] {
  const origin = window.location.origin;
  const coverUrl = getCoverUrl(track.cover_file);
  const lowerCover = (track.cover_file || '').toLowerCase();

  // Always supply absolute URLs with explicit 192x192 & 512x512 sizes
  // (iOS Safari, Android Chrome, and CarPlay ignore SVG or relative artwork URLs)
  if (
    coverUrl &&
    (lowerCover.endsWith('.png') ||
      lowerCover.endsWith('.jpg') ||
      lowerCover.endsWith('.jpeg') ||
      lowerCover.endsWith('.webp'))
  ) {
    const absCover = new URL(coverUrl, origin).href;
    const mimeType = lowerCover.endsWith('.png')
      ? 'image/png'
      : lowerCover.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg';
    return [
      {src: absCover, sizes: '96x96', type: mimeType},
      {src: absCover, sizes: '192x192', type: mimeType},
      {src: absCover, sizes: '512x512', type: mimeType},
    ];
  }

  return [
    {src: new URL('/icon-96.png', origin).href, sizes: '96x96', type: 'image/png'},
    {src: new URL('/icon-192.png', origin).href, sizes: '192x192', type: 'image/png'},
    {src: new URL('/icon-512.png', origin).href, sizes: '512x512', type: 'image/png'},
  ];
}

function getTrackMetadataKey(track: Track): string {
  return `${track.id}|${track.title}|${track.artist}|${track.album}|${track.cover_file || ''}`;
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

  const currentTrack =
    currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  // Synchronous state refs so native audio / MediaSession callbacks never read stale state
  const stateRef = useRef({queue, currentIndex, shuffle, repeat, currentTrack, isPlaying, duration});
  stateRef.current = {queue, currentIndex, shuffle, repeat, currentTrack, isPlaying, duration};

  // Playback intent & buffering recovery refs
  const wantPlayingRef = useRef(false);
  const transitioningTrackRef = useRef(false);
  const transitionTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryAttemptsRef = useRef(0);
  const lastMetadataKeyRef = useRef<string | null>(null);

  const bumpLibraryRefresh = useCallback(() => {
    setLibraryRefreshVersion((v) => v + 1);
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
      try {
        navigator.mediaSession.metadata = null;
      } catch {
        // ignore
      }
      return;
    }

    const key = getTrackMetadataKey(track);
    if (!force && lastMetadataKeyRef.current === key && navigator.mediaSession.metadata) {
      return;
    }

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Unknown Title',
        artist: track.artist || 'Unknown Artist',
        album: track.album || '',
        artwork: buildTrackArtwork(track),
      });
      lastMetadataKeyRef.current = key;
    } catch {
      // Ignore MediaMetadata errors on unsupported environments
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
    const audioDuration = audio.duration;
    if (!Number.isFinite(audioDuration) || audioDuration <= 0) return;

    const rawRate = audio.playbackRate;
    const playbackRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
    const rawPos = audio.currentTime;
    const position = Number.isFinite(rawPos)
      ? Math.max(0, Math.min(rawPos, audioDuration))
      : 0;

    try {
      navigator.mediaSession.setPositionState({
        duration: audioDuration,
        playbackRate,
        position,
      });
    } catch {
      // Ignore transient MediaSession position errors
    }
  }, []);

  // Synchronously assign audio.src and call audio.play() on the persistent HTMLAudioElement
  // without awaiting React state updates or network calls (critical for iOS/Android lock-screen continuity).
  const loadAndPlayTrackSync = useCallback(
    (track: Track, options: {resetIfSame?: boolean} = {}) => {
      const audio = audioRef.current ?? getPersistentAudioElement();
      if (!audio) return;
      audioRef.current = audio;

      const nextStreamUrl = getStreamUrl(track.id);
      const isSameLoadedTrack =
        audio.dataset.trackId === String(track.id) && Boolean(audio.getAttribute('src'));

      wantPlayingRef.current = true;
      stateRef.current.isPlaying = true;
      stateRef.current.currentTrack = track;
      clearRecoveryTimer();
      recoveryAttemptsRef.current = 0;

      // Update lock-screen metadata & playing state synchronously
      syncMediaSessionMetadata(track, true);
      setMediaSessionPlaybackState('playing');

      if (isSameLoadedTrack) {
        if (options.resetIfSame) {
          audio.currentTime = 0;
        }
      } else {
        beginTrackTransition();
        audio.dataset.trackId = String(track.id);
        audio.src = nextStreamUrl;
      }

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err: unknown) => {
          // Ignore AbortError caused by rapid track switching
          if (err instanceof DOMException && err.name === 'AbortError') return;
          endTrackTransition();
          wantPlayingRef.current = false;
          stateRef.current.isPlaying = false;
          setIsPlaying(false);
          setMediaSessionPlaybackState('paused');
        });
      }

      setIsPlaying(true);
      setCurrentTime(0);
      setDuration(track.duration || 0);
    },
    [
      beginTrackTransition,
      clearRecoveryTimer,
      endTrackTransition,
      setMediaSessionPlaybackState,
      syncMediaSessionMetadata,
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
          audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
        ) {
          const track = stateRef.current.currentTrack;
          if (!track) return;
          const resumePos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
          beginTrackTransition();
          audio.src = getStreamUrl(track.id);
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
    const audio = audioRef.current;
    const activeTrack = stateRef.current.currentTrack;
    if (!audio || !activeTrack) return;

    if (audio.paused) {
      wantPlayingRef.current = true;
      stateRef.current.isPlaying = true;
      syncMediaSessionMetadata(activeTrack, false);
      setMediaSessionPlaybackState('playing');
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
      wantPlayingRef.current = false;
      stateRef.current.isPlaying = false;
      audio.pause();
      setIsPlaying(false);
      setMediaSessionPlaybackState('paused');
      syncMediaSessionPositionState(audio);
    }
  }, [
    clearRecoveryTimer,
    endTrackTransition,
    setMediaSessionPlaybackState,
    syncMediaSessionMetadata,
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
        wantPlayingRef.current = true;
        stateRef.current.isPlaying = true;
        audio.currentTime = 0;
        if (activeTrack) {
          syncMediaSessionMetadata(activeTrack, false);
        }
        setMediaSessionPlaybackState('playing');
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
      clearRecoveryTimer,
      endTrackTransition,
      loadAndPlayTrackSync,
      setMediaSessionPlaybackState,
      syncMediaSessionMetadata,
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
      const data = await apiFetch<{track: Track}>(`/api/tracks/${trackId}`);
      if (data.track) {
        playTrack(data.track, [data.track]);
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

      const activeWasDeleted = Boolean(activeTrack && deletedSet.has(activeTrack.id));
      if (activeWasDeleted && audioRef.current) {
        endTrackTransition();
        clearRecoveryTimer();
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

      const nextQueue = prevQueue.filter((t) => !deletedSet.has(t.id));
      setQueue(nextQueue);

      if (activeWasDeleted || nextQueue.length === 0) {
        setCurrentIndex(-1);
      } else if (currIdx >= 0) {
        let removedBefore = 0;
        for (let i = 0; i < currIdx && i < prevQueue.length; i++) {
          if (deletedSet.has(prevQueue[i].id)) removedBefore++;
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

  const syncTrackLikeState = useCallback((trackId: number, liked: boolean) => {
    setQueue((prev) => prev.map((t) => (t.id === trackId ? {...t, liked} : t)));
  }, []);

  const toggleLikeTrack = useCallback(
    async (trackId: number) => {
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

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
  }, []);

  // Attach native DOM audio event listeners directly to the single persistent HTMLAudioElement
  // so `ended`, `stalled`, `waiting`, and MediaSession sync run immediately even while locked/backgrounded.
  useEffect(() => {
    const audio = audioRef.current ?? getPersistentAudioElement();
    if (!audio) return;
    audioRef.current = audio;

    const handlePlay = () => {
      endTrackTransition();
      wantPlayingRef.current = true;
      stateRef.current.isPlaying = true;
      setIsPlaying(true);
      syncMediaSessionMetadata(stateRef.current.currentTrack, false);
      setMediaSessionPlaybackState('playing');
      syncMediaSessionPositionState(audio);
    };

    const handlePlaying = () => {
      endTrackTransition();
      clearRecoveryTimer();
      recoveryAttemptsRef.current = 0;
      setIsBuffering(false);
      wantPlayingRef.current = true;
      stateRef.current.isPlaying = true;
      setIsPlaying(true);
      syncMediaSessionMetadata(stateRef.current.currentTrack, false);
      setMediaSessionPlaybackState('playing');
      syncMediaSessionPositionState(audio);
    };

    const handlePause = () => {
      // Ignore synthetic pause events fired mid-transition when swapping audio.src or reaching ended
      if (transitioningTrackRef.current || audio.ended) return;
      clearRecoveryTimer();
      wantPlayingRef.current = false;
      stateRef.current.isPlaying = false;
      setIsPlaying(false);
      syncMediaSessionMetadata(stateRef.current.currentTrack, false);
      setMediaSessionPlaybackState('paused');
      syncMediaSessionPositionState(audio);
    };

    const handleWaiting = () => {
      setIsBuffering(true);
      if (wantPlayingRef.current && !audio.ended) {
        setMediaSessionPlaybackState('playing');
        scheduleBufferRecovery('waiting');
      }
    };

    const handleStalled = () => {
      setIsBuffering(true);
      if (wantPlayingRef.current && !audio.ended) {
        setMediaSessionPlaybackState('playing');
        scheduleBufferRecovery('stalled');
      }
    };

    const handleCanPlay = () => {
      clearRecoveryTimer();
      recoveryAttemptsRef.current = 0;
      setIsBuffering(false);
      if (wantPlayingRef.current && audio.paused && !audio.ended) {
        audio.play().catch(() => {});
      }
    };

    const handleLoadedMetadata = () => {
      const d = audio.duration;
      if (Number.isFinite(d) && d > 0) {
        stateRef.current.duration = d;
        setDuration(d);
      }
      syncMediaSessionMetadata(stateRef.current.currentTrack, true);
      setMediaSessionPlaybackState(
        wantPlayingRef.current || !audio.paused ? 'playing' : 'paused'
      );
      syncMediaSessionPositionState(audio);
    };

    const handleDurationChange = () => {
      const d = audio.duration;
      if (Number.isFinite(d) && d > 0) {
        stateRef.current.duration = d;
        setDuration(d);
      }
      syncMediaSessionPositionState(audio);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      syncMediaSessionMetadata(stateRef.current.currentTrack, false);
      if (!transitioningTrackRef.current) {
        setMediaSessionPlaybackState(audio.paused ? 'paused' : 'playing');
      }
      syncMediaSessionPositionState(audio);
    };

    const handleSeeked = () => {
      setCurrentTime(audio.currentTime);
      syncMediaSessionPositionState(audio);
    };

    const handleRateChange = () => {
      syncMediaSessionPositionState(audio);
    };

    const handleEnded = () => {
      advanceToNextTrack(true);
    };

    const handleError = () => {
      endTrackTransition();
      setIsBuffering(false);
      if (wantPlayingRef.current && stateRef.current.currentTrack && recoveryAttemptsRef.current < 2) {
        scheduleBufferRecovery('stalled');
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

      // Pause cleanly if PlayerProvider unmounts (e.g. user logs out), while keeping singleton element intact
      endTrackTransition();
      clearRecoveryTimer();
      wantPlayingRef.current = false;
      audio.pause();
      audio.removeAttribute('src');
      delete audio.dataset.trackId;
      syncMediaSessionMetadata(null);
      setMediaSessionPlaybackState('none');
    };
  }, [
    advanceToNextTrack,
    clearRecoveryTimer,
    endTrackTransition,
    scheduleBufferRecovery,
    setMediaSessionPlaybackState,
    syncMediaSessionMetadata,
    syncMediaSessionPositionState,
  ]);

  // Register MediaSession action handlers once persistently for iOS/Android lock screens, Bluetooth & CarPlay
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      [
        'play',
        () => {
          const audio = audioRef.current;
          if (!audio) return;
          wantPlayingRef.current = true;
          stateRef.current.isPlaying = true;
          syncMediaSessionMetadata(stateRef.current.currentTrack, false);
          setMediaSessionPlaybackState('playing');
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
      ],
      [
        'pause',
        () => {
          const audio = audioRef.current;
          if (!audio) return;
          endTrackTransition();
          clearRecoveryTimer();
          wantPlayingRef.current = false;
          stateRef.current.isPlaying = false;
          audio.pause();
          setIsPlaying(false);
          setMediaSessionPlaybackState('paused');
          syncMediaSessionPositionState(audio);
        },
      ],
      ['previoustrack', () => prevTrack()],
      ['nexttrack', () => nextTrack()],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') {
            seek(details.seekTime, Boolean(details.fastSeek));
          }
        },
      ],
      [
        'seekbackward',
        (details) => {
          const offset = details.seekOffset || 10;
          seek((audioRef.current?.currentTime || 0) - offset);
        },
      ],
      [
        'seekforward',
        (details) => {
          const offset = details.seekOffset || 10;
          seek((audioRef.current?.currentTime || 0) + offset);
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

    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [
    clearRecoveryTimer,
    endTrackTransition,
    nextTrack,
    prevTrack,
    seek,
    setMediaSessionPlaybackState,
    syncMediaSessionMetadata,
    syncMediaSessionPositionState,
  ]);

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
