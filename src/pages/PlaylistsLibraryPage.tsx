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
  Square,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useLocation, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {AddToPlaylistModal} from '../components/AddToPlaylistModal';
import {PlaylistMosaic} from '../components/AlbumArt';
import {ConfirmDeleteModal} from '../components/ConfirmDeleteModal';
import {CreatePlaylistModal} from '../components/CreatePlaylistModal';
import {TrackTable} from '../components/TrackTable';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useOfflineLibrary} from '../hooks/useOfflineLibrary';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {apiFetch, formatDuration} from '../lib/api';
import type {Playlist, Track} from '../types';
import {
  getOfflinePlaylists,
  getOfflinePlaylistTracks,
  getOfflineTracks,
  saveOfflinePlaylistMetadata,
  subscribeOfflineStore,
} from '../utils/offlineStore';

type LibraryTab = 'all' | 'liked' | 'recent' | 'offline' | 'playlists';

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
    playTrack,
    addManyToQueue,
    handleDeletedTracks,
    libraryRefreshVersion,
    bumpLibraryRefresh,
  } = usePlayer();

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
    () => filteredTracks.filter((t) => selectedIds.has(t.id)),
    [filteredTracks, selectedIds]
  );

  const selectedIdArray = useMemo(
    () => selectedTracks.map((t) => t.id),
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
      setSelectedIds(new Set(filteredTracks.map((t) => t.id)));
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
    return tracks.every((t) => cachedTrackIds.has(t.id));
  }, [activePlaylist, tracks, cachedTrackIds]);

  const playlistCachedCount = useMemo(() => {
    if (!activePlaylist || tracks.length === 0) return 0;
    return tracks.filter((t) => cachedTrackIds.has(t.id)).length;
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
        await removeTrack(t.id);
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
    const allTrackIds = tracks.map((t) => t.id);

    await saveOfflinePlaylistMetadata(activePlaylist, allTrackIds);

    let completed = tracks.filter((t) => cachedTrackIds.has(t.id)).length;
    setPlaylistDownloadProgress({
      playlistId: activePlaylist.id,
      completed,
      total: tracks.length,
    });

    let failed = 0;
    try {
      for (const track of tracks) {
        if (controller.signal.aborted) break;
        if (cachedTrackIds.has(track.id)) continue;
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
      setTracks((prev) => prev.filter((t) => !removedSet.has(t.id)));
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

  const tabs: Array<{id: LibraryTab; label: string; icon: React.FC<{className?: string}>}> = offline
    ? [
        {id: 'offline', label: 'Offline Library', icon: HardDriveDownload},
        {id: 'playlists', label: 'Offline Playlists', icon: Disc3},
      ]
    : [
        {id: 'all', label: 'All Tracks', icon: Library},
        {id: 'liked', label: 'Liked Songs', icon: Heart},
        {id: 'recent', label: 'Recently Downloaded', icon: Clock},
        {id: 'offline', label: 'Offline Library', icon: HardDriveDownload},
        {id: 'playlists', label: 'User Playlists', icon: Disc3},
      ];

  const showFloatingBatchBar = selectionMode && selectedIdArray.length > 0;

  return (
    <>
      {pageToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[#1DB954] px-4 py-2 text-sm font-semibold text-black shadow-xl max-w-[90vw] truncate">
          {pageToast}
        </div>
      )}

      {playlistIdParam ? (
        // --- PLAYLIST DETAIL VIEW (/playlists/:id) ---
        <div className={`px-4 sm:px-6 lg:px-8 pt-6 max-w-7xl mx-auto ${showFloatingBatchBar ? 'pb-24' : ''}`}>
          <button
            type="button"
            onClick={() => navigate('/playlists')}
            className="inline-flex items-center gap-2 text-sm font-medium text-[#B3B3B3] hover:text-white mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Playlists
          </button>

          {loading && !activePlaylist ? (
            <div className="flex items-center justify-center py-20 text-[#B3B3B3] gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-[#1DB954]" />
              <span>Loading playlist...</span>
            </div>
          ) : !activePlaylist ? (
            <div className="rounded-xl bg-[#181818] p-10 text-center">
              <p className="text-base font-semibold text-white">Playlist not found</p>
              <button
                type="button"
                onClick={() => navigate('/playlists')}
                className="mt-4 rounded-full bg-white px-5 py-2 text-sm font-bold text-black"
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
                    <p className="text-xs font-semibold text-[#B3B3B3]">Playlist</p>
                    {activePlaylist.source === 'm3u' && (
                      <span className="font-mono text-[10px] font-semibold text-[#1DB954] border border-[#1DB954]/40 bg-[#1DB954]/10 rounded px-1.5 py-0.5 leading-none">
                        M3U
                      </span>
                    )}
                  </div>
                  <h1 className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight text-white break-words">
                    {activePlaylist.name}
                  </h1>
                  {activePlaylist.description && (
                    <p className="text-sm text-[#B3B3B3] max-w-2xl">{activePlaylist.description}</p>
                  )}
                  {activePlaylist.m3u_path && (
                    <p className="font-mono text-xs text-[#6A6A6A] truncate">
                      {activePlaylist.m3u_path}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#B3B3B3] pt-1">
                    <span className="font-semibold text-white">
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
              <div className="flex flex-wrap items-center justify-between gap-3 py-4 border-b border-white/10 mb-4">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={filteredTracks.length === 0}
                    onClick={handlePlayAll}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-[#1DB954] text-black shadow-lg hover:bg-[#1ED760] hover:scale-105 active:scale-95 disabled:opacity-40 transition-all"
                    aria-label="Play playlist"
                  >
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                  </button>

                  {/* Download Playlist Offline Button with Progress State */}
                  {tracks.length > 0 && (
                    <button
                      type="button"
                      disabled={!playlistAllTracksCached && offline && playlistDownloadProgress?.playlistId !== activePlaylist.id}
                      onClick={() => void handleDownloadPlaylistOffline()}
                      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-40 whitespace-nowrap ${
                        playlistDownloadProgress?.playlistId === activePlaylist.id
                          ? 'border-[#1DB954] bg-[#1DB954]/15 text-[#1DB954]'
                          : playlistAllTracksCached
                            ? 'border-[#1DB954]/50 bg-[#1DB954]/15 text-[#1DB954] hover:bg-[#1DB954]/20'
                            : 'border-white/15 bg-[#181818] text-white hover:border-white/40 hover:bg-[#282828]'
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
                          <ArrowDownCircle className="w-3.5 h-3.5 text-[#1DB954]" />
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
                            ? 'border-[#1DB954] bg-[#1DB954]/15 text-[#1DB954]'
                            : 'border-white/15 text-[#B3B3B3] hover:border-white/40 hover:text-white'
                        }`}
                      >
                        <CheckSquare className="w-3.5 h-3.5" />
                        {selectionMode ? 'Done' : 'Select'}
                      </button>

                      {selectionMode && (
                        <button
                          type="button"
                          onClick={toggleSelectAll}
                          className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#282828] transition-colors"
                        >
                          {allVisibleSelected ? (
                            <>
                              <Square className="w-3.5 h-3.5 text-[#B3B3B3]" />
                              Deselect All
                            </>
                          ) : (
                            <>
                              <CheckSquare className="w-3.5 h-3.5 text-[#1DB954]" />
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
                        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 text-[#B3B3B3] hover:border-white/40 hover:text-white transition-colors"
                        aria-label="Playlist options"
                      >
                        {exportingPlaylistId === activePlaylist.id ? (
                          <Loader2 className="w-4 h-4 animate-spin text-[#1DB954]" />
                        ) : (
                          <MoreHorizontal className="w-5 h-5" />
                        )}
                      </button>

                      {detailMenuOpen && (
                        <div className="absolute left-0 top-12 z-40 w-52 rounded-lg bg-[#282828] border border-white/10 p-1.5 shadow-2xl">
                          <button
                            type="button"
                            onClick={() => void handleExportM3u(activePlaylist)}
                            className="flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm text-white hover:bg-white/10"
                          >
                            <FileDown className="w-4 h-4 text-[#1DB954]" />
                            Export as .m3u
                          </button>
                          <div className="my-1 border-t border-white/10" />
                          <button
                            type="button"
                            onClick={() => void handleDeletePlaylist(activePlaylist.id)}
                            className="flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm text-red-400 hover:bg-white/10"
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
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#B3B3B3]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter in playlist..."
                    className="w-full rounded-md bg-[#282828] pl-9 pr-8 py-2 text-sm text-white placeholder-[#6A6A6A] focus:outline-none focus:ring-1 focus:ring-[#1DB954]"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#B3B3B3] hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {filteredTracks.length === 0 ? (
                <div className="rounded-xl bg-[#181818] p-12 text-center">
                  <p className="text-base font-semibold text-white">This playlist is empty</p>
                  <p className="mt-1.5 text-sm text-[#B3B3B3]">
                    Open your Library and use the track menu or Select mode to add songs here.
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate('/')}
                    className="mt-5 rounded-full bg-white px-6 py-2.5 text-sm font-bold text-black hover:scale-105 transition-transform"
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
        // --- MAIN LIBRARY & PLAYLISTS VIEW ---
        <div className={`px-4 sm:px-6 lg:px-8 pt-6 max-w-7xl mx-auto space-y-6 ${showFloatingBatchBar ? 'pb-24' : ''}`}>
          {/* Offline Mode Banner when Disconnected */}
          {offline && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl bg-[#181818] border border-amber-500/30 px-4 py-3.5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
                  <WifiOff className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white">Offline Mode</p>
                  <p className="text-xs text-[#B3B3B3]">
                    Showing{' '}
                    <span className="font-mono tabular-nums text-white">{cachedTrackIds.size}</span>{' '}
                    cached {cachedTrackIds.size === 1 ? 'track' : 'tracks'} and{' '}
                    <span className="font-mono tabular-nums text-white">{playlists.length}</span>{' '}
                    offline {playlists.length === 1 ? 'playlist' : 'playlists'} stored on this device.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#282828] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#333333] transition-colors whitespace-nowrap shrink-0"
              >
                <HardDriveDownload className="w-3.5 h-3.5 text-[#1DB954]" />
                Manage Offline Storage
              </button>
            </div>
          )}

          {/* Header Row */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                {offline
                  ? activeTab === 'playlists'
                    ? 'Offline Playlists'
                    : 'Offline Mode'
                  : activeTab === 'playlists'
                    ? 'Your Playlists'
                    : activeTab === 'liked'
                      ? 'Liked Songs'
                      : activeTab === 'recent'
                        ? 'Recently Downloaded'
                        : activeTab === 'offline'
                          ? 'Offline Library'
                          : 'Music Library'}
              </h1>
              <p className="mt-1 text-sm text-[#B3B3B3]">
                {offline ? (
                  <>
                    <span className="font-mono tabular-nums">{cachedTrackIds.size}</span> cached
                    tracks
                    <span className="mx-2 text-[#6A6A6A]" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{playlists.length}</span> cached
                    playlists
                  </>
                ) : (
                  <>
                    <span className="font-mono tabular-nums">{stats.totalTracks}</span> tracks
                    indexed
                    <span className="mx-2 text-[#6A6A6A]" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{stats.likedTracks}</span> liked
                    <span className="mx-2 text-[#6A6A6A]" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{cachedTrackIds.size}</span> offline
                    <span className="mx-2 text-[#6A6A6A]" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{playlists.length}</span> playlists
                  </>
                )}
              </p>
            </div>

            {!offline && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1DB954] px-5 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760] transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                Create Playlist
              </button>
            )}
          </div>

          {/* Quick Collection Cards (Top Spotlight Row) */}
          {!offline && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <button
                type="button"
                onClick={() => {
                  setSearchParams({});
                  setActiveTab('all');
                }}
                className={`group flex items-center gap-3.5 rounded-md overflow-hidden pr-4 text-left transition-colors ${
                  activeTab === 'all' && !artistFilter
                    ? 'bg-[#282828] ring-1 ring-white/15'
                    : 'bg-[#181818] hover:bg-[#282828]'
                }`}
              >
                <div className="flex h-16 w-16 shrink-0 items-center justify-center bg-gradient-to-br from-[#282828] to-[#121212]">
                  <Library className="w-6 h-6 text-[#1DB954]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">All Tracks</p>
                  <p className="text-xs text-[#B3B3B3] font-mono tabular-nums">
                    {stats.totalTracks} songs
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSearchParams({});
                  setActiveTab('liked');
                }}
                className={`group flex items-center gap-3.5 rounded-md overflow-hidden pr-4 text-left transition-colors ${
                  activeTab === 'liked'
                    ? 'bg-[#282828] ring-1 ring-white/15'
                    : 'bg-[#181818] hover:bg-[#282828]'
                }`}
              >
                <div className="flex h-16 w-16 shrink-0 items-center justify-center bg-gradient-to-br from-[#3b28cc] via-[#2b4d8f] to-[#1DB954]">
                  <Heart className="w-6 h-6 text-white fill-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">Liked Songs</p>
                  <p className="text-xs text-[#B3B3B3] font-mono tabular-nums">
                    {stats.likedTracks} saved
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSearchParams({});
                  setActiveTab('recent');
                }}
                className={`group flex items-center gap-3.5 rounded-md overflow-hidden pr-4 text-left transition-colors ${
                  activeTab === 'recent'
                    ? 'bg-[#282828] ring-1 ring-white/15'
                    : 'bg-[#181818] hover:bg-[#282828]'
                }`}
              >
                <div className="flex h-16 w-16 shrink-0 items-center justify-center bg-gradient-to-br from-[#1DB954] to-[#124e28]">
                  <Clock className="w-6 h-6 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">Recently Downloaded</p>
                  <p className="text-xs text-[#B3B3B3]">Latest additions</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSearchParams({});
                  setActiveTab('offline');
                }}
                className={`group flex items-center gap-3.5 rounded-md overflow-hidden pr-4 text-left transition-colors ${
                  activeTab === 'offline'
                    ? 'bg-[#282828] ring-1 ring-[#1DB954]/40'
                    : 'bg-[#181818] hover:bg-[#282828]'
                }`}
              >
                <div className="flex h-16 w-16 shrink-0 items-center justify-center bg-gradient-to-br from-emerald-600 to-[#0e2d1d]">
                  <HardDriveDownload className="w-6 h-6 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">Offline Library</p>
                  <p className="text-xs text-[#B3B3B3] font-mono tabular-nums">
                    {cachedTrackIds.size} cached
                  </p>
                </div>
              </button>
            </div>
          )}

          {/* Interactive Filter Tabs + Search Bar */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-[#181818] p-1 w-fit max-w-full">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setSearchParams({});
                    setActiveTab(tab.id);
                  }}
                  className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === tab.id
                      ? 'bg-[#282828] text-white'
                      : 'text-[#B3B3B3] hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              {artistFilter && (
                <button
                  type="button"
                  onClick={() => setSearchParams({})}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#282828] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#333333]"
                >
                  <span>Artist: {artistFilter}</span>
                  <X className="w-3.5 h-3.5 text-[#B3B3B3]" />
                </button>
              )}
              {activeTab !== 'playlists' && (
                <div className="relative flex-1 md:w-72">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#B3B3B3]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search title, artist, album..."
                    className="w-full rounded-md bg-[#181818] border border-white/10 pl-9 pr-8 py-2 text-sm text-white placeholder-[#6A6A6A] focus:border-[#1DB954] focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#B3B3B3] hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Content Stage */}
          {activeTab === 'playlists' ? (
            playlists.length === 0 ? (
              <div className="rounded-xl bg-[#181818] p-12 text-center">
                <Disc3 className="w-10 h-10 text-[#6A6A6A] mx-auto mb-3" />
                <h2 className="font-display text-lg font-bold text-white">
                  {offline ? 'No offline playlists cached' : 'No playlists created yet'}
                </h2>
                <p className="mt-1 text-sm text-[#B3B3B3] max-w-md mx-auto">
                  {offline
                    ? 'When back online, open any playlist and tap Download Playlist Offline to listen in Airplane Mode.'
                    : 'Organize your NAS tracks into custom collections, or place .m3u / .m3u8 files inside your music folder and run a library scan.'}
                </p>
                {!offline && (
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="mt-5 rounded-full bg-[#1DB954] px-6 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760]"
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
                      className="group relative rounded-lg bg-[#181818] p-4 hover:bg-[#282828] transition-colors cursor-pointer"
                    >
                      <div className="relative mb-3.5">
                        <PlaylistMosaic
                          covers={pl.covers || []}
                          alt={pl.name}
                          className="w-full aspect-square rounded-md"
                        />

                        {pl.source === 'm3u' && (
                          <span className="absolute top-2 left-2 font-mono text-[10px] font-bold tracking-wide text-[#1DB954] bg-black/75 border border-[#1DB954]/40 rounded px-1.5 py-0.5 leading-none backdrop-blur-xs">
                            M3U
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={(e) => void handleQuickPlayPlaylist(e, pl.id)}
                          className="absolute bottom-2.5 right-2.5 flex h-12 w-12 items-center justify-center rounded-full bg-[#1DB954] text-black shadow-xl opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 hover:bg-[#1ED760] hover:scale-105 transition-all"
                          aria-label={`Play ${pl.name}`}
                        >
                          <Play className="w-5 h-5 fill-current ml-0.5" />
                        </button>
                      </div>

                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-white truncate">{pl.name}</p>
                          <p className="mt-1 text-xs text-[#B3B3B3] truncate">
                            {pl.description || `${pl.track_count} ${pl.track_count === 1 ? 'track' : 'tracks'}`}
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
                              className="flex h-7 w-7 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-white/10 hover:text-white transition-colors"
                              aria-label={`Options for ${pl.name}`}
                            >
                              {exportingPlaylistId === pl.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1DB954]" />
                              ) : (
                                <MoreHorizontal className="w-4 h-4" />
                              )}
                            </button>

                            {isPlMenuOpen && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="absolute right-0 bottom-9 z-40 w-48 rounded-lg bg-[#282828] border border-white/10 p-1.5 shadow-2xl"
                              >
                                <button
                                  type="button"
                                  onClick={() => void handleExportM3u(pl)}
                                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs font-medium text-white hover:bg-white/10"
                                >
                                  <FileDown className="w-3.5 h-3.5 text-[#1DB954]" />
                                  Export as .m3u
                                </button>
                                <div className="my-1 border-t border-white/10" />
                                <button
                                  type="button"
                                  onClick={() => void handleDeletePlaylist(pl.id)}
                                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs font-medium text-red-400 hover:bg-white/10"
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
            <div className="flex items-center justify-center py-20 text-[#B3B3B3] gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-[#1DB954]" />
              <span className="text-sm">Loading tracks...</span>
            </div>
          ) : filteredTracks.length === 0 ? (
            <div className="rounded-xl bg-[#181818] p-12 text-center space-y-3">
              {activeTab === 'offline' || offline ? (
                <HardDriveDownload className="w-10 h-10 text-[#6A6A6A] mx-auto" />
              ) : (
                <Library className="w-10 h-10 text-[#6A6A6A] mx-auto" />
              )}
              <h2 className="font-display text-lg font-bold text-white">
                {searchQuery || artistFilter
                  ? 'No matching tracks found'
                  : activeTab === 'offline' || offline
                    ? 'No offline music downloaded yet'
                    : activeTab === 'liked'
                      ? 'No liked songs yet'
                      : 'Your music library is empty'}
              </h2>
              <p className="text-sm text-[#B3B3B3] max-w-md mx-auto">
                {searchQuery || artistFilter
                  ? 'Try adjusting your search or clearing the active filter.'
                  : activeTab === 'offline' || offline
                    ? 'Tap the download button next to any track, or open a playlist and tap Download Playlist Offline to listen without an internet connection.'
                    : activeTab === 'liked'
                      ? 'Tap the heart icon next to any track to save it to your Liked Songs.'
                      : 'Search and download tracks with yt-dlp, or configure and scan your NAS mount path in Settings.'}
              </p>
              {!searchQuery && !artistFilter && activeTab !== 'liked' && activeTab !== 'offline' && !offline && (
                <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                  {(user?.can_download || user?.role === 'admin') && (
                    <button
                      type="button"
                      onClick={() => navigate('/search')}
                      className="inline-flex items-center gap-2 rounded-full bg-[#1DB954] px-5 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760]"
                    >
                      <Search className="w-4 h-4" />
                      Search YouTube & Download
                    </button>
                  )}
                  {user?.role === 'admin' && (
                    <button
                      type="button"
                      onClick={() => navigate('/settings')}
                      className="inline-flex items-center gap-2 rounded-full bg-[#282828] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#333333]"
                    >
                      <Settings className="w-4 h-4" />
                      Configure NAS Mount & Scan
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handlePlayAll}
                    className="inline-flex items-center gap-2 rounded-full bg-[#1DB954] px-5 py-2 text-sm font-bold text-black hover:bg-[#1ED760] transition-colors"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    Play All ({filteredTracks.length})
                  </button>

                  {!offline && (
                    <button
                      type="button"
                      onClick={() => {
                        if (selectionMode) exitSelectionMode();
                        else setSelectionMode(true);
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${
                        selectionMode
                          ? 'border-[#1DB954] bg-[#1DB954]/15 text-[#1DB954]'
                          : 'border-white/15 text-[#B3B3B3] hover:border-white/40 hover:text-white'
                      }`}
                    >
                      <CheckSquare className="w-3.5 h-3.5" />
                      {selectionMode ? 'Done' : 'Select'}
                    </button>
                  )}

                  {selectionMode && !offline && (
                    <button
                      type="button"
                      onClick={toggleSelectAll}
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#282828] transition-colors"
                    >
                      {allVisibleSelected ? (
                        <>
                          <Square className="w-3.5 h-3.5 text-[#B3B3B3]" />
                          Deselect All
                        </>
                      ) : (
                        <>
                          <CheckSquare className="w-3.5 h-3.5 text-[#1DB954]" />
                          Select All
                        </>
                      )}
                    </button>
                  )}
                </div>

                <span className="font-mono text-xs tabular-nums text-[#6A6A6A]">
                  Total {formatDuration(totalDuration)}
                </span>
              </div>

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
            </div>
          )}
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
          <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-2 sm:gap-3 w-full max-w-3xl rounded-xl bg-[#222222]/95 backdrop-blur-md border border-white/15 px-3.5 sm:px-4 py-2.5 shadow-2xl">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-xs sm:text-sm font-bold tabular-nums text-white">
                {selectedIdArray.length} selected
              </span>
              <button
                type="button"
                onClick={exitSelectionMode}
                className="text-xs text-[#B3B3B3] hover:text-white underline-offset-2 hover:underline"
              >
                Clear
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setBatchPlaylistOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1DB954] px-3.5 py-2 text-xs font-bold text-black hover:bg-[#1ED760] transition-colors"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>Add to Playlist</span>
              </button>

              <button
                type="button"
                onClick={handleBatchAddToQueue}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#333333] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#3f3f3f] transition-colors"
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

