import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {
  hasFullLibrary,
  isTrackVisibleToUser,
  scrubHiddenDuplicateHints,
  visibleTrackClause,
  type TrackAccessDb,
} from './trackAccess.ts';

const admin = {id: 1, role: 'admin', full_library: true};
const alice = {id: 2, role: 'listener', full_library: false};
const bob = {id: 3, role: 'listener', full_library: false};
const carol = {id: 4, role: 'listener', full_library: true};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tracks (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE playlists (id INTEGER PRIMARY KEY, user_id INTEGER, visibility TEXT NOT NULL DEFAULT 'private');
    CREATE TABLE playlist_tracks (id INTEGER PRIMARY KEY, playlist_id INTEGER, track_id INTEGER);
    CREATE TABLE liked_tracks (user_id INTEGER, track_id INTEGER);
    CREATE TABLE user_tracks (user_id INTEGER, track_id INTEGER);
    INSERT INTO tracks (id, title) VALUES
      (1,'Road Trip Song'),(2,'Alice Private Song'),(3,'Bob Liked Song'),
      (4,'Alice Download'),(5,'Admin Only Song'),(6,'Admin Private Playlist Song');
    -- playlists: 10 admin public, 11 alice private, 12 admin private
    INSERT INTO playlists (id, user_id, visibility) VALUES (10,1,'public'),(11,2,'private'),(12,1,'private');
    INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (10,1),(11,2),(12,6);
    INSERT INTO liked_tracks (user_id, track_id) VALUES (3,3);
    INSERT INTO user_tracks (user_id, track_id) VALUES (2,4);
  `);
  return db;
}

function visibleIds(db: DatabaseSync, user: typeof alice): number[] {
  const clause = visibleTrackClause(user, 't');
  const rows = db
    .prepare(`SELECT t.id FROM tracks t WHERE ${clause.sql} ORDER BY t.id`)
    .all(...clause.params) as Array<{id: number}>;
  return rows.map((r) => r.id);
}

test('admins and full-library users see every track', () => {
  const db = makeDb();
  assert.equal(hasFullLibrary(admin), true);
  assert.equal(hasFullLibrary(carol), true);
  assert.deepEqual(visibleIds(db, admin), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(visibleIds(db, carol), [1, 2, 3, 4, 5, 6]);
});

test('a limited user sees public playlist tracks, own playlist tracks and own likes/downloads only', () => {
  const db = makeDb();
  // alice: public playlist song (1), her private playlist song (2), her own download (4)
  assert.deepEqual(visibleIds(db, alice), [1, 2, 4]);
  // bob: public playlist song (1) and the song he liked (3)
  assert.deepEqual(visibleIds(db, bob), [1, 3]);
});

test('songs only in another user\'s private playlist, or in no playlist, stay hidden', () => {
  const db = makeDb();
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, alice, 5), false);
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, alice, 6), false);
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, bob, 2), false);
});

test('making a playlist public reveals its songs; making it private hides them again', () => {
  const db = makeDb();
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, bob, 2), false);
  db.exec("UPDATE playlists SET visibility = 'public' WHERE id = 11");
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, bob, 2), true);
  db.exec("UPDATE playlists SET visibility = 'private' WHERE id = 11");
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, bob, 2), false);
});

test('a song in one public and one private playlist stays visible', () => {
  const db = makeDb();
  db.exec('INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (11, 1)');
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, bob, 1), true);
});

test('invalid track ids are never visible', () => {
  const db = makeDb();
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, alice, 0), false);
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, alice, -3), false);
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, alice, Number.NaN), false);
  assert.equal(isTrackVisibleToUser(db as TrackAccessDb, alice, 999), false);
});

test('the clause works with any table alias and rejects unsafe aliases', () => {
  const db = makeDb();
  const clause = visibleTrackClause(alice, 'tr');
  const rows = db
    .prepare(`SELECT tr.id FROM tracks tr WHERE ${clause.sql} ORDER BY tr.id`)
    .all(...clause.params) as Array<{id: number}>;
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 4]);
  assert.throws(() => visibleTrackClause(alice, 't; DROP TABLE tracks'));
});

test('search hints about hidden tracks are removed, visible ones kept', () => {
  const db = makeDb();
  const body = {
    items: [
      {title: 'a', duplicateTrack: {id: 5, title: 'Admin Only Song'}},
      {title: 'b', duplicateTrack: {id: 1, title: 'Road Trip Song'}},
      {title: 'c', duplicateTrack: null},
    ],
  };
  const scrubbed = scrubHiddenDuplicateHints(db as TrackAccessDb, alice, body);
  assert.equal(scrubbed.items[0].duplicateTrack, null);
  assert.equal(scrubbed.items[1].duplicateTrack?.id, 1);
  assert.equal(scrubbed.items[2].duplicateTrack, null);
});

test('admins keep every search hint untouched', () => {
  const db = makeDb();
  const body = {items: [{duplicateTrack: {id: 5, title: 'Admin Only Song'}}]};
  assert.equal(scrubHiddenDuplicateHints(db as TrackAccessDb, admin, body).items[0].duplicateTrack?.id, 5);
});
