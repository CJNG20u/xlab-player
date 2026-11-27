/**
 * Who may see or change a playlist.
 *
 *  - Admins can see and manage every playlist.
 *  - Everyone else sees their own playlists plus playlists marked "public".
 *  - A playlist is private by default, including playlists created by the library scanner from .m3u files.
 *  - Only the owner (or an admin) can edit, delete or change the visibility of a playlist.
 */

export type PlaylistVisibility = 'private' | 'public';

export interface PlaylistAccessUser {
  id: number;
  role: string;
}

export interface PlaylistAccessRow {
  user_id: number;
  visibility?: string | null;
}

export function parseVisibility(value: unknown): PlaylistVisibility | null {
  return value === 'public' || value === 'private' ? value : null;
}

export function canViewPlaylist(user: PlaylistAccessUser, playlist: PlaylistAccessRow): boolean {
  if (user.role === 'admin') return true;
  if (playlist.user_id === user.id) return true;
  return playlist.visibility === 'public';
}

export function canManagePlaylist(user: PlaylistAccessUser, playlist: PlaylistAccessRow): boolean {
  return user.role === 'admin' || playlist.user_id === user.id;
}
