import {
  Check,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {
  apiFetch,
  formatDuration,
  getCatalogMatchStreamUrl,
  prefetchYouTubeStreams,
} from '../lib/api';
import {
  computeLightTintedTopHex,
  computeNowPlayingTopHex,
  extractDominantColorFromImage,
  getCachedDominantColor,
  getUnifiedPageHeaderTopHex,
  setDocumentThemeColor,
} from '../lib/themeColor';
import type {
  DiscoverAlbumDetail,
  DiscoverAlbumTrack,
  DiscoverArtistDetail,
  Track,
} from '../types';

export type CatalogRoute =
  | {type: 'album'; id: string; titleHint?: string; artistHint?: string; coverHint?: string}
  | {type: 'artist'; id: string; nameHint?: string; pictureHint?: string};

// Session-level client cache for instant back/forward navigation across albums & artists
const albumDetailSessionCache = new Map<string, DiscoverAlbumDetail>();
const artistDetailSessionCache = new Map<string, DiscoverArtistDetail>();

function formatFanCount(fans: number): string {
  if (!fans || fans <= 0) return '';
  if (fans >= 1_000_000) return `${(fans / 1_000_000).toFixed(1)}M fans`;
  if (fans >= 1_000) return `${(fans / 1_000).toFixed(fans >= 100_000 ? 0 : 1)}K fans`;
  return `${fans.toLocaleString()} fans`;
}

function formatTotalRuntime(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  const totalMins = Math.round(seconds / 60);
  if (totalMins < 60) return `${totalMins} min`;
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `${hrs} hr ${mins} min` : `${hrs} hr`;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function hashTint(seed: string): string {
  const palette = ['#2d4a3e', '#3b2e5a', '#4a3228', '#1e3a5f', '#4c2639', '#2b4754'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

export function catalogTrackToPlayerTrack(item: DiscoverAlbumTrack): Track {
  const hasVid = Boolean(item.videoId && /^[A-Za-z0-9_-]{6,20}$/.test(item.videoId));
  const trackId = hasVid ? `yt-${item.videoId}` : item.id;
  const streamUrl = hasVid
    ? `/api/yt-stream/${encodeURIComponent(item.videoId!)}`
    : getCatalogMatchStreamUrl({
        artist: item.artist,
        title: item.title,
        duration: item.duration,
      });

  return {
    id: trackId,
    rel_path: '',
    title: item.title,
    artist: item.artist,
    album: item.album,
    track_number: item.trackNumber,
    year: null,
    duration: item.duration || 0,
    format: 'm4a',
    bitrate: 0,
    size_bytes: 0,
    cover_file: null,
    dominant_color: '#1f2937',
    added_at: '',
    liked: false,
    coverUrl: item.coverUrl || undefined,
    streamUrl,
    isYouTubeStream: true,
    youtubeUrl: hasVid ? `https://www.youtube.com/watch?v=${item.videoId}` : undefined,
    deezerTrackId: item.deezerTrackId,
    deezerAlbumId: item.albumId || undefined,
    deezerArtistId: item.artistId || undefined,
  };
}

interface ResilientCoverProps {
  src?: string;
  alt: string;
  shape: 'square' | 'circle';
  label: string;
  className?: string;
}

const ResilientCover: React.FC<ResilientCoverProps> = ({
  src,
  alt,
  shape,
  label,
  className = '',
}) => {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const radius = shape === 'circle' ? 'rounded-full' : 'rounded-xl';

  if (!src || failed) {
    const tint = hashTint(label || alt);
    return (
      <div
        className={`w-full h-full flex items-center justify-center select-none ${radius} ${className}`}
        style={{
          background: `linear-gradient(145deg, ${tint} 0%, var(--bg-elevated) 100%)`,
        }}
        aria-label={alt}
      >
        {shape === 'circle' ? (
          <span className="font-display text-2xl font-bold tracking-tight text-white/90">
            {getInitials(label || alt)}
          </span>
        ) : (
          <Disc3 className="w-10 h-10 text-white/55" />
        )}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`w-full h-full object-cover bg-[var(--bg-elevated)] select-none ${radius} ${className}`}
    />
  );
};

interface BlurredArtworkBackdropProps {
  imageUrl?: string;
  fallbackSeed: string;
  topHexColor: string;
  isLight: boolean;
}

const BlurredArtworkBackdrop: React.FC<BlurredArtworkBackdropProps> = ({
  imageUrl,
  fallbackSeed,
  topHexColor,
  isLight,
}) => {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [imageUrl]);

  const fallbackTint = useMemo(() => hashTint(fallbackSeed), [fallbackSeed]);

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{backgroundColor: topHexColor}}
      aria-hidden="true"
    >
      {imageUrl && !imgError ? (
        <img
          src={imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className={`h-full w-full object-cover object-center scale-125 blur-3xl saturate-150 ${
            isLight ? 'opacity-25' : 'opacity-45'
          }`}
        />
      ) : (
        <div
          className="h-full w-full opacity-55"
          style={{
            background: `radial-gradient(ellipse at 30% 20%, ${fallbackTint} 0%, transparent 72%)`,
          }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          background: isLight
            ? `linear-gradient(180deg, ${topHexColor} 0%, ${topHexColor}bb 26%, color-mix(in srgb, var(--bg-primary) 72%, transparent) 66%, var(--bg-primary) 100%)`
            : `linear-gradient(180deg, ${topHexColor} 0%, ${topHexColor}aa 24%, color-mix(in srgb, var(--bg-primary) 64%, transparent) 64%, var(--bg-primary) 100%)`,
        }}
      />
    </div>
  );
};

interface CatalogDetailViewProps {
  route: CatalogRoute;
  canDownload: boolean;
  onBack: () => void;
  onOpenAlbum: (album: {
    id: string;
    titleHint?: string;
    artistHint?: string;
    coverHint?: string;
  }) => void;
  onOpenArtist: (artist: {id: string; nameHint?: string; pictureHint?: string}) => void;
  onFlashToast: (msg: string) => void;
}

export const CatalogDetailView: React.FC<CatalogDetailViewProps> = ({
  route,
  canDownload,
  onBack,
  onOpenAlbum,
  onOpenArtist,
  onFlashToast,
}) => {
  const {theme, isLight, isTidal} = useTheme();
  const {
    currentTrack,
    isPlaying,
    isBuffering,
    playTrack,
    togglePlay,
    saveYouTubeTrackToLibrary,
    getYouTubeSaveStatus,
  } = usePlayer();

  const [album, setAlbum] = useState<DiscoverAlbumDetail | null>(() =>
    route.type === 'album' ? (albumDetailSessionCache.get(route.id) ?? null) : null
  );
  const [artist, setArtist] = useState<DiscoverArtistDetail | null>(() =>
    route.type === 'artist' ? (artistDetailSessionCache.get(route.id) ?? null) : null
  );
  const [loading, setLoading] = useState<boolean>(() => {
    if (route.type === 'album') return !albumDetailSessionCache.has(route.id);
    return !artistDetailSessionCache.has(route.id);
  });
  const [error, setError] = useState<string | null>(null);

  // Batch "Download Album" state
  const [albumDownloadState, setAlbumDownloadState] = useState<{
    albumId: string;
    active: boolean;
    done: boolean;
    queued: number;
    total: number;
  } | null>(null);
  const albumDownloadCancelRef = useRef(false);

  useEffect(() => {
    albumDownloadCancelRef.current = true;
    setAlbumDownloadState(null);
    return () => {
      albumDownloadCancelRef.current = true;
    };
  }, [route.id, route.type]);

  const loadDetail = useCallback(
    async (forceRefresh = false) => {
      setError(null);
      if (route.type === 'album') {
        const cached = !forceRefresh ? albumDetailSessionCache.get(route.id) : undefined;
        if (cached) {
          setAlbum(cached);
          setArtist(null);
          setLoading(false);
          return;
        }
        setLoading(true);
        setArtist(null);
        try {
          const qs = forceRefresh ? '?refresh=1' : '';
          const data = await apiFetch<DiscoverAlbumDetail>(
            `/api/discover/album/${encodeURIComponent(route.id)}${qs}`
          );
          albumDetailSessionCache.set(route.id, data);
          setAlbum(data);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not load album tracklist');
        } finally {
          setLoading(false);
        }
      } else {
        const cached = !forceRefresh ? artistDetailSessionCache.get(route.id) : undefined;
        if (cached) {
          setArtist(cached);
          setAlbum(null);
          setLoading(false);
          return;
        }
        setLoading(true);
        setAlbum(null);
        try {
          const qs = forceRefresh ? '?refresh=1' : '';
          const data = await apiFetch<DiscoverArtistDetail>(
            `/api/discover/artist/${encodeURIComponent(route.id)}${qs}`
          );
          artistDetailSessionCache.set(route.id, data);
          setArtist(data);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not load artist page');
        } finally {
          setLoading(false);
        }
      }
    },
    [route.id, route.type]
  );

  useEffect(() => {
    void loadDetail(false);
  }, [loadDetail]);

  // Background prefetch top 3 tracks whenever an album or artist detail view loads
  useEffect(() => {
    const tracks = route.type === 'album' ? album?.tracks : artist?.topTracks;
    if (!tracks || tracks.length === 0) return;
    prefetchYouTubeStreams(
      tracks.slice(0, 3).map((t) => ({
        videoId: t.videoId,
        artist: t.artist,
        title: t.title,
        duration: t.duration,
      }))
    );
  }, [album, artist, route.type]);

  // Play clicked track, queue rest of list, and prefetch clicked track + next 2 tracks
  const handlePlayTrackFromList = useCallback(
    (clicked: DiscoverAlbumTrack, list: DiscoverAlbumTrack[]) => {
      const clickedIdx = Math.max(
        0,
        list.findIndex((item) => item.id === clicked.id || item.deezerTrackId === clicked.deezerTrackId)
      );
      const prefetchSlice = list.slice(clickedIdx, clickedIdx + 3);
      if (prefetchSlice.length > 0) {
        prefetchYouTubeStreams(
          prefetchSlice.map((t) => ({
            videoId: t.videoId,
            artist: t.artist,
            title: t.title,
            duration: t.duration,
          }))
        );
      }

      const queue = list.map(catalogTrackToPlayerTrack);
      const target = catalogTrackToPlayerTrack(clicked);
      if (
        currentTrack?.id === target.id ||
        (currentTrack?.deezerTrackId && currentTrack.deezerTrackId === clicked.deezerTrackId)
      ) {
        togglePlay();
        return;
      }
      const matched =
        queue.find((q) => q.deezerTrackId === clicked.deezerTrackId) || target;
      playTrack(matched, queue);
    },
    [currentTrack?.deezerTrackId, currentTrack?.id, playTrack, togglePlay]
  );

  const handleSaveCatalogTrack = useCallback(
    async (e: React.MouseEvent, item: DiscoverAlbumTrack) => {
      e.stopPropagation();
      if (!canDownload) return;
      const trackObj = catalogTrackToPlayerTrack(item);
      const res = await saveYouTubeTrackToLibrary(trackObj, 'm4a');
      onFlashToast(res.message);
    },
    [canDownload, onFlashToast, saveYouTubeTrackToLibrary]
  );

  const handleDownloadAlbum = useCallback(async () => {
    if (!canDownload || !album || album.tracks.length === 0) return;
    if (albumDownloadState?.albumId === album.deezerAlbumId && albumDownloadState.active) return;

    albumDownloadCancelRef.current = false;
    const total = album.tracks.length;
    setAlbumDownloadState({
      albumId: album.deezerAlbumId,
      active: true,
      done: false,
      queued: 0,
      total,
    });

    let queuedCount = 0;
    for (const track of album.tracks) {
      if (albumDownloadCancelRef.current) return;
      const saveKey = track.videoId ? `yt-${track.videoId}` : track.id;
      if (getYouTubeSaveStatus(saveKey) === 'saved') {
        queuedCount += 1;
        setAlbumDownloadState({
          albumId: album.deezerAlbumId,
          active: true,
          done: false,
          queued: queuedCount,
          total,
        });
        continue;
      }

      const res = await saveYouTubeTrackToLibrary(catalogTrackToPlayerTrack(track), 'm4a');
      if (res.ok) {
        queuedCount += 1;
      }
      if (albumDownloadCancelRef.current) return;
      setAlbumDownloadState({
        albumId: album.deezerAlbumId,
        active: true,
        done: false,
        queued: queuedCount,
        total,
      });
    }

    if (albumDownloadCancelRef.current) return;
    setAlbumDownloadState({
      albumId: album.deezerAlbumId,
      active: false,
      done: queuedCount > 0,
      queued: queuedCount,
      total,
    });
    onFlashToast(
      queuedCount > 0
        ? `Queued ${queuedCount} of ${total} tracks from "${album.title}"`
        : `Could not queue tracks from "${album.title}"`
    );
  }, [album, albumDownloadState, canDownload, getYouTubeSaveStatus, onFlashToast, saveYouTubeTrackToLibrary]);

  const isTrackActive = (item: DiscoverAlbumTrack) =>
    Boolean(
      currentTrack &&
        ((item.videoId && currentTrack.id === `yt-${item.videoId}`) ||
          currentTrack.id === item.id ||
          (currentTrack.deezerTrackId && currentTrack.deezerTrackId === item.deezerTrackId))
    );

  const isAlbumCurrentlyPlaying = useMemo(() => {
    if (!album || !currentTrack) return false;
    return album.tracks.some((t) => isTrackActive(t)) && isPlaying && !isBuffering;
  }, [album, currentTrack, isBuffering, isPlaying]);

  const isArtistCurrentlyPlaying = useMemo(() => {
    if (!artist || !currentTrack) return false;
    return artist.topTracks.some((t) => isTrackActive(t)) && isPlaying && !isBuffering;
  }, [artist, currentTrack, isBuffering, isPlaying]);

  const heroImageUrl =
    route.type === 'album'
      ? album?.coverUrl || route.coverHint
      : artist?.pictureUrl || route.pictureHint;

  const heroFallbackSeed =
    route.type === 'album'
      ? album?.title || route.titleHint || route.id
      : artist?.name || route.nameHint || route.id;

  const heroFallbackColor = useMemo(() => hashTint(heroFallbackSeed), [heroFallbackSeed]);
  const heroColorCacheKey = useMemo(
    () => `catalog:${route.type}:${route.id}:${heroImageUrl || 'none'}`,
    [heroImageUrl, route.id, route.type]
  );

  const [sampledHeroColor, setSampledHeroColor] = useState<string>(
    () => getCachedDominantColor(heroColorCacheKey) || heroFallbackColor
  );

  useEffect(() => {
    const cached = getCachedDominantColor(heroColorCacheKey);
    if (cached) {
      setSampledHeroColor(cached);
      return;
    }
    setSampledHeroColor(heroFallbackColor);
    if (!heroImageUrl) return;

    let cancelled = false;
    void extractDominantColorFromImage(
      heroImageUrl,
      heroColorCacheKey,
      undefined,
      heroFallbackColor
    ).then((hex) => {
      if (!cancelled) {
        setSampledHeroColor(hex);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [heroColorCacheKey, heroFallbackColor, heroImageUrl]);

  const detailTopHexColor = useMemo(() => {
    if (isTidal) return '#000000';
    if (error) {
      return getUnifiedPageHeaderTopHex(theme);
    }
    return isLight
      ? computeLightTintedTopHex(sampledHeroColor, 0.22)
      : computeNowPlayingTopHex(sampledHeroColor);
  }, [error, isLight, isTidal, sampledHeroColor, theme]);

  // Synchronously match mobile status bar (`meta[name="theme-color"]` & root/body bg)
  // to the top edge of the Artist/Album hero backdrop and restore on Back/unmount.
  useLayoutEffect(() => {
    setDocumentThemeColor(detailTopHexColor);
    return () => {
      setDocumentThemeColor(getUnifiedPageHeaderTopHex(theme));
    };
  }, [detailTopHexColor, theme]);

  const latestRelease = useMemo(() => {
    if (!artist) return null;
    return artist.latestRelease || artist.albums[0] || null;
  }, [artist]);

  const isAlbumDownloading =
    albumDownloadState?.albumId === album?.deezerAlbumId && albumDownloadState?.active;
  const isAlbumQueued =
    albumDownloadState?.albumId === album?.deezerAlbumId && albumDownloadState?.done;

  return (
    <div className="space-y-7">
      {loading ? (
        <div className="space-y-6">
          <div
            className="relative w-full pb-8 overflow-hidden"
            style={{paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))'}}
          >
            <BlurredArtworkBackdrop
              imageUrl={heroImageUrl}
              fallbackSeed={heroFallbackSeed}
              topHexColor={detailTopHexColor}
              isLight={isLight}
            />
            <div className="relative z-10 max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
              <button
                type="button"
                onClick={onBack}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/45 backdrop-blur-md border border-white/15 text-white hover:bg-black/65 transition-colors"
                aria-label="Back to Discover"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>

              <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 sm:gap-7">
                <div
                  className={`w-40 h-40 sm:w-48 sm:h-48 shrink-0 bg-[var(--bg-elevated)] animate-pulse shadow-2xl ${
                    route.type === 'artist' ? 'rounded-full' : 'rounded-xl'
                  }`}
                />
                <div className="space-y-3 w-full max-w-md text-center sm:text-left">
                  <div className="h-3.5 w-20 mx-auto sm:mx-0 rounded bg-[var(--bg-elevated)] animate-pulse" />
                  <div className="h-9 w-3/4 mx-auto sm:mx-0 rounded bg-[var(--bg-elevated)] animate-pulse" />
                  <div className="h-4 w-1/2 mx-auto sm:mx-0 rounded bg-[var(--bg-secondary)] animate-pulse" />
                  <div className="h-11 w-36 mx-auto sm:mx-0 rounded-full bg-[var(--bg-elevated)] animate-pulse" />
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 space-y-2">
            {Array.from({length: 8}).map((_, idx) => (
              <div
                key={idx}
                className="h-14 rounded-lg bg-[var(--bg-secondary)] animate-pulse"
              />
            ))}
          </div>
        </div>
      ) : error ? (
        <div
          className="max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 space-y-5"
          style={{paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))'}}
        >
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-full pr-4 pl-1.5 text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
            aria-label="Back to Discover"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              <ChevronLeft className="w-5 h-5" />
            </span>
            <span>Back to Discover</span>
          </button>

          <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-8 text-center space-y-3">
            <p className="text-base font-semibold text-[var(--text-primary)]">
              Couldn&apos;t load {route.type === 'album' ? 'album' : 'artist'} details
            </p>
            <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">{error}</p>
            <button
              type="button"
              onClick={() => void loadDetail(true)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        </div>
      ) : route.type === 'album' && album ? (
        <div className="space-y-6">
          {/* Album Full-Bleed Blurred Cover-Art Hero (extends flush to y=0 behind status bar) */}
          <div
            className="relative w-full pb-6 overflow-hidden"
            style={{paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))'}}
          >
            <BlurredArtworkBackdrop
              imageUrl={album.coverUrl || route.coverHint}
              fallbackSeed={album.title}
              topHexColor={detailTopHexColor}
              isLight={isLight}
            />

            <div className="relative z-10 max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 space-y-5">
              {/* Top Back Button */}
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={onBack}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/45 backdrop-blur-md border border-white/15 text-white hover:bg-black/65 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  aria-label="Back to Discover"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              </div>

              {/* Cover + Metadata + Actions */}
              <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 sm:gap-7">
                <div className="w-44 h-44 sm:w-52 sm:h-52 lg:w-56 lg:h-56 shrink-0 rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 bg-[var(--bg-elevated)]">
                  <ResilientCover
                    src={album.coverUrl || route.coverHint}
                    alt={album.title}
                    shape="square"
                    label={album.title}
                    className="rounded-xl"
                  />
                </div>

                <div className="min-w-0 flex-1 text-center sm:text-left space-y-2.5">
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">
                    {album.recordType || 'Album'}
                    {album.genre ? ` · ${album.genre}` : ''}
                  </p>
                  <h1
                    className="font-display text-2xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-[var(--text-primary)] leading-[1.1]"
                    style={{textWrap: 'balance'}}
                  >
                    {album.title}
                  </h1>

                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-x-2 gap-y-1.5 text-sm text-[var(--text-secondary)]">
                    {album.artistId ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenArtist({
                            id: album.artistId!,
                            nameHint: album.artist,
                            pictureHint: album.artistPictureUrl,
                          })
                        }
                        className="inline-flex items-center gap-2 font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline transition-colors"
                      >
                        {album.artistPictureUrl && (
                          <img
                            src={album.artistPictureUrl}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="w-5 h-5 rounded-full object-cover ring-1 ring-white/15"
                          />
                        )}
                        <span>{album.artist}</span>
                      </button>
                    ) : (
                      <span className="font-semibold text-[var(--text-primary)]">
                        {album.artist}
                      </span>
                    )}
                    {(album.releaseYear || album.releaseDate) && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {album.releaseYear || album.releaseDate}
                        </span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      {album.tracks.length} {album.tracks.length === 1 ? 'track' : 'tracks'}
                    </span>
                    {album.duration > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{formatTotalRuntime(album.duration)}</span>
                      </>
                    )}
                  </div>

                  {album.tracks.length > 0 && (
                    <div className="pt-2 flex flex-wrap items-center justify-center sm:justify-start gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (isAlbumCurrentlyPlaying) {
                            togglePlay();
                          } else {
                            handlePlayTrackFromList(album.tracks[0], album.tracks);
                          }
                        }}
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] active:scale-[0.98] transition-all whitespace-nowrap shadow-lg"
                      >
                        {isAlbumCurrentlyPlaying ? (
                          <Pause className="w-4 h-4 fill-current" />
                        ) : (
                          <Play className="w-4 h-4 fill-current" />
                        )}
                        <span>{isAlbumCurrentlyPlaying ? 'Pause' : 'Play All'}</span>
                      </button>

                      {canDownload && (
                        <button
                          type="button"
                          disabled={isAlbumDownloading}
                          onClick={() => void handleDownloadAlbum()}
                          className={`inline-flex min-h-[44px] items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                            isAlbumQueued
                              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                              : 'border-[var(--border-strong)] bg-[var(--bg-secondary)]/85 backdrop-blur-sm text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] hover:border-[var(--accent)]'
                          }`}
                        >
                          {isAlbumDownloading ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span className="tabular-nums">
                                Queueing {albumDownloadState?.queued}/{albumDownloadState?.total}...
                              </span>
                            </>
                          ) : isAlbumQueued ? (
                            <>
                              <Check className="w-4 h-4 stroke-[2.5]" />
                              <span>Album Queued</span>
                            </>
                          ) : (
                            <>
                              <Download className="w-4 h-4" />
                              <span>Download Album</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Complete Numbered Album Tracklist */}
          <div className="max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
          <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
            {album.tracks.map((track) => {
              const active = isTrackActive(track);
              const playing = active && isPlaying && !isBuffering;
              const buffering = active && isBuffering;
              const saveKey = track.videoId ? `yt-${track.videoId}` : track.id;
              const saveStatus = getYouTubeSaveStatus(saveKey);
              const subtitleArtists = track.featuredArtists || track.artist;

              return (
                <div
                  key={track.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handlePlayTrackFromList(track, album.tracks)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handlePlayTrackFromList(track, album.tracks);
                    }
                  }}
                  className={`group flex min-h-[58px] items-center gap-3 px-2.5 sm:px-3.5 py-2.5 transition-colors cursor-pointer rounded-lg ${
                    active ? 'bg-[var(--bg-elevated)]' : 'hover:bg-[var(--bg-secondary)]'
                  }`}
                >
                  <div className="w-7 text-center shrink-0">
                    {buffering ? (
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)] mx-auto" />
                    ) : playing ? (
                      <Pause className="w-4 h-4 text-[var(--accent)] fill-current mx-auto" />
                    ) : (
                      <>
                        <span
                          className={`font-mono text-xs tabular-nums group-hover:hidden ${
                            active ? 'text-[var(--accent)] font-bold' : 'text-[var(--text-muted)]'
                          }`}
                        >
                          {track.trackNumber}
                        </span>
                        <Play className="w-3.5 h-3.5 text-[var(--text-primary)] fill-current mx-auto hidden group-hover:block" />
                      </>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm font-semibold truncate ${
                        active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                      }`}
                    >
                      {track.title}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                      {subtitleArtists}
                      {track.explicit ? ' · Explicit' : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
                      {track.duration > 0 ? formatDuration(track.duration) : '--:--'}
                    </span>

                    {canDownload && (
                      <button
                        type="button"
                        disabled={saveStatus === 'saving' || saveStatus === 'saved'}
                        onClick={(e) => void handleSaveCatalogTrack(e, track)}
                        title={
                          saveStatus === 'saved'
                            ? 'Queued for library'
                            : `Download "${track.title}"`
                        }
                        aria-label={`Download ${track.title}`}
                        className={`flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
                          saveStatus === 'saved'
                            ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                            : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                        }`}
                      >
                        {saveStatus === 'saving' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : saveStatus === 'saved' ? (
                          <Check className="w-4 h-4 stroke-[2.5]" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {(album.label || album.releaseDate) && (
            <p className="text-xs text-[var(--text-muted)] pt-1">
              {[album.releaseDate, album.label].filter(Boolean).join(' · ')}
            </p>
          )}
          </div>
        </div>
      ) : route.type === 'artist' && artist ? (
        <div className="space-y-8">
          {/* Artist Full-Bleed Blurred Artwork Hero (extends flush to y=0 behind status bar) */}
          <div
            className="relative w-full pb-6 overflow-hidden"
            style={{paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))'}}
          >
            <BlurredArtworkBackdrop
              imageUrl={artist.pictureUrl || route.pictureHint}
              fallbackSeed={artist.name}
              topHexColor={detailTopHexColor}
              isLight={isLight}
            />

            <div className="relative z-10 max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 space-y-5">
              {/* Top Back Button */}
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={onBack}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/45 backdrop-blur-md border border-white/15 text-white hover:bg-black/65 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  aria-label="Back to Discover"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              </div>

              {/* Portrait + Artist Info + Play CTA */}
              <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 sm:gap-7">
                <div className="w-36 h-36 sm:w-44 sm:h-44 lg:w-48 lg:h-48 shrink-0 rounded-full overflow-hidden shadow-2xl ring-2 ring-white/15 bg-[var(--bg-elevated)]">
                  <ResilientCover
                    src={artist.pictureUrl || route.pictureHint}
                    alt={artist.name}
                    shape="circle"
                    label={artist.name}
                  />
                </div>

                <div className="min-w-0 flex-1 text-center sm:text-left space-y-2.5">
                  <div className="inline-flex items-center gap-2 justify-center sm:justify-start">
                    <span className="rounded-md bg-[var(--accent-soft)] border border-[var(--accent)]/35 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-[var(--accent)]">
                      Discover
                    </span>
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      Artist
                    </span>
                  </div>

                  <h1
                    className="font-display text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-[var(--text-primary)] leading-[1.08]"
                    style={{textWrap: 'balance'}}
                  >
                    {artist.name}
                  </h1>

                  <p className="text-sm text-[var(--text-secondary)] tabular-nums">
                    {[
                      formatFanCount(artist.fans),
                      artist.albumCount > 0 ? `${artist.albumCount} releases` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>

                  {artist.topTracks.length > 0 && (
                    <div className="pt-1.5 flex items-center justify-center sm:justify-start gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (isArtistCurrentlyPlaying) {
                            togglePlay();
                          } else {
                            handlePlayTrackFromList(artist.topTracks[0], artist.topTracks);
                          }
                        }}
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] active:scale-[0.98] transition-all whitespace-nowrap shadow-lg"
                      >
                        {isArtistCurrentlyPlaying ? (
                          <Pause className="w-4 h-4 fill-current" />
                        ) : (
                          <Play className="w-4 h-4 fill-current" />
                        )}
                        <span>{isArtistCurrentlyPlaying ? 'Pause' : 'Play Top Tracks'}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
          {/* Highlighted Latest Release Card */}
          {latestRelease && (
            <section className="space-y-3">
              <h2 className="font-display text-lg font-bold tracking-tight text-[var(--text-primary)]">
                Latest release
              </h2>
              <button
                type="button"
                onClick={() =>
                  onOpenAlbum({
                    id: latestRelease.deezerAlbumId,
                    titleHint: latestRelease.title,
                    artistHint: artist.name,
                    coverHint: latestRelease.coverUrl,
                  })
                }
                className="group w-full max-w-xl flex items-center gap-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-3 text-left transition-colors hover:bg-[var(--bg-elevated)] hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden shrink-0 bg-[var(--bg-elevated)] shadow-md">
                  <ResilientCover
                    src={latestRelease.coverUrl}
                    alt={latestRelease.title}
                    shape="square"
                    label={latestRelease.title}
                    className="rounded-lg transition-transform duration-200 group-hover:scale-[1.04]"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-base font-bold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                    {latestRelease.title}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] truncate">
                    {[latestRelease.recordType, latestRelease.releaseDate]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] group-hover:translate-x-0.5 transition-all">
                  <ChevronRight className="w-5 h-5" />
                </span>
              </button>
            </section>
          )}

          {/* Numbered Top Tracks List (1 to 10+) */}
          {artist.topTracks.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-lg font-bold tracking-tight text-[var(--text-primary)]">
                Top Tracks
              </h2>
              <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {artist.topTracks.map((track) => {
                  const active = isTrackActive(track);
                  const playing = active && isPlaying && !isBuffering;
                  const buffering = active && isBuffering;
                  const saveKey = track.videoId ? `yt-${track.videoId}` : track.id;
                  const saveStatus = getYouTubeSaveStatus(saveKey);

                  return (
                    <div
                      key={track.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handlePlayTrackFromList(track, artist.topTracks)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handlePlayTrackFromList(track, artist.topTracks);
                        }
                      }}
                      className={`group flex min-h-[60px] items-center gap-3 px-2.5 sm:px-3.5 py-2 transition-colors cursor-pointer rounded-lg ${
                        active ? 'bg-[var(--bg-elevated)]' : 'hover:bg-[var(--bg-secondary)]'
                      }`}
                    >
                      <div className="w-6 text-center shrink-0">
                        {buffering ? (
                          <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)] mx-auto" />
                        ) : playing ? (
                          <Pause className="w-4 h-4 text-[var(--accent)] fill-current mx-auto" />
                        ) : (
                          <>
                            <span
                              className={`font-mono text-xs tabular-nums group-hover:hidden ${
                                active ? 'text-[var(--accent)] font-bold' : 'text-[var(--text-muted)]'
                              }`}
                            >
                              {track.trackNumber}
                            </span>
                            <Play className="w-3.5 h-3.5 text-[var(--text-primary)] fill-current mx-auto hidden group-hover:block" />
                          </>
                        )}
                      </div>

                      <div className="w-11 h-11 rounded-md overflow-hidden shrink-0 bg-[var(--bg-elevated)] shadow-sm">
                        <ResilientCover
                          src={track.coverUrl}
                          alt={track.album}
                          shape="square"
                          label={track.title}
                          className="rounded-md"
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-sm font-semibold truncate ${
                            active ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                          }`}
                        >
                          {track.title}
                        </p>
                        <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                          {track.featuredArtists || track.artist}
                          {track.album && track.album !== track.title ? ` · ${track.album}` : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
                          {track.duration > 0 ? formatDuration(track.duration) : '--:--'}
                        </span>

                        {canDownload && (
                          <button
                            type="button"
                            disabled={saveStatus === 'saving' || saveStatus === 'saved'}
                            onClick={(e) => void handleSaveCatalogTrack(e, track)}
                            title={
                              saveStatus === 'saved'
                                ? 'Queued for library'
                                : `Download "${track.title}"`
                            }
                            aria-label={`Download ${track.title}`}
                            className={`flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
                              saveStatus === 'saved'
                                ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                                : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                            }`}
                          >
                            {saveStatus === 'saving' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : saveStatus === 'saved' ? (
                              <Check className="w-4 h-4 stroke-[2.5]" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Discography / Albums */}
          {artist.albums.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold tracking-tight text-[var(--text-primary)]">
                  Discography
                </h2>
                <span className="text-xs text-[var(--text-muted)] tabular-nums">
                  {artist.albums.length} {artist.albums.length === 1 ? 'release' : 'releases'}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3.5">
                {artist.albums.map((alb) => (
                  <button
                    key={alb.id}
                    type="button"
                    onClick={() =>
                      onOpenAlbum({
                        id: alb.deezerAlbumId,
                        titleHint: alb.title,
                        artistHint: artist.name,
                        coverHint: alb.coverUrl,
                      })
                    }
                    className="group rounded-xl p-2 text-left transition-colors hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <div className="aspect-square w-full rounded-lg overflow-hidden bg-[var(--bg-elevated)] shadow-md">
                      <ResilientCover
                        src={alb.coverUrl}
                        alt={alb.title}
                        shape="square"
                        label={alb.title}
                        className="rounded-lg transition-transform duration-200 group-hover:scale-[1.03]"
                      />
                    </div>
                    <p className="mt-2.5 text-sm font-semibold text-[var(--text-primary)] truncate">
                      {alb.title}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                      {[alb.recordType, alb.releaseDate].filter(Boolean).join(' · ')}
                    </p>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Fans Also Like */}
          {artist.relatedArtists.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-lg font-bold tracking-tight text-[var(--text-primary)]">
                Fans Also Like
              </h2>
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 sm:-mx-2 sm:px-2 snap-x snap-mandatory no-scrollbar lg:grid lg:grid-cols-6 xl:grid-cols-8 lg:overflow-visible lg:mx-0 lg:px-0">
                {artist.relatedArtists.map((rel) => (
                  <button
                    key={rel.id}
                    type="button"
                    onClick={() => {
                      if (rel.deezerArtistId) {
                        onOpenArtist({
                          id: rel.deezerArtistId,
                          nameHint: rel.name,
                          pictureHint: rel.thumbnailUrl,
                        });
                      }
                    }}
                    className="group w-[128px] sm:w-[144px] lg:w-auto shrink-0 snap-start rounded-xl p-2 text-center transition-colors hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <div className="aspect-square w-full rounded-full overflow-hidden bg-[var(--bg-elevated)] shadow-md ring-1 ring-[var(--border-subtle)]">
                      <ResilientCover
                        src={rel.thumbnailUrl}
                        alt={rel.name}
                        shape="circle"
                        label={rel.name}
                        className="transition-transform duration-200 group-hover:scale-[1.04]"
                      />
                    </div>
                    <p className="mt-2 text-sm font-semibold text-[var(--text-primary)] truncate">
                      {rel.name}
                    </p>
                  </button>
                ))}
              </div>
            </section>
          )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
