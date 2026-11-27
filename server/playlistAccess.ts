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

/** Minimal slice of the SQLite API used here so the rules can be tested without a native build. */
export interface PlaylistShareDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/** True when the owner shared this playlist with the user. */
export function isPlaylistSharedWith(db: PlaylistShareDb, playlistId: number, userId: number): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 AS ok FROM playlist_shares WHERE playlist_id = ? AND user_id = ?')
      .get(playlistId, userId)
  );
}

/** Own playlists, public playlists, playlists shared with the user, and everything for admins. */
export function canViewPlaylistWithShares(
  db: PlaylistShareDb,
  user: PlaylistAccessUser,
  playlist: PlaylistAccessRow & {id: number}
): boolean {
  return canViewPlaylist(user, playlist) || isPlaylistSharedWith(db, playlist.id, user.id);
}

export function getPlaylistShareIds(db: PlaylistShareDb, playlistId: number): number[] {
  return (
    db
      .prepare('SELECT user_id FROM playlist_shares WHERE playlist_id = ? ORDER BY user_id ASC')
      .all(playlistId) as Array<{user_id: number}>
  ).map((r) => r.user_id);
}

/**
 * Parses a "shared_with" request value: an array of positive integer user ids.
 * Returns null when the value is not a valid list. Duplicates are removed.
 */
export function parseShareIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const ids: number[] = [];
  for (const v of value) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

/**
 * Replaces the list of people a playlist is shared with. Ids that are not existing users, the owner
 * and admins (who see everything anyway) are ignored. Returns the ids actually stored.
 */
export function replacePlaylistShares(
  db: PlaylistShareDb,
  playlist: {id: number; user_id: number},
  userIds: number[]
): number[] {
  const valid: number[] = [];
  for (const id of userIds) {
    if (id === playlist.user_id) continue;
    const row = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id) as
      | {id: number; role: string}
      | undefined;
    if (!row || row.role === 'admin') continue;
    valid.push(row.id);
  }
  db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ?').run(playlist.id);
  const insert = db.prepare('INSERT OR IGNORE INTO playlist_shares (playlist_id, user_id) VALUES (?, ?)');
  for (const id of valid) insert.run(playlist.id, id);
  return valid;
}
