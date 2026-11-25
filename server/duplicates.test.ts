import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  DuplicateResolveError,
  detectDuplicateGroups,
  extractPrimaryArtist,
  extractVersionMarkers,
  findDuplicateGroupsForUser,
  normalizeDuplicateTitle,
  resolveDuplicatePair,
  type DuplicateInputTrack,
} from './duplicates.ts';
import {filterIgnoredAudioFiles} from './scanner.ts';

function makeTrack(overrides: Partial<DuplicateInputTrack> & {id: number}): DuplicateInputTrack {
  return {
    rel_path: `Music/track-${overrides.id}.m4a`,
    title: 'Sample Song',
    artist: 'Sample Artist',
    album: 'Sample Album',
    duration: 200,
    format: 'm4a',
    bitrate: 192,
    size_bytes: 4_000_000,
    cover_file: null,
    dominant_color: '#1f3a2e',
    added_at: '2026-01-01 12:00:00',
    file_hash: null,
    youtube_video_id: null,
    playlistCount: 0,
    liked: false,
    isPlaying: false,
    ...overrides,
  };
}

function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'listener',
      can_download INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL DEFAULT 'Unknown Artist',
      album TEXT NOT NULL DEFAULT 'Unknown Album',
      track_number INTEGER,
      year INTEGER,
      duration REAL NOT NULL DEFAULT 0,
      format TEXT NOT NULL DEFAULT '',
      bitrate INTEGER DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      cover_file TEXT,
      dominant_color TEXT NOT NULL DEFAULT '#1f3a2e',
      lyrics TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_hash TEXT,
      youtube_video_id TEXT
    );

    CREATE TABLE playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      m3u_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE TABLE liked_tracks (
      user_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      liked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, track_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE TABLE play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      track_id INTEGER,
      video_id TEXT NOT NULL DEFAULT '',
      played_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE listening_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      track_id TEXT NOT NULL DEFAULT '',
      video_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      listened_sec REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE download_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      url TEXT NOT NULL,
      track_id INTEGER,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
    );

    CREATE TABLE youtube_playlist_job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      track_id INTEGER,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
    );

    CREATE TABLE library_ignored_paths (
      rel_path TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT 'duplicate',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return testDb;
}

// ---------------------------------------------------------------------------
// 1. Normalization & Detection Unit Tests
// ---------------------------------------------------------------------------

test('normalizeDuplicateTitle strips accents, punctuation, feat, and release suffixes', () => {
  assert.equal(normalizeDuplicateTitle('Café del Mar - 2020 Remastered'), 'cafe del mar');
  assert.equal(normalizeDuplicateTitle('Song (feat. Guest Artist)'), 'song');
  assert.equal(normalizeDuplicateTitle('Song ft. Guest Artist'), 'song');
  assert.equal(normalizeDuplicateTitle('Song - Single Version'), 'song');
  assert.equal(normalizeDuplicateTitle('Demons (Official Audio) - Remastered'), 'demons');
});

test('extractPrimaryArtist handles collaborations and Topic suffixes', () => {
  assert.equal(extractPrimaryArtist('Josiah Queen - Topic'), 'josiah queen');
  assert.equal(extractPrimaryArtist('Josiah Queen, Brandon Lake'), 'josiah queen');
  assert.equal(extractPrimaryArtist('Josiah Queen feat. Forrest Frank'), 'josiah queen');
});

test('version markers prevent grouping Song with Song (Live), while Alive is unaffected', () => {
  assert.deepEqual(extractVersionMarkers('Song'), []);
  assert.deepEqual(extractVersionMarkers('Song (Live)'), ['live']);
  assert.deepEqual(extractVersionMarkers('Alive'), []);

  const groups = detectDuplicateGroups([
    makeTrack({id: 1, title: 'Song', artist: 'Artist A', duration: 210}),
    makeTrack({id: 2, title: 'Song (Live)', artist: 'Artist A', duration: 210}),
    makeTrack({id: 3, title: 'Song (Acoustic)', artist: 'Artist A', duration: 210}),
    makeTrack({id: 4, title: 'Alive', artist: 'Artist B', duration: 195}),
    makeTrack({id: 5, title: 'Alive - Remastered', artist: 'Artist B', duration: 196}),
  ]);

  // Song vs Song (Live) vs Song (Acoustic) must NOT group; Alive & Alive - Remastered DO group
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].copies.map((c) => c.id).sort((a, b) => a - b),
    [4, 5]
  );
});

test('Song (feat. X) and Song group as likely duplicates within +/- 3s, not > 3s apart', () => {
  const groups = detectDuplicateGroups([
    makeTrack({id: 10, title: 'Song (feat. X)', artist: 'Artist A', duration: 182}),
    makeTrack({id: 11, title: 'Song', artist: 'Artist A', duration: 180}),
    makeTrack({id: 12, title: 'Different Length', artist: 'Artist B', duration: 180}),
    makeTrack({id: 13, title: 'Different Length', artist: 'Artist B', duration: 184}),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].matchType, 'likely');
  assert.equal(groups[0].label, 'Probably the same');
  assert.deepEqual(
    groups[0].copies.map((c) => c.id).sort((a, b) => a - b),
    [10, 11]
  );
});

test('demons by Josiah Queen with two copies groups cleanly and prefers lossless / higher bitrate', () => {
  const groups = detectDuplicateGroups([
    makeTrack({
      id: 101,
      rel_path: 'YouTube/Josiah Queen - demons.m4a',
      title: 'demons',
      artist: 'Josiah Queen',
      duration: 198,
      format: 'm4a',
      bitrate: 128,
      youtube_video_id: 'dQw4w9WgXcQ',
      playlistCount: 2,
      added_at: '2026-01-10 10:00:00',
    }),
    makeTrack({
      id: 102,
      rel_path: 'Josiah Queen/demons.flac',
      title: 'Demons',
      artist: 'Josiah Queen',
      duration: 199,
      format: 'flac',
      bitrate: 920,
      playlistCount: 1,
      added_at: '2026-02-01 10:00:00',
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].copies.length, 2);
  assert.equal(groups[0].suggestedKeepId, 102);
  assert.equal(groups[0].copies[0].id, 102);
  assert.equal(groups[0].copies[0].suggestedKeep, true);
  assert.equal(groups[0].copies[0].qualityLabel, 'FLAC');
  assert.equal(groups[0].copies[1].source, 'youtube');
});

test('definite matches (same youtube_video_id, file_hash, or catalog_track_id) are labeled Same song', () => {
  const groups = detectDuplicateGroups([
    makeTrack({
      id: 201,
      rel_path: 'A/one.m4a',
      title: 'Track One',
      artist: 'Artist X',
      duration: 150,
      youtube_video_id: 'abc12345678',
    }),
    makeTrack({
      id: 202,
      rel_path: 'B/one-copy.m4a',
      title: 'Track One (Different Name)',
      artist: 'Someone Else',
      duration: 165,
      youtube_video_id: 'abc12345678',
    }),
    makeTrack({
      id: 203,
      rel_path: 'C/hash-a.mp3',
      title: 'Hash Song',
      artist: 'Artist Y',
      file_hash: 'deadbeef01',
    }),
    makeTrack({
      id: 204,
      rel_path: 'D/hash-b.mp3',
      title: 'Hash Song Copy',
      artist: 'Artist Z',
      file_hash: 'DEADBEEF01',
    }),
    makeTrack({
      id: 205,
      rel_path: 'E/cat-a.m4a',
      title: 'Catalog A',
      artist: 'Artist W',
      catalog_track_id: 'dz-999',
    }),
    makeTrack({
      id: 206,
      rel_path: 'F/cat-b.m4a',
      title: 'Catalog A Alt',
      artist: 'Artist W',
      catalog_track_id: 'dz-999',
    }),
  ]);

  assert.equal(groups.length, 3);
  for (const g of groups) {
    assert.equal(g.matchType, 'definite');
    assert.equal(g.label, 'Same song');
  }
});

test('suggestedKeep prefers higher bitrate, then most playlists, then oldest added_at', () => {
  const byPlaylists = detectDuplicateGroups([
    makeTrack({
      id: 301,
      title: 'Tie Song',
      artist: 'Tie Artist',
      format: 'mp3',
      bitrate: 320,
      playlistCount: 1,
      added_at: '2025-01-01 00:00:00',
    }),
    makeTrack({
      id: 302,
      title: 'Tie Song',
      artist: 'Tie Artist',
      format: 'mp3',
      bitrate: 320,
      playlistCount: 4,
      added_at: '2026-01-01 00:00:00',
    }),
  ]);
  assert.equal(byPlaylists[0].suggestedKeepId, 302);

  const byOldest = detectDuplicateGroups([
    makeTrack({
      id: 303,
      title: 'Oldest Song',
      artist: 'Tie Artist',
      format: 'mp3',
      bitrate: 320,
      playlistCount: 2,
      added_at: '2026-05-01 00:00:00',
    }),
    makeTrack({
      id: 304,
      title: 'Oldest Song',
      artist: 'Tie Artist',
      format: 'mp3',
      bitrate: 320,
      playlistCount: 2,
      added_at: '2024-03-01 00:00:00',
    }),
  ]);
  assert.equal(byOldest[0].suggestedKeepId, 304);
});

// ---------------------------------------------------------------------------
// 2. Transactional Merge, Rollback, Playing Guard & Rescan Ignore Tests
// ---------------------------------------------------------------------------

test('resolveDuplicatePair merges playlists preserving first position, carries over likes/history, and ignores removed path on rescan', () => {
  const testDb = createTestDb();
  const userId = Number(
    testDb
      .prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', 'hash', 'admin')")
      .run().lastInsertRowid
  );

  const insertTrack = testDb.prepare(
    `INSERT INTO tracks (rel_path, title, artist, album, duration, format, bitrate, size_bytes, added_at, youtube_video_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const trackA = Number(
    insertTrack.run('Artist/A.mp3', 'Intro', 'Other', 'Alb', 120, 'mp3', 320, 2000, '2025-01-01', null)
      .lastInsertRowid
  );
  const trackB = Number(
    insertTrack.run('Artist/B.mp3', 'Middle', 'Other', 'Alb', 130, 'mp3', 320, 2000, '2025-01-01', null)
      .lastInsertRowid
  );
  const trackC = Number(
    insertTrack.run('Artist/C.mp3', 'Outro', 'Other', 'Alb', 140, 'mp3', 320, 2000, '2025-01-01', null)
      .lastInsertRowid
  );

  const demonsKeepId = Number(
    insertTrack.run(
      'Josiah Queen/demons.flac',
      'demons',
      'Josiah Queen',
      'The Prodigal',
      198,
      'flac',
      900,
      25_000_000,
      '2025-06-01',
      null
    ).lastInsertRowid
  );
  const demonsRemoveId = Number(
    insertTrack.run(
      'YouTube/Josiah Queen - demons.m4a',
      'demons',
      'Josiah Queen',
      'YouTube',
      199,
      'm4a',
      128,
      3_500_000,
      '2025-07-01',
      'vid12345678'
    ).lastInsertRowid
  );

  // Playlist 1 has removeId BEFORE keepId -> keepId must end up at index 1 (position of first)
  const pl1 = Number(
    testDb.prepare("INSERT INTO playlists (user_id, name) VALUES (?, 'Both Remove First')").run(userId)
      .lastInsertRowid
  );
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl1, trackA, 0);
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl1, demonsRemoveId, 1);
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl1, trackB, 2);
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl1, demonsKeepId, 3);
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl1, trackC, 4);

  // Playlist 2 has keepId BEFORE removeId -> keepId stays at index 1
  const pl2 = Number(
    testDb.prepare("INSERT INTO playlists (user_id, name) VALUES (?, 'Both Keep First')").run(userId)
      .lastInsertRowid
  );
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl2, trackA, 0);
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl2, demonsKeepId, 1);
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl2, trackB, 2);
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl2, demonsRemoveId, 3);

  // Playlist 3 has ONLY removeId -> replaced in place by keepId
  const pl3 = Number(
    testDb.prepare("INSERT INTO playlists (user_id, name) VALUES (?, 'Only Removed')").run(userId)
      .lastInsertRowid
  );
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(pl3, demonsRemoveId, 0);

  // Only the removed copy was liked
  testDb
    .prepare('INSERT INTO liked_tracks (user_id, track_id) VALUES (?, ?)')
    .run(userId, demonsRemoveId);

  // Play history & listening events on removed copy
  testDb
    .prepare(
      'INSERT INTO play_history (user_id, title, artist, track_id, played_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId, 'demons', 'Josiah Queen', demonsRemoveId, 1700000000000);
  testDb
    .prepare(
      'INSERT INTO listening_events (user_id, event, track_id, title, artist) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId, 'complete', String(demonsRemoveId), 'demons', 'Josiah Queen');

  // Verify detection finds "demons" by Josiah Queen as 1 group with 2 copies
  const groupsBefore = findDuplicateGroupsForUser(testDb, {userId, userRole: 'admin'});
  assert.equal(groupsBefore.length, 1);
  assert.equal(groupsBefore[0].copies.length, 2);
  assert.equal(groupsBefore[0].suggestedKeepId, demonsKeepId);

  // Guard: currently playing copy cannot be removed
  assert.throws(
    () =>
      resolveDuplicatePair(testDb, {
        userId,
        userRole: 'admin',
        keepId: demonsKeepId,
        removeId: demonsRemoveId,
        playingTrackIds: new Set([demonsRemoveId]),
        silentLog: true,
      }),
    (err: unknown) => err instanceof DuplicateResolveError && err.status === 409
  );

  // Guard: non-duplicate pair is rejected
  assert.throws(
    () =>
      resolveDuplicatePair(testDb, {
        userId,
        userRole: 'admin',
        keepId: trackA,
        removeId: demonsRemoveId,
        silentLog: true,
      }),
    (err: unknown) => err instanceof DuplicateResolveError && err.status === 400
  );

  // Perform the actual merge
  const result = resolveDuplicatePair(testDb, {
    userId,
    userRole: 'admin',
    keepId: demonsKeepId,
    removeId: demonsRemoveId,
    silentLog: true,
  });

  assert.equal(result.playlistsUpdated, 3);
  assert.equal(result.keepLiked, true);
  assert.equal(result.remainingGroup, null);

  // Removed track row is deleted; kept track remains
  assert.equal(
    testDb.prepare('SELECT id FROM tracks WHERE id = ?').get(demonsRemoveId),
    undefined
  );
  assert.ok(testDb.prepare('SELECT id FROM tracks WHERE id = ?').get(demonsKeepId));

  // Playlist 1: [trackA, demonsKeepId, trackB, trackC] with positions 0, 1, 2, 3
  const pl1Rows = testDb
    .prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC')
    .all(pl1) as Array<{track_id: number; position: number}>;
  assert.deepEqual(pl1Rows, [
    {track_id: trackA, position: 0},
    {track_id: demonsKeepId, position: 1},
    {track_id: trackB, position: 2},
    {track_id: trackC, position: 3},
  ]);

  // Playlist 2: [trackA, demonsKeepId, trackB] with positions 0, 1, 2
  const pl2Rows = testDb
    .prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC')
    .all(pl2) as Array<{track_id: number; position: number}>;
  assert.deepEqual(pl2Rows, [
    {track_id: trackA, position: 0},
    {track_id: demonsKeepId, position: 1},
    {track_id: trackB, position: 2},
  ]);

  // Playlist 3: [demonsKeepId] at position 0
  const pl3Rows = testDb
    .prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC')
    .all(pl3) as Array<{track_id: number; position: number}>;
  assert.deepEqual(pl3Rows, [{track_id: demonsKeepId, position: 0}]);

  // Kept track inherited liked status
  const likedRow = testDb
    .prepare('SELECT 1 FROM liked_tracks WHERE user_id = ? AND track_id = ?')
    .get(userId, demonsKeepId);
  assert.ok(likedRow);

  // Play history & listening events reassigned to kept track
  const historyRows = testDb
    .prepare('SELECT track_id FROM play_history WHERE user_id = ?')
    .all(userId) as Array<{track_id: number}>;
  assert.deepEqual(historyRows, [{track_id: demonsKeepId}]);

  const eventRows = testDb
    .prepare('SELECT track_id FROM listening_events WHERE user_id = ?')
    .all(userId) as Array<{track_id: string}>;
  assert.deepEqual(eventRows, [{track_id: String(demonsKeepId)}]);

  // Ignored path recorded and skipped by scanner filterIgnoredAudioFiles on rescan
  const ignoredRows = testDb
    .prepare('SELECT rel_path FROM library_ignored_paths')
    .all() as Array<{rel_path: string}>;
  assert.deepEqual(ignoredRows, [{rel_path: 'YouTube/Josiah Queen - demons.m4a'}]);

  const musicDir = '/tmp/music';
  const ignoredSet = new Set(ignoredRows.map((r) => r.rel_path));
  const discovered = [
    path.join(musicDir, 'Josiah Queen/demons.flac'),
    path.join(musicDir, 'YouTube/Josiah Queen - demons.m4a'),
  ];
  const afterFilter = filterIgnoredAudioFiles(discovered, musicDir, ignoredSet);
  assert.deepEqual(afterFilter, [path.join(musicDir, 'Josiah Queen/demons.flac')]);

  testDb.close();
});

test('resolveDuplicatePair rolls back completely if an error occurs inside the transaction', () => {
  const testDb = createTestDb();
  const userId = Number(
    testDb
      .prepare("INSERT INTO users (username, password_hash, role) VALUES ('bob', 'hash', 'listener')")
      .run().lastInsertRowid
  );

  const insertTrack = testDb.prepare(
    `INSERT INTO tracks (rel_path, title, artist, album, duration, format, bitrate, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const keepId = Number(
    insertTrack.run('Music/song.flac', 'Rollback Song', 'Artist', 'Alb', 200, 'flac', 900, 20000)
      .lastInsertRowid
  );
  const removeId = Number(
    insertTrack.run('Music/song.mp3', 'Rollback Song', 'Artist', 'Alb', 201, 'mp3', 192, 4000)
      .lastInsertRowid
  );
  const plId = Number(
    testDb.prepare("INSERT INTO playlists (user_id, name) VALUES (?, 'My Playlist')").run(userId)
      .lastInsertRowid
  );
  testDb
    .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
    .run(plId, removeId, 0);
  testDb
    .prepare('INSERT INTO liked_tracks (user_id, track_id) VALUES (?, ?)')
    .run(userId, removeId);
  testDb
    .prepare(
      'INSERT INTO play_history (user_id, title, artist, track_id, played_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId, 'Rollback Song', 'Artist', removeId, 1700000000000);

  assert.throws(
    () =>
      resolveDuplicatePair(testDb, {
        userId,
        keepId,
        removeId,
        silentLog: true,
        beforeCommitHook: () => {
          throw new Error('simulated failure before commit');
        },
      }),
    /simulated failure before commit/
  );

  // Everything must remain completely untouched
  assert.ok(testDb.prepare('SELECT id FROM tracks WHERE id = ?').get(removeId));
  assert.ok(testDb.prepare('SELECT id FROM tracks WHERE id = ?').get(keepId));
  assert.deepEqual(
    testDb.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').all(plId),
    [{track_id: removeId}]
  );
  assert.deepEqual(
    testDb.prepare('SELECT track_id FROM liked_tracks WHERE user_id = ?').all(userId),
    [{track_id: removeId}]
  );
  assert.deepEqual(
    testDb.prepare('SELECT track_id FROM play_history WHERE user_id = ?').all(userId),
    [{track_id: removeId}]
  );
  assert.deepEqual(
    testDb.prepare('SELECT rel_path FROM library_ignored_paths').all(),
    []
  );

  testDb.close();
});
