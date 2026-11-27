import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {
  canViewPlaylistWithShares,
  getPlaylistShareIds,
  parseShareIds,
  replacePlaylistShares,
  type PlaylistShareDb,
} from './playlistAccess.ts';

function makeDb(): PlaylistShareDb {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT);
    CREATE TABLE playlist_shares (playlist_id INTEGER, user_id INTEGER, PRIMARY KEY (playlist_id, user_id));
    INSERT INTO users (id, role) VALUES (1,'admin'),(2,'listener'),(3,'listener'),(4,'listener');
  `);
  return db as unknown as PlaylistShareDb;
}

const alice = {id: 2, role: 'listener'};
const bob = {id: 3, role: 'listener'};
const carol = {id: 4, role: 'listener'};
const playlist = {id: 10, user_id: 2, visibility: 'private'};

test('a private playlist is visible to a user it is shared with, and nobody else', () => {
  const db = makeDb();
  assert.equal(canViewPlaylistWithShares(db, bob, playlist), false);
  replacePlaylistShares(db, playlist, [3]);
  assert.equal(canViewPlaylistWithShares(db, bob, playlist), true);
  assert.equal(canViewPlaylistWithShares(db, carol, playlist), false);
  assert.equal(canViewPlaylistWithShares(db, alice, playlist), true);
});

test('replacing the list removes people who are no longer included', () => {
  const db = makeDb();
  replacePlaylistShares(db, playlist, [3, 4]);
  assert.deepEqual(getPlaylistShareIds(db, 10), [3, 4]);
  replacePlaylistShares(db, playlist, [4]);
  assert.deepEqual(getPlaylistShareIds(db, 10), [4]);
  assert.equal(canViewPlaylistWithShares(db, bob, playlist), false);
  replacePlaylistShares(db, playlist, []);
  assert.deepEqual(getPlaylistShareIds(db, 10), []);
});

test('the owner, admins and unknown users are never stored as share targets', () => {
  const db = makeDb();
  const stored = replacePlaylistShares(db, playlist, [2, 1, 999, 3]);
  assert.deepEqual(stored, [3]);
  assert.deepEqual(getPlaylistShareIds(db, 10), [3]);
});

test('parseShareIds accepts lists of positive integers and rejects anything else', () => {
  assert.deepEqual(parseShareIds([2, '3', 2]), [2, 3]);
  assert.deepEqual(parseShareIds([]), []);
  assert.equal(parseShareIds('3'), null);
  assert.equal(parseShareIds([0]), null);
  assert.equal(parseShareIds([-1]), null);
  assert.equal(parseShareIds([1.5]), null);
  assert.equal(parseShareIds(['x']), null);
  assert.equal(parseShareIds(undefined), null);
});
