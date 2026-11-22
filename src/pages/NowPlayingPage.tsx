import {
  ChevronDown,
  Heart,
  ListMusic,
  Loader2,
  Mic2,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import React, {useEffect, useMemo, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {AlbumArt} from '../components/AlbumArt';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {useSwipeTrackGesture} from '../hooks/useSwipeTrackGesture';
import {apiFetch, formatDuration, getCoverUrl, parseLrc} from '../lib/api';
import {
  computeLightTintedTopHex,
  computeNowPlayingTopHex,
  extractDominantColorFromImage,
  getAlbumColorCacheKey,
  getCachedDominantColor,
  setDocumentThemeColor,
} from '../lib/themeColor';
import {getOfflineCoverBlobUrl, getOfflineTrackLyrics} from '../utils/offlineStore';

export const NowPlayingPage: React.FC = () => {
  const navigate = useNavigate();
  const {isLight, baseThemeColor} = useTheme();
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
    togglePlay,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    toggleLikeTrack,
  } = usePlayer();

  const [rawLyrics, setRawLyrics] = useState<string | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [offlineCoverBackdrop, setOfflineCoverBackdrop] = useState<string | null>(null);
  const [sampledDominantColor, setSampledDominantColor] = useState<string | null>(null);

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
  const albumColorKey = useMemo(
    () => (currentTrack ? getAlbumColorCacheKey(currentTrack) : null),
    [currentTrack]
  );
  const resolvedCoverUrl = offlineCoverBackdrop || getCoverUrl(coverFile);

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

    if (!resolvedCoverUrl) return;
    let cancelled = false;
    void extractDominantColorFromImage(
      resolvedCoverUrl,
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
  }, [albumColorKey, currentTrack, resolvedCoverUrl]);

  const effectiveDominantColor = useMemo(() => {
    if (!currentTrack) return null;
    const cached = getCachedDominantColor(albumColorKey, currentTrack.id);
    return cached || sampledDominantColor || currentTrack.dominant_color;
  }, [albumColorKey, currentTrack, sampledDominantColor]);

  const dominantTopHexColor = useMemo(() => {
    if (!currentTrack) return baseThemeColor;
    if (isLight) {
      return computeLightTintedTopHex(effectiveDominantColor, 0.24);
    }
    return computeNowPlayingTopHex(effectiveDominantColor);
  }, [baseThemeColor, currentTrack, effectiveDominantColor, isLight]);

  // Dynamically sync mobile status bar (`meta[name="theme-color"]`) with the Now Playing top gradient color,
  // resetting back to the active theme's base color when Now Playing is minimized or closed.
  useEffect(() => {
    setDocumentThemeColor(dominantTopHexColor);
    return () => {
      setDocumentThemeColor(baseThemeColor);
    };
  }, [dominantTopHexColor, baseThemeColor]);

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

  useEffect(() => {
    if (!trackId) {
      setRawLyrics(null);
      return;
    }
    let cancelled = false;
    setLyricsLoading(true);
    const loadLyrics = async () => {
      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          const cached = await getOfflineTrackLyrics(trackId);
          if (!cancelled) setRawLyrics(cached);
          return;
        }
        const res = await apiFetch<{lyrics: string | null}>(`/api/tracks/${trackId}/lyrics`);
        if (!cancelled) setRawLyrics(res.lyrics);
      } catch {
        const cached = await getOfflineTrackLyrics(trackId);
        if (!cancelled) setRawLyrics(cached);
      } finally {
        if (!cancelled) setLyricsLoading(false);
      }
    };
    void loadLyrics();
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  const parsedLyrics = useMemo(() => {
    if (!rawLyrics) return null;
    return parseLrc(rawLyrics);
  }, [rawLyrics]);

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

  const coverUrl = offlineCoverBackdrop || getCoverUrl(currentTrack.cover_file);
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const remaining = Math.max(0, (duration || 0) - currentTime);
  const volPct = (isMuted ? 0 : volume) * 100;

  return (
    <div
      className="relative min-h-full w-full overflow-hidden flex flex-col pt-safe"
      style={{
        background: isLight
          ? `linear-gradient(180deg, ${dominantTopHexColor} 0%, #FFFFFF 76%)`
          : `linear-gradient(180deg, ${dominantTopHexColor} 0%, var(--bg-primary) 72%)`,
      }}
    >
      {/* Blurred album cover backdrop */}
      {coverUrl && (
        <div
          className={`pointer-events-none absolute inset-0 blur-3xl scale-110 bg-cover bg-center ${
            isLight ? 'opacity-15' : 'opacity-20'
          }`}
          style={{backgroundImage: `url("${coverUrl}")`}}
          aria-hidden="true"
        />
      )}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: isLight
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
            <p className="text-xs font-medium text-[var(--text-secondary)]">Playing from Library</p>
            <p className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[200px] sm:max-w-xs">
              {currentTrack.album}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLyricsOpen(!lyricsOpen)}
              className={`flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold transition-colors ${
                lyricsOpen
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : isLight
                    ? 'bg-white/75 backdrop-blur-md border border-black/[0.08] text-[#1C1C1E] hover:bg-white'
                    : 'bg-black/30 text-white hover:bg-black/50'
              }`}
              aria-label="Toggle Lyrics"
            >
              <Mic2 className="w-4 h-4" />
              <span className="hidden sm:inline">Lyrics</span>
            </button>
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

      {/* Main Content Split (Artwork + Controls | Optional Lyrics Drawer) */}
      <div className="relative z-10 flex-1 flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-12 px-6 sm:px-10 py-6 pb-safe max-w-6xl mx-auto w-full">
        {/* Artwork + Info + Transport */}
        <div className="flex flex-col items-center w-full max-w-md">
          <div
            {...artworkSwipe.handlers}
            style={artworkSwipe.style}
            className="w-full max-w-[340px] sm:max-w-[380px] aspect-square select-none cursor-grab active:cursor-grabbing"
            aria-label="Swipe left for next track or right for previous track"
          >
            <AlbumArt
              coverFile={currentTrack.cover_file}
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

          {/* Track Metadata + Heart */}
          <div className="mt-7 flex w-full items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-[var(--text-primary)] truncate">
                {currentTrack.title}
              </h1>
              <div className="mt-1 flex items-center gap-2 text-sm text-[var(--text-secondary)] truncate">
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/?artist=${encodeURIComponent(currentTrack.artist)}`)
                  }
                  className="font-medium text-[var(--text-primary)] opacity-90 hover:text-[var(--accent)] hover:underline truncate"
                >
                  {currentTrack.artist}
                </button>
                <span aria-hidden="true">·</span>
                <span className="truncate">{currentTrack.album}</span>
              </div>
              <p className="mt-1 font-mono text-xs text-[var(--text-muted)] tabular-nums">
                {currentTrack.format.toUpperCase()}
                {currentTrack.bitrate ? ` · ${currentTrack.bitrate} kbps` : ''}
              </p>
            </div>

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

        {/* Toggleable Lyrics Drawer */}
        {lyricsOpen && (
          <section
            className={`w-full lg:w-[440px] max-h-[480px] lg:max-h-[580px] flex flex-col rounded-2xl backdrop-blur-xl border p-6 ${
              isLight
                ? 'bg-white/75 border-black/[0.08] shadow-xl'
                : 'bg-black/35 border-white/10'
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Mic2 className="w-4 h-4 text-[var(--accent)]" />
                <h2 className="font-display text-sm font-bold text-[var(--text-primary)]">Lyrics</h2>
              </div>
              {parsedLyrics?.isSynced && (
                <span className="text-xs text-[var(--accent)] font-medium">Synced LRC</span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto pr-2 space-y-3">
              {lyricsLoading ? (
                <div className="flex items-center justify-center py-16 text-[var(--text-secondary)] gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                  <span className="text-sm">Reading lyrics...</span>
                </div>
              ) : !parsedLyrics || parsedLyrics.lines.length === 0 ? (
                <div className="py-16 text-center space-y-2">
                  <p className="text-sm font-medium text-[var(--text-primary)]">No lyrics available</p>
                  <p className="text-xs text-[var(--text-secondary)] max-w-xs mx-auto">
                    Embed lyrics in the audio file tags or place a matching{' '}
                    <code className="font-mono text-[var(--text-primary)]">.lrc</code> sidecar file alongside the
                    track on your NAS.
                  </p>
                </div>
              ) : (
                parsedLyrics.lines.map((line, idx) => {
                  const isCurrent = idx === activeLyricIndex;
                  return (
                    <button
                      key={idx}
                      type="button"
                      disabled={line.time === null}
                      onClick={() => line.time !== null && seek(line.time)}
                      className={`block w-full text-left font-display text-lg leading-snug transition-colors ${
                        parsedLyrics.isSynced
                          ? isCurrent
                            ? 'text-[var(--text-primary)] font-bold'
                            : idx < activeLyricIndex
                              ? 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                          : 'text-[var(--text-primary)] opacity-85 font-medium cursor-default'
                      }`}
                    >
                      {line.text}
                    </button>
                  );
                })
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
