import assert from 'node:assert/strict';
import test from 'node:test';
import {ListeningLearning, type ListeningEventPayload, type ListeningEventType} from '../src/lib/listeningLearning.ts';
import {
  planAutoplayQueue,
  type AutoplayCandidate,
} from './autoplay.ts';
import {buildListeningProfileFromEvents} from './listeningProfile.ts';

function makeCandidate(overrides: Partial<AutoplayCandidate> & {id: string; artist: string; title: string}): AutoplayCandidate {
  return {
    videoId: overrides.videoId ?? overrides.id.replace(/^yt-/, ''),
    trackId: null,
    album: 'Single',
    duration: 210,
    isYouTubeStream: true,
    sourcePool: 'related',
    playbackSourceKind: 'official_audio',
    recommendationIdentity: `music:youtube:${overrides.id}`,
    canonicalIdentity: `${overrides.artist.toLowerCase()}::${overrides.title.toLowerCase()}`,
    score: 0.7,
    semanticScore: 0.7,
    ...overrides,
  };
}

test('ListeningLearning ignores seeks, paused ticks, and suspended-tab jumps', () => {
  const emitted: Array<{event: ListeningEventType; payload: ListeningEventPayload}> = [];
  const ll = new ListeningLearning((event, payload) => emitted.push({event, payload}));
  const track = {id: 'yt-dQw4w9WgXcQ', title: 'Track A', artist: 'Artist A', duration: 200};

  // Start at 0, then seek across the whole track in 10s jumps
  ll.update(track, 0, true);
  ll.update(track, 15, true);
  ll.update(track, 45, true);
  ll.update(track, 120, true);
  // Paused forward step should not count
  ll.update(track, 121, false);
  // Backwards seek should not count
  ll.update(track, 10, true);

  assert.equal(ll.listenedSeconds, 0);
  assert.equal(emitted.length, 0);
});

test('ListeningLearning counts real forward steps and emits played_30s once per track', () => {
  const emitted: Array<{event: ListeningEventType; payload: ListeningEventPayload}> = [];
  const ll = new ListeningLearning((event, payload) => emitted.push({event, payload}));
  const track = {id: 'yt-dQw4w9WgXcQ', title: 'Track A', artist: 'Artist A', duration: 200};

  for (let sec = 0; sec <= 45; sec += 1) {
    ll.update(track, sec, true);
  }

  assert.equal(ll.listenedSeconds, 45);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'played_30s');
  assert.equal(emitted[0].payload.video_id, 'dQw4w9WgXcQ');
  assert.equal(emitted[0].payload.listened_sec, 30);

  // Track change resets counter and allows emitting again for next track
  const track2 = {id: 42, title: 'Track B', artist: 'Artist B', duration: 180};
  ll.update(track2, 0, true);
  assert.equal(ll.listenedSeconds, 0);
  for (let sec = 1; sec <= 30; sec += 1) {
    ll.update(track2, sec, true);
  }
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].payload.track_id, '42');
});

test('ListeningLearning emits generated_completed and generated_skipped_early only for generated sources', () => {
  const emitted: Array<{event: ListeningEventType; payload: ListeningEventPayload}> = [];
  const ll = new ListeningLearning((event, payload) => emitted.push({event, payload}));

  // 1. Autoplay track skipped at 5s (< min(60, max(12, 200*0.3)) = 60s)
  const autoplayTrack = {
    id: 'yt-aaaaaaaaaaa',
    title: 'Auto Song',
    artist: 'Skip Me',
    duration: 200,
    recommendation: {source: 'autoplay' as const},
  };
  for (let sec = 0; sec <= 5; sec += 1) {
    ll.update(autoplayTrack, sec, true);
  }
  ll.skip(autoplayTrack, 200);
  ll.skip(autoplayTrack, 200); // duplicate guard
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'generated_skipped_early');
  assert.equal(emitted[0].payload.source, 'autoplay');

  // 2. Discover track completed after 60s (>= min(60, max(12, 200*0.6)) = 60s)
  const discoverTrack = {
    id: 'yt-bbbbbbbbbbb',
    title: 'Discover Song',
    artist: 'Good Artist',
    duration: 200,
    recommendation: {source: 'discover' as const},
  };
  for (let sec = 0; sec <= 60; sec += 1) {
    ll.update(discoverTrack, sec, true);
  }
  ll.complete(discoverTrack, 200);
  assert.equal(emitted.filter((e) => e.event === 'generated_completed').length, 1);
  assert.equal(emitted.filter((e) => e.event === 'played_30s').length, 1);

  // 3. Library track skipped at 2s should NOT emit generated_skipped_early
  const libraryTrack = {
    id: 99,
    title: 'My Track',
    artist: 'Library Artist',
    duration: 200,
    recommendation: {source: 'library' as const},
  };
  ll.update(libraryTrack, 0, true);
  ll.update(libraryTrack, 2, true);
  ll.skip(libraryTrack, 200);
  assert.equal(emitted.filter((e) => e.event === 'generated_skipped_early').length, 1);
});

test('buildListeningProfileFromEvents applies 14-day half-life decay and weights', () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const iso = (daysAgo: number) =>
    new Date(now - daysAgo * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

  const profile = buildListeningProfileFromEvents(
    [
      {event: 'played_30s', artist: 'Alpha', created_at: iso(0)}, // +1.0
      {event: 'generated_completed', artist: 'Alpha', created_at: iso(14)}, // +1.5 * 0.5 = +0.75 => 1.75
      {event: 'played_30s', artist: 'Beta', created_at: iso(10)}, // outside 7d window, +1 * 0.5^(10/14)
      {event: 'generated_skipped_early', artist: 'Gamma', created_at: iso(0)}, // -2.0
    ],
    now
  );

  assert.equal(profile.tracksPlayed7d, 1);
  assert.equal(profile.topArtists[0].artist, 'Alpha');
  assert.equal(profile.topArtists[0].score, 1.75);
  assert.deepEqual(profile.skippedArtists, ['Gamma']);
  assert.deepEqual(profile.recentArtists, ['Alpha', 'Beta']);
});

test('planAutoplayQueue gently applies listeningProfile without breaking artist caps', () => {
  const related: AutoplayCandidate[] = [
    makeCandidate({id: 'yt-11111111111', artist: 'Skipped Artist', title: 'Song 1', score: 0.75}),
    makeCandidate({id: 'yt-22222222222', artist: 'Neutral Artist', title: 'Song 2', score: 0.72}),
    makeCandidate({id: 'yt-33333333333', artist: 'Top Artist', title: 'Song 3', score: 0.70}),
    makeCandidate({id: 'yt-44444444444', artist: 'Top Artist', title: 'Song 4', score: 0.69}),
    makeCandidate({id: 'yt-55555555555', artist: 'Top Artist', title: 'Song 5', score: 0.68}),
  ];

  const planned = planAutoplayQueue(
    {related},
    {
      intent: 'autoplay',
      limit: 5,
      listeningProfile: {
        topArtists: [{artist: 'Top Artist', score: 6}],
        skippedArtists: ['Skipped Artist'],
      },
    }
  );

  // Top Artist (0.70 + 0.08 = 0.78) moves ahead of Neutral (0.72) and Skipped (0.75 - 0.14 = 0.61)
  assert.equal(planned[0].artist, 'Top Artist');
  // Skipped Artist drops to the back
  assert.equal(planned[planned.length - 1].artist, 'Skipped Artist');
  // Autoplay artist cap of 2 still holds for Top Artist (Song 5 must be excluded)
  assert.equal(planned.filter((item) => item.artist === 'Top Artist').length, 2);
});
