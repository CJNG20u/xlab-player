import {
  ArrowDownCircle,
  Check,
  CheckCircle2,
  Clock,
  Heart,
  ListPlus,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  Trash2,
} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {useOfflineLibrary} from '../hooks/useOfflineLibrary';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {apiFetch, formatDuration} from '../lib/api';
import type {Playlist, Track} from '../types';
import {AlbumArt} from './AlbumArt';
import {ConfirmDeleteModal} from './ConfirmDeleteModal';

function formatDisplayTrackTitle(title: string): string {
  const cleaned = title.replace(/^\s*\d{1,3}(?:\.|\)|\s+-)\s+/, '').trim();
  return cleaned || title;
}

interface TrackTableProps {
  tracks: Track[];
  playlists: Playlist[];
  playlistId?: number;
  selectionMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (trackId: number) => void;
  onEnterSelectionMode?: (initialTrackId: number) => void;
  onArtistClick?: (artist: string) => void;
  onTrackDeleted?: (trackId: number) => void;
  onRemovedFromPlaylist?: (trackId: number) => void;
  onLikeToggled?: (trackId: number, liked: boolean) => void;
}

export const TrackTable: React.FC<TrackTableProps> = ({
  tracks,
  playlists,
  playlistId,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  onEnterSelectionMode,
  onArtistClick,
  onTrackDeleted,
  onRemovedFromPlaylist,
  onLikeToggled,
}) => {
  const {user, isOfflineMode} = useAuth();
  const {isTidal} = useTheme();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const {
    supported: offlineSupported,
    cachedTrackIds,
    downloadingTrackIds,
    downloadTrack,
    removeTrack,
  } = useOfflineLibrary();
  const {
    currentTrack,
    isPlaying,
    playTrack,
    togglePlay,
    addToQueue,
    playNextInQueue,
    startRadio,
    toggleLikeTrack,
    handleDeletedTracks,
    bumpLibraryRefresh,
  } = usePlayer();

  const canDeleteTracks = !offline && (user?.role === 'admin' || Boolean(user?.can_download));

  const [menuTrackId, setMenuTrackId] = useState<number | null>(null);
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingDeleteTrack, setPendingDeleteTrack] = useState<Track | null>(null);
  const [deletingTrack, setDeletingTrack] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const touchStartPosRef = useRef<{x: number; y: number} | null>(null);
  const didLongPressRef = useRef(false);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuTrackId(null);
        setShowPlaylistSubmenu(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    if (selectionMode) {
      setMenuTrackId(null);
      setShowPlaylistSubmenu(false);
    }
  }, [selectionMode]);

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchStartPosRef.current = null;
  };

  const handleTouchStart = (e: React.TouchEvent, trackId: number) => {
    if (selectionMode || !onEnterSelectionMode || e.touches.length !== 1) return;
    const touch = e.touches[0];
    touchStartPosRef.current = {x: touch.clientX, y: touch.clientY};
    didLongPressRef.current = false;
    clearLongPress();
    touchStartPosRef.current = {x: touch.clientX, y: touch.clientY};
    longPressTimerRef.current = window.setTimeout(() => {
      didLongPressRef.current = true;
      longPressTimerRef.current = null;
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(15);
        } catch {
          // ignore
        }
      }
      onEnterSelectionMode(trackId);
    }, 500);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPosRef.current || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
    if (dx > 10 || dy > 10) {
      clearLongPress();
    }
  };

  const handleAddToPlaylist = async (targetPlaylistId: number, trackId: number, pName: string) => {
    try {
      await apiFetch(`/api/playlists/${targetPlaylistId}/tracks`, {
        method: 'POST',
        body: JSON.stringify({trackId}),
      });
      bumpLibraryRefresh();
      flashToast(`Added to ${pName}`);
    } catch (err) {
      flashToast(err instanceof Error ? err.message : 'Failed to add to playlist');
    } finally {
      setMenuTrackId(null);
      setShowPlaylistSubmenu(false);
    }
  };

  const handleRemoveFromPlaylist = async (trackId: number) => {
    if (!playlistId) return;
    try {
      await apiFetch(`/api/playlists/${playlistId}/tracks/${trackId}`, {method: 'DELETE'});
      onRemovedFromPlaylist?.(trackId);
      bumpLibraryRefresh();
      flashToast('Removed from playlist');
    } catch (err) {
      flashToast(err instanceof Error ? err.message : 'Failed to remove track');
    } finally {
      setMenuTrackId(null);
    }
  };

  const handleToggleOfflineTrack = async (track: Track) => {
    if (typeof track.id !== 'number') return;
    const numericId = track.id;
    if (downloadingTrackIds.has(numericId)) return;
    if (cachedTrackIds.has(numericId)) {
      try {
        await removeTrack(numericId);
        flashToast('Removed from offline storage');
      } catch (err) {
        flashToast(err instanceof Error ? err.message : 'Could not remove offline copy');
      }
      return;
    }
    if (offline) {
      flashToast('Reconnect to download tracks for offline playback');
      return;
    }
    if (!offlineSupported) {
      flashToast('Offline caching requires HTTPS or localhost');
      return;
    }
    try {
      await downloadTrack(track);
      flashToast(`Saved "${track.title}" for offline playback`);
    } catch (err) {
      flashToast(err instanceof Error ? err.message : 'Offline download failed');
    }
  };

  const handleConfirmPermanentDelete = async () => {
    if (!pendingDeleteTrack || typeof pendingDeleteTrack.id !== 'number') return;
    const deletedId = pendingDeleteTrack.id;
    setDeletingTrack(true);
    setDeleteError(null);
    try {
      await apiFetch(`/api/tracks/${deletedId}`, {
        method: 'DELETE',
      });
      const deletedTitle = pendingDeleteTrack.title;
      handleDeletedTracks([deletedId]);
      onTrackDeleted?.(deletedId);
      setPendingDeleteTrack(null);
      flashToast(`Deleted "${deletedTitle}" permanently`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete track');
    } finally {
      setDeletingTrack(false);
    }
  };

  return (
    <div className="relative">
      {toast && (
        <div className="fixed bottom-28 md:bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl">
          {toast}
        </div>
      )}

      {/* Desktop Column Header */}
      <div className="hidden md:grid grid-cols-[40px_minmax(0,1.6fr)_minmax(0,1fr)_124px_40px] items-center gap-4 px-4 py-2 border-b border-[var(--border-subtle)] text-xs font-medium text-[var(--text-secondary)]">
        <span className="text-center">{selectionMode ? '' : '#'}</span>
        <span>Title</span>
        <span>Album</span>
        <span className="flex justify-end pr-2">
          <Clock className="w-4 h-4" />
        </span>
        <span />
      </div>

      {/* Rows */}
      <div className="divide-y divide-[var(--border-subtle)] md:divide-y-0 mt-1">
        {tracks.map((track, idx) => {
          const numericId = typeof track.id === 'number' ? track.id : null;
          const isActive = currentTrack?.id === track.id;
          const isMenuOpen = numericId !== null && menuTrackId === numericId;
          const isSelected = Boolean(
            selectionMode && numericId !== null && selectedIds?.has(numericId)
          );
          const isCached = numericId !== null && cachedTrackIds.has(numericId);
          const isDownloadingOffline = numericId !== null && downloadingTrackIds.has(numericId);

          return (
            <div
              key={`${track.id}-${idx}`}
              className={`group relative grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[40px_minmax(0,1.6fr)_minmax(0,1fr)_124px_40px] items-center gap-3 md:gap-4 rounded-md px-3 md:px-4 py-2.5 transition-colors select-none ${
                isSelected
                  ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
                  : isActive
                    ? 'bg-[var(--bg-elevated)]/85'
                    : 'hover:bg-[var(--bg-hover)]'
              } ${selectionMode ? 'cursor-pointer' : ''}`}
              onTouchStart={(e) => {
                if (numericId !== null) handleTouchStart(e, numericId);
              }}
              onTouchMove={handleTouchMove}
              onTouchEnd={clearLongPress}
              onTouchCancel={clearLongPress}
              onClick={() => {
                if (didLongPressRef.current) {
                  didLongPressRef.current = false;
                  return;
                }
                if (selectionMode && numericId !== null) {
                  onToggleSelect?.(numericId);
                }
              }}
              onDoubleClick={() => {
                if (!selectionMode) playTrack(track, tracks);
              }}
            >
              {/* Index / Play button OR Checkbox (Desktop) */}
              <div className="hidden md:flex items-center justify-center">
                {selectionMode ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (numericId !== null) onToggleSelect?.(numericId);
                    }}
                    className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                      isSelected
                        ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]'
                        : 'border-[var(--border-strong)] bg-transparent hover:border-[var(--text-primary)]'
                    }`}
                    aria-label={isSelected ? `Deselect ${track.title}` : `Select ${track.title}`}
                    aria-pressed={isSelected}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (isActive) togglePlay();
                      else playTrack(track, tracks);
                    }}
                    className="flex h-8 w-8 items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    aria-label={isActive && isPlaying ? 'Pause' : `Play ${track.title}`}
                  >
                    <span
                      className={`font-mono text-sm tabular-nums group-hover:hidden ${
                        isActive ? 'text-[var(--accent)] font-semibold' : ''
                      }`}
                    >
                      {idx + 1}
                    </span>
                    <span className="hidden group-hover:flex items-center justify-center text-[var(--text-primary)]">
                      {isActive && isPlaying ? (
                        <Pause className="w-4 h-4 fill-current" />
                      ) : (
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      )}
                    </span>
                  </button>
                )}
              </div>

              {/* Cover + Title + Artist (plus Mobile Checkbox in selection mode) */}
              <div className="flex items-center gap-3 min-w-0">
                {selectionMode && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (numericId !== null) onToggleSelect?.(numericId);
                    }}
                    className={`md:hidden flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors ${
                      isSelected
                        ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]'
                        : 'border-[var(--border-strong)] bg-transparent'
                    }`}
                    aria-label={isSelected ? `Deselect ${track.title}` : `Select ${track.title}`}
                    aria-pressed={isSelected}
                  >
                    {isSelected && <Check className="w-4 h-4 stroke-[3]" />}
                  </button>
                )}

                <button
                  type="button"
                  onClick={(e) => {
                    if (didLongPressRef.current) {
                      didLongPressRef.current = false;
                      e.stopPropagation();
                      return;
                    }
                    if (selectionMode) {
                      e.stopPropagation();
                      if (numericId !== null) onToggleSelect?.(numericId);
                      return;
                    }
                    if (isActive) togglePlay();
                    else playTrack(track, tracks);
                  }}
                  className="relative shrink-0"
                  aria-label={selectionMode ? `Select ${track.title}` : `Play ${track.title}`}
                >
                  <AlbumArt
                    coverFile={track.cover_file}
                    externalUrl={track.coverUrl}
                    alt={track.title}
                    color={track.dominant_color}
                    className="w-11 h-11 md:w-10 md:h-10 rounded"
                    iconSize={16}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      if (didLongPressRef.current) {
                        didLongPressRef.current = false;
                        e.stopPropagation();
                        return;
                      }
                      if (selectionMode) {
                        e.stopPropagation();
                        if (numericId !== null) onToggleSelect?.(numericId);
                        return;
                      }
                      playTrack(track, tracks);
                    }}
                    className={`block max-w-full truncate text-left text-sm font-medium ${
                      isActive ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {formatDisplayTrackTitle(track.title)}
                  </button>
                  <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] truncate">
                    {isTidal && track.format && (
                      <span className="shrink-0 rounded border border-[rgba(0,255,255,0.35)] bg-[rgba(0,255,255,0.1)] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-[#00FFFF] leading-none">
                        {track.format.toUpperCase()}
                      </span>
                    )}
                    {onArtistClick && !selectionMode ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onArtistClick(track.artist);
                        }}
                        className="truncate hover:text-[var(--text-primary)] hover:underline"
                      >
                        {track.artist}
                      </button>
                    ) : (
                      <span className="truncate">{track.artist}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Album (Desktop) */}
              <div className="hidden md:block min-w-0">
                <p className="truncate text-sm text-[var(--text-secondary)]">{track.album}</p>
              </div>

              {/* Offline Cache + Like + Duration */}
              <div className="flex items-center justify-end gap-1.5 md:gap-2">
                {!selectionMode && (
                  <button
                    type="button"
                    disabled={isDownloadingOffline || (!isCached && offline)}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleToggleOfflineTrack(track);
                    }}
                    className={`flex h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                      isDownloadingOffline
                        ? 'text-[var(--accent)]'
                        : isCached
                          ? 'text-[var(--accent)] hover:text-[var(--accent-hover)]'
                          : 'text-[var(--text-muted)] md:opacity-0 md:group-hover:opacity-100 hover:text-[var(--text-primary)]'
                    }`}
                    title={
                      isDownloadingOffline
                        ? 'Downloading for offline playback...'
                        : isCached
                          ? 'Available offline (click to remove)'
                          : 'Download for offline playback'
                    }
                    aria-label={
                      isDownloadingOffline
                        ? `Downloading ${track.title} for offline playback`
                        : isCached
                          ? `Remove ${track.title} from offline storage`
                          : `Download ${track.title} for offline playback`
                    }
                  >
                    {isDownloadingOffline ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : isCached ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <ArrowDownCircle className="w-4 h-4" />
                    )}
                  </button>
                )}

                {!selectionMode && !offline && (
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (numericId === null) return;
                      const res = await toggleLikeTrack(numericId);
                      if (res !== null) onLikeToggled?.(numericId, res);
                    }}
                    className={`flex h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-full transition-colors ${
                      track.liked
                        ? 'text-[var(--accent)]'
                        : 'text-[var(--text-muted)] md:opacity-0 md:group-hover:opacity-100 hover:text-[var(--text-primary)]'
                    }`}
                    aria-label={track.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
                  >
                    <Heart className={`w-4 h-4 ${track.liked ? 'fill-current' : ''}`} />
                  </button>
                )}
                <span className="hidden md:inline font-mono text-xs tabular-nums text-[var(--text-secondary)] w-11 text-right">
                  {formatDuration(track.duration)}
                </span>

                {/* Context menu button on mobile */}
                {!selectionMode && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowPlaylistSubmenu(false);
                      setMenuTrackId(isMenuOpen ? null : numericId);
                    }}
                    className="md:hidden flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    aria-label="Track options"
                  >
                    <MoreHorizontal className="w-5 h-5" />
                  </button>
                )}
              </div>

              {/* Context menu trigger (Desktop) */}
              <div className="hidden md:flex justify-end relative">
                {!selectionMode && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowPlaylistSubmenu(false);
                      setMenuTrackId(isMenuOpen ? null : numericId);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[var(--text-primary)] transition-opacity"
                    aria-label="Track options"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Dropdown Menu */}
              {isMenuOpen && !selectionMode && (
                <div
                  ref={menuRef}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-4 top-12 z-40 w-56 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-strong)] p-1.5 shadow-2xl"
                >
                  <button
                    type="button"
                    onClick={() => {
                      playNextInQueue(track);
                      setMenuTrackId(null);
                      flashToast('Playing next');
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  >
                    <Play className="w-4 h-4 text-[var(--text-secondary)]" />
                    Play Next
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      addToQueue(track);
                      setMenuTrackId(null);
                      flashToast('Added to queue');
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  >
                    <ListPlus className="w-4 h-4 text-[var(--text-secondary)]" />
                    Add to Queue
                  </button>
                  {!offline && (
                    <button
                      type="button"
                      onClick={() => {
                        startRadio(track);
                        setMenuTrackId(null);
                        flashToast('Starting radio...');
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <Radio className="w-4 h-4 text-[var(--accent)]" />
                      Start Radio
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isDownloadingOffline || (!isCached && offline)}
                    onClick={() => {
                      setMenuTrackId(null);
                      void handleToggleOfflineTrack(track);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                  >
                    {isDownloadingOffline ? (
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                    ) : isCached ? (
                      <CheckCircle2 className="w-4 h-4 text-[var(--accent)]" />
                    ) : (
                      <ArrowDownCircle className="w-4 h-4 text-[var(--text-secondary)]" />
                    )}
                    {isDownloadingOffline
                      ? 'Downloading Offline...'
                      : isCached
                        ? 'Remove Offline Download'
                        : 'Download for Offline'}
                  </button>

                  {!offline && (
                    <>
                      <div className="my-1 border-t border-[var(--border-subtle)]" />

                      <button
                        type="button"
                        onClick={() => setShowPlaylistSubmenu((s) => !s)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
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
                        <div className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-1 space-y-0.5">
                          {playlists.length === 0 ? (
                            <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">No playlists yet</p>
                          ) : (
                            playlists.map((pl) => (
                              <button
                                key={pl.id}
                                type="button"
                                onClick={() => {
                                  if (numericId !== null) {
                                    void handleAddToPlaylist(pl.id, numericId, pl.name);
                                  }
                                }}
                                className="block w-full truncate rounded px-2.5 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                              >
                                {pl.name}
                              </button>
                            ))
                          )}
                        </div>
                      )}

                      {playlistId && numericId !== null && (
                        <button
                          type="button"
                          onClick={() => void handleRemoveFromPlaylist(numericId)}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--warn-text)] hover:bg-[var(--bg-hover)]"
                        >
                          <Trash2 className="w-4 h-4" />
                          Remove from Playlist
                        </button>
                      )}
                    </>
                  )}

                  {canDeleteTracks && (
                    <>
                      <div className="my-1 border-t border-[var(--border-subtle)]" />
                      <button
                        type="button"
                        onClick={() => {
                          setMenuTrackId(null);
                          setDeleteError(null);
                          setPendingDeleteTrack(track);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--danger-text)] hover:bg-[var(--bg-hover)]"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete Permanently
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDeleteModal
        open={Boolean(pendingDeleteTrack)}
        count={pendingDeleteTrack ? 1 : 0}
        singleTitle={pendingDeleteTrack ? `${pendingDeleteTrack.title} — ${pendingDeleteTrack.artist}` : undefined}
        deleting={deletingTrack}
        error={deleteError}
        onCancel={() => {
          if (!deletingTrack) {
            setPendingDeleteTrack(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => void handleConfirmPermanentDelete()}
      />
    </div>
  );
};

