import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  Download,
  Heart,
  ListMusic,
  ListPlus,
  Loader2,
  Mic2,
  MonitorSpeaker,
  Music2,
  Pause,
  Play,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {AddToPlaylistModal} from '../components/AddToPlaylistModal';
import {AlbumArt} from '../components/AlbumArt';
import {DesktopNowPlayingView} from '../components/DesktopNowPlayingView';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {useLayoutMode} from '../hooks/useLayoutMode';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {useSwipeTrackGesture} from '../hooks/useSwipeTrackGesture';
import {
  apiFetch,
  formatDuration,
  getTrackCoverUrl,
  getYouTubeThumbProxyUrl,
  getYouTubeVideoId,
  parseLrc,
} from '../lib/api';
import {usePlaybackTime} from '../lib/playbackClock';
import {useRemoteControl} from '../lib/remoteControl';
import {useScrollReady} from '../lib/scrollHistory';
import type {Playlist, RepeatMode, Track} from '../types';
import {
  computeLightTintedTopHex,
  computeNowPlayingTopHex,
  extractDominantColorFromImage,
  getAlbumColorCacheKey,
  getCachedDominantColor,
  useStatusBarColor,
} from '../lib/themeColor';
import {
  getOfflineCoverBlobUrl,
  getOfflinePlaylists,
  getOfflineTrackLyrics,
} from '../utils/offlineStore';

interface LyricsResponsePayload {
  lyrics: string | null;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
  source: 'local' | 'cache' | 'lrclib' | 'offline' | 'none';
}

const sessionLyricsCache = new Map<string, LyricsResponsePayload>();

function getSessionLyricsKey(track: {
  id: number | string;
  title?: string;
  artist?: string;
}): string {
  return `${track.id}|${(track.artist || '').trim().toLowerCase()}|${(track.title || '').trim().toLowerCase()}`;
}

const pendingPlaylistAddKeys = new Set<string>();
const pendingPlaylistAddListeners = new Set<() => void>();

function notifyPendingPlaylistAddListeners() {
  for (const listener of pendingPlaylistAddListeners) {
    listener();
  }
}

function getTrackPlaylistActionKeys(track: Track): string[] {
  const videoId = track.isYouTubeStream ? getYouTubeVideoId(track) : null;
  return Array.from(
    new Set(
      [
        String(track.id),
        track.deezerTrackId ? `dz-track-${track.deezerTrackId}` : null,
        videoId ? `yt-${videoId}` : null,
      ].filter((k): k is string => Boolean(k))
    )
  );
}

export const NowPlayingPage: React.FC = () => {
  const navigate = useNavigate();
  useScrollReady(true);
  const isDesktop = useLayoutMode() === 'desktop';
  const {user, isOfflineMode} = useAuth();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const canDownload = Boolean(user?.can_download || user?.role === 'admin');
  const {isLight, isTidal, baseThemeColor} = useTheme();
  const {
    currentTrack,
    isPlaying,
    duration,
    volume,
    isMuted,
    shuffle,
    repeat,
    lyricsOpen,
    setLyricsOpen,
    setQueueOpen,
    radioMode,
    startRadio,
    stopRadio,
    togglePlay,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    toggleLikeTrack,
    saveYouTubeTrackToLibrary,
    getYouTubeSaveStatus,
    libraryRefreshVersion,
    bumpLibraryRefresh,
    remoteHostApi,
  } = usePlayer();

  const remote = useRemoteControl();
  const isRemoteActive = remote.isRemoteActive;
  const remoteTrackObj = useMemo<Track | null>(() => {
    if (!isRemoteActive || !remote.targetState?.track) return null;
    const rt = remote.targetState.track;
    return {
      id: rt.id,
      rel_path: '',
      title: rt.title,
      artist: rt.artist,
      album: rt.album || '',
      track_number: null,
      year: null,
      duration: rt.duration || 0,
      format: rt.isYouTubeStream || rt.videoId ? 'WEB' : 'AUDIO',
      bitrate: 0,
      size_bytes: 0,
      cover_file: rt.cover_file ?? null,
      dominant_color: rt.dominant_color || '#1f3a2e',
      added_at: '',
      liked: false,
      coverUrl: rt.cover ?? undefined,
      isYouTubeStream: Boolean(rt.isYouTubeStream || rt.videoId),
      youtubeUrl: rt.videoId ? `https://www.youtube.com/watch?v=${rt.videoId}` : undefined,
    };
  }, [isRemoteActive, remote.targetState?.track]);

  const localTime = usePlaybackTime();
  const activeTrack = isRemoteActive ? remoteTrackObj : currentTrack;
  const activeIsPlaying = isRemoteActive ? Boolean(remote.targetState?.isPlaying) : isPlaying;
  const activeTime = isRemoteActive ? remote.extrapolatedPositionSec : localTime;
  const activeDuration = isRemoteActive ? remote.targetState?.track?.duration || 0 : duration;
  const activeVolume = isRemoteActive ? (remote.targetState?.volume ?? 1) : volume;
  const activeMuted = isRemoteActive ? Boolean(remote.targetState?.muted) : isMuted;
  const activeShuffle = isRemoteActive ? Boolean(remote.targetState?.shuffle) : shuffle;
  const activeRepeat: RepeatMode = isRemoteActive ? (remote.targetState?.repeat ?? 'off') : repeat;

  const handleTogglePlay = useCallback(() => {
    if (isRemoteActive) {
      void remote.send('toggle');
      return;
    }
    togglePlay();
  }, [isRemoteActive, remote, togglePlay]);

  const handleNext = useCallback(() => {
    if (isRemoteActive) {
      void remote.send('next');
      return;
    }
    nextTrack();
  }, [isRemoteActive, nextTrack, remote]);

  const handlePrev = useCallback(() => {
    if (isRemoteActive) {
      void remote.send('prev');
      return;
    }
    prevTrack();
  }, [isRemoteActive, prevTrack, remote]);

  const handleSeek = useCallback(
    (pos: number) => {
      if (isRemoteActive) {
        void remote.send('seek', {positionSec: pos});
        return;
      }
      seek(pos);
    },
    [isRemoteActive, remote, seek]
  );

  const handleSetVolume = useCallback(
    (vol: number) => {
      if (isRemoteActive) {
        void remote.send('setVolume', {volume: vol});
        return;
      }
      setVolume(vol);
    },
    [isRemoteActive, remote, setVolume]
  );

  const handleToggleMute = useCallback(() => {
    if (isRemoteActive) {
      void remote.send('mute', {muted: !activeMuted});
      return;
    }
    toggleMute();
  }, [activeMuted, isRemoteActive, remote, toggleMute]);

  const handleToggleShuffle = useCallback(() => {
    if (isRemoteActive) {
      void remote.send('shuffle', {shuffle: !activeShuffle});
      return;
    }
    toggleShuffle();
  }, [activeShuffle, isRemoteActive, remote, toggleShuffle]);

  const handleCycleRepeat = useCallback(() => {
    if (isRemoteActive) {
      const nextMode: RepeatMode =
        activeRepeat === 'off' ? 'all' : activeRepeat === 'all' ? 'one' : 'off';
      void remote.send('repeat', {repeat: nextMode});
      return;
    }
    cycleRepeat();
  }, [activeRepeat, cycleRepeat, isRemoteActive, remote]);

  const [lyricsData, setLyricsData] = useState<LyricsResponsePayload | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [offlineCoverBackdrop, setOfflineCoverBackdrop] = useState<string | null>(null);
  const [sampledDominantColor, setSampledDominantColor] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [pickerTrack, setPickerTrack] = useState<Track | null>(null);
  const [, setPendingAddTick] = useState(0);

  const lyricsScrollRef = useRef<HTMLDivElement | null>(null);
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const userScrollPauseUntilRef = useRef<number>(0);
  const justOpenedLyricsRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const toastTimerRef = useRef<number | null>(null);
  const playlistsLoadedRef = useRef<boolean>(false);
  const playlistsLoadedVersionRef = useRef<number>(-1);

  useEffect(() => {
    isMountedRef.current = true;
    const onPendingChange = () => setPendingAddTick((n) => n + 1);
    pendingPlaylistAddListeners.add(onPendingChange);
    return () => {
      isMountedRef.current = false;
      pendingPlaylistAddListeners.delete(onPendingChange);
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  const flashToast = useCallback((msg: string) => {
    if (!isMountedRef.current) return;
    setActionToast(msg);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      if (isMountedRef.current) {
        setActionToast(null);
      }
    }, 2800);
  }, []);

  const loadPlaylistsForModal = useCallback(async () => {
    if (offline) {
      const cached = await getOfflinePlaylists();
      if (isMountedRef.current) {
        setPlaylists(cached);
        playlistsLoadedRef.current = true;
        playlistsLoadedVersionRef.current = libraryRefreshVersion;
      }
      return;
    }
    try {
      const res = await apiFetch<{playlists: Playlist[]}>('/api/playlists');
      if (isMountedRef.current) {
        setPlaylists(res.playlists || []);
        playlistsLoadedRef.current = true;
        playlistsLoadedVersionRef.current = libraryRefreshVersion;
      }
    } catch {
      const cached = await getOfflinePlaylists();
      if (isMountedRef.current) {
        setPlaylists(cached);
        playlistsLoadedRef.current = true;
        playlistsLoadedVersionRef.current = libraryRefreshVersion;
      }
    }
  }, [libraryRefreshVersion, offline]);

  const handleOpenPlaylistPicker = useCallback(() => {
    if (isRemoteActive || !currentTrack) return;
    if (currentTrack.isYouTubeStream) {
      if (!canDownload || offline) return;
      const keys = getTrackPlaylistActionKeys(currentTrack);
      if (keys.some((k) => pendingPlaylistAddKeys.has(k))) return;
    } else if (typeof currentTrack.id !== 'number') {
      return;
    }
    setPickerTrack(currentTrack);
    if (!playlistsLoadedRef.current || playlistsLoadedVersionRef.current !== libraryRefreshVersion) {
      void loadPlaylistsForModal();
    }
  }, [
    canDownload,
    currentTrack,
    isRemoteActive,
    libraryRefreshVersion,
    loadPlaylistsForModal,
    offline,
  ]);

  const handleLibraryPlaylistSuccess = useCallback(
    (message: string, createdPlaylist?: Playlist) => {
      if (createdPlaylist) {
        setPlaylists((prev) =>
          prev.some((p) => p.id === createdPlaylist.id) ? prev : [createdPlaylist, ...prev]
        );
        void loadPlaylistsForModal();
      }
      bumpLibraryRefresh();
      flashToast(message);
    },
    [bumpLibraryRefresh, flashToast, loadPlaylistsForModal]
  );

  const handlePickYouTubePlaylist = useCallback(
    (pickedPlaylist: Playlist) => {
      const capturedTrack = pickerTrack;
      if (!capturedTrack) return;
      const actionKeys = getTrackPlaylistActionKeys(capturedTrack);
      if (actionKeys.some((k) => pendingPlaylistAddKeys.has(k))) return;

      setPlaylists((prev) =>
        prev.some((p) => p.id === pickedPlaylist.id) ? prev : [pickedPlaylist, ...prev]
      );
      void loadPlaylistsForModal();

      for (const k of actionKeys) pendingPlaylistAddKeys.add(k);
      notifyPendingPlaylistAddListeners();
      flashToast(`Downloading and adding to ${pickedPlaylist.name}...`);

      void (async () => {
        try {
          const res = await saveYouTubeTrackToLibrary(capturedTrack);
          const libraryTrackId = res.track?.id;
          if (!res.ok || typeof libraryTrackId !== 'number' || !Number.isFinite(libraryTrackId)) {
            if (isMountedRef.current) {
              flashToast(res.message || 'Could not download track');
            }
            return;
          }
          await apiFetch(`/api/playlists/${pickedPlaylist.id}/tracks`, {
            method: 'POST',
            body: JSON.stringify({trackIds: [libraryTrackId]}),
          });
          bumpLibraryRefresh();
          if (isMountedRef.current) {
            void loadPlaylistsForModal();
            flashToast(`Added to ${pickedPlaylist.name}`);
          }
        } catch (err) {
          if (isMountedRef.current) {
            flashToast(err instanceof Error ? err.message : 'Could not add track to playlist');
          }
        } finally {
          for (const k of actionKeys) pendingPlaylistAddKeys.delete(k);
          notifyPendingPlaylistAddListeners();
        }
      })();
    },
    [bumpLibraryRefresh, flashToast, loadPlaylistsForModal, pickerTrack, saveYouTubeTrackToLibrary]
  );

  const handlePlayHereQuick = useCallback(async () => {
    if (!remote.targetDeviceId) return;
    remoteHostApi.unlockAudio();
    const ack = await remote.send(
      'transfer',
      {direction: 'pull', toDeviceId: remote.selfDeviceId},
      remote.targetDeviceId,
      {onRetry: () => void handlePlayHereQuick()}
    );
    if (ack.status === 'applied') {
      remote.selectTarget(null);
      flashToast(`Playing on ${remote.selfDeviceName}`);
    }
  }, [flashToast, remote, remoteHostApi]);

  const artworkSwipe = useSwipeTrackGesture({
    onSwipeNext: handleNext,
    onSwipePrev: handlePrev,
    threshold: 75,
    deadZone: 10,
    velocityThreshold: 0.55,
    rotationFactor: 0.03,
    slideDistance: 360,
  });

  const trackId = activeTrack?.id ?? null;
  const coverFile = activeTrack?.cover_file ?? null;
  const ytVideoId = useMemo(
    () => (activeTrack?.isYouTubeStream ? getYouTubeVideoId(activeTrack) : null),
    [activeTrack]
  );
  const albumColorKey = useMemo(
    () => (activeTrack ? getAlbumColorCacheKey(activeTrack) : null),
    [activeTrack]
  );
  // Use same-origin YouTube thumbnail proxy for CORS-safe 32x32 offscreen dominant color sampling
  const resolvedSampleCoverUrl =
    offlineCoverBackdrop ||
    (ytVideoId ? getYouTubeThumbProxyUrl(ytVideoId) : getTrackCoverUrl(activeTrack));

  // Sample dominant artwork color on a 32x32 offscreen canvas once per album/track and memoize in memory
  useEffect(() => {
    if (!activeTrack || !albumColorKey) {
      setSampledDominantColor(null);
      return;
    }

    const cached = getCachedDominantColor(albumColorKey, activeTrack.id);
    if (cached) {
      setSampledDominantColor(cached);
      return;
    }

    // Show track metadata color immediately while the 32x32 offscreen sample resolves
    setSampledDominantColor(activeTrack.dominant_color || null);

    if (!resolvedSampleCoverUrl) return;
    let cancelled = false;
    void extractDominantColorFromImage(
      resolvedSampleCoverUrl,
      albumColorKey,
      activeTrack.id,
      activeTrack.dominant_color
    ).then((hex) => {
      if (!cancelled) {
        setSampledDominantColor(hex);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [albumColorKey, activeTrack, resolvedSampleCoverUrl]);

  const effectiveDominantColor = useMemo(() => {
    if (!activeTrack) return null;
    const cached = getCachedDominantColor(albumColorKey, activeTrack.id);
    return cached || sampledDominantColor || activeTrack.dominant_color;
  }, [albumColorKey, activeTrack, sampledDominantColor]);

  const dominantTopHexColor = useMemo(() => {
    if (isTidal) return '#000000';
    if (!activeTrack) return baseThemeColor;
    if (isLight) {
      return computeLightTintedTopHex(effectiveDominantColor, 0.24);
    }
    return computeNowPlayingTopHex(effectiveDominantColor);
  }, [baseThemeColor, activeTrack, effectiveDominantColor, isLight, isTidal]);

  // Claim mobile status bar color matching the exact first stop of the Now Playing top gradient
  useStatusBarColor(dominantTopHexColor);

  useEffect(() => {
    setOfflineCoverBackdrop(null);
    if (!coverFile) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      let cancelled = false;
      void getOfflineCoverBlobUrl(coverFile).then((url) => {
        if (!cancelled && url) setOfflineCoverBackdrop(url);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [coverFile]);

  const trackTitle = activeTrack?.title ?? '';
  const trackArtist = activeTrack?.artist ?? '';
  const trackAlbum = activeTrack?.album ?? '';
  const trackMetaDuration = activeTrack?.duration ?? 0;
  const trackIsYouTube = Boolean(activeTrack?.isYouTubeStream);

  // Unified lyrics fetch for BOTH local library tracks and Discover/YouTube streams
  // via GET /api/lyrics (local tags/.lrc -> SQLite lyrics_cache -> LRCLIB API),
  // with IndexedDB offline fallback when disconnected.
  useEffect(() => {
    if (!activeTrack || (!trackTitle.trim() && typeof trackId !== 'number')) {
      setLyricsData(null);
      setLyricsLoading(false);
      return;
    }

    const cacheKey = getSessionLyricsKey(activeTrack);
    const cachedSession = sessionLyricsCache.get(cacheKey);
    if (cachedSession) {
      setLyricsData(cachedSession);
      setLyricsLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLyricsData(null);
    setLyricsLoading(true);
    lyricLineRefs.current = [];
    userScrollPauseUntilRef.current = 0;

    const loadLyrics = async () => {
      const localNumericId = !trackIsYouTube && typeof trackId === 'number' ? trackId : null;

      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          if (localNumericId !== null) {
            const cachedOffline = await getOfflineTrackLyrics(localNumericId);
            if (!cancelled) {
              const payload: LyricsResponsePayload = {
                lyrics: cachedOffline,
                syncedLyrics: null,
                plainLyrics: cachedOffline,
                instrumental: false,
                source: cachedOffline ? 'offline' : 'none',
              };
              setLyricsData(payload);
            }
          }
          return;
        }

        const qs = new URLSearchParams();
        if (localNumericId !== null) qs.set('trackId', String(localNumericId));
        if (trackTitle.trim()) qs.set('title', trackTitle.trim());
        if (trackArtist.trim()) qs.set('artist', trackArtist.trim());
        if (trackAlbum.trim()) qs.set('album', trackAlbum.trim());
        if (Number.isFinite(trackMetaDuration) && trackMetaDuration > 0) {
          qs.set('duration', String(Math.round(trackMetaDuration)));
        }

        const res = await apiFetch<LyricsResponsePayload>(`/api/lyrics?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (cancelled) return;

        const normalized: LyricsResponsePayload = {
          lyrics: res.syncedLyrics || res.lyrics || res.plainLyrics || null,
          syncedLyrics: res.syncedLyrics || null,
          plainLyrics: res.plainLyrics || null,
          instrumental: Boolean(res.instrumental),
          source: res.source || 'none',
        };
        sessionLyricsCache.set(cacheKey, normalized);
        setLyricsData(normalized);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (localNumericId !== null) {
          const cachedOffline = await getOfflineTrackLyrics(localNumericId);
          if (!cancelled) {
            setLyricsData({
              lyrics: cachedOffline,
              syncedLyrics: null,
              plainLyrics: cachedOffline,
              instrumental: false,
              source: cachedOffline ? 'offline' : 'none',
            });
          }
        } else if (!cancelled) {
          setLyricsData(null);
        }
      } finally {
        if (!cancelled) setLyricsLoading(false);
      }
    };

    void loadLyrics();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTrack, trackAlbum, trackArtist, trackId, trackIsYouTube, trackMetaDuration, trackTitle]);

  const rawLyricsText = useMemo(() => {
    if (!lyricsData) return null;
    return lyricsData.syncedLyrics || lyricsData.lyrics || lyricsData.plainLyrics || null;
  }, [lyricsData]);

  const parsedLyrics = useMemo(() => {
    if (!rawLyricsText) return null;
    return parseLrc(rawLyricsText);
  }, [rawLyricsText]);

  const activeLyricIndex = useMemo(() => {
    if (!parsedLyrics?.isSynced) return -1;
    let active = -1;
    for (let i = 0; i < parsedLyrics.lines.length; i++) {
      const t = parsedLyrics.lines[i].time;
      if (t !== null && t <= activeTime + 0.25) {
        active = i;
      }
    }
    return active;
  }, [parsedLyrics, activeTime]);

  useEffect(() => {
    if (lyricsOpen) {
      justOpenedLyricsRef.current = true;
      userScrollPauseUntilRef.current = 0;
    }
  }, [lyricsOpen, trackId]);

  // Smoothly auto-scroll the square lyrics container to keep the active lyric line centered
  useEffect(() => {
    if (!lyricsOpen || !parsedLyrics?.isSynced || activeLyricIndex < 0) return;
    if (Date.now() < userScrollPauseUntilRef.current) return;

    const container = lyricsScrollRef.current;
    const activeEl = lyricLineRefs.current[activeLyricIndex];
    if (!container || !activeEl) return;

    const targetScrollTop =
      activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
    const behavior: ScrollBehavior = justOpenedLyricsRef.current ? 'auto' : 'smooth';
    justOpenedLyricsRef.current = false;

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior,
    });
  }, [activeLyricIndex, lyricsOpen, parsedLyrics?.isSynced]);

  const coverUrl = activeTrack ? offlineCoverBackdrop || getTrackCoverUrl(activeTrack) : null;
  const isYouTubeTrack = Boolean(activeTrack?.isYouTubeStream);
  const ytSaveStatus =
    !isRemoteActive && activeTrack && isYouTubeTrack ? getYouTubeSaveStatus(activeTrack.id) : 'idle';
  const isAddingCurrentToPlaylist = Boolean(
    !isRemoteActive &&
      currentTrack &&
      currentTrack.isYouTubeStream &&
      getTrackPlaylistActionKeys(currentTrack).some((k) => pendingPlaylistAddKeys.has(k))
  );

  const handleSaveToLibrary = async () => {
    if (isRemoteActive || !currentTrack) return;
    const res = await saveYouTubeTrackToLibrary(currentTrack);
    flashToast(res.message);
  };

  if (isDesktop) {
    return (
      <>
        <DesktopNowPlayingView
          activeTrack={activeTrack}
          currentTrack={currentTrack}
          isRemoteActive={isRemoteActive}
          remoteDeviceName={remote.targetDevice?.name ?? null}
          offline={offline}
          canDownload={canDownload}
          isLight={isLight}
          isTidal={isTidal}
          dominantTopHexColor={dominantTopHexColor}
          coverUrl={coverUrl}
          actionToast={actionToast}
          lyricsLoading={lyricsLoading}
          isInstrumental={Boolean(lyricsData?.instrumental)}
          parsedLyrics={parsedLyrics}
          activeLyricIndex={activeLyricIndex}
          ytSaveStatus={ytSaveStatus}
          isAddingCurrentToPlaylist={isAddingCurrentToPlaylist}
          onSeek={handleSeek}
          onSaveToLibrary={() => void handleSaveToLibrary()}
          onOpenPlaylistPicker={handleOpenPlaylistPicker}
          onToggleLike={(id) => void toggleLikeTrack(id)}
          onOpenDevices={() => remote.setDeviceSheetOpen(true)}
          onPlayHereQuick={() => void handlePlayHereQuick()}
          onFlashToast={flashToast}
        />
        <AddToPlaylistModal
          open={Boolean(pickerTrack)}
          trackIds={
            pickerTrack && !pickerTrack.isYouTubeStream && typeof pickerTrack.id === 'number'
              ? [pickerTrack.id]
              : []
          }
          playlists={playlists}
          onClose={() => setPickerTrack(null)}
          onPick={pickerTrack?.isYouTubeStream ? handlePickYouTubePlaylist : undefined}
          onSuccess={handleLibraryPlaylistSuccess}
        />
      </>
    );
  }

  if (!activeTrack) {
    return (
      <div className="flex h-full min-h-[70vh] flex-col items-center justify-center px-6 pt-safe text-center bg-[var(--bg-primary)]">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] mb-5">
          <Music2 className="w-9 h-9 text-[var(--text-muted)]" />
        </div>
        <h1 className="font-display text-2xl font-bold text-[var(--text-primary)]">
          {isRemoteActive && remote.targetDevice
            ? `${remote.targetDevice.name} Is Idle`
            : 'Nothing Playing Right Now'}
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)] max-w-sm">
          {isRemoteActive
            ? 'Start playing a track on the remote device or switch back to this device.'
            : 'Choose a song from your Library or Playlists to launch the full-screen player.'}
        </p>
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
          >
            Go to Library
          </button>
          {!offline && (
            <button
              type="button"
              onClick={() => remote.setDeviceSheetOpen(true)}
              className="inline-flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-5 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              <MonitorSpeaker className="w-4 h-4 text-[var(--accent)]" />
              Devices
            </button>
          )}
        </div>
      </div>
    );
  }

  const progressPct =
    activeDuration > 0 ? Math.min(100, (activeTime / activeDuration) * 100) : 0;
  const remaining = Math.max(0, (activeDuration || 0) - activeTime);
  const volPct = (activeMuted ? 0 : activeVolume) * 100;

  return (
    <div
      className="relative min-h-full w-full overflow-hidden flex flex-col pt-safe [background:var(--np-canvas-bg)]"
      style={
        {
          '--np-top-hex': dominantTopHexColor,
          background: isTidal
            ? dominantTopHexColor
            : `linear-gradient(180deg, ${dominantTopHexColor} 0%, var(--bg-primary) ${isLight ? '76%' : '72%'})`,
        } as React.CSSProperties
      }
    >
      {actionToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate">
          {actionToast}
        </div>
      )}

      {/* Subtle Tidal Cyan Ambient Glow on Pure OLED Black */}
      {isTidal && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 72% 42% at 50% 34%, rgba(0, 255, 255, 0.11) 0%, rgba(0, 255, 255, 0.03) 44%, transparent 74%)',
          }}
          aria-hidden="true"
        />
      )}

      {/* Blurred album cover backdrop */}
      {coverUrl && (
        <div
          className="pointer-events-none absolute inset-0 blur-3xl scale-110 bg-cover bg-center opacity-[var(--np-backdrop-opacity)]"
          style={{backgroundImage: `url("${coverUrl}")`}}
          aria-hidden="true"
        />
      )}
      <div
        className="pointer-events-none absolute inset-0 [background:var(--np-scrim)]"
        aria-hidden="true"
      />

      {/* Top Bar (safe-area-inset-top is handled by the full-screen container) */}
      <header className="relative z-10">
        <div className="flex items-center justify-between px-5 sm:px-8 pt-4 pb-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex h-11 w-11 items-center justify-center rounded-full backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)] transition-colors"
            aria-label="Back"
          >
            <ChevronDown className="w-6 h-6" />
          </button>

          <div className="text-center min-w-0 px-3">
            <p className="text-xs font-medium text-[var(--text-secondary)] truncate">
              {isRemoteActive && remote.targetDevice
                ? `Playing on ${remote.targetDevice.name}`
                : isYouTubeTrack
                  ? 'Streaming Online'
                  : 'Playing from Library'}
            </p>
            <p className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[200px] sm:max-w-xs">
              {activeTrack.album || activeTrack.artist}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {!offline && (
              <button
                type="button"
                onClick={() => remote.setDeviceSheetOpen(true)}
                aria-pressed={isRemoteActive}
                className={`flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold transition-colors ${
                  isRemoteActive
                    ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-md'
                    : 'backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)]'
                }`}
                aria-label="Devices"
              >
                <MonitorSpeaker className="w-4 h-4" />
                <span className="hidden sm:inline">Devices</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setLyricsOpen(!lyricsOpen)}
              aria-pressed={lyricsOpen}
              className={`flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold transition-colors ${
                lyricsOpen
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-md'
                  : 'backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)]'
              }`}
              aria-label="Toggle Lyrics"
            >
              <Mic2 className="w-4 h-4" />
              <span className="hidden sm:inline">Lyrics</span>
            </button>
            {!offline && !isRemoteActive && currentTrack && (
              <button
                type="button"
                onClick={() => {
                  if (radioMode) {
                    stopRadio();
                    flashToast('Radio stopped');
                  } else {
                    startRadio(currentTrack);
                    flashToast('Starting radio...');
                  }
                }}
                aria-pressed={radioMode}
                className={`flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold transition-colors ${
                  radioMode
                    ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-md'
                    : 'backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)]'
                }`}
                aria-label={radioMode ? 'Stop Radio' : 'Start Radio'}
              >
                <Radio className="w-4 h-4" />
                <span className="hidden sm:inline">{radioMode ? 'Radio On' : 'Radio'}</span>
              </button>
            )}
            {!isRemoteActive && (
              <button
                type="button"
                onClick={() => setQueueOpen(true)}
                className="flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)] transition-colors"
                aria-label="Open Queue"
              >
                <ListMusic className="w-4 h-4" />
                <span className="hidden sm:inline">Queue</span>
              </button>
            )}
          </div>
        </div>
        {isRemoteActive && remote.targetDevice && (
          <div className="px-5 sm:px-8 pb-2 flex items-center justify-center">
            <div className="inline-flex items-center gap-2.5 rounded-full backdrop-blur-md border border-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-1.5 text-xs">
              <MonitorSpeaker className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <span className="font-semibold text-[var(--text-primary)] truncate max-w-[180px]">
                Controlling {remote.targetDevice.name}
              </span>
              <button
                type="button"
                onClick={() => void handlePlayHereQuick()}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--accent-contrast)] hover:opacity-90 transition-opacity"
              >
                <ArrowRightLeft className="w-3 h-3" />
                Play here
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Main Centered Player Stack (Cover Art swaps directly into Live-Synced Lyrics on toggle) */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 sm:px-10 py-6 pb-safe max-w-2xl mx-auto w-full">
        {/* Artwork / Swappable Lyrics Card + Info + Transport */}
        <div className="flex flex-col items-center w-full max-w-md">
          {lyricsOpen ? (
            <section
              aria-label="Song lyrics"
              className="w-full max-w-[340px] sm:max-w-[380px] aspect-square rounded-2xl backdrop-blur-xl border border-[var(--np-lyrics-border)] bg-[var(--np-lyrics-bg)] shadow-[var(--np-lyrics-shadow)] overflow-hidden flex flex-col"
            >
              {/* Compact Lyrics Header Bar */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--np-lyrics-header-border)] shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Mic2 className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <span className="font-display text-xs font-bold tracking-wide text-[var(--text-primary)]">
                    Lyrics
                  </span>
                </div>
                {parsedLyrics?.isSynced ? (
                  <span className="text-[11px] font-semibold text-[var(--accent)]">Synced</span>
                ) : lyricsData?.instrumental ? (
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Instrumental
                  </span>
                ) : parsedLyrics && parsedLyrics.lines.length > 0 ? (
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Plain text
                  </span>
                ) : null}
              </div>

              {/* Scrollable Live Lyrics Body */}
              <div
                ref={lyricsScrollRef}
                onWheel={() => {
                  userScrollPauseUntilRef.current = Date.now() + 3000;
                }}
                onTouchStart={() => {
                  userScrollPauseUntilRef.current = Date.now() + 3000;
                }}
                className="relative flex-1 overflow-y-auto no-scrollbar px-5"
                style={{
                  WebkitMaskImage:
                    'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)',
                  maskImage:
                    'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)',
                }}
              >
                {lyricsLoading ? (
                  <div className="h-full flex flex-col items-center justify-center gap-2.5 text-[var(--text-secondary)]">
                    <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
                    <span className="text-xs font-medium">Fetching lyrics...</span>
                  </div>
                ) : lyricsData?.instrumental ? (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-4">
                    <Music2 className="w-7 h-7 text-[var(--accent)] opacity-80" />
                    <p className="font-display text-base font-bold text-[var(--text-primary)]">
                      Instrumental Track
                    </p>
                    <p className="text-xs text-[var(--text-secondary)]">
                      Sit back and enjoy the music.
                    </p>
                  </div>
                ) : !parsedLyrics || parsedLyrics.lines.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-1.5 px-4">
                    <Mic2 className="w-6 h-6 text-[var(--text-muted)] mb-1" />
                    <p className="font-display text-sm font-semibold text-[var(--text-primary)]">
                      No lyrics found
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] max-w-[230px]">
                      {offline
                        ? 'Reconnect to fetch lyrics online or embed lyrics in the file.'
                        : 'Lyrics are not available for this track yet.'}
                    </p>
                  </div>
                ) : parsedLyrics.isSynced ? (
                  <div className="py-16 space-y-3.5">
                    {parsedLyrics.lines.map((line, idx) => {
                      const isCurrent = idx === activeLyricIndex;
                      const isPast = activeLyricIndex >= 0 && idx < activeLyricIndex;
                      return (
                        <button
                          key={`${line.time ?? idx}-${idx}`}
                          ref={(el) => {
                            lyricLineRefs.current[idx] = el;
                          }}
                          type="button"
                          onClick={() => {
                            if (line.time !== null) {
                              userScrollPauseUntilRef.current = 0;
                              handleSeek(line.time);
                            }
                          }}
                          className={`block w-full text-left font-display leading-snug transition-all duration-200 cursor-pointer focus:outline-none ${
                            isCurrent
                              ? 'text-[19px] sm:text-[21px] font-extrabold text-[var(--np-lyric-current)] [filter:var(--np-lyric-current-filter)]'
                              : isPast
                                ? 'text-base sm:text-[17px] font-semibold text-[var(--np-lyric-past)] hover:text-[var(--np-lyric-past-hover)]'
                                : 'text-base sm:text-[17px] font-semibold text-[var(--np-lyric-future)] hover:text-[var(--np-lyric-future-hover)]'
                          }`}
                        >
                          {line.text}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-6 space-y-2.5">
                    {parsedLyrics.lines.map((line, idx) => (
                      <p
                        key={idx}
                        className="font-display text-[15px] sm:text-base leading-relaxed font-medium text-[var(--np-lyric-plain)]"
                      >
                        {line.text}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : (
            <div
              {...artworkSwipe.handlers}
              style={artworkSwipe.style}
              className="w-full max-w-[340px] sm:max-w-[380px] aspect-square select-none cursor-grab active:cursor-grabbing"
              aria-label="Swipe left for next track or right for previous track"
            >
              <AlbumArt
                coverFile={activeTrack.cover_file}
                externalUrl={activeTrack.coverUrl}
                alt={activeTrack.title}
                color={activeTrack.dominant_color}
                className="w-full h-full rounded-2xl pointer-events-none select-none shadow-[var(--np-art-shadow)] ring-1 ring-[var(--np-art-ring)]"
                iconSize={72}
              />
            </div>
          )}

          {/* Track Metadata + Heart or Save to Library */}
          <div className="mt-7 flex w-full items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[var(--text-primary)] truncate">
                {activeTrack.title}
              </h1>
              <div className="mt-1 flex items-center gap-2 text-sm text-[var(--text-secondary)] truncate">
                {isYouTubeTrack || isRemoteActive ? (
                  <span className="font-medium text-[var(--text-primary)] opacity-90 truncate">
                    {activeTrack.artist}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/?artist=${encodeURIComponent(activeTrack.artist)}`)
                    }
                    className="font-medium text-[var(--text-primary)] opacity-90 hover:text-[var(--accent)] hover:underline truncate"
                  >
                    {activeTrack.artist}
                  </button>
                )}
                {activeTrack.album ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{activeTrack.album}</span>
                  </>
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                {isTidal ? (
                  <>
                    <span className="inline-flex items-center rounded border border-[rgba(0,255,255,0.35)] bg-[rgba(0,255,255,0.1)] px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-[#00FFFF] leading-none">
                      {activeTrack.format.toUpperCase()}
                    </span>
                    {activeTrack.bitrate ? (
                      <span className="font-mono text-xs text-[var(--text-secondary)] tabular-nums">
                        {activeTrack.bitrate} kbps
                      </span>
                    ) : null}
                  </>
                ) : (
                  <p className="font-mono text-xs text-[var(--text-muted)] tabular-nums">
                    {activeTrack.format.toUpperCase()}
                    {activeTrack.bitrate ? ` · ${activeTrack.bitrate} kbps` : ''}
                  </p>
                )}
                {isYouTubeTrack && (
                  <span className="inline-flex items-center rounded border border-[var(--badge-source-border)] bg-[var(--badge-source-bg)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide leading-none text-[var(--badge-source-text)]">
                    Online
                  </span>
                )}
              </div>
            </div>

            {!isRemoteActive && currentTrack ? (
              isYouTubeTrack ? (
                canDownload && !offline ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={ytSaveStatus === 'saving'}
                      onClick={() => void handleSaveToLibrary()}
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors ${
                        ytSaveStatus === 'saved'
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                      }`}
                      title={ytSaveStatus === 'saved' ? 'Saved to library' : 'Save track'}
                      aria-label="Save track"
                    >
                      {ytSaveStatus === 'saving' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : ytSaveStatus === 'saved' ? (
                        <Check className="w-4 h-4 stroke-[2.5]" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={isAddingCurrentToPlaylist}
                      onClick={handleOpenPlaylistPicker}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60 transition-colors"
                      title="Add to playlist"
                      aria-label="Add to playlist"
                    >
                      {isAddingCurrentToPlaylist ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ListPlus className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                ) : null
              ) : (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => void toggleLikeTrack(currentTrack.id)}
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors ${
                      currentTrack.liked
                        ? 'text-[var(--accent)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                    aria-label={currentTrack.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
                  >
                    <Heart className={`w-6 h-6 ${currentTrack.liked ? 'fill-current' : ''}`} />
                  </button>
                  {typeof currentTrack.id === 'number' && (
                    <button
                      type="button"
                      onClick={handleOpenPlaylistPicker}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                      title="Add to playlist"
                      aria-label="Add to playlist"
                    >
                      <ListPlus className="w-6 h-6" />
                    </button>
                  )}
                </div>
              )
            ) : null}
          </div>

          {/* Interactive Progress Scrubber */}
          <div className="xlab-slider-group mt-6 w-full space-y-2">
            <input
              type="range"
              min={0}
              max={activeDuration || 1}
              step={0.1}
              value={Math.min(activeTime, activeDuration || 1)}
              onChange={(e) => handleSeek(parseFloat(e.target.value))}
              className="xlab-slider always-thumb w-full h-1.5"
              style={{
                background: `linear-gradient(to right, var(--accent) ${progressPct}%, var(--slider-track) ${progressPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Seek track position"
            />
            <div className="flex items-center justify-between font-mono text-xs tabular-nums text-[var(--text-secondary)]">
              <span>{formatDuration(activeTime)}</span>
              <span>-{formatDuration(remaining)}</span>
            </div>
          </div>

          {/* Full Transport Controls */}
          <div className="mt-5 flex w-full items-center justify-between max-w-sm">
            <button
              type="button"
              onClick={handleToggleShuffle}
              className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                activeShuffle
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label="Shuffle"
            >
              <Shuffle className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={handlePrev}
              className="flex h-12 w-12 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              aria-label="Previous track"
            >
              <SkipBack className="w-7 h-7 fill-current" />
            </button>

            <button
              type="button"
              onClick={handleTogglePlay}
              className={`flex h-16 w-16 items-center justify-center rounded-full bg-[var(--btn-contrast-bg)] text-[var(--btn-contrast-text)] shadow-2xl hover:scale-105 active:scale-95 transition-transform ${
                remote.isPending ? 'opacity-70' : ''
              }`}
              aria-label={activeIsPlaying ? 'Pause' : 'Play'}
            >
              {activeIsPlaying ? (
                <Pause className="w-7 h-7 fill-current" />
              ) : (
                <Play className="w-7 h-7 fill-current ml-1" />
              )}
            </button>

            <button
              type="button"
              onClick={handleNext}
              className="flex h-12 w-12 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              aria-label="Next track"
            >
              <SkipForward className="w-7 h-7 fill-current" />
            </button>

            <button
              type="button"
              onClick={handleCycleRepeat}
              className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                activeRepeat !== 'off'
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label={`Repeat ${activeRepeat}`}
            >
              {activeRepeat === 'one' ? (
                <Repeat1 className="w-5 h-5" />
              ) : (
                <Repeat className="w-5 h-5" />
              )}
            </button>
          </div>

          {/* Mobile Volume Slider */}
          <div className="mt-6 flex md:hidden w-full max-w-xs items-center gap-3">
            <button
              type="button"
              onClick={handleToggleMute}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              aria-label="Mute toggle"
            >
              {activeMuted || activeVolume === 0 ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={activeMuted ? 0 : activeVolume}
              onChange={(e) => handleSetVolume(parseFloat(e.target.value))}
              className="xlab-slider always-thumb flex-1 h-1"
              style={{
                background: `linear-gradient(to right, var(--accent) ${volPct}%, var(--slider-track) ${volPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Volume"
            />
          </div>
        </div>
      </div>

      <AddToPlaylistModal
        open={Boolean(pickerTrack)}
        trackIds={
          pickerTrack && !pickerTrack.isYouTubeStream && typeof pickerTrack.id === 'number'
            ? [pickerTrack.id]
            : []
        }
        playlists={playlists}
        onClose={() => setPickerTrack(null)}
        onPick={pickerTrack?.isYouTubeStream ? handlePickYouTubePlaylist : undefined}
        onSuccess={handleLibraryPlaylistSuccess}
      />
    </div>
  );
};
