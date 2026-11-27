import React, {useEffect, useState} from 'react';
import {apiFetch} from '../lib/api';

interface DirectoryUser {
  id: number;
  username: string;
}

interface PlaylistSharePickerProps {
  value: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}

/** Lets a playlist owner pick which listeners can see a private playlist. */
export const PlaylistSharePicker: React.FC<PlaylistSharePickerProps> = ({value, onChange, disabled}) => {
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{users: DirectoryUser[]}>('/api/users/directory')
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: number) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
        Share with specific people <span className="text-[var(--text-muted)] font-normal">(optional)</span>
      </legend>
      {failed ? (
        <p className="text-xs text-[var(--text-secondary)]">Could not load the list of users.</p>
      ) : users === null ? (
        <p className="text-xs text-[var(--text-secondary)]">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">There are no other listeners to share with yet.</p>
      ) : (
        <div className="max-h-36 overflow-y-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] divide-y divide-[var(--border-subtle)]">
          {users.map((u) => (
            <label
              key={u.id}
              className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-overlay)]"
            >
              <input
                type="checkbox"
                checked={value.includes(u.id)}
                onChange={() => toggle(u.id)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span className="truncate">{u.username}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
};
