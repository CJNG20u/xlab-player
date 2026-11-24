import test from 'node:test';
import assert from 'node:assert/strict';
import type {Response} from 'express';
import {
  DEVICE_EVICT_AFTER_MS,
  DEVICE_ONLINE_WINDOW_MS,
  DeviceHub,
  MAX_TRANSFER_QUEUE_ITEMS,
  sanitizeCommandRequest,
  sanitizeDeviceStatePayload,
  sanitizeRemoteTrack,
} from './deviceHub.ts';
import {
  buildImmediateRemoteTrack,
  extrapolateRemotePosition,
  formatRemoteAckError,
  hydrateRemoteTrack,
  serializeTrackForRemote,
} from '../src/lib/remoteControl.ts';
import type {Track} from '../src/types.ts';

interface FakeSse {
  res: Response;
  chunks: string[];
  ended: boolean;
  events: Array<{event: string; data: Record<string, unknown>}>;
}

function createFakeSse(): FakeSse {
  const state: FakeSse = {
    chunks: [],
    ended: false,
    events: [],
    res: null as unknown as Response,
  };

  const mockRes = {
    get writableEnded() {
      return state.ended;
    },
    get destroyed() {
      return state.ended;
    },
    write(chunk: string) {
      if (state.ended) throw new Error('stream closed');
      state.chunks.push(chunk);
      const match = /^event:\s*([^\n]+)\ndata:\s*([^\n]+)\n\n$/.exec(chunk);
      if (match) {
        state.events.push({
          event: match[1],
          data: JSON.parse(match[2]) as Record<string, unknown>,
        });
      }
      return true;
    },
    end() {
      state.ended = true;
    },
  };

  state.res = mockRes as unknown as Response;
  return state;
}

test('DeviceHub isolates devices and commands strictly per user', async () => {
  const hub = new DeviceHub();
  try {
    const sseA = createFakeSse();
    const sseB = createFakeSse();

    const closeA = hub.connectSse({
      userId: 1,
      deviceId: 'device-user1-a',
      name: 'User1 Laptop',
      platform: 'macos',
      res: sseA.res,
    });
    const closeB = hub.connectSse({
      userId: 2,
      deviceId: 'device-user2-b',
      name: 'User2 Phone',
      platform: 'ios',
      res: sseB.res,
    });

    const list1 = hub.listDevices(1);
    const list2 = hub.listDevices(2);
    assert.equal(list1.length, 1);
    assert.equal(list1[0].deviceId, 'device-user1-a');
    assert.equal(list2.length, 1);
    assert.equal(list2[0].deviceId, 'device-user2-b');

    // User 2 cannot command User 1's device
    const crossAck = await hub.sendCommand({
      userId: 2,
      targetDeviceId: 'device-user1-a',
      fromDeviceId: 'device-user2-b',
      cmd: 'pause',
      args: {},
      commandId: 'cmd-cross-user-1',
      timeoutMs: 300,
    });
    assert.equal(crossAck.status, 'rejected');
    assert.equal(crossAck.reason, 'device_offline');

    // User 1's SSE stream never received any command from User 2
    assert.equal(
      sseA.events.filter((e) => e.event === 'command').length,
      0
    );

    closeA();
    closeB();
  } finally {
    hub.dispose();
  }
});

test('DeviceHub stamps monotonic rev and fans out device-state to same-user watchers', () => {
  const hub = new DeviceHub();
  try {
    const sseHost = createFakeSse();
    const sseRemote = createFakeSse();

    const closeHost = hub.connectSse({
      userId: 7,
      deviceId: 'host-device-001',
      name: 'Desktop Chrome',
      platform: 'windows',
      res: sseHost.res,
    });
    const closeRemote = hub.connectSse({
      userId: 7,
      deviceId: 'remote-device-002',
      name: 'iPhone Safari',
      platform: 'ios',
      res: sseRemote.res,
    });

    const parsed = sanitizeDeviceStatePayload({
      track: {
        id: 'yt-dQw4w9WgXcQ',
        videoId: 'dQw4w9WgXcQ',
        title: 'Never Gonna Give You Up',
        artist: 'Rick Astley',
        album: 'Whenever You Need Somebody',
        duration: 213,
      },
      positionSec: 42.5,
      isPlaying: true,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: 'off',
      queueLength: 12,
      measuredAtMs: Date.now(),
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const s1 = hub.publishState({
      userId: 7,
      deviceId: 'host-device-001',
      state: parsed.value,
    });
    const s2 = hub.publishState({
      userId: 7,
      deviceId: 'host-device-001',
      state: {...parsed.value, positionSec: 47.5},
    });

    assert.equal(s1.rev, 1);
    assert.equal(s2.rev, 2);
    assert.ok(s2.serverNowMs >= s1.serverNowMs);

    const watcherStateEvents = sseRemote.events.filter((e) => e.event === 'device-state');
    assert.equal(watcherStateEvents.length, 2);
    assert.equal(watcherStateEvents[0].data.rev, 1);
    assert.equal(watcherStateEvents[1].data.rev, 2);

    // Host should not receive its own device-state echo
    assert.equal(sseHost.events.filter((e) => e.event === 'device-state').length, 0);

    closeHost();
    closeRemote();
  } finally {
    hub.dispose();
  }
});

test('DeviceHub delivers commands over SSE, resolves ack, and times out when unacked', async () => {
  const hub = new DeviceHub();
  try {
    const sseTarget = createFakeSse();
    const closeTarget = hub.connectSse({
      userId: 42,
      deviceId: 'target-device-1',
      name: 'Living Room',
      platform: 'linux',
      res: sseTarget.res,
    });

    // Applied ack flow
    const ackPromise = hub.sendCommand({
      userId: 42,
      targetDeviceId: 'target-device-1',
      fromDeviceId: 'controller-device-2',
      cmd: 'seek',
      args: {positionSec: 64},
      commandId: 'cmd-seek-1',
      timeoutMs: 1000,
    });

    const cmdEvents = sseTarget.events.filter((e) => e.event === 'command');
    assert.equal(cmdEvents.length, 1);
    assert.equal(cmdEvents[0].data.commandId, 'cmd-seek-1');
    assert.equal(cmdEvents[0].data.cmd, 'seek');

    const matched = hub.ackCommand({
      userId: 42,
      deviceId: 'target-device-1',
      commandId: 'cmd-seek-1',
      status: 'applied',
    });
    assert.equal(matched, true);
    const ack = await ackPromise;
    assert.equal(ack.status, 'applied');

    // Timeout flow when target never acks
    const timeoutAck = await hub.sendCommand({
      userId: 42,
      targetDeviceId: 'target-device-1',
      fromDeviceId: 'controller-device-2',
      cmd: 'pause',
      args: {},
      commandId: 'cmd-timeout-1',
      timeoutMs: 220,
    });
    assert.equal(timeoutAck.status, 'timeout');

    closeTarget();
  } finally {
    hub.dispose();
  }
});

test('DeviceHub presence window marks offline after 25s and evicts after 2m', () => {
  const hub = new DeviceHub();
  try {
    const sse = createFakeSse();
    const close = hub.connectSse({
      userId: 9,
      deviceId: 'ephemeral-device-1',
      name: 'Tablet',
      platform: 'android',
      res: sse.res,
    });

    const t0 = Date.now();
    assert.equal(hub.listDevices(9, t0)[0].online, true);

    close();

    // Still online immediately after SSE disconnect within 25s window
    assert.equal(hub.listDevices(9, t0 + DEVICE_ONLINE_WINDOW_MS - 1000)[0].online, true);

    // Offline after 25s without SSE
    const afterOffline = hub.listDevices(9, t0 + DEVICE_ONLINE_WINDOW_MS + 5000);
    assert.equal(afterOffline.length, 1);
    assert.equal(afterOffline[0].online, false);

    // Evicted after 2 minutes offline
    const afterEvict = hub.listDevices(9, t0 + DEVICE_EVICT_AFTER_MS + 5000);
    assert.equal(afterEvict.length, 0);
  } finally {
    hub.dispose();
  }
});

test('sanitizeCommandRequest validates YouTube videoId, bounds, and 100-track transfer cap', () => {
  // Invalid YouTube videoId rejected
  const badVideo = sanitizeCommandRequest({
    cmd: 'playTrack',
    commandId: 'cmd-bad-vid-1',
    args: {
      track: {
        id: 'yt-notvalid',
        videoId: '../../etc/passwd',
        title: 'Bad',
        artist: 'Bad',
        album: '',
        duration: 100,
      },
    },
  });
  assert.equal(badVideo.ok, false);

  // Out-of-range volume rejected
  const badVol = sanitizeCommandRequest({
    cmd: 'setVolume',
    commandId: 'cmd-bad-vol-1',
    args: {volume: 1.5},
  });
  assert.equal(badVol.ok, false);

  // Transfer queue > 100 rejected
  const track = {
    id: 'yt-dQw4w9WgXcQ',
    videoId: 'dQw4w9WgXcQ',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
  };
  const tooMany = Array.from({length: MAX_TRANSFER_QUEUE_ITEMS + 1}, () => track);
  const badTransfer = sanitizeCommandRequest({
    cmd: 'transfer',
    commandId: 'cmd-big-xfer-1',
    args: {track, queue: tooMany, index: 0, positionSec: 10, isPlaying: true},
  });
  assert.equal(badTransfer.ok, false);

  // Valid transfer accepted
  const goodTransfer = sanitizeCommandRequest({
    cmd: 'transfer',
    commandId: 'cmd-ok-xfer-1',
    args: {track, queue: [track], index: 0, positionSec: 12.5, isPlaying: true},
  });
  assert.equal(goodTransfer.ok, true);
});

test('extrapolateRemotePosition advances smoothly while playing and clamps to duration', () => {
  const baseState = {
    positionSec: 30,
    isPlaying: true,
    measuredAtMs: 10_000,
    serverNowMs: 10_500,
    track: {
      id: 1,
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      duration: 60,
    },
  };

  // receivedAtMs = 10_200 -> clock offset = +300ms
  // at now = 15_200 -> elapsed = (15_200 + 300 - 10_000) / 1000 = 5.5s -> 35.5s
  const posPlaying = extrapolateRemotePosition(baseState, 10_200, 15_200);
  assert.equal(posPlaying, 35.5);

  // Clamps to duration (60s)
  const posClamped = extrapolateRemotePosition(baseState, 10_200, 99_000);
  assert.equal(posClamped, 60);

  // Does not advance when paused
  const posPaused = extrapolateRemotePosition({...baseState, isPlaying: false}, 10_200, 25_000);
  assert.equal(posPaused, 30);
});

test('sanitizeRemoteTrack validates dz-track-<digits>, deezerTrackId, yt-, library tracks, and limits', () => {
  // Valid Deezer catalog track
  const dzOk = sanitizeRemoteTrack({
    id: 'dz-track-3135556',
    deezerTrackId: '3135556',
    title: 'Harder, Better, Faster, Stronger',
    artist: 'Daft Punk',
    album: 'Discovery',
    duration: 224,
    cover: 'https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg',
  });
  assert.equal(dzOk.ok, true);
  if (dzOk.ok) {
    assert.equal(dzOk.value.id, 'dz-track-3135556');
    assert.equal(dzOk.value.deezerTrackId, '3135556');
    assert.equal(dzOk.value.videoId, null);
    assert.equal(dzOk.value.artist, 'Daft Punk');
    assert.equal(dzOk.value.title, 'Harder, Better, Faster, Stronger');
    assert.equal(dzOk.value.album, 'Discovery');
    assert.equal(dzOk.value.duration, 224);
    assert.equal(dzOk.value.cover, 'https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg');
    assert.equal(dzOk.value.isYouTubeStream, true);
  }

  // Derives deezerTrackId from dz-track-<digits> when omitted
  const dzDerived = sanitizeRemoteTrack({
    id: 'dz-track-987654321012345',
    title: 'Aerodynamic',
    artist: 'Daft Punk',
    album: 'Discovery',
    duration: 207,
  });
  assert.equal(dzDerived.ok, true);
  if (dzDerived.ok) {
    assert.equal(dzDerived.value.deezerTrackId, '987654321012345');
  }

  // Rejects invalid dz-track id formats (non-digits, empty, >15 digits)
  for (const badId of ['dz-track-', 'dz-track-abc', 'dz-track-1234567890123456', 'dz-track-123/../../x']) {
    const res = sanitizeRemoteTrack({
      id: badId,
      title: 'Song',
      artist: 'Artist',
      album: '',
      duration: 120,
    });
    assert.equal(res.ok, false, `Expected ${badId} to be rejected`);
  }

  // Rejects invalid deezerTrackId field
  const badDzField = sanitizeRemoteTrack({
    id: 'dz-track-12345',
    deezerTrackId: 'not-digits',
    title: 'Song',
    artist: 'Artist',
    album: '',
    duration: 120,
  });
  assert.equal(badDzField.ok, false);

  // Rejects unsafe cover URL schemes while keeping safe http(s) and relative paths
  const unsafeCover = sanitizeRemoteTrack({
    id: 'dz-track-12345',
    title: 'Song',
    artist: 'Artist',
    album: '',
    duration: 120,
    cover: 'javascript:alert(1)',
  });
  assert.equal(unsafeCover.ok, true);
  if (unsafeCover.ok) {
    assert.equal(unsafeCover.value.cover, null);
  }

  // Enforces existing field length limits
  const longFields = sanitizeRemoteTrack({
    id: 'dz-track-42',
    title: 'T'.repeat(300),
    artist: 'A'.repeat(300),
    album: 'B'.repeat(300),
    duration: 999_999,
  });
  assert.equal(longFields.ok, true);
  if (longFields.ok) {
    assert.equal(longFields.value.title.length, 200);
    assert.equal(longFields.value.artist.length, 200);
    assert.equal(longFields.value.album.length, 200);
    assert.equal(longFields.value.duration, 86_400);
  }
});

test('serializeTrackForRemote preserves dz-track, yt-, and library tracks', () => {
  const dzTrack: Track = {
    id: 'dz-track-3135556',
    rel_path: '',
    title: 'Digital Love',
    artist: 'Daft Punk',
    album: 'Discovery',
    track_number: 3,
    year: 2001,
    duration: 298,
    format: 'm4a',
    bitrate: 0,
    size_bytes: 0,
    cover_file: null,
    dominant_color: '#1f2937',
    added_at: '',
    liked: false,
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/xyz/500x500.jpg',
    streamUrl: '/api/yt-stream/match?artist=Daft+Punk&title=Digital+Love&duration=298',
    isYouTubeStream: true,
    deezerTrackId: '3135556',
  };
  const serializedDz = serializeTrackForRemote(dzTrack);
  assert.equal(serializedDz.id, 'dz-track-3135556');
  assert.equal(serializedDz.deezerTrackId, '3135556');
  assert.equal(serializedDz.videoId, null);
  assert.equal(serializedDz.artist, 'Daft Punk');
  assert.equal(serializedDz.title, 'Digital Love');
  assert.equal(serializedDz.album, 'Discovery');
  assert.equal(serializedDz.duration, 298);
  assert.equal(serializedDz.cover, 'https://e-cdns-images.dzcdn.net/images/cover/xyz/500x500.jpg');
  assert.equal(sanitizeRemoteTrack(serializedDz).ok, true);

  const ytTrack: Track = {
    ...dzTrack,
    id: 'yt-dQw4w9WgXcQ',
    deezerTrackId: undefined,
    streamUrl: '/api/yt-stream/dQw4w9WgXcQ',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    coverUrl: undefined,
  };
  const serializedYt = serializeTrackForRemote(ytTrack);
  assert.equal(serializedYt.id, 'yt-dQw4w9WgXcQ');
  assert.equal(serializedYt.videoId, 'dQw4w9WgXcQ');
  assert.equal(serializedYt.deezerTrackId, undefined);
  assert.equal(serializedYt.cover, '/api/yt-thumb/dQw4w9WgXcQ');
  assert.equal(sanitizeRemoteTrack(serializedYt).ok, true);

  const libTrack: Track = {
    id: 42,
    rel_path: 'Daft Punk/Discovery/01 One More Time.flac',
    title: 'One More Time',
    artist: 'Daft Punk',
    album: 'Discovery',
    track_number: 1,
    year: 2001,
    duration: 320,
    format: 'FLAC',
    bitrate: 1000,
    size_bytes: 35_000_000,
    cover_file: 'cover_42.jpg',
    dominant_color: '#123456',
    added_at: '2026-01-01',
    liked: true,
    isYouTubeStream: false,
  };
  const serializedLib = serializeTrackForRemote(libTrack);
  assert.equal(serializedLib.id, 42);
  assert.equal(serializedLib.videoId, null);
  assert.equal(serializedLib.cover_file, 'cover_42.jpg');
  assert.equal(serializedLib.cover, '/api/covers/cover_42.jpg');
  assert.equal(serializedLib.isYouTubeStream, false);
  assert.equal(sanitizeRemoteTrack(serializedLib).ok, true);
});

test('hydrateRemoteTrack resolves dz-track and artist+title web tracks, keeps yt- and library tracks', async () => {
  // 1. Catalog dz-track resolves via resolver into a normal YouTube-stream Track
  let resolveCalls = 0;
  const hydratedDz = await hydrateRemoteTrack(
    {
      id: 'dz-track-3135556',
      deezerTrackId: '3135556',
      title: 'Digital Love',
      artist: 'Daft Punk',
      album: 'Discovery',
      duration: 298,
      cover: 'https://e-cdns-images.dzcdn.net/images/cover/xyz/500x500.jpg',
      isYouTubeStream: true,
    },
    {
      resolveTrack: async (input) => {
        resolveCalls += 1;
        assert.equal(input.artist, 'Daft Punk');
        assert.equal(input.title, 'Digital Love');
        assert.equal(input.duration, 298);
        return {videoId: 'FGBhQbmPwH8', streamUrl: '/api/yt-stream/FGBhQbmPwH8', matchedDuration: 300};
      },
    }
  );
  assert.equal(resolveCalls, 1);
  assert.ok(hydratedDz);
  assert.equal(hydratedDz.id, 'yt-FGBhQbmPwH8');
  assert.equal(hydratedDz.streamUrl, '/api/yt-stream/FGBhQbmPwH8');
  assert.equal(hydratedDz.coverUrl, 'https://e-cdns-images.dzcdn.net/images/cover/xyz/500x500.jpg');
  assert.equal(hydratedDz.isYouTubeStream, true);
  assert.equal(hydratedDz.deezerTrackId, '3135556');

  // 2. Artist+title-only web track (no videoId, no deezerTrackId) also resolves and falls back to YT thumb cover
  const hydratedWeb = await hydrateRemoteTrack(
    {
      id: 'web-custom-1',
      title: 'Midnight City',
      artist: 'M83',
      album: "Hurry Up, We're Dreaming",
      duration: 243,
      isYouTubeStream: true,
    },
    {
      resolveTrack: async () => ({videoId: 'dX3k_QDnzHE'}),
    }
  );
  assert.ok(hydratedWeb);
  assert.equal(hydratedWeb.id, 'yt-dX3k_QDnzHE');
  assert.equal(hydratedWeb.streamUrl, '/api/yt-stream/dX3k_QDnzHE');
  assert.equal(hydratedWeb.coverUrl, '/api/yt-thumb/dX3k_QDnzHE');

  // 3. Unresolvable dz-track returns null so host rejects with unresolvable_track
  const failedDz = await hydrateRemoteTrack(
    {
      id: 'dz-track-999999',
      deezerTrackId: '999999',
      title: 'Nonexistent Obscure Track',
      artist: 'Nobody',
      album: '',
      duration: 180,
      isYouTubeStream: true,
    },
    {
      resolveTrack: async () => null,
    }
  );
  assert.equal(failedDz, null);

  // 4. YouTube track hydrates directly without invoking resolver
  let unexpectedResolve = false;
  const hydratedYt = await hydrateRemoteTrack(
    {
      id: 'yt-dQw4w9WgXcQ',
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      album: 'Whenever You Need Somebody',
      duration: 213,
      isYouTubeStream: true,
    },
    {
      resolveTrack: async () => {
        unexpectedResolve = true;
        return null;
      },
    }
  );
  assert.equal(unexpectedResolve, false);
  assert.ok(hydratedYt);
  assert.equal(hydratedYt.id, 'yt-dQw4w9WgXcQ');
  assert.equal(hydratedYt.streamUrl, '/api/yt-stream/dQw4w9WgXcQ');

  // 5. Library track hydrates via fetchLibraryTrack (and falls back cleanly if fetch returns null)
  const fullLib: Track = {
    id: 77,
    rel_path: 'Artist/Album/Track.flac',
    title: 'Local Track',
    artist: 'Local Artist',
    album: 'Local Album',
    track_number: 1,
    year: 2024,
    duration: 200,
    format: 'FLAC',
    bitrate: 900,
    size_bytes: 20_000_000,
    cover_file: 'c77.jpg',
    dominant_color: '#112233',
    added_at: '2026-01-01',
    liked: true,
    isYouTubeStream: false,
  };
  const hydratedLib = await hydrateRemoteTrack(
    {
      id: 77,
      title: 'Local Track',
      artist: 'Local Artist',
      album: 'Local Album',
      duration: 200,
      cover_file: 'c77.jpg',
      isYouTubeStream: false,
    },
    {
      fetchLibraryTrack: async (id) => (id === 77 ? fullLib : null),
    }
  );
  assert.deepEqual(hydratedLib, fullLib);

  const hydratedLibFallback = await hydrateRemoteTrack(
    {
      id: 78,
      title: 'Fallback Track',
      artist: 'Fallback Artist',
      album: 'Album',
      duration: 150,
      isYouTubeStream: false,
    },
    {
      fetchLibraryTrack: async () => null,
    }
  );
  assert.ok(hydratedLibFallback);
  assert.equal(hydratedLibFallback.id, 78);
  assert.equal(hydratedLibFallback.isYouTubeStream, false);

  // 6. buildImmediateRemoteTrack creates a playable match placeholder for background queue resolution
  const immediateDz = buildImmediateRemoteTrack(
    {
      id: 'dz-track-3135556',
      deezerTrackId: '3135556',
      title: 'Digital Love',
      artist: 'Daft Punk',
      album: 'Discovery',
      duration: 298,
      cover: 'https://e-cdns-images.dzcdn.net/images/cover/xyz/500x500.jpg',
      isYouTubeStream: true,
    },
    1
  );
  assert.ok(immediateDz);
  assert.equal(immediateDz.needsBackgroundHydration, true);
  assert.equal(immediateDz.track.id, 'dz-track-3135556');
  assert.ok(immediateDz.track.streamUrl?.startsWith('/api/yt-stream/match?'));
});

test('formatRemoteAckError maps all remote ack failure reasons to user-friendly messages', () => {
  assert.equal(formatRemoteAckError({status: 'applied'}, 'Living Room'), null);
  assert.equal(
    formatRemoteAckError({status: 'rejected', reason: 'unresolvable_track'}, 'Living Room'),
    "Couldn't find that track on Living Room"
  );
  assert.equal(
    formatRemoteAckError({status: 'rejected', reason: 'device_offline'}, 'Living Room'),
    'Living Room is offline'
  );
  assert.equal(
    formatRemoteAckError({status: 'timeout', reason: 'device_timeout'}, 'Living Room'),
    "Living Room didn't respond"
  );
  assert.equal(
    formatRemoteAckError({status: 'rejected', reason: 'needs_gesture'}, 'Living Room'),
    'Tap Living Room to start playback'
  );
  assert.equal(
    formatRemoteAckError({status: 'rejected', reason: 'invalid_track'}, 'Living Room'),
    "Track couldn't be sent to Living Room"
  );
  assert.equal(
    formatRemoteAckError({status: 'rejected', reason: 'empty_transfer'}, 'Living Room'),
    'Nothing to transfer to Living Room'
  );
  assert.equal(
    formatRemoteAckError({status: 'rejected', reason: 'no_track'}, 'Living Room'),
    'No track is loaded on Living Room'
  );
});
