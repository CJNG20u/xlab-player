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
import {useVirtualizer} from '@tanstack/react-virtual';
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {useAuth} from '../context/AuthContext';
import {useMainScroll} from '../context/MainScrollContext';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {useOfflineLibrary} from '../hooks/useOfflineLibrary';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {apiFetch, formatDuration} from '../lib/api';
import type {Playlist, Track} from '../types';
import {AlbumArt} from './AlbumArt';
import {ConfirmDeleteModal} from './ConfirmDeleteModal';

const VIRTUALIZATION_THRESHOLD = 100;
const EMPTY_PLAYLISTS: readonly Playlist[] = [];

function formatDisplayTrackTitle(title: string): string {
  const cleaned = title.replace(/^\s*\d{1,3}(?:\.|\)|\s+-)\s+/, '').trim();
  return cleaned || title;
}

interface TrackTableRowProps {
  index: number;
  totalCount: number;
  numericId: number | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
  liked: boolean;
  coverFile: string | null;
  coverUrl: string | undefined;
  dominantColor: string;
  format: string | undefined;
  isActive: boolean;
  isRowPlaying: boolean;
  isMenuOpen: boolean;
  showPlaylistSubmenu: boolean;
  isSelected: boolean;
  isCached: boolean;
  isDownloadingOffline: boolean;
  selectionMode: boolean;
  isTidal: boolean;
  offline: boolean;
  canDeleteTracks: boolean;
  hasArtistClick: boolean;
  hasPlaylistId: boolean;
  isVirtualized: boolean;
  virtualOffsetY: number | undefined;
  menuPlaylists: readonly Playlist[];
  menuRef: React.RefObject<HTMLDivElement | null>;
  measureElement: ((node: Element | null) => void) | undefined;
  onTouchStartRow: (e: React.TouchEvent, numericId: number | null) => void;
  onTouchMoveRow: (e: React.TouchEvent) => void;
  onClearLongPress: () => void;
  onRowClick: (numericId: number | null) => void;
  onRowDoubleClick: (index: number) => void;
  onToggleSelectRow: (numericId: number | null) => void;
  onDesktopPlayToggle: (index: number, isActive: boolean) => void;
  onCoverClick: (
    e: React.MouseEvent,
    index: number,
    numericId: number | null,
    isActive: boolean
  ) => void;
  onTitleClick: (e: React.MouseEvent, index: number, numericId: number | null) => void;
  onArtistClickRow: (artist: string) => void;
  onToggleOfflineRow: (index: number, closeMenu: boolean) => void;
  onToggleLikeRow: (numericId: number | null) => void;
  onToggleMenuRow: (numericId: number | null, isMenuOpen: boolean) => void;
  onPlayNextRow: (index: number) => void;
  onAddToQueueRow: (index: number) => void;
  onStartRadioRow: (index: number) => void;
  onTogglePlaylistSubmenu: () => void;
  onAddToPlaylistRow: (targetPlaylistId: number, numericId: number | null, pName: string) => void;
  onRemoveFromPlaylistRow: (numericId: number | null) => void;
  onRequestDeleteRow: (index: number) => void;
}

const TrackTableRow = React.memo<TrackTableRowProps>(function TrackTableRow({
  index,
  totalCount,
  numericId,
  title,
  artist,
  album,
  duration,
  liked,
  coverFile,
  coverUrl,
  dominantColor,
  format,
  isActive,
  isRowPlaying,
  isMenuOpen,
  showPlaylistSubmenu,
  isSelected,
  isCached,
  isDownloadingOffline,
  selectionMode,
  isTidal,
  offline,
  canDeleteTracks,
  hasArtistClick,
  hasPlaylistId,
  isVirtualized,
  virtualOffsetY,
  menuPlaylists,
  menuRef,
  measureElement,
  onTouchStartRow,
  onTouchMoveRow,
  onClearLongPress,
  onRowClick,
  onRowDoubleClick,
  onToggleSelectRow,
  onDesktopPlayToggle,
  onCoverClick,
  onTitleClick,
  onArtistClickRow,
  onToggleOfflineRow,
  onToggleLikeRow,
  onToggleMenuRow,
  onPlayNextRow,
  onAddToQueueRow,
  onStartRadioRow,
  onTogglePlaylistSubmenu,
  onAddToPlaylistRow,
  onRemoveFromPlaylistRow,
  onRequestDeleteRow,
}) {
  const virtualRowStyle: React.CSSProperties | undefined =
    isVirtualized && virtualOffsetY !== undefined
      ? {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${virtualOffsetY}px)`,
          zIndex: isMenuOpen ? 40 : undefined,
        }
      : undefined;

  return (
    <div
      ref={isVirtualized ? measureElement : undefined}
      data-index={isVirtualized ? index : undefined}
      role="listitem"
      aria-setsize={totalCount}
      aria-posinset={index + 1}
      style={virtualRowStyle}
      className={`group relative grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[40px_minmax(0,1.6fr)_minmax(0,1fr)_124px_40px] items-center gap-3 md:gap-4 rounded-md px-3 md:px-4 py-2.5 transition-colors select-none ${
        isVirtualized && index > 0 ? 'border-t border-[var(--border-subtle)] md:border-t-0' : ''
      } ${
        isSelected
          ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
          : isActive
            ? 'bg-[var(--bg-elevated)]/85'
            : 'hover:bg-[var(--bg-hover)]'
      } ${selectionMode ? 'cursor-pointer' : ''}`}
      onTouchStart={(e) => onTouchStartRow(e, numericId)}
      onTouchMove={onTouchMoveRow}
      onTouchEnd={onClearLongPress}
      onTouchCancel={onClearLongPress}
      onClick={() => onRowClick(numericId)}
      onDoubleClick={() => onRowDoubleClick(index)}
    >
      {/* Index / Play button OR Checkbox (Desktop) */}
      <div className="hidden md:flex items-center justify-center">
        {selectionMode ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelectRow(numericId);
            }}
            className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
              isSelected
                ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]'
                : 'border-[var(--border-strong)] bg-transparent hover:border-[var(--text-primary)]'
            }`}
            aria-label={isSelected ? `Deselect ${title}` : `Select ${title}`}
            aria-pressed={isSelected}
          >
            {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onDesktopPlayToggle(index, isActive)}
            className="flex h-8 w-8 items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            aria-label={isRowPlaying ? 'Pause' : `Play ${title}`}
          >
            <span
              className={`font-mono text-sm tabular-nums group-hover:hidden ${
                isActive ? 'text-[var(--accent)] font-semibold' : ''
              }`}
            >
              {index + 1}
            </span>
            <span className="hidden group-hover:flex items-center justify-center text-[var(--text-primary)]">
              {isRowPlaying ? (
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
              onToggleSelectRow(numericId);
            }}
            className={`md:hidden flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors ${
              isSelected
                ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-contrast)]'
                : 'border-[var(--border-strong)] bg-transparent'
            }`}
            aria-label={isSelected ? `Deselect ${title}` : `Select ${title}`}
            aria-pressed={isSelected}
          >
            {isSelected && <Check className="w-4 h-4 stroke-[3]" />}
          </button>
        )}

        <button
          type="button"
          onClick={(e) => onCoverClick(e, index, numericId, isActive)}
          className="relative shrink-0"
          aria-label={selectionMode ? `Select ${title}` : `Play ${title}`}
        >
          <AlbumArt
            coverFile={coverFile}
            externalUrl={coverUrl}
            alt={title}
            color={dominantColor}
            className="w-11 h-11 md:w-10 md:h-10 rounded"
            iconSize={16}
          />
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={(e) => onTitleClick(e, index, numericId)}
            className={`block max-w-full truncate text-left text-sm font-medium ${
              isActive ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
            }`}
          >
            {formatDisplayTrackTitle(title)}
          </button>
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] truncate">
            {isTidal && format && (
              <span className="shrink-0 rounded border border-[rgba(0,255,255,0.35)] bg-[rgba(0,255,255,0.1)] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-[#00FFFF] leading-none">
                {format.toUpperCase()}
              </span>
            )}
            {hasArtistClick && !selectionMode ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onArtistClickRow(artist);
                }}
                className="truncate hover:text-[var(--text-primary)] hover:underline"
              >
                {artist}
              </button>
            ) : (
              <span className="truncate">{artist}</span>
            )}
          </div>
        </div>
      </div>

      {/* Album (Desktop) */}
      <div className="hidden md:block min-w-0">
        <p className="truncate text-sm text-[var(--text-secondary)]">{album}</p>
      </div>

      {/* Offline Cache + Like + Duration */}
      <div className="flex items-center justify-end gap-1.5 md:gap-2">
        {!selectionMode && (
          <button
            type="button"
            disabled={isDownloadingOffline || (!isCached && offline)}
            onClick={(e) => {
              e.stopPropagation();
              onToggleOfflineRow(index, false);
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
                ? `Downloading ${title} for offline playback`
                : isCached
                  ? `Remove ${title} from offline storage`
                  : `Download ${title} for offline playback`
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
            onClick={(e) => {
              e.stopPropagation();
              onToggleLikeRow(numericId);
            }}
            className={`flex h-9 w-9 md:h-8 md:w-8 items-center justify-center rounded-full transition-colors ${
              liked
                ? 'text-[var(--accent)]'
                : 'text-[var(--text-muted)] md:opacity-0 md:group-hover:opacity-100 hover:text-[var(--text-primary)]'
            }`}
            aria-label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
          >
            <Heart className={`w-4 h-4 ${liked ? 'fill-current' : ''}`} />
          </button>
        )}
        <span className="hidden md:inline font-mono text-xs tabular-nums text-[var(--text-secondary)] w-11 text-right">
          {formatDuration(duration)}
        </span>

        {/* Context menu button on mobile */}
        {!selectionMode && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMenuRow(numericId, isMenuOpen);
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
              onToggleMenuRow(numericId, isMenuOpen);
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
            onClick={() => onPlayNextRow(index)}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <Play className="w-4 h-4 text-[var(--text-secondary)]" />
            Play Next
          </button>
          <button
            type="button"
            onClick={() => onAddToQueueRow(index)}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <ListPlus className="w-4 h-4 text-[var(--text-secondary)]" />
            Add to Queue
          </button>
          {!offline && (
            <button
              type="button"
              onClick={() => onStartRadioRow(index)}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              <Radio className="w-4 h-4 text-[var(--accent)]" />
              Start Radio
            </button>
          )}

          <button
            type="button"
            disabled={isDownloadingOffline || (!isCached && offline)}
            onClick={() => onToggleOfflineRow(index, true)}
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
                onClick={onTogglePlaylistSubmenu}
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
                  {menuPlaylists.length === 0 ? (
                    <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">No playlists yet</p>
                  ) : (
                    menuPlaylists.map((pl) => (
                      <button
                        key={pl.id}
                        type="button"
                        onClick={() => onAddToPlaylistRow(pl.id, numericId, pl.name)}
                        className="block w-full truncate rounded px-2.5 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        {pl.name}
                      </button>
                    ))
                  )}
                </div>
              )}

              {hasPlaylistId && numericId !== null && (
                <button
                  type="button"
                  onClick={() => onRemoveFromPlaylistRow(numericId)}
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
                onClick={() => onRequestDeleteRow(index)}
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
});

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

  const {element: mainScrollElement, getElement: getMainScrollElement} = useMainScroll();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const lastViewportWidthRef = useRef<number>(
    typeof window !== 'undefined' ? window.innerWidth : 0
  );

  const menuRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const touchStartPosRef = useRef<{x: number; y: number} | null>(null);
  const didLongPressRef = useRef(false);

  // Keep latest values in a ref so row event callbacks remain referentially stable for React.memo
  const actionRef = useRef({
    tracks,
    playlistId,
    selectionMode,
    offline,
    offlineSupported,
    cachedTrackIds,
    downloadingTrackIds,
    onToggleSelect,
    onEnterSelectionMode,
    onArtistClick,
    onRemovedFromPlaylist,
    onLikeToggled,
    playTrack,
    togglePlay,
    addToQueue,
    playNextInQueue,
    startRadio,
    toggleLikeTrack,
    bumpLibraryRefresh,
    downloadTrack,
    removeTrack,
  });
  actionRef.current = {
    tracks,
    playlistId,
    selectionMode,
    offline,
    offlineSupported,
    cachedTrackIds,
    downloadingTrackIds,
    onToggleSelect,
    onEnterSelectionMode,
    onArtistClick,
    onRemovedFromPlaylist,
    onLikeToggled,
    playTrack,
    togglePlay,
    addToQueue,
    playNextInQueue,
    startRadio,
    toggleLikeTrack,
    bumpLibraryRefresh,
    downloadTrack,
    removeTrack,
  };

  const isVirtualized = tracks.length > VIRTUALIZATION_THRESHOLD;

  const estimateRowSize = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      return 60;
    }
    return 65;
  }, []);

  const getTrackItemKey = useCallback(
    (index: number) => tracks[index]?.id ?? index,
    [tracks]
  );

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: getMainScrollElement,
    estimateSize: estimateRowSize,
    overscan: 8,
    scrollMargin,
    enabled: isVirtualized,
    getItemKey: getTrackItemKey,
  });

  useLayoutEffect(() => {
    if (!isVirtualized || !mainScrollElement || !listRef.current) {
      setScrollMargin(0);
      return;
    }

    const computeScrollMargin = () => {
      const listEl = listRef.current;
      if (!listEl) return;
      const listRect = listEl.getBoundingClientRect();
      const scrollRect = mainScrollElement.getBoundingClientRect();
      const nextMargin = Math.max(
        0,
        Math.round(listRect.top - scrollRect.top + mainScrollElement.scrollTop)
      );
      setScrollMargin((prev) => (prev === nextMargin ? prev : nextMargin));
    };

    computeScrollMargin();

    const handleResize = () => {
      computeScrollMargin();
      const width = window.innerWidth;
      if (width !== lastViewportWidthRef.current) {
        lastViewportWidthRef.current = width;
        virtualizer.measure();
      }
    };

    window.addEventListener('resize', handleResize);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        computeScrollMargin();
      });
      observer.observe(mainScrollElement);
      if (mainScrollElement.firstElementChild) {
        observer.observe(mainScrollElement.firstElementChild);
      }
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      observer?.disconnect();
    };
  }, [isVirtualized, mainScrollElement, offline, playlistId, selectionMode, tracks.length, virtualizer]);

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

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchStartPosRef.current = null;
  }, []);

  const handleTouchStartRow = useCallback(
    (e: React.TouchEvent, numericId: number | null) => {
      const {selectionMode: sel, onEnterSelectionMode: enterSel} = actionRef.current;
      if (numericId === null || sel || !enterSel || e.touches.length !== 1) return;
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
        actionRef.current.onEnterSelectionMode?.(numericId);
      }, 500);
    },
    [clearLongPress]
  );

  const handleTouchMoveRow = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartPosRef.current || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
      const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
      if (dx > 10 || dy > 10) {
        clearLongPress();
      }
    },
    [clearLongPress]
  );

  const handleRowClick = useCallback((numericId: number | null) => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false;
      return;
    }
    const {selectionMode: sel, onToggleSelect: toggleSel} = actionRef.current;
    if (sel && numericId !== null) {
      toggleSel?.(numericId);
    }
  }, []);

  const handleRowDoubleClick = useCallback((index: number) => {
    const {selectionMode: sel, tracks: list, playTrack: play} = actionRef.current;
    const track = list[index];
    if (!sel && track) {
      play(track, list);
    }
  }, []);

  const handleToggleSelectRow = useCallback((numericId: number | null) => {
    if (numericId !== null) {
      actionRef.current.onToggleSelect?.(numericId);
    }
  }, []);

  const handleDesktopPlayToggle = useCallback((index: number, isActive: boolean) => {
    const {tracks: list, togglePlay: toggle, playTrack: play} = actionRef.current;
    if (isActive) {
      toggle();
    } else {
      const track = list[index];
      if (track) play(track, list);
    }
  }, []);

  const handleCoverClick = useCallback(
    (e: React.MouseEvent, index: number, numericId: number | null, isActive: boolean) => {
      if (didLongPressRef.current) {
        didLongPressRef.current = false;
        e.stopPropagation();
        return;
      }
      const {selectionMode: sel, onToggleSelect: toggleSel, tracks: list, togglePlay: toggle, playTrack: play} =
        actionRef.current;
      if (sel) {
        e.stopPropagation();
        if (numericId !== null) toggleSel?.(numericId);
        return;
      }
      if (isActive) {
        toggle();
      } else {
        const track = list[index];
        if (track) play(track, list);
      }
    },
    []
  );

  const handleTitleClick = useCallback(
    (e: React.MouseEvent, index: number, numericId: number | null) => {
      if (didLongPressRef.current) {
        didLongPressRef.current = false;
        e.stopPropagation();
        return;
      }
      const {selectionMode: sel, onToggleSelect: toggleSel, tracks: list, playTrack: play} =
        actionRef.current;
      if (sel) {
        e.stopPropagation();
        if (numericId !== null) toggleSel?.(numericId);
        return;
      }
      const track = list[index];
      if (track) play(track, list);
    },
    []
  );

  const handleArtistClickRow = useCallback((artist: string) => {
    actionRef.current.onArtistClick?.(artist);
  }, []);

  const handleToggleOfflineRow = useCallback(
    (index: number, closeMenu: boolean) => {
      if (closeMenu) setMenuTrackId(null);
      const {
        tracks: list,
        downloadingTrackIds: dlIds,
        cachedTrackIds: cachedIds,
        offline: isOff,
        offlineSupported: isSupported,
        downloadTrack: dlTrack,
        removeTrack: rmTrack,
      } = actionRef.current;
      const track = list[index];
      if (!track || typeof track.id !== 'number') return;
      const numericId = track.id;
      if (dlIds.has(numericId)) return;

      void (async () => {
        if (cachedIds.has(numericId)) {
          try {
            await rmTrack(numericId);
            flashToast('Removed from offline storage');
          } catch (err) {
            flashToast(err instanceof Error ? err.message : 'Could not remove offline copy');
          }
          return;
        }
        if (isOff) {
          flashToast('Reconnect to download tracks for offline playback');
          return;
        }
        if (!isSupported) {
          flashToast('Offline caching requires HTTPS or localhost');
          return;
        }
        try {
          await dlTrack(track);
          flashToast(`Saved "${track.title}" for offline playback`);
        } catch (err) {
          flashToast(err instanceof Error ? err.message : 'Offline download failed');
        }
      })();
    },
    [flashToast]
  );

  const handleToggleLikeRow = useCallback((numericId: number | null) => {
    if (numericId === null) return;
    void (async () => {
      const res = await actionRef.current.toggleLikeTrack(numericId);
      if (res !== null) actionRef.current.onLikeToggled?.(numericId, res);
    })();
  }, []);

  const handleToggleMenuRow = useCallback((numericId: number | null, isMenuOpen: boolean) => {
    setShowPlaylistSubmenu(false);
    setMenuTrackId(isMenuOpen ? null : numericId);
  }, []);

  const handlePlayNextRow = useCallback(
    (index: number) => {
      const track = actionRef.current.tracks[index];
      if (!track) return;
      actionRef.current.playNextInQueue(track);
      setMenuTrackId(null);
      flashToast('Playing next');
    },
    [flashToast]
  );

  const handleAddToQueueRow = useCallback(
    (index: number) => {
      const track = actionRef.current.tracks[index];
      if (!track) return;
      actionRef.current.addToQueue(track);
      setMenuTrackId(null);
      flashToast('Added to queue');
    },
    [flashToast]
  );

  const handleStartRadioRow = useCallback(
    (index: number) => {
      const track = actionRef.current.tracks[index];
      if (!track) return;
      actionRef.current.startRadio(track);
      setMenuTrackId(null);
      flashToast('Starting radio...');
    },
    [flashToast]
  );

  const handleTogglePlaylistSubmenu = useCallback(() => {
    setShowPlaylistSubmenu((s) => !s);
  }, []);

  const handleAddToPlaylistRow = useCallback(
    (targetPlaylistId: number, numericId: number | null, pName: string) => {
      if (numericId === null) return;
      void (async () => {
        try {
          await apiFetch(`/api/playlists/${targetPlaylistId}/tracks`, {
            method: 'POST',
            body: JSON.stringify({trackId: numericId}),
          });
          actionRef.current.bumpLibraryRefresh();
          flashToast(`Added to ${pName}`);
        } catch (err) {
          flashToast(err instanceof Error ? err.message : 'Failed to add to playlist');
        } finally {
          setMenuTrackId(null);
          setShowPlaylistSubmenu(false);
        }
      })();
    },
    [flashToast]
  );

  const handleRemoveFromPlaylistRow = useCallback(
    (numericId: number | null) => {
      const pid = actionRef.current.playlistId;
      if (!pid || numericId === null) return;
      void (async () => {
        try {
          await apiFetch(`/api/playlists/${pid}/tracks/${numericId}`, {method: 'DELETE'});
          actionRef.current.onRemovedFromPlaylist?.(numericId);
          actionRef.current.bumpLibraryRefresh();
          flashToast('Removed from playlist');
        } catch (err) {
          flashToast(err instanceof Error ? err.message : 'Failed to remove track');
        } finally {
          setMenuTrackId(null);
        }
      })();
    },
    [flashToast]
  );

  const handleRequestDeleteRow = useCallback((index: number) => {
    const track = actionRef.current.tracks[index];
    if (!track) return;
    setMenuTrackId(null);
    setDeleteError(null);
    setPendingDeleteTrack(track);
  }, []);

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

  const hasArtistClick = Boolean(onArtistClick);
  const hasPlaylistId = Boolean(playlistId);
  const effectiveScrollMargin = virtualizer.options.scrollMargin;
  const measureElement = isVirtualized ? virtualizer.measureElement : undefined;

  const renderTrackRow = (track: Track, idx: number, virtualStart?: number) => {
    const numericId = typeof track.id === 'number' ? track.id : null;
    const isActive = currentTrack?.id === track.id;
    const isMenuOpen = numericId !== null && menuTrackId === numericId;
    const isSelected = Boolean(
      selectionMode && numericId !== null && selectedIds?.has(numericId)
    );
    const isCached = numericId !== null && cachedTrackIds.has(numericId);
    const isDownloadingOffline = numericId !== null && downloadingTrackIds.has(numericId);
    const rowShowSubmenu = isMenuOpen && showPlaylistSubmenu;

    return (
      <TrackTableRow
        key={track.id}
        index={idx}
        totalCount={tracks.length}
        numericId={numericId}
        title={track.title}
        artist={track.artist}
        album={track.album}
        duration={track.duration}
        liked={Boolean(track.liked)}
        coverFile={track.cover_file}
        coverUrl={track.coverUrl}
        dominantColor={track.dominant_color}
        format={track.format}
        isActive={isActive}
        isRowPlaying={isActive && isPlaying}
        isMenuOpen={isMenuOpen}
        showPlaylistSubmenu={rowShowSubmenu}
        isSelected={isSelected}
        isCached={isCached}
        isDownloadingOffline={isDownloadingOffline}
        selectionMode={selectionMode}
        isTidal={isTidal}
        offline={offline}
        canDeleteTracks={canDeleteTracks}
        hasArtistClick={hasArtistClick}
        hasPlaylistId={hasPlaylistId}
        isVirtualized={isVirtualized}
        virtualOffsetY={
          virtualStart !== undefined ? virtualStart - effectiveScrollMargin : undefined
        }
        menuPlaylists={rowShowSubmenu ? playlists : EMPTY_PLAYLISTS}
        menuRef={menuRef}
        measureElement={measureElement}
        onTouchStartRow={handleTouchStartRow}
        onTouchMoveRow={handleTouchMoveRow}
        onClearLongPress={clearLongPress}
        onRowClick={handleRowClick}
        onRowDoubleClick={handleRowDoubleClick}
        onToggleSelectRow={handleToggleSelectRow}
        onDesktopPlayToggle={handleDesktopPlayToggle}
        onCoverClick={handleCoverClick}
        onTitleClick={handleTitleClick}
        onArtistClickRow={handleArtistClickRow}
        onToggleOfflineRow={handleToggleOfflineRow}
        onToggleLikeRow={handleToggleLikeRow}
        onToggleMenuRow={handleToggleMenuRow}
        onPlayNextRow={handlePlayNextRow}
        onAddToQueueRow={handleAddToQueueRow}
        onStartRadioRow={handleStartRadioRow}
        onTogglePlaylistSubmenu={handleTogglePlaylistSubmenu}
        onAddToPlaylistRow={handleAddToPlaylistRow}
        onRemoveFromPlaylistRow={handleRemoveFromPlaylistRow}
        onRequestDeleteRow={handleRequestDeleteRow}
      />
    );
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
      {isVirtualized ? (
        <div
          ref={listRef}
          role="list"
          aria-label="Tracks"
          className="relative mt-1"
          style={{height: `${virtualizer.getTotalSize()}px`}}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const track = tracks[virtualRow.index];
            if (!track) return null;
            return renderTrackRow(track, virtualRow.index, virtualRow.start);
          })}
        </div>
      ) : (
        <div
          ref={listRef}
          role="list"
          aria-label="Tracks"
          className="divide-y divide-[var(--border-subtle)] md:divide-y-0 mt-1"
        >
          {tracks.map((track, idx) => renderTrackRow(track, idx))}
        </div>
      )}

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

