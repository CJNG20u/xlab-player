import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Link2,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  WifiOff,
  X,
  XCircle,
} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlbumArt} from '../components/AlbumArt';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useOfflineLibrary} from '../hooks/useOfflineLibrary';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {apiFetch, formatDuration, getSSEUrl} from '../lib/api';
import type {DownloadJob, MetadataPreviewItem, Track} from '../types';
import {getOfflineTracks, subscribeOfflineStore} from '../utils/offlineStore';

interface EditablePreviewItem extends MetadataPreviewItem {
  selected: boolean;
  format: 'm4a' | 'opus';
}

export const SearchPage: React.FC = () => {
  const {user, isOfflineMode} = useAuth();
  const {
    currentTrack,
    playTrackById,
    playTrack,
    bumpLibraryRefresh,
    libraryRefreshVersion,
    isPlaying,
    togglePlay,
  } = usePlayer();
  const {cachedTrackIds} = useOfflineLibrary();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const canDownload = Boolean(user?.can_download || user?.role === 'admin');

  const [query, setQuery] = useState('');
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);

  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // YouTube (yt-dlp) search results state
  const [searchResults, setSearchResults] = useState<MetadataPreviewItem[]>([]);
  const [lastSearchTerm, setLastSearchTerm] = useState<string | null>(null);
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null);
  const [quickQueueingId, setQuickQueueingId] = useState<string | null>(null);
  const [quickQueuedIds, setQuickQueuedIds] = useState<Set<string>>(new Set());
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Single-track OR Playlist Metadata Editor state
  const [previewItems, setPreviewItems] = useState<EditablePreviewItem[]>([]);
  const [isPlaylistPreview, setIsPlaylistPreview] = useState(false);
  const [playlistTitle, setPlaylistTitle] = useState<string | null>(null);
  const [defaultFormat, setDefaultFormat] = useState<'m4a' | 'opus'>('m4a');
  const [enqueueing, setEnqueueing] = useState(false);
  const [actionToast, setActionToast] = useState<string | null>(null);

  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [expandedErrorId, setExpandedErrorId] = useState<number | null>(null);

  const [publicInfo, setPublicInfo] = useState<{
    musicDir: string;
    ytdlpInstalled: boolean;
    ffmpegInstalled: boolean;
  } | null>(null);

  const metadataEditorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const trimmedQuery = query.trim();
  const isUrlInput = /^https?:\/\//i.test(trimmedQuery);

  const flashToast = useCallback((msg: string) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2800);
  }, []);

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.removeAttribute('src');
      previewAudioRef.current.load();
    }
    setPreviewingId(null);
    setPreviewLoadingId(null);
  }, []);

  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current.removeAttribute('src');
      }
    };
  }, []);

  // Load local /music library (or cached offline tracks when offline) for instant live filtering
  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    if (offline) {
      try {
        const cached = await getOfflineTracks();
        setLibraryTracks(cached);
      } catch {
        setLibraryTracks([]);
      } finally {
        setLibraryLoading(false);
      }
      return;
    }

    try {
      const res = await apiFetch<{tracks: Track[]}>('/api/tracks');
      setLibraryTracks(res.tracks || []);
    } catch {
      try {
        const cached = await getOfflineTracks();
        setLibraryTracks(cached);
      } catch {
        setLibraryTracks([]);
      }
    } finally {
      setLibraryLoading(false);
    }
  }, [offline]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary, libraryRefreshVersion]);

  useEffect(() => {
    if (!offline) return;
    return subscribeOfflineStore(() => {
      void loadLibrary();
    });
  }, [offline, loadLibrary]);

  // Live filter local /music tracks as the user types (title, artist, or album)
  const localMatches = useMemo(() => {
    if (!trimmedQuery || isUrlInput) return [];
    const tokens = trimmedQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    return libraryTracks.filter((track) => {
      const haystack = `${track.title || ''} ${track.artist || ''} ${track.album || ''}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [isUrlInput, libraryTracks, trimmedQuery]);

  // Map active/recent download jobs by URL so YouTube result rows display live progress inline
  const jobByUrl = useMemo(() => {
    const map = new Map<string, DownloadJob>();
    for (const job of jobs) {
      if (!map.has(job.url)) {
        map.set(job.url, job);
      }
    }
    return map;
  }, [jobs]);

  const loadInfo = useCallback(async () => {
    if (offline) return;
    try {
      const info = await apiFetch<{
        musicDir: string;
        ytdlpInstalled: boolean;
        ffmpegInstalled: boolean;
      }>('/api/admin/public-info');
      setPublicInfo(info);
    } catch {
      // ignore
    }
  }, [offline]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  // Connect to SSE stream for live download progress
  useEffect(() => {
    if (!canDownload || offline) return;
    const es = new EventSource(getSSEUrl('/api/download/events'));

    es.addEventListener('init', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {jobs: DownloadJob[]};
        setJobs(data.jobs || []);
      } catch {
        // ignore
      }
    });

    es.addEventListener('job', (event) => {
      try {
        const job = JSON.parse((event as MessageEvent).data) as DownloadJob;
        setJobs((prev) => {
          const exists = prev.some((j) => j.id === job.id);
          if (exists) return prev.map((j) => (j.id === job.id ? job : j));
          return [job, ...prev];
        });
        if (job.status === 'completed') {
          bumpLibraryRefresh();
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener('deleted', (event) => {
      try {
        const {id} = JSON.parse((event as MessageEvent).data) as {id: number};
        setJobs((prev) => prev.filter((j) => j.id !== id));
      } catch {
        // ignore
      }
    });

    return () => {
      es.close();
    };
  }, [bumpLibraryRefresh, canDownload, offline]);

  const handleTogglePreview = useCallback(
    (e: React.MouseEvent, item: MetadataPreviewItem) => {
      e.stopPropagation();
      if (previewingId === item.id || previewLoadingId === item.id) {
        stopPreview();
        return;
      }
      if (isPlaying) {
        togglePlay();
      }
      if (!previewAudioRef.current) {
        previewAudioRef.current = new Audio();
      }
      const audio = previewAudioRef.current;
      audio.pause();
      setPreviewLoadingId(item.id);
      setPreviewingId(null);

      audio.onplaying = () => {
        setPreviewLoadingId(null);
        setPreviewingId(item.id);
      };
      audio.onended = () => {
        setPreviewingId(null);
        setPreviewLoadingId(null);
      };
      audio.onerror = () => {
        setPreviewingId(null);
        setPreviewLoadingId(null);
        flashToast('Preview unavailable for this track');
      };

      audio.src = getSSEUrl(`/api/download/preview-audio?url=${encodeURIComponent(item.url)}`);
      void audio.play().catch(() => {
        setPreviewLoadingId(null);
        setPreviewingId(null);
      });
    },
    [flashToast, isPlaying, previewLoadingId, previewingId, stopPreview, togglePlay]
  );

  const handlePlayLocalTrack = useCallback(
    (track: Track) => {
      stopPreview();
      if (currentTrack?.id === track.id) {
        togglePlay();
      } else {
        playTrack(track, localMatches.length > 0 ? localMatches : [track]);
      }
    },
    [currentTrack?.id, localMatches, playTrack, stopPreview, togglePlay]
  );

  const handleFetchMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedQuery || !canDownload) return;
    if (offline) {
      setMetaError('YouTube search requires an internet connection.');
      return;
    }

    stopPreview();
    setFetchingMeta(true);
    setMetaError(null);
    setPreviewItems([]);
    setIsPlaylistPreview(false);
    setPlaylistTitle(null);
    setSearchResults([]);
    setLastSearchTerm(null);
    setActiveSearchResultId(null);
    setQuickQueuedIds(new Set());

    try {
      const res = await apiFetch<{
        mode?: 'search' | 'single' | 'playlist';
        isSearch?: boolean;
        isPlaylist: boolean;
        playlistTitle: string | null;
        items: MetadataPreviewItem[];
        musicDir: string;
      }>('/api/download/metadata', {
        method: 'POST',
        body: JSON.stringify({query: trimmedQuery}),
      });

      if (res.musicDir) {
        setPublicInfo((prev) => (prev ? {...prev, musicDir: res.musicDir} : prev));
      }

      const isSearchMode =
        res.mode === 'search' || res.isSearch || !/^https?:\/\//i.test(trimmedQuery);

      if (isSearchMode) {
        setSearchResults(res.items || []);
        setLastSearchTerm(trimmedQuery);
        if (!res.items || res.items.length === 0) {
          setMetaError(`No YouTube results found for "${trimmedQuery}". Try a different query.`);
        }
      } else {
        setIsPlaylistPreview(Boolean(res.isPlaylist));
        setPlaylistTitle(res.playlistTitle);
        setPreviewItems(
          (res.items || []).map((item, idx) => ({
            ...item,
            selected: res.isPlaylist ? true : idx === 0,
            format: defaultFormat,
          }))
        );
      }
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : 'Could not fetch YouTube results');
    } finally {
      setFetchingMeta(false);
    }
  };

  const handleSelectSearchResult = (item: MetadataPreviewItem) => {
    setActiveSearchResultId(item.id);
    setIsPlaylistPreview(false);
    setPlaylistTitle(null);
    setMetaError(null);
    setPreviewItems([
      {
        ...item,
        selected: true,
        format: defaultFormat,
      },
    ]);
    requestAnimationFrame(() => {
      metadataEditorRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    });
  };

  const handleQuickDownloadResult = async (e: React.MouseEvent, item: MetadataPreviewItem) => {
    e.stopPropagation();
    if (quickQueueingId === item.id) return;
    setQuickQueueingId(item.id);
    setMetaError(null);
    try {
      await apiFetch('/api/download/start', {
        method: 'POST',
        body: JSON.stringify({
          items: [
            {
              url: item.url,
              title: item.title,
              artist: item.artist,
              album: item.album || 'Singles',
              format: defaultFormat,
              thumbnail_url: item.thumbnail_url,
            },
          ],
        }),
      });
      setQuickQueuedIds((prev) => new Set(prev).add(item.id));
      flashToast(`Queued "${item.title}" (.${defaultFormat})`);
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : 'Failed to enqueue download');
    } finally {
      setQuickQueueingId(null);
    }
  };

  const updatePreviewItem = (id: string, patch: Partial<EditablePreviewItem>) => {
    setPreviewItems((prev) => prev.map((item) => (item.id === id ? {...item, ...patch} : item)));
  };

  const handleStartDownloads = async () => {
    const selected = previewItems.filter((i) => i.selected);
    if (selected.length === 0) return;

    setEnqueueing(true);
    setMetaError(null);
    try {
      await apiFetch('/api/download/start', {
        method: 'POST',
        body: JSON.stringify({
          items: selected.map((item) => ({
            url: item.url,
            title: item.title,
            artist: item.artist,
            album: item.album,
            format: item.format,
            thumbnail_url: item.thumbnail_url,
          })),
        }),
      });

      if (activeSearchResultId) {
        setQuickQueuedIds((prev) => new Set(prev).add(activeSearchResultId));
        setActiveSearchResultId(null);
      }
      setPreviewItems([]);
      setIsPlaylistPreview(false);
      setPlaylistTitle(null);
      if (searchResults.length === 0) {
        setQuery('');
      }
      flashToast(
        selected.length === 1
          ? `Queued "${selected[0].title}" for download`
          : `Queued ${selected.length} tracks for download`
      );
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : 'Failed to enqueue download');
    } finally {
      setEnqueueing(false);
    }
  };

  const handleDeleteJob = async (id: number) => {
    try {
      await apiFetch(`/api/download/jobs/${id}`, {method: 'DELETE'});
    } catch {
      // ignore
    }
  };

  const handleClearInput = () => {
    setQuery('');
    setMetaError(null);
    searchInputRef.current?.focus();
  };

  const selectedCount = previewItems.filter((i) => i.selected).length;
  const isSingleEditor = !isPlaylistPreview && previewItems.length === 1;
  const destinationLabel = publicInfo?.musicDir || '/music';

  return (
    <div
      className="px-4 sm:px-6 lg:px-8 pt-5 max-w-5xl mx-auto space-y-6 pb-36 md:pb-12"
      style={{paddingBottom: 'calc(8.5rem + env(safe-area-inset-bottom, 0px))'}}
    >
      {actionToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[#1DB954] px-4 py-2 text-sm font-semibold text-black shadow-xl max-w-[90vw] truncate">
          {actionToast}
        </div>
      )}

      {/* Compact Single-Row Header */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
          Search
        </h1>
        {canDownload && (
          <div
            className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] border border-white/[0.08] px-2.5 py-1 text-xs text-[#B3B3B3] max-w-[60vw]"
            title={`Download destination: ${destinationLabel}`}
          >
            <FolderOpen className="w-3.5 h-3.5 text-[#1DB954] shrink-0" />
            <code className="font-mono text-white/90 truncate">{destinationLabel}</code>
          </div>
        )}
      </div>

      {/* Unified Search Input & Compact Format / Action Row */}
      <form onSubmit={handleFetchMetadata} className="space-y-3">
        <div className="relative">
          {isUrlInput ? (
            <Link2 className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1DB954]" />
          ) : (
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#B3B3B3]" />
          )}
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Songs, artists, or YouTube URL..."
            aria-label="Search library or YouTube"
            className="w-full rounded-lg bg-[#181818] border border-white/10 pl-10 pr-10 py-3 text-sm text-white placeholder-[#8A8A8A] focus:border-[#1DB954] focus:bg-[#202020] focus:outline-none transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={handleClearInput}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {canDownload && (
          <div className="flex items-center justify-between gap-2.5">
            <div className="inline-flex items-center rounded-md bg-[#181818] p-0.5 border border-white/10">
              {(['m4a', 'opus'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => {
                    setDefaultFormat(fmt);
                    setPreviewItems((prev) => prev.map((p) => ({...p, format: fmt})));
                  }}
                  className={`px-3 py-1.5 rounded text-xs font-mono font-medium transition-colors ${
                    defaultFormat === fmt
                      ? 'bg-[#282828] text-white'
                      : 'text-[#8A8A8A] hover:text-white'
                  }`}
                >
                  .{fmt}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={fetchingMeta || !trimmedQuery || offline}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1DB954] px-5 py-2 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
            >
              {fetchingMeta ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{isUrlInput ? 'Fetching...' : 'Searching...'}</span>
                </>
              ) : (
                <>
                  {isUrlInput ? <Link2 className="w-4 h-4" /> : <Search className="w-4 h-4" />}
                  <span>{isUrlInput ? 'Fetch YouTube URL' : 'Search YouTube'}</span>
                </>
              )}
            </button>
          </div>
        )}
      </form>

      {/* Graceful warning if yt-dlp or ffmpeg is missing */}
      {canDownload &&
        !offline &&
        publicInfo &&
        (!publicInfo.ytdlpInstalled || !publicInfo.ffmpegInstalled) && (
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 p-3.5 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/90 leading-relaxed">
              {!publicInfo.ytdlpInstalled && !publicInfo.ffmpegInstalled
                ? 'yt-dlp and ffmpeg are not installed in this container.'
                : !publicInfo.ytdlpInstalled
                  ? 'yt-dlp is not installed in this container.'
                  : 'ffmpeg is not installed in this container.'}{' '}
              Local library search and streaming remain fully operational.
            </p>
          </div>
        )}

      {metaError && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/25 px-4 py-3 text-sm text-red-300">
          {metaError}
        </div>
      )}

      {/* SECTION 1: In Your Library (live-filtered as user types) */}
      {trimmedQuery && !isUrlInput && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[#B3B3B3]">
              In Your Library
            </h2>
            <span className="font-mono text-xs tabular-nums text-[#6A6A6A]">
              {libraryLoading
                ? 'Loading...'
                : `${localMatches.length} ${localMatches.length === 1 ? 'track' : 'tracks'}`}
            </span>
          </div>

          {localMatches.length === 0 ? (
            <div className="rounded-xl bg-[#181818] border border-white/[0.06] px-4 py-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <Music2 className="w-5 h-5 text-[#6A6A6A] shrink-0" />
                <p className="text-sm text-[#B3B3B3] truncate">
                  No local tracks matching &ldquo;{trimmedQuery}&rdquo;
                </p>
              </div>
              {canDownload && !offline && (
                <button
                  type="button"
                  disabled={fetchingMeta}
                  onClick={(e) => void handleFetchMetadata(e)}
                  className="text-xs font-semibold text-[#1DB954] hover:text-[#1ED760] whitespace-nowrap shrink-0"
                >
                  Search YouTube →
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {localMatches.slice(0, 25).map((track) => {
                const isCurrent = currentTrack?.id === track.id;
                const isCachedOffline = cachedTrackIds.has(track.id);

                return (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => handlePlayLocalTrack(track)}
                    className={`group w-full flex items-center gap-3 rounded-lg p-2.5 border text-left transition-colors ${
                      isCurrent
                        ? 'bg-[#242424] border-[#1DB954]/50'
                        : 'bg-[#181818] border-white/[0.05] hover:bg-[#222222] hover:border-white/10'
                    }`}
                  >
                    <div className="relative shrink-0">
                      <AlbumArt
                        coverFile={track.cover_file}
                        alt={track.title}
                        color={track.dominant_color}
                        className="w-12 h-12 rounded object-cover"
                        iconSize={18}
                      />
                      <span
                        className={`absolute inset-0 flex items-center justify-center rounded bg-black/45 transition-opacity ${
                          isCurrent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        {isCurrent && isPlaying ? (
                          <Pause className="w-4 h-4 text-[#1DB954] fill-current" />
                        ) : (
                          <Play className="w-4 h-4 text-white fill-current ml-0.5" />
                        )}
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm font-semibold truncate ${
                          isCurrent ? 'text-[#1DB954]' : 'text-white'
                        }`}
                      >
                        {track.title}
                      </p>
                      <p className="text-xs text-[#B3B3B3] truncate mt-0.5">
                        {track.artist}
                        {track.album ? ` · ${track.album}` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      {isCachedOffline && (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[#1DB954]"
                          title="Available offline"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Offline</span>
                        </span>
                      )}
                      <span className="font-mono text-xs tabular-nums text-[#8A8A8A]">
                        {track.duration > 0 ? formatDuration(track.duration) : '--:--'}
                      </span>
                    </div>
                  </button>
                );
              })}
              {localMatches.length > 25 && (
                <p className="text-center text-xs text-[#6A6A6A] pt-1">
                  Showing top 25 of {localMatches.length} matches in your library.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {/* SECTION 2: YouTube (yt-dlp) Results, Metadata Preview & Live Download Progress */}
      {canDownload && (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[#B3B3B3]">
              YouTube (yt-dlp) Results
            </h2>
            {searchResults.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  stopPreview();
                  setSearchResults([]);
                  setLastSearchTerm(null);
                  setActiveSearchResultId(null);
                }}
                className="text-xs font-medium text-[#B3B3B3] hover:text-white shrink-0"
              >
                Clear results
              </button>
            )}
          </div>

          {offline ? (
            <div className="rounded-xl bg-[#181818] border border-white/[0.06] p-6 text-center space-y-2">
              <WifiOff className="w-6 h-6 text-amber-400 mx-auto" />
              <p className="text-sm font-medium text-white">Offline Mode</p>
              <p className="text-xs text-[#B3B3B3]">
                You can search and play your cached tracks above. Reconnect to search or download
                from YouTube.
              </p>
            </div>
          ) : (
            <>
              {/* Empty state before any YouTube search or pasted URL */}
              {searchResults.length === 0 && previewItems.length === 0 && !fetchingMeta && (
                <div className="rounded-xl bg-[#181818] border border-white/[0.06] px-5 py-7 text-center space-y-1.5">
                  <p className="text-sm font-medium text-white">
                    {trimmedQuery
                      ? `Press Enter or tap "${isUrlInput ? 'Fetch YouTube URL' : 'Search YouTube'}"`
                      : 'Find tracks in your library or on YouTube'}
                  </p>
                  <p className="text-xs text-[#8A8A8A]">
                    Preview audio inline and download directly into{' '}
                    <code className="font-mono text-[#B3B3B3]">{destinationLabel}</code> as{' '}
                    <code className="font-mono text-[#B3B3B3]">.{defaultFormat}</code>.
                  </p>
                </div>
              )}

              {/* Loading skeleton state */}
              {fetchingMeta && (
                <div className="rounded-xl bg-[#181818] border border-white/[0.06] p-8 flex items-center justify-center gap-3 text-sm text-[#B3B3B3]">
                  <Loader2 className="w-5 h-5 animate-spin text-[#1DB954]" />
                  <span>
                    {isUrlInput
                      ? 'Reading YouTube metadata...'
                      : `Searching YouTube for "${trimmedQuery}"...`}
                  </span>
                </div>
              )}

              {/* YouTube Search Results List */}
              {searchResults.length > 0 && (
                <div className="space-y-2">
                  {lastSearchTerm && (
                    <p className="text-xs text-[#8A8A8A]">
                      Results for &ldquo;{lastSearchTerm}&rdquo; · Tap a track to edit tags, or{' '}
                      <span className="text-[#B3B3B3] font-semibold">+</span> for one-tap{' '}
                      <code className="font-mono text-[#B3B3B3]">.{defaultFormat}</code> download.
                    </p>
                  )}

                  <div className="space-y-2">
                    {searchResults.map((item) => {
                      const isSelected = activeSearchResultId === item.id;
                      const isQuickQueueing = quickQueueingId === item.id;
                      const matchingJob = jobByUrl.get(item.url);
                      const isJobActive =
                        matchingJob?.status === 'queued' ||
                        matchingJob?.status === 'downloading' ||
                        matchingJob?.status === 'processing';
                      const isJobComplete = matchingJob?.status === 'completed';
                      const isQuickQueued = quickQueuedIds.has(item.id) || isJobActive || isJobComplete;

                      const subLine =
                        item.channel &&
                        item.channel.toLowerCase() !== item.artist.toLowerCase()
                          ? `${item.artist} · ${item.channel}`
                          : item.channel || item.artist;

                      return (
                        <div
                          key={item.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleSelectSearchResult(item)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleSelectSearchResult(item);
                            }
                          }}
                          className={`group rounded-lg p-2.5 border transition-colors cursor-pointer space-y-2 ${
                            isSelected
                              ? 'bg-[#262626] border-[#1DB954]/60'
                              : 'bg-[#181818] border-white/[0.06] hover:bg-[#222222] hover:border-white/15'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <AlbumArt
                              externalUrl={item.thumbnail_url}
                              alt={item.title}
                              className="w-12 h-12 sm:w-14 sm:h-14 rounded object-cover shrink-0"
                              iconSize={20}
                            />

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p
                                  className={`text-sm font-semibold truncate ${
                                    isSelected ? 'text-[#1DB954]' : 'text-white'
                                  }`}
                                >
                                  {item.title}
                                </p>
                                {item.duplicateTrack && (
                                  <span className="text-[10px] font-semibold text-amber-300 border border-amber-400/35 bg-amber-500/10 rounded px-1.5 py-0.5 leading-none shrink-0">
                                    In Library
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-[#B3B3B3] truncate mt-0.5">{subLine}</p>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span className="hidden sm:inline font-mono text-xs tabular-nums text-[#8A8A8A] w-11 text-right">
                                {item.duration > 0 ? formatDuration(item.duration) : '--:--'}
                              </span>

                              <button
                                type="button"
                                onClick={(e) => handleTogglePreview(e, item)}
                                title={
                                  previewingId === item.id
                                    ? 'Stop preview'
                                    : 'Preview audio before downloading'
                                }
                                aria-label={
                                  previewingId === item.id
                                    ? `Stop previewing ${item.title}`
                                    : `Preview ${item.title}`
                                }
                                className={`flex h-9 w-9 items-center justify-center rounded-full border transition-all ${
                                  previewingId === item.id || previewLoadingId === item.id
                                    ? 'bg-[#1DB954] border-[#1DB954] text-black'
                                    : 'bg-[#121212] border-white/15 text-white hover:border-[#1DB954] hover:text-[#1DB954]'
                                }`}
                              >
                                {previewLoadingId === item.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : previewingId === item.id ? (
                                  <Pause className="w-4 h-4 fill-current" />
                                ) : (
                                  <Play className="w-4 h-4 fill-current ml-0.5" />
                                )}
                              </button>

                              {isJobComplete && matchingJob?.track_id ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    stopPreview();
                                    void playTrackById(matchingJob.track_id!);
                                  }}
                                  title="Play downloaded track"
                                  aria-label={`Play ${item.title}`}
                                  className="flex h-9 px-3 items-center justify-center gap-1 rounded-full bg-[#1DB954] text-xs font-bold text-black hover:bg-[#1ED760]"
                                >
                                  <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                  <span className="hidden sm:inline">Play</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isQuickQueueing || isJobActive}
                                  onClick={(e) => void handleQuickDownloadResult(e, item)}
                                  title={`Download as .${defaultFormat}`}
                                  aria-label={`Download ${item.title}`}
                                  className={`flex h-9 w-9 items-center justify-center rounded-full border transition-all ${
                                    isQuickQueued
                                      ? 'bg-[#1DB954]/20 border-[#1DB954] text-[#1DB954]'
                                      : 'bg-[#121212] border-white/15 text-white hover:bg-[#1DB954] hover:border-[#1DB954] hover:text-black'
                                  }`}
                                >
                                  {isQuickQueueing || isJobActive ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : isQuickQueued ? (
                                    <Check className="w-4 h-4 stroke-[2.5]" />
                                  ) : (
                                    <Plus className="w-4 h-4 stroke-[2.5]" />
                                  )}
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Inline live progress bar for this track while downloading */}
                          {matchingJob && isJobActive && (
                            <div className="space-y-1 pt-0.5">
                              <div className="h-1 w-full overflow-hidden rounded-full bg-[#2A2A2A]">
                                <div
                                  className="h-full bg-[#1DB954] transition-[width] duration-200"
                                  style={{width: `${Math.max(matchingJob.progress, 5)}%`}}
                                />
                              </div>
                              <div className="flex items-center justify-between text-[11px] font-mono text-[#B3B3B3] tabular-nums">
                                <span className="truncate">{matchingJob.stage}</span>
                                <span>{Math.round(matchingJob.progress)}%</span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Metadata Preview Editor (Pasted URL, Playlist, or Clicked Result) */}
              {previewItems.length > 0 && (
                <div
                  ref={metadataEditorRef}
                  className="rounded-xl bg-[#181818] border border-white/10 p-4 sm:p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        {playlistTitle
                          ? `Playlist: ${playlistTitle}`
                          : activeSearchResultId
                            ? 'Edit Metadata Before Download'
                            : 'YouTube Metadata Preview'}
                      </h3>
                      <p className="text-xs text-[#8A8A8A]">
                        Saves to{' '}
                        <code className="font-mono text-[#B3B3B3]">
                          {destinationLabel}/&lt;Artist&gt;/&lt;Album&gt;/&lt;Title&gt;.
                          {isSingleEditor ? previewItems[0].format : defaultFormat}
                        </code>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewItems([]);
                          setActiveSearchResultId(null);
                          setIsPlaylistPreview(false);
                          setPlaylistTitle(null);
                        }}
                        className="rounded-full border border-white/15 px-3.5 py-2 text-xs font-semibold text-[#B3B3B3] hover:text-white hover:border-white/30 transition-colors"
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        disabled={enqueueing || selectedCount === 0}
                        onClick={handleStartDownloads}
                        className="inline-flex items-center gap-2 rounded-full bg-[#1DB954] px-5 py-2 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {enqueueing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                        <span>
                          {isSingleEditor
                            ? 'Download Track'
                            : `Download Selected (${selectedCount})`}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {previewItems.map((item) => (
                      <div
                        key={item.id}
                        className={`rounded-lg p-3.5 border transition-colors ${
                          item.selected
                            ? 'bg-[#121212] border-[#1DB954]/40'
                            : 'bg-[#121212]/60 border-white/[0.06] opacity-75'
                        }`}
                      >
                        <div className="flex flex-col md:flex-row gap-4">
                          <div className="flex items-start gap-3 shrink-0">
                            {!isSingleEditor && (
                              <input
                                type="checkbox"
                                checked={item.selected}
                                onChange={(e) =>
                                  updatePreviewItem(item.id, {selected: e.target.checked})
                                }
                                className="mt-1 h-4 w-4 accent-[#1DB954] cursor-pointer"
                                aria-label={`Select ${item.title}`}
                              />
                            )}
                            <div className="relative">
                              <AlbumArt
                                externalUrl={item.thumbnail_url}
                                alt={item.title}
                                className="w-16 h-16 sm:w-20 sm:h-20 rounded-md"
                                iconSize={24}
                              />
                              <button
                                type="button"
                                onClick={(e) => handleTogglePreview(e, item)}
                                title={
                                  previewingId === item.id ? 'Stop preview' : 'Preview audio'
                                }
                                aria-label={
                                  previewingId === item.id
                                    ? `Stop previewing ${item.title}`
                                    : `Preview ${item.title}`
                                }
                                className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/75 text-white hover:bg-[#1DB954] hover:text-black transition-colors"
                              >
                                {previewLoadingId === item.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : previewingId === item.id ? (
                                  <Pause className="w-3.5 h-3.5 fill-current" />
                                ) : (
                                  <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                                )}
                              </button>
                            </div>
                          </div>

                          <div className="flex-1 space-y-3 min-w-0">
                            {item.duplicateTrack && (
                              <div className="flex items-center gap-2 rounded bg-amber-500/15 border border-amber-500/30 px-3 py-1.5 text-xs text-amber-200">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                <span className="truncate">
                                  Already in library:{' '}
                                  <strong>
                                    {item.duplicateTrack.artist} — {item.duplicateTrack.title}
                                  </strong>
                                </span>
                              </div>
                            )}

                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                              <div>
                                <label className="block text-[11px] font-medium text-[#B3B3B3] mb-1">
                                  Title
                                </label>
                                <input
                                  type="text"
                                  value={item.title}
                                  onChange={(e) =>
                                    updatePreviewItem(item.id, {title: e.target.value})
                                  }
                                  className="w-full rounded bg-[#181818] border border-white/10 px-2.5 py-1.5 text-sm text-white focus:border-[#1DB954] focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-[#B3B3B3] mb-1">
                                  Artist
                                </label>
                                <input
                                  type="text"
                                  value={item.artist}
                                  onChange={(e) =>
                                    updatePreviewItem(item.id, {artist: e.target.value})
                                  }
                                  className="w-full rounded bg-[#181818] border border-white/10 px-2.5 py-1.5 text-sm text-white focus:border-[#1DB954] focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-[#B3B3B3] mb-1">
                                  Album
                                </label>
                                <input
                                  type="text"
                                  value={item.album}
                                  onChange={(e) =>
                                    updatePreviewItem(item.id, {album: e.target.value})
                                  }
                                  className="w-full rounded bg-[#181818] border border-white/10 px-2.5 py-1.5 text-sm text-white focus:border-[#1DB954] focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-[#B3B3B3] mb-1">
                                  Format & Length
                                </label>
                                <div className="flex items-center gap-2">
                                  <select
                                    value={item.format}
                                    onChange={(e) =>
                                      updatePreviewItem(item.id, {
                                        format: e.target.value === 'opus' ? 'opus' : 'm4a',
                                      })
                                    }
                                    className="flex-1 rounded bg-[#181818] border border-white/10 px-2.5 py-1.5 text-sm font-mono text-white focus:border-[#1DB954] focus:outline-none"
                                  >
                                    <option value="m4a">m4a (AAC)</option>
                                    <option value="opus">opus</option>
                                  </select>
                                  <span className="font-mono text-xs tabular-nums text-[#6A6A6A]">
                                    {formatDuration(item.duration)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Live Download Progress Queue */}
              {jobs.length > 0 && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-xs font-bold uppercase tracking-wider text-[#B3B3B3]">
                      Download Progress
                    </h3>
                    <span className="font-mono text-xs tabular-nums text-[#6A6A6A]">
                      {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {jobs.map((job) => {
                      const isError = job.status === 'error';
                      const isComplete = job.status === 'completed';
                      const isActive =
                        job.status === 'downloading' || job.status === 'processing';

                      return (
                        <div
                          key={job.id}
                          className="rounded-lg bg-[#181818] border border-white/[0.06] p-3.5 space-y-2.5"
                        >
                          <div className="flex items-center gap-3">
                            <AlbumArt
                              externalUrl={job.thumbnail_url}
                              alt={job.title}
                              className="w-11 h-11 rounded shrink-0"
                              iconSize={18}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-semibold text-white truncate">
                                  {job.title}
                                </p>
                                <span className="font-mono text-[11px] text-[#6A6A6A] shrink-0">
                                  .{job.format}
                                </span>
                              </div>
                              <p className="text-xs text-[#B3B3B3] truncate">
                                {job.artist} · {job.album}
                              </p>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <span
                                className={`inline-flex items-center gap-1 text-xs font-semibold ${
                                  isComplete
                                    ? 'text-[#1DB954]'
                                    : isError
                                      ? 'text-red-400'
                                      : isActive
                                        ? 'text-white'
                                        : 'text-[#B3B3B3]'
                                }`}
                              >
                                {isComplete && <CheckCircle2 className="w-4 h-4" />}
                                {isError && <XCircle className="w-4 h-4" />}
                                {isActive && (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1DB954]" />
                                )}
                                <span className="hidden sm:inline">{job.stage}</span>
                              </span>

                              {isComplete && job.track_id && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    stopPreview();
                                    void playTrackById(job.track_id!);
                                  }}
                                  className="inline-flex items-center gap-1 rounded-full bg-[#1DB954] px-3 py-1.5 text-xs font-bold text-black hover:bg-[#1ED760] transition-colors"
                                >
                                  <Play className="w-3.5 h-3.5 fill-current" />
                                  <span>Play</span>
                                </button>
                              )}

                              {isError && job.error_log && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedErrorId(expandedErrorId === job.id ? null : job.id)
                                  }
                                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-300 hover:bg-white/5"
                                >
                                  <span>Log</span>
                                  {expandedErrorId === job.id ? (
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  ) : (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => void handleDeleteJob(job.id)}
                                className="p-1.5 rounded text-[#6A6A6A] hover:text-red-400 transition-colors"
                                aria-label="Remove job"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          <div className="space-y-1">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#282828]">
                              <div
                                className={`h-full transition-[width] duration-200 ${
                                  isError ? 'bg-red-500' : 'bg-[#1DB954]'
                                }`}
                                style={{
                                  width: `${Math.max(isComplete ? 100 : job.progress, isActive ? 4 : 0)}%`,
                                }}
                              />
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-[#8A8A8A] font-mono tabular-nums">
                              <span className="truncate">{job.stage}</span>
                              <span>{Math.round(isComplete ? 100 : job.progress)}%</span>
                            </div>
                          </div>

                          {isError && job.error_log && expandedErrorId === job.id && (
                            <pre className="rounded bg-[#0A0A0A] border border-red-500/20 p-3 text-[11px] font-mono text-red-200/90 overflow-x-auto whitespace-pre-wrap break-all">
                              {job.error_log}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
};
