import {
  ArrowLeft,
  Check,
  Disc3,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
} from 'lucide-react';
import React, {useCallback, useEffect, useState} from 'react';
import {usePlayer} from '../context/PlayerContext';
import {
  apiFetch,
  formatDuration,
  getCatalogMatchStreamUrl,
  prefetchYouTubeStreams,
} from '../lib/api';
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
  if (fans >= 1_000) return `${Math.round(fans / 1_000)}K fans`;
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

interface CatalogDetailViewProps {
  route: CatalogRoute;
  canDownload: boolean;
  onBack: () => void;
  onOpenAlbum: (album: {id: string; titleHint?: string; artistHint?: string; coverHint?: string}) => void;
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

  // Background prefetch top 3 tracks whenever an album or artist view opens
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

  const handlePlayTrackFromList = useCallback(
    (clicked: DiscoverAlbumTrack, list: DiscoverAlbumTrack[]) => {
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

  const isTrackActive = (item: DiscoverAlbumTrack) =>
    Boolean(
      currentTrack &&
        ((item.videoId && currentTrack.id === `yt-${item.videoId}`) ||
          currentTrack.id === item.id ||
          (currentTrack.deezerTrackId && currentTrack.deezerTrackId === item.deezerTrackId))
    );

  const headerTitle =
    route.type === 'album'
      ? album?.title || route.titleHint || 'Album'
      : artist?.name || route.nameHint || 'Artist';

  return (
    <div className="space-y-6">
      {/* Compact Sticky Back Bar */}
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-2.5 bg-[var(--bg-glass)] backdrop-blur-md border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-full pr-3 pl-1 text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors whitespace-nowrap shrink-0"
          aria-label="Back to Discover"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <ArrowLeft className="w-4 h-4" />
          </span>
          <span>Back</span>
        </button>

        <p className="text-sm font-semibold text-[var(--text-primary)] truncate min-w-0 flex-1 text-center">
          {headerTitle}
        </p>

        <div className="w-[72px] shrink-0" aria-hidden="true" />
      </div>

      {loading ? (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5">
            <div
              className={`w-44 h-44 sm:w-52 sm:h-52 shrink-0 bg-[var(--bg-elevated)] animate-pulse ${
                route.type === 'artist' ? 'rounded-full' : 'rounded-2xl'
              }`}
            />
            <div className="space-y-3 w-full max-w-md text-center sm:text-left">
              <div className="h-7 w-3/4 mx-auto sm:mx-0 rounded bg-[var(--bg-elevated)] animate-pulse" />
              <div className="h-4 w-1/2 mx-auto sm:mx-0 rounded bg-[var(--bg-secondary)] animate-pulse" />
              <div className="h-11 w-36 mx-auto sm:mx-0 rounded-full bg-[var(--bg-elevated)] animate-pulse" />
            </div>
          </div>
          <div className="space-y-2">
            {Array.from({length: 8}).map((_, idx) => (
              <div
                key={idx}
                className="h-14 rounded-lg bg-[var(--bg-secondary)] animate-pulse"
              />
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 text-center space-y-3">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
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
      ) : route.type === 'album' && album ? (
        <div className="space-y-6">
          {/* Album Hero */}
          <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 sm:gap-6">
            <div className="w-44 h-44 sm:w-52 sm:h-52 shrink-0 rounded-2xl overflow-hidden shadow-xl bg-[var(--bg-elevated)]">
              <ResilientCover
                src={album.coverUrl || route.coverHint}
                alt={album.title}
                shape="square"
                label={album.title}
              />
            </div>

            <div className="min-w-0 flex-1 text-center sm:text-left space-y-2">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                Album
                {album.genre ? ` · ${album.genre}` : ''}
              </p>
              <h1
                className="font-display text-2xl sm:text-4xl font-extrabold tracking-tight text-[var(--text-primary)] leading-tight"
                style={{textWrap: 'balance'}}
              >
                {album.title}
              </h1>

              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-x-2 gap-y-1 text-sm text-[var(--text-secondary)]">
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
                    className="font-semibold text-[var(--text-primary)] hover:underline"
                  >
                    {album.artist}
                  </button>
                ) : (
                  <span className="font-semibold text-[var(--text-primary)]">{album.artist}</span>
                )}
                {album.releaseDate && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{album.releaseDate}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {album.tracks.length} {album.tracks.length === 1 ? 'track' : 'tracks'}
                </span>
                {album.duration > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{formatTotalRuntime(album.duration)}</span>
                  </>
                )}
              </div>

              {album.tracks.length > 0 && (
                <div className="pt-2 flex items-center justify-center sm:justify-start gap-3">
                  <button
                    type="button"
                    onClick={() => handlePlayTrackFromList(album.tracks[0], album.tracks)}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors whitespace-nowrap"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span>Play Album</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Numbered Album Tracklist */}
          <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
            {album.tracks.map((track) => {
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
                  onClick={() => handlePlayTrackFromList(track, album.tracks)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handlePlayTrackFromList(track, album.tracks);
                    }
                  }}
                  className={`group flex min-h-[56px] items-center gap-3 px-2.5 sm:px-3 py-2.5 transition-colors cursor-pointer ${
                    active
                      ? 'bg-[var(--bg-elevated)]'
                      : 'hover:bg-[var(--bg-secondary)]'
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
                      {track.artist}
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
                            : `Save "${track.title}" to library`
                        }
                        aria-label={`Save ${track.title} to library`}
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
                          <Plus className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {album.label && (
            <p className="text-xs text-[var(--text-muted)] pt-1">
              {album.label}
              {album.releaseDate ? ` · ${album.releaseDate}` : ''}
            </p>
          )}
        </div>
      ) : route.type === 'artist' && artist ? (
        <div className="space-y-8">
          {/* Artist Hero */}
          <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 sm:gap-6">
            <div className="w-36 h-36 sm:w-44 sm:h-44 shrink-0 rounded-full overflow-hidden shadow-xl ring-1 ring-[var(--border-subtle)] bg-[var(--bg-elevated)]">
              <ResilientCover
                src={artist.pictureUrl || route.pictureHint}
                alt={artist.name}
                shape="circle"
                label={artist.name}
              />
            </div>

            <div className="min-w-0 flex-1 text-center sm:text-left space-y-2">
              <p className="text-xs font-medium text-[var(--text-secondary)]">Artist</p>
              <h1
                className="font-display text-2xl sm:text-4xl font-extrabold tracking-tight text-[var(--text-primary)] leading-tight"
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
                <div className="pt-2 flex items-center justify-center sm:justify-start gap-3">
                  <button
                    type="button"
                    onClick={() => handlePlayTrackFromList(artist.topTracks[0], artist.topTracks)}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors whitespace-nowrap"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span>Play Top Tracks</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Popular Tracks */}
          {artist.topTracks.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-lg font-bold tracking-tight text-[var(--text-primary)]">
                Popular Tracks
              </h2>
              <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {artist.topTracks.slice(0, 15).map((track) => {
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
                      className={`group flex min-h-[58px] items-center gap-3 px-2.5 sm:px-3 py-2 transition-colors cursor-pointer ${
                        active
                          ? 'bg-[var(--bg-elevated)]'
                          : 'hover:bg-[var(--bg-secondary)]'
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

                      <div className="w-11 h-11 rounded-lg overflow-hidden shrink-0 bg-[var(--bg-elevated)]">
                        <ResilientCover
                          src={track.coverUrl}
                          alt={track.album}
                          shape="square"
                          label={track.title}
                          className="rounded-lg"
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
                          {track.album}
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
                                : `Save "${track.title}" to library`
                            }
                            aria-label={`Save ${track.title} to library`}
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
                              <Plus className="w-4 h-4" />
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

          {/* Artist Discography */}
          {artist.albums.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-lg font-bold tracking-tight text-[var(--text-primary)]">
                Albums &amp; Releases
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
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
                      {[alb.releaseDate, alb.recordType].filter(Boolean).join(' · ')}
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
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 sm:-mx-2 sm:px-2 snap-x snap-mandatory no-scrollbar">
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
                    className="group w-[128px] sm:w-[144px] shrink-0 snap-start rounded-xl p-2 text-center transition-colors hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
      ) : null}
    </div>
  );
};
