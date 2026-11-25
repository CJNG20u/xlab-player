import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  Download,
  Heart,
  ListMusic,
  ListPlus,
  Loader2,
  Mic2,
  MonitorSpeaker,
  Music2,
  PanelLeftOpen,
  Radio,
} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {useDesktopLayout} from '../context/DesktopLayoutContext';
import {usePlayer} from '../context/PlayerContext';
import type {LrcLine, Track} from '../types';
import {AlbumArt} from './AlbumArt';
import {DesktopBrowsePane} from './DesktopBrowsePane';
import {QueuePanelContent} from './QueuePanelContent';

interface ParsedLyrics {
  isSynced: boolean;
  lines: LrcLine[];
}

export interface DesktopNowPlayingViewProps {
  activeTrack: Track | null;
  currentTrack: Track | null;
  isRemoteActive: boolean;
  remoteDeviceName: string | null;
  offline: boolean;
  canDownload: boolean;
  isLight: boolean;
  isTidal: boolean;
  dominantTopHexColor: string;
  coverUrl: string | null;
  actionToast: string | null;
  lyricsLoading: boolean;
  isInstrumental: boolean;
  parsedLyrics: ParsedLyrics | null;
  activeLyricIndex: number;
  ytSaveStatus: 'idle' | 'saving' | 'saved';
  isAddingCurrentToPlaylist: boolean;
  onSeek: (pos: number) => void;
  onSaveToLibrary: () => void;
  onOpenPlaylistPicker: () => void;
  onToggleLike: (trackId: number | string) => void;
  onOpenDevices: () => void;
  onPlayHereQuick: () => void;
  onFlashToast: (msg: string) => void;
}

export const DesktopNowPlayingView: React.FC<DesktopNowPlayingViewProps> = ({
  activeTrack,
  currentTrack,
  isRemoteActive,
  remoteDeviceName,
  offline,
  canDownload,
  isLight,
  isTidal,
  dominantTopHexColor,
  coverUrl,
  actionToast,
  lyricsLoading,
  isInstrumental,
  parsedLyrics,
  activeLyricIndex,
  ytSaveStatus,
  isAddingCurrentToPlaylist,
  onSeek,
  onSaveToLibrary,
  onOpenPlaylistPicker,
  onToggleLike,
  onOpenDevices,
  onPlayHereQuick,
  onFlashToast,
}) => {
  const navigate = useNavigate();
  const {radioMode, startRadio, stopRadio, queue, currentIndex} = usePlayer();
  const {
    desktopLyricsVisible,
    toggleDesktopLyrics,
    browsePaneCollapsed,
    toggleBrowsePane,
    focusQueueTick,
  } = useDesktopLayout();

  const lyricsScrollRef = useRef<HTMLDivElement | null>(null);
  const lyricLineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const userScrollPauseUntilRef = useRef<number>(0);
  const justEnteredLyricsRef = useRef<boolean>(true);
  const queuePaneRef = useRef<HTMLElement | null>(null);
  const [queueFocusPulse, setQueueFocusPulse] = useState(false);

  const trackId = activeTrack?.id ?? null;
  const hasLyrics = Boolean(parsedLyrics && parsedLyrics.lines.length > 0 && !isInstrumental);
  const showLyricsPane = desktopLyricsVisible && (lyricsLoading || hasLyrics);

  // Reset auto-scroll pause when switching track or toggling lyrics on
  useEffect(() => {
    lyricLineRefs.current = [];
    userScrollPauseUntilRef.current = 0;
    justEnteredLyricsRef.current = true;
  }, [trackId, showLyricsPane]);

  // Smoothly auto-scroll synced lyrics to keep current line centered
  useEffect(() => {
    if (!showLyricsPane || !parsedLyrics?.isSynced || activeLyricIndex < 0) return;
    if (Date.now() < userScrollPauseUntilRef.current) return;

    const container = lyricsScrollRef.current;
    const activeEl = lyricLineRefs.current[activeLyricIndex];
    if (!container || !activeEl) return;

    const targetScrollTop =
      activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
    const behavior: ScrollBehavior = justEnteredLyricsRef.current ? 'auto' : 'smooth';
    justEnteredLyricsRef.current = false;

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior,
    });
  }, [activeLyricIndex, parsedLyrics?.isSynced, showLyricsPane]);

  // Focus right queue pane when Q shortcut fires
  useEffect(() => {
    if (focusQueueTick === 0) return;
    queuePaneRef.current?.focus({preventScroll: true});
    setQueueFocusPulse(true);
    const timer = window.setTimeout(() => setQueueFocusPulse(false), 750);
    return () => window.clearTimeout(timer);
  }, [focusQueueTick]);

  const upcomingCount = Math.max(0, queue.length - currentIndex - 1);
  const isYouTubeTrack = Boolean(activeTrack?.isYouTubeStream);

  return (
    <div
      className="relative h-full w-full overflow-hidden flex flex-col [background:var(--np-canvas-bg)]"
      style={
        {
          '--np-top-hex': dominantTopHexColor,
          background: isTidal
            ? dominantTopHexColor
            : `linear-gradient(180deg, ${dominantTopHexColor} 0%, var(--bg-primary) ${isLight ? '76%' : '72%'})`,
        } as React.CSSProperties
      }
    >
      {actionToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] shadow-xl max-w-[90vw] truncate">
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

      {/* Full-bleed blurred album-colour backdrop */}
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

      {/* Width-capped 3-pane desktop stage (max 1680px so 2560px+ screens never over-stretch) */}
      <div className="relative z-10 flex flex-1 min-h-0 w-full max-w-[1680px] mx-auto">
        {/* LEFT PANE (~320px, collapsible): Library / Search */}
        {!browsePaneCollapsed && (
          <DesktopBrowsePane onCollapse={toggleBrowsePane} onToast={onFlashToast} />
        )}

        {/* CENTER PANE: Large Synced Lyrics Focus (or Centered Album Art + Title + Artist) */}
        <section
          aria-label="Now Playing stage"
          className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden"
        >
          {/* Minimal Top Context & Actions Bar (No Queue button on desktop) */}
          <header className="flex items-center justify-between gap-2 xl:gap-3 px-4 xl:px-6 py-3.5 border-b border-[var(--border-subtle)]/60 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {browsePaneCollapsed && (
                <button
                  type="button"
                  onClick={toggleBrowsePane}
                  className="flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)] transition-colors cursor-pointer shrink-0"
                  title="Show library pane"
                  aria-label="Show library pane"
                >
                  <PanelLeftOpen className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)] transition-colors cursor-pointer shrink-0"
                title="Back"
                aria-label="Back"
              >
                <ChevronDown className="w-5 h-5" />
              </button>
              {activeTrack && (
                <div className="min-w-0 pl-1">
                  <p className="text-[11px] font-medium text-[var(--text-secondary)] truncate">
                    {isRemoteActive && remoteDeviceName
                      ? `Playing on ${remoteDeviceName}`
                      : isYouTubeTrack
                        ? 'Streaming Online'
                        : 'Playing from Library'}
                  </p>
                  <p className="text-xs font-semibold text-[var(--text-primary)] truncate">
                    {activeTrack.album || activeTrack.artist}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 xl:gap-2 shrink-0">
              {isRemoteActive && remoteDeviceName && (
                <button
                  type="button"
                  onClick={onPlayHereQuick}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 xl:px-3.5 text-xs font-bold text-[var(--accent-contrast)] hover:opacity-90 transition-opacity cursor-pointer whitespace-nowrap"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                  <span className="hidden xl:inline">Play here</span>
                </button>
              )}

              {activeTrack && (
                <button
                  type="button"
                  onClick={toggleDesktopLyrics}
                  aria-pressed={desktopLyricsVisible}
                  className={`inline-flex h-9 px-2.5 xl:px-3.5 items-center gap-1.5 rounded-full text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    desktopLyricsVisible
                      ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-sm'
                      : 'backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)]'
                  }`}
                  title="Toggle lyrics (L)"
                  aria-label="Toggle Lyrics"
                >
                  <Mic2 className="w-3.5 h-3.5" />
                  <span className="hidden xl:inline">Lyrics</span>
                </button>
              )}

              {!offline && !isRemoteActive && currentTrack && (
                <button
                  type="button"
                  onClick={() => {
                    if (radioMode) {
                      stopRadio();
                      onFlashToast('Radio stopped');
                    } else {
                      startRadio(currentTrack);
                      onFlashToast('Starting radio...');
                    }
                  }}
                  aria-pressed={radioMode}
                  className={`inline-flex h-9 px-2.5 xl:px-3.5 items-center gap-1.5 rounded-full text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    radioMode
                      ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-sm'
                      : 'backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)]'
                  }`}
                  title={radioMode ? 'Stop Radio' : 'Start Radio'}
                  aria-label={radioMode ? 'Stop Radio' : 'Start Radio'}
                >
                  <Radio className="w-3.5 h-3.5" />
                  <span className="hidden xl:inline">{radioMode ? 'Radio On' : 'Radio'}</span>
                </button>
              )}

              {!isRemoteActive && currentTrack && (
                isYouTubeTrack ? (
                  canDownload && !offline ? (
                    <>
                      <button
                        type="button"
                        disabled={ytSaveStatus === 'saving'}
                        onClick={onSaveToLibrary}
                        className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors cursor-pointer ${
                          ytSaveStatus === 'saved'
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'backdrop-blur-md border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)]'
                        }`}
                        title={ytSaveStatus === 'saved' ? 'Saved to library' : 'Save track'}
                        aria-label="Save track"
                      >
                        {ytSaveStatus === 'saving' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : ytSaveStatus === 'saved' ? (
                          <Check className="w-4 h-4 stroke-[2.5]" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={isAddingCurrentToPlaylist}
                        onClick={onOpenPlaylistPicker}
                        className="flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)] disabled:opacity-60 transition-colors cursor-pointer"
                        title="Add to playlist"
                        aria-label="Add to playlist"
                      >
                        {isAddingCurrentToPlaylist ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <ListPlus className="w-4 h-4" />
                        )}
                      </button>
                    </>
                  ) : null
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onToggleLike(currentTrack.id)}
                      className={`flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] hover:bg-[var(--np-pill-bg-hover)] transition-colors cursor-pointer ${
                        currentTrack.liked ? 'text-[var(--accent)]' : 'text-[var(--np-pill-text)]'
                      }`}
                      title={currentTrack.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
                      aria-label={currentTrack.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
                    >
                      <Heart className={`w-4 h-4 ${currentTrack.liked ? 'fill-current' : ''}`} />
                    </button>
                    {typeof currentTrack.id === 'number' && (
                      <button
                        type="button"
                        onClick={onOpenPlaylistPicker}
                        className="flex h-9 w-9 items-center justify-center rounded-full backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)] transition-colors cursor-pointer"
                        title="Add to playlist"
                        aria-label="Add to playlist"
                      >
                        <ListPlus className="w-4 h-4" />
                      </button>
                    )}
                  </>
                )
              )}

              {!offline && (
                <button
                  type="button"
                  onClick={onOpenDevices}
                  aria-pressed={isRemoteActive}
                  className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors cursor-pointer ${
                    isRemoteActive
                      ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-sm'
                      : 'backdrop-blur-md border border-[var(--np-pill-border)] bg-[var(--np-pill-bg)] text-[var(--np-pill-text)] hover:bg-[var(--np-pill-bg-hover)]'
                  }`}
                  title="Devices"
                  aria-label="Devices"
                >
                  <MonitorSpeaker className="w-4 h-4" />
                </button>
              )}
            </div>
          </header>

          {/* Main Center Content */}
          {!activeTrack ? (
            <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] mb-5">
                <Music2 className="w-10 h-10 text-[var(--text-muted)]" />
              </div>
              <h1 className="font-display text-2xl font-bold text-[var(--text-primary)]">
                {isRemoteActive && remoteDeviceName
                  ? `${remoteDeviceName} Is Idle`
                  : 'Nothing Playing Right Now'}
              </h1>
              <p className="mt-2 text-sm text-[var(--text-secondary)] max-w-sm">
                Pick any song from the library pane on the left to start listening.
              </p>
            </div>
          ) : showLyricsPane ? (
            <div
              ref={lyricsScrollRef}
              onWheel={() => {
                userScrollPauseUntilRef.current = Date.now() + 3000;
              }}
              aria-label="Song lyrics"
              className="relative flex-1 overflow-y-auto px-8 xl:px-14"
              style={{
                WebkitMaskImage:
                  'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)',
                maskImage:
                  'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)',
              }}
            >
              {lyricsLoading ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-[var(--text-secondary)]">
                  <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
                  <span className="text-sm font-medium">Fetching lyrics...</span>
                </div>
              ) : parsedLyrics?.isSynced ? (
                <div className="max-w-2xl mx-auto py-28 space-y-5 xl:space-y-6">
                  {parsedLyrics.lines.map((line, idx) => {
                    const isCurrent = idx === activeLyricIndex;
                    const isPast = activeLyricIndex >= 0 && idx < activeLyricIndex;
                    return (
                      <button
                        key={`${line.time ?? idx}-${idx}`}
                        ref={(el) => {
                          lyricLineRefs.current[idx] = el;
                        }}
                        type="button"
                        onClick={() => {
                          if (line.time !== null) {
                            userScrollPauseUntilRef.current = 0;
                            onSeek(line.time);
                          }
                        }}
                        className={`block w-full text-left font-display leading-snug transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:underline rounded-lg px-2 py-1 -mx-2 hover:bg-white/[0.04] ${
                          isCurrent
                            ? 'text-2xl xl:text-3xl 2xl:text-[34px] font-extrabold text-[var(--np-lyric-current)] [filter:var(--np-lyric-current-filter)]'
                            : isPast
                              ? 'text-xl xl:text-2xl font-semibold text-[var(--np-lyric-past)] hover:text-[var(--np-lyric-past-hover)]'
                              : 'text-xl xl:text-2xl font-semibold text-[var(--np-lyric-future)] hover:text-[var(--np-lyric-future-hover)]'
                        }`}
                      >
                        {line.text}
                      </button>
                    );
                  })}
                </div>
              ) : parsedLyrics && parsedLyrics.lines.length > 0 ? (
                <div className="max-w-2xl mx-auto py-16 space-y-4">
                  {parsedLyrics.lines.map((line, idx) => (
                    <p
                      key={idx}
                      className="font-display text-xl xl:text-2xl leading-relaxed font-semibold text-[var(--np-lyric-plain)]"
                    >
                      {line.text}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            /* Fallback when no lyrics / instrumental / lyrics toggled off: large centered album art, title, and artist */
            <div className="flex-1 flex flex-col items-center justify-center px-6 xl:px-8 py-6 text-center overflow-y-auto">
              <div className="w-56 h-56 xl:w-72 xl:h-72 2xl:w-96 2xl:h-96 shrink-0">
                <AlbumArt
                  coverFile={activeTrack.cover_file}
                  externalUrl={activeTrack.coverUrl}
                  alt={activeTrack.title}
                  color={activeTrack.dominant_color}
                  className="w-full h-full rounded-2xl shadow-[var(--np-art-shadow)] ring-1 ring-[var(--np-art-ring)] select-none"
                  iconSize={84}
                />
              </div>

              <div className="mt-7 max-w-xl w-full space-y-2">
                <h1 className="font-display text-3xl xl:text-4xl font-extrabold tracking-tight text-[var(--text-primary)] text-balance line-clamp-2">
                  {activeTrack.title}
                </h1>
                <p className="text-base xl:text-lg font-medium text-[var(--text-secondary)] truncate">
                  {activeTrack.artist}
                </p>
                {activeTrack.album && (
                  <p className="text-xs text-[var(--text-muted)] truncate">
                    {activeTrack.album}
                    {activeTrack.format ? ` · ${activeTrack.format.toUpperCase()}` : ''}
                    {activeTrack.bitrate ? ` · ${activeTrack.bitrate} kbps` : ''}
                  </p>
                )}
                {isInstrumental && desktopLyricsVisible && (
                  <p className="pt-1 text-xs font-medium text-[var(--text-muted)]">
                    Instrumental track
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        {/* RIGHT PANE (~340px): Always-visible "Up next" */}
        <aside
          ref={queuePaneRef}
          tabIndex={-1}
          aria-label="Up next queue"
          className={`w-[244px] xl:w-[312px] 2xl:w-[340px] shrink-0 flex flex-col min-h-0 border-l border-[var(--border-subtle)] bg-[var(--np-lyrics-bg)]/55 backdrop-blur-md focus:outline-none transition-shadow ${
            queueFocusPulse
              ? 'ring-2 ring-inset ring-[var(--accent)]'
              : 'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'
          }`}
        >
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border-subtle)] shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <ListMusic className="w-4 h-4 text-[var(--accent)] shrink-0" />
              <h2 className="font-display text-sm font-bold text-[var(--text-primary)] truncate">
                Up next
              </h2>
            </div>
            <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
              {upcomingCount} {upcomingCount === 1 ? 'track' : 'tracks'}
            </span>
          </div>

          <QueuePanelContent desktopMode />
        </aside>
      </div>
    </div>
  );
};
