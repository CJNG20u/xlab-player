import {
  Check,
  ChevronDown,
  Download,
  Heart,
  ListMusic,
  Loader2,
  Mic2,
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
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {AlbumArt} from '../components/AlbumArt';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
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
import {
  computeLightTintedTopHex,
  computeNowPlayingTopHex,
  extractDominantColorFromImage,
  getAlbumColorCacheKey,
  getCachedDominantColor,
  setDocumentThemeColor,
} from '../lib/themeColor';
import {getOfflineCoverBlobUrl, getOfflineTrackLyrics} from '../utils/offlineStore';

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

export const NowPlayingPage: React.FC = () => {
  const navigate = useNavigate();
  const {user, isOfflineMode} = useAuth();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const canDownload = Boolean(user?.can_download || user?.role === 'admin');
  const {isLight, isTidal, baseThemeColor} = useTheme();
  const {
    currentTrack,
    isPlaying,
    currentTime,
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
  } = usePlayer();

  const [lyricsData, setLyricsData] = useState<LyricsResponsePayload | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [offlineCoverBackdrop, setOfflineCoverBackdrop] = useState<string | null>(null);
  const [sampledDominantColor, setSampledDominantColor] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);

  const lyricsScrollRef = useRef<HTMLDivElement | null>(null);
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const userScrollPauseUntilRef = useRef<number>(0);
  const justOpenedLyricsRef = useRef<boolean>(false);

  const flashToast = useCallback((msg: string) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2800);
  }, []);

  const artworkSwipe = useSwipeTrackGesture({
    onSwipeNext: nextTrack,
    onSwipePrev: prevTrack,
    threshold: 75,
    deadZone: 10,
    velocityThreshold: 0.55,
    rotationFactor: 0.03,
    slideDistance: 360,
  });

  const trackId = currentTrack?.id ?? null;
  const coverFile = currentTrack?.cover_file ?? null;
  const ytVideoId = useMemo(
    () => (currentTrack?.isYouTubeStream ? getYouTubeVideoId(currentTrack) : null),
    [currentTrack]
  );
  const albumColorKey = useMemo(
    () => (currentTrack ? getAlbumColorCacheKey(currentTrack) : null),
    [currentTrack]
  );
  // Use same-origin YouTube thumbnail proxy for CORS-safe 32x32 offscreen dominant color sampling
  const resolvedSampleCoverUrl =
    offlineCoverBackdrop ||
    (ytVideoId ? getYouTubeThumbProxyUrl(ytVideoId) : getTrackCoverUrl(currentTrack));

  // Sample dominant artwork color on a 32x32 offscreen canvas once per album/track and memoize in memory
  useEffect(() => {
    if (!currentTrack || !albumColorKey) {
      setSampledDominantColor(null);
      return;
    }

    const cached = getCachedDominantColor(albumColorKey, currentTrack.id);
    if (cached) {
      setSampledDominantColor(cached);
      return;
    }

    // Show track metadata color immediately while the 32x32 offscreen sample resolves
    setSampledDominantColor(currentTrack.dominant_color || null);

    if (!resolvedSampleCoverUrl) return;
    let cancelled = false;
    void extractDominantColorFromImage(
      resolvedSampleCoverUrl,
      albumColorKey,
      currentTrack.id,
      currentTrack.dominant_color
    ).then((hex) => {
      if (!cancelled) {
        setSampledDominantColor(hex);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [albumColorKey, currentTrack, resolvedSampleCoverUrl]);

  const effectiveDominantColor = useMemo(() => {
    if (!currentTrack) return null;
    const cached = getCachedDominantColor(albumColorKey, currentTrack.id);
    return cached || sampledDominantColor || currentTrack.dominant_color;
  }, [albumColorKey, currentTrack, sampledDominantColor]);

  const dominantTopHexColor = useMemo(() => {
    if (isTidal) return '#000000';
    if (!currentTrack) return baseThemeColor;
    if (isLight) {
      return computeLightTintedTopHex(effectiveDominantColor, 0.24);
    }
    return computeNowPlayingTopHex(effectiveDominantColor);
  }, [baseThemeColor, currentTrack, effectiveDominantColor, isLight, isTidal]);

  // Synchronously sync mobile status bar (`meta[name="theme-color"]`) with the Now Playing top gradient color
  useLayoutEffect(() => {
    setDocumentThemeColor(dominantTopHexColor);
  }, [dominantTopHexColor]);

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

  const trackTitle = currentTrack?.title ?? '';
  const trackArtist = currentTrack?.artist ?? '';
  const trackAlbum = currentTrack?.album ?? '';
  const trackMetaDuration = currentTrack?.duration ?? 0;
  const trackIsYouTube = Boolean(currentTrack?.isYouTubeStream);

  // Unified lyrics fetch for BOTH local library tracks and Discover/YouTube streams
  // via GET /api/lyrics (local tags/.lrc -> SQLite lyrics_cache -> LRCLIB API),
  // with IndexedDB offline fallback when disconnected.
  useEffect(() => {
    if (!currentTrack || (!trackTitle.trim() && typeof trackId !== 'number')) {
      setLyricsData(null);
      setLyricsLoading(false);
      return;
    }

    const cacheKey = getSessionLyricsKey(currentTrack);
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
  }, [currentTrack, trackAlbum, trackArtist, trackId, trackIsYouTube, trackMetaDuration, trackTitle]);

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
      if (t !== null && t <= currentTime + 0.25) {
        active = i;
      }
    }
    return active;
  }, [parsedLyrics, currentTime]);

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

  if (!currentTrack) {
    return (
      <div className="flex h-full min-h-[70vh] flex-col items-center justify-center px-6 pt-safe text-center bg-[var(--bg-primary)]">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] mb-5">
          <Music2 className="w-9 h-9 text-[var(--text-muted)]" />
        </div>
        <h1 className="font-display text-2xl font-bold text-[var(--text-primary)]">
          Nothing Playing Right Now
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)] max-w-sm">
          Choose a song from your Library or Playlists to launch the full-screen player.
        </p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-6 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          Go to Library
        </button>
      </div>
    );
  }

  const coverUrl = offlineCoverBackdrop || getTrackCoverUrl(currentTrack);
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const remaining = Math.max(0, (duration || 0) - currentTime);
  const volPct = (isMuted ? 0 : volume) * 100;
  const isYouTubeTrack = Boolean(currentTrack.isYouTubeStream);
  const ytSaveStatus = isYouTubeTrack ? getYouTubeSaveStatus(currentTrack.id) : 'idle';

  const handleSaveToLibrary = async () => {
    const res = await saveYouTubeTrackToLibrary(currentTrack);
    flashToast(res.message);
  };

  return (
    <div
      className="relative min-h-full w-full overflow-hidden flex flex-col pt-safe"
      style={{
        background: isTidal
          ? '#000000'
          : isLight
            ? `linear-gradient(180deg, ${dominantTopHexColor} 0%, #FFFFFF 76%)`
            : `linear-gradient(180deg, ${dominantTopHexColor} 0%, var(--bg-primary) 72%)`,
      }}
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
          className={`pointer-events-none absolute inset-0 blur-3xl scale-110 bg-cover bg-center ${
            isTidal ? 'opacity-10' : isLight ? 'opacity-15' : 'opacity-20'
          }`}
          style={{backgroundImage: `url("${coverUrl}")`}}
          aria-hidden="true"
        />
      )}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: isTidal
            ? 'linear-gradient(180deg, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.35) 38%, #000000 100%)'
            : isLight
              ? 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.68) 60%, #FFFFFF 100%)'
              : 'linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--bg-primary) 62%, transparent) 60%, var(--bg-primary) 100%)',
        }}
        aria-hidden="true"
      />

      {/* Top Bar (safe-area-inset-top is handled by the full-screen container) */}
      <header className="relative z-10">
        <div className="flex items-center justify-between px-5 sm:px-8 pt-4 pb-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
              isLight
                ? 'bg-white/75 backdrop-blur-md border border-black/[0.08] text-[#1C1C1E] hover:bg-white'
                : 'bg-black/30 text-white hover:bg-black/50'
            }`}
            aria-label="Back"
          >
            <ChevronDown className="w-6 h-6" />
          </button>

          <div className="text-center min-w-0 px-3">
            <p className="text-xs font-medium text-[var(--text-secondary)]">
              {isYouTubeTrack ? 'Streaming Online' : 'Playing from Library'}
            </p>
            <p className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[200px] sm:max-w-xs">
              {currentTrack.album}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLyricsOpen(!lyricsOpen)}
              aria-pressed={lyricsOpen}
              className={`flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold transition-colors ${
                lyricsOpen
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-md'
                  : isLight
                    ? 'bg-white/75 backdrop-blur-md border border-black/[0.08] text-[#1C1C1E] hover:bg-white'
                    : 'bg-black/30 text-white hover:bg-black/50'
              }`}
              aria-label="Toggle Lyrics"
            >
              <Mic2 className="w-4 h-4" />
              <span className="hidden sm:inline">Lyrics</span>
            </button>
            {!offline && currentTrack && (
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
                    : isLight
                      ? 'bg-white/75 backdrop-blur-md border border-black/[0.08] text-[#1C1C1E] hover:bg-white'
                      : 'bg-black/30 text-white hover:bg-black/50'
                }`}
                aria-label={radioMode ? 'Stop Radio' : 'Start Radio'}
              >
                <Radio className="w-4 h-4" />
                <span className="hidden sm:inline">{radioMode ? 'Radio On' : 'Radio'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setQueueOpen(true)}
              className={`flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold transition-colors ${
                isLight
                  ? 'bg-white/75 backdrop-blur-md border border-black/[0.08] text-[#1C1C1E] hover:bg-white'
                  : 'bg-black/30 text-white hover:bg-black/50'
              }`}
              aria-label="Open Queue"
            >
              <ListMusic className="w-4 h-4" />
              <span className="hidden sm:inline">Queue</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Centered Player Stack (Cover Art swaps directly into Live-Synced Lyrics on toggle) */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 sm:px-10 py-6 pb-safe max-w-2xl mx-auto w-full">
        {/* Artwork / Swappable Lyrics Card + Info + Transport */}
        <div className="flex flex-col items-center w-full max-w-md">
          {lyricsOpen ? (
            <section
              aria-label="Song lyrics"
              className={`w-full max-w-[340px] sm:max-w-[380px] aspect-square rounded-2xl backdrop-blur-xl border overflow-hidden flex flex-col ${
                isLight
                  ? 'bg-white/80 border-black/[0.08] shadow-[0_24px_56px_rgba(0,0,0,0.14)]'
                  : 'bg-black/45 border-white/12 shadow-2xl'
              }`}
            >
              {/* Compact Lyrics Header Bar */}
              <div
                className={`flex items-center justify-between px-4 py-2.5 border-b shrink-0 ${
                  isLight ? 'border-black/[0.06]' : 'border-white/10'
                }`}
              >
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
                              seek(line.time);
                            }
                          }}
                          className={`block w-full text-left font-display leading-snug transition-all duration-200 cursor-pointer focus:outline-none ${
                            isCurrent
                              ? isTidal
                                ? 'text-[19px] sm:text-[21px] font-extrabold text-[#00FFFF] drop-shadow-[0_0_16px_rgba(0,255,255,0.35)]'
                                : isLight
                                  ? 'text-[19px] sm:text-[21px] font-extrabold text-[#1C1C1E]'
                                  : 'text-[19px] sm:text-[21px] font-extrabold text-white'
                              : isPast
                                ? isLight
                                  ? 'text-base sm:text-[17px] font-semibold text-black/30 hover:text-black/70'
                                  : 'text-base sm:text-[17px] font-semibold text-white/35 hover:text-white/75'
                                : isLight
                                  ? 'text-base sm:text-[17px] font-semibold text-black/55 hover:text-black/85'
                                  : 'text-base sm:text-[17px] font-semibold text-white/55 hover:text-white/85'
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
                        className={`font-display text-[15px] sm:text-base leading-relaxed font-medium ${
                          isLight ? 'text-[#1C1C1E]/90' : 'text-white/90'
                        }`}
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
                coverFile={currentTrack.cover_file}
                externalUrl={currentTrack.coverUrl}
                alt={currentTrack.title}
                color={currentTrack.dominant_color}
                className={`w-full h-full rounded-2xl pointer-events-none select-none ${
                  isLight
                    ? 'shadow-[0_24px_56px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.06]'
                    : 'shadow-2xl'
                }`}
                iconSize={72}
              />
            </div>
          )}

          {/* Track Metadata + Heart or Save to Library */}
          <div className="mt-7 flex w-full items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[var(--text-primary)] truncate">
                {currentTrack.title}
              </h1>
              <div className="mt-1 flex items-center gap-2 text-sm text-[var(--text-secondary)] truncate">
                {isYouTubeTrack ? (
                  <span className="font-medium text-[var(--text-primary)] opacity-90 truncate">
                    {currentTrack.artist}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/?artist=${encodeURIComponent(currentTrack.artist)}`)
                    }
                    className="font-medium text-[var(--text-primary)] opacity-90 hover:text-[var(--accent)] hover:underline truncate"
                  >
                    {currentTrack.artist}
                  </button>
                )}
                <span aria-hidden="true">·</span>
                <span className="truncate">{currentTrack.album}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                {isTidal ? (
                  <>
                    <span className="inline-flex items-center rounded border border-[rgba(0,255,255,0.35)] bg-[rgba(0,255,255,0.1)] px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-[#00FFFF] leading-none">
                      {currentTrack.format.toUpperCase()}
                    </span>
                    {currentTrack.bitrate ? (
                      <span className="font-mono text-xs text-[var(--text-secondary)] tabular-nums">
                        {currentTrack.bitrate} kbps
                      </span>
                    ) : null}
                  </>
                ) : (
                  <p className="font-mono text-xs text-[var(--text-muted)] tabular-nums">
                    {currentTrack.format.toUpperCase()}
                    {currentTrack.bitrate ? ` · ${currentTrack.bitrate} kbps` : ''}
                  </p>
                )}
                {isYouTubeTrack && (
                  <span
                    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide leading-none ${
                      isTidal
                        ? 'border-[rgba(0,255,255,0.35)] bg-[rgba(0,255,255,0.1)] text-[#00FFFF]'
                        : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                    }`}
                  >
                    Online
                  </span>
                )}
              </div>
            </div>

            {isYouTubeTrack ? (
              canDownload && !offline ? (
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
              ) : null
            ) : (
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
            )}
          </div>

          {/* Interactive Progress Scrubber */}
          <div className="xlab-slider-group mt-6 w-full space-y-2">
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(currentTime, duration || 1)}
              onChange={(e) => seek(parseFloat(e.target.value))}
              className="xlab-slider always-thumb w-full h-1.5"
              style={{
                background: `linear-gradient(to right, var(--accent) ${progressPct}%, var(--slider-track) ${progressPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Seek track position"
            />
            <div className="flex items-center justify-between font-mono text-xs tabular-nums text-[var(--text-secondary)]">
              <span>{formatDuration(currentTime)}</span>
              <span>-{formatDuration(remaining)}</span>
            </div>
          </div>

          {/* Full Transport Controls */}
          <div className="mt-5 flex w-full items-center justify-between max-w-sm">
            <button
              type="button"
              onClick={toggleShuffle}
              className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                shuffle
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label="Shuffle"
            >
              <Shuffle className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={prevTrack}
              className="flex h-12 w-12 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              aria-label="Previous track"
            >
              <SkipBack className="w-7 h-7 fill-current" />
            </button>

            <button
              type="button"
              onClick={togglePlay}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--btn-contrast-bg)] text-[var(--btn-contrast-text)] shadow-2xl hover:scale-105 active:scale-95 transition-transform"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-7 h-7 fill-current" />
              ) : (
                <Play className="w-7 h-7 fill-current ml-1" />
              )}
            </button>

            <button
              type="button"
              onClick={nextTrack}
              className="flex h-12 w-12 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              aria-label="Next track"
            >
              <SkipForward className="w-7 h-7 fill-current" />
            </button>

            <button
              type="button"
              onClick={cycleRepeat}
              className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                repeat !== 'off'
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label={`Repeat ${repeat}`}
            >
              {repeat === 'one' ? (
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
              onClick={toggleMute}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              aria-label="Mute toggle"
            >
              {isMuted || volume === 0 ? (
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
              value={isMuted ? 0 : volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
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
    </div>
  );
};
