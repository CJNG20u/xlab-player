import {X} from 'lucide-react';
import React, {useState} from 'react';
import {apiFetch} from '../lib/api';
import type {Playlist} from '../types';

interface CreatePlaylistModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (playlist: Playlist) => void;
}

export const CreatePlaylistModal: React.FC<CreatePlaylistModalProps> = ({
  open,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{playlist: Playlist}>('/api/playlists', {
        method: 'POST',
        body: JSON.stringify({name: name.trim(), description: description.trim()}),
      });
      setName('');
      setDescription('');
      onCreated({...res.playlist, track_count: 0, covers: []});
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create playlist');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl bg-[#181818] border border-white/10 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-display text-xl font-bold text-white">Create Playlist</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[#B3B3B3] hover:bg-[#282828] hover:text-white transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="playlist-name" className="block text-sm font-medium text-[#B3B3B3] mb-1.5">
              Playlist Name
            </label>
            <input
              id="playlist-name"
              type="text"
              required
              autoFocus
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Late Night Synth"
              className="w-full rounded-md bg-[#282828] px-3.5 py-2.5 text-sm text-white placeholder-[#6A6A6A] border border-transparent focus:border-[#1DB954] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="playlist-desc" className="block text-sm font-medium text-[#B3B3B3] mb-1.5">
              Description (optional)
            </label>
            <textarea
              id="playlist-desc"
              rows={3}
              maxLength={300}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add an optional description for this collection"
              className="w-full rounded-md bg-[#282828] px-3.5 py-2.5 text-sm text-white placeholder-[#6A6A6A] border border-transparent focus:border-[#1DB954] focus:outline-none resize-none"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-[#B3B3B3] hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="rounded-full bg-[#1DB954] px-6 py-2.5 text-sm font-bold text-black hover:bg-[#1ED760] disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
