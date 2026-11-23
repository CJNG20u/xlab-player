import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Disc3,
  FileDown,
  HardDriveDownload,
  Heart,
  Loader2,
  MoreHorizontal,
  Music2,
  Play,
  Plus,
  Shuffle,
  Sparkles,
  Trash2,
} from 'lucide-react';
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useTheme} from '../context/ThemeContext';
import {getCoverUrl, getLocalPlayHistory, getTrackCoverUrl} from '../lib/api';
import {
  computeLightTintedTopHex,
  computeNowPlayingTopHex,
  extractDominantColorFromImage,
  getCachedDominantColor,
  setDocumentThemeColor,
} from '../lib/themeColor';
import type {Playlist, Track} from '../types';
import {getOfflineCoverBlobUrl} from '../utils/offlineStore';
import {PlaylistMosaic} from './AlbumArt';

const RECENT_PLAYLISTS_STORAGE_KEY = 'xlabplayer-recent-playlists';

export function readRecentPlaylistIds(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_PLAYLISTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  } catch {
    return [];
  }
}

export function recordRecentPlaylistId(playlistId: number): number[] {
  const existing = readRecentPlaylistIds().filter((id) => id !== playlistId);
  const next = [playlistId, ...existing].slice(0, 20);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(RECENT_PLAYLISTS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors
    }
  }
  return next;
}

function formatHumanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const totalMins = Math.floor(seconds / 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 0) return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  if (mins > 0) return `${mins} min`;
  return `${Math.max(1, Math.floor(seconds))}s`;
}

function cleanArtistName(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .trim();
  if (!trimmed) return '';
  if (/^(unknown artist|various artists|youtube|online)$/i.test(trimmed)) return '';
  return trimmed;
}

interface SmartMixCardData {
  id: string;
  title: string;
  subtitle: string;
  covers: string[];
  variant: 'default' | 'liked' | 'recent' | 'offline';
  tracks: Track[];
  shuffleOnPlay?: boolean;
  onCardClick: () => void;
}

interface HorizontalCarouselSectionProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

const HorizontalCarouselSection: React.FC<HorizontalCarouselSectionProps> = ({
  title,
  subtitle,
  children,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    updateScrollEdges();
    const el = scrollRef.current;
    if (!el) return;
    const onResize = () => updateScrollEdges();
    window.addEventListener('resize', onResize);
    const timer = window.setTimeout(updateScrollEdges, 120);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
  }, [updateScrollEdges, children]);

  const scrollByAmount = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const step = Math.max(300, Math.round(el.clientWidth * 0.78));
    el.scrollBy({left: direction * step, behavior: 'smooth'});
  };

  return (
    <section className="space-y-3.5">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg sm:text-xl font-extrabold tracking-tight text-[var(--text-primary)] truncate">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs text-[var(--text-secondary)] truncate mt-0.5">{subtitle}</p>
          )}
        </div>

        {(canScrollLeft || canScrollRight) && (
          <div className="hidden md:flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={!canScrollLeft}
              onClick={() => scrollByAmount(-1)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
              aria-label={`Scroll ${title} left`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={!canScrollRight}
              onClick={() => scrollByAmount(1)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"
              aria-label={`Scroll ${title} right`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={updateScrollEdges}
        className="flex flex-nowrap items-start gap-4 overflow-x-auto snap-x snap-mandatory no-scrollbar pb-2 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
      >
        {children}
      </div>
    </section>
  );
};

interface PlaylistsHubViewProps {
  playlists: Playlist[];
  tracks: Track[];
  currentTrack: Track | null;
  totalTrackCount: number;
  cachedTrackIds: Set<number>;
  offline: boolean;
  loading: boolean;
  exportingPlaylistId: number | null;
  onOpenPlaylist: (playlistId: number) => void;
  onPlayPlaylist: (playlistId: number, shufflePlay?: boolean) => Promise<void>;
  onPlayTracks: (trackList: Track[], shufflePlay?: boolean) => void;
  onOpenCreatePlaylist: () => void;
  onExportM3u: (playlist: Playlist) => Promise<void>;
  onDeletePlaylist: (playlistId: number) => Promise<void>;
  onNavigateHomeTab: (tab: 'liked' | 'recent' | 'offline' | 'all') => void;
}

export const PlaylistsHubView: React.FC<PlaylistsHubViewProps> = ({
  playlists,
  tracks,
  currentTrack,
  totalTrackCount,
  cachedTrackIds,
  offline,
  loading,
  exportingPlaylistId,
  onOpenPlaylist,
  onPlayPlaylist,
  onPlayTracks,
  onOpenCreatePlaylist,
  onExportM3u,
  onDeletePlaylist,
  onNavigateHomeTab,
}) => {
  const {theme, isLight, isTidal} = useTheme();
  const [recentIds, setRecentIds] = useState<number[]>(() => readRecentPlaylistIds());
  const [heroSampledColor, setHeroSampledColor] = useState<string | null>(null);
  const [heroOfflineCoverUrl, setHeroOfflineCoverUrl] = useState<string | null>(null);
  const [heroImageErrored, setHeroImageErrored] = useState(false);

  // Viewport-anchored floating context menu (prevents clipping inside overflow-x-auto carousels)
  const [menuState, setMenuState] = useState<{
    playlist: Playlist;
    top: number;
    left: number;
  } | null>(null);
  const menuPopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuState) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuPopoverRef.current && !menuPopoverRef.current.contains(e.target as Node)) {
        setMenuState(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuState(null);
    };
    const onScroll = () => setMenuState(null);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuState]);

  const handleOpenPlaylistCard = useCallback(
    (playlistId: number) => {
      setRecentIds(recordRecentPlaylistId(playlistId));
      onOpenPlaylist(playlistId);
    },
    [onOpenPlaylist]
  );

  const handlePlayPlaylistCard = useCallback(
    async (playlistId: number, shufflePlay = false) => {
      setRecentIds(recordRecentPlaylistId(playlistId));
      await onPlayPlaylist(playlistId, shufflePlay);
    },
    [onPlayPlaylist]
  );

  const openPlaylistMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>, pl: Playlist) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 196;
    const menuHeight = 104;
    const clampedLeft = Math.max(
      12,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12)
    );
    const fitsBelow = rect.bottom + menuHeight + 12 < window.innerHeight;
    const top = fitsBelow ? rect.bottom + 6 : Math.max(12, rect.top - menuHeight - 6);
    setMenuState((prev) =>
      prev?.playlist.id === pl.id ? null : {playlist: pl, top, left: clampedLeft}
    );
  }, []);

  // Derive recent artists from persistent play history + library tracks for "My Soundtrack"
  const recentArtists = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    const pushName = (raw: string | null | undefined) => {
      const cleaned = cleanArtistName(raw);
      if (!cleaned) return;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(cleaned);
    };

    if (currentTrack?.artist) pushName(currentTrack.artist);
    const history = getLocalPlayHistory();
    for (const entry of history) {
      pushName(entry.artist);
      if (names.length >= 6) break;
    }
    if (names.length < 4) {
      for (const t of tracks) {
        if (t.liked) pushName(t.artist);
        if (names.length >= 6) break;
      }
    }
    if (names.length < 4) {
      for (const t of tracks) {
        pushName(t.artist);
        if (names.length >= 6) break;
      }
    }
    return names;
  }, [currentTrack?.artist, tracks]);

  // Build "My Soundtrack" mix prioritizing recent artists & liked tracks
  const soundtrackTracks = useMemo(() => {
    if (tracks.length === 0) return [];
    const recentArtistSet = new Set(recentArtists.slice(0, 6).map((a) => a.toLowerCase()));
    const prioritized: Track[] = [];
    const secondary: Track[] = [];
    const rest: Track[] = [];

    for (const t of tracks) {
      const artistKey = cleanArtistName(t.artist).toLowerCase();
      if (recentArtistSet.has(artistKey)) {
        prioritized.push(t);
      } else if (t.liked) {
        secondary.push(t);
      } else {
        rest.push(t);
      }
    }
    return [...prioritized, ...secondary, ...rest].slice(0, 60);
  }, [recentArtists, tracks]);

  const soundtrackDuration = useMemo(
    () => soundtrackTracks.reduce((sum, t) => sum + (t.duration || 0), 0),
    [soundtrackTracks]
  );

  const soundtrackCovers = useMemo(() => {
    const unique: string[] = [];
    for (const t of soundtrackTracks) {
      if (t.cover_file && !unique.includes(t.cover_file)) {
        unique.push(t.cover_file);
        if (unique.length >= 4) break;
      }
    }
    return unique;
  }, [soundtrackTracks]);

  const soundtrackSubtitle = useMemo(() => {
    if (recentArtists.length > 0) {
      const shown = recentArtists.slice(0, 3).join(', ');
      const suffix = recentArtists.length > 3 ? ' and more' : '';
      return `Based on ${shown}${suffix}`;
    }
    if (soundtrackTracks.length > 0) {
      const dur = formatHumanDuration(soundtrackDuration);
      return dur
        ? `${soundtrackTracks.length} ${soundtrackTracks.length === 1 ? 'track' : 'tracks'} · ${dur}`
        : `${soundtrackTracks.length} ${soundtrackTracks.length === 1 ? 'track' : 'tracks'}`;
    }
    return 'Your personal rotation, refreshed from your listening';
  }, [recentArtists, soundtrackDuration, soundtrackTracks.length]);

  // Identify most recently played playlist that still exists
  const recentPlaylists = useMemo(() => {
    if (recentIds.length === 0 || playlists.length === 0) return [];
    const byId = new Map(playlists.map((p) => [p.id, p]));
    return recentIds
      .map((id) => byId.get(id))
      .filter((p): p is Playlist => Boolean(p));
  }, [playlists, recentIds]);

  // Featured Hero selection: prefer most recently played playlist with tracks, else My Soundtrack mix, else first playlist
  const featuredHero = useMemo(() => {
    const recentPlayable = recentPlaylists.find((p) => p.track_count > 0);
    if (recentPlayable) {
      const trackLabel = `${recentPlayable.track_count} ${recentPlayable.track_count === 1 ? 'track' : 'tracks'}`;
      return {
        kind: 'playlist' as const,
        playlist: recentPlayable,
        eyebrow: 'FEATURED PLAYLIST',
        title: recentPlayable.name,
        subtitle: recentPlayable.description
          ? `${recentPlayable.description} · ${trackLabel}`
          : recentPlayable.source === 'm3u'
            ? `Imported M3U · ${trackLabel}`
            : trackLabel,
        coverFile: recentPlayable.covers?.[0] || soundtrackCovers[0] || null,
        externalCoverUrl: null as string | null,
        fallbackColor:
          theme === 'tidal-dark' ? '#092226' : theme === 'spotify-dark' ? '#1c4230' : '#4a1722',
      };
    }

    if (soundtrackTracks.length > 0) {
      const primaryTrack =
        (currentTrack?.cover_file
          ? currentTrack
          : soundtrackTracks.find((t) => Boolean(t.cover_file))) ||
        (currentTrack?.coverUrl ? currentTrack : soundtrackTracks[0]);
      const dur = formatHumanDuration(soundtrackDuration);
      const countMeta = `${soundtrackTracks.length} ${soundtrackTracks.length === 1 ? 'track' : 'tracks'}${dur ? ` · ${dur}` : ''}`;
      return {
        kind: 'soundtrack' as const,
        playlist: null as Playlist | null,
        eyebrow: 'MY SOUNDTRACK',
        title: 'My Soundtrack',
        subtitle:
          recentArtists.length > 0
            ? `${soundtrackSubtitle} · ${countMeta}`
            : countMeta,
        coverFile: primaryTrack?.cover_file || null,
        externalCoverUrl: !primaryTrack?.cover_file ? primaryTrack?.coverUrl || null : null,
        fallbackColor:
          primaryTrack?.dominant_color ||
          (theme === 'tidal-dark' ? '#092226' : theme === 'spotify-dark' ? '#1c4230' : '#4a1722'),
      };
    }

    if (playlists.length > 0) {
      const pl = playlists[0];
      const trackLabel = `${pl.track_count} ${pl.track_count === 1 ? 'track' : 'tracks'}`;
      return {
        kind: 'playlist' as const,
        playlist: pl,
        eyebrow: 'FEATURED PLAYLIST',
        title: pl.name,
        subtitle: pl.description ? `${pl.description} · ${trackLabel}` : trackLabel,
        coverFile: pl.covers?.[0] || null,
        externalCoverUrl: null as string | null,
        fallbackColor:
          theme === 'tidal-dark' ? '#092226' : theme === 'spotify-dark' ? '#1c4230' : '#4a1722',
      };
    }

    return {
      kind: 'empty' as const,
      playlist: null as Playlist | null,
      eyebrow: 'MY SOUNDTRACK',
      title: offline ? 'Offline Playlists' : 'My Soundtrack',
      subtitle: offline
        ? 'Download playlists while online to listen in Airplane Mode.'
        : 'Create your first playlist or import .m3u collections from your music library.',
      coverFile: null as string | null,
      externalCoverUrl: null as string | null,
      fallbackColor:
        theme === 'tidal-dark' ? '#092226' : theme === 'spotify-dark' ? '#1b3a2b' : '#4a1722',
    };
  }, [
    currentTrack,
    offline,
    playlists,
    recentArtists.length,
    recentPlaylists,
    soundtrackCovers,
    soundtrackDuration,
    soundtrackSubtitle,
    soundtrackTracks,
    theme,
  ]);

  // Resolve offline hero cover blob when offline
  useEffect(() => {
    setHeroOfflineCoverUrl(null);
    setHeroImageErrored(false);
    if (!featuredHero.coverFile || !offline) return;
    let cancelled = false;
    void getOfflineCoverBlobUrl(featuredHero.coverFile).then((url) => {
      if (!cancelled && url) setHeroOfflineCoverUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [featuredHero.coverFile, offline]);

  const heroImageSrc = useMemo(() => {
    if (heroOfflineCoverUrl) return heroOfflineCoverUrl;
    if (featuredHero.coverFile) return getCoverUrl(featuredHero.coverFile);
    if (featuredHero.externalCoverUrl) return featuredHero.externalCoverUrl;
    if (currentTrack) return getTrackCoverUrl(currentTrack);
    return null;
  }, [currentTrack, featuredHero.coverFile, featuredHero.externalCoverUrl, heroOfflineCoverUrl]);

  const heroColorCacheKey = useMemo(() => {
    if (featuredHero.coverFile) return `cover:${featuredHero.coverFile}`;
    if (featuredHero.externalCoverUrl) return `ext-cover:${featuredHero.externalCoverUrl}`;
    return null;
  }, [featuredHero.coverFile, featuredHero.externalCoverUrl]);

  // Sample hero artwork dominant color for seamless `<meta name="theme-color">` sync
  useEffect(() => {
    if (!heroColorCacheKey || !heroImageSrc) {
      setHeroSampledColor(featuredHero.fallbackColor);
      return;
    }

    const cached = getCachedDominantColor(heroColorCacheKey);
    if (cached) {
      setHeroSampledColor(cached);
      return;
    }

    setHeroSampledColor(featuredHero.fallbackColor);
    let cancelled = false;
    void extractDominantColorFromImage(
      heroImageSrc,
      heroColorCacheKey,
      undefined,
      featuredHero.fallbackColor
    ).then((hex) => {
      if (!cancelled) setHeroSampledColor(hex);
    });

    return () => {
      cancelled = true;
    };
  }, [featuredHero.fallbackColor, heroColorCacheKey, heroImageSrc]);

  const heroTopHex = useMemo(() => {
    if (isTidal) return '#000000';
    const raw =
      (heroColorCacheKey ? getCachedDominantColor(heroColorCacheKey) : null) ||
      heroSampledColor ||
      featuredHero.fallbackColor;
    return isLight ? computeLightTintedTopHex(raw, 0.24) : computeNowPlayingTopHex(raw);
  }, [featuredHero.fallbackColor, heroColorCacheKey, heroSampledColor, isLight, isTidal]);

  useLayoutEffect(() => {
    setDocumentThemeColor(heroTopHex);
  }, [heroTopHex, theme]);

  // Partition playlists cleanly across Row 1 (Your Playlists) and Row 2 (Mixes & Imported / Recently Played)
  const manualPlaylists = useMemo(
    () => playlists.filter((p) => p.source !== 'm3u'),
    [playlists]
  );
  const m3uPlaylists = useMemo(
    () => playlists.filter((p) => p.source === 'm3u'),
    [playlists]
  );

  // If the user has both manual & M3U playlists, Row 1 shows manual playlists and Row 2 shows M3U + smart mixes.
  // If they only have one kind, Row 1 shows all playlists so nothing is empty.
  const primaryPlaylists = manualPlaylists.length > 0 ? manualPlaylists : playlists;
  const secondaryM3uPlaylists = manualPlaylists.length > 0 ? m3uPlaylists : [];

  // Smart mixes built from real user tracks for Row 2
  const smartMixes = useMemo<SmartMixCardData[]>(() => {
    const mixes: SmartMixCardData[] = [];

    // Include "My Soundtrack" card in Row 2 whenever the hero is featuring a specific playlist
    if (featuredHero.kind !== 'soundtrack' && soundtrackTracks.length > 0) {
      mixes.push({
        id: 'mix-soundtrack',
        title: 'My Soundtrack',
        subtitle: soundtrackSubtitle,
        covers: soundtrackCovers,
        variant: 'default',
        tracks: soundtrackTracks,
        shuffleOnPlay: true,
        onCardClick: () => onPlayTracks(soundtrackTracks, true),
      });
    }

    const likedTracks = tracks.filter((t) => t.liked);
    if (likedTracks.length > 0) {
      const likedDur = formatHumanDuration(
        likedTracks.reduce((sum, t) => sum + (t.duration || 0), 0)
      );
      mixes.push({
        id: 'mix-liked',
        title: 'Liked Songs',
        subtitle: `${likedTracks.length} ${likedTracks.length === 1 ? 'track' : 'tracks'}${likedDur ? ` · ${likedDur}` : ''}`,
        covers: likedTracks
          .map((t) => t.cover_file)
          .filter((c): c is string => Boolean(c))
          .slice(0, 4),
        variant: 'liked',
        tracks: likedTracks,
        onCardClick: () => onNavigateHomeTab('liked'),
      });
    }

    if (tracks.length > 0 && !offline) {
      const recentTracks = [...tracks]
        .sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''))
        .slice(0, 40);
      const recentCovers: string[] = [];
      for (const t of recentTracks) {
        if (t.cover_file && !recentCovers.includes(t.cover_file)) {
          recentCovers.push(t.cover_file);
          if (recentCovers.length >= 4) break;
        }
      }
      mixes.push({
        id: 'mix-recent',
        title: 'Recently Added',
        subtitle: `${recentTracks.length} ${recentTracks.length === 1 ? 'track' : 'tracks'} · Fresh rotation`,
        covers: recentCovers,
        variant: recentCovers.length > 0 ? 'default' : 'recent',
        tracks: recentTracks,
        onCardClick: () => onNavigateHomeTab('recent'),
      });
    }

    if (cachedTrackIds.size > 0) {
      const offlineTracks = tracks.filter(
        (t) => typeof t.id === 'number' && cachedTrackIds.has(t.id)
      );
      const offlineCovers: string[] = [];
      for (const t of offlineTracks) {
        if (t.cover_file && !offlineCovers.includes(t.cover_file)) {
          offlineCovers.push(t.cover_file);
          if (offlineCovers.length >= 4) break;
        }
      }
      mixes.push({
        id: 'mix-offline',
        title: 'Offline Ready',
        subtitle: `${cachedTrackIds.size} cached ${cachedTrackIds.size === 1 ? 'track' : 'tracks'}`,
        covers: offlineCovers,
        variant: offlineCovers.length > 0 ? 'default' : 'offline',
        tracks: offlineTracks,
        onCardClick: () => onNavigateHomeTab('offline'),
      });
    }

    return mixes;
  }, [
    cachedTrackIds,
    featuredHero.kind,
    offline,
    onNavigateHomeTab,
    onPlayTracks,
    soundtrackCovers,
    soundtrackSubtitle,
    soundtrackTracks,
    tracks,
  ]);

  // Recently played playlists (shown in Row 2 when there are no separate M3U playlists)
  const secondaryRecentPlaylists = useMemo(() => {
    if (secondaryM3uPlaylists.length > 0) return [];
    return recentPlaylists.slice(0, 10);
  }, [recentPlaylists, secondaryM3uPlaylists.length]);

  const secondaryRowTitle =
    secondaryM3uPlaylists.length > 0
      ? 'Mixes & Imported Playlists'
      : secondaryRecentPlaylists.length > 0
        ? 'Mixes & Recently Played'
        : 'Mixes for You';

  const secondaryRowSubtitle =
    secondaryM3uPlaylists.length > 0
      ? `${secondaryM3uPlaylists.length} imported .m3u ${secondaryM3uPlaylists.length === 1 ? 'playlist' : 'playlists'} & library mixes`
      : 'Instant mixes tailored from your library';

  const handleHeroPlay = () => {
    if (featuredHero.kind === 'playlist' && featuredHero.playlist) {
      void handlePlayPlaylistCard(featuredHero.playlist.id, true);
    } else if (featuredHero.kind === 'soundtrack' && soundtrackTracks.length > 0) {
      onPlayTracks(soundtrackTracks, true);
    } else if (!offline) {
      onOpenCreatePlaylist();
    }
  };

  const topSafeScrim = isLight
    ? `linear-gradient(to bottom, ${heroTopHex}e6 0%, ${heroTopHex}73 20%, transparent 45%)`
    : `linear-gradient(to bottom, ${heroTopHex}e0 0%, ${heroTopHex}66 20%, transparent 46%)`;

  const renderPlaylistCard = (pl: Playlist, keyPrefix: string) => {
    const isMenuOpen = menuState?.playlist.id === pl.id;
    const subtitleText = pl.description
      ? pl.description
      : pl.source === 'm3u'
        ? `M3U · ${pl.track_count} ${pl.track_count === 1 ? 'track' : 'tracks'}`
        : `${pl.track_count} ${pl.track_count === 1 ? 'track' : 'tracks'}`;

    return (
      <div
        key={`${keyPrefix}-${pl.id}`}
        role="button"
        tabIndex={0}
        onClick={() => handleOpenPlaylistCard(pl.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleOpenPlaylistCard(pl.id);
          }
        }}
        className="group w-40 sm:w-44 shrink-0 snap-start text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-xl"
      >
        <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-[var(--bg-secondary)] shadow-md ring-1 ring-[var(--border-subtle)]">
          <PlaylistMosaic
            covers={pl.covers || []}
            alt={pl.name}
            className="w-full h-full rounded-xl transition-transform duration-300 ease-out group-hover:scale-[1.03]"
          />

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handlePlayPlaylistCard(pl.id, false);
            }}
            className="absolute bottom-2.5 right-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xl opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 focus-visible:opacity-100 focus-visible:translate-y-0 hover:bg-[var(--accent-hover)] hover:scale-105 active:scale-95 transition-all"
            aria-label={`Play ${pl.name}`}
          >
            <Play className="w-4 h-4 fill-current ml-0.5" />
          </button>
        </div>

        <div className="mt-2.5 flex items-start justify-between gap-1">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-[var(--text-primary)] truncate leading-snug">
              {pl.name}
            </p>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)] truncate">{subtitleText}</p>
          </div>

          {!offline && (
            <button
              type="button"
              disabled={exportingPlaylistId === pl.id}
              onClick={(e) => openPlaylistMenu(e, pl)}
              aria-expanded={isMenuOpen}
              aria-label={`Options for ${pl.name}`}
              className={`flex h-8 w-8 -mr-1 -mt-0.5 shrink-0 items-center justify-center rounded-full transition-colors ${
                isMenuOpen
                  ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]'
              }`}
            >
              {exportingPlaylistId === pl.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
              ) : (
                <MoreHorizontal className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-full">
      {/* FULL-BLEED IMMERSIVE TOP HERO CARD (extends behind status bar via env(safe-area-inset-top)) */}
      <section
        className="relative w-full overflow-hidden min-h-[350px] sm:min-h-[400px] lg:min-h-[430px] flex flex-col justify-between"
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          backgroundColor: heroTopHex,
        }}
      >
        {/* Full-bleed Artwork Backdrop */}
        {heroImageSrc && !heroImageErrored ? (
          <img
            src={heroImageSrc}
            alt={featuredHero.title}
            referrerPolicy="no-referrer"
            onError={() => setHeroImageErrored(true)}
            className="absolute inset-0 h-full w-full object-cover object-center scale-[1.02] select-none pointer-events-none"
          />
        ) : (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: isLight
                ? `radial-gradient(circle at 22% 20%, ${heroTopHex} 0%, #f5e6ea 55%, var(--bg-primary) 100%)`
                : `radial-gradient(circle at 22% 20%, ${featuredHero.fallbackColor} 0%, ${heroTopHex} 48%, var(--bg-primary) 100%)`,
            }}
          />
        )}

        {/* Top Safe-Area Scrim (blends seamlessly with meta[name="theme-color"]) */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{background: topSafeScrim}}
          aria-hidden="true"
        />

        {/* Smooth Bottom Fade into Active Theme Base Canvas (--bg-primary) */}
        <div
          className="absolute inset-0 pointer-events-none [background:var(--hub-bottom-fade)]"
          aria-hidden="true"
        />

        {/* Top Safe-Area Header Row */}
        <div className="relative z-10 w-full max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 pt-3.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="font-display text-lg sm:text-xl font-extrabold tracking-tight text-[var(--hub-header-text)] [filter:var(--hub-header-filter)]">
              {offline ? 'Offline Playlists' : 'Playlists'}
            </span>
          </div>

          {!offline && (
            <button
              type="button"
              onClick={onOpenCreatePlaylist}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-3.5 sm:px-4 text-xs font-bold backdrop-blur-md transition-all whitespace-nowrap shrink-0 bg-[var(--hub-btn-bg)] hover:bg-[var(--hub-btn-bg-hover)] text-[var(--hub-btn-text)] border border-[var(--hub-btn-border)] shadow-[var(--hub-btn-shadow)]"
              aria-label="Create Playlist"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>Create Playlist</span>
            </button>
          )}
        </div>

        {/* Bottom Hero Footer: Eyebrow + Bold Title + Subtitle | Circular Accent Play Button */}
        <div className="relative z-10 w-full max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 pb-6 pt-24 sm:pt-28 flex items-end justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-[11px] sm:text-xs font-extrabold uppercase tracking-[0.14em] text-[var(--accent)]">
              {featuredHero.eyebrow}
            </p>

            {featuredHero.kind === 'playlist' && featuredHero.playlist ? (
              <button
                type="button"
                onClick={() => handleOpenPlaylistCard(featuredHero.playlist!.id)}
                className="block max-w-2xl text-left focus-visible:outline-none focus-visible:underline"
              >
                <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-[var(--text-primary)] leading-[1.06] text-balance line-clamp-2">
                  {featuredHero.title}
                </h1>
              </button>
            ) : (
              <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-[var(--text-primary)] leading-[1.06] max-w-2xl text-balance line-clamp-2">
                {featuredHero.title}
              </h1>
            )}

            <p className="text-xs sm:text-sm font-medium text-[var(--text-secondary)] max-w-xl line-clamp-2">
              {featuredHero.subtitle}
            </p>
          </div>

          <div className="shrink-0 flex items-center gap-2.5 pb-0.5">
            {featuredHero.kind !== 'empty' ? (
              <button
                type="button"
                onClick={handleHeroPlay}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xl hover:bg-[var(--accent-hover)] hover:scale-105 active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
                aria-label={`Play ${featuredHero.title}`}
                title={`Play & shuffle ${featuredHero.title}`}
              >
                <Play className="w-6 h-6 fill-current ml-0.5" />
              </button>
            ) : !offline ? (
              <button
                type="button"
                onClick={onOpenCreatePlaylist}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xl hover:bg-[var(--accent-hover)] hover:scale-105 active:scale-95 transition-all"
                aria-label="Create first playlist"
                title="Create first playlist"
              >
                <Plus className="w-6 h-6 stroke-[2.5]" />
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {/* HORIZONTAL SIDEWAYS-SCROLLING CAROUSELS */}
      <div className="w-full max-w-[1680px] mx-auto px-4 sm:px-6 lg:px-8 pt-2 space-y-8">
        {/* ROW 1: Your Playlists */}
        <HorizontalCarouselSection
          title={offline ? 'Offline Playlists' : 'Your Playlists'}
          subtitle={
            playlists.length > 0
              ? `${primaryPlaylists.length} ${primaryPlaylists.length === 1 ? 'playlist' : 'playlists'}${
                  !offline && totalTrackCount > 0
                    ? ` · ${totalTrackCount} library ${totalTrackCount === 1 ? 'track' : 'tracks'}`
                    : ''
                }`
              : undefined
          }
        >
          {loading && playlists.length === 0 ? (
            Array.from({length: 5}).map((_, idx) => (
              <div key={idx} className="w-40 sm:w-44 shrink-0 snap-start space-y-2.5 animate-pulse">
                <div className="w-full aspect-square rounded-xl bg-[var(--bg-secondary)]" />
                <div className="h-3.5 w-3/4 rounded bg-[var(--bg-secondary)]" />
                <div className="h-3 w-1/2 rounded bg-[var(--bg-secondary)]" />
              </div>
            ))
          ) : primaryPlaylists.length === 0 ? (
            <div className="w-full rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-elevated)] text-[var(--accent)]">
                  <Disc3 className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <p className="font-display text-base font-bold text-[var(--text-primary)]">
                    {offline ? 'No offline playlists cached' : 'No playlists created yet'}
                  </p>
                  <p className="text-xs sm:text-sm text-[var(--text-secondary)] mt-0.5 max-w-lg">
                    {offline
                      ? 'Open any playlist while online and tap Download Playlist Offline to listen without a connection.'
                      : 'Create custom collections or place .m3u / .m3u8 files inside your music folder and scan.'}
                  </p>
                </div>
              </div>

              {!offline && (
                <button
                  type="button"
                  onClick={onOpenCreatePlaylist}
                  className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[var(--accent)] px-5 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus className="w-4 h-4 stroke-[2.5]" />
                  <span>Create First Playlist</span>
                </button>
              )}
            </div>
          ) : (
            primaryPlaylists.map((pl) => renderPlaylistCard(pl, 'your'))
          )}
        </HorizontalCarouselSection>

        {/* ROW 2: Mixes & Imported Playlists / Mixes & Recently Played */}
        {(secondaryM3uPlaylists.length > 0 ||
          secondaryRecentPlaylists.length > 0 ||
          smartMixes.length > 0) && (
          <HorizontalCarouselSection title={secondaryRowTitle} subtitle={secondaryRowSubtitle}>
            {/* Imported M3U Playlists (when separated from manual playlists) */}
            {secondaryM3uPlaylists.map((pl) => renderPlaylistCard(pl, 'm3u'))}

            {/* Recently Played Playlists (when no separate M3U partition) */}
            {secondaryRecentPlaylists.map((pl) => renderPlaylistCard(pl, 'recent'))}

            {/* Generated Library Mixes */}
            {smartMixes.map((mix) => (
              <div
                key={mix.id}
                role="button"
                tabIndex={0}
                onClick={mix.onCardClick}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    mix.onCardClick();
                  }
                }}
                className="group w-40 sm:w-44 shrink-0 snap-start text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-xl"
              >
                <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-[var(--bg-secondary)] shadow-md ring-1 ring-[var(--border-subtle)]">
                  {mix.variant === 'offline' && mix.covers.length === 0 ? (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-emerald-600 via-teal-800 to-[#0e241d]">
                      <HardDriveDownload className="w-12 h-12 text-white drop-shadow-md" />
                    </div>
                  ) : mix.variant === 'liked' ? (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#4f39f6] via-[#32468a] to-[var(--accent)]">
                      <Heart className="w-12 h-12 text-white fill-white drop-shadow-md" />
                    </div>
                  ) : mix.variant === 'recent' && mix.covers.length === 0 ? (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[var(--accent)] via-[#1c4b32] to-[#121212]">
                      <Clock className="w-12 h-12 text-white drop-shadow-md" />
                    </div>
                  ) : mix.covers.length > 0 ? (
                    <PlaylistMosaic
                      covers={mix.covers}
                      alt={mix.title}
                      className="w-full h-full rounded-xl transition-transform duration-300 ease-out group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-[var(--bg-elevated)]">
                      {mix.id === 'mix-soundtrack' ? (
                        <Sparkles className="w-11 h-11 text-[var(--accent)]" />
                      ) : (
                        <Music2 className="w-11 h-11 text-[var(--text-muted)]" />
                      )}
                    </div>
                  )}

                  {mix.tracks.length > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayTracks(mix.tracks, Boolean(mix.shuffleOnPlay));
                      }}
                      className="absolute bottom-2.5 right-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xl opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 focus-visible:opacity-100 focus-visible:translate-y-0 hover:bg-[var(--accent-hover)] hover:scale-105 active:scale-95 transition-all"
                      aria-label={`Play ${mix.title}`}
                    >
                      {mix.shuffleOnPlay ? (
                        <Shuffle className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      )}
                    </button>
                  )}
                </div>

                <div className="mt-2.5 min-w-0">
                  <p className="text-sm font-bold text-[var(--text-primary)] truncate leading-snug">
                    {mix.title}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--text-secondary)] truncate">
                    {mix.subtitle}
                  </p>
                </div>
              </div>
            ))}
          </HorizontalCarouselSection>
        )}
      </div>

      {/* Viewport-anchored Playlist Options Menu (never clipped by horizontal scroll containers) */}
      {menuState && !offline && (
        <div
          ref={menuPopoverRef}
          style={{top: `${menuState.top}px`, left: `${menuState.left}px`}}
          className="fixed z-50 w-48 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] p-1.5 shadow-2xl"
        >
          <button
            type="button"
            onClick={() => {
              const target = menuState.playlist;
              setMenuState(null);
              void onExportM3u(target);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <FileDown className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <span>Export as .m3u</span>
          </button>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={() => {
              const targetId = menuState.playlist.id;
              setMenuState(null);
              void onDeletePlaylist(targetId);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-[var(--danger-text)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            <span>Delete Playlist</span>
          </button>
        </div>
      )}
    </div>
  );
};
