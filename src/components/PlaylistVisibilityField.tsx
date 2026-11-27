import {Globe, Lock} from 'lucide-react';
import React from 'react';

export type PlaylistVisibility = 'private' | 'public';

interface PlaylistVisibilityFieldProps {
  value: PlaylistVisibility;
  onChange: (value: PlaylistVisibility) => void;
  disabled?: boolean;
  idPrefix: string;
}

const OPTIONS: Array<{
  value: PlaylistVisibility;
  label: string;
  hint: string;
  Icon: typeof Lock;
}> = [
  {value: 'private', label: 'Private', hint: 'Only you and admins can see it', Icon: Lock},
  {value: 'public', label: 'Public', hint: 'Everyone with an account can see it', Icon: Globe},
];

export const PlaylistVisibilityField: React.FC<PlaylistVisibilityFieldProps> = ({
  value,
  onChange,
  disabled,
  idPrefix,
}) => (
  <fieldset className="space-y-2" disabled={disabled}>
    <legend className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
      Who can see this playlist
    </legend>
    <div className="grid grid-cols-2 gap-2">
      {OPTIONS.map(({value: optionValue, label, hint, Icon}) => {
        const selected = value === optionValue;
        return (
          <label
            key={optionValue}
            htmlFor={`${idPrefix}-${optionValue}`}
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors ${
              selected
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-[var(--border-subtle)] bg-[var(--bg-input)] hover:border-[var(--border-strong)]'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <input
              id={`${idPrefix}-${optionValue}`}
              type="radio"
              name={`${idPrefix}-visibility`}
              value={optionValue}
              checked={selected}
              onChange={() => onChange(optionValue)}
              className="sr-only"
            />
            <Icon
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                selected ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
              }`}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-[var(--text-primary)]">{label}</span>
              <span className="block text-xs text-[var(--text-secondary)] leading-snug">{hint}</span>
            </span>
          </label>
        );
      })}
    </div>
  </fieldset>
);

export type PlaylistAudience = 'public' | 'shared' | 'private';

/**
 * What to show on a playlist's badge. Owners and admins get the real share list; anyone else only
 * sees a private playlist because it was shared with them.
 */
export function playlistAudience(playlist: {
  visibility?: 'private' | 'public';
  shared_with?: number[];
}): PlaylistAudience {
  if (playlist.visibility === 'public') return 'public';
  if (playlist.shared_with === undefined) return 'shared';
  return playlist.shared_with.length > 0 ? 'shared' : 'private';
}
