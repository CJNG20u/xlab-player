import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDiscoveryPool,
  buildLocalPool,
  canonicalSongIdentity,
  classifyPlaybackSourceKind,
  cleanArtistName,
  extractArtistKeys,
  MAX_GENERATED_DURATION_SECONDS,
  planAutoplayQueue,
  scoreRelatedPool,
  type AutoplayCandidate,
  type LibraryTrackInput,
  type PlaybackSourceKind,
} from './autoplay.ts';

function makeCandidate(
  overrides: Partial<AutoplayCandidate> & {videoId?: string | null; title: string; artist: string}
): AutoplayCandidate {
  const videoId = overrides.videoId === undefined ? 'abcdefghijk' : overrides.videoId;
  const isLocal = overrides.sourcePool === 'local' || overrides.isYouTubeStream === false;
  const trackId = overrides.trackId ?? (isLocal ? 101 : null);
  const id = overrides.id ?? (isLocal && trackId !== null ? trackId : `yt-${videoId}`);
  const canonical = overrides.canonicalIdentity ?? canonicalSongIdentity(overrides.artist, overrides.title);
  const recId =
    overrides.recommendationIdentity ??
    (isLocal && trackId !== null ? `music:track:${trackId}` : `music:youtube:${videoId}`);

  return {
    id,
    videoId,
    trackId,
    title: overrides.title,
    artist: overrides.artist,
    album: overrides.album ?? 'Test Album',
    duration: overrides.duration ?? 210,
    isYouTubeStream: !isLocal,
    sourcePool: overrides.sourcePool ?? 'related',
    playbackSourceKind: overrides.playbackSourceKind ?? 'official_audio',
    recommendationIdentity: recId,
    canonicalIdentity: canonical,
    score: overrides.score ?? 0.8,
    semanticScore: overrides.semanticScore ?? (overrides.score ?? 0.8),
  };
}

test('artist name normalization strips channel suffixes and splits collaborations', () => {
  assert.equal(cleanArtistName('Daft Punk - Topic'), 'Daft Punk');
  assert.equal(cleanArtistName('Daft Punk (Official)'), 'Daft Punk');
  assert.equal(cleanArtistName('Daft Punk [Official Channel]'), 'Daft Punk');
  assert.equal(cleanArtistName('Rosalia (Oficial)'), 'Rosalia');
  assert.equal(cleanArtistName('TheWeekndVEVO'), 'TheWeeknd');
  assert.equal(cleanArtistName('Taylor Swift VEVO'), 'Taylor Swift');
  assert.equal(cleanArtistName('Radiohead Official Channel'), 'Radiohead');

  const keys = extractArtistKeys('Daft Punk feat. Pharrell Williams & Nile Rodgers x Julian Casablancas');
  assert.deepEqual(
    keys,
    new Set(['daft punk', 'pharrell williams', 'nile rodgers', 'julian casablancas'])
  );

  // Suffix variants collapse to the same key
  assert.deepEqual(extractArtistKeys('Tame Impala - Topic'), extractArtistKeys('Tame Impala (Official)'));
  assert.deepEqual(extractArtistKeys('Tame ImpalaVEVO'), extractArtistKeys('Tame Impala'));
});

test('artist cap enforces max 2 per artist for autoplay and max 3 for radio across credited artists', () => {
  const related: AutoplayCandidate[] = [
    makeCandidate({videoId: 'vid00000001', title: 'Track 1', artist: 'Artist A - Topic', score: 0.99}),
    makeCandidate({videoId: 'vid00000002', title: 'Track 2', artist: 'Artist A (Official)', score: 0.98}),
    makeCandidate({videoId: 'vid00000003', title: 'Track 3', artist: 'Artist A feat. Artist B', score: 0.97}),
    makeCandidate({videoId: 'vid00000004', title: 'Track 4', artist: 'Artist A', score: 0.96}),
    makeCandidate({videoId: 'vid00000005', title: 'Track 5', artist: 'Artist B & Artist C', score: 0.95}),
    makeCandidate({videoId: 'vid00000006', title: 'Track 6', artist: 'Artist B', score: 0.94}),
    makeCandidate({videoId: 'vid00000007', title: 'Track 7', artist: 'Artist B', score: 0.93}),
    makeCandidate({videoId: 'vid00000008', title: 'Track 8', artist: 'Artist D', score: 0.92}),
  ];

  const autoplay = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8});
  const countArtist = (items: AutoplayCandidate[], key: string) =>
    items.filter((i) => extractArtistKeys(i.artist).has(key)).length;

  assert.equal(countArtist(autoplay, 'artist a'), 2);
  assert.equal(countArtist(autoplay, 'artist b'), 2);
  // Track 3 ("Artist A feat. Artist B") must be skipped because Artist A already hit cap=2
  assert.ok(!autoplay.some((i) => i.videoId === 'vid00000003'));

  const radio = planAutoplayQueue({related}, {intent: 'radio', limit: 8});
  assert.equal(countArtist(radio, 'artist a'), 3);
  // Track 3 counted toward both Artist A (3rd) and Artist B (1st), so Artist B still allows 2 more
  assert.ok(radio.some((i) => i.videoId === 'vid00000003'));
  assert.ok(!radio.some((i) => i.videoId === 'vid00000004'));
  assert.equal(countArtist(radio, 'artist b'), 3);
});

test('context pre-fill blocks the last 2 context artists from appearing in the next batch', () => {
  const related: AutoplayCandidate[] = [
    makeCandidate({videoId: 'ctx00000001', title: 'Old Context Song', artist: 'Old Artist', score: 0.99}),
    makeCandidate({videoId: 'ctx00000002', title: 'Recent 1 Song', artist: 'Recent One - Topic', score: 0.98}),
    makeCandidate({videoId: 'ctx00000003', title: 'Recent 2 Song', artist: 'Recent Two (Official)', score: 0.97}),
    makeCandidate({videoId: 'ctx00000004', title: 'Collab With Recent 2', artist: 'Fresh Artist feat. Recent Two', score: 0.96}),
    makeCandidate({videoId: 'ctx00000005', title: 'Fresh Song', artist: 'Fresh Artist', score: 0.95}),
  ];

  const selected = planAutoplayQueue(
    {related},
    {
      intent: 'autoplay',
      limit: 8,
      contextArtists: ['Old Artist', 'Middle Artist', 'Recent One', 'Recent Two'],
    }
  );

  const ids = selected.map((i) => i.videoId);
  assert.deepEqual(ids, ['ctx00000001', 'ctx00000005']);
});

test('exclude filters out tracks by videoId, trackId, yt-id, recommendationIdentity, or canonicalIdentity', () => {
  const related: AutoplayCandidate[] = [
    makeCandidate({videoId: 'exc00000001', title: 'Excluded By Vid', artist: 'Artist 1', score: 0.99}),
    makeCandidate({videoId: 'exc00000002', title: 'Excluded By RecId', artist: 'Artist 2', score: 0.98}),
    makeCandidate({videoId: 'exc00000003', title: 'Excluded By Canonical', artist: 'Artist 3', score: 0.97}),
    makeCandidate({videoId: 'exc00000004', title: 'Kept Song', artist: 'Artist 4', score: 0.96}),
  ];
  const local: AutoplayCandidate[] = [
    makeCandidate({
      sourcePool: 'local',
      isYouTubeStream: false,
      trackId: 42,
      videoId: null,
      title: 'Excluded Local',
      artist: 'Artist 5',
      score: 0.76,
    }),
    makeCandidate({
      sourcePool: 'local',
      isYouTubeStream: false,
      trackId: 43,
      videoId: null,
      title: 'Kept Local',
      artist: 'Artist 6',
      score: 0.76,
    }),
  ];

  const selected = planAutoplayQueue(
    {related, local},
    {
      intent: 'radio',
      limit: 8,
      exclude: [
        'exc00000001',
        'music:youtube:exc00000002',
        canonicalSongIdentity('Artist 3', 'Excluded By Canonical'),
        'music:track:42',
      ],
    }
  );

  assert.deepEqual(
    selected.map((i) => i.title),
    ['Kept Song', 'Kept Local']
  );
});

test('pool mix pattern follows 7:1 for autoplay, 6:1:1 for radio, and falls back when a pool is empty', () => {
  const makePool = (pool: 'related' | 'discovery' | 'local', count: number): AutoplayCandidate[] =>
    Array.from({length: count}, (_, i) =>
      makeCandidate({
        sourcePool: pool,
        isYouTubeStream: pool !== 'local',
        trackId: pool === 'local' ? 1000 + i : null,
        videoId: pool === 'local' ? null : `${pool.slice(0, 3)}${String(i).padStart(8, '0')}`,
        title: `${pool} Song ${i}`,
        artist: `${pool} Artist ${i}`,
        score: 0.9 - i * 0.01,
      })
    );

  const autoplay = planAutoplayQueue(
    {
      related: makePool('related', 10),
      discovery: makePool('discovery', 4),
      local: makePool('local', 4),
    },
    {intent: 'autoplay', limit: 16}
  );
  assert.deepEqual(
    autoplay.map((i) => i.sourcePool),
    [
      'related', 'related', 'related', 'related', 'related', 'related', 'related', 'discovery',
      // Next cycle: only 3 related left, so remaining slots fall back to discovery then local
      'related', 'related', 'related', 'discovery', 'discovery', 'discovery', 'local', 'local',
    ]
  );

  const radio = planAutoplayQueue(
    {
      related: makePool('related', 12),
      discovery: makePool('discovery', 4),
      local: makePool('local', 4),
    },
    {intent: 'radio', limit: 16}
  );
  assert.deepEqual(
    radio.map((i) => i.sourcePool),
    [
      'related', 'related', 'related', 'related', 'related', 'related', 'discovery', 'local',
      'related', 'related', 'related', 'related', 'related', 'related', 'discovery', 'local',
    ]
  );

  // Fallback when discovery is empty during autoplay
  const fallback = planAutoplayQueue(
    {
      related: makePool('related', 8),
      discovery: [],
      local: makePool('local', 2),
    },
    {intent: 'autoplay', limit: 8}
  );
  assert.equal(fallback.length, 8);
  assert.ok(fallback.every((i) => i.sourcePool === 'related'));
});

test('duration filter drops tracks longer than 30 minutes and keeps unknown or <= 30m tracks', () => {
  const related: AutoplayCandidate[] = [
    makeCandidate({videoId: 'dur00000001', title: 'Normal Song', artist: 'Artist 1', duration: 200, score: 0.9}),
    makeCandidate({
      videoId: 'dur00000002',
      title: 'Exact 30 Min',
      artist: 'Artist 2',
      duration: MAX_GENERATED_DURATION_SECONDS,
      score: 0.89,
    }),
    makeCandidate({
      videoId: 'dur00000003',
      title: 'Long Concert Mix',
      artist: 'Artist 3',
      duration: MAX_GENERATED_DURATION_SECONDS + 1,
      score: 0.99,
    }),
    makeCandidate({videoId: 'dur00000004', title: 'Unknown Duration', artist: 'Artist 4', duration: 0, score: 0.88}),
  ];

  const selected = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8});
  assert.deepEqual(
    selected.map((i) => i.videoId),
    ['dur00000001', 'dur00000002', 'dur00000004']
  );
});

test('duplicate songs by normalized title+artist keep the best upload kind', () => {
  const variants: Array<{vid: string; title: string; channel: string; expectedKind: PlaybackSourceKind}> = [
    {vid: 'dup00000001', title: 'Starboy (Lyrics)', channel: 'Random Lyrics Channel', expectedKind: 'third_party_lyrics'},
    {vid: 'dup00000002', title: 'Starboy', channel: 'Random Uploader', expectedKind: 'unverified'},
    {vid: 'dup00000003', title: 'Starboy (Official Video)', channel: 'TheWeekndVEVO', expectedKind: 'official_video'},
    {vid: 'dup00000004', title: 'Starboy (Audio)', channel: 'The Weeknd', expectedKind: 'artist_audio'},
    {vid: 'dup00000005', title: 'Starboy', channel: 'The Weeknd - Topic', expectedKind: 'official_audio'},
  ];

  for (const v of variants) {
    assert.equal(
      classifyPlaybackSourceKind({title: v.title, artist: 'The Weeknd', channel: v.channel}),
      v.expectedKind
    );
  }

  const related = variants.map((v, idx) =>
    makeCandidate({
      videoId: v.vid,
      title: v.title,
      artist: 'The Weeknd',
      playbackSourceKind: v.expectedKind,
      score: 0.9 - idx * 0.05, // Give lower score to official_audio to verify source kind wins
    })
  );

  const selected = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8});
  assert.equal(selected.length, 1);
  assert.equal(selected[0].videoId, 'dup00000005');
  assert.equal(selected[0].playbackSourceKind, 'official_audio');
});

test('scoreRelatedPool applies recency weighting over last 4 anchors and caps at 48', () => {
  const anchors = Array.from({length: 5}, (_, aIdx) => ({
    seedVideoId: `seed000000${aIdx}`,
    rows: Array.from({length: 25}, (__, rIdx) => ({
      videoId: `r${aIdx}${String(rIdx).padStart(9, '0')}`,
      title: `Track ${aIdx}-${rIdx}`,
      artist: `Artist ${aIdx}-${rIdx} - Topic`,
      channel: `Artist ${aIdx}-${rIdx} - Topic`,
      duration: 200,
      thumbnail: '',
    })),
  }));

  const pool = scoreRelatedPool(anchors, {contextLength: 5});
  assert.equal(pool.length, 48);
  // Newest anchor (index 3 of last 4 -> recency = 1.0, rank 0 -> semantic = 1.0) must be #1
  assert.equal(pool[0].videoId, 'r4000000000');
  assert.equal(pool[0].score, 1);
  // Oldest dropped anchor (aIdx=0) must not appear
  assert.ok(!pool.some((item) => item.videoId?.startsWith('r0')));
});

test('buildLocalPool scores context artists at 0.76 and related artists at 0.62, and buildDiscoveryPool excludes owned tracks', () => {
  const library: LibraryTrackInput[] = [
    {
      id: 1,
      rel_path: 'a.flac',
      title: 'Instant Crush',
      artist: 'Daft Punk',
      album: 'RAM',
      track_number: 5,
      year: 2013,
      duration: 337,
      format: 'flac',
      bitrate: 900,
      size_bytes: 30_000_000,
      cover_file: null,
      dominant_color: '#111111',
      added_at: '2026-01-01',
    },
    {
      id: 2,
      rel_path: 'b.flac',
      title: 'D.A.N.C.E.',
      artist: 'Justice',
      album: 'Cross',
      track_number: 3,
      year: 2007,
      duration: 242,
      format: 'flac',
      bitrate: 900,
      size_bytes: 25_000_000,
      cover_file: null,
      dominant_color: '#111111',
      added_at: '2026-01-01',
    },
    {
      id: 3,
      rel_path: 'c.flac',
      title: 'Unrelated Song',
      artist: 'Someone Else',
      album: 'Other',
      track_number: 1,
      year: 2020,
      duration: 180,
      format: 'flac',
      bitrate: 900,
      size_bytes: 20_000_000,
      cover_file: null,
      dominant_color: '#111111',
      added_at: '2026-01-01',
    },
  ];

  const local = buildLocalPool(library, {
    contextArtists: ['Daft Punk - Topic'],
    relatedArtists: ['Justice'],
  });
  assert.equal(local.length, 2);
  assert.equal(local[0].trackId, 1);
  assert.equal(local[0].score, 0.76);
  assert.equal(local[1].trackId, 2);
  assert.equal(local[1].score, 0.62);

  const ownedCanonical = new Set(library.map((t) => canonicalSongIdentity(t.artist, t.title)));
  const discovery = buildDiscoveryPool(
    [
      {videoId: 'dis00000001', title: 'D.A.N.C.E.', artist: 'Justice', duration: 242},
      {videoId: 'dis00000002', title: 'Genesis', artist: 'Justice', duration: 234},
    ],
    {ownedCanonicalIds: ownedCanonical}
  );
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].videoId, 'dis00000002');
});

test('deterministic ranking by default and deterministic Gumbel-top-k when entropy is supplied', () => {
  const related = Array.from({length: 10}, (_, i) =>
    makeCandidate({
      videoId: `ent0000000${i}`,
      title: `Song ${i}`,
      artist: `Unique Artist ${i}`,
      score: 0.75 - i * 0.005, // Close scores so temp=0.2 can swap nearby items
    })
  );

  const detA = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8});
  const detB = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8});
  assert.deepEqual(
    detA.map((i) => i.videoId),
    detB.map((i) => i.videoId)
  );
  assert.deepEqual(
    detA.map((i) => i.videoId),
    related.slice(0, 8).map((i) => i.videoId)
  );

  // Same entropy string is deterministic
  const gumbel1a = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8, entropy: 'session-alpha'});
  const gumbel1b = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8, entropy: 'session-alpha'});
  assert.deepEqual(
    gumbel1a.map((i) => i.videoId),
    gumbel1b.map((i) => i.videoId)
  );

  // Different entropy strings vary order across a handful of seeds
  const orders = new Set<string>();
  for (const seed of ['session-1', 'session-2', 'session-3', 'session-4', 'session-5']) {
    const res = planAutoplayQueue({related}, {intent: 'autoplay', limit: 8, entropy: seed});
    orders.add(res.map((i) => i.videoId).join(','));
  }
  assert.ok(orders.size > 1, 'Expected Gumbel-top-k with distinct entropy strings to vary order');
});
