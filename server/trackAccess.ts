/**
 * Which songs a signed-in user can see.
 *
 *  - Admins, and users whose "whole library" switch is on, see every track.
 *  - Everyone else sees only tracks that are:
 *      1. in one of their own playlists, or in any playlist marked public,
 *      2. liked by them, or
 *      3. added by them (downloaded or uploaded; recorded in user_tracks).
 *
 * The rule is one SQL fragment so every route that reads tracks can apply it the same way.
 */

export interface TrackAccessUser {
  id: number;
  role: string;
  full_library?: boolean | number | null;
}

/** Minimal slice of better-sqlite3 / node:sqlite used here, so the rule can be tested without a native build. */
export interface TrackAccessDb {
  prepare(sql: string): {get(...params: unknown[]): unknown};
}

export function hasFullLibrary(user: TrackAccessUser): boolean {
  return user.role === 'admin' || Boolean(user.full_library);
}

export interface VisibleTrackClause {
  /** SQL boolean expression; always safe to AND into a WHERE clause. */
  sql: string;
  /** Positional parameters for the placeholders in `sql`, in order. */
  params: number[];
}

/**
 * `alias` is the table alias of the tracks table in the surrounding query (default "t").
 * Only letters, digits and underscores are allowed, since it is placed into the SQL text.
 */
export function visibleTrackClause(user: TrackAccessUser, alias = 't'): VisibleTrackClause {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('Invalid table alias');
  }
  if (hasFullLibrary(user)) {
    return {sql: '1 = 1', params: []};
  }
  const sql =
    `(EXISTS (SELECT 1 FROM playlist_tracks vpt JOIN playlists vp ON vp.id = vpt.playlist_id` +
    ` WHERE vpt.track_id = ${alias}.id AND (vp.user_id = ? OR vp.visibility = 'public'))` +
    ` OR EXISTS (SELECT 1 FROM liked_tracks vlt WHERE vlt.track_id = ${alias}.id AND vlt.user_id = ?)` +
    ` OR EXISTS (SELECT 1 FROM user_tracks vut WHERE vut.track_id = ${alias}.id AND vut.user_id = ?))`;
  return {sql, params: [user.id, user.id, user.id]};
}

export function isTrackVisibleToUser(db: TrackAccessDb, user: TrackAccessUser, trackId: number): boolean {
  if (!Number.isInteger(trackId) || trackId <= 0) return false;
  const clause = visibleTrackClause(user, 't');
  const row = db
    .prepare(`SELECT 1 AS ok FROM tracks t WHERE t.id = ? AND ${clause.sql}`)
    .get(trackId, ...clause.params);
  return Boolean(row);
}

/**
 * Removes "already in your library" hints for tracks the user cannot see, so search results do not
 * reveal what is in the hidden part of the library. Mutates and returns the same value.
 */
export function scrubHiddenDuplicateHints<T>(db: TrackAccessDb, user: TrackAccessUser, body: T): T {
  if (hasFullLibrary(user)) return body;
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (key === 'duplicateTrack' && value && typeof value === 'object') {
        const id = Number((value as {id?: unknown}).id);
        if (!isTrackVisibleToUser(db, user, id)) record[key] = null;
      } else {
        visit(value);
      }
    }
  };
  visit(body);
  return body;
}
