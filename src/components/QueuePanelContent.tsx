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
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
      {/* Now Playing */}
      {currentTrack && (
        <section>
          <div className="flex items-center justify-between mb-2.5 px-1">
            <h3 className="text-xs font-semibold text-[var(--text-secondary)]">Now playing</h3>
            {!radioMode && (
              <button
                type="button"
                onClick={() => startRadio(currentTrack)}
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:opacity-80 transition-opacity cursor-pointer"
              >
                <Radio className="w-3.5 h-3.5" />
                Start radio
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 rounded-lg bg-[var(--bg-elevated)]/90 p-2.5">
            <AlbumArt
              coverFile={currentTrack.cover_file}
              externalUrl={currentTrack.coverUrl}
              alt={currentTrack.title}
              color={currentTrack.dominant_color}
              className="w-11 h-11 rounded"
              iconSize={18}
            />
            <div className="min-w-0 flex-1">
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
              <p className="text-xs text-[var(--text-secondary)] truncate">{currentTrack.artist}</p>
            </div>
            <span className="font-mono text-xs tabular-nums text-[var(--text-secondary)]">
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
                <p className="text-xs font-semibold text-[var(--text-primary)] truncate">
                  Radio active
                </p>
                {radioSeed && (
                  <p className="text-[11px] text-[var(--text-secondary)] truncate">
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
              <p className="text-xs font-semibold text-[var(--text-primary)]">Autoplay</p>
              <p className="text-[11px] text-[var(--text-secondary)] truncate">
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
            <h3 className="text-xs font-semibold text-[var(--text-secondary)] truncate">
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
                className="text-xs text-[var(--accent)] hover:opacity-80 transition-opacity cursor-pointer"
              >
                Clear {radioMode ? 'radio' : 'autoplay'}
              </button>
            )}
            {upcoming.length > 0 && (
              <button
                type="button"
                onClick={clearUpcomingQueue}
                className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {upcoming.length === 0 ? (
          <div className="rounded-lg bg-[var(--bg-primary)]/60 border border-[var(--border-subtle)] p-6 text-center">
            <p className="text-sm text-[var(--text-secondary)]">
              {autoplayLoading ? 'Finding similar tracks...' : 'No tracks queued up next.'}
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Play an album, playlist, start radio, or add tracks from the library menu.
            </p>
          </div>
        ) : (
          <ul className="space-y-1">
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
                  className={`group flex items-center gap-2 rounded-lg p-2 transition-colors cursor-grab active:cursor-grabbing ${
                    isDragging
                      ? 'opacity-45 bg-[var(--bg-hover)]'
                      : isDropTarget
                        ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/60'
                        : 'hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {desktopMode && (
                    <GripVertical
                      className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] opacity-45 group-hover:opacity-100 transition-opacity"
                      aria-hidden="true"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => playTrack(track, queue)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer"
                  >
                    <AlbumArt
                      coverFile={track.cover_file}
                      externalUrl={track.coverUrl}
                      alt={track.title}
                      color={track.dominant_color}
                      className="w-10 h-10 rounded"
                      iconSize={16}
                    />
                    <div className="min-w-0 flex-1">
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
                      <p className="text-xs text-[var(--text-secondary)] truncate">{track.artist}</p>
                    </div>
                  </button>

                  <div
                    className={`flex items-center gap-0.5 transition-opacity ${
                      desktopMode
                        ? 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                        : 'opacity-80 group-hover:opacity-100'
                    }`}
                  >
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
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
