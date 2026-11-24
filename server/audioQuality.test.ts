import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeMomentaryLoudness,
  applyBadMatchRejectionPolicy,
  evaluateAudioQc,
  LEVEL_DROP_DB,
  MIN_RUN_PCT,
  MIN_RUN_SECONDS,
  parseEbur128Output,
  type MomentarySample,
} from './audioFacts.ts';
import {db} from './db.ts';
import {
  buildTrackMatchKey,
  hasWholeWordMarker,
  normalizeScoreText,
  rankVideoCandidates,
  scoreVideoCandidateDetailed,
  YDL_FORMAT_AUDIO_DOWNLOAD,
  YDL_FORMAT_AUDIO_PREVIEW,
} from './downloader.ts';

test('Phase 1: normalizeScoreText strips accents, brackets, punctuation, and filler words', () => {
  assert.equal(
    normalizeScoreText('Café Tacvba - Eres [Official Audio] (HD) feat. Someone!'),
    'cafe tacvba eres someone'
  );
  assert.equal(
    normalizeScoreText('Bohemian Rhapsody (Official Video) [HQ] Lyrics'),
    'bohemian rhapsody'
  );
  assert.equal(
    normalizeScoreText('Stayin’ Alive (ft. Bee Gees) [Official]'),
    'stayin alive'
  );
});

test('Phase 1: whole-word wrong-version matching never triggers on substrings', () => {
  assert.equal(hasWholeWordMarker('Stayin Alive', 'live'), false);
  assert.equal(hasWholeWordMarker('Discover Me', 'cover'), false);
  assert.equal(hasWholeWordMarker('Song Title (Live at Wembley)', 'live'), true);
  assert.equal(hasWholeWordMarker('Song Title [Acoustic Version]', 'acoustic'), true);
  assert.equal(hasWholeWordMarker('Song Title (Sped Up + Reverb)', 'sped up'), true);
  assert.equal(hasWholeWordMarker('Song Title (8D Audio)', '8d'), true);
  assert.equal(hasWholeWordMarker('Song Title 18d', '8d'), false);
});

test('Phase 1: artist is scored against channel ONLY, not title, and wrong versions are penalized both directions', () => {
  const randomUploaderWithArtistInTitle = scoreVideoCandidateDetailed(
    {
      id: 'aaaaaaaaaaa',
      title: 'Queen - Bohemian Rhapsody',
      channel: 'Random Reuploads 99',
      duration: 355,
    },
    'Queen',
    'Bohemian Rhapsody',
    355
  );
  assert.equal(randomUploaderWithArtistInTitle.artistScore, 0);

  const topicChannel = scoreVideoCandidateDetailed(
    {
      id: 'bbbbbbbbbbb',
      title: 'Bohemian Rhapsody',
      channel: 'Queen - Topic',
      duration: 355,
    },
    'Queen',
    'Bohemian Rhapsody',
    355
  );
  assert.equal(topicChannel.artistScore, 0.30);
  assert.equal(topicChannel.titleScore, 0.45);
  assert.equal(topicChannel.durationScore, 0.25);
  assert.ok(topicChannel.score > randomUploaderWithArtistInTitle.score);

  // Candidate has "Live" when request does not -> penalized by 0.20
  const liveVersion = scoreVideoCandidateDetailed(
    {
      id: 'ccccccccccc',
      title: 'Bohemian Rhapsody (Live)',
      channel: 'Queen - Topic',
      duration: 355,
    },
    'Queen',
    'Bohemian Rhapsody',
    355
  );
  assert.ok(liveVersion.score < topicChannel.score);

  // Request asks for "Acoustic", candidate lacks "Acoustic" -> penalized by 0.20
  const studioWhenAcousticRequested = scoreVideoCandidateDetailed(
    {
      id: 'ddddddddddd',
      title: 'Creep',
      channel: 'Radiohead',
      duration: 240,
    },
    'Radiohead',
    'Creep (Acoustic)',
    240
  );
  const acousticWhenAcousticRequested = scoreVideoCandidateDetailed(
    {
      id: 'eeeeeeeeeee',
      title: 'Creep (Acoustic)',
      channel: 'Radiohead',
      duration: 240,
    },
    'Radiohead',
    'Creep (Acoustic)',
    240
  );
  assert.ok(acousticWhenAcousticRequested.score > studioWhenAcousticRequested.score);

  // "Stayin' Alive" must NOT get penalized for "live"
  const stayinAlive = scoreVideoCandidateDetailed(
    {
      id: 'fffffffffff',
      title: "Stayin' Alive",
      channel: 'Bee Gees',
      duration: 285,
    },
    'Bee Gees',
    "Stayin' Alive",
    285
  );
  assert.equal(stayinAlive.score, 1);
});

test('Phase 1: rankVideoCandidates sorts by rounded 1-decimal score, then source preference, then exact score, and caps at top 5', () => {
  const entries = [
    {id: '11111111111', title: 'My Song (Lyrics)', channel: 'LyricsHub', duration: 200},
    {id: '22222222222', title: 'My Song (Official Video)', channel: 'My Artist Official', duration: 204},
    {id: '33333333333', title: 'My Song', channel: 'My Artist - Topic', duration: 201},
    {id: '44444444444', title: 'My Song (Karaoke)', channel: 'KaraokeTV', duration: 200},
    {id: '55555555555', title: 'My Song (Official Audio)', channel: 'My Artist', duration: 200},
    {id: '66666666666', title: 'My Song (Slowed + Reverb)', channel: 'Vibes', duration: 230},
  ];
  const ranked = rankVideoCandidates(entries, 'My Artist', 'My Song', 200);
  assert.equal(ranked.length, 5);
  assert.equal(ranked[0].videoId, '33333333333');
});

test('Phase 2: analyzeMomentaryLoudness detects sustained >=12dB drops ignoring first/last 8s', () => {
  assert.equal(LEVEL_DROP_DB, 12);
  assert.equal(MIN_RUN_PCT, 25);
  assert.equal(MIN_RUN_SECONDS, 20);

  // 100s track: loud (-10 LUFS) except 30s quiet drop (-28 LUFS) from t=25..55
  const samples: MomentarySample[] = [];
  for (let i = 0; i <= 1000; i++) {
    const t = i * 0.1;
    const m = t >= 25 && t <= 55 ? -28 : -10;
    samples.push({t, m});
  }
  const analysis = analyzeMomentaryLoudness(samples, 100);
  assert.equal(analysis.medianLufs, -10);
  assert.ok(analysis.longestRunSec >= 29.5 && analysis.longestRunSec <= 30.5);
  assert.ok(analysis.lowRunPct >= 29.5 && analysis.lowRunPct <= 30.5);

  const qc = evaluateAudioQc({
    lufs: -12,
    truePeakDb: -1,
    durationSec: 100,
    lowRunPct: analysis.lowRunPct,
    longestRunSec: analysis.longestRunSec,
    requestedDuration: 100,
  });
  assert.equal(qc.status, 'bad');
  assert.equal(qc.reason, 'level-drop');

  // Quiet intro/outro within first/last 8s only -> must NOT trigger level-drop
  const edgeOnly: MomentarySample[] = [];
  for (let i = 0; i <= 1000; i++) {
    const t = i * 0.1;
    const m = t < 7.5 || t > 92.5 ? -40 : -11;
    edgeOnly.push({t, m});
  }
  const edgeAnalysis = analyzeMomentaryLoudness(edgeOnly, 100);
  assert.equal(edgeAnalysis.lowRunPct, 0);
});

test('Phase 2: parseEbur128Output parses frame series and final Summary block', () => {
  const sampleStderr = [
    '  Duration: 00:01:40.00, start: 0.000000, bitrate: 128 kb/s',
    '[Parsed_ebur128_0 @ 0x1] Summary:',
    '  Integrated loudness:',
    '    I:         -70.0 LUFS',
    '[Parsed_ebur128_0 @ 0x1] t: 0.100000  TARGET:-23 LUFS  M:-14.2 S:-14.2  I: -14.2 LUFS',
    '[Parsed_ebur128_0 @ 0x1] t: 0.200000  TARGET:-23 LUFS  M:-13.8 S:-14.0  I: -14.0 LUFS',
    '[Parsed_ebur128_0 @ 0x1] Summary:',
    '  Integrated loudness:',
    '    I:         -9.4 LUFS',
    '    Threshold: -19.4 LUFS',
    '  True peak:',
    '    Peak:      -0.3 dBFS',
  ].join('\n');

  const parsed = parseEbur128Output(sampleStderr);
  assert.equal(parsed.lufs, -9.4);
  assert.equal(parsed.truePeakDb, -0.3);
  assert.equal(parsed.samples.length, 2);
  assert.equal(parsed.samples[0].m, -14.2);
});

test('Phase 2: evaluateAudioQc catches silent and duration mismatches (> max(15s, 8%))', () => {
  const silent = evaluateAudioQc({
    lufs: -65,
    truePeakDb: -55,
    durationSec: 200,
    lowRunPct: 0,
    longestRunSec: 0,
    requestedDuration: 200,
  });
  assert.equal(silent.status, 'bad');
  assert.equal(silent.reason, 'silent');

  // 200s track -> max(15, 16) = 16s allowed. 220s -> diff 20s -> bad duration
  const badDur = evaluateAudioQc({
    lufs: -11,
    truePeakDb: -1,
    durationSec: 220,
    lowRunPct: 0,
    longestRunSec: 0,
    requestedDuration: 200,
  });
  assert.equal(badDur.status, 'bad');
  assert.equal(badDur.reason, 'duration');

  // 200s track, 214s actual -> diff 14s <= 16s -> ok
  const okDur = evaluateAudioQc({
    lufs: -11,
    truePeakDb: -1,
    durationSec: 214,
    lowRunPct: 0,
    longestRunSec: 0,
    requestedDuration: 200,
  });
  assert.equal(okDur.status, 'ok');
});

test('Phase 2: rejection policy stops rejecting after 2 BAD candidates and keeps the better one', () => {
  const trackKey = buildTrackMatchKey('Test QC Artist', 'Test QC Song Unique 99');
  const origin = {
    trackKey,
    artist: 'Test QC Artist',
    title: 'Test QC Song Unique 99',
    requestedDuration: 200,
    recordedAt: Date.now(),
  };
  const v1 = 'QCTestVid01';
  const v2 = 'QCTestVid02';
  const v3 = 'QCTestVid03';

  try {
    db.prepare('DELETE FROM track_video_rejects WHERE trackKey = ?').run(trackKey);
    db.prepare('DELETE FROM track_video_map WHERE match_key = ?').run(trackKey);
    db.prepare('DELETE FROM video_audio_facts WHERE videoId IN (?, ?, ?)').run(v1, v2, v3);

    // Seed facts for v1 (silent) and v2 (35% level-drop)
    const now = Date.now();
    db.prepare(
      'INSERT INTO video_audio_facts (videoId, lufs, truePeakDb, durationSec, lowRunPct, status, reason, measuredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(v1, -68, -60, 200, 0, 'bad', 'silent', now);
    db.prepare(
      'INSERT INTO video_audio_facts (videoId, lufs, truePeakDb, durationSec, lowRunPct, status, reason, measuredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(v2, -12, -1, 200, 35, 'bad', 'level-drop', now);

    const r1 = applyBadMatchRejectionPolicy({
      origin,
      videoId: v1,
      reason: 'silent',
      facts: {lufs: -68, lowRunPct: 0, durationSec: 200},
    });
    assert.equal(r1.rejected, true);

    const r2 = applyBadMatchRejectionPolicy({
      origin,
      videoId: v2,
      reason: 'level-drop',
      facts: {lufs: -12, lowRunPct: 35, durationSec: 200},
    });
    assert.equal(r2.rejected, true);

    // Third bad candidate: track already had 2 BAD candidates -> stop rejecting, keep better (v3 has 26% vs v2's 35% vs v1's silent)
    const r3 = applyBadMatchRejectionPolicy({
      origin,
      videoId: v3,
      reason: 'level-drop',
      facts: {lufs: -11, lowRunPct: 26, durationSec: 200},
    });
    assert.equal(r3.rejected, false);
    assert.equal(r3.keptBetterVideoId, v3);

    const rejectsCount = (
      db.prepare('SELECT COUNT(*) AS cnt FROM track_video_rejects WHERE trackKey = ?').get(trackKey) as {
        cnt: number;
      }
    ).cnt;
    assert.equal(rejectsCount, 2);
  } finally {
    db.prepare('DELETE FROM track_video_rejects WHERE trackKey = ?').run(trackKey);
    db.prepare('DELETE FROM track_video_map WHERE match_key = ?').run(trackKey);
    db.prepare('DELETE FROM video_audio_facts WHERE videoId IN (?, ?, ?)').run(v1, v2, v3);
  }
});

test('Phase 4: download selector is uncapped and streaming selector is unchanged', () => {
  assert.equal(
    YDL_FORMAT_AUDIO_DOWNLOAD,
    'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]'
  );
  assert.ok(YDL_FORMAT_AUDIO_PREVIEW.includes('abr<=130'));
  assert.ok(YDL_FORMAT_AUDIO_PREVIEW.includes('abr<=170'));
});
