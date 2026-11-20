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

export const PlayerProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  // Keep refs for MediaSession / ended handler so callbacks never capture stale state
  const stateRef = useRef({queue, currentIndex, shuffle, repeat, currentTrack});
  stateRef.current = {queue, currentIndex, shuffle, repeat, currentTrack};

  const bumpLibraryRefresh = useCallback(() => {
    setLibraryRefreshVersion((v) => v + 1);
  }, []);

  // Load new track source into the single persistent <audio> element
  const currentTrackId = currentTrack?.id ?? null;
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (currentTrackId === null) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      return;
    }

    const src = getStreamUrl(currentTrackId);
    if (audio.dataset.trackId !== String(currentTrackId)) {
      audio.dataset.trackId = String(currentTrackId);
      audio.src = src;
      audio.load();
      setCurrentTime(0);
      setDuration(stateRef.current.currentTrack?.duration || 0);
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  }, [currentTrackId]);

  // Keep volume synced
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
    const position = Math.max(0, Math.min(audio.currentTime || 0, audioDuration));
    try {
      navigator.mediaSession.setPositionState({
        duration: audioDuration,
        playbackRate: audio.playbackRate || 1,
        position,
      });
    } catch {
      // Ignore transient MediaSession position errors
    }
  }, []);

  const seek = useCallback(
    (time: number, fastSeek = false) => {
      const audio = audioRef.current;
      if (!audio) return;
      const maxDur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration || 0;
      const clamped = Math.max(0, Math.min(maxDur, time));
      if (fastSeek && typeof audio.fastSeek === 'function') {
        audio.fastSeek(clamped);
      } else {
        audio.currentTime = clamped;
      }
      setCurrentTime(clamped);
      syncMediaSessionPositionState(audio);
    },
    [duration, syncMediaSessionPositionState]
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !stateRef.current.currentTrack) return;
    if (audio.paused) {
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, []);

  const nextTrack = useCallback(() => {
    const {queue: q, currentIndex: idx, shuffle: isShuf, repeat: rep} = stateRef.current;
    if (q.length === 0) return;

    if (rep === 'one' && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
      return;
    }

    if (isShuf && q.length > 1) {
      let nextIdx = idx;
      while (nextIdx === idx) {
        nextIdx = Math.floor(Math.random() * q.length);
      }
      setCurrentIndex(nextIdx);
      return;
    }

    if (idx + 1 < q.length) {
      setCurrentIndex(idx + 1);
    } else if (rep === 'all') {
      setCurrentIndex(0);
    } else {
      setIsPlaying(false);
    }
  }, []);

  const prevTrack = useCallback(() => {
    const audio = audioRef.current;
    const {queue: q, currentIndex: idx, repeat: rep} = stateRef.current;
    if (q.length === 0) return;

    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }

    if (idx > 0) {
      setCurrentIndex(idx - 1);
    } else if (rep === 'all') {
      setCurrentIndex(q.length - 1);
    } else if (audio) {
      audio.currentTime = 0;
      setCurrentTime(0);
    }
  }, []);

  const playTrack = useCallback((track: Track, list?: Track[]) => {
    if (list && list.length > 0) {
      const idx = list.findIndex((t) => t.id === track.id);
      setQueue(list);
      setCurrentIndex(idx >= 0 ? idx : 0);
      if (audioRef.current && audioRef.current.dataset.trackId === String(track.id)) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
      }
      return;
    }

    setQueue((prev) => {
      const existingIdx = prev.findIndex((t) => t.id === track.id);
      if (existingIdx >= 0) {
        setCurrentIndex(existingIdx);
        return prev;
      }
      const next = [...prev, track];
      setCurrentIndex(next.length - 1);
      return next;
    });
  }, []);

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

  const handleDeletedTracks = useCallback((deletedIds: number[]) => {
    if (deletedIds.length === 0) return;
    const deletedSet = new Set(deletedIds);
    const {currentTrack: activeTrack, currentIndex: currIdx, queue: prevQueue} = stateRef.current;

    const activeWasDeleted = Boolean(activeTrack && deletedSet.has(activeTrack.id));
    if (activeWasDeleted && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      delete audioRef.current.dataset.trackId;
      audioRef.current.load();
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
    }

    const nextQueue = prevQueue.filter((t) => !deletedSet.has(t.id));
    setQueue(nextQueue);

    if (activeWasDeleted || nextQueue.length === 0) {
      setCurrentIndex(-1);
    } else if (currIdx >= 0) {
      // Shift currentIndex left by how many deleted items preceded it
      let removedBefore = 0;
      for (let i = 0; i < currIdx && i < prevQueue.length; i++) {
        if (deletedSet.has(prevQueue[i].id)) removedBefore++;
      }
      setCurrentIndex(Math.max(0, currIdx - removedBefore));
    }
  }, []);

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

  // Browser MediaSession API for iOS/Android lock screens, Bluetooth, CarPlay & Android Auto
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (!currentTrack) {
      navigator.mediaSession.metadata = null;
      return;
    }

    const origin = window.location.origin;
    const coverUrl = getCoverUrl(currentTrack.cover_file);
    const lowerCover = (currentTrack.cover_file || '').toLowerCase();

    // Always supply absolute URLs in PNG/JPEG format across 96x96, 192x192, and 512x512
    // (iOS Safari and Android Auto ignore SVG or relative artwork URLs)
    let artwork: MediaImage[];
    if (coverUrl && (lowerCover.endsWith('.png') || lowerCover.endsWith('.jpg') || lowerCover.endsWith('.jpeg'))) {
      const absCover = new URL(coverUrl, origin).href;
      const mimeType = lowerCover.endsWith('.png') ? 'image/png' : 'image/jpeg';
      artwork = [
        {src: absCover, sizes: '96x96', type: mimeType},
        {src: absCover, sizes: '192x192', type: mimeType},
        {src: absCover, sizes: '512x512', type: mimeType},
      ];
    } else {
      artwork = [
        {src: new URL('/icon-96.png', origin).href, sizes: '96x96', type: 'image/png'},
        {src: new URL('/icon-192.png', origin).href, sizes: '192x192', type: 'image/png'},
        {src: new URL('/icon-512.png', origin).href, sizes: '512x512', type: 'image/png'},
      ];
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album,
      artwork,
    });

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      [
        'play',
        () => {
          const audio = audioRef.current;
          if (!audio) return;
          audio
            .play()
            .then(() => {
              setIsPlaying(true);
              syncMediaSessionPositionState(audio);
            })
            .catch(() => setIsPlaying(false));
        },
      ],
      [
        'pause',
        () => {
          const audio = audioRef.current;
          if (!audio) return;
          audio.pause();
          setIsPlaying(false);
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

    syncMediaSessionPositionState(audioRef.current);
  }, [currentTrack, nextTrack, prevTrack, seek, syncMediaSessionPositionState]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    syncMediaSessionPositionState(audioRef.current);
  }, [isPlaying, syncMediaSessionPositionState]);

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
      {/* Single persistent HTML5 <audio> element mounted at root layout level (playsInline + preload="auto" for iOS background continuity) */}
      <audio
        ref={audioRef}
        playsInline
        preload="auto"
        onPlay={(e) => {
          setIsPlaying(true);
          syncMediaSessionPositionState(e.currentTarget);
        }}
        onPause={(e) => {
          setIsPlaying(false);
          syncMediaSessionPositionState(e.currentTarget);
        }}
        onWaiting={() => setIsBuffering(true)}
        onCanPlay={() => setIsBuffering(false)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
          syncMediaSessionPositionState(e.currentTarget);
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
          syncMediaSessionPositionState(e.currentTarget);
        }}
        onSeeked={(e) => {
          setCurrentTime(e.currentTarget.currentTime);
          syncMediaSessionPositionState(e.currentTarget);
        }}
        onRateChange={(e) => {
          syncMediaSessionPositionState(e.currentTarget);
        }}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setCurrentTime(t);
          syncMediaSessionPositionState(e.currentTarget);
        }}
        onEnded={() => {
          const {repeat: rep} = stateRef.current;
          if (rep === 'one' && audioRef.current) {
            audioRef.current.currentTime = 0;
            audioRef.current.play().catch(() => {});
          } else {
            nextTrack();
          }
        }}
      />
      {children}
    </PlayerContext.Provider>
  );
};

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider');
  return ctx;
}
