import {X} from 'lucide-react';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {apiFetch} from '../lib/api';
import {useBackClose} from '../lib/backStack';
import type {Playlist} from '../types';

interface RenamePlaylistModalProps {
  playlist: Playlist | null;
  onClose: () => void;
  onRenamed: (playlist: Playlist, newName: string) => void;
}

export const RenamePlaylistModal: React.FC<RenamePlaylistModalProps> = ({
  playlist,
  onClose,
  onRenamed,
}) => {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const open = Boolean(playlist);

  const handleCancel = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);

  useBackClose(open, handleCancel);

  useEffect(() => {
    if (!playlist) return;
    setName(playlist.name);
    setError(null);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [playlist]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleCancel, open]);

  if (!playlist) return null;

  const cleanedName = name.replace(/[\r\n]/g, '').trim();
  const isUnchanged = cleanedName === playlist.name.trim();
  const canSave = !submitting && cleanedName.length > 0 && !isUnchanged;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/playlists/${playlist.id}`, {
        method: 'PUT',
        body: JSON.stringify({name: cleanedName}),
      });
      onRenamed(playlist, cleanedName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename playlist');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-playlist-title"
      >
        <div className="flex items-center justify-between mb-5">
          <h2
            id="rename-playlist-title"
            className="font-display text-xl font-bold text-[var(--text-primary)]"
          >
            Rename Playlist
          </h2>
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="rename-playlist-name"
              className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
            >
              Playlist Name
            </label>
            <input
              ref={inputRef}
              id="rename-playlist-name"
              type="text"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Playlist name"
              className="w-full rounded-md bg-[var(--bg-input)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] border border-[var(--border-subtle)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          {error && <p className="text-sm text-[var(--danger-text)]">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleCancel}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="rounded-full bg-[var(--accent)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
