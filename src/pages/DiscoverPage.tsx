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
  Link2,
  Loader2,
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
import {CatalogDetailView, type CatalogRoute} from '../components/CatalogDetailView';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {
  apiFetch,
  formatDuration,
  getCatalogMatchStreamUrl,
  getSSEUrl,
  getYouTubeThumbProxyUrl,
  prefetchYouTubeStreams,
} from '../lib/api';
import type {
  DiscoverAlbumItem,
  DiscoverArtistItem,
  DiscoverFeedResponse,
  DiscoverNewReleaseItem,
  DownloadJob,
  DownloadQuality,
  MetadataPreviewItem,
  Track,
} from '../types';

interface EditablePreviewItem extends MetadataPreviewItem {
  selected: boolean;
  format: 'm4a' | 'opus' | 'mp3';
  quality: DownloadQuality;
}

const SEARCH_DEBOUNCE_MS = 450;
const DEFAULT_DOWNLOAD_FORMAT: 'm4a' = 'm4a';
const DEFAULT_DOWNLOAD_QUALITY: DownloadQuality = 'ultra';

// Client-side session cache keyed by user + last-played artist so tab switches render
// instantaneously while playing a new artist immediately invalidates & refreshes Discover.
let sessionDiscoverCache: {
  userId: number;
  seedArtistKey: string;
  feed: DiscoverFeedResponse;
} | null = null;

const GENERIC_ARTIST_LABELS = new Set([
  '',
  'unknown',
  'unknown artist',
  'youtube',
  'various artists',
  'various',
  'va',
  'none',
  'untitled',
]);

function stripArtistLabelNoise(raw: string): string {
  return raw
    .trim()
    .replace(/\s*[-–—]\s*topic$/i, '')
    .replace(/\s+official\s*(music\s*)?(channel|video|audio)?$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDisplayArtist(artist: string | null | undefined, title?: string | null): string {
  const cleaned = stripArtistLabelNoise(artist || '');
  const norm = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (norm && !GENERIC_ARTIST_LABELS.has(norm)) {
    return cleaned;
  }
  const rawTitle = (title || '').trim();
  const sepMatch = /^(.{2,60}?)\s+[-–—]\s+(.+)$/.exec(rawTitle);
  if (sepMatch) {
    const extracted = stripArtistLabelNoise(sepMatch[1]);
    const extractedNorm = extracted.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (extractedNorm && !GENERIC_ARTIST_LABELS.has(extractedNorm)) {
      return extracted;
    }
  }
  return '';
}

function normalizeArtistSeedKey(artist: string | null | undefined, title?: string | null): string {
  const display = extractDisplayArtist(artist, title);
  return display.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
    coverUrl: item.thumbnail_url || getYouTubeThumbProxyUrl(videoId),
    streamUrl: `/api/yt-stream/${encodeURIComponent(videoId)}`,
    isYouTubeStream: true,
    youtubeUrl: item.url || `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function discoverReleaseToTrack(item: DiscoverNewReleaseItem): Track {
  const hasVid = Boolean(item.videoId && /^[A-Za-z0-9_-]{6,20}$/.test(item.videoId));
  const trackId = hasVid
    ? `yt-${item.videoId}`
    : item.id || `dz-track-${item.deezerTrackId || `${item.artist}-${item.title}`}`;
  const coverUrl =
    item.thumbnailUrl || (hasVid ? getYouTubeThumbProxyUrl(item.videoId!) : undefined);
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
    album: item.album || item.releaseLabel || 'New Release',
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
    coverUrl,
    streamUrl,
    isYouTubeStream: true,
    youtubeUrl: hasVid ? `https://www.youtube.com/watch?v=${item.videoId}` : undefined,
    deezerTrackId: item.deezerTrackId,
    deezerAlbumId: item.albumId,
    deezerArtistId: item.artistId,
  };
}

function discoverAlbumToTrack(item: DiscoverAlbumItem): Track {
  const hasVid = Boolean(item.videoId && /^[A-Za-z0-9_-]{6,20}$/.test(item.videoId));
  const trackId = hasVid ? `yt-${item.videoId}` : item.id || `dz-album-${item.deezerAlbumId || item.title}`;
  const coverUrl =
    item.thumbnailUrl || (hasVid ? getYouTubeThumbProxyUrl(item.videoId!) : undefined);
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
    coverUrl,
    streamUrl,
    isYouTubeStream: true,
    youtubeUrl: hasVid ? `https://www.youtube.com/watch?v=${item.videoId}` : undefined,
    deezerAlbumId: item.deezerAlbumId,
    deezerArtistId: item.artistId,
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
  directUrl?: string;
  videoId?: string;
  fallbackUrl?: string;
  alt: string;
  shape: 'square' | 'circle';
  labelForFallback?: string;
  className?: string;
}

const DiscoverArtwork: React.FC<DiscoverArtworkProps> = ({
  directUrl,
  videoId,
  fallbackUrl,
  alt,
  shape,
  labelForFallback,
  className = '',
}) => {
  const primarySrc = useMemo(() => {
    if (directUrl && /^https?:\/\//i.test(directUrl)) return directUrl;
    if (videoId) return getYouTubeThumbProxyUrl(videoId);
    return fallbackUrl || '';
  }, [directUrl, fallbackUrl, videoId]);

  const secondarySrc = useMemo(() => {
    if (fallbackUrl && fallbackUrl !== primarySrc) return fallbackUrl;
    if (videoId) {
      const ytUrl = getYouTubeThumbProxyUrl(videoId);
      if (ytUrl !== primarySrc) return ytUrl;
    }
    return '';
  }, [fallbackUrl, primarySrc, videoId]);

  const [stage, setStage] = useState<'primary' | 'fallback' | 'empty'>(
    primarySrc ? 'primary' : 'empty'
  );

  useEffect(() => {
    setStage(primarySrc ? 'primary' : secondarySrc ? 'fallback' : 'empty');
  }, [primarySrc, secondarySrc]);

  const activeSrc =
    stage === 'primary'
      ? primarySrc
      : stage === 'fallback' && secondarySrc
        ? secondarySrc
        : null;

  const radiusClass = shape === 'circle' ? 'rounded-full' : 'rounded-lg';

  if (!activeSrc) {
    const tint = hashToTint(labelForFallback || alt || videoId || 'music');
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
        if (stage === 'primary' && secondarySrc) {
          setStage('fallback');
        } else {
          setStage('empty');
        }
      }}
      className={`w-full h-full object-cover bg-[var(--bg-elevated)] select-none ${radiusClass} ${className}`}
    />
  );
};

interface ResponsiveDiscoverShelfProps {
  title: string;
  variant: 'square' | 'circle';
  children: React.ReactNode;
}

const ResponsiveDiscoverShelf: React.FC<ResponsiveDiscoverShelfProps> = ({
  title,
  variant,
  children,
}) => {
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

  const desktopGridClasses =
    variant === 'circle'
      ? 'lg:grid lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10 lg:gap-3 lg:overflow-visible lg:mx-0 lg:px-0 lg:pb-0'
      : 'lg:grid lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 min-[1720px]:grid-cols-10 lg:gap-3 lg:overflow-visible lg:mx-0 lg:px-0 lg:pb-0';

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg sm:text-xl font-bold tracking-tight text-[var(--text-primary)]">
          {title}
        </h2>
        <div className="hidden sm:flex lg:hidden items-center gap-1.5 shrink-0">
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
        className={`flex gap-2.5 sm:gap-3.5 overflow-x-auto pb-2 -mx-4 px-4 sm:-mx-2 sm:px-2 snap-x snap-mandatory no-scrollbar ${desktopGridClasses}`}
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
      <div className="flex gap-3 overflow-hidden lg:grid lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
        {Array.from({length: 8}).map((_, i) => (
          <div key={i} className="w-[144px] sm:w-[164px] lg:w-auto shrink-0 space-y-2.5 p-2">
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
      <div className="flex gap-3 overflow-hidden lg:grid lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10">
        {Array.from({length: 10}).map((_, i) => (
          <div
            key={i}
            className="w-[128px] sm:w-[144px] lg:w-auto shrink-0 space-y-2.5 p-2 flex flex-col items-center"
          >
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
      <div className="flex gap-3 overflow-hidden lg:grid lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
        {Array.from({length: 8}).map((_, i) => (
          <div key={i} className="w-[144px] sm:w-[164px] lg:w-auto shrink-0 space-y-2.5 p-2">
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
    lastPlayed,
    playTrackById,
    playTrack,
    bumpLibraryRefresh,
    isPlaying,
    isBuffering,
    togglePlay,
  } = usePlayer();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const canDownload = Boolean(user?.can_download || user?.role === 'admin');

  const [query, setQuery] = useState('');

  const lastPlayedArtistKey = useMemo(
    () => normalizeArtistSeedKey(lastPlayed?.artist, lastPlayed?.title),
    [lastPlayed?.artist, lastPlayed?.title]
  );

  // Personalized Discover feed + instant Album/Artist catalog drill-down stack
  const [discoverFeed, setDiscoverFeed] = useState<DiscoverFeedResponse | null>(() =>
    user &&
    sessionDiscoverCache?.userId === user.id &&
    sessionDiscoverCache.seedArtistKey ===
      normalizeArtistSeedKey(lastPlayed?.artist, lastPlayed?.title)
      ? sessionDiscoverCache.feed
      : null
  );
  const [discoverLoading, setDiscoverLoading] = useState<boolean>(
    () =>
      !(
        user &&
        sessionDiscoverCache?.userId === user.id &&
        sessionDiscoverCache.seedArtistKey ===
          normalizeArtistSeedKey(lastPlayed?.artist, lastPlayed?.title)
      )
  );
  const [discoverRefreshing, setDiscoverRefreshing] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [catalogStack, setCatalogStack] = useState<CatalogRoute[]>([]);
  const activeCatalogRoute =
    catalogStack.length > 0 ? catalogStack[catalogStack.length - 1] : null;

  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Automatic YouTube (yt-dlp) search results state
  const [searchResults, setSearchResults] = useState<MetadataPreviewItem[]>([]);
  const [lastSearchTerm, setLastSearchTerm] = useState<string | null>(null);
  const [quickQueueingId, setQuickQueueingId] = useState<string | null>(null);
  const [quickQueuedIds, setQuickQueuedIds] = useState<Set<string>>(new Set());

  // Pasted-URL single-track / playlist metadata preview state
  const [previewItems, setPreviewItems] = useState<EditablePreviewItem[]>([]);
  const [isPlaylistPreview, setIsPlaylistPreview] = useState(false);
  const [playlistTitle, setPlaylistTitle] = useState<string | null>(null);
  const [enqueueing, setEnqueueing] = useState(false);
  const [actionToast, setActionToast] = useState<string | null>(null);

  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [expandedErrorId, setExpandedErrorId] = useState<number | null>(null);

  const [publicInfo, setPublicInfo] = useState<{
    musicDir: string;
    ytdlpInstalled: boolean;
    ffmpegInstalled: boolean;
  } | null>(null);

  const pageRootRef = useRef<HTMLDivElement | null>(null);
  const searchSentinelRef = useRef<HTMLDivElement | null>(null);
  const metadataEditorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestIdRef = useRef(0);
  const inFlightTermRef = useRef<string | null>(null);
  const skipNextDebounceTermRef = useRef<string | null>(null);
  const [searchPinned, setSearchPinned] = useState(false);

  const trimmedQuery = query.trim();
  const isUrlInput = /^https?:\/\//i.test(trimmedQuery);
  const isDiscoverView = trimmedQuery.length === 0;

  const flashToast = useCallback((msg: string) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2800);
  }, []);

  const discoverRequestIdRef = useRef(0);
  const hasLoadedDiscoverFeedRef = useRef(Boolean(discoverFeed));
  hasLoadedDiscoverFeedRef.current = Boolean(discoverFeed);

  // Load personalized Discover shelves from GET /api/discover (auto-invalidates when last-played artist changes)
  const loadDiscoverFeed = useCallback(
    async (forceRefresh = false) => {
      if (offline || !user) {
        setDiscoverLoading(false);
        return;
      }
      if (
        !forceRefresh &&
        sessionDiscoverCache?.userId === user.id &&
        sessionDiscoverCache.seedArtistKey === lastPlayedArtistKey
      ) {
        setDiscoverFeed(sessionDiscoverCache.feed);
        setDiscoverLoading(false);
        return;
      }

      const reqId = ++discoverRequestIdRef.current;

      if (forceRefresh || hasLoadedDiscoverFeedRef.current) {
        setDiscoverRefreshing(true);
      } else {
        setDiscoverLoading(true);
      }
      setDiscoverError(null);

      try {
        const qs = new URLSearchParams();
        if (forceRefresh) qs.set('refresh', '1');
        if (lastPlayed?.artist?.trim()) qs.set('seedArtist', lastPlayed.artist.trim());
        if (lastPlayed?.title?.trim()) qs.set('seedTitle', lastPlayed.title.trim());
        const queryString = qs.toString();
        const endpoint = queryString ? `/api/discover/feed?${queryString}` : '/api/discover/feed';

        const data = await apiFetch<DiscoverFeedResponse>(endpoint);
        if (discoverRequestIdRef.current !== reqId) return;

        sessionDiscoverCache = {
          userId: user.id,
          seedArtistKey: lastPlayedArtistKey,
          feed: data,
        };
        setDiscoverFeed(data);
        if (forceRefresh) {
          flashToast('Recommendations refreshed');
        }
      } catch (err) {
        if (discoverRequestIdRef.current !== reqId) return;
        setDiscoverError(
          err instanceof Error ? err.message : 'Could not load Discover recommendations'
        );
      } finally {
        if (discoverRequestIdRef.current === reqId) {
          setDiscoverLoading(false);
          setDiscoverRefreshing(false);
        }
      }
    },
    [flashToast, lastPlayed?.artist, lastPlayed?.title, lastPlayedArtistKey, offline, user]
  );

  const loadDiscoverFeedRef = useRef(loadDiscoverFeed);
  loadDiscoverFeedRef.current = loadDiscoverFeed;

  // Trigger initial load and automatically refresh whenever the last-played artist changes
  useEffect(() => {
    void loadDiscoverFeedRef.current(false);
  }, [lastPlayedArtistKey, offline, user?.id]);

  // Background prefetch the top 3 visible Discover tracks once the Discover feed loads
  const prefetchedDiscoverKeyRef = useRef<string>('');
  useEffect(() => {
    if (offline || !discoverFeed || discoverFeed.newReleases.length === 0) return;
    const topThree = discoverFeed.newReleases.slice(0, 3);
    const key = topThree.map((i) => i.id || i.videoId || `${i.artist}:${i.title}`).join('|');
    if (prefetchedDiscoverKeyRef.current === key) return;
    prefetchedDiscoverKeyRef.current = key;

    prefetchYouTubeStreams(
      topThree.map((item) => ({
        videoId: item.videoId,
        artist: item.artist,
        title: item.title,
        duration: item.duration,
      }))
    );
  }, [discoverFeed, offline]);

  // Background prefetch the top 3 search results as soon as they render so tapping plays near-instantly
  const prefetchedSearchKeyRef = useRef<string>('');
  useEffect(() => {
    if (offline) return;
    const candidates = searchResults.length > 0 ? searchResults : previewItems;
    if (candidates.length === 0) return;

    const topThree = candidates.slice(0, 3);
    const itemsToPrefetch = topThree
      .map((item) => ({
        videoId: extractYouTubeVideoIdFromItem(item),
        artist: item.channel || item.artist,
        title: item.title,
        duration: item.duration,
      }))
      .filter((item) => Boolean(item.videoId || item.title));
    if (itemsToPrefetch.length === 0) return;

    const key = itemsToPrefetch.map((i) => i.videoId || `${i.artist}:${i.title}`).join('|');
    if (prefetchedSearchKeyRef.current === key) return;
    prefetchedSearchKeyRef.current = key;

    prefetchYouTubeStreams(itemsToPrefetch);
  }, [offline, previewItems, searchResults]);

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

  const scrollStageToTop = useCallback(() => {
    const mainEl = pageRootRef.current?.closest('main');
    if (mainEl) {
      mainEl.scrollTo({top: 0, behavior: 'smooth'});
    }
    window.scrollTo({top: 0, behavior: 'smooth'});
  }, []);

  const handlePlayDiscoverRelease = useCallback(
    (item: DiscoverNewReleaseItem) => {
      const shelf = discoverFeed?.newReleases || [item];
      const clickedIdx = Math.max(
        0,
        shelf.findIndex(
          (entry) =>
            (item.id && entry.id === item.id) ||
            (item.deezerTrackId && entry.deezerTrackId === item.deezerTrackId)
        )
      );
      prefetchYouTubeStreams(
        shelf.slice(clickedIdx, clickedIdx + 3).map((entry) => ({
          videoId: entry.videoId,
          artist: entry.artist,
          title: entry.title,
          duration: entry.duration,
        }))
      );

      const targetTrack = discoverReleaseToTrack(item);
      if (
        currentTrack?.id === targetTrack.id ||
        (item.deezerTrackId && currentTrack?.deezerTrackId === item.deezerTrackId)
      ) {
        togglePlay();
        return;
      }
      const queue = shelf.map(discoverReleaseToTrack);
      const matched =
        queue.find(
          (t) =>
            t.id === targetTrack.id ||
            (item.deezerTrackId && t.deezerTrackId === item.deezerTrackId)
        ) || targetTrack;
      playTrack(matched, queue);
    },
    [currentTrack?.deezerTrackId, currentTrack?.id, discoverFeed?.newReleases, playTrack, togglePlay]
  );

  const handleOpenAlbumView = useCallback(
    (album: {id: string; titleHint?: string; artistHint?: string; coverHint?: string}) => {
      setCatalogStack((prev) => [...prev, {type: 'album', ...album}]);
      scrollStageToTop();
    },
    [scrollStageToTop]
  );

  const handleOpenArtistView = useCallback(
    (artist: {id: string; nameHint?: string; pictureHint?: string}) => {
      setCatalogStack((prev) => [...prev, {type: 'artist', ...artist}]);
      scrollStageToTop();
    },
    [scrollStageToTop]
  );

  const handlePopCatalogView = useCallback(() => {
    setCatalogStack((prev) => prev.slice(0, -1));
    scrollStageToTop();
  }, [scrollStageToTop]);

  const handleOpenDiscoverRelease = useCallback(
    (item: DiscoverNewReleaseItem) => {
      if (item.albumId) {
        handleOpenAlbumView({
          id: item.albumId,
          titleHint: item.album || item.title,
          artistHint: item.artist,
          coverHint: item.thumbnailUrl,
        });
        return;
      }
      handlePlayDiscoverRelease(item);
    },
    [handleOpenAlbumView, handlePlayDiscoverRelease]
  );

  const handleOpenDiscoverAlbum = useCallback(
    (item: DiscoverAlbumItem) => {
      if (item.deezerAlbumId) {
        handleOpenAlbumView({
          id: item.deezerAlbumId,
          titleHint: item.title,
          artistHint: item.artist,
          coverHint: item.thumbnailUrl,
        });
        return;
      }
      const target = discoverAlbumToTrack(item);
      if (currentTrack?.id === target.id) {
        togglePlay();
        return;
      }
      const shelf = discoverFeed?.albumsForYou || [item];
      const queue = shelf.map(discoverAlbumToTrack);
      playTrack(target, queue);
    },
    [currentTrack?.id, discoverFeed?.albumsForYou, handleOpenAlbumView, playTrack, togglePlay]
  );

  const cancelInFlightSearch = useCallback(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
      searchAbortRef.current = null;
    }
    inFlightTermRef.current = null;
    searchRequestIdRef.current += 1;
  }, []);

  const executeYouTubeSearch = useCallback(
    async (rawTerm: string) => {
      const term = rawTerm.trim();
      if (!term) return;

      // If an identical search is already in flight, let it finish instead of restarting
      if (searchAbortRef.current && inFlightTermRef.current === term) {
        return;
      }

      cancelInFlightSearch();

      if (offline) {
        setFetchingMeta(false);
        setMetaError('YouTube search requires an internet connection.');
        return;
      }

      const controller = new AbortController();
      searchAbortRef.current = controller;
      inFlightTermRef.current = term;
      const requestId = searchRequestIdRef.current;

      setFetchingMeta(true);
      setMetaError(null);
      setPreviewItems([]);
      setIsPlaylistPreview(false);
      setPlaylistTitle(null);
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
          signal: controller.signal,
          body: JSON.stringify({query: term, source: 'youtube'}),
        });

        if (controller.signal.aborted || searchRequestIdRef.current !== requestId) {
          return;
        }

        if (res.musicDir) {
          setPublicInfo((prev) => (prev ? {...prev, musicDir: res.musicDir} : prev));
        }

        const isSearchMode =
          res.mode === 'search' || res.isSearch || !/^https?:\/\//i.test(term);

        if (isSearchMode) {
          setSearchResults(res.items || []);
          setLastSearchTerm(term);
          if (!res.items || res.items.length === 0) {
            setMetaError(`No YouTube results found for "${term}". Try a different query.`);
          }
        } else {
          setSearchResults([]);
          setLastSearchTerm(term);
          setIsPlaylistPreview(Boolean(res.isPlaylist));
          setPlaylistTitle(res.playlistTitle);
          setPreviewItems(
            (res.items || []).map((item, idx) => ({
              ...item,
              selected: res.isPlaylist ? true : idx === 0,
              format: DEFAULT_DOWNLOAD_FORMAT,
              quality: DEFAULT_DOWNLOAD_QUALITY,
            }))
          );
        }
      } catch (err) {
        if (
          controller.signal.aborted ||
          searchRequestIdRef.current !== requestId ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return;
        }
        setSearchResults([]);
        setMetaError(err instanceof Error ? err.message : 'Could not fetch YouTube results');
      } finally {
        if (searchAbortRef.current === controller) {
          searchAbortRef.current = null;
          inFlightTermRef.current = null;
        }
        if (searchRequestIdRef.current === requestId) {
          setFetchingMeta(false);
        }
      }
    },
    [cancelInFlightSearch, offline]
  );

  // Automatic 450ms debounced search as the user types, cancelling stale requests on change
  useEffect(() => {
    if (!trimmedQuery) {
      cancelInFlightSearch();
      setFetchingMeta(false);
      return;
    }

    if (skipNextDebounceTermRef.current === trimmedQuery) {
      skipNextDebounceTermRef.current = null;
      return;
    }

    if (offline) {
      cancelInFlightSearch();
      setFetchingMeta(false);
      return;
    }

    // Cancel any in-flight previous search immediately when the query changes
    cancelInFlightSearch();
    setFetchingMeta(false);
    setMetaError(null);

    const timer = setTimeout(() => {
      searchDebounceRef.current = null;
      void executeYouTubeSearch(trimmedQuery);
    }, SEARCH_DEBOUNCE_MS);
    searchDebounceRef.current = timer;

    return () => {
      clearTimeout(timer);
      if (searchDebounceRef.current === timer) {
        searchDebounceRef.current = null;
      }
    };
  }, [cancelInFlightSearch, executeYouTubeSearch, offline, trimmedQuery]);

  // Abort any in-flight search request on unmount
  useEffect(() => {
    return () => {
      cancelInFlightSearch();
    };
  }, [cancelInFlightSearch]);

  const handleFetchMetadata = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedQuery) return;
    skipNextDebounceTermRef.current = trimmedQuery;
    void executeYouTubeSearch(trimmedQuery);
  };

  const handleSelectArtistToDiscover = useCallback(
    (artist: DiscoverArtistItem) => {
      if (artist.deezerArtistId) {
        handleOpenArtistView({
          id: artist.deezerArtistId,
          nameHint: artist.name,
          pictureHint: artist.thumbnailUrl,
        });
        return;
      }
      const nextTerm = artist.name.trim();
      skipNextDebounceTermRef.current = nextTerm;
      setQuery(nextTerm);
      void executeYouTubeSearch(nextTerm);
    },
    [executeYouTubeSearch, handleOpenArtistView]
  );

  const handleSearchAlbumTracks = useCallback(
    (e: React.MouseEvent, album: DiscoverAlbumItem) => {
      e.stopPropagation();
      const term = (
        album.title.toLowerCase().includes(album.artist.toLowerCase())
          ? album.title
          : `${album.artist} ${album.title}`
      ).trim();
      skipNextDebounceTermRef.current = term;
      setQuery(term);
      void executeYouTubeSearch(term);
    },
    [executeYouTubeSearch]
  );

  const handleQueryChange = (nextValue: string) => {
    setQuery(nextValue);
    if (nextValue.trim() === '') {
      cancelInFlightSearch();
      skipNextDebounceTermRef.current = null;
      prefetchedSearchKeyRef.current = '';
      setFetchingMeta(false);
      setSearchResults([]);
      setLastSearchTerm(null);
      setPreviewItems([]);
      setIsPlaylistPreview(false);
      setPlaylistTitle(null);
      setMetaError(null);
    }
  };

  const handleTapSearchResult = useCallback(
    (item: MetadataPreviewItem) => {
      const clickedTrack = metadataItemToYouTubeTrack(item);
      if (currentTrack?.id === clickedTrack.id) {
        togglePlay();
        return;
      }
      const listToQueue = searchResults.length > 0 ? searchResults : [item];
      const ytQueue = listToQueue.map(metadataItemToYouTubeTrack);
      const matched = ytQueue.find((t) => t.id === clickedTrack.id) || clickedTrack;
      playTrack(matched, ytQueue);
    },
    [currentTrack?.id, playTrack, searchResults, togglePlay]
  );

  const handleQuickDownloadResult = async (e: React.MouseEvent, item: MetadataPreviewItem) => {
    e.stopPropagation();
    if (!canDownload || quickQueueingId === item.id) return;
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
              format: DEFAULT_DOWNLOAD_FORMAT,
              quality: DEFAULT_DOWNLOAD_QUALITY,
              thumbnail_url: item.thumbnail_url,
            },
          ],
        }),
      });
      setQuickQueuedIds((prev) => new Set(prev).add(item.id));
      flashToast(`Queued "${item.title}" for download`);
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

  const hasAnyDiscoverShelf = Boolean(
    discoverFeed &&
      (discoverFeed.newReleases.length > 0 ||
        discoverFeed.artistsToDiscover.length > 0 ||
        discoverFeed.albumsForYou.length > 0)
  );

  const isCatalogDetailOpen = Boolean(isDiscoverView && activeCatalogRoute && !offline);

  useEffect(() => {
    if (isCatalogDetailOpen) {
      setSearchPinned(false);
      return;
    }
    const sentinel = searchSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') {
      setSearchPinned(false);
      return;
    }
    const scrollRoot = sentinel.closest('main');
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setSearchPinned(Boolean(entry && !entry.isIntersecting));
      },
      {
        root: scrollRoot,
        threshold: 0,
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isCatalogDetailOpen]);

  const discoverSubtitle = useMemo(() => {
    const feedArtist = extractDisplayArtist(
      discoverFeed?.lastPlayed?.artist,
      discoverFeed?.lastPlayed?.title
    );
    const feedTitle = (discoverFeed?.lastPlayed?.title || '').trim();
    const localArtist = extractDisplayArtist(lastPlayed?.artist, lastPlayed?.title);
    const localTitle = (lastPlayed?.title || '').trim();

    const activeArtist = lastPlayedArtistKey ? localArtist || feedArtist : feedArtist;
    const activeTitle = lastPlayedArtistKey ? localTitle || feedTitle : feedTitle;

    if (activeArtist && activeTitle) {
      return `Picked from ${activeArtist} • ${activeTitle}`;
    }
    if (activeArtist) {
      return `Picked from ${activeArtist}`;
    }
    if (discoverFeed?.basedOnLibrary && discoverFeed.seeds.length > 0) {
      return `Picked from ${discoverFeed.seeds.join(', ')}`;
    }
    return 'Trending music picks';
  }, [discoverFeed, lastPlayed?.artist, lastPlayed?.title, lastPlayedArtistKey]);

  return (
    <div
      ref={pageRootRef}
      className={
        isCatalogDetailOpen
          ? 'w-full pb-36 md:pb-12'
          : 'px-4 sm:px-6 lg:px-8 max-w-[1680px] mx-auto space-y-5 pb-36 md:pb-12'
      }
      style={{
        paddingTop: isCatalogDetailOpen
          ? '0px'
          : 'calc(1.25rem + env(safe-area-inset-top, 0px))',
        paddingBottom: 'calc(8.5rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {actionToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate">
          {actionToast}
        </div>
      )}

      {/* Minimalist Single-Row Header (hidden when inspecting an Album/Artist detail view) */}
      {!isCatalogDetailOpen && (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">
            Discover
          </h1>
          {isDiscoverView && (discoverFeed || lastPlayedArtistKey) && (
            <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">
              {discoverSubtitle}
            </p>
          )}
        </div>

        {isDiscoverView && !offline && (
          <div className="flex items-center gap-2 shrink-0">
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
          </div>
        )}
      </div>
      )}

      {/* Sentinel for detecting when the search bar pins at top of viewport */}
      {!isCatalogDetailOpen && (
        <div ref={searchSentinelRef} className="h-px w-full -mt-5 pointer-events-none" aria-hidden="true" />
      )}

      {/* Pinned Wide Minimalist Search Input Bar (transparent over top gradient, frosted glass behind status bar when pinned) */}
      {!isCatalogDetailOpen && (
      <div
        className={`sticky top-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 transition-colors duration-200 ${
          searchPinned
            ? 'bg-[var(--bg-glass)] backdrop-blur-xl border-b border-[var(--border-subtle)]'
            : 'bg-transparent'
        }`}
        style={{
          paddingTop: searchPinned
            ? 'calc(0.625rem + env(safe-area-inset-top, 0px))'
            : '0.375rem',
          paddingBottom: '0.625rem',
        }}
      >
        <form onSubmit={handleFetchMetadata}>
          <div className="relative">
            {isUrlInput ? (
              <Link2 className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--accent)]" />
            ) : fetchingMeta ? (
              <Loader2 className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-[var(--accent)]" />
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
              className="w-full rounded-full bg-[var(--bg-elevated)] border border-[var(--border-subtle)] pl-11 pr-12 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:border-[var(--accent)] focus:outline-none transition-colors shadow-sm"
            />
            {query && (
              <button
                type="button"
                onClick={handleClearInput}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)] transition-colors"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </form>
      </div>
      )}

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
          MODE A: PERSONALIZED DISCOVER SHELVES OR INSTANT ALBUM/ARTIST VIEW
         ===================================================================== */}
      {isDiscoverView ? (
        activeCatalogRoute && !offline ? (
          <CatalogDetailView
            route={activeCatalogRoute}
            canDownload={canDownload}
            onBack={handlePopCatalogView}
            onOpenAlbum={handleOpenAlbumView}
            onOpenArtist={handleOpenArtistView}
            onFlashToast={flashToast}
          />
        ) : (
        <div className="space-y-8">
          {offline ? (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 text-center space-y-2">
              <WifiOff className="w-6 h-6 text-[var(--warn-text)] mx-auto" />
              <p className="text-sm font-medium text-[var(--text-primary)]">Offline Mode</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Reconnect to search YouTube and browse Discover recommendations. Use Home or Library
                for offline cached tracks.
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
                <ResponsiveDiscoverShelf title="New releases" variant="square">
                  {discoverFeed.newReleases.map((item) => {
                    const trackKey =
                      item.id ||
                      (item.videoId ? `yt-${item.videoId}` : `${item.artist}-${item.title}`);
                    const isCurrent = Boolean(
                      currentTrack &&
                        ((item.videoId && currentTrack.id === `yt-${item.videoId}`) ||
                          (item.id && currentTrack.id === item.id) ||
                          (item.deezerTrackId &&
                            currentTrack.deezerTrackId === item.deezerTrackId) ||
                          (item.albumId && currentTrack.deezerAlbumId === item.albumId))
                    );
                    const isItemPlaying = isCurrent && isPlaying && !isBuffering;
                    const isItemBuffering = isCurrent && isBuffering;

                    return (
                      <div
                        key={trackKey}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenDiscoverRelease(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleOpenDiscoverRelease(item);
                          }
                        }}
                        className="group w-[144px] sm:w-[164px] lg:w-auto shrink-0 snap-start rounded-xl p-2 text-left transition-colors hover:bg-[var(--bg-secondary)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-[var(--bg-elevated)] shadow-md">
                          <DiscoverArtwork
                            directUrl={item.thumbnailUrl}
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
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePlayDiscoverRelease(item);
                            }}
                            aria-label={
                              isItemPlaying ? `Pause ${item.title}` : `Play ${item.title}`
                            }
                            className={`absolute bottom-2 right-2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg transition-all duration-150 hover:scale-105 ${
                              isCurrent
                                ? 'opacity-100 translate-y-0'
                                : 'opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 focus-visible:opacity-100'
                            }`}
                          >
                            {isItemBuffering ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : isItemPlaying ? (
                              <Pause className="w-4 h-4 fill-current" />
                            ) : (
                              <Play className="w-4 h-4 fill-current ml-0.5" />
                            )}
                          </button>
                        </div>

                        <div className="mt-2.5 min-w-0 space-y-0.5">
                          <p
                            className={`text-sm font-semibold truncate ${
                              isCurrent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                            }`}
                          >
                            {item.title}
                          </p>
                          <p className="text-xs font-medium text-[var(--text-secondary)] truncate">
                            {item.artist}
                          </p>
                          {item.releaseLabel && (
                            <p className="text-[11px] text-[var(--text-muted)] truncate">
                              {item.releaseLabel}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </ResponsiveDiscoverShelf>
              )}

              {/* Shelf 2: Artists to discover */}
              {discoverFeed.artistsToDiscover.length > 0 && (
                <ResponsiveDiscoverShelf title="Artists to discover" variant="circle">
                  {discoverFeed.artistsToDiscover.map((artist) => (
                    <button
                      key={artist.id}
                      type="button"
                      onClick={() => handleSelectArtistToDiscover(artist)}
                      className="group w-[128px] sm:w-[144px] lg:w-auto shrink-0 snap-start rounded-xl p-2 text-center transition-colors hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <div className="relative aspect-square w-full rounded-full overflow-hidden bg-[var(--bg-elevated)] shadow-md ring-1 ring-[var(--border-subtle)]">
                        <DiscoverArtwork
                          directUrl={artist.thumbnailUrl}
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
                        <p className="text-[11px] text-[var(--text-secondary)] truncate">
                          {artist.subtitle}
                        </p>
                      </div>
                    </button>
                  ))}
                </ResponsiveDiscoverShelf>
              )}

              {/* Shelf 3: Albums for you */}
              {discoverFeed.albumsForYou.length > 0 && (
                <ResponsiveDiscoverShelf title="Albums for you" variant="square">
                  {discoverFeed.albumsForYou.map((album) => {
                    const albumKey =
                      album.id ||
                      album.deezerAlbumId ||
                      album.videoId ||
                      `${album.artist}-${album.title}`;
                    const isCurrent = Boolean(
                      currentTrack &&
                        ((album.videoId && currentTrack.id === `yt-${album.videoId}`) ||
                          (album.deezerAlbumId &&
                            currentTrack.deezerAlbumId === album.deezerAlbumId))
                    );

                    return (
                      <div
                        key={albumKey}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenDiscoverAlbum(album)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleOpenDiscoverAlbum(album);
                          }
                        }}
                        className="group w-[144px] sm:w-[164px] lg:w-auto shrink-0 snap-start rounded-xl p-2 text-left transition-colors hover:bg-[var(--bg-secondary)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-[var(--bg-elevated)] shadow-md">
                          <DiscoverArtwork
                            directUrl={album.thumbnailUrl}
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
                            title={`Search YouTube for ${album.title}`}
                            aria-label={`Search YouTube for ${album.title}`}
                            className="absolute top-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/85 transition-opacity"
                          >
                            <Search className="w-3.5 h-3.5" />
                          </button>
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
                </ResponsiveDiscoverShelf>
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
        )
      ) : (
        /* =====================================================================
           MODE B: AUTOMATIC ONLINE YOUTUBE SEARCH & INSTANT PLAY
           ===================================================================== */
        <div className="space-y-5">
          {metaError && (
            <div className="rounded-lg bg-[var(--danger-bg)] border border-[var(--danger-border)] px-4 py-3 text-sm text-[var(--danger-text)]">
              {metaError}
            </div>
          )}

          <section className="space-y-3">
            {offline ? (
              <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 text-center space-y-2">
                <WifiOff className="w-6 h-6 text-[var(--warn-text)] mx-auto" />
                <p className="text-sm font-medium text-[var(--text-primary)]">Offline Mode</p>
                <p className="text-xs text-[var(--text-secondary)]">
                  Reconnect to search and stream from YouTube. Use Home or Library for offline
                  tracks.
                </p>
              </div>
            ) : (
              <>
                {fetchingMeta && searchResults.length === 0 && previewItems.length === 0 && (
                  <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-8 flex items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
                    <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
                    <span>
                      {isUrlInput
                        ? 'Reading YouTube link...'
                        : `Searching YouTube for "${trimmedQuery}"...`}
                    </span>
                  </div>
                )}

                {searchResults.length > 0 && (
                  <div className="space-y-2.5">
                    {lastSearchTerm && (
                      <div className="flex items-center justify-between gap-2 px-0.5">
                        <p className="text-xs text-[var(--text-muted)] truncate">
                          Results for &ldquo;{lastSearchTerm}&rdquo;
                        </p>
                        {fetchingMeta && (
                          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] shrink-0">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
                            <span>Updating...</span>
                          </span>
                        )}
                      </div>
                    )}

                    <div className={`space-y-2 transition-opacity duration-150 ${fetchingMeta ? 'opacity-65' : 'opacity-100'}`}>
                      {searchResults.map((item) => {
                        const videoId = extractYouTubeVideoIdFromItem(item);
                        const ytTrackId = `yt-${videoId}`;
                        const isCurrentStream = currentTrack?.id === ytTrackId;
                        const isStreamPlaying = isCurrentStream && isPlaying && !isBuffering;
                        const isStreamBuffering = isCurrentStream && isBuffering;
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
                            onClick={() => handleTapSearchResult(item)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handleTapSearchResult(item);
                              }
                            }}
                            className={`group rounded-lg p-2.5 border transition-colors cursor-pointer space-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                              isCurrentStream
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
                                <p
                                  className={`text-sm font-semibold truncate ${
                                    isCurrentStream
                                      ? 'text-[var(--accent)]'
                                      : 'text-[var(--text-primary)]'
                                  }`}
                                >
                                  {item.title}
                                </p>
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
                                  className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all ${
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
                                      className="flex h-10 px-3 items-center justify-center gap-1 rounded-full bg-[var(--accent)] text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                                    >
                                      <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                      <span className="hidden sm:inline">Play</span>
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={isQuickQueueing || isJobActive}
                                      onClick={(e) => void handleQuickDownloadResult(e, item)}
                                      title="Download track"
                                      aria-label={`Download ${item.title}`}
                                      className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all ${
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

                {/* Pasted-URL Metadata Preview (single track or playlist link) */}
                {previewItems.length > 0 && (
                  <div
                    ref={metadataEditorRef}
                    className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-4 sm:p-5 space-y-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-sm font-bold text-[var(--text-primary)]">
                        {playlistTitle ? `Playlist: ${playlistTitle}` : 'YouTube Link Preview'}
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewItems([]);
                            setIsPlaylistPreview(false);
                            setPlaylistTitle(null);
                          }}
                          className="rounded-full border border-[var(--border-strong)] px-3.5 py-2 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                        >
                          Dismiss
                        </button>
                        {canDownload && (
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
                        )}
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
                                          format: nextQ === 'ultra' ? DEFAULT_DOWNLOAD_FORMAT : 'mp3',
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
