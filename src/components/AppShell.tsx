import {
  Download,
  Heart,
  Home,
  ListMusic,
  LogOut,
  Maximize2,
  Mic2,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import React, {useCallback, useEffect, useState} from 'react';
import {NavLink, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useOnlineStatus} from '../hooks/useOnlineStatus';
import {usePWAInstall} from '../hooks/usePWAInstall';
import {useSwipeTrackGesture} from '../hooks/useSwipeTrackGesture';
import {apiFetch, formatDuration} from '../lib/api';
import {DEFAULT_APP_THEME_COLOR, setDocumentThemeColor} from '../lib/themeColor';
import type {Playlist} from '../types';
import {getOfflinePlaylists, subscribeOfflineStore} from '../utils/offlineStore';
import {AlbumArt} from './AlbumArt';
import {BrandLogo} from './BrandLogo';
import {CreatePlaylistModal} from './CreatePlaylistModal';
import {QueueDrawer} from './QueueDrawer';

export const AppShell: React.FC = () => {
  const {user, isOfflineMode, logout} = useAuth();
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
  } = usePlayer();

  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;
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
    location.pathname === '/search' ||
    location.pathname.startsWith('/playlists');
  const stageTint = currentTrack?.dominant_color || '#1c3b29';

  // Keep mobile status bar synced to #121212 on standard views (Now Playing & Home sync dynamically)
  useEffect(() => {
    if (!isNowPlayingPage && !isHomePage) {
      setDocumentThemeColor(DEFAULT_APP_THEME_COLOR);
    }
  }, [isNowPlayingPage, isHomePage]);

  const navItems = [
    {to: '/', label: 'Home', icon: Home, end: true},
    {to: '/playlists', label: 'Playlists', icon: ListMusic, end: false},
    {to: '/search', label: 'Search', icon: Search, end: false},
    {to: '/settings', label: 'Settings', icon: Settings, end: false},
  ];

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#121212] text-white">
      {/* Main Area: Sidebar (Desktop) + Scrollable Stage */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Desktop Fixed Left Sidebar (240px) */}
        <aside className="hidden md:flex w-[240px] shrink-0 flex-col bg-[#0A0A0A] border-r border-white/[0.06]">
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
                        ? 'bg-[#282828] text-white'
                        : 'text-[#B3B3B3] hover:text-white hover:bg-[#181818]'
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
          <div className="mt-6 flex flex-1 min-h-0 flex-col border-t border-white/[0.06] pt-4 px-3">
            <div className="flex items-center justify-between px-3 mb-2">
              <span className="text-xs font-semibold text-[#B3B3B3]">
                {offline ? 'Offline Playlists' : 'Playlists'}
              </span>
              {!offline && (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-[#282828] hover:text-white transition-colors"
                  title="Create playlist"
                  aria-label="Create playlist"
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
              {playlists.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[#6A6A6A]">
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
                          ? 'bg-[#282828] text-white font-medium'
                          : 'text-[#B3B3B3] hover:text-white hover:bg-[#181818]'
                      }`
                    }
                  >
                    <span className="truncate">{pl.name}</span>
                    <span className="font-mono text-xs tabular-nums text-[#6A6A6A] ml-2">
                      {pl.track_count}
                    </span>
                  </NavLink>
                ))
              )}
            </div>
          </div>

          {/* Sidebar Footer: PWA Install (if available) + User */}
          <div className="border-t border-white/[0.06] p-3 space-y-2">
            {isInstallable && !isInstalled && (
              <button
                type="button"
                onClick={() => void install()}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-[#181818] border border-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-[#282828] transition-colors"
              >
                <Download className="w-3.5 h-3.5 text-[#1DB954]" />
                Install xlabplayer App
              </button>
            )}
            <div className="flex items-center justify-between rounded-md px-2.5 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{user?.username}</p>
                <p className="text-xs text-[#6A6A6A] capitalize">{user?.role}</p>
              </div>
              <button
                type="button"
                onClick={() => void logout()}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-[#282828] hover:text-white transition-colors"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </aside>

        {/* Main Scrollable Viewport */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-[#121212] relative">
          {/* Dynamic Subtle Top-to-Bottom Gradient Backdrop */}
          <main
            className="flex-1 overflow-y-auto relative"
            style={{
              backgroundImage:
                isNowPlayingPage || isHomePage
                  ? undefined
                  : `linear-gradient(180deg, ${stageTint}55 0%, #121212 280px, #121212 100%)`,
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
      <footer className="hidden md:grid h-[90px] shrink-0 grid-cols-[minmax(220px,1fr)_minmax(340px,1.5fr)_minmax(220px,1fr)] items-center gap-4 bg-[#181818] border-t border-white/[0.08] px-4 z-30">
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
                  alt={currentTrack.title}
                  color={currentTrack.dominant_color}
                  className="w-14 h-14 rounded shadow-md"
                  iconSize={22}
                />
              </button>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => navigate('/now-playing')}
                  className="block max-w-full truncate text-sm font-semibold text-white hover:underline text-left"
                >
                  {currentTrack.title}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/?artist=${encodeURIComponent(currentTrack.artist)}`)
                  }
                  className="block max-w-full truncate text-xs text-[#B3B3B3] hover:text-white hover:underline text-left"
                >
                  {currentTrack.artist}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void toggleLikeTrack(currentTrack.id)}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                  currentTrack.liked ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
                }`}
                aria-label={currentTrack.liked ? 'Unlike track' : 'Like track'}
              >
                <Heart className={`w-4 h-4 ${currentTrack.liked ? 'fill-current' : ''}`} />
              </button>
            </>
          ) : (
            <div className="flex items-center gap-3 text-[#6A6A6A]">
              <div className="h-14 w-14 rounded bg-[#242424] flex items-center justify-center">
                <ListMusic className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-[#B3B3B3]">Not playing</p>
                <p className="text-xs text-[#6A6A6A]">Select a track to begin</p>
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
                shuffle ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
              }`}
              aria-label="Shuffle"
            >
              <Shuffle className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={prevTrack}
              disabled={!currentTrack}
              className="p-1.5 text-[#B3B3B3] hover:text-white disabled:opacity-30 transition-colors"
              aria-label="Previous track"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              disabled={!currentTrack}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-black hover:scale-105 active:scale-95 disabled:opacity-40 transition-transform"
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
              className="p-1.5 text-[#B3B3B3] hover:text-white disabled:opacity-30 transition-colors"
              aria-label="Next track"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
            <button
              type="button"
              onClick={cycleRepeat}
              className={`p-1.5 transition-colors ${
                repeat !== 'off' ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
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
            <span className="font-mono text-[11px] tabular-nums text-[#B3B3B3] w-10 text-right">
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
                background: `linear-gradient(to right, #1DB954 ${progressPct}%, #4D4D4D ${progressPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Seek progress"
            />
            <span className="font-mono text-[11px] tabular-nums text-[#B3B3B3] w-10">
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
            className="p-2 text-[#B3B3B3] hover:text-white disabled:opacity-30 transition-colors"
            title="Lyrics"
            aria-label="Open Lyrics"
          >
            <Mic2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setQueueOpen(!queueOpen)}
            className={`p-2 transition-colors ${
              queueOpen ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
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
              className="text-[#B3B3B3] hover:text-white transition-colors"
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
                background: `linear-gradient(to right, #1DB954 ${volPct}%, #4D4D4D ${volPct}%)`,
                borderRadius: '9999px',
              }}
              aria-label="Volume"
            />
          </div>

          <button
            type="button"
            onClick={() => navigate(isNowPlayingPage ? '/' : '/now-playing')}
            className={`p-2 transition-colors ${
              isNowPlayingPage ? 'text-[#1DB954]' : 'text-[#B3B3B3] hover:text-white'
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
          className="md:hidden fixed left-2 right-2 bottom-above-nav z-30 h-[64px] rounded-lg border border-white/10 shadow-2xl overflow-hidden select-none"
          style={{
            background: `linear-gradient(90deg, ${stageTint} 0%, #1c1c1c 100%)`,
            touchAction: 'pan-y',
          }}
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
                alt={currentTrack.title}
                color={currentTrack.dominant_color}
                className="w-11 h-11 rounded pointer-events-none"
                iconSize={18}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{currentTrack.title}</p>
                <p className="text-xs text-white/75 truncate">{currentTrack.artist}</p>
              </div>
            </button>

            <button
              type="button"
              data-no-swipe="true"
              onClick={() => void toggleLikeTrack(currentTrack.id)}
              className={`flex h-11 w-11 items-center justify-center ${
                currentTrack.liked ? 'text-[#1DB954]' : 'text-white/80'
              }`}
              aria-label="Like track"
            >
              <Heart className={`w-5 h-5 ${currentTrack.liked ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              data-no-swipe="true"
              onClick={togglePlay}
              className="flex h-11 w-11 items-center justify-center text-white"
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
          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/15">
            <div
              className="h-full bg-[#1DB954] transition-[width] duration-150"
              style={{width: `${progressPct}%`}}
            />
          </div>
        </div>
      )}

      {/* Mobile 4-Tab Bottom Navigation Bar (60px + safe-area-inset-bottom) */}
      {!isNowPlayingPage && (
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 pb-safe bg-[#121212]/95 backdrop-blur-md border-t border-white/10">
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
                      isActive ? 'text-[#1DB954]' : 'text-[#B3B3B3]'
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
