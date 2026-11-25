import {
  ArrowDownCircle,
  CheckCircle2,
  Heart,
  Library,
  ListPlus,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  X,
} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useOfflineLibrary} from '../hooks/useOfflineLibrary';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {
  apiFetch,
  formatDuration,
  getCatalogMatchStreamUrl,
  getYouTubeThumbProxyUrl,
} from '../lib/api';
import type {DiscoverAlbumTrack, DiscoverSearchResponse, Playlist, Track} from '../types';
import {getOfflinePlaylists, getOfflineTracks} from '../utils/offlineStore';
import {AlbumArt} from './AlbumArt';

const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function catalogTrackToPlayable(item: DiscoverAlbumTrack): Track {
  const hasVid = typeof item.videoId === 'string' && YT_VIDEO_ID_RE.test(item.videoId);
  const trackId = hasVid
    ? `yt-${item.videoId}`
    : item.id || `dz-track-${item.deezerTrackId || `${item.artist}-${item.title}`}`;
  const coverUrl =
    item.coverUrl || (hasVid ? getYouTubeThumbProxyUrl(item.videoId!) : undefined);
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
    album: item.album || 'Online',
    track_number: item.trackNumber ?? null,
    year: null,
    duration: item.duration || 0,
    format: 'm4a',
    bitrate: 0,
    size_bytes: 0,
    cover_file: null,
    dominant_color: '#1f2937',
    added_at: '',
    liked: false,
    coverUrl,
    streamUrl,
    isYouTubeStream: true,
    youtubeUrl: hasVid ? `https://www.youtube.com/watch?v=${item.videoId}` : undefined,
    deezerTrackId: item.deezerTrackId,
    deezerAlbumId: item.albumId,
    deezerArtistId: item.artistId,
    recommendation: {source: 'discover'},
  };
}

function formatDisplayTitle(title: string): string {
  const cleaned = title.replace(/^\s*\d{1,3}(?:\.|\)|\s+-)\s+/, '').trim();
  return cleaned || title;
}

interface DesktopBrowsePaneProps {
  onCollapse: () => void;
  onToast: (msg: string) => void;
}

export const DesktopBrowsePane: React.FC<DesktopBrowsePaneProps> = ({onCollapse, onToast}) => {
  const {isOfflineMode} = useAuth();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const {
    currentTrack,
    isPlaying,
    playTrack,
    togglePlay,
    addToQueue,
    playNextInQueue,
    startRadio,
    toggleLikeTrack,
    libraryRefreshVersion,
    bumpLibraryRefresh,
  } = usePlayer();
  const {
    supported: offlineSupported,
    cachedTrackIds,
    downloadingTrackIds,
    downloadTrack,
    removeTrack,
  } = useOfflineLibrary();

  const [tab, setTab] = useState<'all' | 'liked'>('all');
  const [query, setQuery] = useState('');
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [onlineTracks, setOnlineTracks] = useState<Track[]>([]);
  const [searchingOnline, setSearchingOnline] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    track: Track;
    top: number;
    left: number;
  } | null>(null);
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Load library tracks and playlists
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingLibrary(true);
      try {
        if (offline) {
          const [offTracks, offPlaylists] = await Promise.all([
            getOfflineTracks(),
            getOfflinePlaylists(),
          ]);
          if (!cancelled) {
            setLibraryTracks(offTracks);
            setPlaylists(offPlaylists);
          }
          return;
        }
        const [tracksRes, playlistsRes] = await Promise.all([
          apiFetch<{tracks: Track[]}>('/api/tracks'),
          apiFetch<{playlists: Playlist[]}>('/api/playlists'),
        ]);
        if (!cancelled) {
          setLibraryTracks(tracksRes.tracks || []);
          setPlaylists(playlistsRes.playlists || []);
        }
      } catch {
        const offTracks = await getOfflineTracks();
        if (!cancelled) setLibraryTracks(offTracks);
      } finally {
        if (!cancelled) setLoadingLibrary(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [offline, libraryRefreshVersion]);

  // Debounced online search when typing >= 2 chars while online
  useEffect(() => {
    const trimmed = query.trim();
    if (offline || trimmed.length < 2) {
      setOnlineTracks([]);
      setSearchingOnline(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchingOnline(true);
      try {
        const res = await apiFetch<DiscoverSearchResponse>(
          `/api/discover/search?q=${encodeURIComponent(trimmed)}`,
          {signal: controller.signal}
        );
        if (!cancelled) {
          const converted = (res.tracks || []).slice(0, 12).map(catalogTrackToPlayable);
          setOnlineTracks(converted);
        }
      } catch {
        if (!cancelled) setOnlineTracks([]);
      } finally {
        if (!cancelled) setSearchingOnline(false);
      }
    }, 380);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [offline, query]);

  // Dismiss context menu on outside click, escape, or scroll
  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setShowPlaylistSubmenu(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setShowPlaylistSubmenu(false);
      }
    };
    const onScroll = () => {
      setContextMenu(null);
      setShowPlaylistSubmenu(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [contextMenu]);

  const filteredLibraryTracks = useMemo(() => {
    const base = tab === 'liked' ? libraryTracks.filter((t) => Boolean(t.liked)) : libraryTracks;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        (t.album || '').toLowerCase().includes(q)
    );
  }, [libraryTracks, query, tab]);

  const openMenuAt = useCallback((track: Track, clientX: number, clientY: number) => {
    const menuWidth = 220;
    const menuHeight = 260;
    const left = Math.max(10, Math.min(clientX, window.innerWidth - menuWidth - 10));
    const top = Math.max(10, Math.min(clientY, window.innerHeight - menuHeight - 10));
    setShowPlaylistSubmenu(false);
    setContextMenu({track, top, left});
  }, []);

  const handleToggleOffline = useCallback(
    async (track: Track) => {
      setContextMenu(null);
      if (typeof track.id !== 'number') return;
      if (downloadingTrackIds.has(track.id)) return;
      if (cachedTrackIds.has(track.id)) {
        try {
          await removeTrack(track.id);
          onToast('Removed from offline storage');
        } catch (err) {
          onToast(err instanceof Error ? err.message : 'Could not remove offline copy');
        }
        return;
      }
      if (offline || !offlineSupported) {
        onToast('Offline download unavailable right now');
        return;
      }
      try {
        await downloadTrack(track);
        onToast(`Saved "${track.title}" for offline playback`);
      } catch (err) {
        onToast(err instanceof Error ? err.message : 'Offline download failed');
      }
    },
    [cachedTrackIds, downloadTrack, downloadingTrackIds, offline, offlineSupported, onToast, removeTrack]
  );

  const handleAddToPlaylist = useCallback(
    async (playlistId: number, trackId: number, playlistName: string) => {
      try {
        await apiFetch(`/api/playlists/${playlistId}/tracks`, {
          method: 'POST',
          body: JSON.stringify({trackId}),
        });
        bumpLibraryRefresh();
        onToast(`Added to ${playlistName}`);
      } catch (err) {
        onToast(err instanceof Error ? err.message : 'Failed to add to playlist');
      } finally {
        setContextMenu(null);
        setShowPlaylistSubmenu(false);
      }
    },
    [bumpLibraryRefresh, onToast]
  );

  const renderTrackRow = (track: Track, list: Track[]) => {
    const isActive = currentTrack?.id === track.id;
    const isRowPlaying = isActive && isPlaying;
    return (
      <div
        key={String(track.id)}
        role="listitem"
        onContextMenu={(e) => {
          e.preventDefault();
          openMenuAt(track, e.clientX, e.clientY);
        }}
        className={`group flex items-center gap-[clamp(0.625rem,0.75vw,0.9rem)] rounded-lg px-[clamp(0.5rem,0.65vw,0.85rem)] py-[clamp(0.4rem,0.48vw,0.68rem)] transition-colors select-none ${
          isActive
            ? 'bg-[var(--bg-elevated)]/90'
            : 'hover:bg-[var(--bg-hover)]/80'
        }`}
      >
        <button
          type="button"
          onClick={() => {
            if (isActive) {
              togglePlay();
            } else {
              playTrack(track, list);
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-[clamp(0.625rem,0.75vw,0.9rem)] text-left cursor-pointer"
        >
          <div className="relative w-[clamp(2.5rem,2.15rem_+_0.68vw,3.25rem)] h-[clamp(2.5rem,2.15rem_+_0.68vw,3.25rem)] shrink-0 rounded overflow-hidden">
            <AlbumArt
              coverFile={track.cover_file}
              externalUrl={track.coverUrl}
              alt={track.title}
              color={track.dominant_color}
              className="w-full h-full rounded"
              iconSize={16}
            />
            <span
              className={`absolute inset-0 flex items-center justify-center bg-black/55 text-white transition-opacity ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              {isRowPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p
              className={`text-[clamp(0.875rem,0.7rem_+_0.26vw,1.125rem)] font-medium truncate leading-snug ${
                isActive ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
              }`}
            >
              {formatDisplayTitle(track.title)}
            </p>
            <p className="text-[clamp(0.75rem,0.62rem_+_0.22vw,0.9375rem)] text-[var(--text-secondary)] truncate leading-snug">
              {track.artist}
            </p>
          </div>
        </button>

        <div className="flex items-center gap-1 shrink-0">
          <span className="font-mono text-[clamp(0.75rem,0.64rem_+_0.18vw,0.875rem)] tabular-nums text-[var(--text-muted)] group-hover:hidden">
            {formatDuration(track.duration)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              openMenuAt(track, rect.right - 220, rect.bottom + 4);
            }}
            className="hidden group-hover:flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            aria-label={`Options for ${track.title}`}
            title="Track options"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  const menuTrack = contextMenu?.track ?? null;
  const menuNumericId = menuTrack && typeof menuTrack.id === 'number' ? menuTrack.id : null;
  const menuIsCached = menuNumericId !== null && cachedTrackIds.has(menuNumericId);
  const menuIsDownloading = menuNumericId !== null && downloadingTrackIds.has(menuNumericId);

  return (
    <aside
      aria-label="Library and search"
      className="w-[clamp(240px,24%,300px)] xl:w-[clamp(300px,24%,460px)] shrink-0 flex flex-col min-h-0 border-r border-[var(--border-subtle)] bg-[var(--np-lyrics-bg)]/55 backdrop-blur-md"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-[clamp(0.875rem,1.15vw,1.5rem)] py-[clamp(0.75rem,0.9vw,1.125rem)] border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Library className="w-[clamp(1rem,1.05vw,1.2rem)] h-[clamp(1rem,1.05vw,1.2rem)] text-[var(--accent)] shrink-0" />
          <h2 className="font-display text-[clamp(0.875rem,0.75rem_+_0.24vw,1.125rem)] font-bold text-[var(--text-primary)] truncate">
            Library
          </h2>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center rounded-md bg-[var(--bg-primary)]/60 p-0.5 border border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={() => setTab('all')}
              className={`px-2.5 py-0.5 text-[clamp(0.7rem,0.62rem_+_0.14vw,0.825rem)] font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
                tab === 'all'
                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Songs
            </button>
            <button
              type="button"
              onClick={() => setTab('liked')}
              className={`px-2.5 py-0.5 text-[clamp(0.7rem,0.62rem_+_0.14vw,0.825rem)] font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
                tab === 'liked'
                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Liked
            </button>
          </div>
          <button
            type="button"
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            title="Collapse library pane"
            aria-label="Collapse library pane"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Inline Search */}
      <div className="px-[clamp(0.75rem,1vw,1.25rem)] py-[clamp(0.6rem,0.75vw,0.9rem)] border-b border-[var(--border-subtle)] shrink-0">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={offline ? 'Filter offline library...' : 'Search library or online...'}
            aria-label="Search library or online"
            className="w-full rounded-lg bg-[var(--bg-input)]/85 border border-[var(--border-subtle)] pl-9 pr-8 py-[clamp(0.45rem,0.55vw,0.65rem)] text-[clamp(0.78rem,0.66rem_+_0.2vw,0.9375rem)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Track List */}
      <div className="flex-1 overflow-y-auto px-[clamp(0.625rem,0.9vw,1.15rem)] py-[clamp(0.625rem,0.9vw,1.15rem)] space-y-4">
        {loadingLibrary ? (
          <div className="flex items-center justify-center py-12 gap-2 text-[clamp(0.78rem,0.66rem_+_0.2vw,0.9375rem)] text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
            <span>Loading library...</span>
          </div>
        ) : (
          <>
            <section className="space-y-[clamp(0.2rem,0.3vw,0.45rem)]" role="list" aria-label="Library tracks">
              {filteredLibraryTracks.length === 0 ? (
                <p className="px-2 py-4 text-xs text-[var(--text-muted)] text-center">
                  {query.trim()
                    ? 'No matching tracks in your library.'
                    : tab === 'liked'
                      ? 'No liked tracks yet.'
                      : 'Your library is empty.'}
                </p>
              ) : (
                filteredLibraryTracks.slice(0, 150).map((t) => renderTrackRow(t, filteredLibraryTracks))
              )}
              {filteredLibraryTracks.length > 150 && (
                <p className="px-2 pt-2 text-[11px] text-[var(--text-muted)] text-center">
                  Showing first 150 of{' '}
                  <span className="font-mono tabular-nums">{filteredLibraryTracks.length}</span>{' '}
                  tracks — type to filter
                </p>
              )}
            </section>

            {!offline && query.trim().length >= 2 && (
              <section className="pt-2 border-t border-[var(--border-subtle)] space-y-1">
                <div className="flex items-center justify-between px-2 pb-1">
                  <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
                    Online results
                  </span>
                  {searchingOnline && (
                    <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />
                  )}
                </div>
                {!searchingOnline && onlineTracks.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-[var(--text-muted)]">No online matches.</p>
                ) : (
                  <div role="list" aria-label="Online search results" className="space-y-1">
                    {onlineTracks.map((t) => renderTrackRow(t, onlineTracks))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {/* Right-click & "..." Context Menu (reusing TrackTable actions) */}
      {contextMenu && menuTrack && (
        <div
          ref={menuRef}
          style={{top: `${contextMenu.top}px`, left: `${contextMenu.left}px`}}
          className="fixed z-50 w-56 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-strong)] p-1.5 shadow-2xl"
        >
          <button
            type="button"
            onClick={() => {
              playNextInQueue(menuTrack);
              setContextMenu(null);
              onToast('Playing next');
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <Play className="w-4 h-4 text-[var(--text-secondary)]" />
            Play Next
          </button>
          <button
            type="button"
            onClick={() => {
              addToQueue(menuTrack);
              setContextMenu(null);
              onToast('Added to queue');
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            <ListPlus className="w-4 h-4 text-[var(--text-secondary)]" />
            Add to Queue
          </button>
          {!offline && (
            <button
              type="button"
              onClick={() => {
                startRadio(menuTrack);
                setContextMenu(null);
                onToast('Starting radio...');
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <Radio className="w-4 h-4 text-[var(--accent)]" />
              Start Radio
            </button>
          )}
          {menuNumericId !== null && !offline && (
            <button
              type="button"
              onClick={() => {
                void toggleLikeTrack(menuNumericId).then((liked) => {
                  if (liked !== null) {
                    setLibraryTracks((prev) =>
                      prev.map((t) => (t.id === menuNumericId ? {...t, liked} : t))
                    );
                  }
                });
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <Heart
                className={`w-4 h-4 ${
                  menuTrack.liked ? 'fill-current text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                }`}
              />
              {menuTrack.liked ? 'Remove from Liked' : 'Save to Liked'}
            </button>
          )}
          {menuNumericId !== null && (
            <button
              type="button"
              disabled={menuIsDownloading || (!menuIsCached && offline)}
              onClick={() => void handleToggleOffline(menuTrack)}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 cursor-pointer"
            >
              {menuIsDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
              ) : menuIsCached ? (
                <CheckCircle2 className="w-4 h-4 text-[var(--accent)]" />
              ) : (
                <ArrowDownCircle className="w-4 h-4 text-[var(--text-secondary)]" />
              )}
              {menuIsDownloading
                ? 'Downloading Offline...'
                : menuIsCached
                  ? 'Remove Offline Download'
                  : 'Download for Offline'}
            </button>
          )}
          {menuNumericId !== null && !offline && (
            <>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => setShowPlaylistSubmenu((s) => !s)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <span className="flex items-center gap-2.5">
                  <Plus className="w-4 h-4 text-[var(--text-secondary)]" />
                  Add to Playlist
                </span>
                <span className="text-xs text-[var(--text-secondary)]">
                  {showPlaylistSubmenu ? '▾' : '▸'}
                </span>
              </button>
              {showPlaylistSubmenu && (
                <div className="mt-1 max-h-36 overflow-y-auto rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-1 space-y-0.5">
                  {playlists.length === 0 ? (
                    <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">No playlists yet</p>
                  ) : (
                    playlists.map((pl) => (
                      <button
                        key={pl.id}
                        type="button"
                        onClick={() => void handleAddToPlaylist(pl.id, menuNumericId, pl.name)}
                        className="block w-full truncate rounded px-2.5 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        {pl.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
};
