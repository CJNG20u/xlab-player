import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Disc3,
  Download,
  FolderOpen,
  Link2,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
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
import {
  apiFetch,
  formatDuration,
  getSSEUrl,
  getYouTubeThumbProxyUrl,
} from '../lib/api';
import type {
  DiscoverAlbumItem,
  DiscoverArtistItem,
  DiscoverFeedResponse,
  DiscoverNewReleaseItem,
  DownloadJob,
  DownloadQuality,
  MetadataPreviewItem,
  SearchSource,
  Track,
} from '../types';
import {getOfflineTracks, subscribeOfflineStore} from '../utils/offlineStore';

interface EditablePreviewItem extends MetadataPreviewItem {
  selected: boolean;
  format: 'm4a' | 'opus' | 'mp3';
  quality: DownloadQuality;
}

const QUALITY_LABELS: Record<DownloadQuality, string> = {
  ultra: 'Ultra',
  high: '320k',
  standard: '128k',
};

// Client-side session cache so tab switches back to Discover render instantaneously
let sessionDiscoverCache: {userId: number; feed: DiscoverFeedResponse} | null = null;

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
    coverUrl: item.thumbnail_url || getYouTubeThumbProxyUrl(videoId),
    streamUrl: `/api/yt-stream/${encodeURIComponent(videoId)}`,
    isYouTubeStream: true,
    youtubeUrl: item.url || `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function discoverReleaseToTrack(item: DiscoverNewReleaseItem): Track {
  return {
    id: `yt-${item.videoId}`,
    rel_path: '',
    title: item.title,
    artist: item.artist,
    album: item.releaseLabel || 'New Release',
    track_number: null,
    year: null,
    duration: item.duration || 0,
    format: 'm4a',
    bitrate: 0,
    size_bytes: 0,
    cover_file: null,
    dominant_color: '#1f2937',
    added_at: '',
    liked: false,
    coverUrl: getYouTubeThumbProxyUrl(item.videoId),
    streamUrl: `/api/yt-stream/${encodeURIComponent(item.videoId)}`,
    isYouTubeStream: true,
    youtubeUrl: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
  };
}

function discoverAlbumToTrack(item: DiscoverAlbumItem): Track {
  return {
    id: `yt-${item.videoId}`,
    rel_path: '',
    title: item.title,
    artist: item.artist,
    album: item.title,
    track_number: null,
    year: null,
    duration: item.duration || 0,
    format: 'm4a',
    bitrate: 0,
    size_bytes: 0,
    cover_file: null,
    dominant_color: '#1f2937',
    added_at: '',
    liked: false,
    coverUrl: getYouTubeThumbProxyUrl(item.videoId),
    streamUrl: `/api/yt-stream/${encodeURIComponent(item.videoId)}`,
    isYouTubeStream: true,
    youtubeUrl: item.url || `https://www.youtube.com/watch?v=${item.videoId}`,
  };
}

function getArtistInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function hashToTint(seed: string): string {
  const palette = ['#2d4a3e', '#3b2e5a', '#4a3228', '#1e3a5f', '#4c2639', '#2b4754'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

interface DiscoverArtworkProps {
  videoId: string;
  fallbackUrl?: string;
  alt: string;
  shape: 'square' | 'circle';
  labelForFallback?: string;
  className?: string;
}

const DiscoverArtwork: React.FC<DiscoverArtworkProps> = ({
  videoId,
  fallbackUrl,
  alt,
  shape,
  labelForFallback,
  className = '',
}) => {
  const primarySrc = useMemo(() => getYouTubeThumbProxyUrl(videoId), [videoId]);
  const [stage, setStage] = useState<'primary' | 'fallback' | 'empty'>('primary');

  useEffect(() => {
    setStage('primary');
  }, [primarySrc, fallbackUrl]);

  const activeSrc =
    stage === 'primary'
      ? primarySrc
      : stage === 'fallback' && fallbackUrl
        ? fallbackUrl
        : null;

  const radiusClass = shape === 'circle' ? 'rounded-full' : 'rounded-lg';

  if (!activeSrc) {
    const tint = hashToTint(labelForFallback || alt || videoId);
    return (
      <div
        className={`w-full h-full flex items-center justify-center select-none ${radiusClass} ${className}`}
        style={{
          background: `linear-gradient(145deg, ${tint} 0%, var(--bg-elevated) 100%)`,
        }}
        aria-label={alt}
      >
        {shape === 'circle' ? (
          <span className="font-display text-2xl font-bold tracking-tight text-white/90">
            {getArtistInitials(labelForFallback || alt)}
          </span>
        ) : (
          <Disc3 className="w-10 h-10 text-white/55" />
        )}
      </div>
    );
  }

  return (
    <img
      src={activeSrc}
      alt={alt}
      draggable={false}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        if (stage === 'primary' && fallbackUrl) {
          setStage('fallback');
        } else {
          setStage('empty');
        }
      }}
      className={`w-full h-full object-cover bg-[var(--bg-elevated)] select-none ${radiusClass} ${className}`}
    />
  );
};

interface HorizontalShelfProps {
  title: string;
  children: React.ReactNode;
}

const HorizontalShelf: React.FC<HorizontalShelfProps> = ({title, children}) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const scrollShelf = (direction: 'left' | 'right') => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = Math.max(el.clientWidth * 0.75, 280);
    el.scrollBy({
      left: direction === 'left' ? -distance : distance,
      behavior: 'smooth',
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg sm:text-xl font-bold tracking-tight text-[var(--text-primary)]">
          {title}
        </h2>
        <div className="hidden md:flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => scrollShelf('left')}
            aria-label={`Scroll ${title} left`}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => scrollShelf('right')}
            aria-label={`Scroll ${title} right`}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="flex gap-2.5 sm:gap-3.5 overflow-x-auto pb-2 -mx-4 px-4 sm:-mx-2 sm:px-2 snap-x snap-mandatory no-scrollbar"
      >
        {children}
      </div>
    </section>
  );
};

const DiscoverSkeletonShelves: React.FC = () => (
  <div className="space-y-8" aria-label="Loading personalized recommendations">
    {/* New releases skeleton */}
    <div className="space-y-3">
      <div className="h-6 w-36 rounded bg-[var(--bg-elevated)] animate-pulse" />
      <div className="flex gap-3.5 overflow-hidden">
        {Array.from({length: 6}).map((_, i) => (
          <div key={i} className="w-[152px] sm:w-[172px] shrink-0 space-y-2.5 p-2">
            <div className="aspect-square w-full rounded-lg bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-3.5 w-4/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-3 w-3/5 rounded bg-[var(--bg-secondary)] animate-pulse" />
          </div>
        ))}
      </div>
    </div>

    {/* Artists to discover skeleton */}
    <div className="space-y-3">
      <div className="h-6 w-44 rounded bg-[var(--bg-elevated)] animate-pulse" />
      <div className="flex gap-3.5 overflow-hidden">
        {Array.from({length: 6}).map((_, i) => (
          <div key={i} className="w-[136px] sm:w-[152px] shrink-0 space-y-2.5 p-2 flex flex-col items-center">
            <div className="aspect-square w-full rounded-full bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-3.5 w-3/4 rounded bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-3 w-4/5 rounded bg-[var(--bg-secondary)] animate-pulse" />
          </div>
        ))}
      </div>
    </div>

    {/* Albums for you skeleton */}
    <div className="space-y-3">
      <div className="h-6 w-40 rounded bg-[var(--bg-elevated)] animate-pulse" />
      <div className="flex gap-3.5 overflow-hidden">
        {Array.from({length: 6}).map((_, i) => (
          <div key={i} className="w-[152px] sm:w-[172px] shrink-0 space-y-2.5 p-2">
            <div className="aspect-square w-full rounded-lg bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-3.5 w-4/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-[var(--bg-secondary)] animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  </div>
);

export const DiscoverPage: React.FC = () => {
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

  // Personalized Discover feed state
  const [discoverFeed, setDiscoverFeed] = useState<DiscoverFeedResponse | null>(() =>
    user && sessionDiscoverCache?.userId === user.id ? sessionDiscoverCache.feed : null
  );
  const [discoverLoading, setDiscoverLoading] = useState<boolean>(
    () => !(user && sessionDiscoverCache?.userId === user.id)
  );
  const [discoverRefreshing, setDiscoverRefreshing] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // YouTube / YouTube Music (yt-dlp) search results state
  const [searchSource, setSearchSource] = useState<SearchSource>('youtube');
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
  const [downloadQuality, setDownloadQuality] = useState<DownloadQuality>('ultra');
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
  const isDiscoverView = trimmedQuery.length === 0;

  const flashToast = useCallback((msg: string) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2800);
  }, []);

  // Load personalized Discover shelves from GET /api/discover
  const loadDiscoverFeed = useCallback(
    async (forceRefresh = false) => {
      if (offline || !user) {
        setDiscoverLoading(false);
        return;
      }
      if (!forceRefresh && sessionDiscoverCache?.userId === user.id) {
        setDiscoverFeed(sessionDiscoverCache.feed);
        setDiscoverLoading(false);
        return;
      }

      if (forceRefresh) {
        setDiscoverRefreshing(true);
      } else {
        setDiscoverLoading(true);
      }
      setDiscoverError(null);

      try {
        const endpoint = forceRefresh ? '/api/discover?refresh=1' : '/api/discover';
        const data = await apiFetch<DiscoverFeedResponse>(endpoint);
        sessionDiscoverCache = {userId: user.id, feed: data};
        setDiscoverFeed(data);
        if (forceRefresh) {
          flashToast('Recommendations refreshed');
        }
      } catch (err) {
        setDiscoverError(
          err instanceof Error ? err.message : 'Could not load Discover recommendations'
        );
      } finally {
        setDiscoverLoading(false);
        setDiscoverRefreshing(false);
      }
    },
    [flashToast, offline, user]
  );

  useEffect(() => {
    void loadDiscoverFeed(false);
  }, [loadDiscoverFeed]);

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

  const handlePlayDiscoverRelease = useCallback(
    (item: DiscoverNewReleaseItem) => {
      const trackId = `yt-${item.videoId}`;
      if (currentTrack?.id === trackId) {
        togglePlay();
        return;
      }
      const shelf = discoverFeed?.newReleases || [item];
      const queue = shelf.map(discoverReleaseToTrack);
      const matched = queue.find((t) => t.id === trackId) || discoverReleaseToTrack(item);
      playTrack(matched, queue);
    },
    [currentTrack?.id, discoverFeed?.newReleases, playTrack, togglePlay]
  );

  const handlePlayDiscoverAlbum = useCallback(
    (item: DiscoverAlbumItem) => {
      const trackId = `yt-${item.videoId}`;
      if (currentTrack?.id === trackId) {
        togglePlay();
        return;
      }
      const shelf = discoverFeed?.albumsForYou || [item];
      const queue = shelf.map(discoverAlbumToTrack);
      const matched = queue.find((t) => t.id === trackId) || discoverAlbumToTrack(item);
      playTrack(matched, queue);
    },
    [currentTrack?.id, discoverFeed?.albumsForYou, playTrack, togglePlay]
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

  const executeYouTubeSearch = useCallback(
    async (rawTerm: string, sourceOverride?: SearchSource) => {
      const term = rawTerm.trim();
      if (!term) return;
      if (offline) {
        setMetaError('YouTube search requires an internet connection.');
        return;
      }

      const activeSource = sourceOverride ?? searchSource;
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
          body: JSON.stringify({query: term, source: activeSource}),
        });

        if (res.musicDir) {
          setPublicInfo((prev) => (prev ? {...prev, musicDir: res.musicDir} : prev));
        }

        const isSearchMode =
          res.mode === 'search' || res.isSearch || !/^https?:\/\//i.test(term);

        if (isSearchMode) {
          setSearchResults(res.items || []);
          setLastSearchTerm(term);
          if (!res.items || res.items.length === 0) {
            setMetaError(
              `No ${activeSource === 'ytmusic' ? 'YouTube Music' : 'YouTube'} results found for "${term}". Try a different query.`
            );
          }
        } else {
          setIsPlaylistPreview(Boolean(res.isPlaylist));
          setPlaylistTitle(res.playlistTitle);
          const effectiveFormat = downloadQuality === 'ultra' ? defaultFormat : 'mp3';
          setPreviewItems(
            (res.items || []).map((item, idx) => ({
              ...item,
              selected: res.isPlaylist ? true : idx === 0,
              format: effectiveFormat,
              quality: downloadQuality,
            }))
          );
        }
      } catch (err) {
        setMetaError(err instanceof Error ? err.message : 'Could not fetch YouTube results');
      } finally {
        setFetchingMeta(false);
      }
    },
    [defaultFormat, downloadQuality, offline, searchSource]
  );

  const handleFetchMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedQuery) return;
    await executeYouTubeSearch(trimmedQuery);
  };

  const handleSelectArtistToDiscover = useCallback(
    (artist: DiscoverArtistItem) => {
      setQuery(artist.name);
      void executeYouTubeSearch(artist.name);
    },
    [executeYouTubeSearch]
  );

  const handleSearchAlbumTracks = useCallback(
    (e: React.MouseEvent, album: DiscoverAlbumItem) => {
      e.stopPropagation();
      const term = album.title.toLowerCase().includes(album.artist.toLowerCase())
        ? album.title
        : `${album.artist} ${album.title}`;
      setQuery(term);
      void executeYouTubeSearch(term);
    },
    [executeYouTubeSearch]
  );

  const handleQueryChange = (nextValue: string) => {
    setQuery(nextValue);
    if (nextValue.trim() === '') {
      setSearchResults([]);
      setLastSearchTerm(null);
      setActiveSearchResultId(null);
      setPreviewItems([]);
      setIsPlaylistPreview(false);
      setPlaylistTitle(null);
      setMetaError(null);
    }
  };

  const handleSelectSearchResult = (item: MetadataPreviewItem) => {
    if (!canDownload) {
      const clickedTrack = metadataItemToYouTubeTrack(item);
      if (currentTrack?.id === clickedTrack.id) {
        togglePlay();
      } else {
        const ytQueue = searchResults.map(metadataItemToYouTubeTrack);
        const matched = ytQueue.find((t) => t.id === clickedTrack.id) || clickedTrack;
        playTrack(matched, ytQueue);
      }
      return;
    }
    setActiveSearchResultId(item.id);
    setIsPlaylistPreview(false);
    setPlaylistTitle(null);
    setMetaError(null);
    setPreviewItems([
      {
        ...item,
        selected: true,
        format: downloadQuality === 'ultra' ? defaultFormat : 'mp3',
        quality: downloadQuality,
      },
    ]);
    requestAnimationFrame(() => {
      metadataEditorRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    });
  };

  const handleQuickDownloadResult = async (e: React.MouseEvent, item: MetadataPreviewItem) => {
    e.stopPropagation();
    if (!canDownload || quickQueueingId === item.id) return;
    setQuickQueueingId(item.id);
    setMetaError(null);
    const effectiveFormat = downloadQuality === 'ultra' ? defaultFormat : 'mp3';
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
              format: effectiveFormat,
              quality: downloadQuality,
              thumbnail_url: item.thumbnail_url,
            },
          ],
        }),
      });
      setQuickQueuedIds((prev) => new Set(prev).add(item.id));
      flashToast(
        downloadQuality === 'ultra'
          ? `Queued "${item.title}" (Ultra)`
          : `Queued "${item.title}" (${QUALITY_LABELS[downloadQuality]} MP3)`
      );
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
    if (selected.length === 0 || !canDownload) return;

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
            format: item.quality === 'ultra' ? item.format : 'mp3',
            quality: item.quality,
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
    handleQueryChange('');
    searchInputRef.current?.focus();
  };

  const selectedCount = previewItems.filter((i) => i.selected).length;
  const isSingleEditor = !isPlaylistPreview && previewItems.length === 1;
  const destinationLabel = publicInfo?.musicDir || '/music';

  const hasAnyDiscoverShelf = Boolean(
    discoverFeed &&
      (discoverFeed.newReleases.length > 0 ||
        discoverFeed.artistsToDiscover.length > 0 ||
        discoverFeed.albumsForYou.length > 0)
  );

  return (
    <div
      className="px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto space-y-5 pb-36 md:pb-12"
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
        <div className="min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
            Discover
          </h1>
          {isDiscoverView && discoverFeed && (
            <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
              {discoverFeed.basedOnLibrary && discoverFeed.seeds.length > 0
                ? `Picked from ${discoverFeed.seeds.join(', ')}`
                : 'Trending music picks'}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isDiscoverView && !offline && (
            <button
              type="button"
              onClick={() => void loadDiscoverFeed(true)}
              disabled={discoverLoading || discoverRefreshing}
              title="Refresh recommendations"
              aria-label="Refresh Discover recommendations"
              className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-3.5 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${discoverRefreshing ? 'animate-spin text-[var(--accent)]' : ''}`}
              />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          )}
          {!isDiscoverView && canDownload && (
            <div
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-secondary)] max-w-[52vw]"
              title={`Download destination: ${destinationLabel}`}
            >
              <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <code className="font-mono text-[var(--text-primary)] truncate">
                {destinationLabel}
              </code>
            </div>
          )}
        </div>
      </div>

      {/* Pinned Wide Top Search Bar */}
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-2.5 bg-[var(--bg-glass)] backdrop-blur-md">
        <form onSubmit={handleFetchMetadata} className="space-y-2.5">
          <div className="relative">
            {isUrlInput ? (
              <Link2 className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--accent)]" />
            ) : (
              <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)]" />
            )}
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="What do you want to play?"
              aria-label="What do you want to play?"
              className="w-full rounded-full bg-[var(--bg-elevated)] border border-[var(--border-subtle)] pl-11 pr-11 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none transition-colors shadow-sm"
            />
            {query && (
              <button
                type="button"
                onClick={handleClearInput}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)] transition-colors"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {!isDiscoverView && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {!isUrlInput && (
                  <div
                    className="inline-flex items-center rounded-md bg-[var(--bg-secondary)] p-0.5 border border-[var(--border-subtle)]"
                    role="group"
                    aria-label="Search source"
                  >
                    {(
                      [
                        {id: 'youtube', label: 'YouTube'},
                        {id: 'ytmusic', label: 'YT Music'},
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          if (searchSource === opt.id) return;
                          setSearchSource(opt.id);
                          if (lastSearchTerm && !offline) {
                            void executeYouTubeSearch(lastSearchTerm, opt.id);
                          }
                        }}
                        className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                          searchSource === opt.id
                            ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}

                {canDownload && (
                  <div
                    className="inline-flex items-center rounded-md bg-[var(--bg-secondary)] p-0.5 border border-[var(--border-subtle)]"
                    role="group"
                    aria-label="Download quality"
                  >
                    {(['ultra', 'high', 'standard'] as const).map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => {
                          setDownloadQuality(q);
                          const nextFmt = q === 'ultra' ? defaultFormat : 'mp3';
                          setPreviewItems((prev) =>
                            prev.map((p) => ({...p, quality: q, format: nextFmt}))
                          );
                        }}
                        title={
                          q === 'ultra'
                            ? 'Best native audio stream (no transcoding)'
                            : q === 'high'
                              ? '320 kbps MP3'
                              : '128 kbps MP3'
                        }
                        className={`px-2.5 py-1.5 rounded text-xs font-mono font-medium transition-colors whitespace-nowrap ${
                          downloadQuality === q
                            ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {QUALITY_LABELS[q]}
                      </button>
                    ))}
                  </div>
                )}

                {canDownload && downloadQuality === 'ultra' && (
                  <div className="hidden sm:inline-flex items-center rounded-md bg-[var(--bg-secondary)] p-0.5 border border-[var(--border-subtle)]">
                    {(['m4a', 'opus'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() => {
                          setDefaultFormat(fmt);
                          setPreviewItems((prev) =>
                            prev.map((p) =>
                              p.quality === 'ultra' ? {...p, format: fmt} : p
                            )
                          );
                        }}
                        className={`px-2.5 py-1.5 rounded text-xs font-mono font-medium transition-colors ${
                          defaultFormat === fmt
                            ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        .{fmt}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={fetchingMeta || !trimmedQuery || offline}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 ml-auto"
              >
                {fetchingMeta ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{isUrlInput ? 'Fetching...' : 'Searching...'}</span>
                  </>
                ) : (
                  <>
                    {isUrlInput ? <Link2 className="w-4 h-4" /> : <Search className="w-4 h-4" />}
                    <span>
                      {isUrlInput
                        ? 'Fetch YouTube URL'
                        : searchSource === 'ytmusic'
                          ? 'Search YT Music'
                          : 'Search YouTube'}
                    </span>
                  </>
                )}
              </button>
            </div>
          )}
        </form>
      </div>

      {/* Graceful warning if yt-dlp or ffmpeg is missing */}
      {!offline &&
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

      {/* =====================================================================
          MODE A: PERSONALIZED DISCOVER SHELVES (when search input is empty)
         ===================================================================== */}
      {isDiscoverView ? (
        <div className="space-y-8">
          {offline ? (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 text-center space-y-2">
              <WifiOff className="w-6 h-6 text-[var(--warn-text)] mx-auto" />
              <p className="text-sm font-medium text-[var(--text-primary)]">Offline Mode</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Type above to search your offline cached tracks. Reconnect to browse personalized
                Discover recommendations.
              </p>
            </div>
          ) : discoverLoading && !hasAnyDiscoverShelf ? (
            <DiscoverSkeletonShelves />
          ) : discoverError && !hasAnyDiscoverShelf ? (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 text-center space-y-3">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Couldn&apos;t load Discover recommendations
              </p>
              <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
                {discoverError}
              </p>
              <button
                type="button"
                onClick={() => void loadDiscoverFeed(true)}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Try again
              </button>
            </div>
          ) : hasAnyDiscoverShelf && discoverFeed ? (
            <>
              {/* Shelf 1: New releases */}
              {discoverFeed.newReleases.length > 0 && (
                <HorizontalShelf title="New releases">
                  {discoverFeed.newReleases.map((item) => {
                    const trackId = `yt-${item.videoId}`;
                    const isCurrent = currentTrack?.id === trackId;
                    const isItemPlaying = isCurrent && isPlaying && !isBuffering;
                    const isItemBuffering = isCurrent && isBuffering;

                    return (
                      <button
                        key={item.videoId}
                        type="button"
                        onClick={() => handlePlayDiscoverRelease(item)}
                        className="group w-[152px] sm:w-[172px] shrink-0 snap-start rounded-xl p-2 text-left transition-colors hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-[var(--bg-elevated)] shadow-md">
                          <DiscoverArtwork
                            videoId={item.videoId}
                            fallbackUrl={item.fallbackThumbnailUrl}
                            alt={item.title}
                            shape="square"
                            labelForFallback={item.title}
                            className="transition-transform duration-200 group-hover:scale-[1.03]"
                          />
                          {item.isNew && (
                            <span className="absolute top-2 left-2 z-10 rounded-full bg-[#f97316] px-2 py-0.5 text-[10px] font-bold tracking-wide text-white shadow-md leading-tight">
                              New
                            </span>
                          )}
                          <span
                            className={`absolute bottom-2 right-2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg transition-all duration-150 ${
                              isCurrent
                                ? 'opacity-100 translate-y-0'
                                : 'opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0'
                            }`}
                          >
                            {isItemBuffering ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : isItemPlaying ? (
                              <Pause className="w-4 h-4 fill-current" />
                            ) : (
                              <Play className="w-4 h-4 fill-current ml-0.5" />
                            )}
                          </span>
                        </div>

                        <div className="mt-2.5 min-w-0 space-y-0.5">
                          <p
                            className={`text-sm font-semibold truncate ${
                              isCurrent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                            }`}
                          >
                            {item.title}
                          </p>
                          <p className="text-xs text-[var(--text-secondary)] truncate">
                            {item.artist}
                            {item.releaseLabel ? ` · ${item.releaseLabel}` : ''}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </HorizontalShelf>
              )}

              {/* Shelf 2: Artists to discover */}
              {discoverFeed.artistsToDiscover.length > 0 && (
                <HorizontalShelf title="Artists to discover">
                  {discoverFeed.artistsToDiscover.map((artist) => (
                    <button
                      key={artist.id}
                      type="button"
                      onClick={() => handleSelectArtistToDiscover(artist)}
                      className="group w-[134px] sm:w-[154px] shrink-0 snap-start rounded-xl p-2 text-center transition-colors hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <div className="relative aspect-square w-full rounded-full overflow-hidden bg-[var(--bg-elevated)] shadow-md ring-1 ring-[var(--border-subtle)]">
                        <DiscoverArtwork
                          videoId={artist.videoId}
                          fallbackUrl={artist.fallbackThumbnailUrl}
                          alt={artist.name}
                          shape="circle"
                          labelForFallback={artist.name}
                          className="transition-transform duration-200 group-hover:scale-[1.04]"
                        />
                      </div>

                      <div className="mt-2.5 min-w-0 space-y-0.5">
                        <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                          {artist.name}
                        </p>
                        <p className="text-xs text-[var(--text-secondary)] truncate">
                          {artist.subtitle}
                        </p>
                      </div>
                    </button>
                  ))}
                </HorizontalShelf>
              )}

              {/* Shelf 3: Albums for you */}
              {discoverFeed.albumsForYou.length > 0 && (
                <HorizontalShelf title="Albums for you">
                  {discoverFeed.albumsForYou.map((album) => {
                    const trackId = `yt-${album.videoId}`;
                    const isCurrent = currentTrack?.id === trackId;
                    const isItemPlaying = isCurrent && isPlaying && !isBuffering;
                    const isItemBuffering = isCurrent && isBuffering;

                    return (
                      <div
                        key={album.videoId}
                        role="button"
                        tabIndex={0}
                        onClick={() => handlePlayDiscoverAlbum(album)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handlePlayDiscoverAlbum(album);
                          }
                        }}
                        className="group w-[152px] sm:w-[172px] shrink-0 snap-start rounded-xl p-2 text-left transition-colors hover:bg-[var(--bg-secondary)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-[var(--bg-elevated)] shadow-md">
                          <DiscoverArtwork
                            videoId={album.videoId}
                            fallbackUrl={album.fallbackThumbnailUrl}
                            alt={album.title}
                            shape="square"
                            labelForFallback={album.title}
                            className="transition-transform duration-200 group-hover:scale-[1.03]"
                          />
                          <button
                            type="button"
                            onClick={(e) => handleSearchAlbumTracks(e, album)}
                            title={`Search tracks from ${album.title}`}
                            aria-label={`Search tracks from ${album.title}`}
                            className="absolute top-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/85 transition-opacity"
                          >
                            <Search className="w-3.5 h-3.5" />
                          </button>
                          <span
                            className={`absolute bottom-2 right-2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg transition-all duration-150 ${
                              isCurrent
                                ? 'opacity-100 translate-y-0'
                                : 'opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0'
                            }`}
                          >
                            {isItemBuffering ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : isItemPlaying ? (
                              <Pause className="w-4 h-4 fill-current" />
                            ) : (
                              <Play className="w-4 h-4 fill-current ml-0.5" />
                            )}
                          </span>
                        </div>

                        <div className="mt-2.5 min-w-0 space-y-0.5">
                          <p
                            className={`text-sm font-semibold truncate ${
                              isCurrent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                            }`}
                          >
                            {album.title}
                          </p>
                          <p className="text-xs font-medium text-[var(--text-secondary)] truncate">
                            {album.artist}
                          </p>
                          <p className="text-[11px] text-[var(--text-muted)] truncate">
                            {album.subtitle}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </HorizontalShelf>
              )}
            </>
          ) : (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-5 py-8 text-center space-y-2">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Explore tracks across your library and YouTube
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                Search for any song, artist, album, or paste a YouTube link above to stream or save
                it to your library.
              </p>
            </div>
          )}

          {/* Active Download Progress Queue (visible below Discover shelves when jobs exist) */}
          {canDownload && !offline && jobs.length > 0 && (
            <section className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-bold tracking-tight text-[var(--text-secondary)]">
                  Download Progress
                </h2>
                <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
                  {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
                </span>
              </div>

              <div className="space-y-2.5">
                {jobs.slice(0, 6).map((job) => {
                  const isError = job.status === 'error';
                  const isComplete = job.status === 'completed';
                  const isActive = job.status === 'downloading' || job.status === 'processing';

                  return (
                    <div
                      key={job.id}
                      className="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-3.5 space-y-2"
                    >
                      <div className="flex items-center gap-3">
                        <AlbumArt
                          externalUrl={job.thumbnail_url}
                          alt={job.title}
                          className="w-10 h-10 rounded shrink-0"
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
                          {isComplete && job.track_id && (
                            <button
                              type="button"
                              onClick={() => void playTrackById(job.track_id!)}
                              className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                              <span>Play</span>
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
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : (
        /* =====================================================================
           MODE B: ACTIVE LIVE SEARCH (Local Library + YouTube Results)
           ===================================================================== */
        <div className="space-y-6">
          {metaError && (
            <div className="rounded-lg bg-[var(--danger-bg)] border border-[var(--danger-border)] px-4 py-3 text-sm text-[var(--danger-text)]">
              {metaError}
            </div>
          )}

          {/* SECTION 1: In Your Library (live-filtered as user types) */}
          {!isUrlInput && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-sm font-bold tracking-tight text-[var(--text-secondary)]">
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
                  {!offline && (
                    <button
                      type="button"
                      disabled={fetchingMeta}
                      onClick={() => void executeYouTubeSearch(trimmedQuery)}
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
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-sm font-bold tracking-tight text-[var(--text-secondary)]">
                YouTube Results
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
                  You can search and play your cached tracks above. Reconnect to search or stream
                  from YouTube.
                </p>
              </div>
            ) : (
              <>
                {searchResults.length === 0 && previewItems.length === 0 && !fetchingMeta && (
                  <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-5 py-7 text-center space-y-1.5">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      Press Enter or tap &ldquo;
                      {isUrlInput
                        ? 'Fetch YouTube URL'
                        : searchSource === 'ytmusic'
                          ? 'Search YT Music'
                          : 'Search YouTube'}
                      &rdquo;
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      Stream full tracks right in the player
                      {canDownload ? (
                        <>
                          {' '}
                          or save directly into{' '}
                          <code className="font-mono text-[var(--text-secondary)]">
                            {destinationLabel}/tracks
                          </code>{' '}
                          ({downloadQuality === 'ultra' ? 'best native audio' : `${QUALITY_LABELS[downloadQuality]} MP3`})
                        </>
                      ) : null}
                      .
                    </p>
                  </div>
                )}

                {fetchingMeta && (
                  <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-8 flex items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
                    <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
                    <span>
                      {isUrlInput
                        ? 'Reading YouTube metadata...'
                        : `Searching ${searchSource === 'ytmusic' ? 'YouTube Music' : 'YouTube'} for "${trimmedQuery}"...`}
                    </span>
                  </div>
                )}

                {searchResults.length > 0 && (
                  <div className="space-y-2">
                    {lastSearchTerm && (
                      <p className="text-xs text-[var(--text-muted)]">
                        {searchSource === 'ytmusic' ? 'YouTube Music' : 'YouTube'} results for &ldquo;
                        {lastSearchTerm}&rdquo;
                        {canDownload ? (
                          <>
                            {' '}
                            · Tap a track to edit tags, or{' '}
                            <span className="text-[var(--text-secondary)] font-semibold">+</span>{' '}
                            for one-tap{' '}
                            <code className="font-mono text-[var(--text-secondary)]">
                              {downloadQuality === 'ultra'
                                ? 'Ultra'
                                : `${QUALITY_LABELS[downloadQuality]} mp3`}
                            </code>{' '}
                            download.
                          </>
                        ) : (
                          ' · Tap any track to stream.'
                        )}
                      </p>
                    )}

                    <div className="space-y-2">
                      {searchResults.map((item) => {
                        const videoId = extractYouTubeVideoIdFromItem(item);
                        const ytTrackId = `yt-${videoId}`;
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
                        const isQuickQueued =
                          quickQueuedIds.has(item.id) || isJobActive || isJobComplete;

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
                              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded overflow-hidden shrink-0">
                                <DiscoverArtwork
                                  videoId={videoId}
                                  fallbackUrl={item.thumbnail_url}
                                  alt={item.title}
                                  shape="square"
                                  labelForFallback={item.title}
                                />
                              </div>

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
                                    <span className="text-[11px] font-medium text-[var(--warn-text)] shrink-0">
                                      · In Library
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
                                  title={isStreamPlaying ? 'Pause track' : 'Play in player'}
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

                                {canDownload &&
                                  (isJobComplete && matchingJob?.track_id ? (
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
                                  ))}
                              </div>
                            </div>

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
                {canDownload && previewItems.length > 0 && (
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
                          Deduplicated storage:{' '}
                          <code className="font-mono text-[var(--text-secondary)]">
                            {destinationLabel}/tracks/&lt;sha256&gt;.
                            {isSingleEditor
                              ? previewItems[0].quality === 'ultra'
                                ? previewItems[0].format
                                : 'mp3'
                              : downloadQuality === 'ultra'
                                ? defaultFormat
                                : 'mp3'}
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
                                      onClick={(e) =>
                                        handlePlayYouTubeItem(e, item, previewItems)
                                      }
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
                                    Quality &amp; Length
                                  </label>
                                  <div className="flex items-center gap-2">
                                    <select
                                      value={item.quality}
                                      onChange={(e) => {
                                        const nextQ = e.target.value as DownloadQuality;
                                        updatePreviewItem(item.id, {
                                          quality: nextQ,
                                          format: nextQ === 'ultra' ? defaultFormat : 'mp3',
                                        });
                                      }}
                                      className="flex-1 rounded bg-[var(--bg-input)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm font-mono text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                                    >
                                      <option value="ultra">Ultra (Native)</option>
                                      <option value="high">High (320k MP3)</option>
                                      <option value="standard">Standard (128k MP3)</option>
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
                {canDownload && jobs.length > 0 && (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center justify-between">
                      <h3 className="font-display text-xs font-bold tracking-tight text-[var(--text-secondary)]">
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
                                      setExpandedErrorId(
                                        expandedErrorId === job.id ? null : job.id
                                      )
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
        </div>
      )}
    </div>
  );
};
