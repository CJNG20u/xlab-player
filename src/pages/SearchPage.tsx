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

function extractYouTubeVideoIdFromItem(item: MetadataPreviewItem): string {
  const candidate = (item.id || '').trim();
  if (/^[A-Za-z0-9_-]{6,20}$/.test(candidate)) {
    return candidate;
  }
  if (item.url) {
    try {
      const parsed = new URL(item.url);
      const v = parsed.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
      if (parsed.hostname === 'youtu.be') {
        const seg = parsed.pathname.replace(/^\//, '').split('/')[0];
        if (/^[A-Za-z0-9_-]{6,20}$/.test(seg)) return seg;
      }
    } catch {
      // ignore invalid URL
    }
  }
  return candidate;
}

function metadataItemToYouTubeTrack(item: MetadataPreviewItem): Track {
  const videoId = extractYouTubeVideoIdFromItem(item);
  return {
    id: `yt-${videoId}`,
    rel_path: '',
    title: item.title,
    artist: item.channel || item.artist || 'YouTube',
    album: 'YouTube Stream',
    track_number: null,
    year: null,
    duration: item.duration || 0,
    format: 'm4a',
    bitrate: 0,
    size_bytes: 0,
    cover_file: null,
    dominant_color: '#181818',
    added_at: '',
    liked: false,
    coverUrl: item.thumbnail_url || undefined,
    streamUrl: `/api/yt-stream/${encodeURIComponent(videoId)}`,
    isYouTubeStream: true,
    youtubeUrl: item.url || `https://www.youtube.com/watch?v=${videoId}`,
  };
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
    isBuffering,
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

  const handlePlayYouTubeItem = useCallback(
    (e: React.MouseEvent, item: MetadataPreviewItem, sourceList: MetadataPreviewItem[]) => {
      e.stopPropagation();
      const clickedTrack = metadataItemToYouTubeTrack(item);
      if (currentTrack?.id === clickedTrack.id) {
        togglePlay();
        return;
      }
      const listToQueue = sourceList.length > 0 ? sourceList : [item];
      const ytQueue = listToQueue.map(metadataItemToYouTubeTrack);
      const matched = ytQueue.find((t) => t.id === clickedTrack.id) || clickedTrack;
      playTrack(matched, ytQueue);
    },
    [currentTrack?.id, playTrack, togglePlay]
  );

  const handlePlayLocalTrack = useCallback(
    (track: Track) => {
      if (currentTrack?.id === track.id) {
        togglePlay();
      } else {
        playTrack(track, localMatches.length > 0 ? localMatches : [track]);
      }
    },
    [currentTrack?.id, localMatches, playTrack, togglePlay]
  );

  const handleFetchMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedQuery || !canDownload) return;
    if (offline) {
      setMetaError('YouTube search requires an internet connection.');
      return;
    }

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
      className="px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto space-y-6 pb-36 md:pb-12"
      style={{
        paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(8.5rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {actionToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate">
          {actionToast}
        </div>
      )}

      {/* Compact Single-Row Header */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
          Search
        </h1>
        {canDownload && (
          <div
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-secondary)] max-w-[60vw]"
            title={`Download destination: ${destinationLabel}`}
          >
            <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <code className="font-mono text-[var(--text-primary)] truncate">{destinationLabel}</code>
          </div>
        )}
      </div>

      {/* Unified Search Input & Compact Format / Action Row */}
      <form onSubmit={handleFetchMetadata} className="space-y-3">
        <div className="relative">
          {isUrlInput ? (
            <Link2 className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--accent)]" />
          ) : (
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)]" />
          )}
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Songs, artists, or YouTube URL..."
            aria-label="Search library or YouTube"
            className="w-full rounded-lg bg-[var(--bg-input)] border border-[var(--border-subtle)] pl-10 pr-10 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={handleClearInput}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)] transition-colors"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {canDownload && (
          <div className="flex items-center justify-between gap-2.5">
            <div className="inline-flex items-center rounded-md bg-[var(--bg-secondary)] p-0.5 border border-[var(--border-subtle)]">
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
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  .{fmt}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={fetchingMeta || !trimmedQuery || offline}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
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
          <div className="rounded-lg bg-[var(--warn-bg)] border border-[var(--warn-border)] p-3.5 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-[var(--warn-text)] shrink-0 mt-0.5" />
            <p className="text-xs text-[var(--warn-text)] leading-relaxed">
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
        <div className="rounded-lg bg-[var(--danger-bg)] border border-[var(--danger-border)] px-4 py-3 text-sm text-[var(--danger-text)]">
          {metaError}
        </div>
      )}

      {/* SECTION 1: In Your Library (live-filtered as user types) */}
      {trimmedQuery && !isUrlInput && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
              In Your Library
            </h2>
            <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
              {libraryLoading
                ? 'Loading...'
                : `${localMatches.length} ${localMatches.length === 1 ? 'track' : 'tracks'}`}
            </span>
          </div>

          {localMatches.length === 0 ? (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-4 py-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <Music2 className="w-5 h-5 text-[var(--text-muted)] shrink-0" />
                <p className="text-sm text-[var(--text-secondary)] truncate">
                  No local tracks matching &ldquo;{trimmedQuery}&rdquo;
                </p>
              </div>
              {canDownload && !offline && (
                <button
                  type="button"
                  disabled={fetchingMeta}
                  onClick={(e) => void handleFetchMetadata(e)}
                  className="text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)] whitespace-nowrap shrink-0"
                >
                  Search YouTube →
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {localMatches.slice(0, 25).map((track) => {
                const isCurrent = currentTrack?.id === track.id;
                const isCachedOffline =
                  typeof track.id === 'number' && cachedTrackIds.has(track.id);

                return (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => handlePlayLocalTrack(track)}
                    className={`group w-full flex items-center gap-3 rounded-lg p-2.5 border text-left transition-colors ${
                      isCurrent
                        ? 'bg-[var(--bg-elevated)] border-[var(--accent)]/50'
                        : 'bg-[var(--bg-secondary)] border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
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
                          <Pause className="w-4 h-4 text-[var(--accent)] fill-current" />
                        ) : (
                          <Play className="w-4 h-4 text-white fill-current ml-0.5" />
                        )}
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm font-semibold truncate ${
                          isCurrent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                        }`}
                      >
                        {track.title}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                        {track.artist}
                        {track.album ? ` · ${track.album}` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      {isCachedOffline && (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)]"
                          title="Available offline"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Offline</span>
                        </span>
                      )}
                      <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
                        {track.duration > 0 ? formatDuration(track.duration) : '--:--'}
                      </span>
                    </div>
                  </button>
                );
              })}
              {localMatches.length > 25 && (
                <p className="text-center text-xs text-[var(--text-muted)] pt-1">
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
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
              YouTube (yt-dlp) Results
            </h2>
            {searchResults.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSearchResults([]);
                  setLastSearchTerm(null);
                  setActiveSearchResultId(null);
                }}
                className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0"
              >
                Clear results
              </button>
            )}
          </div>

          {offline ? (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 text-center space-y-2">
              <WifiOff className="w-6 h-6 text-[var(--warn-text)] mx-auto" />
              <p className="text-sm font-medium text-[var(--text-primary)]">Offline Mode</p>
              <p className="text-xs text-[var(--text-secondary)]">
                You can search and play your cached tracks above. Reconnect to search or download
                from YouTube.
              </p>
            </div>
          ) : (
            <>
              {/* Empty state before any YouTube search or pasted URL */}
              {searchResults.length === 0 && previewItems.length === 0 && !fetchingMeta && (
                <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-5 py-7 text-center space-y-1.5">
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    {trimmedQuery
                      ? `Press Enter or tap "${isUrlInput ? 'Fetch YouTube URL' : 'Search YouTube'}"`
                      : 'Find tracks in your library or on YouTube'}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Stream full tracks right in the player or save directly into{' '}
                    <code className="font-mono text-[var(--text-secondary)]">{destinationLabel}</code> as{' '}
                    <code className="font-mono text-[var(--text-secondary)]">.{defaultFormat}</code>.
                  </p>
                </div>
              )}

              {/* Loading skeleton state */}
              {fetchingMeta && (
                <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-8 flex items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
                  <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
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
                    <p className="text-xs text-[var(--text-muted)]">
                      Results for &ldquo;{lastSearchTerm}&rdquo; · Tap a track to edit tags, or{' '}
                      <span className="text-[var(--text-secondary)] font-semibold">+</span> for one-tap{' '}
                      <code className="font-mono text-[var(--text-secondary)]">.{defaultFormat}</code> download.
                    </p>
                  )}

                  <div className="space-y-2">
                    {searchResults.map((item) => {
                      const ytTrackId = `yt-${extractYouTubeVideoIdFromItem(item)}`;
                      const isCurrentStream = currentTrack?.id === ytTrackId;
                      const isStreamPlaying = isCurrentStream && isPlaying && !isBuffering;
                      const isStreamBuffering = isCurrentStream && isBuffering;
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
                            isCurrentStream || isSelected
                              ? 'bg-[var(--bg-elevated)] border-[var(--accent)]/60'
                              : 'bg-[var(--bg-secondary)] border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
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
                                    isCurrentStream || isSelected
                                      ? 'text-[var(--accent)]'
                                      : 'text-[var(--text-primary)]'
                                  }`}
                                >
                                  {item.title}
                                </p>
                                {item.duplicateTrack && (
                                  <span className="text-[10px] font-semibold text-[var(--warn-text)] border border-[var(--warn-border)] bg-[var(--warn-bg)] rounded px-1.5 py-0.5 leading-none shrink-0">
                                    In Library
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
                                {subLine}
                              </p>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span className="hidden sm:inline font-mono text-xs tabular-nums text-[var(--text-muted)] w-11 text-right">
                                {item.duration > 0 ? formatDuration(item.duration) : '--:--'}
                              </span>

                              <button
                                type="button"
                                onClick={(e) => handlePlayYouTubeItem(e, item, searchResults)}
                                title={
                                  isStreamPlaying
                                    ? 'Pause track'
                                    : 'Play in player'
                                }
                                aria-label={
                                  isStreamPlaying
                                    ? `Pause ${item.title}`
                                    : `Play ${item.title}`
                                }
                                className={`flex h-9 w-9 items-center justify-center rounded-full border transition-all ${
                                  isCurrentStream
                                    ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]'
                                    : 'bg-[var(--bg-primary)] border-[var(--border-strong)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                                }`}
                              >
                                {isStreamBuffering ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : isStreamPlaying ? (
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
                                    void playTrackById(matchingJob.track_id!);
                                  }}
                                  title="Play downloaded track"
                                  aria-label={`Play ${item.title}`}
                                  className="flex h-9 px-3 items-center justify-center gap-1 rounded-full bg-[var(--accent)] text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
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
                                      ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                                      : 'bg-[var(--bg-primary)] border-[var(--border-strong)] text-[var(--text-primary)] hover:bg-[var(--accent)] hover:border-[var(--accent)] hover:text-[var(--accent-contrast)]'
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
                              <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--slider-track)]">
                                <div
                                  className="h-full bg-[var(--accent)] transition-[width] duration-200"
                                  style={{width: `${Math.max(matchingJob.progress, 5)}%`}}
                                />
                              </div>
                              <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-secondary)] tabular-nums">
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
                  className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-4 sm:p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-[var(--text-primary)]">
                        {playlistTitle
                          ? `Playlist: ${playlistTitle}`
                          : activeSearchResultId
                            ? 'Edit Metadata Before Download'
                            : 'YouTube Metadata Preview'}
                      </h3>
                      <p className="text-xs text-[var(--text-muted)]">
                        Saves to{' '}
                        <code className="font-mono text-[var(--text-secondary)]">
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
                        className="rounded-full border border-[var(--border-strong)] px-3.5 py-2 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        disabled={enqueueing || selectedCount === 0}
                        onClick={handleStartDownloads}
                        className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors whitespace-nowrap"
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
                            ? 'bg-[var(--bg-primary)] border-[var(--accent)]/40'
                            : 'bg-[var(--bg-primary)]/60 border-[var(--border-subtle)] opacity-75'
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
                                className="mt-1 h-4 w-4 accent-[var(--accent)] cursor-pointer"
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
                              {(() => {
                                const ytId = `yt-${extractYouTubeVideoIdFromItem(item)}`;
                                const isActiveItem = currentTrack?.id === ytId;
                                const isItemPlaying = isActiveItem && isPlaying && !isBuffering;
                                const isItemBuffering = isActiveItem && isBuffering;
                                return (
                                  <button
                                    type="button"
                                    onClick={(e) => handlePlayYouTubeItem(e, item, previewItems)}
                                    title={isItemPlaying ? 'Pause track' : 'Play in player'}
                                    aria-label={
                                      isItemPlaying
                                        ? `Pause ${item.title}`
                                        : `Play ${item.title}`
                                    }
                                    className={`absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                                      isActiveItem
                                        ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                                        : 'bg-black/75 text-white hover:bg-[var(--accent)] hover:text-[var(--accent-contrast)]'
                                    }`}
                                  >
                                    {isItemBuffering ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : isItemPlaying ? (
                                      <Pause className="w-3.5 h-3.5 fill-current" />
                                    ) : (
                                      <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                                    )}
                                  </button>
                                );
                              })()}
                            </div>
                          </div>

                          <div className="flex-1 space-y-3 min-w-0">
                            {item.duplicateTrack && (
                              <div className="flex items-center gap-2 rounded bg-[var(--warn-bg)] border border-[var(--warn-border)] px-3 py-1.5 text-xs text-[var(--warn-text)]">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
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
                                <label className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">
                                  Title
                                </label>
                                <input
                                  type="text"
                                  value={item.title}
                                  onChange={(e) =>
                                    updatePreviewItem(item.id, {title: e.target.value})
                                  }
                                  className="w-full rounded bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">
                                  Artist
                                </label>
                                <input
                                  type="text"
                                  value={item.artist}
                                  onChange={(e) =>
                                    updatePreviewItem(item.id, {artist: e.target.value})
                                  }
                                  className="w-full rounded bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">
                                  Album
                                </label>
                                <input
                                  type="text"
                                  value={item.album}
                                  onChange={(e) =>
                                    updatePreviewItem(item.id, {album: e.target.value})
                                  }
                                  className="w-full rounded bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">
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
                                    className="flex-1 rounded bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm font-mono text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                                  >
                                    <option value="m4a">m4a (AAC)</option>
                                    <option value="opus">opus</option>
                                  </select>
                                  <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
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
                    <h3 className="font-display text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                      Download Progress
                    </h3>
                    <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
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
                          className="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-3.5 space-y-2.5"
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
                                <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                                  {job.title}
                                </p>
                                <span className="font-mono text-[11px] text-[var(--text-muted)] shrink-0">
                                  .{job.format}
                                </span>
                              </div>
                              <p className="text-xs text-[var(--text-secondary)] truncate">
                                {job.artist} · {job.album}
                              </p>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <span
                                className={`inline-flex items-center gap-1 text-xs font-semibold ${
                                  isComplete
                                    ? 'text-[var(--accent)]'
                                    : isError
                                      ? 'text-[var(--danger-text)]'
                                      : isActive
                                        ? 'text-[var(--text-primary)]'
                                        : 'text-[var(--text-secondary)]'
                                }`}
                              >
                                {isComplete && <CheckCircle2 className="w-4 h-4" />}
                                {isError && <XCircle className="w-4 h-4" />}
                                {isActive && (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
                                )}
                                <span className="hidden sm:inline">{job.stage}</span>
                              </span>

                              {isComplete && job.track_id && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    void playTrackById(job.track_id!);
                                  }}
                                  className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors"
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
                                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--danger-text)] hover:bg-[var(--surface-overlay)]"
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
                                className="p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--danger-text)] transition-colors"
                                aria-label="Remove job"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          <div className="space-y-1">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--slider-track)]">
                              <div
                                className={`h-full transition-[width] duration-200 ${
                                  isError ? 'bg-red-500' : 'bg-[var(--accent)]'
                                }`}
                                style={{
                                  width: `${Math.max(isComplete ? 100 : job.progress, isActive ? 4 : 0)}%`,
                                }}
                              />
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] font-mono tabular-nums">
                              <span className="truncate">{job.stage}</span>
                              <span>{Math.round(isComplete ? 100 : job.progress)}%</span>
                            </div>
                          </div>

                          {isError && job.error_log && expandedErrorId === job.id && (
                            <pre className="rounded bg-[var(--bg-primary)] border border-[var(--danger-border)] p-3 text-[11px] font-mono text-[var(--danger-text)] overflow-x-auto whitespace-pre-wrap break-all">
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
