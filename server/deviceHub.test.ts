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
} from './deviceHub.ts';
import {extrapolateRemotePosition} from '../src/lib/remoteControl.ts';

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
