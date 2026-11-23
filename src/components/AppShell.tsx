import {
  Check,
  Compass,
  Download,
  Heart,
  Home,
  ListMusic,
  Loader2,
  LogOut,
  Maximize2,
  Mic2,
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
import React, {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {NavLink, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useTheme} from '../context/ThemeContext';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {usePWAInstall} from '../hooks/usePWAInstall';
import {useSwipeTrackGesture} from '../hooks/useSwipeTrackGesture';
import {apiFetch, formatDuration} from '../lib/api';
import {
  getUnifiedPageHeaderGradient,
  getUnifiedPageHeaderTopHex,
  setDocumentThemeColor,
} from '../lib/themeColor';
import type {Playlist} from '../types';
import {getOfflinePlaylists, subscribeOfflineStore} from '../utils/offlineStore';
import {AlbumArt} from './AlbumArt';
import {BrandLogo} from './BrandLogo';
import {CreatePlaylistModal} from './CreatePlaylistModal';
import {QueueDrawer} from './QueueDrawer';

export const AppShell: React.FC = () => {
  const {user, isOfflineMode, logout} = useAuth();
  const {theme, isLight, isAppleStyle, isTidal} = useTheme();
  const {
    currentTrack,
    isPlaying,
    currentTime,
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
    saveYouTubeTrackToLibrary,
    getYouTubeSaveStatus,
  } = usePlayer();

  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
  const canDownload = Boolean(user?.can_download || user?.role === 'admin');
  const [shellToast, setShellToast] = useState<string | null>(null);
  const flashShellToast = useCallback((msg: string) => {
    setShellToast(msg);
    setTimeout(() => setShellToast(null), 2800);
  }, []);
  const {isInstallable, isInstalled, install} = usePWAInstall();
  const navigate = useNavigate();
  const location = useLocation();

  const miniPlayerSwipe = useSwipeTrackGesture({
    onSwipeNext: nextTrack,
    onSwipePrev: prevTrack,
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

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const volPct = (isMuted ? 0 : volume) * 100;
  const isNowPlayingPage = location.pathname === '/now-playing';
  const isHomePage = location.pathname === '/';
  const hasOwnBottomClearance =
    isHomePage ||
    location.pathname === '/discover' ||
    location.pathname === '/search' ||
    location.pathname.startsWith('/playlists');
  const stageTint = currentTrack?.dominant_color || (isAppleStyle ? '#4a1822' : '#1c3b29');
  const isCurrentYouTube = Boolean(currentTrack?.isYouTubeStream);
  const currentYtSaveStatus =
    currentTrack && isCurrentYouTube ? getYouTubeSaveStatus(currentTrack.id) : 'idle';

  const handleSaveCurrentYouTube = useCallback(async () => {
    if (!currentTrack || !currentTrack.isYouTubeStream) return;
    const res = await saveYouTubeTrackToLibrary(currentTrack);
    flashShellToast(res.message);
  }, [currentTrack, flashShellToast, saveYouTubeTrackToLibrary]);

  const isPlaylistsRootPage = location.pathname === '/playlists';
  const usesUnifiedHeader = !isNowPlayingPage && !isHomePage && !isPlaylistsRootPage;
  const unifiedHeaderTopHex = getUnifiedPageHeaderTopHex(theme);
  const unifiedHeaderGradient = getUnifiedPageHeaderGradient(theme);

  // Synchronously match mobile status bar (`meta[name="theme-color"]` & root/body bg)
  // to the exact top edge of the unified header gradient on Playlists, Discover, and Settings.
  useLayoutEffect(() => {
    if (usesUnifiedHeader) {
      setDocumentThemeColor(unifiedHeaderTopHex);
    }
  }, [usesUnifiedHeader, unifiedHeaderTopHex, location.pathname, theme]);

  const navItems = [
    {to: '/', label: 'Home', icon: Home, end: true},
    {to: '/playlists', label: 'Playlists', icon: ListMusic, end: false},
    {to: '/discover', label: 'Discover', icon: Compass, end: false},
    {to: '/settings', label: 'Settings', icon: Settings, end: false},
  ];

  const miniPlayerSurfaceStyle: React.CSSProperties =
    theme === 'spotify-dark'
      ? {
          background: `linear-gradient(90deg, ${stageTint} 0%, #1c1c1c 100%)`,
          touchAction: 'pan-y',
        }
      : {
          touchAction: 'pan-y',
        };

  const miniPlayerClassName =
    theme === 'apple-light'
      ? 'md:hidden fixed left-2.5 right-2.5 bottom-above-nav z-30 h-[64px] rounded-2xl bg-white/85 backdrop-blur-xl border border-black/[0.08] shadow-[0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden select-none'
      : theme === 'apple-dark'
        ? 'md:hidden fixed left-2.5 right-2.5 bottom-above-nav z-30 h-[64px] rounded-2xl bg-[#1C1C1E]/80 backdrop-blur-xl border border-white/[0.12] shadow-2xl overflow-hidden select-none'
        : theme === 'tidal-dark'
          ? 'md:hidden fixed left-2.5 right-2.5 bottom-above-nav z-30 h-[64px] rounded-xl bg-[#111111]/95 backdrop-blur-xl border border-white/[0.08] shadow-2xl overflow-hidden select-none'
          : 'md:hidden fixed left-2 right-2 bottom-above-nav z-30 h-[64px] rounded-lg border border-white/10 shadow-2xl overflow-hidden select-none';

  const bottomNavClassName =
    theme === 'apple-light'
      ? 'md:hidden fixed bottom-0 left-0 right-0 z-30 pb-safe bg-white/85 backdrop-blur-xl border-t border-black/[0.08]'
      : theme === 'apple-dark'
        ? 'md:hidden fixed bottom-0 left-0 right-0 z-30 pb-safe bg-[#1C1C1E]/80 backdrop-blur-xl border-t border-white/[0.10]'
        : theme === 'tidal-dark'
          ? 'md:hidden fixed bottom-0 left-0 right-0 z-30 pb-safe bg-[#060608]/95 backdrop-blur-xl border-t border-white/[0.08]'
          : 'md:hidden fixed bottom-0 left-0 right-0 z-30 pb-safe bg-[var(--bg-glass)] backdrop-blur-md border-t border-[var(--border-subtle)]';

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Main Area: Sidebar (Desktop) + Scrollable Stage */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop Fixed Left Sidebar (240px) */}
        <aside className="hidden md:flex w-[240px] shrink-0 flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)]">
          <div className="px-5 pt-6 pb-5">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="text-left focus:outline-none"
            >
              <BrandLogo size="md" />
            </button>
          </div>

          <nav className="px-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({isActive}) =>
                    `flex items-center gap-3.5 rounded-md px-3 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                      isActive
                        ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                    }`
                  }
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>

          {/* Quick Playlist List */}
          <div className="mt-6 flex flex-1 min-h-0 flex-col border-t border-[var(--border-subtle)] pt-4 px-3">
            <div className="flex items-center justify-between px-3 mb-2">
              <span className="text-xs font-semibold text-[var(--text-secondary)]">
                {offline ? 'Offline Playlists' : 'Playlists'}
              </span>
              {!offline && (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
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

          {/* Sidebar Footer: PWA Install (if available) + User */}
          <div className="border-t border-[var(--border-subtle)] p-3 space-y-2">
            {isInstallable && !isInstalled && (
              <button
                type="button"
                onClick={() => void install()}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
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
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </aside>

        {/* Main Scrollable Viewport */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-[var(--bg-primary)] relative">
          {/* Unified Full-Bleed Top-to-Bottom Header Gradient Backdrop (starts flush at y=0 behind status bar) */}
          <main
            className="flex-1 overflow-y-auto relative"
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
              <Outlet />
            </div>
          </main>
        </div>
      </div>

      {/* Desktop Fixed Bottom Playback Bar (90px) */}
      <footer
        className={`hidden md:grid h-[90px] shrink-0 grid-cols-[minmax(220px,1fr)_minmax(340px,1.5fr)_minmax(220px,1fr)] items-center gap-4 border-t border-[var(--border-subtle)] px-4 z-30 ${
          isAppleStyle ? 'bg-[var(--bg-glass)] backdrop-blur-xl' : 'bg-[var(--bg-secondary)]'
        }`}
      >
        {/* Left: Mini Cover + Title + Artist + Heart */}
        <div className="flex items-center gap-3.5 min-w-0">
          {currentTrack ? (
            <>
              <button
                type="button"
                onClick={() => navigate('/now-playing')}
                className="shrink-0 group relative"
                aria-label="Open Now Playing"
              >
                <AlbumArt
                  coverFile={currentTrack.cover_file}
                  externalUrl={currentTrack.coverUrl}
                  alt={currentTrack.title}
                  color={currentTrack.dominant_color}
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
                  {currentTrack.title}
                </button>
                <div className="flex items-center gap-1.5 min-w-0">
                  {isCurrentYouTube ? (
                    <span className="truncate text-xs text-[var(--text-secondary)]">
                      {currentTrack.artist}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/?artist=${encodeURIComponent(currentTrack.artist)}`)
                      }
                      className="block max-w-full truncate text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline text-left"
                    >
                      {currentTrack.artist}
                    </button>
                  )}
                  {isCurrentYouTube && (
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none ${
                        isTidal
                          ? 'border-[rgba(0,255,255,0.35)] bg-[rgba(0,255,255,0.1)] text-[#00FFFF]'
                          : 'border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                      }`}
                    >
                      Web
                    </span>
                  )}
                </div>
              </div>
              {isCurrentYouTube ? (
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
              )}
            </>
          ) : (
            <div className="flex items-center gap-3 text-[var(--text-muted)]">
              <div className="h-14 w-14 rounded-md bg-[var(--bg-elevated)] flex items-center justify-center">
                <ListMusic className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">Not playing</p>
                <p className="text-xs text-[var(--text-muted)]">Select a track to begin</p>
              </div>
            </div>
          )}
        </div>

        {/* Center: Transport + Scrubber */}
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={toggleShuffle}
              className={`relative p-1.5 transition-colors ${
                shuffle
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label="Shuffle"
            >
              <Shuffle className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={prevTrack}
              disabled={!currentTrack}
              className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
              aria-label="Previous track"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              disabled={!currentTrack}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--btn-contrast-bg)] text-[var(--btn-contrast-text)] hover:scale-105 active:scale-95 disabled:opacity-40 transition-transform"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>
            <button
              type="button"
              onClick={nextTrack}
              disabled={!currentTrack}
              className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
              aria-label="Next track"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
            <button
              type="button"
              onClick={cycleRepeat}
              className={`p-1.5 transition-colors ${
                repeat !== 'off'
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              aria-label={`Repeat: ${repeat}`}
            >
              {repeat === 'one' ? (
                <Repeat1 className="w-4 h-4" />
              ) : (
                <Repeat className="w-4 h-4" />
              )}
            </button>
          </div>

          <div className="xlab-slider-group flex w-full max-w-xl items-center gap-2.5">
            <span className="font-mono text-[11px] tabular-nums text-[var(--text-secondary)] w-10 text-right">
              {formatDuration(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(currentTime, duration || 1)}
              disabled={!currentTrack}
              onChange={(e) => seek(parseFloat(e.target.value))}
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
        </div>

        {/* Right: Lyrics + Queue + Volume + Expand */}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setLyricsOpen(true);
              navigate('/now-playing');
            }}
            disabled={!currentTrack}
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

          <div className="xlab-slider-group flex items-center gap-2 w-28">
            <button
              type="button"
              onClick={toggleMute}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted || volume === 0 ? (
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
              value={isMuted ? 0 : volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
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
            onClick={() => navigate(isNowPlayingPage ? '/' : '/now-playing')}
            className={`p-2 transition-colors ${
              isNowPlayingPage
                ? 'text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Expand Now Playing"
            aria-label="Expand Now Playing"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </footer>

      {/* Mobile Floating Mini-Player (64px) above safe-area-padded 60px Bottom Nav */}
      {!isNowPlayingPage && currentTrack && (
        <div
          {...miniPlayerSwipe.handlers}
          className={miniPlayerClassName}
          style={miniPlayerSurfaceStyle}
        >
          <div className="flex h-full items-center gap-3 px-3">
            <button
              type="button"
              onClick={() => {
                if (miniPlayerSwipe.shouldSuppressClick()) return;
                navigate('/now-playing');
              }}
              style={miniPlayerSwipe.style}
              className="flex min-w-0 flex-1 items-center gap-3 text-left select-none"
            >
              <AlbumArt
                coverFile={currentTrack.cover_file}
                externalUrl={currentTrack.coverUrl}
                alt={currentTrack.title}
                color={currentTrack.dominant_color}
                className="w-11 h-11 rounded-md pointer-events-none shadow-sm"
                iconSize={18}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm font-semibold truncate ${
                    theme === 'apple-light' ? 'text-[#1C1C1E]' : 'text-white'
                  }`}
                >
                  {currentTrack.title}
                </p>
                <div className="flex items-center gap-1.5 min-w-0">
                  <p
                    className={`text-xs truncate ${
                      theme === 'apple-light' ? 'text-[#6E6E73]' : 'text-white/75'
                    }`}
                  >
                    {currentTrack.artist}
                  </p>
                  {isCurrentYouTube && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none ${
                        isTidal
                          ? 'border border-[rgba(0,255,255,0.35)] bg-[rgba(0,255,255,0.1)] text-[#00FFFF]'
                          : theme === 'apple-light'
                            ? 'bg-black/[0.07] text-[#6E6E73]'
                            : 'bg-white/15 text-white/85'
                      }`}
                    >
                      Web
                    </span>
                  )}
                </div>
              </div>
            </button>

            {isCurrentYouTube ? (
              canDownload && !offline ? (
                <button
                  type="button"
                  data-no-swipe="true"
                  disabled={currentYtSaveStatus === 'saving'}
                  onClick={() => void handleSaveCurrentYouTube()}
                  className={`flex h-11 w-11 items-center justify-center ${
                    currentYtSaveStatus === 'saved'
                      ? 'text-[var(--accent)]'
                      : theme === 'apple-light'
                        ? 'text-[#6E6E73]'
                        : 'text-white/85'
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
                className={`flex h-11 w-11 items-center justify-center ${
                  currentTrack.liked
                    ? 'text-[var(--accent)]'
                    : theme === 'apple-light'
                      ? 'text-[#6E6E73]'
                      : 'text-white/80'
                }`}
                aria-label="Like track"
              >
                <Heart className={`w-5 h-5 ${currentTrack.liked ? 'fill-current' : ''}`} />
              </button>
            )}
            <button
              type="button"
              data-no-swipe="true"
              onClick={togglePlay}
              className={`flex h-11 w-11 items-center justify-center ${
                theme === 'apple-light' ? 'text-[#1C1C1E]' : 'text-white'
              }`}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current ml-0.5" />
              )}
            </button>
          </div>
          {/* Thin progress strip along bottom of mini-player */}
          <div
            className={`absolute bottom-0 left-0 right-0 h-[2px] ${
              theme === 'apple-light' ? 'bg-black/10' : 'bg-white/15'
            }`}
          >
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-150"
              style={{width: `${progressPct}%`}}
            />
          </div>
        </div>
      )}

      {/* Mobile 4-Tab Bottom Navigation Bar (60px + safe-area-inset-bottom) */}
      {!isNowPlayingPage && (
        <nav className={bottomNavClassName}>
          <div
            className="grid h-[60px] items-center"
            style={{gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))`}}
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({isActive}) =>
                    `flex flex-col items-center justify-center gap-1 h-full text-[11px] font-medium transition-colors ${
                      isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
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

      {shellToast && (
        <div className="fixed top-16 md:top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate">
          {shellToast}
        </div>
      )}

      {/* Offline Mode Indicator */}
      {offline && (
        <button
          type="button"
          onClick={() => navigate('/')}
          className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-md bg-amber-500 px-3.5 py-2 text-xs font-semibold text-black shadow-lg hover:bg-amber-400 transition-colors"
        >
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>Offline Mode — Playing cached music</span>
        </button>
      )}

      {/* Modals & Drawers */}
      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
      <CreatePlaylistModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(pl) => {
          setPlaylists((prev) => [pl, ...prev]);
          navigate(`/playlists/${pl.id}`);
        }}
      />
    </div>
  );
};
