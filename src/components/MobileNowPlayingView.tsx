import {
  ArrowRightLeft,
  Check,
  Download,
  Heart,
  ListMusic,
  ListPlus,
  Loader2,
  Mic2,
  MonitorSpeaker,
  MoreHorizontal,
  Music2,
  Plus,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  User,
  X,
} from 'lucide-react';
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {useBackClose} from '../lib/backStack';
import {formatDuration} from '../lib/api';
import type {SwipeTrackGestureResult} from '../hooks/useSwipeTrackGesture';
import type {LrcLine, RepeatMode, Track} from '../types';
import {AlbumArt} from './AlbumArt';

interface ParsedLyrics {
  isSynced: boolean;
  lines: LrcLine[];
}

export interface MobileNowPlayingViewProps {
  activeTrack: Track;
  currentTrack: Track | null;
  isRemoteActive: boolean;
  remoteDeviceName: string | null;
  remoteIsPending: boolean;
  offline: boolean;
  canDownload: boolean;
  isLight: boolean;
  isTidal: boolean;
  dominantTopHexColor: string;
  coverUrl: string | null;
  isYouTubeTrack: boolean;
  ytSaveStatus: 'idle' | 'saving' | 'saved';
  isAddingCurrentToPlaylist: boolean;
  actionToast: string | null;
  activeIsPlaying: boolean;
  activeTime: number;
  activeDuration: number;
  activeShuffle: boolean;
  activeRepeat: RepeatMode;
  radioMode: boolean;
  lyricsOpen: boolean;
  lyricsLoading: boolean;
  isInstrumental: boolean;
  parsedLyrics: ParsedLyrics | null;
  activeLyricIndex: number;
  lyricsScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  lyricLineRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  userScrollPauseUntilRef: React.MutableRefObject<number>;
  artworkSwipe: SwipeTrackGestureResult;
  onClose: () => void;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (positionSec: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onToggleLyrics: () => void;
  onOpenDevices: () => void;
  onOpenQueue: () => void;
  onToggleLike: (trackId: number | string) => void;
  onSaveToLibrary: () => void;
  onOpenPlaylistPicker: () => void;
  onAddToQueue: () => void;
  onToggleRadio: () => void;
  onGoToArtist: () => void;
  onPlayHereQuick: () => void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function formatCodecLabel(format: string | undefined, isYouTube: boolean): string {
  const raw = (format || '').trim().toLowerCase();
  if (!raw) return isYouTube ? 'Online' : 'Audio';
  switch (raw) {
    case 'opus':
    case 'webm':
      return 'Opus';
    case 'flac':
      return 'FLAC';
    case 'mp3':
      return 'MP3';
    case 'aac':
    case 'm4a':
    case 'mp4':
      return 'AAC';
    case 'alac':
      return 'ALAC';
    case 'ogg':
    case 'oga':
      return 'OGG';
    case 'wav':
      return 'WAV';
    case 'web':
      return 'Online';
    case 'audio':
      return 'Audio';
    default:
      return raw.toUpperCase();
  }
}

function formatQualityPill(track: Track, isYouTube: boolean): string {
  const codec = formatCodecLabel(track.format, isYouTube);
  if (track.bitrate && track.bitrate > 0) {
    return `${codec} ${Math.round(track.bitrate)} kbps`;
  }
  return isYouTube && codec !== 'Online' ? `${codec} · Online` : codec;
}

/* Rounded iOS-style filled transport glyphs (no circular backgrounds) */
const IosPrevGlyph: React.FC = () => (
  <svg
    viewBox="0 0 44 28"
    className="w-[34px] h-[22px] min-[390px]:w-[38px] min-[390px]:h-[24px]"
    aria-hidden="true"
  >
    <path
      d="M22.2 6.15c0-1.92-2.12-3.08-3.76-2.06L4.82 12.04a2.3 2.3 0 0 0 0 3.92l13.62 7.95c1.64 1.02 3.76-.14 3.76-2.06V6.15Z"
      fill="currentColor"
    />
    <path
      d="M40.5 6.15c0-1.92-2.12-3.08-3.76-2.06L23.12 12.04a2.3 2.3 0 0 0 0 3.92l13.62 7.95c1.64 1.02 3.76-.14 3.76-2.06V6.15Z"
      fill="currentColor"
    />
  </svg>
);

const IosNextGlyph: React.FC = () => (
  <svg
    viewBox="0 0 44 28"
    className="w-[34px] h-[22px] min-[390px]:w-[38px] min-[390px]:h-[24px]"
    aria-hidden="true"
  >
    <path
      d="M3.5 6.15c0-1.92 2.12-3.08 3.76-2.06l13.62 7.95a2.3 2.3 0 0 1 0 3.92L7.26 23.91C5.62 24.93 3.5 23.77 3.5 21.85V6.15Z"
      fill="currentColor"
    />
    <path
      d="M21.8 6.15c0-1.92 2.12-3.08 3.76-2.06l13.62 7.95a2.3 2.3 0 0 1 0 3.92l-13.62 7.95c-1.64 1.02-3.76-.14-3.76-2.06V6.15Z"
      fill="currentColor"
    />
  </svg>
);

const IosPlayGlyph: React.FC = () => (
  <svg
    viewBox="0 0 48 48"
    className="w-[54px] h-[54px] min-[390px]:w-[62px] min-[390px]:h-[62px]"
    aria-hidden="true"
  >
    <path
      d="M13 13.2C13 10.55 15.86 8.88 18.17 10.18L35.85 20.98C38.05 22.32 38.05 25.68 35.85 27.02L18.17 37.82C15.86 39.12 13 37.45 13 34.8Z"
      fill="currentColor"
    />
  </svg>
);

const IosPauseGlyph: React.FC = () => (
  <svg
    viewBox="0 0 48 48"
    className="w-[54px] h-[54px] min-[390px]:w-[62px] min-[390px]:h-[62px]"
    aria-hidden="true"
  >
    <rect x="12.5" y="9.5" width="8.5" height="29" rx="3.2" fill="currentColor" />
    <rect x="27" y="9.5" width="8.5" height="29" rx="3.2" fill="currentColor" />
  </svg>
);

export const MobileNowPlayingView: React.FC<MobileNowPlayingViewProps> = ({
  activeTrack,
  currentTrack,
  isRemoteActive,
  remoteDeviceName,
  remoteIsPending,
  offline,
  canDownload,
  isLight,
  isTidal,
  dominantTopHexColor,
  coverUrl,
  isYouTubeTrack,
  ytSaveStatus,
  isAddingCurrentToPlaylist,
  actionToast,
  activeIsPlaying,
  activeTime,
  activeDuration,
  activeShuffle,
  activeRepeat,
  radioMode,
  lyricsOpen,
  lyricsLoading,
  isInstrumental,
  parsedLyrics,
  activeLyricIndex,
  userScrollPauseUntilRef,
  artworkSwipe,
  onClose,
  onTogglePlay,
  onNext,
  onPrev,
  onSeek,
  onToggleShuffle,
  onCycleRepeat,
  onToggleLyrics,
  onOpenDevices,
  onOpenQueue,
  onToggleLike,
  onSaveToLibrary,
  onOpenPlaylistPicker,
  onAddToQueue,
  onToggleRadio,
  onGoToArtist,
  onPlayHereQuick,
}) => {
  // "..." Context Action Sheet state
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const closeMoreMenu = useCallback(() => setMoreMenuOpen(false), []);
  useBackClose(moreMenuOpen, closeMoreMenu);

  // Thick knobless scrubber state (grows from 6px -> 10px & shows drag time)
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const scrubPointerIdRef = useRef<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState<number>(activeTime);
  const [scrubPct, setScrubPct] = useState<number>(0);

  const computeTimeFromClientX = useCallback(
    (clientX: number): {time: number; pct: number} => {
      const el = scrubberRef.current;
      if (!el || activeDuration <= 0) return {time: 0, pct: 0};
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
      return {time: ratio * activeDuration, pct: ratio * 100};
    },
    [activeDuration]
  );

  const handleScrubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (activeDuration <= 0) return;
      e.stopPropagation();
      scrubPointerIdRef.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable
      }
      const next = computeTimeFromClientX(e.clientX);
      setScrubTime(next.time);
      setScrubPct(next.pct);
      setIsScrubbing(true);
    },
    [activeDuration, computeTimeFromClientX]
  );

  const handleScrubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (scrubPointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();
      const next = computeTimeFromClientX(e.clientX);
      setScrubTime(next.time);
      setScrubPct(next.pct);
    },
    [computeTimeFromClientX]
  );

  const finishScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      if (scrubPointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();
      scrubPointerIdRef.current = null;
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }
      const finalPos = computeTimeFromClientX(e.clientX);
      setIsScrubbing(false);
      if (!cancelled && activeDuration > 0) {
        onSeek(finalPos.time);
      }
    },
    [activeDuration, computeTimeFromClientX, onSeek]
  );

  const handleScrubKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (activeDuration <= 0) return;
      const step = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        onSeek(Math.min(activeDuration, activeTime + step));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        onSeek(Math.max(0, activeTime - step));
      } else if (e.key === 'Home') {
        e.preventDefault();
        onSeek(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        onSeek(activeDuration);
      }
    },
    [activeDuration, activeTime, onSeek]
  );

  // Swipe-down-to-close gesture on handle & artwork area (harmonizes with horizontal artwork swipe)
  const [dismissOffsetY, setDismissOffsetY] = useState(0);
  const [dismissPhase, setDismissPhase] = useState<'idle' | 'dragging' | 'spring' | 'closing'>('idle');
  const dismissPointerIdRef = useRef<number | null>(null);
  const dismissStartXRef = useRef(0);
  const dismissStartYRef = useRef(0);
  const dismissLastYRef = useRef(0);
  const dismissLastTimeRef = useRef(0);
  const dismissVelocityYRef = useRef(0);
  const dismissAxisRef = useRef<'none' | 'vertical' | 'horizontal'>('none');
  const suppressHandleClickUntilRef = useRef(0);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  const startDismissPointer = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    dismissPointerIdRef.current = e.pointerId;
    dismissStartXRef.current = e.clientX;
    dismissStartYRef.current = e.clientY;
    dismissLastYRef.current = e.clientY;
    dismissLastTimeRef.current = performance.now();
    dismissVelocityYRef.current = 0;
    dismissAxisRef.current = 'none';
  }, []);

  const moveDismissPointer = useCallback(
    (e: React.PointerEvent<HTMLElement>, allowFromHandle: boolean) => {
      if (dismissPointerIdRef.current !== e.pointerId) return;
      const dx = e.clientX - dismissStartXRef.current;
      const dy = e.clientY - dismissStartYRef.current;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (dismissAxisRef.current === 'horizontal') return;

      if (dismissAxisRef.current === 'none') {
        const threshold = allowFromHandle ? 6 : 12;
        if (absDx < threshold && absDy < threshold) return;
        // Only lock into vertical dismiss when pulling downward clearly more than horizontally
        if (dy > 0 && dy > absDx * 1.15) {
          dismissAxisRef.current = 'vertical';
          suppressHandleClickUntilRef.current = Date.now() + 350;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Ignore
          }
        } else {
          dismissAxisRef.current = 'horizontal';
          return;
        }
      }

      const now = performance.now();
      const dt = Math.max(now - dismissLastTimeRef.current, 1);
      const instantVy = (e.clientY - dismissLastYRef.current) / dt;
      dismissVelocityYRef.current = dismissVelocityYRef.current * 0.35 + instantVy * 0.65;
      dismissLastYRef.current = e.clientY;
      dismissLastTimeRef.current = now;

      const clampedDy = Math.max(0, dy);
      setDismissPhase('dragging');
      setDismissOffsetY(prefersReducedMotion() ? 0 : clampedDy);
    },
    []
  );

  const endDismissPointer = useCallback(
    (e: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
      if (dismissPointerIdRef.current !== e.pointerId) return;
      const wasVertical = dismissAxisRef.current === 'vertical';
      const dy = Math.max(0, e.clientY - dismissStartYRef.current);
      const vy = dismissVelocityYRef.current;

      dismissPointerIdRef.current = null;
      dismissAxisRef.current = 'none';
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }

      if (!wasVertical) return;

      const shouldDismiss = !cancelled && (dy > 84 || (dy > 32 && vy > 0.55));
      if (shouldDismiss) {
        if (prefersReducedMotion()) {
          setDismissOffsetY(0);
          setDismissPhase('idle');
          onClose();
          return;
        }
        setDismissPhase('closing');
        setDismissOffsetY(Math.max(window.innerHeight * 0.45, 320));
        dismissTimerRef.current = window.setTimeout(() => {
          dismissTimerRef.current = null;
          onClose();
        }, 160);
      } else {
        setDismissPhase('spring');
        setDismissOffsetY(0);
        dismissTimerRef.current = window.setTimeout(() => {
          dismissTimerRef.current = null;
          setDismissPhase('idle');
        }, 230);
      }
    },
    [onClose]
  );

  const displayTime = isScrubbing ? scrubTime : activeTime;
  const displayProgressPct = isScrubbing
    ? scrubPct
    : activeDuration > 0
      ? Math.min(100, Math.max(0, (activeTime / activeDuration) * 100))
      : 0;
  const displayRemaining = Math.max(0, (activeDuration || 0) - displayTime);
  const qualityPillLabel = formatQualityPill(activeTrack, isYouTubeTrack);

  const playingFromLabel =
    isRemoteActive && remoteDeviceName
      ? `Playing from ${remoteDeviceName}`
      : isYouTubeTrack
        ? `Playing from ${activeTrack.album ? `${activeTrack.album} · Online` : 'Online Stream'}`
        : `Playing from ${activeTrack.album || 'Library'}`;

  const sheetTransition =
    dismissPhase === 'spring'
      ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease-out'
      : dismissPhase === 'closing'
        ? 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms ease-out'
        : 'none';

  const sheetOpacity =
    dismissPhase === 'closing'
      ? 0.25
      : dismissPhase === 'dragging'
        ? Math.max(0.55, 1 - dismissOffsetY / 520)
        : 1;

  const showSaveAsPrimary =
    !isRemoteActive && Boolean(currentTrack) && isYouTubeTrack && canDownload && !offline;
  const showLikeAsPrimary = !isRemoteActive && Boolean(currentTrack) && !isYouTubeTrack;

  // Reactive prefers-reduced-motion tracking for lyrics blur, pill motion & scroll easing
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => prefersReducedMotion());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    onChange();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  // Full-screen mobile lyrics scroll, 3s manual-browse pause, and sliding active-line glass pill
  const mobileLyricsScrollRef = useRef<HTMLDivElement | null>(null);
  const mobileLyricLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lyricsScrollAnimRef = useRef<number | null>(null);
  const manualScrollTimerRef = useRef<number | null>(null);
  const lastProgrammaticScrollAtRef = useRef<number>(0);
  const justOpenedLyricsLocalRef = useRef<boolean>(true);
  const hasPositionedPillRef = useRef<boolean>(false);

  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [lyricsViewportHeight, setLyricsViewportHeight] = useState(0);
  const [pillRect, setPillRect] = useState<{top: number; height: number} | null>(null);

  const cancelLyricsScrollAnim = useCallback(() => {
    if (lyricsScrollAnimRef.current !== null) {
      window.cancelAnimationFrame(lyricsScrollAnimRef.current);
      lyricsScrollAnimRef.current = null;
    }
  }, []);

  const clearManualScrollPause = useCallback(() => {
    if (manualScrollTimerRef.current !== null) {
      window.clearTimeout(manualScrollTimerRef.current);
      manualScrollTimerRef.current = null;
    }
    userScrollPauseUntilRef.current = 0;
    setIsUserScrolling(false);
  }, [userScrollPauseUntilRef]);

  const pauseAutoScrollForManualBrowse = useCallback(() => {
    cancelLyricsScrollAnim();
    setIsUserScrolling(true);
    userScrollPauseUntilRef.current = Date.now() + 3000;
    if (manualScrollTimerRef.current !== null) {
      window.clearTimeout(manualScrollTimerRef.current);
    }
    manualScrollTimerRef.current = window.setTimeout(() => {
      manualScrollTimerRef.current = null;
      userScrollPauseUntilRef.current = 0;
      setIsUserScrolling(false);
    }, 3000);
  }, [cancelLyricsScrollAnim, userScrollPauseUntilRef]);

  const handleLyricsContainerScroll = useCallback(() => {
    if (performance.now() - lastProgrammaticScrollAtRef.current < 80) return;
    pauseAutoScrollForManualBrowse();
  }, [pauseAutoScrollForManualBrowse]);

  // Cleanup animation frames & timers on unmount
  useEffect(() => {
    return () => {
      cancelLyricsScrollAnim();
      if (manualScrollTimerRef.current !== null) {
        window.clearTimeout(manualScrollTimerRef.current);
      }
    };
  }, [cancelLyricsScrollAnim]);

  // Reset scroll/pill state when lyrics mode toggles or track changes
  useEffect(() => {
    cancelLyricsScrollAnim();
    clearManualScrollPause();
    justOpenedLyricsLocalRef.current = true;
    hasPositionedPillRef.current = false;
    mobileLyricLineRefs.current = [];
    if (!lyricsOpen) {
      setPillRect(null);
    }
  }, [lyricsOpen, activeTrack.id, cancelLyricsScrollAnim, clearManualScrollPause]);

  // Observe lyrics viewport height so first & last lines can always reach the 38% focal point
  useEffect(() => {
    if (!lyricsOpen) return;
    const container = mobileLyricsScrollRef.current;
    if (!container) return;

    const updateHeight = () => {
      setLyricsViewportHeight(container.clientHeight);
    };
    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateHeight);
      ro.observe(container);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [lyricsOpen, lyricsLoading, isInstrumental, parsedLyrics?.isSynced]);

  // Measure active line bounds for the sliding translucent glass pill
  useLayoutEffect(() => {
    if (
      !lyricsOpen ||
      lyricsLoading ||
      isInstrumental ||
      !parsedLyrics?.isSynced ||
      activeLyricIndex < 0
    ) {
      setPillRect(null);
      hasPositionedPillRef.current = false;
      return;
    }

    const activeEl = mobileLyricLineRefs.current[activeLyricIndex];
    if (!activeEl) {
      setPillRect(null);
      return;
    }

    setPillRect({
      top: Math.max(0, activeEl.offsetTop - 12),
      height: activeEl.offsetHeight + 24,
    });

    if (!hasPositionedPillRef.current) {
      const rafId = window.requestAnimationFrame(() => {
        hasPositionedPillRef.current = true;
      });
      return () => window.cancelAnimationFrame(rafId);
    }
  }, [
    lyricsOpen,
    lyricsLoading,
    isInstrumental,
    parsedLyrics,
    activeLyricIndex,
    lyricsViewportHeight,
  ]);

  // Smoothly auto-scroll synced lyrics to keep the active line around 38% of the lyrics viewport
  useEffect(() => {
    if (
      !lyricsOpen ||
      lyricsLoading ||
      isInstrumental ||
      !parsedLyrics?.isSynced ||
      activeLyricIndex < 0 ||
      isUserScrolling
    ) {
      return;
    }

    const container = mobileLyricsScrollRef.current;
    const activeEl = mobileLyricLineRefs.current[activeLyricIndex];
    if (!container || !activeEl) return;

    const targetScrollTop = Math.max(
      0,
      activeEl.offsetTop - container.clientHeight * 0.38 + activeEl.offsetHeight * 0.5
    );

    cancelLyricsScrollAnim();

    const shouldJumpInstantly = justOpenedLyricsLocalRef.current || reducedMotion;
    if (lyricsViewportHeight > 0) {
      justOpenedLyricsLocalRef.current = false;
    }

    const startTop = container.scrollTop;
    const delta = targetScrollTop - startTop;

    if (shouldJumpInstantly || Math.abs(delta) < 1) {
      lastProgrammaticScrollAtRef.current = performance.now();
      container.scrollTop = targetScrollTop;
      return;
    }

    const durationMs = 350;
    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      lastProgrammaticScrollAtRef.current = now;
      container.scrollTop = startTop + delta * eased;
      if (t < 1) {
        lyricsScrollAnimRef.current = window.requestAnimationFrame(step);
      } else {
        lyricsScrollAnimRef.current = null;
      }
    };

    lyricsScrollAnimRef.current = window.requestAnimationFrame(step);
    return () => cancelLyricsScrollAnim();
  }, [
    lyricsOpen,
    lyricsLoading,
    isInstrumental,
    parsedLyrics,
    activeLyricIndex,
    isUserScrolling,
    reducedMotion,
    lyricsViewportHeight,
    cancelLyricsScrollAnim,
  ]);

  const lyricsPadTop = lyricsViewportHeight > 0 ? Math.round(lyricsViewportHeight * 0.34) : 140;
  const lyricsPadBottom = lyricsViewportHeight > 0 ? Math.round(lyricsViewportHeight * 0.56) : 220;

  const renderTrackActionButtons = (oledStyle: boolean) => {
    const glassCircleBase = oledStyle
      ? 'flex h-10 w-10 items-center justify-center rounded-full backdrop-blur-md border border-white/15 bg-white/10 transition-colors'
      : 'flex h-10 w-10 items-center justify-center rounded-full backdrop-blur-md border border-[var(--np-glass-btn-border)] bg-[var(--np-glass-btn-bg)] transition-colors';
    const inactiveText = oledStyle ? 'text-white' : 'text-[var(--np-glass-btn-text)]';

    return (
      <div className="flex items-center gap-1 shrink-0">
        {showLikeAsPrimary && currentTrack ? (
          <button
            type="button"
            onClick={() => onToggleLike(currentTrack.id)}
            className="flex h-11 w-11 items-center justify-center rounded-full active:scale-95 transition-transform"
            aria-label={currentTrack.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
            aria-pressed={Boolean(currentTrack.liked)}
          >
            <span
              className={`${glassCircleBase} ${
                currentTrack.liked ? 'text-[var(--accent)]' : inactiveText
              }`}
            >
              <Heart className={`w-5 h-5 ${currentTrack.liked ? 'fill-current' : ''}`} />
            </span>
          </button>
        ) : showSaveAsPrimary ? (
          <button
            type="button"
            disabled={ytSaveStatus === 'saving'}
            onClick={onSaveToLibrary}
            className="flex h-11 w-11 items-center justify-center rounded-full active:scale-95 transition-transform disabled:opacity-60"
            aria-label="Save track"
          >
            <span
              className={`${glassCircleBase} ${
                ytSaveStatus === 'saved' ? 'text-[var(--accent)]' : inactiveText
              }`}
            >
              {ytSaveStatus === 'saving' ? (
                <Loader2 className="w-[18px] h-[18px] animate-spin" />
              ) : ytSaveStatus === 'saved' ? (
                <Check className="w-5 h-5 stroke-[2.5]" />
              ) : (
                <Download className="w-[18px] h-[18px]" />
              )}
            </span>
          </button>
        ) : (
          <button
            type="button"
            disabled
            className="flex h-11 w-11 items-center justify-center rounded-full opacity-40"
            aria-label="Save to Liked Songs"
          >
            <span className={`${glassCircleBase} ${inactiveText}`}>
              <Heart className="w-5 h-5" />
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setMoreMenuOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-full active:scale-95 transition-transform"
          aria-label="More options"
          aria-haspopup="dialog"
          aria-expanded={moreMenuOpen}
        >
          <span className={`${glassCircleBase} ${inactiveText}`}>
            <MoreHorizontal className="w-5 h-5" />
          </span>
        </button>
      </div>
    );
  };

  return (
    <div
      className="relative h-full max-h-full w-full overflow-hidden flex flex-col pt-safe [background:var(--np-canvas-bg)] select-none"
      style={
        {
          '--np-top-hex': dominantTopHexColor,
          background: isTidal
            ? dominantTopHexColor
            : `linear-gradient(180deg, ${dominantTopHexColor} 0%, var(--bg-primary) ${isLight ? '76%' : '72%'})`,
          transform: dismissOffsetY > 0 ? `translateY(${dismissOffsetY}px)` : undefined,
          opacity: sheetOpacity,
          transition: sheetTransition,
          willChange: dismissPhase === 'idle' ? 'auto' : 'transform, opacity',
        } as React.CSSProperties
      }
    >
      {actionToast && (
        <div
          role="status"
          className="fixed top-14 left-1/2 -translate-x-1/2 z-50 rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate"
        >
          {actionToast}
        </div>
      )}

      {/* Subtle Tidal Cyan Ambient Glow on Pure OLED Black */}
      {isTidal && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 72% 42% at 50% 34%, rgba(0, 255, 255, 0.11) 0%, rgba(0, 255, 255, 0.03) 44%, transparent 74%)',
          }}
          aria-hidden="true"
        />
      )}

      {/* Blurred album cover backdrop */}
      {coverUrl && (
        <div
          className="pointer-events-none absolute inset-0 blur-3xl scale-110 bg-cover bg-center opacity-[var(--np-backdrop-opacity)]"
          style={{backgroundImage: `url("${coverUrl}")`}}
          aria-hidden="true"
        />
      )}
      <div
        className="pointer-events-none absolute inset-0 [background:var(--np-scrim)]"
        aria-hidden="true"
      />

      {/* Pure OLED black overlay for lyrics mode with 250ms cross-fade */}
      <div
        className={`pointer-events-none absolute inset-0 z-[1] bg-black mobile-lyrics-fade ${
          lyricsOpen ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden="true"
      />

      {/* 1. Top Centered Drag-Handle Pill (+ Compact Lyrics Header when lyricsOpen) */}
      <header className="relative z-10 shrink-0 flex flex-col items-center pt-1">
        <button
          type="button"
          onClick={() => {
            if (Date.now() < suppressHandleClickUntilRef.current) return;
            onClose();
          }}
          onPointerDown={startDismissPointer}
          onPointerMove={(e) => moveDismissPointer(e, true)}
          onPointerUp={(e) => endDismissPointer(e, false)}
          onPointerCancel={(e) => endDismissPointer(e, true)}
          style={{touchAction: 'none'}}
          className="flex min-h-[44px] min-w-[96px] items-center justify-center rounded-full focus-visible:outline-none"
          aria-label="Back"
        >
          <span
            className={`block h-[5px] w-[36px] rounded-full transition-colors duration-250 ${
              lyricsOpen ? 'bg-white/35' : 'bg-[var(--np-handle-bg)]'
            }`}
            aria-hidden="true"
          />
        </button>

        {isRemoteActive && remoteDeviceName && (
          <div className="px-6 pb-1 flex items-center justify-center">
            <div className="inline-flex items-center gap-2 rounded-full backdrop-blur-md border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1 text-[11px]">
              <MonitorSpeaker className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <span
                className={`font-semibold truncate max-w-[160px] ${
                  lyricsOpen ? 'text-white' : 'text-[var(--text-primary)]'
                }`}
              >
                {remoteDeviceName}
              </span>
              <button
                type="button"
                onClick={onPlayHereQuick}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--accent-contrast)] active:scale-95 transition-transform"
              >
                <ArrowRightLeft className="w-3 h-3" />
                Play here
              </button>
            </div>
          </div>
        )}

        {/* Compact Lyrics Header (cover + title/artist + like & more buttons); swipe down dismisses */}
        {lyricsOpen && (
          <div
            onPointerDown={startDismissPointer}
            onPointerMove={(e) => moveDismissPointer(e, false)}
            onPointerUp={(e) => endDismissPointer(e, false)}
            onPointerCancel={(e) => endDismissPointer(e, true)}
            style={{touchAction: 'none'}}
            className="w-full max-w-[460px] px-6 pt-1 pb-2 flex items-center gap-3.5"
          >
            <AlbumArt
              coverFile={activeTrack.cover_file}
              externalUrl={activeTrack.coverUrl}
              alt={activeTrack.title}
              color={activeTrack.dominant_color}
              className="mobile-lyrics-cover shrink-0 pointer-events-none select-none shadow-lg ring-1 ring-white/10"
              iconSize={28}
            />

            <div className="min-w-0 flex-1 text-left">
              <h1 className="font-display text-[20px] min-[390px]:text-[22px] leading-tight font-semibold tracking-[-0.015em] text-white truncate">
                {activeTrack.title}
              </h1>
              {isYouTubeTrack || isRemoteActive ? (
                <p className="mt-0.5 text-[17px] min-[390px]:text-[20px] leading-snug font-normal text-white/60 truncate">
                  {activeTrack.artist}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={onGoToArtist}
                  className="mt-0.5 block max-w-full text-left text-[17px] min-[390px]:text-[20px] leading-snug font-normal text-white/60 hover:text-white truncate"
                >
                  {activeTrack.artist}
                </button>
              )}
            </div>

            {renderTrackActionButtons(true)}
          </div>
        )}
      </header>

      {/* 2. Full-Screen OLED Lyrics Area OR Centered Artwork */}
      {lyricsOpen ? (
        <section
          aria-label="Song lyrics"
          className="relative z-10 flex-1 min-h-0 w-full max-w-[460px] mx-auto overflow-hidden"
        >
          <div
            ref={mobileLyricsScrollRef}
            onWheel={pauseAutoScrollForManualBrowse}
            onTouchStart={pauseAutoScrollForManualBrowse}
            onTouchMove={pauseAutoScrollForManualBrowse}
            onScroll={handleLyricsContainerScroll}
            className="relative h-full w-full overflow-y-auto no-scrollbar"
            style={{
              touchAction: 'pan-y',
              WebkitOverflowScrolling: 'touch',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent 0%, black 8%, black 90%, transparent 100%)',
              maskImage:
                'linear-gradient(to bottom, transparent 0%, black 8%, black 90%, transparent 100%)',
            }}
          >
            {lyricsLoading ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-white/50">
                <Loader2 className="w-5 h-5 animate-spin text-white/55" />
                <span className="text-sm font-medium">Fetching lyrics...</span>
              </div>
            ) : isInstrumental ? (
              <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-6">
                <Music2 className="w-7 h-7 text-white/45" />
                <p className="font-display text-base font-semibold text-white/75">
                  Instrumental Track
                </p>
                <p className="text-xs text-white/45">Sit back and enjoy the music.</p>
              </div>
            ) : !parsedLyrics || parsedLyrics.lines.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center gap-1.5 px-6">
                <Mic2 className="w-6 h-6 text-white/40 mb-1" />
                <p className="font-display text-sm font-semibold text-white/75">
                  No lyrics found
                </p>
                <p className="text-xs text-white/45 max-w-[240px]">
                  {offline
                    ? 'Reconnect to fetch lyrics online or embed lyrics in the file.'
                    : 'Lyrics are not available for this track yet.'}
                </p>
              </div>
            ) : parsedLyrics.isSynced ? (
              <div
                className="relative px-6"
                style={{
                  paddingTop: `${lyricsPadTop}px`,
                  paddingBottom: `${lyricsPadBottom}px`,
                }}
              >
                {/* Sliding translucent glass pill behind the active line */}
                {pillRect && (
                  <div
                    aria-hidden="true"
                    className={`mobile-lyrics-pill pointer-events-none absolute left-3 right-3 top-0 z-0 ${
                      hasPositionedPillRef.current ? '' : 'mobile-lyrics-pill-instant'
                    }`}
                    style={{
                      transform: `translate3d(0, ${pillRect.top}px, 0)`,
                      height: `${pillRect.height}px`,
                      opacity: isUserScrolling ? 0.45 : 1,
                    }}
                  />
                )}

                <div className="flex flex-col gap-5">
                  {parsedLyrics.lines.map((line, idx) => {
                    const isCurrent = idx === activeLyricIndex;
                    let opacity: number;
                    let blurFilter: string | undefined;

                    if (isUserScrolling) {
                      opacity = isCurrent ? 1 : 0.6;
                      blurFilter = undefined;
                    } else if (activeLyricIndex < 0) {
                      if (idx === 0) opacity = 0.55;
                      else if (idx === 1) opacity = 0.35;
                      else if (idx === 2) opacity = 0.22;
                      else opacity = 0.12;
                      blurFilter = undefined;
                    } else {
                      const d = idx - activeLyricIndex;
                      const absD = Math.abs(d);
                      if (d === 0) {
                        opacity = 1;
                      } else if (d > 0) {
                        opacity = d === 1 ? 0.55 : d === 2 ? 0.35 : d === 3 ? 0.22 : 0.12;
                      } else {
                        opacity =
                          absD === 1 ? 0.3 : absD === 2 ? 0.18 : absD === 3 ? 0.12 : 0.08;
                      }

                      if (!reducedMotion && absD >= 2) {
                        blurFilter =
                          absD === 2 ? 'blur(1px)' : absD === 3 ? 'blur(2px)' : 'blur(3px)';
                      }
                    }

                    return (
                      <button
                        key={`${line.time ?? idx}-${idx}`}
                        ref={(el) => {
                          mobileLyricLineRefs.current[idx] = el;
                        }}
                        type="button"
                        onClick={() => {
                          if (line.time !== null) {
                            clearManualScrollPause();
                            onSeek(line.time);
                          }
                        }}
                        className={`relative z-10 mobile-lyrics-text mobile-lyrics-line block w-full text-left font-display text-white py-1.5 rounded-2xl cursor-pointer active:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
                          isCurrent && !isUserScrolling ? 'mobile-lyrics-active-glow' : ''
                        }`}
                        style={{
                          opacity,
                          filter: blurFilter,
                        }}
                      >
                        {line.text}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="px-6 py-8 flex flex-col gap-5">
                {parsedLyrics.lines.map((line, idx) => (
                  <p
                    key={idx}
                    className="mobile-lyrics-text font-display text-left text-white/80"
                  >
                    {line.text}
                  </p>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : (
        <div
          className="relative z-10 flex-1 min-h-0 flex items-center justify-center px-6 py-1.5"
          style={{touchAction: 'none'}}
          onPointerDown={startDismissPointer}
          onPointerMove={(e) => moveDismissPointer(e, false)}
          onPointerUp={(e) => endDismissPointer(e, false)}
          onPointerCancel={(e) => endDismissPointer(e, true)}
        >
          <div
            {...artworkSwipe.handlers}
            style={{
              ...artworkSwipe.style,
              touchAction: 'none',
            }}
            className="w-[min(62vw,34dvh,300px)] min-[390px]:w-[min(65vw,36dvh,304px)] min-[420px]:w-[min(68vw,38dvh,316px)] aspect-square select-none cursor-grab active:cursor-grabbing"
            aria-label="Swipe left for next track, right for previous track, or down to close"
          >
            <AlbumArt
              coverFile={activeTrack.cover_file}
              externalUrl={activeTrack.coverUrl}
              alt={activeTrack.title}
              color={activeTrack.dominant_color}
              className="w-full h-full rounded-[20px] pointer-events-none select-none shadow-[var(--np-mobile-art-shadow)] ring-1 ring-[var(--np-art-ring)]"
              iconSize={64}
            />
          </div>
        </div>
      )}

      {/* Lower Controls Stack (Title [non-lyrics only], Progress, Transport, Bottom Row) */}
      <div
        className={`relative z-10 shrink-0 w-full mx-auto px-6 flex flex-col ${
          lyricsOpen ? 'max-w-[460px]' : 'max-w-[420px]'
        }`}
      >
        {/* 3. Title Block + Two Round Glass Buttons (Normal mode only; moves to compact header in lyrics mode) */}
        {!lyricsOpen && (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1 text-left">
              <h1 className="font-display text-[22px] min-[390px]:text-[24px] leading-tight font-bold tracking-[-0.015em] text-[var(--text-primary)] truncate">
                {activeTrack.title}
              </h1>
              {isYouTubeTrack || isRemoteActive ? (
                <p className="mt-0.5 text-[18px] min-[390px]:text-[20px] leading-snug font-normal text-[var(--np-artist-text)] truncate">
                  {activeTrack.artist}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={onGoToArtist}
                  className="mt-0.5 block max-w-full text-left text-[18px] min-[390px]:text-[20px] leading-snug font-normal text-[var(--np-artist-text)] hover:text-[var(--text-primary)] truncate"
                >
                  {activeTrack.artist}
                </button>
              )}
            </div>

            {/* Right: 2 Round 40px Glass Buttons (44x44 touch hitboxes) */}
            {renderTrackActionButtons(false)}
          </div>
        )}

        {/* 4. Progress Bar + Time & Quality Pill */}
        <div className={`${lyricsOpen ? 'mt-1' : 'mt-3 min-[390px]:mt-4'} w-full`}>
          <div
            ref={scrubberRef}
            role="slider"
            tabIndex={0}
            aria-label="Seek track position"
            aria-valuemin={0}
            aria-valuemax={Math.round(activeDuration || 0)}
            aria-valuenow={Math.round(displayTime)}
            aria-valuetext={formatDuration(displayTime)}
            onPointerDown={handleScrubPointerDown}
            onPointerMove={handleScrubPointerMove}
            onPointerUp={(e) => finishScrub(e, false)}
            onPointerCancel={(e) => finishScrub(e, true)}
            onKeyDown={handleScrubKeyDown}
            style={{touchAction: 'none'}}
            className="relative flex h-11 w-full items-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] rounded-lg"
          >
            {/* Floating time indicator while dragging */}
            {isScrubbing && (
              <div
                className={`pointer-events-none absolute -top-5 -translate-x-1/2 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums backdrop-blur-md border shadow-sm ${
                  lyricsOpen
                    ? 'border-white/20 bg-white/15 text-white'
                    : 'border-[var(--np-glass-btn-border)] bg-[var(--np-glass-btn-bg)] text-[var(--text-primary)]'
                }`}
                style={{
                  left: `${Math.max(10, Math.min(90, displayProgressPct))}%`,
                }}
              >
                {formatDuration(displayTime)}
              </div>
            )}

            {lyricsOpen ? (
              <div className="relative w-full flex items-center">
                <div
                  className={`w-full rounded-full overflow-hidden bg-white/20 transition-[height] duration-150 ease-out ${
                    isScrubbing ? 'h-[6px]' : 'h-[4px]'
                  }`}
                >
                  <div
                    className="h-full rounded-full bg-white"
                    style={{
                      width: `${displayProgressPct}%`,
                    }}
                  />
                </div>
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.45)] transition-transform duration-150 ${
                    isScrubbing ? 'h-3.5 w-3.5 scale-110' : 'h-3 w-3'
                  }`}
                  style={{
                    left: `${displayProgressPct}%`,
                  }}
                />
              </div>
            ) : (
              <div
                className={`w-full rounded-full overflow-hidden bg-[var(--np-progress-track)] transition-[height] duration-150 ease-out ${
                  isScrubbing ? 'h-[10px]' : 'h-[6px]'
                }`}
              >
                <div
                  className="h-full rounded-full transition-colors duration-150"
                  style={{
                    width: `${displayProgressPct}%`,
                    backgroundColor: isScrubbing
                      ? 'var(--np-progress-fill-active)'
                      : 'var(--np-progress-fill)',
                  }}
                />
              </div>
            )}
          </div>

          <div className="-mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <span
              className={`justify-self-start font-mono text-[11px] font-medium tabular-nums ${
                lyricsOpen ? 'text-white/60' : 'text-[var(--np-time-text)]'
              }`}
            >
              {formatDuration(displayTime)}
            </span>
            <span
              className={`inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-[10px] font-medium tracking-tight tabular-nums leading-tight whitespace-nowrap truncate max-w-[160px] ${
                lyricsOpen
                  ? 'border-white/15 bg-white/[0.08] text-white/70'
                  : 'border-[var(--np-quality-border)] bg-[var(--np-quality-bg)] text-[var(--np-quality-text)]'
              }`}
            >
              {qualityPillLabel}
            </span>
            <span
              className={`justify-self-end font-mono text-[11px] font-medium tabular-nums ${
                lyricsOpen ? 'text-white/60' : 'text-[var(--np-time-text)]'
              }`}
            >
              -{formatDuration(displayRemaining)}
            </span>
          </div>
        </div>

        {/* 5. Transport Row (3 large flat iOS-style rounded icons, no circular backgrounds) */}
        <div
          className={`${
            lyricsOpen ? 'mt-2 min-[390px]:mt-3' : 'mt-5 min-[390px]:mt-7'
          } flex w-full items-center justify-evenly`}
        >
          <button
            type="button"
            onClick={onPrev}
            className={`flex h-14 w-14 items-center justify-center active:scale-90 transition-transform duration-150 ${
              lyricsOpen ? 'text-white' : 'text-[var(--np-transport-color)]'
            }`}
            aria-label="Previous track"
          >
            <IosPrevGlyph />
          </button>

          <button
            type="button"
            onClick={onTogglePlay}
            className={`flex h-[68px] w-[68px] items-center justify-center active:scale-90 transition-transform duration-150 ${
              lyricsOpen ? 'text-white' : 'text-[var(--np-transport-color)]'
            } ${remoteIsPending ? 'opacity-70' : ''}`}
            aria-label={activeIsPlaying ? 'Pause' : 'Play'}
          >
            {activeIsPlaying ? <IosPauseGlyph /> : <IosPlayGlyph />}
          </button>

          <button
            type="button"
            onClick={onNext}
            className={`flex h-14 w-14 items-center justify-center active:scale-90 transition-transform duration-150 ${
              lyricsOpen ? 'text-white' : 'text-[var(--np-transport-color)]'
            }`}
            aria-label="Next track"
          >
            <IosNextGlyph />
          </button>
        </div>

        {/* 6. Volume row intentionally omitted on mobile — hardware buttons control volume */}

        {/* 7. Bottom Action Row (3 round buttons in lyrics mode; 5 quiet icons in normal mode) */}
        {lyricsOpen ? (
          <div className="mt-2 min-[390px]:mt-3 pb-[calc(1.125rem+env(safe-area-inset-bottom,0px))] min-[390px]:pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] flex w-full items-center justify-around">
            <button
              type="button"
              onClick={onToggleLyrics}
              aria-label="Toggle Lyrics"
              aria-pressed={true}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white/20 border border-white/25 backdrop-blur-md text-white active:scale-90 transition-all"
            >
              <Mic2 className="w-[21px] h-[21px]" />
            </button>

            <button
              type="button"
              disabled={offline}
              onClick={onOpenDevices}
              aria-label="Devices"
              aria-pressed={isRemoteActive}
              className={`flex h-11 w-11 items-center justify-center rounded-full active:scale-90 transition-all disabled:opacity-35 ${
                isRemoteActive ? 'text-[var(--accent)]' : 'text-white/65 hover:text-white'
              }`}
            >
              <MonitorSpeaker className="w-[21px] h-[21px]" />
            </button>

            <button
              type="button"
              disabled={isRemoteActive}
              onClick={onOpenQueue}
              aria-label="Open Queue"
              className="flex h-11 w-11 items-center justify-center rounded-full text-white/65 hover:text-white active:scale-90 transition-all disabled:opacity-35"
            >
              <ListMusic className="w-[21px] h-[21px]" />
            </button>
          </div>
        ) : (
          <div className="mt-5 min-[390px]:mt-8 pb-[calc(1.125rem+env(safe-area-inset-bottom,0px))] min-[390px]:pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] flex w-full items-center justify-between">
            <button
              type="button"
              onClick={onToggleShuffle}
              aria-label="Shuffle"
              aria-pressed={activeShuffle}
              className={`flex h-11 w-11 items-center justify-center rounded-full active:scale-90 transition-all ${
                activeShuffle
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--np-quiet-icon)] hover:text-[var(--np-quiet-icon-hover)]'
              }`}
            >
              <Shuffle className="w-[21px] h-[21px]" />
            </button>

            <button
              type="button"
              onClick={onToggleLyrics}
              aria-label="Toggle Lyrics"
              aria-pressed={false}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--np-quiet-icon)] hover:text-[var(--np-quiet-icon-hover)] active:scale-90 transition-all"
            >
              <Mic2 className="w-[21px] h-[21px]" />
            </button>

            <button
              type="button"
              disabled={offline}
              onClick={onOpenDevices}
              aria-label="Devices"
              aria-pressed={isRemoteActive}
              className={`flex h-11 w-11 items-center justify-center rounded-full active:scale-90 transition-all disabled:opacity-35 ${
                isRemoteActive
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--np-quiet-icon)] hover:text-[var(--np-quiet-icon-hover)]'
              }`}
            >
              <MonitorSpeaker className="w-[21px] h-[21px]" />
            </button>

            <button
              type="button"
              disabled={isRemoteActive}
              onClick={onOpenQueue}
              aria-label="Open Queue"
              className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--np-quiet-icon)] hover:text-[var(--np-quiet-icon-hover)] active:scale-90 transition-all disabled:opacity-35"
            >
              <ListMusic className="w-[21px] h-[21px]" />
            </button>

            <button
              type="button"
              onClick={onCycleRepeat}
              aria-label={`Repeat ${activeRepeat}`}
              aria-pressed={activeRepeat !== 'off'}
              className={`flex h-11 w-11 items-center justify-center rounded-full active:scale-90 transition-all ${
                activeRepeat !== 'off'
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--np-quiet-icon)] hover:text-[var(--np-quiet-icon-hover)]'
              }`}
            >
              {activeRepeat === 'one' ? (
                <Repeat1 className="w-[21px] h-[21px]" />
              ) : (
                <Repeat className="w-[21px] h-[21px]" />
              )}
            </button>
          </div>
        )}
      </div>

      {/* "..." Context Action Sheet */}
      {moreMenuOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" data-no-swipe="true">
          <div
            className="fixed inset-0 bg-black/55 backdrop-blur-[2px]"
            onClick={closeMoreMenu}
            aria-hidden="true"
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Track options"
            className="relative z-10 flex w-full max-w-md max-h-[82dvh] flex-col rounded-t-3xl bg-[var(--bg-secondary)] border-t border-x border-[var(--border-subtle)] shadow-2xl overflow-hidden pb-safe"
          >
            {/* Sheet grab handle */}
            <div className="flex justify-center pt-2.5 pb-1">
              <span
                className="h-1 w-9 rounded-full bg-[var(--border-strong)]"
                aria-hidden="true"
              />
            </div>

            {/* Header: Track preview + "Playing from <source>" */}
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-subtle)]">
              <div className="flex items-center gap-3 min-w-0">
                <AlbumArt
                  coverFile={activeTrack.cover_file}
                  externalUrl={activeTrack.coverUrl}
                  alt={activeTrack.title}
                  color={activeTrack.dominant_color}
                  className="h-12 w-12 rounded-xl shrink-0 shadow-sm"
                  iconSize={20}
                />
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-[var(--text-secondary)] truncate">
                    {playingFromLabel}
                  </p>
                  <p className="font-display text-sm font-bold text-[var(--text-primary)] truncate">
                    {activeTrack.title}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] truncate">
                    {activeTrack.artist}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeMoreMenu}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                aria-label="Close options"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Actions */}
            <div className="overflow-y-auto px-3 py-2 space-y-1">
              {!isRemoteActive && currentTrack && (
                <button
                  type="button"
                  onClick={() => {
                    onAddToQueue();
                    closeMoreMenu();
                  }}
                  className="flex w-full min-h-[48px] items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:scale-[0.99] transition-all"
                >
                  <ListPlus className="w-5 h-5 text-[var(--text-secondary)] shrink-0" />
                  <span>Add to queue</span>
                </button>
              )}

              {!offline && !isRemoteActive && currentTrack && (
                <button
                  type="button"
                  onClick={() => {
                    onToggleRadio();
                    closeMoreMenu();
                  }}
                  aria-label={radioMode ? 'Stop Radio' : 'Start Radio'}
                  className="flex w-full min-h-[48px] items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:scale-[0.99] transition-all"
                >
                  <Radio
                    className={`w-5 h-5 shrink-0 ${
                      radioMode ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                    }`}
                  />
                  <span className={radioMode ? 'text-[var(--accent)] font-semibold' : ''}>
                    {radioMode ? 'Stop radio' : 'Start radio'}
                  </span>
                </button>
              )}

              {!isRemoteActive &&
                currentTrack &&
                ((!isYouTubeTrack && typeof currentTrack.id === 'number') ||
                  (isYouTubeTrack && canDownload && !offline)) && (
                  <button
                    type="button"
                    disabled={isAddingCurrentToPlaylist}
                    onClick={() => {
                      closeMoreMenu();
                      onOpenPlaylistPicker();
                    }}
                    aria-label="Add to playlist"
                    className="flex w-full min-h-[48px] items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:scale-[0.99] transition-all disabled:opacity-50"
                  >
                    {isAddingCurrentToPlaylist ? (
                      <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)] shrink-0" />
                    ) : (
                      <Plus className="w-5 h-5 text-[var(--text-secondary)] shrink-0" />
                    )}
                    <span>Add to playlist</span>
                  </button>
                )}

              {showSaveAsPrimary && (
                <button
                  type="button"
                  disabled={ytSaveStatus === 'saving'}
                  onClick={() => {
                    onSaveToLibrary();
                    closeMoreMenu();
                  }}
                  aria-label="Save track"
                  className="flex w-full min-h-[48px] items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:scale-[0.99] transition-all disabled:opacity-50"
                >
                  {ytSaveStatus === 'saving' ? (
                    <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)] shrink-0" />
                  ) : ytSaveStatus === 'saved' ? (
                    <Check className="w-5 h-5 text-[var(--accent)] shrink-0" />
                  ) : (
                    <Download className="w-5 h-5 text-[var(--text-secondary)] shrink-0" />
                  )}
                  <span>{ytSaveStatus === 'saved' ? 'Saved to library' : 'Save to library'}</span>
                </button>
              )}

              {!isYouTubeTrack && !isRemoteActive && (
                <button
                  type="button"
                  onClick={() => {
                    closeMoreMenu();
                    onGoToArtist();
                  }}
                  className="flex w-full min-h-[48px] items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:scale-[0.99] transition-all"
                >
                  <User className="w-5 h-5 text-[var(--text-secondary)] shrink-0" />
                  <span>Go to artist</span>
                </button>
              )}

              {isRemoteActive && remoteDeviceName && (
                <button
                  type="button"
                  onClick={() => {
                    closeMoreMenu();
                    onPlayHereQuick();
                  }}
                  className="flex w-full min-h-[48px] items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)] active:scale-[0.99] transition-all"
                >
                  <ArrowRightLeft className="w-5 h-5 shrink-0" />
                  <span>Play on this device</span>
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
