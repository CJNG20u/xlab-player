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
import {apiFetch, formatDuration, getCoverUrl, parseLrc} from '../lib/api';
import {getOfflineCoverBlobUrl, getOfflineTrackLyrics} from '../utils/offlineStore';

export const NowPlayingPage: React.FC = () => {
  const navigate = useNavigate();
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

  const trackId = currentTrack?.id ?? null;
  const coverFile = currentTrack?.cover_file ?? null;

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
      <div className="flex h-full min-h-[70vh] flex-col items-center justify-center px-6 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[#181818] mb-5">
          <Music2 className="w-9 h-9 text-[#6A6A6A]" />
        </div>
        <h1 className="font-display text-2xl font-bold text-white">Nothing Playing Right Now</h1>
        <p className="mt-2 text-sm text-[#B3B3B3] max-w-sm">
          Choose a song from your Library or Playlists to launch the full-screen player.
        </p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-6 rounded-full bg-[#1DB954] px-6 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760]"
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
      className="relative min-h-full w-full overflow-hidden flex flex-col"
      style={{
        background: `linear-gradient(180deg, ${currentTrack.dominant_color} 0%, #121212 72%)`,
      }}
    >
      {/* Blurred album cover backdrop */}
      {coverUrl && (
        <div
          className="pointer-events-none absolute inset-0 opacity-25 blur-3xl scale-110 bg-cover bg-center"
          style={{backgroundImage: `url("${coverUrl}")`}}
          aria-hidden="true"
        />
      )}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/20 via-[#121212]/65 to-[#121212]"
        aria-hidden="true"
      />

      {/* Top Bar with iOS safe-area-inset-top */}
      <header className="relative z-10 pt-safe">
        <div className="flex items-center justify-between px-5 sm:px-8 pt-4 pb-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/30 text-white hover:bg-black/50 transition-colors"
            aria-label="Back"
          >
            <ChevronDown className="w-6 h-6" />
          </button>

          <div className="text-center min-w-0 px-3">
            <p className="text-xs font-medium text-white/70">Playing from Library</p>
            <p className="text-xs font-semibold text-white truncate max-w-[200px] sm:max-w-xs">
              {currentTrack.album}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLyricsOpen(!lyricsOpen)}
              className={`flex h-11 px-3.5 items-center gap-2 rounded-full text-xs font-semibold transition-colors ${
                lyricsOpen
                  ? 'bg-[#1DB954] text-black'
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
              className="flex h-11 px-3.5 items-center gap-2 rounded-full bg-black/30 text-xs font-semibold text-white hover:bg-black/50 transition-colors"
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
          <AlbumArt
            coverFile={currentTrack.cover_file}
            alt={currentTrack.title}
            color={currentTrack.dominant_color}
            className="w-full max-w-[340px] sm:max-w-[380px] aspect-square rounded-lg shadow-2xl"
            iconSize={72}
          />

          {/* Track Metadata + Heart */}
          <div className="mt-7 flex w-full items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-white truncate">
                {currentTrack.title}
              </h1>
              <div className="mt-1 flex items-center gap-2 text-sm text-[#B3B3B3] truncate">
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/?artist=${encodeURIComponent(currentTrack.artist)}`)
                  }
                  className="font-medium text-white/90 hover:text-[#1DB954] hover:underline truncate"
                >
                  {currentTrack.artist}
                </button>
                <span aria-hidden="true">·</span>
                <span className="truncate">{currentTrack.album}</span>
              </div>
              <p className="mt-1 font-mono text-xs text-[#6A6A6A] tabular-nums">
                {currentTrack.format.toUpperCase()}
                {currentTrack.bitrate ? ` · ${currentTrack.bitrate} kbps` : ''}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void toggleLikeTrack(currentTrack.id)}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors ${
                currentTrack.liked ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
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
                background: `linear-gradient(to right, #1DB954 ${progressPct}%, rgba(255,255,255,0.22) ${progressPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Seek track position"
            />
            <div className="flex items-center justify-between font-mono text-xs tabular-nums text-[#B3B3B3]">
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
                shuffle ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
              }`}
              aria-label="Shuffle"
            >
              <Shuffle className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={prevTrack}
              className="flex h-12 w-12 items-center justify-center rounded-full text-white hover:bg-white/10 transition-colors"
              aria-label="Previous track"
            >
              <SkipBack className="w-7 h-7 fill-current" />
            </button>

            <button
              type="button"
              onClick={togglePlay}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-black shadow-2xl hover:scale-105 active:scale-95 transition-transform"
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
              className="flex h-12 w-12 items-center justify-center rounded-full text-white hover:bg-white/10 transition-colors"
              aria-label="Next track"
            >
              <SkipForward className="w-7 h-7 fill-current" />
            </button>

            <button
              type="button"
              onClick={cycleRepeat}
              className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                repeat !== 'off' ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
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
              className="text-[#B3B3B3] hover:text-white"
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
                background: `linear-gradient(to right, #1DB954 ${volPct}%, rgba(255,255,255,0.22) ${volPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Volume"
            />
          </div>
        </div>

        {/* Toggleable Lyrics Drawer */}
        {lyricsOpen && (
          <section className="w-full lg:w-[440px] max-h-[480px] lg:max-h-[580px] flex flex-col rounded-xl bg-black/35 backdrop-blur-md border border-white/10 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Mic2 className="w-4 h-4 text-[#1DB954]" />
                <h2 className="font-display text-sm font-bold text-white">Lyrics</h2>
              </div>
              {parsedLyrics?.isSynced && (
                <span className="text-xs text-[#1DB954] font-medium">Synced LRC</span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto pr-2 space-y-3">
              {lyricsLoading ? (
                <div className="flex items-center justify-center py-16 text-[#B3B3B3] gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-[#1DB954]" />
                  <span className="text-sm">Reading lyrics...</span>
                </div>
              ) : !parsedLyrics || parsedLyrics.lines.length === 0 ? (
                <div className="py-16 text-center space-y-2">
                  <p className="text-sm font-medium text-white">No lyrics available</p>
                  <p className="text-xs text-[#B3B3B3] max-w-xs mx-auto">
                    Embed lyrics in the audio file tags or place a matching{' '}
                    <code className="font-mono text-white">.lrc</code> sidecar file alongside the
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
                            ? 'text-white font-bold'
                            : idx < activeLyricIndex
                              ? 'text-white/45 hover:text-white/80'
                              : 'text-white/65 hover:text-white'
                          : 'text-white/85 font-medium cursor-default'
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
