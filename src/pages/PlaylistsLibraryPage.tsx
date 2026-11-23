import {
  ArrowDownCircle,
  ArrowLeft,
  CheckCircle2,
  CheckSquare,
  Clock,
  Disc3,
  Download,
  FileDown,
  HardDriveDownload,
  Heart,
  Library,
  ListPlus,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings,
  Shuffle,
  Square,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useLocation, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {AddToPlaylistModal} from '../components/AddToPlaylistModal';
import {AlbumArt, PlaylistMosaic} from '../components/AlbumArt';
import {ConfirmDeleteModal} from '../components/ConfirmDeleteModal';
import {CreatePlaylistModal} from '../components/CreatePlaylistModal';
import {TrackTable} from '../components/TrackTable';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {useOfflineLibrary} from '../hooks/useOfflineLibrary';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {useSwipeTrackGesture} from '../hooks/useSwipeTrackGesture';
import {
  apiFetch,
  formatDuration,
  getTrackCoverUrl,
  getYouTubeThumbProxyUrl,
  getYouTubeVideoId,
} from '../lib/api';
import {
  computeLightTintedTopHex,
  computeNowPlayingTopHex,
  extractDominantColorFromImage,
  getAlbumColorCacheKey,
  getCachedDominantColor,
  setDocumentThemeColor,
} from '../lib/themeColor';
import type {Playlist, Track} from '../types';
import {
  getOfflineCoverBlobUrl,
  getOfflinePlaylists,
  getOfflinePlaylistTracks,
  getOfflineTracks,
  saveOfflinePlaylistMetadata,
  subscribeOfflineStore,
} from '../utils/offlineStore';

type LibraryTab = 'all' | 'liked' | 'recent' | 'offline' | 'playlists';
type HomeViewTab = Exclude<LibraryTab, 'playlists'>;

const HOME_VIEW_META: Record<
  HomeViewTab,
  {title: string; fallbackColor: string; gradient: string}
> = {
  all: {
    title: 'All Tracks',
    fallbackColor: '#1f4a34',
    gradient: 'from-[#1DB954]/80 via-[#1b4a33] to-[#121212]',
  },
  liked: {
    title: 'Liked Songs',
    fallbackColor: '#4030b8',
    gradient: 'from-[#4f39f6] via-[#32468a] to-[#1DB954]/80',
  },
  recent: {
    title: 'Recently Downloaded',
    fallbackColor: '#185e38',
    gradient: 'from-[#1DB954] via-[#135c32] to-[#0d2819]',
  },
  offline: {
    title: 'Offline',
    fallbackColor: '#135244',
    gradient: 'from-emerald-500 via-teal-800 to-[#0e241d]',
  },
};

function getTimeOfDayGreeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatHumanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const totalMins = Math.floor(seconds / 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  return `${secs}s`;
}

export const PlaylistsLibraryPage: React.FC = () => {
  const {id: playlistIdParam} = useParams<{id?: string}>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {user, isOfflineMode} = useAuth();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const {
    supported: offlineSupported,
    cachedTrackIds,
    downloadTrack,
    removeTrack,
  } = useOfflineLibrary();
  const {
    currentTrack,
    queue,
    shuffle,
    toggleShuffle,
    playTrack,
    nextTrack,
    prevTrack,
    addManyToQueue,
    handleDeletedTracks,
    libraryRefreshVersion,
    bumpLibraryRefresh,
  } = usePlayer();
  const {isLight, baseThemeColor} = useTheme();

  const canDeleteTracks = !offline && (user?.role === 'admin' || Boolean(user?.can_download));
  const isPlaylistsRoot = location.pathname === '/playlists';
  const artistFilter = searchParams.get('artist') || '';

  const [activeTab, setActiveTab] = useState<LibraryTab>(() => {
    if (isPlaylistsRoot) return 'playlists';
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline';
    return 'all';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [stats, setStats] = useState({totalTracks: 0, likedTracks: 0});
  const [activePlaylist, setActivePlaylist] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [greeting, setGreeting] = useState<string>(() => getTimeOfDayGreeting());
  const [searchOpen, setSearchOpen] = useState(false);
  const [heroSampledColor, setHeroSampledColor] = useState<string | null>(null);
  const [heroOfflineCoverUrl, setHeroOfflineCoverUrl] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const syncGreeting = () => setGreeting(getTimeOfDayGreeting());
    const intervalId = window.setInterval(syncGreeting, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') syncGreeting();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Multi-select & batch action state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchPlaylistOpen, setBatchPlaylistOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchDeleteError, setBatchDeleteError] = useState<string | null>(null);

  // Playlist context menus, offline batch download & toast
  const [playlistMenuId, setPlaylistMenuId] = useState<number | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [exportingPlaylistId, setExportingPlaylistId] = useState<number | null>(null);
  const [playlistDownloadProgress, setPlaylistDownloadProgress] = useState<{
    playlistId: number;
    completed: number;
    total: number;
  } | null>(null);
  const playlistDownloadAbortRef = useRef<AbortController | null>(null);
  const [pageToast, setPageToast] = useState<string | null>(null);
  const playlistMenuRef = useRef<HTMLDivElement | null>(null);
  const detailMenuRef = useRef<HTMLDivElement | null>(null);

  const flashToast = useCallback((msg: string) => {
    setPageToast(msg);
    setTimeout(() => setPageToast(null), 3200);
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (playlistMenuRef.current && !playlistMenuRef.current.contains(e.target as Node)) {
        setPlaylistMenuId(null);
      }
      if (detailMenuRef.current && !detailMenuRef.current.contains(e.target as Node)) {
        setDetailMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    if (isPlaylistsRoot && !playlistIdParam) {
      setActiveTab('playlists');
    } else if (location.pathname === '/' && activeTab === 'playlists') {
      setActiveTab(offline ? 'offline' : 'all');
    }
  }, [isPlaylistsRoot, location.pathname, playlistIdParam, offline]);

  // Automatically boot into Offline Library when disconnected
  useEffect(() => {
    if (offline && !playlistIdParam && activeTab !== 'playlists' && activeTab !== 'offline') {
      setActiveTab('offline');
    }
  }, [offline, playlistIdParam, activeTab]);

  // Abort any in-flight playlist download on unmount
  useEffect(() => {
    return () => {
      playlistDownloadAbortRef.current?.abort();
    };
  }, []);

  // Reset multi-select when switching views or tabs
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setPlaylistMenuId(null);
    setDetailMenuOpen(false);
  }, [playlistIdParam, activeTab, artistFilter]);

  const loadPlaylists = useCallback(async () => {
    if (offline) {
      const [cachedPlaylists, cachedTracks] = await Promise.all([
        getOfflinePlaylists(),
        getOfflineTracks(),
      ]);
      setPlaylists(cachedPlaylists);
      setStats({
        totalTracks: cachedTracks.length,
        likedTracks: cachedTracks.filter((t) => t.liked).length,
      });
      return;
    }

    try {
      const res = await apiFetch<{
        playlists: Playlist[];
        stats: {totalTracks: number; likedTracks: number};
      }>('/api/playlists');
      setPlaylists(res.playlists || []);
      if (res.stats) setStats(res.stats);
    } catch {
      const [cachedPlaylists, cachedTracks] = await Promise.all([
        getOfflinePlaylists(),
        getOfflineTracks(),
      ]);
      setPlaylists(cachedPlaylists);
      setStats({
        totalTracks: cachedTracks.length,
        likedTracks: cachedTracks.filter((t) => t.liked).length,
      });
    }
  }, [offline]);

  const loadContent = useCallback(async () => {
    setLoading(true);
    try {
      await loadPlaylists();
      if (playlistIdParam) {
        const numericId = Number(playlistIdParam);
        if (offline) {
          const cached = await getOfflinePlaylistTracks(numericId);
          setActivePlaylist(cached?.playlist ?? null);
          setTracks(cached?.tracks ?? []);
        } else {
          try {
            const res = await apiFetch<{playlist: Playlist; tracks: Track[]}>(
              `/api/playlists/${playlistIdParam}`
            );
            setActivePlaylist(res.playlist);
            setTracks(res.tracks || []);
          } catch {
            const cached = await getOfflinePlaylistTracks(numericId);
            setActivePlaylist(cached?.playlist ?? null);
            setTracks(cached?.tracks ?? []);
          }
        }
      } else if (activeTab === 'offline' || offline) {
        setActivePlaylist(null);
        const cachedTracks = await getOfflineTracks();
        const filteredByArtist = artistFilter
          ? cachedTracks.filter(
              (t) => t.artist.toLowerCase() === artistFilter.toLowerCase()
            )
          : cachedTracks;
        setTracks(filteredByArtist);
      } else {
        setActivePlaylist(null);
        const filterParam =
          activeTab === 'liked' ? 'liked' : activeTab === 'recent' ? 'recent' : 'all';
        const qs = new URLSearchParams({filter: filterParam});
        if (artistFilter) qs.set('artist', artistFilter);
        try {
          const res = await apiFetch<{tracks: Track[]}>(`/api/tracks?${qs.toString()}`);
          setTracks(res.tracks || []);
        } catch {
          const cachedTracks = await getOfflineTracks();
          setTracks(cachedTracks);
        }
      }
    } catch {
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }, [playlistIdParam, activeTab, artistFilter, loadPlaylists, offline]);

  useEffect(() => {
    void loadContent();
  }, [loadContent, libraryRefreshVersion]);

  // Keep Offline Library & Offline Mode views live when tracks/playlists are cached or removed
  useEffect(() => {
    if (activeTab !== 'offline' && !offline) return;
    return subscribeOfflineStore(() => {
      void loadContent();
    });
  }, [activeTab, offline, loadContent]);

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return tracks;
    const q = searchQuery.toLowerCase();
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
    );
  }, [tracks, searchQuery]);

  const totalDuration = useMemo(
    () => filteredTracks.reduce((sum, t) => sum + (t.duration || 0), 0),
    [filteredTracks]
  );

  const selectedTracks = useMemo(
    () =>
      filteredTracks.filter(
        (t) => typeof t.id === 'number' && selectedIds.has(t.id)
      ),
    [filteredTracks, selectedIds]
  );

  const selectedIdArray = useMemo(
    () => selectedTracks.map((t) => t.id).filter((id): id is number => typeof id === 'number'),
    [selectedTracks]
  );

  const allVisibleSelected =
    filteredTracks.length > 0 && selectedTracks.length === filteredTracks.length;

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelectTrack = useCallback((trackId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  const enterSelectionModeWithTrack = useCallback((initialTrackId: number) => {
    setSelectionMode(true);
    setSelectedIds(new Set([initialTrackId]));
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(
        new Set(
          filteredTracks.map((t) => t.id).filter((id): id is number => typeof id === 'number')
        )
      );
    }
  }, [allVisibleSelected, filteredTracks]);

  const handlePlayAll = () => {
    if (filteredTracks.length > 0) {
      playTrack(filteredTracks[0], filteredTracks);
    }
  };

  const handleQuickPlayPlaylist = async (e: React.MouseEvent, plId: number) => {
    e.stopPropagation();
    if (offline) {
      const cached = await getOfflinePlaylistTracks(plId);
      if (cached && cached.tracks.length > 0) {
        playTrack(cached.tracks[0], cached.tracks);
      } else {
        navigate(`/playlists/${plId}`);
      }
      return;
    }
    try {
      const res = await apiFetch<{tracks: Track[]}>(`/api/playlists/${plId}`);
      if (res.tracks && res.tracks.length > 0) {
        playTrack(res.tracks[0], res.tracks);
      } else {
        navigate(`/playlists/${plId}`);
      }
    } catch {
      const cached = await getOfflinePlaylistTracks(plId);
      if (cached && cached.tracks.length > 0) {
        playTrack(cached.tracks[0], cached.tracks);
      } else {
        navigate(`/playlists/${plId}`);
      }
    }
  };

  const playlistAllTracksCached = useMemo(() => {
    if (!activePlaylist || tracks.length === 0) return false;
    return tracks.every((t) => typeof t.id === 'number' && cachedTrackIds.has(t.id));
  }, [activePlaylist, tracks, cachedTrackIds]);

  const playlistCachedCount = useMemo(() => {
    if (!activePlaylist || tracks.length === 0) return 0;
    return tracks.filter((t) => typeof t.id === 'number' && cachedTrackIds.has(t.id)).length;
  }, [activePlaylist, tracks, cachedTrackIds]);

  const handleDownloadPlaylistOffline = async () => {
    if (!activePlaylist || tracks.length === 0) return;

    // Clicking while actively downloading cancels the batch cleanly
    if (playlistDownloadProgress?.playlistId === activePlaylist.id) {
      playlistDownloadAbortRef.current?.abort();
      return;
    }

    // If every track in the playlist is already cached, remove offline copies for this playlist
    if (playlistAllTracksCached) {
      for (const t of tracks) {
        if (typeof t.id === 'number') {
          await removeTrack(t.id);
        }
      }
      flashToast(`Removed "${activePlaylist.name}" from offline storage`);
      return;
    }

    if (offline) {
      flashToast('Reconnect to download playlist for offline playback');
      return;
    }
    if (!offlineSupported) {
      flashToast('Offline caching requires HTTPS or localhost');
      return;
    }

    const controller = new AbortController();
    playlistDownloadAbortRef.current = controller;
    const allTrackIds = tracks
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number');

    await saveOfflinePlaylistMetadata(activePlaylist, allTrackIds);

    let completed = tracks.filter(
      (t) => typeof t.id === 'number' && cachedTrackIds.has(t.id)
    ).length;
    setPlaylistDownloadProgress({
      playlistId: activePlaylist.id,
      completed,
      total: tracks.length,
    });

    let failed = 0;
    try {
      for (const track of tracks) {
        if (controller.signal.aborted) break;
        if (typeof track.id !== 'number' || cachedTrackIds.has(track.id)) continue;
        try {
          await downloadTrack(track, {
            playlist: activePlaylist,
            playlistTrackIds: allTrackIds,
            signal: controller.signal,
          });
          completed += 1;
          setPlaylistDownloadProgress({
            playlistId: activePlaylist.id,
            completed,
            total: tracks.length,
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            break;
          }
          failed += 1;
        }
      }

      if (controller.signal.aborted) {
        flashToast(`Download cancelled (${completed}/${tracks.length} saved offline)`);
      } else if (failed > 0) {
        flashToast(`Saved ${completed}/${tracks.length} tracks offline (${failed} failed)`);
      } else {
        flashToast(`Downloaded "${activePlaylist.name}" for offline playback`);
      }
    } finally {
      playlistDownloadAbortRef.current = null;
      setPlaylistDownloadProgress(null);
    }
  };

  const handleDeletePlaylist = async (targetPlaylistId: number) => {
    try {
      await apiFetch(`/api/playlists/${targetPlaylistId}`, {method: 'DELETE'});
      setPlaylists((prev) => prev.filter((p) => p.id !== targetPlaylistId));
      setPlaylistMenuId(null);
      setDetailMenuOpen(false);
      bumpLibraryRefresh();
      flashToast('Playlist deleted');
      if (playlistIdParam && Number(playlistIdParam) === targetPlaylistId) {
        navigate('/playlists');
      }
    } catch (err) {
      flashToast(err instanceof Error ? err.message : 'Could not delete playlist');
    }
  };

  const handleExportM3u = async (pl: Playlist) => {
    setExportingPlaylistId(pl.id);
    setPlaylistMenuId(null);
    setDetailMenuOpen(false);
    try {
      const res = await apiFetch<{
        ok: boolean;
        relPath: string;
        trackCount: number;
      }>(`/api/playlists/${pl.id}/export-m3u`, {method: 'POST'});
      flashToast(`Exported to ${res.relPath} (${res.trackCount} tracks)`);
      bumpLibraryRefresh();
    } catch (err) {
      flashToast(err instanceof Error ? err.message : 'Could not export playlist');
    } finally {
      setExportingPlaylistId(null);
    }
  };

  const handleBatchAddToQueue = () => {
    if (selectedTracks.length === 0) return;
    addManyToQueue(selectedTracks);
    flashToast(
      `Added ${selectedTracks.length} ${selectedTracks.length === 1 ? 'track' : 'tracks'} to queue`
    );
    exitSelectionMode();
  };

  const handleBatchConfirmDelete = async () => {
    if (selectedIdArray.length === 0) return;
    setBatchDeleting(true);
    setBatchDeleteError(null);
    try {
      const res = await apiFetch<{deletedIds: number[]; deletedCount: number}>('/api/tracks', {
        method: 'DELETE',
        body: JSON.stringify({ids: selectedIdArray}),
      });
      const removedIds = res.deletedIds || selectedIdArray;
      const removedSet = new Set(removedIds);
      handleDeletedTracks(removedIds);
      setTracks((prev) =>
        prev.filter((t) => !(typeof t.id === 'number' && removedSet.has(t.id)))
      );
      setBatchDeleteOpen(false);
      exitSelectionMode();
      bumpLibraryRefresh();
      flashToast(
        `Permanently deleted ${removedIds.length} ${removedIds.length === 1 ? 'track' : 'tracks'}`
      );
    } catch (err) {
      setBatchDeleteError(err instanceof Error ? err.message : 'Bulk deletion failed');
    } finally {
      setBatchDeleting(false);
    }
  };

  const handleArtistClick = (artist: string) => {
    setSearchParams({artist});
    if (playlistIdParam) {
      navigate(`/?artist=${encodeURIComponent(artist)}`);
    } else {
      setActiveTab('all');
    }
  };

  const homeFilterPills: Array<{id: HomeViewTab; label: string}> = useMemo(
    () =>
      offline
        ? [{id: 'offline', label: 'Offline'}]
        : [
            {id: 'all', label: 'All Tracks'},
            {id: 'liked', label: 'Liked Songs'},
            {id: 'recent', label: 'Recently Downloaded'},
            {id: 'offline', label: 'Offline'},
          ],
    [offline]
  );

  const isHomeView = !playlistIdParam && activeTab !== 'playlists';
  const activeHomeTab: HomeViewTab = activeTab === 'playlists' ? 'all' : activeTab;

  // Determine active hero track (prefer active/playing track so swipes immediately update cover & gradient)
  const heroTrack = useMemo(() => {
    if (!isHomeView) return null;
    if (currentTrack) {
      return currentTrack;
    }
    return (
      filteredTracks.find((t) => Boolean(t.cover_file)) ??
      tracks.find((t) => Boolean(t.cover_file)) ??
      null
    );
  }, [currentTrack, filteredTracks, isHomeView, tracks]);

  // Next view for the right-edge peek card & horizontal swipe cycling
  const activePillIndex = homeFilterPills.findIndex((p) => p.id === activeHomeTab);
  const nextHomeView =
    homeFilterPills.length > 1
      ? homeFilterPills[(activePillIndex + 1) % homeFilterPills.length]
      : null;

  const peekCoverFile = useMemo(() => {
    if (!nextHomeView) return null;
    const distinctTrack = tracks.find(
      (t) => Boolean(t.cover_file) && t.cover_file !== heroTrack?.cover_file
    );
    if (distinctTrack?.cover_file) return distinctTrack.cover_file;
    const playlistCover = playlists
      .flatMap((p) => p.covers || [])
      .find((c) => c && c !== heroTrack?.cover_file);
    return playlistCover || null;
  }, [heroTrack?.cover_file, nextHomeView, playlists, tracks]);

  const cycleHomeView = useCallback(
    (direction: 1 | -1) => {
      if (homeFilterPills.length <= 1) return;
      const idx = homeFilterPills.findIndex((p) => p.id === activeHomeTab);
      const nextIdx = (idx + direction + homeFilterPills.length) % homeFilterPills.length;
      setSearchParams({});
      setActiveTab(homeFilterPills[nextIdx].id);
    },
    [activeHomeTab, homeFilterPills, setSearchParams]
  );

  // Resolve offline cover blob URL when disconnected so offscreen color sampling still works offline
  const heroCoverFile = heroTrack?.cover_file ?? null;
  useEffect(() => {
    setHeroOfflineCoverUrl(null);
    if (!heroCoverFile || !offline) return;
    let cancelled = false;
    void getOfflineCoverBlobUrl(heroCoverFile).then((url) => {
      if (!cancelled && url) setHeroOfflineCoverUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [heroCoverFile, offline]);

  const heroAlbumColorKey = useMemo(
    () => (heroTrack ? getAlbumColorCacheKey(heroTrack) : null),
    [heroTrack]
  );
  const heroYtVideoId = useMemo(
    () => (heroTrack?.isYouTubeStream ? getYouTubeVideoId(heroTrack) : null),
    [heroTrack]
  );
  const heroCoverUrl =
    heroOfflineCoverUrl ||
    (heroYtVideoId ? getYouTubeThumbProxyUrl(heroYtVideoId) : getTrackCoverUrl(heroTrack));
  const viewFallbackColor = HOME_VIEW_META[activeHomeTab].fallbackColor;

  // Sample hero cover dominant color on our reusable 32x32 offscreen canvas (memoized in memory)
  useEffect(() => {
    if (!isHomeView) return;
    if (!heroTrack || !heroAlbumColorKey) {
      setHeroSampledColor(viewFallbackColor);
      return;
    }

    const cached = getCachedDominantColor(heroAlbumColorKey, heroTrack.id);
    if (cached) {
      setHeroSampledColor(cached);
      return;
    }

    setHeroSampledColor(heroTrack.dominant_color || viewFallbackColor);
    if (!heroCoverUrl) return;

    let cancelled = false;
    void extractDominantColorFromImage(
      heroCoverUrl,
      heroAlbumColorKey,
      heroTrack.id,
      heroTrack.dominant_color || viewFallbackColor
    ).then((hex) => {
      if (!cancelled) {
        setHeroSampledColor(hex);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [heroAlbumColorKey, heroCoverUrl, heroTrack, isHomeView, viewFallbackColor]);

  const heroTopHexColor = useMemo(() => {
    if (!isHomeView) return baseThemeColor;
    const cached = heroTrack
      ? getCachedDominantColor(heroAlbumColorKey, heroTrack.id)
      : null;
    const rawColor =
      cached || heroSampledColor || heroTrack?.dominant_color || viewFallbackColor;
    return isLight
      ? computeLightTintedTopHex(rawColor, 0.22)
      : computeNowPlayingTopHex(rawColor);
  }, [
    baseThemeColor,
    heroAlbumColorKey,
    heroSampledColor,
    heroTrack,
    isHomeView,
    isLight,
    viewFallbackColor,
  ]);

  // Synchronously sync mobile PWA top status bar with the exact top edge of the Home hero gradient
  useLayoutEffect(() => {
    if (!isHomeView) return;
    setDocumentThemeColor(heroTopHexColor);
  }, [heroTopHexColor, isHomeView]);

  // Smooth 1:1 horizontal swipe on the Home hero square cover to skip next/previous tracks
  const handleHeroSwipeNext = useCallback(() => {
    if (queue.length > 0 && currentTrack) {
      nextTrack();
    } else if (filteredTracks.length > 0) {
      playTrack(filteredTracks[0], filteredTracks);
    }
  }, [currentTrack, filteredTracks, nextTrack, playTrack, queue.length]);

  const handleHeroSwipePrev = useCallback(() => {
    if (queue.length > 0 && currentTrack) {
      prevTrack();
    } else if (filteredTracks.length > 0) {
      playTrack(filteredTracks[filteredTracks.length - 1], filteredTracks);
    }
  }, [currentTrack, filteredTracks, playTrack, prevTrack, queue.length]);

  const heroCoverSwipe = useSwipeTrackGesture({
    onSwipeNext: handleHeroSwipeNext,
    onSwipePrev: handleHeroSwipePrev,
    threshold: 75,
    deadZone: 10,
    velocityThreshold: 0.55,
    rotationFactor: 0.03,
    slideDistance: 280,
  });

  const handleShufflePlay = useCallback(() => {
    if (filteredTracks.length === 0) {
      toggleShuffle();
      return;
    }
    if (!shuffle) {
      toggleShuffle();
    }
    const randomTrack = filteredTracks[Math.floor(Math.random() * filteredTracks.length)];
    playTrack(randomTrack, filteredTracks);
  }, [filteredTracks, playTrack, shuffle, toggleShuffle]);

  const activeHomeTitle = artistFilter || HOME_VIEW_META[activeHomeTab].title;
  const showFloatingBatchBar = selectionMode && selectedIdArray.length > 0;

  return (
    <>
      {pageToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate">
          {pageToast}
        </div>
      )}

      {playlistIdParam ? (
        // --- PLAYLIST DETAIL VIEW (/playlists/:id) ---
        <div
          className="px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto pb-36 md:pb-12"
          style={{
            paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))',
            paddingBottom: showFloatingBatchBar
              ? 'calc(11.5rem + env(safe-area-inset-bottom, 0px))'
              : 'calc(8.5rem + env(safe-area-inset-bottom, 0px))',
          }}
        >
          <button
            type="button"
            onClick={() => navigate('/playlists')}
            className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Playlists
          </button>

          {loading && !activePlaylist ? (
            <div className="flex items-center justify-center py-20 text-[var(--text-secondary)] gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
              <span>Loading playlist...</span>
            </div>
          ) : !activePlaylist ? (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-10 text-center">
              <p className="text-base font-semibold text-[var(--text-primary)]">Playlist not found</p>
              <button
                type="button"
                onClick={() => navigate('/playlists')}
                className="mt-4 rounded-full bg-[var(--btn-contrast-bg)] px-5 py-2 text-sm font-bold text-[var(--btn-contrast-text)]"
              >
                Return to Playlists
              </button>
            </div>
          ) : (
            <>
              {/* 4-Cover Mosaic Header */}
              <div className="flex flex-col sm:flex-row sm:items-end gap-6 pb-6">
                <PlaylistMosaic
                  covers={activePlaylist.covers || []}
                  alt={activePlaylist.name}
                  className="w-44 h-44 sm:w-52 sm:h-52 rounded-lg shrink-0 shadow-2xl"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-[var(--text-secondary)]">Playlist</p>
                    {activePlaylist.source === 'm3u' && (
                      <span className="font-mono text-[10px] font-semibold text-[var(--accent)] border border-[var(--accent)]/40 bg-[var(--accent-soft)] rounded px-1.5 py-0.5 leading-none">
                        M3U
                      </span>
                    )}
                  </div>
                  <h1 className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight text-[var(--text-primary)] break-words">
                    {activePlaylist.name}
                  </h1>
                  {activePlaylist.description && (
                    <p className="text-sm text-[var(--text-secondary)] max-w-2xl">
                      {activePlaylist.description}
                    </p>
                  )}
                  {activePlaylist.m3u_path && (
                    <p className="font-mono text-xs text-[var(--text-muted)] truncate">
                      {activePlaylist.m3u_path}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)] pt-1">
                    <span className="font-semibold text-[var(--text-primary)]">
                      {activePlaylist.owner_username || user?.username}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {filteredTracks.length} {filteredTracks.length === 1 ? 'track' : 'tracks'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{formatDuration(totalDuration)}</span>
                  </div>
                </div>
              </div>

              {/* Action Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 py-4 border-b border-[var(--border-subtle)] mb-4">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={filteredTracks.length === 0}
                    onClick={handlePlayAll}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-lg hover:bg-[var(--accent-hover)] hover:scale-105 active:scale-95 disabled:opacity-40 transition-all"
                    aria-label="Play playlist"
                  >
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                  </button>

                  {/* Download Playlist Offline Button with Progress State */}
                  {tracks.length > 0 && (
                    <button
                      type="button"
                      disabled={
                        !playlistAllTracksCached &&
                        offline &&
                        playlistDownloadProgress?.playlistId !== activePlaylist.id
                      }
                      onClick={() => void handleDownloadPlaylistOffline()}
                      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-40 whitespace-nowrap ${
                        playlistDownloadProgress?.playlistId === activePlaylist.id
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                          : playlistAllTracksCached
                            ? 'border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-[var(--border-strong)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                      }`}
                      title={
                        playlistDownloadProgress?.playlistId === activePlaylist.id
                          ? 'Click to cancel download'
                          : playlistAllTracksCached
                            ? 'All tracks saved offline (click to remove)'
                            : 'Download all tracks in this playlist for offline playback'
                      }
                    >
                      {playlistDownloadProgress?.playlistId === activePlaylist.id ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span className="font-mono tabular-nums">
                            Downloading {playlistDownloadProgress.completed}/{playlistDownloadProgress.total}...
                          </span>
                        </>
                      ) : playlistAllTracksCached ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Downloaded Offline</span>
                        </>
                      ) : (
                        <>
                          <ArrowDownCircle className="w-3.5 h-3.5 text-[var(--accent)]" />
                          <span>
                            {playlistCachedCount > 0
                              ? `Download Offline (${playlistCachedCount}/${tracks.length})`
                              : 'Download Playlist Offline'}
                          </span>
                        </>
                      )}
                    </button>
                  )}

                  {filteredTracks.length > 0 && !offline && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (selectionMode) exitSelectionMode();
                          else setSelectionMode(true);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
                          selectionMode
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                        }`}
                      >
                        <CheckSquare className="w-3.5 h-3.5" />
                        {selectionMode ? 'Done' : 'Select'}
                      </button>

                      {selectionMode && (
                        <button
                          type="button"
                          onClick={toggleSelectAll}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
                        >
                          {allVisibleSelected ? (
                            <>
                              <Square className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                              Deselect All
                            </>
                          ) : (
                            <>
                              <CheckSquare className="w-3.5 h-3.5 text-[var(--accent)]" />
                              Select All
                            </>
                          )}
                        </button>
                      )}
                    </>
                  )}

                  {/* Playlist ••• Options Menu */}
                  {!offline && (
                    <div className="relative" ref={detailMenuRef}>
                      <button
                        type="button"
                        onClick={() => setDetailMenuOpen((o) => !o)}
                        disabled={exportingPlaylistId === activePlaylist.id}
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
                        aria-label="Playlist options"
                      >
                        {exportingPlaylistId === activePlaylist.id ? (
                          <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                        ) : (
                          <MoreHorizontal className="w-5 h-5" />
                        )}
                      </button>

                      {detailMenuOpen && (
                        <div className="absolute left-0 top-12 z-40 w-52 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] p-1.5 shadow-2xl">
                          <button
                            type="button"
                            onClick={() => void handleExportM3u(activePlaylist)}
                            className="flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                          >
                            <FileDown className="w-4 h-4 text-[var(--accent)]" />
                            Export as .m3u
                          </button>
                          <div className="my-1 border-t border-[var(--border-subtle)]" />
                          <button
                            type="button"
                            onClick={() => void handleDeletePlaylist(activePlaylist.id)}
                            className="flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm text-[var(--danger-text)] hover:bg-[var(--bg-hover)]"
                          >
                            <Trash2 className="w-4 h-4" />
                            Delete Playlist
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter in playlist..."
                    className="w-full rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] pl-9 pr-8 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {filteredTracks.length === 0 ? (
                <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-12 text-center">
                  <p className="text-base font-semibold text-[var(--text-primary)]">
                    This playlist is empty
                  </p>
                  <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
                    Open your Library and use the track menu or Select mode to add songs here.
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate('/')}
                    className="mt-5 rounded-full bg-[var(--btn-contrast-bg)] px-6 py-2.5 text-sm font-bold text-[var(--btn-contrast-text)] hover:scale-105 transition-transform"
                  >
                    Browse Library
                  </button>
                </div>
              ) : (
                <TrackTable
                  tracks={filteredTracks}
                  playlists={playlists}
                  playlistId={activePlaylist.id}
                  selectionMode={selectionMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelectTrack}
                  onEnterSelectionMode={enterSelectionModeWithTrack}
                  onArtistClick={handleArtistClick}
                  onRemovedFromPlaylist={(trackId) =>
                    setTracks((prev) => prev.filter((t) => t.id !== trackId))
                  }
                  onTrackDeleted={(trackId) => {
                    setTracks((prev) => prev.filter((t) => t.id !== trackId));
                    bumpLibraryRefresh();
                  }}
                  onLikeToggled={(trackId, liked) =>
                    setTracks((prev) =>
                      prev.map((t) => (t.id === trackId ? {...t, liked} : t))
                    )
                  }
                />
              )}
            </>
          )}
        </div>
      ) : (
        // --- MAIN HOME & PLAYLISTS VIEW ---
        <div
          className="min-h-full pb-36 md:pb-12"
          style={{
            paddingBottom: showFloatingBatchBar
              ? 'calc(11.5rem + env(safe-area-inset-bottom, 0px))'
              : 'calc(8.5rem + env(safe-area-inset-bottom, 0px))',
          }}
        >
          {/* DYNAMIC GRADIENT HERO HEADER (Home View Only — extends cleanly behind status bar) */}
          {isHomeView ? (
            <div
              className="relative pt-safe transition-colors duration-500"
              style={{
                background: `linear-gradient(180deg, ${heroTopHexColor} 0%, ${heroTopHexColor}88 42%, var(--bg-primary) 100%)`,
              }}
            >
              <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-4 max-w-7xl mx-auto space-y-4">
                {/* Offline Mode Banner when Disconnected */}
                {offline && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl bg-[var(--warn-bg)] backdrop-blur-md border border-[var(--warn-border)] px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-[var(--warn-text)]">
                        <WifiOff className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[var(--text-primary)]">Offline Mode</p>
                        <p className="text-xs text-[var(--text-secondary)]">
                          <span className="font-mono tabular-nums text-[var(--text-primary)]">
                            {cachedTrackIds.size}
                          </span>{' '}
                          cached {cachedTrackIds.size === 1 ? 'track' : 'tracks'} ·{' '}
                          <span className="font-mono tabular-nums text-[var(--text-primary)]">
                            {playlists.length}
                          </span>{' '}
                          offline {playlists.length === 1 ? 'playlist' : 'playlists'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate('/settings')}
                      className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--surface-overlay)] px-3.5 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-overlay-hover)] transition-colors whitespace-nowrap shrink-0"
                    >
                      <HardDriveDownload className="w-3.5 h-3.5 text-[var(--accent)]" />
                      Manage Offline
                    </button>
                  </div>
                )}

                {/* Top Row: Time-of-Day Greeting + Sleek Compact Filter Pills */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <p className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-[var(--text-primary)]">
                    {offline ? 'Offline Mode' : greeting}
                  </p>

                  <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
                    {homeFilterPills.map((pill) => {
                      const isActive = activeHomeTab === pill.id;
                      return (
                        <button
                          key={pill.id}
                          type="button"
                          onClick={() => {
                            setSearchParams({});
                            setActiveTab(pill.id);
                          }}
                          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                            isActive
                              ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-sm'
                              : isLight
                                ? 'bg-black/[0.06] text-[var(--text-primary)] hover:bg-black/[0.11] border border-black/[0.08]'
                                : 'bg-black/30 text-white/90 hover:bg-black/45 border border-white/10'
                          }`}
                        >
                          {pill.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Centered 220x220 Hero Cover Showcase (1:1 Swipe Left/Right to Skip Track) + Right-Edge Peek Card */}
                <div className="relative flex items-center justify-center pt-1 pb-2 overflow-hidden -mx-4 px-4 sm:mx-0 sm:px-0 select-none">
                  {/* Primary Centered 220x220 Rounded-Square Hero Cover */}
                  <div
                    {...heroCoverSwipe.handlers}
                    style={heroCoverSwipe.style}
                    aria-label="Swipe left for next track or right for previous track"
                    className={`relative z-10 w-[220px] h-[220px] shrink-0 rounded-2xl overflow-hidden ring-1 ring-[var(--border-subtle)] select-none cursor-grab active:cursor-grabbing ${
                      isLight
                        ? 'shadow-[0_18px_42px_rgba(0,0,0,0.16)]'
                        : 'shadow-[0_20px_50px_rgba(0,0,0,0.55)]'
                    }`}
                  >
                    {heroTrack?.cover_file || heroTrack?.coverUrl ? (
                      <AlbumArt
                        coverFile={heroTrack.cover_file}
                        externalUrl={heroTrack.coverUrl}
                        alt={heroTrack.title || activeHomeTitle}
                        color={heroSampledColor || heroTrack.dominant_color}
                        className="w-full h-full rounded-2xl pointer-events-none select-none"
                        iconSize={64}
                      />
                    ) : (
                      <div
                        className={`flex w-full h-full flex-col items-center justify-center bg-gradient-to-br ${HOME_VIEW_META[activeHomeTab].gradient} pointer-events-none`}
                      >
                        {activeHomeTab === 'liked' ? (
                          <Heart className="w-16 h-16 text-white fill-white drop-shadow-lg" />
                        ) : activeHomeTab === 'recent' ? (
                          <Clock className="w-16 h-16 text-white drop-shadow-lg" />
                        ) : activeHomeTab === 'offline' ? (
                          <HardDriveDownload className="w-16 h-16 text-white drop-shadow-lg" />
                        ) : (
                          <Library className="w-16 h-16 text-white drop-shadow-lg" />
                        )}
                      </div>
                    )}
                  </div>

                  {/* Subtle Right-Edge Peek Card (Tappable to Cycle Home Views) */}
                  {nextHomeView && (
                    <button
                      type="button"
                      onClick={() => cycleHomeView(1)}
                      aria-label={`Switch to ${nextHomeView.label}`}
                      title={`Next: ${nextHomeView.label}`}
                      className="group absolute left-[calc(50%+128px)] w-[184px] h-[184px] rounded-2xl overflow-hidden opacity-55 hover:opacity-85 transition-all duration-200 shadow-2xl ring-1 ring-[var(--border-subtle)] focus:outline-none"
                    >
                      {peekCoverFile ? (
                        <AlbumArt
                          coverFile={peekCoverFile}
                          alt={nextHomeView.label}
                          color={HOME_VIEW_META[nextHomeView.id].fallbackColor}
                          className="w-full h-full rounded-2xl pointer-events-none"
                          iconSize={48}
                        />
                      ) : (
                        <div
                          className={`flex w-full h-full items-center justify-center bg-gradient-to-br ${HOME_VIEW_META[nextHomeView.id].gradient}`}
                        >
                          {nextHomeView.id === 'liked' ? (
                            <Heart className="w-12 h-12 text-white/90 fill-white/90" />
                          ) : nextHomeView.id === 'recent' ? (
                            <Clock className="w-12 h-12 text-white/90" />
                          ) : nextHomeView.id === 'offline' ? (
                            <HardDriveDownload className="w-12 h-12 text-white/90" />
                          ) : (
                            <Library className="w-12 h-12 text-white/90" />
                          )}
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-3 py-2.5 text-left">
                        <span className="block text-[11px] font-bold text-white truncate">
                          {nextHomeView.label}
                        </span>
                      </div>
                    </button>
                  )}
                </div>

                {/* Left-Aligned Active View Title & Compact Metadata */}
                <div className="space-y-1">
                  <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)] truncate">
                    {activeHomeTitle}
                  </h1>
                  <p className="text-xs sm:text-sm text-[var(--text-secondary)]">
                    <span className="font-mono tabular-nums text-[var(--text-primary)]">
                      {filteredTracks.length}
                    </span>{' '}
                    {filteredTracks.length === 1 ? 'track' : 'tracks'}
                    {totalDuration > 0 && (
                      <>
                        <span className="mx-1.5 text-[var(--text-muted)]" aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {formatHumanDuration(totalDuration)}
                        </span>
                      </>
                    )}
                    {!artistFilter && !searchQuery && activeHomeTab === 'all' && playlists.length > 0 && (
                      <>
                        <span className="mx-1.5 text-[var(--text-muted)]" aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{playlists.length}</span>{' '}
                        {playlists.length === 1 ? 'playlist' : 'playlists'}
                      </>
                    )}
                  </p>
                </div>

                {/* Clean Single-Row Action Bar: Left (Select + Search Toggle + Active Chips) | Right (Shuffle + Circular Accent Play) */}
                <div className="flex items-center justify-between gap-3 pt-0.5">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    {!offline && filteredTracks.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          if (selectionMode) exitSelectionMode();
                          else setSelectionMode(true);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors shrink-0 ${
                          selectionMode
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : isLight
                              ? 'border-black/[0.12] bg-black/[0.05] text-[var(--text-primary)] hover:bg-black/[0.1]'
                              : 'border-white/20 bg-black/25 text-white/90 hover:border-white/40 hover:text-white'
                        }`}
                      >
                        <CheckSquare className="w-3.5 h-3.5" />
                        <span>{selectionMode ? 'Done' : 'Select'}</span>
                      </button>
                    )}

                    {selectionMode && !offline && filteredTracks.length > 0 && (
                      <button
                        type="button"
                        onClick={toggleSelectAll}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors shrink-0 ${
                          isLight
                            ? 'border-black/[0.12] bg-black/[0.05] text-[var(--text-primary)] hover:bg-black/[0.1]'
                            : 'border-white/20 bg-black/25 text-white hover:bg-white/10'
                        }`}
                      >
                        {allVisibleSelected ? (
                          <>
                            <Square className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                            <span>Deselect All</span>
                          </>
                        ) : (
                          <>
                            <CheckSquare className="w-3.5 h-3.5 text-[var(--accent)]" />
                            <span>Select All</span>
                          </>
                        )}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setSearchOpen((prev) => {
                          const next = !prev;
                          if (next) {
                            requestAnimationFrame(() => searchInputRef.current?.focus());
                          }
                          return next;
                        });
                      }}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors shrink-0 ${
                        searchOpen || searchQuery
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                          : isLight
                            ? 'border-black/[0.12] bg-black/[0.05] text-[var(--text-primary)] hover:bg-black/[0.1]'
                            : 'border-white/20 bg-black/25 text-white/90 hover:border-white/40 hover:text-white'
                      }`}
                      aria-label="Filter tracks"
                      title="Filter tracks"
                    >
                      <Search className="w-3.5 h-3.5" />
                      <span className="hidden xs:inline sm:inline">Filter</span>
                    </button>

                    {artistFilter && (
                      <button
                        type="button"
                        onClick={() => setSearchParams({})}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-overlay)] border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-overlay-hover)] shrink-0"
                      >
                        <span className="truncate max-w-[120px]">{artistFilter}</span>
                        <X className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                      </button>
                    )}
                  </div>

                  {/* Right Side: Shuffle + Prominent Circular Accent Play */}
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={handleShufflePlay}
                      disabled={filteredTracks.length === 0}
                      className={`relative flex h-10 w-10 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                        shuffle
                          ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-overlay)]'
                      }`}
                      aria-label="Shuffle play"
                      title="Shuffle play"
                    >
                      <Shuffle className="w-5 h-5" />
                      {shuffle && (
                        <span className="absolute bottom-1 h-1 w-1 rounded-full bg-[var(--accent)]" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handlePlayAll}
                      disabled={filteredTracks.length === 0}
                      className="flex w-12 h-12 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xl hover:bg-[var(--accent-hover)] hover:scale-105 active:scale-95 disabled:opacity-40 transition-all"
                      aria-label={`Play ${activeHomeTitle}`}
                      title={`Play ${activeHomeTitle}`}
                    >
                      <Play className="w-5 h-5 fill-current ml-0.5" />
                    </button>
                  </div>
                </div>

                {/* Collapsible Quick Inline Search Filter */}
                {(searchOpen || Boolean(searchQuery)) && (
                  <div className="relative pt-1">
                    <Search className="pointer-events-none absolute left-3 top-[calc(50%+2px)] -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter title, artist, album..."
                      className="w-full sm:max-w-sm rounded-lg bg-[var(--bg-input)] border border-[var(--border-strong)] pl-9 pr-9 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setSearchOpen(false);
                      }}
                      className="absolute right-2.5 sm:left-[352px] sm:right-auto top-[calc(50%+2px)] -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      aria-label="Close filter"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* PLAYLISTS TAB HEADER (/playlists) */
            <div
              className="px-4 sm:px-6 lg:px-8 pb-4 max-w-7xl mx-auto"
              style={{paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))'}}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)] truncate">
                    {offline ? 'Offline Playlists' : 'Your Playlists'}
                  </h1>
                  <p className="mt-0.5 text-xs sm:text-sm text-[var(--text-secondary)]">
                    <span className="font-mono tabular-nums">{playlists.length}</span>{' '}
                    {playlists.length === 1 ? 'playlist' : 'playlists'}
                    {!offline && (
                      <>
                        <span className="mx-1.5 text-[var(--text-muted)]" aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{stats.totalTracks}</span>{' '}
                        {stats.totalTracks === 1 ? 'track' : 'tracks'}
                      </>
                    )}
                  </p>
                </div>

                {!offline && (
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-4 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-4 h-4 stroke-[2.5]" />
                    Create Playlist
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Content Stage (Starts Immediately Below Hero Action Bar) */}
          <div className="px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
            {activeTab === 'playlists' ? (
              playlists.length === 0 ? (
                <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-12 text-center">
                  <Disc3 className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
                  <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                    {offline ? 'No offline playlists cached' : 'No playlists created yet'}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--text-secondary)] max-w-md mx-auto">
                    {offline
                      ? 'When back online, open any playlist and tap Download Playlist Offline to listen in Airplane Mode.'
                      : 'Organize your NAS tracks into custom collections, or place .m3u / .m3u8 files inside your music folder and run a library scan.'}
                  </p>
                  {!offline && (
                    <button
                      type="button"
                      onClick={() => setCreateOpen(true)}
                      className="mt-5 rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                    >
                      Create First Playlist
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
                  {playlists.map((pl) => {
                    const isPlMenuOpen = playlistMenuId === pl.id;
                    return (
                      <div
                        key={pl.id}
                        onClick={() => navigate(`/playlists/${pl.id}`)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') navigate(`/playlists/${pl.id}`);
                        }}
                        className="group relative rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-4 hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer"
                      >
                        <div className="relative mb-3.5">
                          <PlaylistMosaic
                            covers={pl.covers || []}
                            alt={pl.name}
                            className="w-full aspect-square rounded-md"
                          />

                          {pl.source === 'm3u' && (
                            <span className="absolute top-2 left-2 font-mono text-[10px] font-bold tracking-wide text-[var(--accent)] bg-black/75 border border-[var(--accent)]/40 rounded px-1.5 py-0.5 leading-none backdrop-blur-xs">
                              M3U
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={(e) => void handleQuickPlayPlaylist(e, pl.id)}
                            className="absolute bottom-2.5 right-2.5 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xl opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 hover:bg-[var(--accent-hover)] hover:scale-105 transition-all"
                            aria-label={`Play ${pl.name}`}
                          >
                            <Play className="w-5 h-5 fill-current ml-0.5" />
                          </button>
                        </div>

                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-[var(--text-primary)] truncate">
                              {pl.name}
                            </p>
                            <p className="mt-1 text-xs text-[var(--text-secondary)] truncate">
                              {pl.description ||
                                `${pl.track_count} ${pl.track_count === 1 ? 'track' : 'tracks'}`}
                            </p>
                          </div>

                          {!offline && (
                            <div
                              className="relative shrink-0"
                              ref={isPlMenuOpen ? playlistMenuRef : null}
                            >
                              <button
                                type="button"
                                disabled={exportingPlaylistId === pl.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPlaylistMenuId(isPlMenuOpen ? null : pl.id);
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)] transition-colors"
                                aria-label={`Options for ${pl.name}`}
                              >
                                {exportingPlaylistId === pl.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
                                ) : (
                                  <MoreHorizontal className="w-4 h-4" />
                                )}
                              </button>

                              {isPlMenuOpen && (
                                <div
                                  onClick={(e) => e.stopPropagation()}
                                  className="absolute right-0 bottom-9 z-40 w-48 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] p-1.5 shadow-2xl"
                                >
                                  <button
                                    type="button"
                                    onClick={() => void handleExportM3u(pl)}
                                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                                  >
                                    <FileDown className="w-3.5 h-3.5 text-[var(--accent)]" />
                                    Export as .m3u
                                  </button>
                                  <div className="my-1 border-t border-[var(--border-subtle)]" />
                                  <button
                                    type="button"
                                    onClick={() => void handleDeletePlaylist(pl.id)}
                                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs font-medium text-[var(--danger-text)] hover:bg-[var(--bg-hover)]"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    Delete Playlist
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : loading ? (
              <div className="flex items-center justify-center py-16 text-[var(--text-secondary)] gap-2">
                <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
                <span className="text-sm">Loading tracks...</span>
              </div>
            ) : filteredTracks.length === 0 ? (
              <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-10 text-center space-y-3">
                {activeTab === 'offline' || offline ? (
                  <HardDriveDownload className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
                ) : (
                  <Library className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
                )}
                <h2 className="font-display text-lg font-bold text-[var(--text-primary)]">
                  {searchQuery || artistFilter
                    ? 'No matching tracks found'
                    : activeTab === 'offline' || offline
                      ? 'No offline music downloaded yet'
                      : activeTab === 'liked'
                        ? 'No liked songs yet'
                        : 'Your music library is empty'}
                </h2>
                <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
                  {searchQuery || artistFilter
                    ? 'Try adjusting your search or clearing the active filter.'
                    : activeTab === 'offline' || offline
                      ? 'Tap the download button next to any track, or open a playlist and tap Download Playlist Offline to listen without an internet connection.'
                      : activeTab === 'liked'
                        ? 'Tap the heart icon next to any track to save it to your Liked Songs.'
                        : 'Search and download tracks with yt-dlp, or configure and scan your NAS mount path in Settings.'}
                </p>
                {!searchQuery &&
                  !artistFilter &&
                  activeTab !== 'liked' &&
                  activeTab !== 'offline' &&
                  !offline && (
                    <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                      {(user?.can_download || user?.role === 'admin') && (
                        <button
                          type="button"
                          onClick={() => navigate('/discover')}
                          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                        >
                          <Search className="w-4 h-4" />
                          Discover Music & Download
                        </button>
                      )}
                      {user?.role === 'admin' && (
                        <button
                          type="button"
                          onClick={() => navigate('/settings')}
                          className="inline-flex items-center gap-2 rounded-full bg-[var(--bg-elevated)] px-5 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                        >
                          <Settings className="w-4 h-4" />
                          Configure NAS Mount & Scan
                        </button>
                      )}
                    </div>
                  )}
              </div>
            ) : (
              <TrackTable
                tracks={filteredTracks}
                playlists={playlists}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelectTrack}
                onEnterSelectionMode={enterSelectionModeWithTrack}
                onArtistClick={handleArtistClick}
                onTrackDeleted={(trackId) => {
                  setTracks((prev) => prev.filter((t) => t.id !== trackId));
                  bumpLibraryRefresh();
                }}
                onLikeToggled={(trackId, liked) => {
                  setTracks((prev) => {
                    if (activeTab === 'liked' && !liked) {
                      return prev.filter((t) => t.id !== trackId);
                    }
                    return prev.map((t) => (t.id === trackId ? {...t, liked} : t));
                  });
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Sticky Floating Batch Action Bar */}
      {showFloatingBatchBar && (
        <div
          className={`fixed left-3 right-3 md:left-[264px] md:right-6 z-40 flex justify-center pointer-events-none ${
            currentTrack
              ? 'bottom-[calc(138px+env(safe-area-inset-bottom,0px))]'
              : 'bottom-[calc(70px+env(safe-area-inset-bottom,0px))]'
          } md:bottom-[104px]`}
        >
          <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-2 sm:gap-3 w-full max-w-3xl rounded-xl bg-[var(--bg-mini-glass)] backdrop-blur-xl border border-[var(--border-strong)] px-3.5 sm:px-4 py-2.5 shadow-2xl">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-xs sm:text-sm font-bold tabular-nums text-[var(--text-primary)]">
                {selectedIdArray.length} selected
              </span>
              <button
                type="button"
                onClick={exitSelectionMode}
                className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
              >
                Clear
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setBatchPlaylistOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3.5 py-2 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>Add to Playlist</span>
              </button>

              <button
                type="button"
                onClick={handleBatchAddToQueue}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <ListPlus className="w-3.5 h-3.5" />
                <span>Add to Queue</span>
              </button>

              {canDeleteTracks && (
                <button
                  type="button"
                  onClick={() => {
                    setBatchDeleteError(null);
                    setBatchDeleteOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-red-600/90 px-3.5 py-2 text-xs font-bold text-white hover:bg-red-500 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Permanently</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <CreatePlaylistModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(pl) => {
          setPlaylists((prev) => [pl, ...prev]);
          bumpLibraryRefresh();
          navigate(`/playlists/${pl.id}`);
        }}
      />

      <AddToPlaylistModal
        open={batchPlaylistOpen}
        trackIds={selectedIdArray}
        playlists={playlists}
        onClose={() => setBatchPlaylistOpen(false)}
        onSuccess={(message, createdPlaylist) => {
          if (createdPlaylist) {
            setPlaylists((prev) => [createdPlaylist, ...prev]);
          }
          flashToast(message);
          exitSelectionMode();
          bumpLibraryRefresh();
        }}
      />

      <ConfirmDeleteModal
        open={batchDeleteOpen}
        count={selectedIdArray.length}
        singleTitle={
          selectedTracks.length === 1
            ? `${selectedTracks[0].title} — ${selectedTracks[0].artist}`
            : undefined
        }
        deleting={batchDeleting}
        error={batchDeleteError}
        onCancel={() => {
          if (!batchDeleting) {
            setBatchDeleteOpen(false);
            setBatchDeleteError(null);
          }
        }}
        onConfirm={() => void handleBatchConfirmDelete()}
      />
    </>
  );
};

