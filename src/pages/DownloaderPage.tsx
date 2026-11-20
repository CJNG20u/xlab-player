import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileAudio,
  FolderOpen,
  Link2,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AlbumArt} from '../components/AlbumArt';
import {usePlayer} from '../context/PlayerContext';
import {apiFetch, formatDuration, getSSEUrl} from '../lib/api';
import type {DownloadJob, MetadataPreviewItem, Track} from '../types';

interface EditablePreviewItem extends MetadataPreviewItem {
  selected: boolean;
  format: 'm4a' | 'opus';
}

export const DownloaderPage: React.FC = () => {
  const {playTrackById, playTrack, bumpLibraryRefresh, isPlaying, togglePlay} = usePlayer();

  const [query, setQuery] = useState('');
  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Plain-text search results state (top 8 from ytsearch8)
  const [searchResults, setSearchResults] = useState<MetadataPreviewItem[]>([]);
  const [lastSearchTerm, setLastSearchTerm] = useState<string | null>(null);
  const [activeSearchResultId, setActiveSearchResultId] = useState<string | null>(null);
  const [quickQueueingId, setQuickQueueingId] = useState<string | null>(null);
  const [quickQueuedIds, setQuickQueuedIds] = useState<Set<string>>(new Set());
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

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
        setActionToast('Preview unavailable for this track');
      };

      audio.src = getSSEUrl(`/api/download/preview-audio?url=${encodeURIComponent(item.url)}`);
      void audio.play().catch(() => {
        setPreviewLoadingId(null);
        setPreviewingId(null);
      });
    },
    [isPlaying, previewLoadingId, previewingId, stopPreview, togglePlay]
  );

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

  // Drag & drop local audio upload state
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    message: string;
    tracks: Track[];
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const metadataEditorRef = useRef<HTMLDivElement | null>(null);

  const isUrlInput = /^https?:\/\//i.test(query.trim());

  const flashToast = useCallback((msg: string) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2800);
  }, []);

  const loadInfo = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  // Connect to SSE stream for live download queue progress
  useEffect(() => {
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
  }, [bumpLibraryRefresh]);

  const handleFetchMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
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
        body: JSON.stringify({query: trimmed}),
      });

      if (res.musicDir) {
        setPublicInfo((prev) => (prev ? {...prev, musicDir: res.musicDir} : prev));
      }

      const isSearchMode = res.mode === 'search' || res.isSearch || !/^https?:\/\//i.test(trimmed);

      if (isSearchMode) {
        setSearchResults(res.items || []);
        setLastSearchTerm(trimmed);
        if (!res.items || res.items.length === 0) {
          setMetaError(`No matching results found for "${trimmed}". Try a different search term.`);
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
      setMetaError(err instanceof Error ? err.message : 'Could not fetch metadata');
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

  const uploadAudioFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setUploading(true);
    setUploadError(null);
    setUploadResult(null);

    try {
      const formData = new FormData();
      for (const f of files) {
        formData.append('files', f);
      }
      const res = await apiFetch<{
        uploadedCount: number;
        tracks: Track[];
        destination: string;
      }>('/api/download/upload', {
        method: 'POST',
        body: formData,
      });
      setUploadResult({
        message: `Uploaded & indexed ${res.uploadedCount} audio ${res.uploadedCount === 1 ? 'file' : 'files'} into ${res.destination}`,
        tracks: res.tracks || [],
      });
      bumpLibraryRefresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const selectedCount = previewItems.filter((i) => i.selected).length;
  const isSingleEditor = !isPlaylistPreview && previewItems.length === 1;

  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-6 max-w-6xl mx-auto space-y-8">
      {actionToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[#1DB954] px-4 py-2 text-sm font-semibold text-black shadow-xl max-w-[90vw] truncate">
          {actionToast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
            Music Downloader
          </h1>
          <p className="mt-1 text-sm text-[#B3B3B3]">
            Search by song or artist, paste a YouTube / YouTube Music URL or playlist, or upload local audio files directly to your NAS.
          </p>
        </div>
        {publicInfo && (
          <div className="flex items-center gap-2 text-xs text-[#B3B3B3] shrink-0">
            <FolderOpen className="w-4 h-4 text-[#1DB954]" />
            <span>Destination:</span>
            <code className="font-mono text-white">{publicInfo.musicDir}</code>
          </div>
        )}
      </div>

      {/* Graceful warning if yt-dlp or ffmpeg is missing */}
      {publicInfo && (!publicInfo.ytdlpInstalled || !publicInfo.ffmpegInstalled) && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-200 space-y-1">
            <p className="font-semibold text-amber-100">
              {!publicInfo.ytdlpInstalled && !publicInfo.ffmpegInstalled
                ? 'yt-dlp and ffmpeg are not installed in this container'
                : !publicInfo.ytdlpInstalled
                  ? 'yt-dlp is not installed in this container'
                  : 'ffmpeg is not installed in this container'}
            </p>
            <p className="text-xs text-amber-200/80">
              YouTube downloading requires <code className="font-mono">yt-dlp</code> and{' '}
              <code className="font-mono">ffmpeg</code> on your Debian LXC host. Local audio file
              uploads below and library streaming remain 100% operational.
            </p>
          </div>
        </div>
      )}

      {/* Section 1: YouTube URL / Plain-Text Search + Results + Metadata Preview */}
      <section className="rounded-xl bg-[#181818] border border-white/[0.06] p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-white">
            Search or Fetch from YouTube / YouTube Music
          </h2>
          <div className="flex items-center gap-2 text-xs text-[#B3B3B3]">
            <span>Default format:</span>
            <div className="inline-flex rounded-md bg-[#121212] p-0.5 border border-white/10">
              {(['m4a', 'opus'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => {
                    setDefaultFormat(fmt);
                    setPreviewItems((prev) => prev.map((p) => ({...p, format: fmt})));
                  }}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors ${
                    defaultFormat === fmt
                      ? 'bg-[#282828] text-white'
                      : 'text-[#6A6A6A] hover:text-white'
                  }`}
                >
                  .{fmt}
                </button>
              ))}
            </div>
          </div>
        </div>

        <form onSubmit={handleFetchMetadata} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            {isUrlInput ? (
              <Link2 className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#1DB954]" />
            ) : (
              <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6A6A6A]" />
            )}
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search song & artist (e.g. Daft Punk Instant Crush) or paste a YouTube URL..."
              className="w-full rounded-md bg-[#121212] border border-white/10 pl-10 pr-9 py-3 text-sm text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6A6A6A] hover:text-white"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={fetchingMeta || !query.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1DB954] px-6 py-3 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {fetchingMeta ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isUrlInput ? 'Fetching Metadata...' : 'Searching...'}</span>
              </>
            ) : (
              <>
                {isUrlInput ? <Link2 className="w-4 h-4" /> : <Search className="w-4 h-4" />}
                <span>{isUrlInput ? 'Fetch Metadata' : 'Search'}</span>
              </>
            )}
          </button>
        </form>

        {metaError && (
          <div className="rounded-md bg-red-500/10 border border-red-500/25 px-4 py-3 text-sm text-red-300">
            {metaError}
          </div>
        )}

        {/* Plain-Text Search Results List (Top 8) */}
        {searchResults.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-white/10">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Search Results{' '}
                  {lastSearchTerm && (
                    <span className="font-normal text-[#B3B3B3]">for &ldquo;{lastSearchTerm}&rdquo;</span>
                  )}
                </h3>
                <p className="text-xs text-[#6A6A6A]">
                  Click a result to edit Artist / Album / Title tags, or tap{' '}
                  <span className="text-[#B3B3B3] font-semibold">+</span> to quick-download as{' '}
                  <code className="font-mono text-[#B3B3B3]">.{defaultFormat}</code>.
                </p>
              </div>
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
            </div>

            <div className="max-h-[420px] overflow-y-auto pr-1 space-y-1.5">
              {searchResults.map((item) => {
                const isSelected = activeSearchResultId === item.id;
                const isQuickQueueing = quickQueueingId === item.id;
                const isQuickQueued = quickQueuedIds.has(item.id);
                const subLine =
                  item.channel && item.channel.toLowerCase() !== item.artist.toLowerCase()
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
                    className={`group flex items-center gap-3 rounded-lg p-2.5 border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#282828] border-[#1DB954]/60'
                        : 'bg-[#121212] border-white/[0.06] hover:bg-[#222222] hover:border-white/15'
                    }`}
                  >
                    <AlbumArt
                      externalUrl={item.thumbnail_url}
                      alt={item.title}
                      className="w-14 h-14 rounded object-cover shrink-0"
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

                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="font-mono text-xs tabular-nums text-[#B3B3B3] w-11 text-right">
                        {item.duration > 0 ? formatDuration(item.duration) : '--:--'}
                      </span>

                      <button
                        type="button"
                        onClick={(e) => handleTogglePreview(e, item)}
                        title={previewingId === item.id ? 'Stop preview' : 'Preview song before downloading'}
                        aria-label={previewingId === item.id ? `Stop previewing ${item.title}` : `Preview ${item.title}`}
                        className={`flex h-9 w-9 items-center justify-center rounded-full border transition-all ${
                          previewingId === item.id || previewLoadingId === item.id
                            ? 'bg-[#1DB954] border-[#1DB954] text-black'
                            : 'bg-[#181818] border-white/15 text-white hover:border-[#1DB954] hover:text-[#1DB954]'
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

                      <button
                        type="button"
                        disabled={isQuickQueueing}
                        onClick={(e) => void handleQuickDownloadResult(e, item)}
                        title={`Quick download as .${defaultFormat}`}
                        aria-label={`Quick download ${item.title}`}
                        className={`flex h-9 w-9 items-center justify-center rounded-full border transition-all ${
                          isQuickQueued
                            ? 'bg-[#1DB954]/20 border-[#1DB954] text-[#1DB954]'
                            : 'bg-[#181818] border-white/15 text-white hover:bg-[#1DB954] hover:border-[#1DB954] hover:text-black'
                        }`}
                      >
                        {isQuickQueueing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : isQuickQueued ? (
                          <Check className="w-4 h-4 stroke-[2.5]" />
                        ) : (
                          <Plus className="w-4 h-4 stroke-[2.5]" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Metadata Preview Editor (Single Track OR Playlist) */}
        {previewItems.length > 0 && (
          <div ref={metadataEditorRef} className="space-y-4 pt-3 border-t border-white/10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-white">
                  {playlistTitle
                    ? `Playlist: ${playlistTitle}`
                    : activeSearchResultId
                      ? 'Metadata Editor Preview'
                      : 'Metadata Preview'}
                </h3>
                <p className="text-xs text-[#B3B3B3]">
                  Review and edit tags before saving to{' '}
                  <code className="font-mono text-white">
                    {publicInfo?.musicDir || './music_library'}/&lt;Artist&gt;/&lt;Album&gt;/&lt;Title&gt;.{isSingleEditor ? previewItems[0].format : defaultFormat}
                  </code>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {activeSearchResultId && (
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewItems([]);
                      setActiveSearchResultId(null);
                    }}
                    className="rounded-full border border-white/15 px-3.5 py-2 text-xs font-semibold text-[#B3B3B3] hover:text-white hover:border-white/30 transition-colors"
                  >
                    Dismiss
                  </button>
                )}
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
                  className={`rounded-lg p-4 border transition-colors ${
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
                      <AlbumArt
                        externalUrl={item.thumbnail_url}
                        alt={item.title}
                        className="w-20 h-20 rounded-md"
                        iconSize={28}
                      />
                    </div>

                    <div className="flex-1 space-y-3 min-w-0">
                      {item.duplicateTrack && (
                        <div className="flex items-center gap-2 rounded bg-amber-500/15 border border-amber-500/30 px-3 py-1.5 text-xs text-amber-200">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span>
                            Already in library:{' '}
                            <strong>
                              {item.duplicateTrack.artist} — {item.duplicateTrack.title}
                            </strong>{' '}
                            ({item.duplicateTrack.album})
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
      </section>

      {/* Section 2: Drag & Drop Upload Local Audio Files */}
      <section className="rounded-xl bg-[#181818] border border-white/[0.06] p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-white">
              Upload Local Audio Files
            </h2>
            <p className="text-xs text-[#B3B3B3] mt-0.5">
              Files save directly to{' '}
              <code className="font-mono text-white">
                {publicInfo?.musicDir || './music_library'}/Uploads/
              </code>{' '}
              and are indexed automatically with cover art & metadata.
            </p>
          </div>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files?.length) {
              void uploadAudioFiles(e.dataTransfer.files);
            }
          }}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
          className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
            isDragging
              ? 'border-[#1DB954] bg-[#1DB954]/10'
              : 'border-white/15 bg-[#121212] hover:border-white/30'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".mp3,.m4a,.flac,.opus,.ogg,.wav,audio/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                void uploadAudioFiles(e.target.files);
              }
            }}
          />
          {uploading ? (
            <>
              <Loader2 className="w-8 h-8 text-[#1DB954] animate-spin mb-3" />
              <p className="text-sm font-semibold text-white">Uploading & indexing tracks...</p>
            </>
          ) : (
            <>
              <Upload className="w-8 h-8 text-[#1DB954] mb-3" />
              <p className="text-sm font-semibold text-white">
                Drop .mp3, .m4a, .flac, .opus, or .ogg files here, or click to browse
              </p>
              <p className="mt-1 text-xs text-[#6A6A6A]">
                Up to 25 files per batch · Embedded cover art & tags extracted automatically
              </p>
            </>
          )}
        </div>

        {uploadError && (
          <div className="rounded-md bg-red-500/10 border border-red-500/25 px-4 py-2.5 text-sm text-red-300">
            {uploadError}
          </div>
        )}

        {uploadResult && (
          <div className="rounded-md bg-[#1DB954]/10 border border-[#1DB954]/30 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#1DB954]">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{uploadResult.message}</span>
            </div>
            {uploadResult.tracks.length > 0 && (
              <div className="space-y-1.5">
                {uploadResult.tracks.map((tr) => (
                  <div
                    key={tr.id}
                    className="flex items-center justify-between gap-3 rounded bg-[#121212]/80 px-3 py-2"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <FileAudio className="w-4 h-4 text-[#1DB954] shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">{tr.title}</p>
                        <p className="text-xs text-[#B3B3B3] truncate">
                          {tr.artist} · {tr.album}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => playTrack(tr, uploadResult.tracks)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[#1DB954] px-3.5 py-1.5 text-xs font-bold text-black hover:bg-[#1ED760] shrink-0"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      Play Now
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Section 3: Live SSE Download Queue */}
      <section className="rounded-xl bg-[#181818] border border-white/[0.06] p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-white">Live Download Queue</h2>
          <span className="font-mono text-xs tabular-nums text-[#6A6A6A]">
            {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
          </span>
        </div>

        {jobs.length === 0 ? (
          <div className="rounded-lg bg-[#121212] p-8 text-center">
            <p className="text-sm text-[#B3B3B3]">No download jobs in the queue yet.</p>
            <p className="mt-1 text-xs text-[#6A6A6A]">
              Search or paste a URL above to preview metadata and start downloading.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => {
              const isError = job.status === 'error';
              const isComplete = job.status === 'completed';
              const isActive = job.status === 'downloading' || job.status === 'processing';

              return (
                <div
                  key={job.id}
                  className="rounded-lg bg-[#121212] border border-white/[0.06] p-4 space-y-3"
                >
                  <div className="flex items-center gap-3.5">
                    <AlbumArt
                      externalUrl={job.thumbnail_url}
                      alt={job.title}
                      className="w-12 h-12 rounded"
                      iconSize={20}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white truncate">{job.title}</p>
                        <span className="font-mono text-[11px] text-[#6A6A6A] shrink-0">
                          .{job.format}
                        </span>
                      </div>
                      <p className="text-xs text-[#B3B3B3] truncate">
                        {job.artist} · {job.album}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {/* Semantic status text with icon */}
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
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
                        {isActive && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1DB954]" />}
                        <span>{job.stage}</span>
                      </span>

                      {isComplete && job.track_id && (
                        <button
                          type="button"
                          onClick={() => void playTrackById(job.track_id!)}
                          className="inline-flex items-center gap-1.5 rounded-full bg-[#1DB954] px-3.5 py-1.5 text-xs font-bold text-black hover:bg-[#1ED760] transition-colors"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          Play Now
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

                  {/* Progress bar */}
                  <div className="space-y-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#282828]">
                      <div
                        className={`h-full transition-[width] duration-200 ${
                          isError ? 'bg-red-500' : 'bg-[#1DB954]'
                        }`}
                        style={{width: `${Math.max(isComplete ? 100 : job.progress, isActive ? 4 : 0)}%`}}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-[#6A6A6A] font-mono tabular-nums">
                      <span>Downloading → Cropping 1:1 Cover → Embedding Tags → Indexed</span>
                      <span>{Math.round(job.progress)}%</span>
                    </div>
                  </div>

                  {isError && expandedErrorId === job.id && job.error_log && (
                    <pre className="overflow-x-auto rounded bg-black/50 p-3 text-xs font-mono text-red-300 whitespace-pre-wrap">
                      {job.error_log}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
