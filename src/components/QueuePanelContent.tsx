import {ArrowDown, ArrowUp, GripVertical, Loader2, Radio, Sparkles, Trash2} from 'lucide-react';
import React, {useState} from 'react';
import {usePlayer} from '../context/PlayerContext';
import {formatDuration} from '../lib/api';
import {AlbumArt} from './AlbumArt';

interface QueuePanelContentProps {
  desktopMode?: boolean;
}

export const QueuePanelContent: React.FC<QueuePanelContentProps> = ({desktopMode = false}) => {
  const {
    queue,
    currentIndex,
    currentTrack,
    repeat,
    shuffle,
    autoplayEnabled,
    setAutoplayEnabled,
    autoplayLoading,
    radioMode,
    radioSeed,
    startRadio,
    stopRadio,
    playTrack,
    removeFromQueue,
    reorderQueue,
    clearUpcomingQueue,
    clearGeneratedQueue,
  } = usePlayer();

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const upcoming = queue
    .map((track, idx) => ({track, idx}))
    .filter(({idx}) => idx > currentIndex);

  const generatedUpcomingCount = upcoming.filter(({track}) => Boolean(track.queueSource)).length;
  const autoplayPausedByMode = repeat !== 'off' || shuffle;

  return (
    <div
      className={
        desktopMode
          ? 'flex-1 overflow-y-auto px-[clamp(0.75rem,1.05vw,1.4rem)] py-[clamp(0.875rem,1.1vw,1.5rem)] space-y-[clamp(1.1rem,1.35vw,1.75rem)]'
          : 'flex-1 overflow-y-auto px-4 py-4 space-y-5'
      }
    >
      {/* Now Playing */}
      {currentTrack && (
        <section>
          <div className="flex items-center justify-between mb-2.5 px-1">
            <h3
              className={
                desktopMode
                  ? 'text-[clamp(0.75rem,0.65rem_+_0.18vw,0.9rem)] font-semibold text-[var(--text-secondary)]'
                  : 'text-xs font-semibold text-[var(--text-secondary)]'
              }
            >
              Now playing
            </h3>
            {!radioMode && (
              <button
                type="button"
                onClick={() => startRadio(currentTrack)}
                className={`inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:opacity-80 transition-opacity cursor-pointer ${
                  desktopMode
                    ? 'text-[clamp(0.75rem,0.65rem_+_0.18vw,0.9rem)]'
                    : 'text-xs'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                Start radio
              </button>
            )}
          </div>
          <div
            className={
              desktopMode
                ? 'flex items-center gap-[clamp(0.65rem,0.8vw,0.95rem)] rounded-lg bg-[var(--bg-elevated)]/90 p-[clamp(0.6rem,0.75vw,0.9rem)]'
                : 'flex items-center gap-3 rounded-lg bg-[var(--bg-elevated)]/90 p-2.5'
            }
          >
            <AlbumArt
              coverFile={currentTrack.cover_file}
              externalUrl={currentTrack.coverUrl}
              alt={currentTrack.title}
              color={currentTrack.dominant_color}
              className={
                desktopMode
                  ? 'w-[clamp(2.75rem,2.35rem_+_0.7vw,3.5rem)] h-[clamp(2.75rem,2.35rem_+_0.7vw,3.5rem)] shrink-0 rounded'
                  : 'w-11 h-11 rounded'
              }
              iconSize={18}
            />
            <div className="min-w-0 flex-1">
              {desktopMode ? (
                <>
                  <p className="text-[clamp(0.875rem,0.7rem_+_0.26vw,1.125rem)] font-semibold text-[var(--accent)] truncate leading-snug">
                    {currentTrack.title}
                  </p>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <p className="text-[clamp(0.75rem,0.62rem_+_0.22vw,0.9375rem)] text-[var(--text-secondary)] truncate leading-snug">
                      {currentTrack.artist}
                    </p>
                    {currentTrack.isYouTubeStream && (
                      <span className="shrink-0 rounded border border-[var(--badge-source-border)] bg-[var(--badge-source-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none text-[var(--badge-source-text)]">
                        Online
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <p className="text-sm font-semibold text-[var(--accent)] truncate">
                      {currentTrack.title}
                    </p>
                    {currentTrack.isYouTubeStream && (
                      <span className="shrink-0 rounded border border-[var(--badge-source-border)] bg-[var(--badge-source-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none text-[var(--badge-source-text)]">
                        Online
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] truncate">
                    {currentTrack.artist}
                  </p>
                </>
              )}
            </div>
            <span
              className={
                desktopMode
                  ? 'font-mono text-[clamp(0.75rem,0.64rem_+_0.18vw,0.875rem)] tabular-nums text-[var(--text-secondary)] shrink-0'
                  : 'font-mono text-xs tabular-nums text-[var(--text-secondary)]'
              }
            >
              {formatDuration(currentTrack.duration)}
            </span>
          </div>
        </section>
      )}

      {/* Radio Banner & Autoplay Control */}
      <section className="space-y-2.5">
        {radioMode && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-3 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <Radio className="w-4 h-4 shrink-0 text-[var(--accent)]" />
              <div className="min-w-0">
                <p
                  className={
                    desktopMode
                      ? 'text-[clamp(0.78rem,0.66rem_+_0.2vw,0.9375rem)] font-semibold text-[var(--text-primary)] truncate'
                      : 'text-xs font-semibold text-[var(--text-primary)] truncate'
                  }
                >
                  Radio active
                </p>
                {radioSeed && (
                  <p
                    className={
                      desktopMode
                        ? 'text-[clamp(0.72rem,0.62rem_+_0.16vw,0.85rem)] text-[var(--text-secondary)] truncate'
                        : 'text-[11px] text-[var(--text-secondary)] truncate'
                    }
                  >
                    Based on {radioSeed.title}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={stopRadio}
              className="shrink-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
            >
              Stop radio
            </button>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]/75 px-3 py-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles className="w-4 h-4 shrink-0 text-[var(--accent)]" />
            <div className="min-w-0">
              <p
                className={
                  desktopMode
                    ? 'text-[clamp(0.78rem,0.66rem_+_0.2vw,0.9375rem)] font-semibold text-[var(--text-primary)]'
                    : 'text-xs font-semibold text-[var(--text-primary)]'
                }
              >
                Autoplay
              </p>
              <p
                className={
                  desktopMode
                    ? 'text-[clamp(0.72rem,0.62rem_+_0.16vw,0.85rem)] text-[var(--text-secondary)] truncate'
                    : 'text-[11px] text-[var(--text-secondary)] truncate'
                }
              >
                {autoplayPausedByMode
                  ? 'Paused while repeat or shuffle is on'
                  : autoplayEnabled
                    ? 'Adds similar songs when queue runs low'
                    : 'Off — playback stops at queue end'}
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoplayEnabled}
            aria-label="Toggle Autoplay"
            onClick={() => setAutoplayEnabled(!autoplayEnabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
              autoplayEnabled
                ? 'bg-[var(--accent)]'
                : 'bg-[var(--bg-elevated)] border border-[var(--border-strong)]'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
                autoplayEnabled
                  ? 'translate-x-4.5 bg-[var(--accent-contrast)]'
                  : 'translate-x-0.5 bg-[var(--text-secondary)]'
              }`}
            />
          </button>
        </div>
      </section>

      {/* Upcoming */}
      <section>
        <div className="flex items-center justify-between gap-2 mb-2.5 px-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3
              className={
                desktopMode
                  ? 'text-[clamp(0.75rem,0.65rem_+_0.18vw,0.9rem)] font-semibold text-[var(--text-secondary)] truncate'
                  : 'text-xs font-semibold text-[var(--text-secondary)] truncate'
              }
            >
              Next in queue (<span className="font-mono tabular-nums">{upcoming.length}</span>)
            </h3>
            {autoplayLoading && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)] shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            {generatedUpcomingCount > 0 && (
              <button
                type="button"
                onClick={clearGeneratedQueue}
                className={`text-[var(--accent)] hover:opacity-80 transition-opacity cursor-pointer ${
                  desktopMode ? 'text-[clamp(0.75rem,0.65rem_+_0.18vw,0.9rem)]' : 'text-xs'
                }`}
              >
                Clear {radioMode ? 'radio' : 'autoplay'}
              </button>
            )}
            {upcoming.length > 0 && (
              <button
                type="button"
                onClick={clearUpcomingQueue}
                className={`text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer ${
                  desktopMode ? 'text-[clamp(0.75rem,0.65rem_+_0.18vw,0.9rem)]' : 'text-xs'
                }`}
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {upcoming.length === 0 ? (
          <div className="rounded-lg bg-[var(--bg-primary)]/60 border border-[var(--border-subtle)] p-6 text-center">
            <p
              className={
                desktopMode
                  ? 'text-[clamp(0.875rem,0.72rem_+_0.24vw,1.0625rem)] text-[var(--text-secondary)]'
                  : 'text-sm text-[var(--text-secondary)]'
              }
            >
              {autoplayLoading ? 'Finding similar tracks...' : 'No tracks queued up next.'}
            </p>
            <p
              className={
                desktopMode
                  ? 'mt-1 text-[clamp(0.75rem,0.64rem_+_0.18vw,0.875rem)] text-[var(--text-muted)]'
                  : 'mt-1 text-xs text-[var(--text-muted)]'
              }
            >
              Play an album, playlist, start radio, or add tracks from the library menu.
            </p>
          </div>
        ) : (
          <ul className={desktopMode ? 'space-y-[clamp(0.2rem,0.3vw,0.45rem)]' : 'space-y-1'}>
            {upcoming.map(({track, idx}, localIdx) => {
              const isDropTarget = dragIndex !== null && dragOverIndex === idx && dragIndex !== idx;
              const isDragging = dragIndex === idx;
              return (
                <li
                  key={`${track.id}-${idx}`}
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(idx);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(idx));
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverIndex !== idx) setDragOverIndex(idx);
                  }}
                  onDragLeave={() => {
                    if (dragOverIndex === idx) setDragOverIndex(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null && dragIndex !== idx) {
                      reorderQueue(dragIndex, idx);
                    }
                    setDragIndex(null);
                    setDragOverIndex(null);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDragOverIndex(null);
                  }}
                  className={`group flex items-center rounded-lg transition-colors cursor-grab active:cursor-grabbing ${
                    desktopMode
                      ? 'gap-[clamp(0.5rem,0.65vw,0.85rem)] px-[clamp(0.5rem,0.65vw,0.85rem)] py-[clamp(0.4rem,0.48vw,0.68rem)]'
                      : 'gap-2 p-2'
                  } ${
                    isDragging
                      ? 'opacity-45 bg-[var(--bg-hover)]'
                      : isDropTarget
                        ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/60'
                        : 'hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {desktopMode && (
                    <GripVertical
                      className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] opacity-35 group-hover:opacity-100 transition-opacity"
                      aria-hidden="true"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => playTrack(track, queue)}
                    className={`flex min-w-0 flex-1 items-center text-left cursor-pointer ${
                      desktopMode ? 'gap-[clamp(0.625rem,0.75vw,0.9rem)]' : 'gap-2.5'
                    }`}
                  >
                    <AlbumArt
                      coverFile={track.cover_file}
                      externalUrl={track.coverUrl}
                      alt={track.title}
                      color={track.dominant_color}
                      className={
                        desktopMode
                          ? 'w-[clamp(2.5rem,2.15rem_+_0.68vw,3.25rem)] h-[clamp(2.5rem,2.15rem_+_0.68vw,3.25rem)] shrink-0 rounded'
                          : 'w-10 h-10 rounded'
                      }
                      iconSize={16}
                    />
                    <div className="min-w-0 flex-1">
                      {desktopMode ? (
                        <>
                          <p className="text-[clamp(0.875rem,0.7rem_+_0.26vw,1.125rem)] font-medium text-[var(--text-primary)] truncate leading-snug">
                            {track.title}
                          </p>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p className="text-[clamp(0.75rem,0.62rem_+_0.22vw,0.9375rem)] text-[var(--text-secondary)] truncate leading-snug">
                              {track.artist}
                            </p>
                            {track.queueSource && (
                              <span
                                className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none ${
                                  track.queueSource === 'radio'
                                    ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]'
                                    : 'border-[var(--badge-source-border)] bg-[var(--badge-source-bg)] text-[var(--badge-source-text)]'
                                }`}
                              >
                                {track.queueSource === 'radio' ? 'Radio' : 'Autoplay'}
                              </span>
                            )}
                            {track.isYouTubeStream && !track.queueSource && (
                              <span className="shrink-0 rounded border border-[var(--badge-queue-border)] bg-[var(--badge-queue-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none text-[var(--badge-queue-text)]">
                                Web
                              </span>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                              {track.title}
                            </p>
                            {track.queueSource && (
                              <span
                                className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none ${
                                  track.queueSource === 'radio'
                                    ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]'
                                    : 'border-[var(--badge-source-border)] bg-[var(--badge-source-bg)] text-[var(--badge-source-text)]'
                                }`}
                              >
                                {track.queueSource === 'radio' ? 'Radio' : 'Autoplay'}
                              </span>
                            )}
                            {track.isYouTubeStream && !track.queueSource && (
                              <span className="shrink-0 rounded border border-[var(--badge-queue-border)] bg-[var(--badge-queue-bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none text-[var(--badge-queue-text)]">
                                Web
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[var(--text-secondary)] truncate">
                            {track.artist}
                          </p>
                        </>
                      )}
                    </div>
                  </button>

                  {desktopMode ? (
                    <div className="flex items-center shrink-0">
                      <span className="font-mono text-[clamp(0.75rem,0.64rem_+_0.18vw,0.875rem)] tabular-nums text-[var(--text-muted)] group-hover:hidden group-focus-within:hidden">
                        {formatDuration(track.duration)}
                      </span>
                      <div className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5">
                        <button
                          type="button"
                          disabled={localIdx === 0}
                          onClick={() => reorderQueue(idx, idx - 1)}
                          className="p-1.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-25 cursor-pointer"
                          aria-label="Move up"
                          title="Move up"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={localIdx === upcoming.length - 1}
                          onClick={() => reorderQueue(idx, idx + 1)}
                          className="p-1.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-25 cursor-pointer"
                          aria-label="Move down"
                          title="Move down"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFromQueue(idx)}
                          className="p-1.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--danger-text)] cursor-pointer"
                          aria-label="Remove from queue"
                          title="Remove from queue"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        disabled={localIdx === 0}
                        onClick={() => reorderQueue(idx, idx - 1)}
                        className="p-1.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-25 cursor-pointer"
                        aria-label="Move up"
                        title="Move up"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={localIdx === upcoming.length - 1}
                        onClick={() => reorderQueue(idx, idx + 1)}
                        className="p-1.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-25 cursor-pointer"
                        aria-label="Move down"
                        title="Move down"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromQueue(idx)}
                        className="p-1.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--danger-text)] cursor-pointer"
                        aria-label="Remove from queue"
                        title="Remove from queue"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
