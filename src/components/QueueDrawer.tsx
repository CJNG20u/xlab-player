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
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative z-10 flex h-full w-full max-w-sm flex-col bg-[#181818] border-l border-white/10 shadow-2xl pt-safe pb-safe">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <ListMusic className="w-5 h-5 text-[#1DB954]" />
            <h2 className="font-display text-base font-bold text-white">Up Next Queue</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-[#282828] hover:text-white transition-colors"
            aria-label="Close queue"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          {/* Now Playing */}
          {currentTrack && (
            <section>
              <h3 className="text-xs font-semibold text-[#B3B3B3] mb-2.5 px-1">Now playing</h3>
              <div className="flex items-center gap-3 rounded-md bg-[#282828] p-2.5">
                <AlbumArt
                  coverFile={currentTrack.cover_file}
                  alt={currentTrack.title}
                  color={currentTrack.dominant_color}
                  className="w-11 h-11 rounded"
                  iconSize={18}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[#1DB954] truncate">
                    {currentTrack.title}
                  </p>
                  <p className="text-xs text-[#B3B3B3] truncate">{currentTrack.artist}</p>
                </div>
                <span className="font-mono text-xs tabular-nums text-[#B3B3B3]">
                  {formatDuration(currentTrack.duration)}
                </span>
              </div>
            </section>
          )}

          {/* Upcoming */}
          <section>
            <div className="flex items-center justify-between mb-2.5 px-1">
              <h3 className="text-xs font-semibold text-[#B3B3B3]">
                Next in queue ({upcoming.length})
              </h3>
              {upcoming.length > 0 && (
                <button
                  type="button"
                  onClick={clearUpcomingQueue}
                  className="text-xs text-[#B3B3B3] hover:text-white transition-colors"
                >
                  Clear queue
                </button>
              )}
            </div>

            {upcoming.length === 0 ? (
              <div className="rounded-md bg-[#121212] p-6 text-center">
                <p className="text-sm text-[#B3B3B3]">No tracks queued up next.</p>
                <p className="mt-1 text-xs text-[#6A6A6A]">
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
                    className="group flex items-center gap-2.5 rounded-md p-2 hover:bg-[#282828] transition-colors cursor-grab active:cursor-grabbing"
                  >
                    <button
                      type="button"
                      onClick={() => playTrack(track, queue)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <AlbumArt
                        coverFile={track.cover_file}
                        alt={track.title}
                        color={track.dominant_color}
                        className="w-10 h-10 rounded"
                        iconSize={16}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">{track.title}</p>
                        <p className="text-xs text-[#B3B3B3] truncate">{track.artist}</p>
                      </div>
                    </button>

                    <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
                      <button
                        type="button"
                        disabled={localIdx === 0}
                        onClick={() => reorderQueue(idx, idx - 1)}
                        className="p-1.5 rounded text-[#B3B3B3] hover:text-white disabled:opacity-25"
                        aria-label="Move up"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={localIdx === upcoming.length - 1}
                        onClick={() => reorderQueue(idx, idx + 1)}
                        className="p-1.5 rounded text-[#B3B3B3] hover:text-white disabled:opacity-25"
                        aria-label="Move down"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromQueue(idx)}
                        className="p-1.5 rounded text-[#B3B3B3] hover:text-red-400"
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
