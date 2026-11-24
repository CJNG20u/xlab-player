import type {Response} from 'express';
import {isValidYouTubeVideoId} from './downloader.ts';

export const DEVICE_ONLINE_WINDOW_MS = 25_000;
export const DEVICE_EVICT_AFTER_MS = 120_000;
export const COMMAND_ACK_TIMEOUT_MS = 3_000;
export const SSE_HEARTBEAT_MS = 15_000;
export const MAX_DEVICES_PER_USER = 24;
export const MAX_TRANSFER_QUEUE_ITEMS = 100;

export const ALLOWED_REMOTE_COMMANDS = new Set<RemoteCommandName>([
  'play',
  'pause',
  'toggle',
  'next',
  'prev',
  'seek',
  'setVolume',
  'mute',
  'shuffle',
  'repeat',
  'playTrack',
  'transfer',
]);

export type RemoteCommandName =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'prev'
  | 'seek'
  | 'setVolume'
  | 'mute'
  | 'shuffle'
  | 'repeat'
  | 'playTrack'
  | 'transfer';

export type RepeatMode = 'off' | 'all' | 'one';

export interface RemoteTrackState {
  id: string | number;
  videoId?: string | null;
  deezerTrackId?: string | null;
  title: string;
  artist: string;
  album: string;
  cover?: string | null;
  cover_file?: string | null;
  duration: number;
  isYouTubeStream?: boolean;
  dominant_color?: string;
}

export interface DevicePlaybackState {
  track: RemoteTrackState | null;
  positionSec: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  queueLength: number;
  measuredAtMs: number;
}

export interface StampedDeviceState extends DevicePlaybackState {
  rev: number;
  serverNowMs: number;
}

export interface PublicDeviceSummary {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeen: number;
  rev: number;
  state: StampedDeviceState | null;
}

export interface RemoteCommandAck {
  status: 'applied' | 'rejected' | 'timeout';
  reason?: string;
}

interface DeviceRecord {
  deviceId: string;
  userId: number;
  name: string;
  platform: string;
  lastSeen: number;
  state: StampedDeviceState | null;
  sse: Response | null;
  rev: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  wasOnline: boolean;
}

interface PendingCommand {
  resolve: (ack: RemoteCommandAck) => void;
  timer: ReturnType<typeof setTimeout>;
  userId: number;
  targetDeviceId: string;
}

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9._:-]{4,80}$/;
const DEEZER_TRACK_ID_RE = /^dz-track-(\d{1,15})$/;
const DEEZER_DIGITS_RE = /^\d{1,15}$/;
const ALLOWED_REPEAT_MODES = new Set<RepeatMode>(['off', 'all', 'one']);

function sanitizeRemoteCoverUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 500);
  if (!trimmed) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return trimmed;
    }
  } catch {
    // reject malformed or unsafe URL schemes
  }
  return null;
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_RE.test(value.trim());
}

export function sanitizeDeviceName(raw: unknown): string {
  const cleaned = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 64) : '';
  return cleaned || 'Unnamed Device';
}

export function sanitizeDevicePlatform(raw: unknown): string {
  const cleaned = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 32) : '';
  return cleaned || 'web';
}

export function sanitizeRemoteTrack(
  raw: unknown
): {ok: true; value: RemoteTrackState} | {ok: false; error: string} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {ok: false, error: 'Track must be an object'};
  }
  const rec = raw as Record<string, unknown>;

  let id: string | number;
  let derivedDeezerId: string | null = null;
  if (typeof rec.id === 'number') {
    if (!Number.isSafeInteger(rec.id) || rec.id <= 0) {
      return {ok: false, error: 'Invalid numeric track id'};
    }
    id = rec.id;
  } else if (typeof rec.id === 'string' && rec.id.trim()) {
    const trimmed = rec.id.trim().slice(0, 80);
    if (trimmed.startsWith('yt-')) {
      const vid = trimmed.slice(3);
      if (!isValidYouTubeVideoId(vid)) {
        return {ok: false, error: 'Invalid YouTube track id'};
      }
    } else if (trimmed.startsWith('dz-track-')) {
      const dzMatch = DEEZER_TRACK_ID_RE.exec(trimmed);
      if (!dzMatch) {
        return {ok: false, error: 'Invalid Deezer track id'};
      }
      derivedDeezerId = dzMatch[1];
    }
    id = trimmed;
  } else {
    return {ok: false, error: 'Track id is required'};
  }

  let videoId: string | null = null;
  if (rec.videoId !== undefined && rec.videoId !== null && rec.videoId !== '') {
    if (typeof rec.videoId !== 'string' || !isValidYouTubeVideoId(rec.videoId.trim())) {
      return {ok: false, error: 'Invalid track videoId'};
    }
    videoId = rec.videoId.trim();
  }

  let deezerTrackId: string | null = derivedDeezerId;
  if (rec.deezerTrackId !== undefined && rec.deezerTrackId !== null && rec.deezerTrackId !== '') {
    const rawDz =
      typeof rec.deezerTrackId === 'string'
        ? rec.deezerTrackId.trim()
        : typeof rec.deezerTrackId === 'number' && Number.isSafeInteger(rec.deezerTrackId)
          ? String(rec.deezerTrackId)
          : '';
    if (!DEEZER_DIGITS_RE.test(rawDz)) {
      return {ok: false, error: 'Invalid track deezerTrackId'};
    }
    deezerTrackId = rawDz;
  }

  const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, 200) : '';
  const artist = typeof rec.artist === 'string' ? rec.artist.trim().slice(0, 200) : '';
  const album = typeof rec.album === 'string' ? rec.album.trim().slice(0, 200) : '';
  const cover = sanitizeRemoteCoverUrl(rec.cover);
  const coverFile =
    typeof rec.cover_file === 'string' && rec.cover_file.trim()
      ? rec.cover_file.trim().slice(0, 200)
      : null;
  const dominantColor =
    typeof rec.dominant_color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(rec.dominant_color.trim())
      ? rec.dominant_color.trim()
      : undefined;

  const rawDuration = Number(rec.duration ?? 0);
  if (!Number.isFinite(rawDuration) || rawDuration < 0) {
    return {ok: false, error: 'Invalid track duration'};
  }
  const duration = Math.min(86_400, Math.round(rawDuration * 100) / 100);

  return {
    ok: true,
    value: {
      id,
      videoId,
      ...(deezerTrackId ? {deezerTrackId} : {}),
      title: title || 'Untitled',
      artist: artist || 'Unknown Artist',
      album,
      cover,
      cover_file: coverFile,
      duration,
      isYouTubeStream: Boolean(rec.isYouTubeStream || videoId || deezerTrackId),
      dominant_color: dominantColor,
    },
  };
}

export function sanitizeDeviceStatePayload(
  raw: unknown
): {ok: true; value: DevicePlaybackState} | {ok: false; error: string} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {ok: false, error: 'State payload must be a JSON object'};
  }
  const rec = raw as Record<string, unknown>;

  let track: RemoteTrackState | null = null;
  if (rec.track !== null && rec.track !== undefined) {
    const parsedTrack = sanitizeRemoteTrack(rec.track);
    if (!parsedTrack.ok) return parsedTrack;
    track = parsedTrack.value;
  }

  const rawPos = Number(rec.positionSec ?? 0);
  if (!Number.isFinite(rawPos) || rawPos < 0) {
    return {ok: false, error: 'Invalid positionSec'};
  }
  const positionSec = Math.min(86_400, Math.round(rawPos * 1000) / 1000);

  const rawVol = Number(rec.volume ?? 1);
  if (!Number.isFinite(rawVol)) {
    return {ok: false, error: 'Invalid volume'};
  }
  const volume = Math.max(0, Math.min(1, Math.round(rawVol * 1000) / 1000));

  const rawRepeat = typeof rec.repeat === 'string' ? rec.repeat.trim() : 'off';
  const repeat: RepeatMode = ALLOWED_REPEAT_MODES.has(rawRepeat as RepeatMode)
    ? (rawRepeat as RepeatMode)
    : 'off';

  const rawQueueLen = Number(rec.queueLength ?? 0);
  const queueLength =
    Number.isFinite(rawQueueLen) && rawQueueLen >= 0
      ? Math.min(5000, Math.floor(rawQueueLen))
      : 0;

  const now = Date.now();
  const rawMeasured = Number(rec.measuredAtMs ?? now);
  const measuredAtMs =
    Number.isFinite(rawMeasured) && Math.abs(now - rawMeasured) <= 86_400_000
      ? Math.floor(rawMeasured)
      : now;

  return {
    ok: true,
    value: {
      track,
      positionSec,
      isPlaying: Boolean(rec.isPlaying),
      volume,
      muted: Boolean(rec.muted),
      shuffle: Boolean(rec.shuffle),
      repeat,
      queueLength,
      measuredAtMs,
    },
  };
}

export function sanitizeCommandRequest(raw: unknown):
  | {
      ok: true;
      cmd: RemoteCommandName;
      args: Record<string, unknown>;
      commandId: string;
      fromDeviceId: string | null;
    }
  | {ok: false; error: string} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {ok: false, error: 'Command body must be a JSON object'};
  }
  const rec = raw as Record<string, unknown>;
  const cmd = typeof rec.cmd === 'string' ? rec.cmd.trim() : '';
  if (!ALLOWED_REMOTE_COMMANDS.has(cmd as RemoteCommandName)) {
    return {ok: false, error: 'Unsupported remote command'};
  }

  const rawCommandId = typeof rec.commandId === 'string' ? rec.commandId.trim() : '';
  if (!rawCommandId || !COMMAND_ID_RE.test(rawCommandId)) {
    return {ok: false, error: 'Valid commandId is required'};
  }

  const fromDeviceId = isValidDeviceId(rec.fromDeviceId) ? rec.fromDeviceId.trim() : null;

  const rawArgs =
    rec.args && typeof rec.args === 'object' && !Array.isArray(rec.args)
      ? (rec.args as Record<string, unknown>)
      : {};

  const safeArgs: Record<string, unknown> = {};

  switch (cmd as RemoteCommandName) {
    case 'play':
    case 'pause':
    case 'toggle':
    case 'next':
    case 'prev':
      break;

    case 'seek': {
      const pos = Number(rawArgs.positionSec ?? rawArgs.time);
      if (!Number.isFinite(pos) || pos < 0 || pos > 86_400) {
        return {ok: false, error: 'seek requires finite positionSec between 0 and 86400'};
      }
      safeArgs.positionSec = Math.round(pos * 1000) / 1000;
      break;
    }

    case 'setVolume': {
      const vol = Number(rawArgs.volume);
      if (!Number.isFinite(vol) || vol < 0 || vol > 1) {
        return {ok: false, error: 'setVolume requires volume between 0 and 1'};
      }
      safeArgs.volume = Math.round(vol * 1000) / 1000;
      break;
    }

    case 'mute': {
      if (rawArgs.muted !== undefined) {
        if (typeof rawArgs.muted !== 'boolean') {
          return {ok: false, error: 'mute.muted must be a boolean'};
        }
        safeArgs.muted = rawArgs.muted;
      }
      break;
    }

    case 'shuffle': {
      if (rawArgs.shuffle !== undefined) {
        if (typeof rawArgs.shuffle !== 'boolean') {
          return {ok: false, error: 'shuffle.shuffle must be a boolean'};
        }
        safeArgs.shuffle = rawArgs.shuffle;
      }
      break;
    }

    case 'repeat': {
      if (rawArgs.repeat !== undefined) {
        const mode = typeof rawArgs.repeat === 'string' ? rawArgs.repeat.trim() : '';
        if (!ALLOWED_REPEAT_MODES.has(mode as RepeatMode)) {
          return {ok: false, error: "repeat must be 'off', 'all', or 'one'"};
        }
        safeArgs.repeat = mode;
      }
      break;
    }

    case 'playTrack': {
      const parsed = sanitizeRemoteTrack(rawArgs.track ?? rawArgs);
      if (!parsed.ok) return parsed;
      safeArgs.track = parsed.value;
      break;
    }

    case 'transfer': {
      if (rawArgs.direction === 'pull') {
        if (!isValidDeviceId(rawArgs.toDeviceId)) {
          return {ok: false, error: 'transfer pull requires valid toDeviceId'};
        }
        safeArgs.direction = 'pull';
        safeArgs.toDeviceId = rawArgs.toDeviceId.trim();
        break;
      }

      const parsedTrack = sanitizeRemoteTrack(rawArgs.track);
      if (!parsedTrack.ok) return parsedTrack;

      const rawQueue = Array.isArray(rawArgs.queue) ? rawArgs.queue : [rawArgs.track];
      if (rawQueue.length > MAX_TRANSFER_QUEUE_ITEMS) {
        return {
          ok: false,
          error: `transfer queue exceeds maximum of ${MAX_TRANSFER_QUEUE_ITEMS} tracks`,
        };
      }
      const cleanQueue: RemoteTrackState[] = [];
      for (const item of rawQueue) {
        const parsedItem = sanitizeRemoteTrack(item);
        if (!parsedItem.ok) return parsedItem;
        cleanQueue.push(parsedItem.value);
      }

      const rawIndex = Number(rawArgs.index ?? 0);
      const index =
        Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < Math.max(1, cleanQueue.length)
          ? rawIndex
          : 0;

      const rawPosition = Number(rawArgs.positionSec ?? 0);
      if (!Number.isFinite(rawPosition) || rawPosition < 0 || rawPosition > 86_400) {
        return {ok: false, error: 'transfer requires valid positionSec'};
      }

      safeArgs.track = parsedTrack.value;
      safeArgs.queue = cleanQueue;
      safeArgs.index = index;
      safeArgs.positionSec = Math.round(rawPosition * 1000) / 1000;
      safeArgs.isPlaying = Boolean(rawArgs.isPlaying);
      break;
    }
  }

  return {
    ok: true,
    cmd: cmd as RemoteCommandName,
    args: safeArgs,
    commandId: rawCommandId,
    fromDeviceId,
  };
}

export class DeviceHub {
  private readonly users = new Map<number, Map<string, DeviceRecord>>();
  private readonly pendingAcks = new Map<string, PendingCommand>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.sweepTimer = setInterval(() => {
      this.sweepStaleDevices();
    }, 15_000);
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  private getOrCreateUserMap(userId: number): Map<string, DeviceRecord> {
    let map = this.users.get(userId);
    if (!map) {
      map = new Map<string, DeviceRecord>();
      this.users.set(userId, map);
    }
    return map;
  }

  private isRecordOnline(record: DeviceRecord, now = Date.now()): boolean {
    return record.sse !== null || now - record.lastSeen <= DEVICE_ONLINE_WINDOW_MS;
  }

  private writeSse(res: Response | null, event: string, payload: unknown): boolean {
    if (!res || res.writableEnded || res.destroyed) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  private toPublicSummary(record: DeviceRecord, now = Date.now()): PublicDeviceSummary {
    return {
      deviceId: record.deviceId,
      name: record.name,
      platform: record.platform,
      online: this.isRecordOnline(record, now),
      lastSeen: record.lastSeen,
      rev: record.rev,
      state: record.state,
    };
  }

  private broadcastDevicesList(userId: number): void {
    const userMap = this.users.get(userId);
    if (!userMap) return;
    const now = Date.now();
    const devices = Array.from(userMap.values()).map((r) => this.toPublicSummary(r, now));
    const payload = {devices, serverNowMs: now};
    for (const record of userMap.values()) {
      if (record.sse) {
        this.writeSse(record.sse, 'devices', payload);
      }
    }
  }

  private evictExcessDevices(userMap: Map<string, DeviceRecord>): void {
    if (userMap.size <= MAX_DEVICES_PER_USER) return;
    const sorted = Array.from(userMap.values()).sort((a, b) => {
      const aLive = a.sse ? 1 : 0;
      const bLive = b.sse ? 1 : 0;
      if (aLive !== bLive) return aLive - bLive; // evict offline devices first
      return a.lastSeen - b.lastSeen;
    });
    while (userMap.size > MAX_DEVICES_PER_USER && sorted.length > 0) {
      const victim = sorted.shift()!;
      if (victim.heartbeatTimer) clearInterval(victim.heartbeatTimer);
      if (victim.sse && !victim.sse.writableEnded) {
        try {
          victim.sse.end();
        } catch {
          // ignore
        }
      }
      userMap.delete(victim.deviceId);
    }
  }

  sweepStaleDevices(now = Date.now()): void {
    for (const [userId, userMap] of this.users.entries()) {
      let changed = false;
      for (const [deviceId, record] of userMap.entries()) {
        const online = this.isRecordOnline(record, now);
        if (!online && now - record.lastSeen > DEVICE_EVICT_AFTER_MS) {
          if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
          userMap.delete(deviceId);
          changed = true;
          continue;
        }
        if (record.wasOnline !== online) {
          record.wasOnline = online;
          changed = true;
        }
      }
      if (userMap.size === 0) {
        this.users.delete(userId);
      } else if (changed) {
        this.broadcastDevicesList(userId);
      }
    }
  }

  connectSse(params: {
    userId: number;
    deviceId: string;
    name: string;
    platform: string;
    res: Response;
  }): () => void {
    const {userId, deviceId, name, platform, res} = params;
    const now = Date.now();
    const userMap = this.getOrCreateUserMap(userId);
    let record = userMap.get(deviceId);

    if (record) {
      if (record.heartbeatTimer) {
        clearInterval(record.heartbeatTimer);
        record.heartbeatTimer = null;
      }
      if (record.sse && record.sse !== res && !record.sse.writableEnded) {
        try {
          record.sse.end();
        } catch {
          // ignore stale stream close errors
        }
      }
      record.name = name;
      record.platform = platform;
      record.lastSeen = now;
      record.sse = res;
      record.wasOnline = true;
    } else {
      record = {
        deviceId,
        userId,
        name,
        platform,
        lastSeen: now,
        state: null,
        sse: res,
        rev: 0,
        heartbeatTimer: null,
        wasOnline: true,
      };
      userMap.set(deviceId, record);
      this.evictExcessDevices(userMap);
    }

    const heartbeatTimer = setInterval(() => {
      if (!record || record.sse !== res || res.writableEnded || res.destroyed) {
        clearInterval(heartbeatTimer);
        return;
      }
      record.lastSeen = Date.now();
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, SSE_HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
    record.heartbeatTimer = heartbeatTimer;

    const devices = this.listDevices(userId);
    this.writeSse(res, 'hello', {
      deviceId,
      serverNowMs: now,
      devices,
    });

    // Send latest state snapshots of all other online devices so watchers hydrate immediately
    for (const other of userMap.values()) {
      if (other.deviceId !== deviceId && other.state) {
        this.writeSse(res, 'device-state', {
          deviceId: other.deviceId,
          rev: other.rev,
          serverNowMs: now,
          state: other.state,
        });
      }
    }

    this.broadcastDevicesList(userId);

    // Return disconnect cleanup handler
    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeatTimer);
      const currentMap = this.users.get(userId);
      const current = currentMap?.get(deviceId);
      if (!current || current.sse !== res) return;
      current.sse = null;
      current.heartbeatTimer = null;
      current.lastSeen = Date.now();
      current.wasOnline = this.isRecordOnline(current, current.lastSeen);
      this.broadcastDevicesList(userId);
    };
  }

  listDevices(userId: number, now = Date.now()): PublicDeviceSummary[] {
    this.sweepStaleDevices(now);
    const userMap = this.users.get(userId);
    if (!userMap) return [];
    return Array.from(userMap.values())
      .map((record) => this.toPublicSummary(record, now))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return b.lastSeen - a.lastSeen;
      });
  }

  publishState(params: {
    userId: number;
    deviceId: string;
    state: DevicePlaybackState;
    name?: string;
    platform?: string;
  }): StampedDeviceState {
    const {userId, deviceId, state} = params;
    const now = Date.now();
    const userMap = this.getOrCreateUserMap(userId);
    let record = userMap.get(deviceId);
    const isNewRecord = !record;
    const prevTrackKey = record?.state?.track
      ? `${record.state.track.id}|${record.state.track.title}|${record.state.isPlaying}`
      : '';

    if (!record) {
      record = {
        deviceId,
        userId,
        name: sanitizeDeviceName(params.name),
        platform: sanitizeDevicePlatform(params.platform),
        lastSeen: now,
        state: null,
        sse: null,
        rev: 0,
        heartbeatTimer: null,
        wasOnline: true,
      };
      userMap.set(deviceId, record);
      this.evictExcessDevices(userMap);
    }

    const wasOffline = !record.wasOnline;
    record.rev += 1;
    record.lastSeen = now;
    record.wasOnline = true;
    if (params.name) record.name = sanitizeDeviceName(params.name);
    if (params.platform) record.platform = sanitizeDevicePlatform(params.platform);

    const stamped: StampedDeviceState = {
      ...state,
      rev: record.rev,
      serverNowMs: now,
    };
    record.state = stamped;

    const eventPayload = {
      deviceId,
      rev: stamped.rev,
      serverNowMs: now,
      state: stamped,
    };

    for (const watcher of userMap.values()) {
      if (watcher.deviceId !== deviceId && watcher.sse) {
        this.writeSse(watcher.sse, 'device-state', eventPayload);
      }
    }

    const nextTrackKey = stamped.track
      ? `${stamped.track.id}|${stamped.track.title}|${stamped.isPlaying}`
      : '';
    if (isNewRecord || wasOffline || prevTrackKey !== nextTrackKey) {
      this.broadcastDevicesList(userId);
    }

    return stamped;
  }

  async sendCommand(params: {
    userId: number;
    targetDeviceId: string;
    fromDeviceId: string | null;
    cmd: RemoteCommandName;
    args: Record<string, unknown>;
    commandId: string;
    timeoutMs?: number;
  }): Promise<RemoteCommandAck> {
    const {userId, targetDeviceId, fromDeviceId, cmd, args, commandId} = params;
    const userMap = this.users.get(userId);
    const target = userMap?.get(targetDeviceId);
    if (!target || !target.sse || target.sse.writableEnded || target.sse.destroyed) {
      return {status: 'rejected', reason: 'device_offline'};
    }

    const fromRecord = fromDeviceId ? userMap?.get(fromDeviceId) : undefined;
    const fromDeviceName = fromRecord?.name || 'Another device';

    const ackKey = `${userId}:${targetDeviceId}:${commandId}`;
    const timeoutMs = Math.max(200, Math.min(15_000, params.timeoutMs ?? COMMAND_ACK_TIMEOUT_MS));

    return new Promise<RemoteCommandAck>((resolve) => {
      const existing = this.pendingAcks.get(ackKey);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({status: 'rejected', reason: 'superseded'});
        this.pendingAcks.delete(ackKey);
      }

      const timer = setTimeout(() => {
        this.pendingAcks.delete(ackKey);
        resolve({status: 'timeout', reason: 'device_timeout'});
      }, timeoutMs);

      this.pendingAcks.set(ackKey, {
        resolve,
        timer,
        userId,
        targetDeviceId,
      });

      const ok = this.writeSse(target.sse, 'command', {
        commandId,
        cmd,
        args,
        fromDeviceId,
        fromDeviceName,
        sentAtMs: Date.now(),
      });

      if (!ok) {
        clearTimeout(timer);
        this.pendingAcks.delete(ackKey);
        resolve({status: 'rejected', reason: 'device_offline'});
      }
    });
  }

  ackCommand(params: {
    userId: number;
    deviceId: string;
    commandId: string;
    status: 'applied' | 'rejected';
    reason?: string;
  }): boolean {
    const {userId, deviceId, commandId, status, reason} = params;
    const userMap = this.users.get(userId);
    const device = userMap?.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
    }

    const ackKey = `${userId}:${deviceId}:${commandId}`;
    const pending = this.pendingAcks.get(ackKey);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingAcks.delete(ackKey);
    pending.resolve({
      status,
      reason: reason ? reason.slice(0, 120) : undefined,
    });
    return true;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve({status: 'timeout', reason: 'hub_closed'});
    }
    this.pendingAcks.clear();
    for (const userMap of this.users.values()) {
      for (const record of userMap.values()) {
        if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
      }
    }
    this.users.clear();
  }
}

export const deviceHub = new DeviceHub();
