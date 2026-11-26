import {
  Check,
  Download,
  Heart,
  Home,
  Library,
  ListMusic,
  Loader2,
  LogOut,
  Maximize2,
  Mic2,
  MonitorSpeaker,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import React, {Suspense, useCallback, useEffect, useState} from 'react';
import {NavLink, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {useAuth} from '../context/AuthContext';
import {DesktopLayoutProvider, useDesktopLayout} from '../context/DesktopLayoutContext';
import {MainScrollProvider} from '../context/MainScrollContext';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {useDesktopKeyboardShortcuts} from '../hooks/useDesktopKeyboardShortcuts';
import {useLayoutMode} from '../hooks/useLayoutMode';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {usePWAInstall} from '../hooks/usePWAInstall';
import {useRemoteHost} from '../hooks/useRemoteHost';
import {useSwipeTrackGesture} from '../hooks/useSwipeTrackGesture';
import {apiFetch, formatDuration} from '../lib/api';
import {getTime as getPlaybackTime, usePlaybackTime} from '../lib/playbackClock';
import {useYouTubePlaylistJobsSync} from '../lib/playlistJobs';
import {useRemoteControl} from '../lib/remoteControl';
import {useMainScrollRestoration} from '../lib/scrollHistory';
import {getTabGroup, openPrimaryDestination, rememberTabLocation} from '../lib/tabMemory';
import {getUnifiedPageHeaderTopHex, useStatusBarColor} from '../lib/themeColor';
import type {Playlist, RepeatMode} from '../types';
import {getOfflinePlaylists, subscribeOfflineStore} from '../utils/offlineStore';
import {AlbumArt} from './AlbumArt';
import {BrandLogo} from './BrandLogo';
import {CreatePlaylistModal} from './CreatePlaylistModal';
import {DeviceSheet} from './DeviceSheet';
import {QueueDrawer} from './QueueDrawer';

const MainScrollRestorationSync: React.FC = () => {
  useMainScrollRestoration();
  return null;
};

interface DesktopPlaybackScrubberProps {
  isRemoteActive: boolean;
  remoteTime: number;
  duration: number;
  disabled: boolean;
  onSeek: (pos: number) => void;
}

const DesktopPlaybackScrubber: React.FC<DesktopPlaybackScrubberProps> = React.memo(
  ({isRemoteActive, remoteTime, duration, disabled, onSeek}) => {
    const localTime = usePlaybackTime();
    const displayTime = isRemoteActive ? remoteTime : localTime;
    const progressPct = duration > 0 ? Math.min(100, (displayTime / duration) * 100) : 0;

    return (
      <div className="xlab-slider-group flex w-full max-w-xl items-center gap-2.5">
        <span className="font-mono text-[11px] tabular-nums text-[var(--text-secondary)] w-10 text-right">
          {formatDuration(displayTime)}
        </span>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(displayTime, duration || 1)}
          disabled={disabled}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          className="xlab-slider flex-1 h-1"
          style={{
            background: `linear-gradient(to right, var(--accent) ${progressPct}%, var(--slider-track) ${progressPct}%)`,
            borderRadius: '9999px',
          }}
          aria-label="Seek progress"
        />
        <span className="font-mono text-[11px] tabular-nums text-[var(--text-secondary)] w-10">
          {formatDuration(duration)}
        </span>
      </div>
    );
  }
);

interface MobileMiniProgressBarProps {
  isRemoteActive: boolean;
  remoteTime: number;
  duration: number;
}

const MobileMiniProgressBar: React.FC<MobileMiniProgressBarProps> = React.memo(
  ({isRemoteActive, remoteTime, duration}) => {
    const localTime = usePlaybackTime();
    const displayTime = isRemoteActive ? remoteTime : localTime;
    const progressPct = duration > 0 ? Math.min(100, (displayTime / duration) * 100) : 0;

    return (
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--miniplayer-progress-track)]">
        <div
          className="h-full bg-[var(--accent)] transition-[width] duration-150"
          style={{width: `${progressPct}%`}}
        />
      </div>
    );
  }
);

const DesktopFullWidthProgressBar: React.FC<DesktopPlaybackScrubberProps> = React.memo(
  ({isRemoteActive, remoteTime, duration, disabled, onSeek}) => {
    const localTime = usePlaybackTime();
    const displayTime = isRemoteActive ? remoteTime : localTime;
    const progressPct = duration > 0 ? Math.min(100, (displayTime / duration) * 100) : 0;

    return (
      <div className="xlab-desktop-scrubber-group relative w-full h-4 -mt-2 flex items-center group">
        {/* Visual full-width track: 3px at rest, 6px on hover/focus */}
        <div className="relative w-full h-[3px] group-hover:h-[6px] group-focus-within:h-[6px] bg-[var(--slider-track)] transition-[height] duration-150">
          <div
            className="h-full bg-[var(--accent)]"
            style={{width: `${progressPct}%`}}
          />
          {!disabled && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full bg-[var(--slider-thumb)] shadow-[0_2px_8px_rgba(0,0,0,0.45),0_0_0_3px_var(--accent-soft)] transition-transform duration-150 group-hover:scale-125 group-active:scale-135 group-focus-within:scale-125 group-focus-within:ring-2 group-focus-within:ring-[var(--focus-ring)]"
              style={{left: `${progressPct}%`}}
            />
          )}
        </div>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(displayTime, duration || 1)}
          disabled={disabled}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default"
          aria-label="Seek progress"
        />
      </div>
    );
  }
);

interface DesktopTimeReadoutProps {
  isRemoteActive: boolean;
  remoteTime: number;
  duration: number;
}

const DesktopTimeReadout: React.FC<DesktopTimeReadoutProps> = React.memo(
  ({isRemoteActive, remoteTime, duration}) => {
    const localTime = usePlaybackTime();
    const displayTime = isRemoteActive ? remoteTime : localTime;

    return (
      <span className="font-mono text-[clamp(0.8125rem,0.72rem_+_0.18vw,0.9375rem)] font-medium tabular-nums text-[var(--text-secondary)] whitespace-nowrap select-none">
        {formatDuration(displayTime)} / {formatDuration(duration)}
      </span>
    );
  }
);

const RouteLoadingFallback: React.FC = () => (
  <div className="flex h-full min-h-[60vh] w-full items-center justify-center">
    <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
  </div>
);

const AppShellInner: React.FC = () => {
  const isDesktop = useLayoutMode() === 'desktop';
  const {
    desktopLyricsVisible,
    setDesktopLyricsVisible,
    toggleDesktopLyrics,
    sidebarCollapsed,
    toggleSidebar,
    requestFocusQueue,
  } = useDesktopLayout();
  const isSidebarCollapsed = isDesktop && sidebarCollapsed;
  const {user, isOfflineMode, logout} = useAuth();
  const {theme, baseThemeColor} = useTheme();
  const {
    currentTrack,
    isPlaying,
    duration,
    volume,
    isMuted,
    shuffle,
    repeat,
    queueOpen,
    setQueueOpen,
    setLyricsOpen,
    togglePlay,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    toggleLikeTrack,
    libraryRefreshVersion,
    bumpLibraryRefresh,
    saveYouTubeTrackToLibrary,
    getYouTubeSaveStatus,
    remoteHostApi,
  } = usePlayer();

  // Keep SSE device presence, command execution, and local state publishing active across all routes
  useRemoteHost();
  const remote = useRemoteControl();
  const onlineOtherDeviceCount = remote.otherDevices.filter((d) => d.online).length;

  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const canDownload = Boolean(user?.can_download || user?.role === 'admin');
  const [shellToast, setShellToast] = useState<string | null>(null);
  const flashShellToast = useCallback((msg: string) => {
    setShellToast(msg);
    setTimeout(() => setShellToast(null), 3200);
  }, []);

  useEffect(() => {
    const onAppToast = (ev: Event) => {
      const msg = (ev as CustomEvent<unknown>).detail;
      if (typeof msg === 'string' && msg.trim()) {
        flashShellToast(msg);
      }
    };
    window.addEventListener('xlab:toast', onAppToast);
    return () => window.removeEventListener('xlab:toast', onAppToast);
  }, [flashShellToast]);

  useYouTubePlaylistJobsSync(!offline && Boolean(user), {
    onProgress: bumpLibraryRefresh,
    onComplete: (job) => {
      bumpLibraryRefresh();
      if (job.state === 'completed') {
        flashShellToast(
          job.failed > 0
            ? `Downloaded "${job.playlistName}" (${job.done}/${job.total}, ${job.failed} failed)`
            : `Downloaded "${job.playlistName}" (${job.done}/${job.total} tracks)`
        );
      } else if (job.state === 'failed') {
        flashShellToast(`Playlist download failed for "${job.playlistName}"`);
      }
    },
  });
  const {isInstallable, isInstalled, install} = usePWAInstall();
  const navigate = useNavigate();
  const location = useLocation();
  const [mainElement, setMainElement] = useState<HTMLElement | null>(null);
  const handleMainRef = useCallback((node: HTMLElement | null) => {
    setMainElement(node);
  }, []);

  // Effective transport state & handlers: route to remote target when selected (never starting local audio)
  const displayTrack = remote.isRemoteActive
    ? remote.targetState?.track
      ? {
          id: remote.targetState.track.id,
          title: remote.targetState.track.title,
          artist: remote.targetState.track.artist,
          album: remote.targetState.track.album,
          cover_file: remote.targetState.track.cover_file ?? null,
          coverUrl: remote.targetState.track.cover ?? undefined,
          dominant_color: remote.targetState.track.dominant_color || '#1c3b29',
          isYouTubeStream: Boolean(
            remote.targetState.track.isYouTubeStream || remote.targetState.track.videoId
          ),
          liked: false,
          duration: remote.targetState.track.duration || 0,
        }
      : null
    : currentTrack;

  const displayIsPlaying = remote.isRemoteActive
    ? Boolean(remote.targetState?.isPlaying)
    : isPlaying;
  const displayDuration = remote.isRemoteActive
    ? remote.targetState?.track?.duration || 0
    : duration;
  const displayVolume = remote.isRemoteActive ? (remote.targetState?.volume ?? 1) : volume;
  const displayMuted = remote.isRemoteActive ? Boolean(remote.targetState?.muted) : isMuted;
  const displayShuffle = remote.isRemoteActive ? Boolean(remote.targetState?.shuffle) : shuffle;
  const displayRepeat: RepeatMode = remote.isRemoteActive
    ? (remote.targetState?.repeat ?? 'off')
    : repeat;

  const handleTogglePlay = useCallback(() => {
    if (remote.isRemoteActive) {
      void remote.send('toggle');
      return;
    }
    togglePlay();
  }, [remote, togglePlay]);

  const handleNextTrack = useCallback(() => {
    if (remote.isRemoteActive) {
      void remote.send('next');
      return;
    }
    nextTrack();
  }, [nextTrack, remote]);

  const handlePrevTrack = useCallback(() => {
    if (remote.isRemoteActive) {
      void remote.send('prev');
      return;
    }
    prevTrack();
  }, [prevTrack, remote]);

  const handleSeek = useCallback(
    (pos: number) => {
      if (remote.isRemoteActive) {
        void remote.send('seek', {positionSec: pos});
        return;
      }
      seek(pos);
    },
    [remote, seek]
  );

  const handleSetVolume = useCallback(
    (vol: number) => {
      if (remote.isRemoteActive) {
        void remote.send('setVolume', {volume: vol});
        return;
      }
      setVolume(vol);
    },
    [remote, setVolume]
  );

  const handleToggleMute = useCallback(() => {
    if (remote.isRemoteActive) {
      void remote.send('mute', {muted: !displayMuted});
      return;
    }
    toggleMute();
  }, [displayMuted, remote, toggleMute]);

  const handleToggleShuffle = useCallback(() => {
    if (remote.isRemoteActive) {
      void remote.send('shuffle', {shuffle: !displayShuffle});
      return;
    }
    toggleShuffle();
  }, [displayShuffle, remote, toggleShuffle]);

  const handleCycleRepeat = useCallback(() => {
    if (remote.isRemoteActive) {
      const nextMode: RepeatMode =
        displayRepeat === 'off' ? 'all' : displayRepeat === 'all' ? 'one' : 'off';
      void remote.send('repeat', {repeat: nextMode});
      return;
    }
    cycleRepeat();
  }, [cycleRepeat, displayRepeat, remote]);

  const miniPlayerSwipe = useSwipeTrackGesture({
    onSwipeNext: handleNextTrack,
    onSwipePrev: handlePrevTrack,
    threshold: 75,
    deadZone: 10,
    velocityThreshold: 0.55,
    rotationFactor: 0,
    slideDistance: 240,
  });

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  const loadPlaylists = useCallback(async () => {
    if (offline) {
      const cached = await getOfflinePlaylists();
      setPlaylists(cached);
      return;
    }
    try {
      const res = await apiFetch<{playlists: Playlist[]}>('/api/playlists');
      setPlaylists(res.playlists || []);
    } catch {
      const cached = await getOfflinePlaylists();
      setPlaylists(cached);
    }
  }, [offline]);

  useEffect(() => {
    void loadPlaylists();
  }, [loadPlaylists, libraryRefreshVersion]);

  useEffect(() => {
    if (!offline) return;
    return subscribeOfflineStore(() => {
      void loadPlaylists();
    });
  }, [offline, loadPlaylists]);

  const volPct = (displayMuted ? 0 : displayVolume) * 100;
  const isNowPlayingPage = location.pathname === '/now-playing';
  const isHomePage = location.pathname === '/';
  const isLibraryRoute =
    location.pathname === '/library' || location.pathname.startsWith('/library/');
  const hasOwnBottomClearance =
    isHomePage || isLibraryRoute || location.pathname.startsWith('/playlists');
  const stageTint = displayTrack?.dominant_color || '#1c3b29';
  const isCurrentYouTube = Boolean(displayTrack?.isYouTubeStream);
  const currentYtSaveStatus =
    !remote.isRemoteActive && currentTrack && isCurrentYouTube
      ? getYouTubeSaveStatus(currentTrack.id)
      : 'idle';

  const handleSaveCurrentYouTube = useCallback(async () => {
    if (!currentTrack || !currentTrack.isYouTubeStream) return;
    const res = await saveYouTubeTrackToLibrary(currentTrack);
    flashShellToast(res.message);
  }, [currentTrack, flashShellToast, saveYouTubeTrackToLibrary]);

  const isDynamicHeroLibraryRoute =
    location.pathname === '/library/songs' ||
    location.pathname === '/library/liked' ||
    location.pathname === '/library/downloaded' ||
    location.pathname === '/library/cached' ||
    location.pathname === '/library/playlists' ||
    (location.pathname === '/library' && (isDesktop || (offline && playlists.length === 0)));
  const usesUnifiedHeader = !isNowPlayingPage && !isDynamicHeroLibraryRoute;
  const unifiedHeaderTopHex = getUnifiedPageHeaderTopHex(theme);
  const unifiedHeaderGradient = `linear-gradient(180deg, ${unifiedHeaderTopHex} 0%, ${baseThemeColor} 240px, ${baseThemeColor} 100%)`;

  // Claim mobile status bar color to match the exact first color stop of the unified header gradient.
  useStatusBarColor(unifiedHeaderTopHex, usesUnifiedHeader);

  useEffect(() => {
    rememberTabLocation(location.pathname, location.search);
  }, [location.pathname, location.search]);

  // Ensure mobile Queue drawer is closed if the window transitions live into desktop mode
  useEffect(() => {
    if (isDesktop && queueOpen) {
      setQueueOpen(false);
    }
  }, [isDesktop, queueOpen, setQueueOpen]);

  const handleDesktopToggleLyrics = useCallback(() => {
    if (isNowPlayingPage) {
      toggleDesktopLyrics();
    } else {
      setDesktopLyricsVisible(true);
      navigate('/now-playing');
    }
  }, [isNowPlayingPage, navigate, setDesktopLyricsVisible, toggleDesktopLyrics]);

  const handleDesktopFocusQueue = useCallback(() => {
    if (!isNowPlayingPage) {
      navigate('/now-playing');
    }
    requestFocusQueue();
  }, [isNowPlayingPage, navigate, requestFocusQueue]);

  useDesktopKeyboardShortcuts({
    enabled: isDesktop,
    hasTrack: Boolean(displayTrack),
    getCurrentTime: () =>
      remote.isRemoteActive ? remote.extrapolatedPositionSec : getPlaybackTime(),
    duration: displayDuration,
    volume: displayVolume,
    isMuted: displayMuted,
    onTogglePlay: handleTogglePlay,
    onSeek: handleSeek,
    onPrevTrack: handlePrevTrack,
    onNextTrack: handleNextTrack,
    onSetVolume: handleSetVolume,
    onToggleMute: handleToggleMute,
    onToggleLyrics: handleDesktopToggleLyrics,
    onFocusQueue: handleDesktopFocusQueue,
    onToggleSidebar: toggleSidebar,
  });

  const handlePrimaryNavClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      const isSelected = getTabGroup(location.pathname) === href;
      openPrimaryDestination(navigate, href, isSelected, location, mainElement);
    },
    [location, mainElement, navigate]
  );

  const handleToggleNowPlaying = useCallback(() => {
    if (isNowPlayingPage) {
      if (typeof window !== 'undefined' && window.history.length > 1) {
        navigate(-1);
      } else {
        navigate('/');
      }
    } else {
      navigate('/now-playing');
    }
  }, [isNowPlayingPage, navigate]);

  const activeTabGroup = getTabGroup(location.pathname);

  const navItems = [
    {to: '/', label: 'Home', icon: Home, end: true},
    {to: '/library', label: 'Library', icon: Library, end: false},
    {to: '/settings', label: 'Settings', icon: Settings, end: false},
  ];

  const miniPlayerSurfaceStyle = {
    '--stage-tint': stageTint,
    touchAction: 'pan-y',
  } as React.CSSProperties;

  const miniPlayerClassName =
    'md:hidden fixed left-[var(--miniplayer-inset)] right-[var(--miniplayer-inset)] bottom-above-nav z-30 h-[64px] rounded-[var(--miniplayer-radius)] [background:var(--miniplayer-bg)] border border-[var(--miniplayer-border)] shadow-[var(--miniplayer-shadow)] overflow-hidden select-none mobile-mini-player-glass';

  const bottomNavClassName =
    'md:hidden fixed bottom-0 left-0 right-0 z-30 pb-safe bg-[var(--mobile-tab-bar-bg)] border-t border-[var(--mobile-tab-bar-border)]';

  return (
    <MainScrollProvider element={mainElement}>
      <MainScrollRestorationSync />
      <div className="fixed inset-0 flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Main Area: Sidebar (Desktop) + Scrollable Stage */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop Left Sidebar (240px expanded, 64px slim icon rail when collapsed on desktop only) */}
        <aside
          aria-label="Primary navigation"
          className={`hidden md:flex shrink-0 flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none ${
            isSidebarCollapsed ? 'w-[64px]' : 'w-[240px]'
          }`}
        >
          {/* Logo + Desktop-only Sidebar Toggle */}
          {isSidebarCollapsed ? (
            <div className="flex flex-col items-center gap-2.5 pt-5 pb-4 px-2 shrink-0">
              <button
                type="button"
                onClick={() => navigate('/')}
                className="flex items-center justify-center rounded-md focus:outline-none cursor-pointer"
                title="xlabplayer"
                aria-label="xlabplayer Home"
              >
                <BrandLogo size="md" showWordmark={false} />
              </button>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-expanded={false}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 px-5 pt-6 pb-5 shrink-0">
              <button
                type="button"
                onClick={() => navigate('/')}
                className="text-left focus:outline-none cursor-pointer min-w-0"
              >
                <BrandLogo size="md" />
              </button>
              {isDesktop && (
                <button
                  type="button"
                  onClick={toggleSidebar}
                  aria-expanded={true}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
                >
                  <PanelLeftClose className="w-4 h-4" />
                </button>
              )}
            </div>
          )}

          {/* Primary Navigation */}
          <nav className={isSidebarCollapsed ? 'px-2 space-y-1.5 flex flex-col items-center' : 'px-3 space-y-1'}>
            {navItems.map((item) => {
              const Icon = item.icon;
              const isSelected = activeTabGroup === item.to;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={(e) => handlePrimaryNavClick(e, item.to)}
                  title={isSidebarCollapsed ? item.label : undefined}
                  aria-label={isSidebarCollapsed ? item.label : undefined}
                  aria-current={isSelected ? 'page' : undefined}
                  className={() =>
                    isSidebarCollapsed
                      ? `flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
                          isSelected
                            ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                        }`
                      : `flex items-center gap-3.5 rounded-md px-3 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                          isSelected
                            ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                        }`
                  }
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  {!isSidebarCollapsed && <span>{item.label}</span>}
                </NavLink>
              );
            })}
          </nav>

          {/* Quick Playlist List / Collapsed Playlist Square Tiles */}
          {isSidebarCollapsed ? (
            <div className="mt-4 flex flex-1 min-h-0 flex-col items-center border-t border-[var(--border-subtle)] pt-3 px-2 gap-2">
              {!offline && (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  title="Create playlist"
                  aria-label="Create playlist"
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
              <div className="flex-1 w-full overflow-y-auto flex flex-col items-center gap-2 pb-2">
                {playlists.map((pl) => {
                  const firstCover = pl.covers?.find(Boolean) || null;
                  const initial = (pl.name.trim()[0] || '?').toUpperCase();
                  return (
                    <NavLink
                      key={pl.id}
                      to={`/playlists/${pl.id}`}
                      title={pl.name}
                      aria-label={pl.name}
                      className={({isActive}) =>
                        `relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md overflow-hidden transition-all ${
                          isActive
                            ? 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg-sidebar)]'
                            : 'opacity-85 hover:opacity-100 hover:ring-1 hover:ring-[var(--border-strong)]'
                        }`
                      }
                    >
                      {firstCover ? (
                        <AlbumArt
                          coverFile={firstCover}
                          alt={pl.name}
                          className="h-full w-full rounded-md"
                          iconSize={15}
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center bg-[var(--bg-elevated)] text-xs font-bold text-[var(--text-primary)] select-none">
                          {initial}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-6 flex flex-1 min-h-0 flex-col border-t border-[var(--border-subtle)] pt-4 px-3">
              <div className="flex items-center justify-between px-3 mb-2">
                <NavLink
                  to="/library/playlists"
                  className={({isActive}) =>
                    `text-xs font-semibold whitespace-nowrap transition-colors ${
                      isActive
                        ? 'text-[var(--accent)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`
                  }
                >
                  {offline ? 'Offline Playlists' : 'Playlists'}
                </NavLink>
                {!offline && (
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                    title="Create playlist"
                    aria-label="Create playlist"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
                {playlists.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-[var(--text-muted)]">
                    {offline ? 'No offline playlists cached' : 'No playlists yet'}
                  </p>
                ) : (
                  playlists.map((pl) => (
                    <NavLink
                      key={pl.id}
                      to={`/playlists/${pl.id}`}
                      className={({isActive}) =>
                        `flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                          isActive
                            ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                        }`
                      }
                    >
                      <span className="truncate">{pl.name}</span>
                      <span className="font-mono text-xs tabular-nums text-[var(--text-muted)] ml-2">
                        {pl.track_count}
                      </span>
                    </NavLink>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Sidebar Footer: PWA Install (if available) + User */}
          {isSidebarCollapsed ? (
            <div className="border-t border-[var(--border-subtle)] py-3 px-2 flex flex-col items-center gap-2 shrink-0">
              {isInstallable && !isInstalled && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--accent)] hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer"
                  title="Install xlabplayer App"
                  aria-label="Install xlabplayer App"
                >
                  <Download className="w-4 h-4" />
                </button>
              )}
              <div
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-xs font-bold uppercase text-[var(--text-primary)] select-none"
                title={user ? `${user.username} (${user.role})` : 'Account'}
                aria-label={user ? `${user.username} (${user.role})` : 'Account'}
              >
                {(user?.username?.trim()[0] || '?').toUpperCase()}
              </div>
              <button
                type="button"
                onClick={() => void logout()}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="border-t border-[var(--border-subtle)] p-3 space-y-2 shrink-0">
              {isInstallable && !isInstalled && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5 text-[var(--accent)]" />
                  Install xlabplayer App
                </button>
              )}
              <div className="flex items-center justify-between rounded-md px-2.5 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">{user?.username}</p>
                  <p className="text-xs text-[var(--text-muted)] capitalize">{user?.role}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </aside>

        {/* Main Scrollable Viewport */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-[var(--bg-primary)] relative">
          {/* Unified Full-Bleed Top-to-Bottom Header Gradient Backdrop (starts flush at y=0 behind status bar) */}
          <main
            ref={handleMainRef}
            className={`flex-1 relative ${
              isDesktop && isNowPlayingPage ? 'overflow-hidden' : 'overflow-y-auto'
            }`}
            style={{
              backgroundColor: 'var(--bg-primary)',
              backgroundImage: usesUnifiedHeader ? unifiedHeaderGradient : undefined,
              backgroundRepeat: 'no-repeat',
            }}
          >
            <div
              className={
                isNowPlayingPage
                  ? 'h-full'
                  : hasOwnBottomClearance
                    ? ''
                    : 'pb-mobile-stage md:pb-8'
              }
            >
              <Suspense fallback={<RouteLoadingFallback />}>
                <Outlet />
              </Suspense>
            </div>
          </main>
        </div>
      </div>

      {/* Bottom Playback Bar: Desktop gets full-width edge progress bar & no Queue button; non-desktop (incl. 768px touch) stays identical */}
      {isDesktop ? (
        <footer className="flex flex-col shrink-0 border-t border-[var(--border-subtle)] bg-[var(--footer-bg)] backdrop-blur-xl z-30">
          <DesktopFullWidthProgressBar
            isRemoteActive={remote.isRemoteActive}
            remoteTime={remote.extrapolatedPositionSec}
            duration={displayDuration}
            disabled={!displayTrack}
            onSeek={handleSeek}
          />
          <div className="grid h-[clamp(80px,5.2vw,96px)] grid-cols-[minmax(240px,1fr)_auto_minmax(240px,1fr)] items-center gap-4 px-[clamp(1.25rem,1.6vw,2rem)]">
            {/* Left: Mini Cover + Title + Artist + Heart/Save */}
            <div className="flex items-center gap-3.5 min-w-0">
              {displayTrack ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate('/now-playing')}
                    className="shrink-0 group relative cursor-pointer"
                    aria-label="Open Now Playing"
                  >
                    <AlbumArt
                      coverFile={displayTrack.cover_file}
                      externalUrl={displayTrack.coverUrl}
                      alt={displayTrack.title}
                      color={displayTrack.dominant_color}
                      className="w-[clamp(3.25rem,2.9rem_+_0.5vw,3.75rem)] h-[clamp(3.25rem,2.9rem_+_0.5vw,3.75rem)] rounded-md shadow-md transition-transform group-hover:scale-[1.03]"
                      iconSize={22}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => navigate('/now-playing')}
                      className="block max-w-full truncate text-[clamp(0.875rem,0.74rem_+_0.22vw,1.0625rem)] font-semibold text-[var(--text-primary)] hover:underline text-left cursor-pointer leading-snug"
                    >
                      {displayTrack.title}
                    </button>
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isCurrentYouTube || remote.isRemoteActive ? (
                        <span className="truncate text-[clamp(0.75rem,0.65rem_+_0.18vw,0.9375rem)] text-[var(--text-secondary)]">
                          {displayTrack.artist}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            navigate(`/library/songs?artist=${encodeURIComponent(displayTrack.artist)}`)
                          }
                          className="block max-w-full truncate text-[clamp(0.75rem,0.65rem_+_0.18vw,0.9375rem)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline text-left cursor-pointer"
                        >
                          {displayTrack.artist}
                        </button>
                      )}
                      {remote.isRemoteActive && remote.targetDevice ? (
                        <span className="shrink-0 rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-semibold tracking-wide leading-none text-[var(--accent)] truncate max-w-[110px]">
                          {remote.targetDevice.name}
                        </span>
                      ) : isCurrentYouTube ? (
                        <span className="shrink-0 rounded border border-[var(--badge-source-border)] bg-[var(--badge-source-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none text-[var(--badge-source-text)]">
                          Web
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {!remote.isRemoteActive && currentTrack ? (
                    isCurrentYouTube ? (
                      canDownload && !offline ? (
                        <button
                          type="button"
                          disabled={currentYtSaveStatus === 'saving'}
                          onClick={() => void handleSaveCurrentYouTube()}
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors cursor-pointer ${
                            currentYtSaveStatus === 'saved'
                              ? 'text-[var(--accent)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
                          }`}
                          title={
                            currentYtSaveStatus === 'saved'
                              ? 'Queued for library download'
                              : 'Save to Library'
                          }
                          aria-label="Save to Library"
                        >
                          {currentYtSaveStatus === 'saving' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : currentYtSaveStatus === 'saved' ? (
                            <Check className="w-4 h-4 stroke-[2.5]" />
                          ) : (
                            <Plus className="w-4 h-4 stroke-[2.5]" />
                          )}
                        </button>
                      ) : null
                    ) : (
                      <button
                        type="button"
                        onClick={() => void toggleLikeTrack(currentTrack.id)}
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer ${
                          currentTrack.liked
                            ? 'text-[var(--accent)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                        aria-label={currentTrack.liked ? 'Unlike track' : 'Like track'}
                      >
                        <Heart className={`w-4 h-4 ${currentTrack.liked ? 'fill-current' : ''}`} />
                      </button>
                    )
                  ) : null}
                </>
              ) : (
                <div className="flex items-center gap-3 text-[var(--text-muted)]">
                  <div className="h-13 w-13 rounded-md bg-[var(--bg-elevated)] flex items-center justify-center">
                    <ListMusic className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-secondary)] truncate">
                      {remote.isRemoteActive && remote.targetDevice
                        ? `${remote.targetDevice.name} · Idle`
                        : 'Not playing'}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {remote.isRemoteActive ? 'Remote control active' : 'Select a track to begin'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Center: Transport Controls + Elapsed / Total Readout */}
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={handleToggleShuffle}
                  className={`relative p-2 rounded-full hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer ${
                    displayShuffle
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title="Shuffle"
                  aria-label="Shuffle"
                >
                  <Shuffle className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handlePrevTrack}
                  disabled={!displayTrack}
                  className="p-2 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors cursor-pointer"
                  title="Previous track (Shift+Left)"
                  aria-label="Previous track"
                >
                  <SkipBack className="w-5 h-5 fill-current" />
                </button>
                <button
                  type="button"
                  onClick={handleTogglePlay}
                  disabled={!displayTrack}
                  className={`flex h-10 w-10 items-center justify-center rounded-full bg-[var(--btn-contrast-bg)] text-[var(--btn-contrast-text)] hover:scale-105 active:scale-95 disabled:opacity-40 transition-transform cursor-pointer ${
                    remote.isPending ? 'opacity-70' : ''
                  }`}
                  title={displayIsPlaying ? 'Pause (Space)' : 'Play (Space)'}
                  aria-label={displayIsPlaying ? 'Pause' : 'Play'}
                >
                  {displayIsPlaying ? (
                    <Pause className="w-4 h-4 fill-current" />
                  ) : (
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleNextTrack}
                  disabled={!displayTrack}
                  className="p-2 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors cursor-pointer"
                  title="Next track (Shift+Right)"
                  aria-label="Next track"
                >
                  <SkipForward className="w-5 h-5 fill-current" />
                </button>
                <button
                  type="button"
                  onClick={handleCycleRepeat}
                  className={`p-2 rounded-full hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer ${
                    displayRepeat !== 'off'
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title={`Repeat: ${displayRepeat}`}
                  aria-label={`Repeat: ${displayRepeat}`}
                >
                  {displayRepeat === 'one' ? (
                    <Repeat1 className="w-4 h-4" />
                  ) : (
                    <Repeat className="w-4 h-4" />
                  )}
                </button>
              </div>
              <DesktopTimeReadout
                isRemoteActive={remote.isRemoteActive}
                remoteTime={remote.extrapolatedPositionSec}
                duration={displayDuration}
              />
            </div>

            {/* Right: Lyrics + Devices + Volume + Expand (Queue button hidden on desktop) */}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleDesktopToggleLyrics}
                disabled={!displayTrack}
                className={`p-2 rounded-full hover:bg-[var(--bg-elevated)] disabled:opacity-30 transition-colors cursor-pointer ${
                  isNowPlayingPage && desktopLyricsVisible
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title="Toggle Lyrics (L)"
                aria-label="Toggle Lyrics"
              >
                <Mic2 className="w-4 h-4" />
              </button>
              {!offline && (
                <button
                  type="button"
                  onClick={() => remote.setDeviceSheetOpen(true)}
                  className={`relative p-2 rounded-full hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer ${
                    remote.isRemoteActive
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title={
                    remote.isRemoteActive && remote.targetDevice
                      ? `Controlling ${remote.targetDevice.name}`
                      : 'Devices'
                  }
                  aria-label="Devices"
                >
                  <MonitorSpeaker className="w-4 h-4" />
                  {(remote.isRemoteActive || onlineOtherDeviceCount > 0) && (
                    <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                  )}
                </button>
              )}

              <div className="xlab-slider-group flex items-center gap-2 w-28">
                <button
                  type="button"
                  onClick={handleToggleMute}
                  className="p-1.5 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  title={displayMuted ? 'Unmute (M)' : 'Mute (M)'}
                  aria-label={displayMuted ? 'Unmute' : 'Mute'}
                >
                  {displayMuted || displayVolume === 0 ? (
                    <VolumeX className="w-4 h-4" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={displayMuted ? 0 : displayVolume}
                  onChange={(e) => handleSetVolume(parseFloat(e.target.value))}
                  className="xlab-slider flex-1 h-1"
                  style={{
                    background: `linear-gradient(to right, var(--accent) ${volPct}%, var(--slider-track) ${volPct}%)`,
                    borderRadius: '9999px',
                  }}
                  aria-label="Volume"
                />
              </div>

              <button
                type="button"
                onClick={handleToggleNowPlaying}
                className={`p-2 rounded-full hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer ${
                  isNowPlayingPage
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title={isNowPlayingPage ? 'Close Now Playing' : 'Expand Now Playing'}
                aria-label={isNowPlayingPage ? 'Close Now Playing' : 'Expand Now Playing'}
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </footer>
      ) : (
        <footer className="hidden md:grid h-[90px] shrink-0 grid-cols-[minmax(220px,1fr)_minmax(340px,1.5fr)_minmax(240px,1fr)] items-center gap-4 border-t border-[var(--border-subtle)] bg-[var(--footer-bg)] backdrop-blur-xl px-4 z-30">
        {/* Left: Mini Cover + Title + Artist + Heart */}
        <div className="flex items-center gap-3.5 min-w-0">
          {displayTrack ? (
            <>
              <button
                type="button"
                onClick={() => navigate('/now-playing')}
                className="shrink-0 group relative"
                aria-label="Open Now Playing"
              >
                <AlbumArt
                  coverFile={displayTrack.cover_file}
                  externalUrl={displayTrack.coverUrl}
                  alt={displayTrack.title}
                  color={displayTrack.dominant_color}
                  className="w-14 h-14 rounded-md shadow-md"
                  iconSize={22}
                />
              </button>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => navigate('/now-playing')}
                  className="block max-w-full truncate text-sm font-semibold text-[var(--text-primary)] hover:underline text-left"
                >
                  {displayTrack.title}
                </button>
                <div className="flex items-center gap-1.5 min-w-0">
                  {isCurrentYouTube || remote.isRemoteActive ? (
                    <span className="truncate text-xs text-[var(--text-secondary)]">
                      {displayTrack.artist}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/library/songs?artist=${encodeURIComponent(displayTrack.artist)}`)
                      }
                      className="block max-w-full truncate text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline text-left"
                    >
                      {displayTrack.artist}
                    </button>
                  )}
                  {remote.isRemoteActive && remote.targetDevice ? (
                    <span className="shrink-0 rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-semibold tracking-wide leading-none text-[var(--accent)] truncate max-w-[110px]">
                      {remote.targetDevice.name}
                    </span>
                  ) : isCurrentYouTube ? (
                    <span className="shrink-0 rounded border border-[var(--badge-source-border)] bg-[var(--badge-source-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none text-[var(--badge-source-text)]">
                      Web
                    </span>
                  ) : null}
                </div>
              </div>
              {!remote.isRemoteActive && currentTrack ? (
                isCurrentYouTube ? (
                  canDownload && !offline ? (
                    <button
                      type="button"
                      disabled={currentYtSaveStatus === 'saving'}
                      onClick={() => void handleSaveCurrentYouTube()}
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                        currentYtSaveStatus === 'saved'
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
                      }`}
                      title={
                        currentYtSaveStatus === 'saved'
                          ? 'Queued for library download'
                          : 'Save to Library'
                      }
                      aria-label="Save to Library"
                    >
                      {currentYtSaveStatus === 'saving' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : currentYtSaveStatus === 'saved' ? (
                        <Check className="w-4 h-4 stroke-[2.5]" />
                      ) : (
                        <Plus className="w-4 h-4 stroke-[2.5]" />
                      )}
                    </button>
                  ) : null
                ) : (
                  <button
                    type="button"
                    onClick={() => void toggleLikeTrack(currentTrack.id)}
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                      currentTrack.liked
                        ? 'text-[var(--accent)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                    aria-label={currentTrack.liked ? 'Unlike track' : 'Like track'}
                  >
                    <Heart className={`w-4 h-4 ${currentTrack.liked ? 'fill-current' : ''}`} />
                  </button>
                )
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-3 text-[var(--text-muted)]">
              <div className="h-14 w-14 rounded-md bg-[var(--bg-elevated)] flex items-center justify-center">
                <ListMusic className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-secondary)] truncate">
                  {remote.isRemoteActive && remote.targetDevice
                    ? `${remote.targetDevice.name} · Idle`
                    : 'Not playing'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {remote.isRemoteActive ? 'Remote control active' : 'Select a track to begin'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Center: Transport + Scrubber */}
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={handleToggleShuffle}
              className={`relative p-1.5 transition-colors ${
                displayShuffle
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label="Shuffle"
            >
              <Shuffle className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handlePrevTrack}
              disabled={!displayTrack}
              className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
              aria-label="Previous track"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            <button
              type="button"
              onClick={handleTogglePlay}
              disabled={!displayTrack}
              className={`flex h-9 w-9 items-center justify-center rounded-full bg-[var(--btn-contrast-bg)] text-[var(--btn-contrast-text)] hover:scale-105 active:scale-95 disabled:opacity-40 transition-transform ${
                remote.isPending ? 'opacity-70' : ''
              }`}
              aria-label={displayIsPlaying ? 'Pause' : 'Play'}
            >
              {displayIsPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleNextTrack}
              disabled={!displayTrack}
              className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
              aria-label="Next track"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
            <button
              type="button"
              onClick={handleCycleRepeat}
              className={`p-1.5 transition-colors ${
                displayRepeat !== 'off'
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label={`Repeat: ${displayRepeat}`}
            >
              {displayRepeat === 'one' ? (
                <Repeat1 className="w-4 h-4" />
              ) : (
                <Repeat className="w-4 h-4" />
              )}
            </button>
          </div>

          <DesktopPlaybackScrubber
            isRemoteActive={remote.isRemoteActive}
            remoteTime={remote.extrapolatedPositionSec}
            duration={displayDuration}
            disabled={!displayTrack}
            onSeek={handleSeek}
          />
        </div>

        {/* Right: Lyrics + Queue + Devices + Volume + Expand */}
        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={() => {
              setLyricsOpen(true);
              navigate('/now-playing');
            }}
            disabled={!displayTrack}
            className="p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
            title="Lyrics"
            aria-label="Open Lyrics"
          >
            <Mic2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setQueueOpen(!queueOpen)}
            className={`p-2 transition-colors ${
              queueOpen
                ? 'text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Queue"
            aria-label="Toggle Queue"
          >
            <ListMusic className="w-4 h-4" />
          </button>
          {!offline && (
            <button
              type="button"
              onClick={() => remote.setDeviceSheetOpen(true)}
              className={`relative p-2 transition-colors ${
                remote.isRemoteActive
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={
                remote.isRemoteActive && remote.targetDevice
                  ? `Controlling ${remote.targetDevice.name}`
                  : 'Devices'
              }
              aria-label="Devices"
            >
              <MonitorSpeaker className="w-4 h-4" />
              {(remote.isRemoteActive || onlineOtherDeviceCount > 0) && (
                <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              )}
            </button>
          )}

          <div className="xlab-slider-group flex items-center gap-2 w-28">
            <button
              type="button"
              onClick={handleToggleMute}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              aria-label={displayMuted ? 'Unmute' : 'Mute'}
            >
              {displayMuted || displayVolume === 0 ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={displayMuted ? 0 : displayVolume}
              onChange={(e) => handleSetVolume(parseFloat(e.target.value))}
              className="xlab-slider flex-1 h-1"
              style={{
                background: `linear-gradient(to right, var(--accent) ${volPct}%, var(--slider-track) ${volPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Volume"
            />
          </div>

          <button
            type="button"
            onClick={handleToggleNowPlaying}
            className={`p-2 transition-colors ${
              isNowPlayingPage
                ? 'text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title={isNowPlayingPage ? 'Close Now Playing' : 'Expand Now Playing'}
            aria-label={isNowPlayingPage ? 'Close Now Playing' : 'Expand Now Playing'}
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </footer>
      )}

      {/* Mobile Floating Mini-Player (64px) above safe-area-padded 60px Bottom Nav */}
      {!isNowPlayingPage && (displayTrack || remote.isRemoteActive) && (
        <div
          {...miniPlayerSwipe.handlers}
          className={miniPlayerClassName}
          style={miniPlayerSurfaceStyle}
        >
          <div className="flex h-full items-center gap-2 px-3">
            <button
              ref={miniPlayerSwipe.ref}
              type="button"
              onClick={() => {
                if (miniPlayerSwipe.shouldSuppressClick()) return;
                navigate('/now-playing');
              }}
              style={miniPlayerSwipe.style}
              className="flex min-w-0 flex-1 items-center gap-3 text-left select-none"
            >
              <AlbumArt
                coverFile={displayTrack?.cover_file ?? null}
                externalUrl={displayTrack?.coverUrl}
                alt={displayTrack?.title || remote.targetDevice?.name || 'Playback'}
                color={displayTrack?.dominant_color || '#1c3b29'}
                className="w-11 h-11 rounded-md pointer-events-none shadow-sm"
                iconSize={18}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate text-[var(--miniplayer-text)]">
                  {displayTrack ? displayTrack.title : `${remote.targetDevice?.name || 'Device'} · Idle`}
                </p>
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-xs truncate text-[var(--miniplayer-subtext)]">
                    {remote.isRemoteActive && remote.targetDevice
                      ? `${remote.targetDevice.name}${displayTrack ? ` · ${displayTrack.artist}` : ''}`
                      : displayTrack?.artist}
                  </p>
                  {!remote.isRemoteActive && isCurrentYouTube && (
                    <span className="shrink-0 rounded border border-[var(--miniplayer-badge-border)] bg-[var(--miniplayer-badge-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none text-[var(--miniplayer-badge-text)]">
                      Web
                    </span>
                  )}
                </div>
              </div>
            </button>

            {!offline && (
              <button
                type="button"
                data-no-swipe="true"
                onClick={() => remote.setDeviceSheetOpen(true)}
                className={`relative flex h-10 w-10 items-center justify-center ${
                  remote.isRemoteActive ? 'text-[var(--accent)]' : 'text-[var(--miniplayer-icon)]'
                }`}
                aria-label="Devices"
              >
                <MonitorSpeaker className="w-5 h-5" />
                {(remote.isRemoteActive || onlineOtherDeviceCount > 0) && (
                  <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                )}
              </button>
            )}

            {!remote.isRemoteActive && currentTrack ? (
              isCurrentYouTube ? (
                canDownload && !offline ? (
                  <button
                    type="button"
                    data-no-swipe="true"
                    disabled={currentYtSaveStatus === 'saving'}
                    onClick={() => void handleSaveCurrentYouTube()}
                    className={`flex h-10 w-10 items-center justify-center ${
                      currentYtSaveStatus === 'saved'
                        ? 'text-[var(--accent)]'
                        : 'text-[var(--miniplayer-icon)]'
                    }`}
                    title={
                      currentYtSaveStatus === 'saved'
                        ? 'Queued for library download'
                        : 'Save to Library'
                    }
                    aria-label="Save to Library"
                  >
                    {currentYtSaveStatus === 'saving' ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : currentYtSaveStatus === 'saved' ? (
                      <Check className="w-5 h-5 stroke-[2.5]" />
                    ) : (
                      <Plus className="w-5 h-5 stroke-[2.5]" />
                    )}
                  </button>
                ) : null
              ) : (
                <button
                  type="button"
                  data-no-swipe="true"
                  onClick={() => void toggleLikeTrack(currentTrack.id)}
                  className={`flex h-10 w-10 items-center justify-center ${
                    currentTrack.liked
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--miniplayer-icon)]'
                  }`}
                  aria-label="Like track"
                >
                  <Heart className={`w-5 h-5 ${currentTrack.liked ? 'fill-current' : ''}`} />
                </button>
              )
            ) : null}

            <button
              type="button"
              data-no-swipe="true"
              disabled={!displayTrack}
              onClick={handleTogglePlay}
              className={`flex h-11 w-11 items-center justify-center text-[var(--miniplayer-text)] disabled:opacity-40 ${
                remote.isPending ? 'opacity-70' : ''
              }`}
              aria-label={displayIsPlaying ? 'Pause' : 'Play'}
            >
              {displayIsPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current ml-0.5" />
              )}
            </button>
          </div>
          {/* Thin progress strip along bottom of mini-player */}
          <MobileMiniProgressBar
            isRemoteActive={remote.isRemoteActive}
            remoteTime={remote.extrapolatedPositionSec}
            duration={displayDuration}
          />
        </div>
      )}

      {/* Mobile 3-Tab Bottom Navigation Bar (60px + safe-area-inset-bottom) */}
      {!isNowPlayingPage && (
        <nav className={bottomNavClassName} aria-label="Primary navigation">
          <div
            className="grid h-[60px] items-center"
            style={{gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))`}}
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const isSelected = activeTabGroup === item.to;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={(e) => handlePrimaryNavClick(e, item.to)}
                  aria-current={isSelected ? 'page' : undefined}
                  className={() =>
                    `flex flex-col items-center justify-center gap-1 h-full text-[11px] font-medium transition-colors ${
                      isSelected ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                    }`
                  }
                >
                  <Icon className="w-5 h-5" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </nav>
      )}

      {(shellToast || remote.toast) && (
        remote.toast?.action === 'resume_local' ? (
          <button
            type="button"
            onClick={() => {
              void remoteHostApi.playLocal();
              remote.dismissToast();
            }}
            className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-[60] rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate hover:opacity-95 active:scale-95 transition-transform"
          >
            {remote.toast.message}
          </button>
        ) : remote.toast?.action === 'retry' && remote.toast.onRetry ? (
          <div
            role="status"
            className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2.5 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-strong)] pl-4 pr-2 py-1.5 text-sm font-medium text-[var(--text-primary)] shadow-2xl max-w-[92vw]"
          >
            <span className="truncate">{remote.toast.message}</span>
            <button
              type="button"
              onClick={() => {
                const retry = remote.toast?.onRetry;
                remote.dismissToast();
                retry?.();
              }}
              className="shrink-0 rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-bold text-[var(--accent-contrast)] hover:opacity-95 active:scale-95 transition-transform"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-[60] rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate">
            {remote.toast?.message || shellToast}
          </div>
        )
      )}

      {/* Offline Mode Indicator */}
      {offline && (
        <button
          type="button"
          onClick={() => navigate('/library')}
          className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-md bg-amber-500 px-3.5 py-2 text-xs font-semibold text-black shadow-lg hover:bg-amber-400 transition-colors"
        >
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>Offline Mode — Playing cached music</span>
        </button>
      )}

      {/* Modals & Drawers */}
      {!isDesktop && <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />}
      <DeviceSheet
        open={remote.deviceSheetOpen}
        onClose={() => remote.setDeviceSheetOpen(false)}
      />
      <CreatePlaylistModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(pl) => {
          setPlaylists((prev) => [pl, ...prev]);
          navigate(`/playlists/${pl.id}`);
        }}
      />
      </div>
    </MainScrollProvider>
  );
};

export const AppShell: React.FC = () => (
  <DesktopLayoutProvider>
    <AppShellInner />
  </DesktopLayoutProvider>
);
