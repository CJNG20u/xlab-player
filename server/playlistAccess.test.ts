import assert from 'node:assert/strict';
import test from 'node:test';
import {canManagePlaylist, canViewPlaylist, parseVisibility} from './playlistAccess.ts';

const admin = {id: 1, role: 'admin'};
const alice = {id: 2, role: 'listener'};
const bob = {id: 3, role: 'listener'};

test('parseVisibility accepts only public and private', () => {
  assert.equal(parseVisibility('public'), 'public');
  assert.equal(parseVisibility('private'), 'private');
  assert.equal(parseVisibility('PUBLIC'), null);
  assert.equal(parseVisibility(''), null);
  assert.equal(parseVisibility(undefined), null);
  assert.equal(parseVisibility(1), null);
});

test('private playlists are visible to the owner and admins only', () => {
  const p = {user_id: alice.id, visibility: 'private'};
  assert.equal(canViewPlaylist(alice, p), true);
  assert.equal(canViewPlaylist(admin, p), true);
  assert.equal(canViewPlaylist(bob, p), false);
});

test('public playlists are visible to everyone', () => {
  const p = {user_id: alice.id, visibility: 'public'};
  assert.equal(canViewPlaylist(bob, p), true);
});

test('missing or unknown visibility counts as private', () => {
  assert.equal(canViewPlaylist(bob, {user_id: alice.id}), false);
  assert.equal(canViewPlaylist(bob, {user_id: alice.id, visibility: null}), false);
  assert.equal(canViewPlaylist(bob, {user_id: alice.id, visibility: 'friends'}), false);
});

test('an admin-owned local playlist stays hidden from listeners until made public', () => {
  assert.equal(canViewPlaylist(alice, {user_id: admin.id, visibility: 'private'}), false);
  assert.equal(canViewPlaylist(alice, {user_id: admin.id, visibility: 'public'}), true);
});

test('only the owner or an admin can manage a playlist, even a public one', () => {
  const p = {user_id: alice.id, visibility: 'public'};
  assert.equal(canManagePlaylist(alice, p), true);
  assert.equal(canManagePlaylist(admin, p), true);
  assert.equal(canManagePlaylist(bob, p), false);
});
