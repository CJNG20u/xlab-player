import {ArrowDown, ArrowUp, ListMusic, Trash2, X} from 'lucide-react';
import React, {useState} from 'react';
import {usePlayer} from '../context/PlayerContext';
import {formatDuration} from '../lib/api';
import {AlbumArt} from './AlbumArt';

interface QueueDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const QueueDrawer: React.FC<QueueDrawerProps> = ({open, onClose}) => {
  const {
    queue,
    currentIndex,
    currentTrack,
    playTrack,
    removeFromQueue,
    reorderQueue,
    clearUpcomingQueue,
  } = usePlayer();

  const [dragIndex, setDragIndex] = useState<number | null>(null);

  if (!open) return null;

  const upcoming = queue
    .map((track, idx) => ({track, idx}))
    .filter(({idx}) => idx > currentIndex);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="fixed inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative z-10 flex h-full w-full max-w-sm flex-col bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] shadow-2xl pt-safe pb-safe">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5">
            <ListMusic className="w-5 h-5 text-[var(--accent)]" />
            <h2 className="font-display text-base font-bold text-[var(--text-primary)]">Up Next Queue</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Close queue"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          {/* Now Playing */}
          {currentTrack && (
            <section>
              <h3 className="text-xs font-semibold text-[var(--text-secondary)] mb-2.5 px-1">Now playing</h3>
              <div className="flex items-center gap-3 rounded-lg bg-[var(--bg-elevated)] p-2.5">
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
                      <span className="shrink-0 rounded border border-[var(--border-strong)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] leading-none">
                        YouTube
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

          {/* Upcoming */}
          <section>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h3 className="text-xs font-semibold text-[var(--text-secondary)]">
                Next in queue ({upcoming.length})
              </h3>
              {upcoming.length > 0 && (
                <button
                  type="button"
                  onClick={clearUpcomingQueue}
                  className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Clear queue
                </button>
              )}
            </div>

            {upcoming.length === 0 ? (
              <div className="rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] p-6 text-center">
                <p className="text-sm text-[var(--text-secondary)]">No tracks queued up next.</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Play an album, playlist, or add tracks from the library menu.
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {upcoming.map(({track, idx}, localIdx) => (
                  <li
                    key={`${track.id}-${idx}`}
                    draggable
                    onDragStart={() => setDragIndex(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null && dragIndex !== idx) {
                        reorderQueue(dragIndex, idx);
                      }
                      setDragIndex(null);
                    }}
                    className="group flex items-center gap-2.5 rounded-lg p-2 hover:bg-[var(--bg-hover)] transition-colors cursor-grab active:cursor-grabbing"
                  >
                    <button
                      type="button"
                      onClick={() => playTrack(track, queue)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
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
                          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{track.title}</p>
                          {track.isYouTubeStream && (
                            <span className="shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)] leading-none">
                              YT
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] truncate">{track.artist}</p>
                      </div>
                    </button>

                    <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
                      <button
                        type="button"
                        disabled={localIdx === 0}
                        onClick={() => reorderQueue(idx, idx - 1)}
                        className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-25"
                        aria-label="Move up"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={localIdx === upcoming.length - 1}
                        onClick={() => reorderQueue(idx, idx + 1)}
                        className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-25"
                        aria-label="Move down"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromQueue(idx)}
                        className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--danger-text)]"
                        aria-label="Remove from queue"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
};
