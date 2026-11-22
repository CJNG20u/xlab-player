import {ListMusic, Loader2, Plus, X} from 'lucide-react';
import React, {useState} from 'react';
import {apiFetch} from '../lib/api';
import type {Playlist} from '../types';
import {PlaylistMosaic} from './AlbumArt';

interface AddToPlaylistModalProps {
  open: boolean;
  trackIds: number[];
  playlists: Playlist[];
  onClose: () => void;
  onSuccess: (message: string, createdPlaylist?: Playlist) => void;
}

export const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({
  open,
  trackIds,
  playlists,
  onClose,
  onSuccess,
}) => {
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open || trackIds.length === 0) return null;

  const handlePickExisting = async (pl: Playlist) => {
    setBusyId(pl.id);
    setError(null);
    try {
      await apiFetch(`/api/playlists/${pl.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({trackIds}),
      });
      onSuccess(
        `Added ${trackIds.length} ${trackIds.length === 1 ? 'track' : 'tracks'} to ${pl.name}`
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add tracks to playlist');
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusyId('new');
    setError(null);
    try {
      const createdRes = await apiFetch<{playlist: Playlist}>('/api/playlists', {
        method: 'POST',
        body: JSON.stringify({name: trimmed}),
      });
      const created = createdRes.playlist;
      await apiFetch(`/api/playlists/${created.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({trackIds}),
      });
      setNewName('');
      onSuccess(
        `Created "${created.name}" with ${trackIds.length} ${trackIds.length === 1 ? 'track' : 'tracks'}`,
        {...created, track_count: trackIds.length, covers: []}
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create playlist');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs">
      <div
        className="w-full max-w-md rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-add-playlist-title"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
          <div>
            <h2 id="batch-add-playlist-title" className="font-display text-lg font-bold text-[var(--text-primary)]">
              Add to Playlist
            </h2>
            <p className="text-xs text-[var(--text-secondary)] font-mono tabular-nums mt-0.5">
              {trackIds.length} {trackIds.length === 1 ? 'track' : 'tracks'} selected
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Create new playlist inline */}
        <form onSubmit={handleCreateAndAdd} className="p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]/50">
          <label htmlFor="new-batch-playlist" className="block text-xs font-semibold text-[var(--text-secondary)] mb-2">
            Create New Playlist with Selection
          </label>
          <div className="flex items-center gap-2">
            <input
              id="new-batch-playlist"
              type="text"
              maxLength={100}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New playlist name..."
              className="flex-1 rounded-md bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              disabled={busyId !== null || !newName.trim()}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-40 whitespace-nowrap"
            >
              {busyId === 'new' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              )}
              Create
            </button>
          </div>
        </form>

        {/* Existing playlists */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {playlists.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--text-muted)]">
              <ListMusic className="w-7 h-7 mx-auto mb-2 opacity-60" />
              No existing playlists yet. Create one above.
            </div>
          ) : (
            playlists.map((pl) => (
              <button
                key={pl.id}
                type="button"
                disabled={busyId !== null}
                onClick={() => void handlePickExisting(pl)}
                className="flex w-full items-center gap-3 rounded-lg p-2.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
              >
                <PlaylistMosaic
                  covers={pl.covers || []}
                  alt={pl.name}
                  className="w-11 h-11 rounded shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{pl.name}</p>
                    {pl.source === 'm3u' && (
                      <span className="font-mono text-[10px] font-semibold text-[var(--accent)] border border-[var(--accent)]/35 rounded px-1 py-0.5 leading-none shrink-0">
                        M3U
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] font-mono tabular-nums">
                    {pl.track_count} {pl.track_count === 1 ? 'track' : 'tracks'}
                  </p>
                </div>
                {busyId === pl.id && (
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)] shrink-0" />
                )}
              </button>
            ))
          )}
        </div>

        {error && (
          <div className="px-5 py-3 border-t border-[var(--border-subtle)] text-xs text-[var(--danger-text)] bg-[var(--danger-bg)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
