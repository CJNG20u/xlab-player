import {useEffect, useState, useSyncExternalStore} from 'react';
import type {RepeatMode, Track} from '../types';
import {
  apiFetch,
  getCatalogMatchStreamUrl,
  getSSEUrl,
  getTrackCoverUrl,
  getYouTubeThumbProxyUrl,
  getYouTubeVideoId,
  isValidYouTubeVideoId,
} from './api';
import {
  detectDevicePlatform,
  getDeviceName,
  getOrCreateDeviceId,
  subscribeDeviceName,
} from './deviceIdentity';

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

export interface RemotePlaybackState {
  track: RemoteTrackState | null;
  positionSec: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  queueLength: number;
  measuredAtMs: number;
  rev: number;
  serverNowMs: number;
}

export interface RemoteDeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeen: number;
  rev: number;
  state: RemotePlaybackState | null;
}

export interface RemoteCommandEvent {
  commandId: string;
  cmd: RemoteCommandName;
  args: Record<string, unknown>;
  fromDeviceId: string | null;
  fromDeviceName: string;
  sentAtMs: number;
}

export interface RemoteCommandAckResponse {
  status: 'applied' | 'rejected' | 'timeout';
  reason?: string;
}

export interface RemoteToastState {
  id: number;
  message: string;
  action?: 'resume_local' | 'retry';
  onRetry?: () => void;
}

export interface HeldRemoteState {
  state: RemotePlaybackState;
  receivedAtMs: number;
  rev: number;
}

export interface RemoteControlSnapshot {
  selfDeviceId: string;
  selfDeviceName: string;
  selfPlatform: string;
  connected: boolean;
  devices: RemoteDeviceInfo[];
  targetDeviceId: string | null;
  targetDevice: RemoteDeviceInfo | null;
  targetHeldState: HeldRemoteState | null;
  pendingCommand: {commandId: string; cmd: RemoteCommandName; startedAtMs: number} | null;
  deviceSheetOpen: boolean;
  toast: RemoteToastState | null;
}

const TARGET_STORAGE_PREFIX = 'xlabplayer_remote_target_v1';
const MAX_TRANSFER_QUEUE_ITEMS = 100;
const PENDING_TIMEOUT_MS = 3_000;
const TRANSFER_PENDING_TIMEOUT_MS = 12_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export const DEEZER_TRACK_ID_RE = /^dz-track-(\d{1,15})$/;
export const DEEZER_DIGITS_RE = /^\d{1,15}$/;

export function extractDeezerTrackId(
  track: Pick<Track, 'id' | 'deezerTrackId'> | Pick<RemoteTrackState, 'id' | 'deezerTrackId'> | null | undefined
): string | null {
  if (!track) return null;
  if (typeof track.deezerTrackId === 'string') {
    const trimmed = track.deezerTrackId.trim();
    if (DEEZER_DIGITS_RE.test(trimmed)) return trimmed;
  }
  if (typeof track.id === 'string') {
    const match = DEEZER_TRACK_ID_RE.exec(track.id.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * Pure position extrapolation for a playing remote device:
 *   position = positionSec + (now + (serverNowMs - receivedAtMs) - measuredAtMs) / 1000
 * clamped to [0, duration].
 */
export function extrapolateRemotePosition(
  state: Pick<RemotePlaybackState, 'positionSec' | 'isPlaying' | 'serverNowMs' | 'measuredAtMs' | 'track'> | null | undefined,
  receivedAtMs: number,
  nowMs = Date.now()
): number {
  if (!state) return 0;
  const maxDur =
    state.track && Number.isFinite(state.track.duration) && state.track.duration > 0
      ? state.track.duration
      : Infinity;
  const base = Number.isFinite(state.positionSec) ? Math.max(0, state.positionSec) : 0;
  if (!state.isPlaying) {
    return Number.isFinite(maxDur) ? Math.min(base, maxDur) : base;
  }
  const clockOffset = state.serverNowMs - receivedAtMs;
  const elapsedSec = (nowMs + clockOffset - state.measuredAtMs) / 1000;
  const extrapolated = base + (Number.isFinite(elapsedSec) ? Math.max(0, elapsedSec) : 0);
  if (Number.isFinite(maxDur)) {
    return Math.max(0, Math.min(maxDur, extrapolated));
  }
  return Math.max(0, extrapolated);
}

export function serializeTrackForRemote(track: Track): RemoteTrackState {
  const videoId = getYouTubeVideoId(track);
  const deezerTrackId = extractDeezerTrackId(track);
  const cover =
    getTrackCoverUrl(track) || (videoId ? getYouTubeThumbProxyUrl(videoId) : null);

  let id: string | number = track.id;
  if (
    typeof track.id === 'string' &&
    track.id.startsWith('dz-track-') &&
    !DEEZER_TRACK_ID_RE.test(track.id)
  ) {
    id = deezerTrackId ? `dz-track-${deezerTrackId}` : `web-${track.id.slice(9)}`.slice(0, 80);
  }

  return {
    id,
    videoId,
    ...(deezerTrackId ? {deezerTrackId} : {}),
    title: track.title || 'Untitled',
    artist: track.artist || 'Unknown Artist',
    album: track.album || '',
    cover,
    cover_file: track.cover_file ?? null,
    duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,
    isYouTubeStream: Boolean(track.isYouTubeStream || videoId || deezerTrackId),
    dominant_color: track.dominant_color || '#1f3a2e',
  };
}

export interface HydrateRemoteTrackDeps {
  fetchLibraryTrack?: (id: number) => Promise<Track | null>;
  resolveTrack?: (input: {
    artist: string;
    title: string;
    duration: number;
  }) => Promise<{videoId: string; streamUrl?: string; matchedDuration?: number} | null>;
}

const defaultHydrateDeps: Required<HydrateRemoteTrackDeps> = {
  fetchLibraryTrack: async (id: number) => {
    try {
      const res = await apiFetch<{track?: Track}>(`/api/tracks/${id}`);
      return res.track ?? null;
    } catch {
      return null;
    }
  },
  resolveTrack: async (input) => {
    try {
      const res = await apiFetch<{
        videoId?: string;
        streamUrl?: string;
        matchedDuration?: number;
      }>('/api/yt-stream/resolve', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!res?.videoId || !isValidYouTubeVideoId(res.videoId)) return null;
      return {
        videoId: res.videoId,
        streamUrl: res.streamUrl,
        matchedDuration: res.matchedDuration,
      };
    } catch {
      return null;
    }
  },
};

function getRemoteVideoId(raw: RemoteTrackState): string | null {
  if (raw.videoId && isValidYouTubeVideoId(raw.videoId)) {
    return raw.videoId;
  }
  if (typeof raw.id === 'string' && raw.id.startsWith('yt-')) {
    const vid = raw.id.slice(3);
    if (isValidYouTubeVideoId(vid)) return vid;
  }
  return null;
}

function buildYouTubeStreamTrack(
  raw: RemoteTrackState,
  videoId: string,
  resolvedDuration?: number
): Track {
  const deezerTrackId = extractDeezerTrackId(raw);
  const duration =
    Number.isFinite(raw.duration) && raw.duration > 0
      ? raw.duration
      : resolvedDuration && Number.isFinite(resolvedDuration) && resolvedDuration > 0
        ? resolvedDuration
        : 0;
  return {
    id: `yt-${videoId}`,
    rel_path: '',
    title: raw.title || 'Untitled',
    artist: raw.artist || 'Unknown Artist',
    album: raw.album || 'Online Stream',
    track_number: null,
    year: null,
    duration,
    format: 'm4a',
    bitrate: 0,
    size_bytes: 0,
    cover_file: null,
    dominant_color: raw.dominant_color || '#1f2937',
    added_at: '',
    liked: false,
    coverUrl: raw.cover || getYouTubeThumbProxyUrl(videoId),
    streamUrl: `/api/yt-stream/${encodeURIComponent(videoId)}`,
    isYouTubeStream: true,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    ...(deezerTrackId ? {deezerTrackId} : {}),
  };
}

function buildLightweightLibraryTrack(raw: RemoteTrackState, numericId: number): Track {
  return {
    id: numericId,
    rel_path: '',
    title: raw.title || 'Untitled',
    artist: raw.artist || 'Unknown Artist',
    album: raw.album || '',
    track_number: null,
    year: null,
    duration: raw.duration || 0,
    format: 'AUDIO',
    bitrate: 0,
    size_bytes: 0,
    cover_file: raw.cover_file ?? null,
    coverUrl: raw.cover || undefined,
    dominant_color: raw.dominant_color || '#1f3a2e',
    added_at: '',
    liked: false,
    isYouTubeStream: false,
  };
}

function isLibraryRemoteTrack(raw: RemoteTrackState, videoId: string | null, deezerTrackId: string | null): boolean {
  return (
    !raw.isYouTubeStream &&
    !videoId &&
    !deezerTrackId &&
    typeof raw.id === 'number' &&
    Number.isSafeInteger(raw.id) &&
    raw.id > 0
  );
}

function canResolveByMetadata(raw: RemoteTrackState, deezerTrackId: string | null): boolean {
  const title = (raw.title || '').trim();
  const artist = (raw.artist || '').trim();
  const hasRealTitle = Boolean(title && title !== 'Untitled');
  const hasRealArtist = Boolean(artist && artist !== 'Unknown Artist');
  if (deezerTrackId) {
    return hasRealTitle;
  }
  return hasRealTitle && hasRealArtist;
}

/**
 * Hydrates a serialized remote track on the host device into a playable Track.
 * - Library tracks: fetched from /api/tracks/:id (with lightweight fallback).
 * - YouTube tracks: built directly from videoId.
 * - Catalog (dz-track-<digits>) or artist+title web tracks: resolved via the same
 *   /api/yt-stream/resolve (resolveTrackToVideoId) resolver used for local playback.
 */
export async function hydrateRemoteTrack(
  raw: RemoteTrackState,
  deps: HydrateRemoteTrackDeps = {}
): Promise<Track | null> {
  const videoId = getRemoteVideoId(raw);
  const deezerTrackId = extractDeezerTrackId(raw);

  if (videoId) {
    return buildYouTubeStreamTrack(raw, videoId);
  }

  if (isLibraryRemoteTrack(raw, videoId, deezerTrackId)) {
    const numericId = raw.id as number;
    const fetcher = deps.fetchLibraryTrack ?? defaultHydrateDeps.fetchLibraryTrack;
    const fetched = await fetcher(numericId);
    if (fetched) return fetched;
    return buildLightweightLibraryTrack(raw, numericId);
  }

  if (canResolveByMetadata(raw, deezerTrackId)) {
    const title = (raw.title || '').trim();
    const rawArtist = (raw.artist || '').trim();
    const artist = rawArtist === 'Unknown Artist' ? '' : rawArtist;
    const resolver = deps.resolveTrack ?? defaultHydrateDeps.resolveTrack;
    const resolved = await resolver({
      artist,
      title,
      duration: Number.isFinite(raw.duration) ? Math.max(0, raw.duration) : 0,
    });
    if (resolved && isValidYouTubeVideoId(resolved.videoId)) {
      return buildYouTubeStreamTrack(raw, resolved.videoId, resolved.matchedDuration);
    }
  }

  return null;
}

/**
 * Synchronously builds a queue entry for non-current items in a transfer so the current
 * track starts immediately while remaining catalog/library tracks hydrate lazily in the background.
 */
export function buildImmediateRemoteTrack(
  raw: RemoteTrackState,
  fallbackIndex: number
): {track: Track; needsBackgroundHydration: boolean} | null {
  const videoId = getRemoteVideoId(raw);
  const deezerTrackId = extractDeezerTrackId(raw);

  if (videoId) {
    return {
      track: buildYouTubeStreamTrack(raw, videoId),
      needsBackgroundHydration: false,
    };
  }

  if (isLibraryRemoteTrack(raw, videoId, deezerTrackId)) {
    return {
      track: buildLightweightLibraryTrack(raw, raw.id as number),
      needsBackgroundHydration: true,
    };
  }

  if (canResolveByMetadata(raw, deezerTrackId)) {
    const title = (raw.title || '').trim();
    const rawArtist = (raw.artist || '').trim();
    const artist = rawArtist === 'Unknown Artist' ? '' : rawArtist;
    const placeholderId =
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : deezerTrackId
          ? `dz-track-${deezerTrackId}`
          : `remote-web-${fallbackIndex}-${title.slice(0, 24)}`;
    return {
      track: {
        id: placeholderId,
        rel_path: '',
        title: raw.title || 'Untitled',
        artist: raw.artist || 'Unknown Artist',
        album: raw.album || 'Online Stream',
        track_number: null,
        year: null,
        duration: Number.isFinite(raw.duration) ? Math.max(0, raw.duration) : 0,
        format: 'm4a',
        bitrate: 0,
        size_bytes: 0,
        cover_file: null,
        dominant_color: raw.dominant_color || '#1f2937',
        added_at: '',
        liked: false,
        coverUrl: raw.cover || undefined,
        streamUrl: getCatalogMatchStreamUrl({
          artist,
          title,
          duration: raw.duration,
        }),
        isYouTubeStream: true,
        ...(deezerTrackId ? {deezerTrackId} : {}),
      },
      needsBackgroundHydration: true,
    };
  }

  return null;
}

export function formatRemoteAckError(
  ack: RemoteCommandAckResponse,
  deviceName: string
): string | null {
  if (ack.status === 'applied') return null;
  const name = deviceName.trim() || 'Target device';

  if (
    ack.status === 'timeout' ||
    ack.reason === 'timeout' ||
    ack.reason === 'device_timeout' ||
    ack.reason === 'network_error'
  ) {
    return `${name} didn't respond`;
  }

  switch (ack.reason) {
    case 'device_offline':
      return `${name} is offline`;
    case 'needs_gesture':
      return `Tap ${name} to start playback`;
    case 'unresolvable_track':
    case 'unresolvable_transfer':
      return `Couldn't find that track on ${name}`;
    case 'invalid_track':
      return `Track couldn't be sent to ${name}`;
    case 'empty_transfer':
      return `Nothing to transfer to ${name}`;
    case 'no_track':
      return `No track is loaded on ${name}`;
    default:
      return `Couldn't complete action on ${name}`;
  }
}

export function buildTransferQueueSlice(
  queue: Track[],
  currentIndex: number,
  currentTrack: Track | null
): {track: RemoteTrackState; queue: RemoteTrackState[]; index: number} | null {
  if (!currentTrack) return null;
  const safeQueue = queue.length > 0 ? queue : [currentTrack];
  const rawIdx =
    currentIndex >= 0 && currentIndex < safeQueue.length
      ? currentIndex
      : Math.max(
          0,
          safeQueue.findIndex((t) => String(t.id) === String(currentTrack.id))
        );

  // Slice up to 100 tracks centered so the current track and upcoming tracks are preserved
  let start = 0;
  if (safeQueue.length > MAX_TRANSFER_QUEUE_ITEMS) {
    start = Math.max(0, Math.min(rawIdx - 10, safeQueue.length - MAX_TRANSFER_QUEUE_ITEMS));
  }
  const sliced = safeQueue.slice(start, start + MAX_TRANSFER_QUEUE_ITEMS);
  const adjustedIdx = Math.max(0, Math.min(sliced.length - 1, rawIdx - start));
  const serializedQueue = sliced.map(serializeTrackForRemote);
  return {
    track: serializedQueue[adjustedIdx] ?? serializeTrackForRemote(currentTrack),
    queue: serializedQueue,
    index: adjustedIdx,
  };
}

type CommandListener = (event: RemoteCommandEvent) => void;
type HelloListener = () => void;

class RemoteControlController {
  private readonly selfDeviceId = getOrCreateDeviceId();
  private readonly selfPlatform = detectDevicePlatform();
  private selfDeviceName = getDeviceName();
  private activeUserId: number | null = null;
  private eventSource: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private toastCounter = 0;
  private commandCounter = 0;

  private connected = false;
  private devices: RemoteDeviceInfo[] = [];
  private targetDeviceId: string | null = null;
  private readonly heldStates = new Map<string, HeldRemoteState>();
  private pendingCommand: {commandId: string; cmd: RemoteCommandName; startedAtMs: number} | null =
    null;
  private deviceSheetOpen = false;
  private toast: RemoteToastState | null = null;

  private readonly storeListeners = new Set<() => void>();
  private readonly commandListeners = new Set<CommandListener>();
  private readonly helloListeners = new Set<HelloListener>();
  private snapshotCache: RemoteControlSnapshot | null = null;

  constructor() {
    subscribeDeviceName(() => {
      const next = getDeviceName();
      if (next === this.selfDeviceName) return;
      this.selfDeviceName = next;
      this.notify();
      // Reconnect SSE so server & other devices immediately receive the updated friendly name
      if (this.activeUserId !== null) {
        this.reconnectNow();
      }
    });
  }

  private getTargetStorageKey(userId: number | null): string {
    return userId ? `${TARGET_STORAGE_PREFIX}:user:${userId}` : `${TARGET_STORAGE_PREFIX}:default`;
  }

  private loadRememberedTarget(userId: number | null): string | null {
    try {
      if (typeof localStorage === 'undefined') return null;
      const saved = localStorage.getItem(this.getTargetStorageKey(userId))?.trim();
      if (!saved || saved === this.selfDeviceId) return null;
      return saved;
    } catch {
      return null;
    }
  }

  private persistRememberedTarget(userId: number | null, targetId: string | null): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const key = this.getTargetStorageKey(userId);
      if (targetId && targetId !== this.selfDeviceId) {
        localStorage.setItem(key, targetId);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // ignore storage errors
    }
  }

  private notify(): void {
    this.snapshotCache = null;
    for (const listener of this.storeListeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.storeListeners.add(listener);
    return () => {
      this.storeListeners.delete(listener);
    };
  };

  onCommand(listener: CommandListener): () => void {
    this.commandListeners.add(listener);
    return () => {
      this.commandListeners.delete(listener);
    };
  }

  onHello(listener: HelloListener): () => void {
    this.helloListeners.add(listener);
    return () => {
      this.helloListeners.delete(listener);
    };
  }

  getSnapshot = (): RemoteControlSnapshot => {
    if (this.snapshotCache) return this.snapshotCache;
    const targetDevice = this.targetDeviceId
      ? this.devices.find((d) => d.deviceId === this.targetDeviceId) ?? null
      : null;
    const targetHeldState = this.targetDeviceId
      ? this.heldStates.get(this.targetDeviceId) ?? null
      : null;
    this.snapshotCache = {
      selfDeviceId: this.selfDeviceId,
      selfDeviceName: this.selfDeviceName,
      selfPlatform: this.selfPlatform,
      connected: this.connected,
      devices: this.devices,
      targetDeviceId: this.targetDeviceId,
      targetDevice,
      targetHeldState,
      pendingCommand: this.pendingCommand,
      deviceSheetOpen: this.deviceSheetOpen,
      toast: this.toast,
    };
    return this.snapshotCache;
  };

  showToast(
    message: string,
    action?: 'resume_local' | 'retry',
    durationMs = 3600,
    onRetry?: () => void
  ): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toastCounter += 1;
    this.toast = {id: this.toastCounter, message, action, onRetry};
    this.notify();
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.toastTimer = null;
      this.notify();
    }, durationMs);
  }

  dismissToast = (): void => {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    if (this.toast) {
      this.toast = null;
      this.notify();
    }
  };

  setDeviceSheetOpen = (open: boolean): void => {
    if (this.deviceSheetOpen === open) return;
    this.deviceSheetOpen = open;
    this.notify();
  };

  selectTarget = (deviceId: string | null): void => {
    const normalized = !deviceId || deviceId === this.selfDeviceId ? null : deviceId;
    if (normalized) {
      const found = this.devices.find((d) => d.deviceId === normalized);
      if (!found || !found.online) {
        this.showToast('Device is offline');
        return;
      }
    }
    this.targetDeviceId = normalized;
    this.persistRememberedTarget(this.activeUserId, normalized);
    this.notify();
  };

  private fallbackTargetOffline(reasonMessage = 'Device went offline'): void {
    if (!this.targetDeviceId) return;
    this.targetDeviceId = null;
    this.persistRememberedTarget(this.activeUserId, null);
    this.clearPendingCommand();
    this.showToast(reasonMessage);
  }

  private clearPendingCommand(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingCommand) {
      this.pendingCommand = null;
      this.notify();
    }
  }

  private applyIncomingState(
    deviceId: string,
    state: RemotePlaybackState | null | undefined,
    receivedAtMs: number,
    allowRevReset = false
  ): void {
    if (!state) return;
    const prev = this.heldStates.get(deviceId);
    if (prev && !allowRevReset && state.rev <= prev.rev) {
      return;
    }
    this.heldStates.set(deviceId, {
      state,
      receivedAtMs,
      rev: state.rev,
    });
  }

  private applyDevicesList(nextDevices: RemoteDeviceInfo[], receivedAtMs: number, isHello = false): void {
    this.devices = nextDevices;
    for (const dev of nextDevices) {
      if (dev.state) {
        this.applyIncomingState(dev.deviceId, dev.state, receivedAtMs, isHello);
      }
    }

    // If a remote target is selected and it disappeared or went offline, fall back safely to local
    if (this.targetDeviceId) {
      const target = nextDevices.find((d) => d.deviceId === this.targetDeviceId);
      if (!target || !target.online) {
        this.fallbackTargetOffline('Device went offline');
        return;
      }
    }
    this.notify();
  }

  connect(userId: number): void {
    if (this.activeUserId === userId && this.eventSource) return;
    this.disconnect();
    this.activeUserId = userId;
    this.selfDeviceName = getDeviceName();
    this.targetDeviceId = this.loadRememberedTarget(userId);
    this.reconnectAttempt = 0;
    this.openEventSource();
  }

  private reconnectNow(): void {
    if (this.activeUserId === null) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.reconnectAttempt = 0;
    this.openEventSource();
  }

  private openEventSource(): void {
    if (this.activeUserId === null) return;
    if (typeof EventSource === 'undefined') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.handleConnectionLost();
      return;
    }

    const qs = new URLSearchParams({
      deviceId: this.selfDeviceId,
      name: this.selfDeviceName,
      platform: this.selfPlatform,
    });
    const url = getSSEUrl(`/api/devices/events?${qs.toString()}`);
    const es = new EventSource(url);
    this.eventSource = es;

    es.addEventListener('hello', (evt) => {
      if (this.eventSource !== es) return;
      this.connected = true;
      this.reconnectAttempt = 0;
      const receivedAtMs = Date.now();
      try {
        const data = JSON.parse((evt as MessageEvent).data) as {
          devices?: RemoteDeviceInfo[];
        };
        this.applyDevicesList(Array.isArray(data.devices) ? data.devices : [], receivedAtMs, true);
      } catch {
        this.notify();
      }
      for (const listener of this.helloListeners) {
        listener();
      }
    });

    es.addEventListener('devices', (evt) => {
      if (this.eventSource !== es) return;
      const receivedAtMs = Date.now();
      try {
        const data = JSON.parse((evt as MessageEvent).data) as {
          devices?: RemoteDeviceInfo[];
        };
        if (Array.isArray(data.devices)) {
          this.applyDevicesList(data.devices, receivedAtMs, false);
        }
      } catch {
        // ignore malformed payload
      }
    });

    es.addEventListener('device-state', (evt) => {
      if (this.eventSource !== es) return;
      const receivedAtMs = Date.now();
      try {
        const data = JSON.parse((evt as MessageEvent).data) as {
          deviceId?: string;
          state?: RemotePlaybackState;
        };
        if (!data.deviceId || !data.state) return;
        this.applyIncomingState(data.deviceId, data.state, receivedAtMs, false);
        this.devices = this.devices.map((dev) =>
          dev.deviceId === data.deviceId
            ? {...dev, online: true, lastSeen: receivedAtMs, rev: data.state!.rev, state: data.state!}
            : dev
        );
        this.notify();
      } catch {
        // ignore malformed state event
      }
    });

    es.addEventListener('command', (evt) => {
      if (this.eventSource !== es) return;
      try {
        const data = JSON.parse((evt as MessageEvent).data) as RemoteCommandEvent;
        if (!data || !data.commandId || !data.cmd) return;
        for (const listener of this.commandListeners) {
          listener(data);
        }
      } catch {
        // ignore malformed command
      }
    });

    es.onerror = () => {
      if (this.eventSource !== es) return;
      es.close();
      this.eventSource = null;
      this.handleConnectionLost();
    };
  }

  private handleConnectionLost(): void {
    this.connected = false;
    // Mark all remote devices offline while SSE is dropped, and never leave local player stuck in remote mode
    this.devices = this.devices.map((dev) =>
      dev.deviceId === this.selfDeviceId ? dev : {...dev, online: false}
    );
    if (this.targetDeviceId) {
      this.fallbackTargetOffline('Device went offline');
    } else {
      this.notify();
    }

    if (this.activeUserId === null) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    const jitter = Math.floor(Math.random() * 400);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openEventSource();
    }, delay + jitter);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.clearPendingCommand();
    this.activeUserId = null;
    this.connected = false;
    this.devices = [];
    this.targetDeviceId = null;
    this.heldStates.clear();
    this.notify();
  }

  async publishState(state: Omit<RemotePlaybackState, 'rev' | 'serverNowMs'>): Promise<void> {
    if (this.activeUserId === null) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      await apiFetch(`/api/devices/${encodeURIComponent(this.selfDeviceId)}/state`, {
        method: 'PUT',
        body: JSON.stringify({
          ...state,
          name: this.selfDeviceName,
          platform: this.selfPlatform,
        }),
      });
    } catch {
      // Best-effort state publish; reconnect loop will resync
    }
  }

  async send(
    cmd: RemoteCommandName,
    args: Record<string, unknown> = {},
    explicitTargetId?: string,
    options?: {onRetry?: () => void; suppressToast?: boolean}
  ): Promise<RemoteCommandAckResponse> {
    const targetId = explicitTargetId ?? this.targetDeviceId;
    if (!targetId || targetId === this.selfDeviceId) {
      return {status: 'rejected', reason: 'no_target'};
    }

    const targetName =
      this.devices.find((d) => d.deviceId === targetId)?.name || 'Target device';

    this.commandCounter += 1;
    const commandId = `${this.selfDeviceId.slice(0, 8)}-${Date.now()}-${this.commandCounter}`;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingCommand = {commandId, cmd, startedAtMs: Date.now()};
    this.notify();

    const pendingTimeoutMs =
      cmd === 'transfer' || cmd === 'playTrack' ? TRANSFER_PENDING_TIMEOUT_MS : PENDING_TIMEOUT_MS;
    this.pendingTimer = setTimeout(() => {
      if (this.pendingCommand?.commandId === commandId) {
        this.pendingCommand = null;
        this.pendingTimer = null;
        this.notify();
      }
    }, pendingTimeoutMs);

    const retryAction =
      options?.onRetry ??
      (() => {
        void this.send(cmd, args, targetId, options);
      });

    try {
      const res = await apiFetch<RemoteCommandAckResponse>(
        `/api/devices/${encodeURIComponent(targetId)}/command`,
        {
          method: 'POST',
          body: JSON.stringify({
            cmd,
            args,
            commandId,
            fromDeviceId: this.selfDeviceId,
          }),
        }
      );

      if (res.status !== 'applied') {
        const msg = formatRemoteAckError(res, targetName);
        if (res.status === 'rejected' && res.reason === 'device_offline') {
          if (targetId === this.targetDeviceId) {
            this.targetDeviceId = null;
            this.persistRememberedTarget(this.activeUserId, null);
            this.clearPendingCommand();
          }
        }
        if (msg && !options?.suppressToast) {
          this.showToast(msg, 'retry', 6000, retryAction);
        }
      }

      return res;
    } catch {
      const fallbackAck: RemoteCommandAckResponse = {status: 'timeout', reason: 'network_error'};
      const msg = formatRemoteAckError(fallbackAck, targetName);
      if (msg && !options?.suppressToast) {
        this.showToast(msg, 'retry', 6000, retryAction);
      }
      return fallbackAck;
    } finally {
      if (this.pendingCommand?.commandId === commandId) {
        this.clearPendingCommand();
      }
    }
  }

  async ackCommand(
    commandId: string,
    status: 'applied' | 'rejected',
    reason?: string
  ): Promise<void> {
    if (this.activeUserId === null) return;
    try {
      await apiFetch(`/api/devices/${encodeURIComponent(this.selfDeviceId)}/ack`, {
        method: 'POST',
        body: JSON.stringify({commandId, status, reason}),
      });
    } catch {
      // Best-effort ack
    }
  }
}

export const remoteControl = new RemoteControlController();

export function useRemoteControl() {
  const snapshot = useSyncExternalStore(
    remoteControl.subscribe,
    remoteControl.getSnapshot,
    remoteControl.getSnapshot
  );

  const isRemoteActive = Boolean(
    snapshot.targetDeviceId && snapshot.targetDevice && snapshot.targetDevice.online
  );
  const targetState = snapshot.targetHeldState?.state ?? snapshot.targetDevice?.state ?? null;
  const targetReceivedAtMs = snapshot.targetHeldState?.receivedAtMs ?? Date.now();

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!isRemoteActive || !targetState?.isPlaying) return;
    const id = window.setInterval(() => {
      setClockTick((t) => t + 1);
    }, 250);
    return () => window.clearInterval(id);
  }, [isRemoteActive, targetState?.isPlaying, targetState?.rev]);

  // Include clockTick in calculation so UI smoothly advances remote playback timer
  const extrapolatedPositionSec =
    clockTick >= 0
      ? extrapolateRemotePosition(targetState, targetReceivedAtMs, Date.now())
      : 0;

  const otherDevices = snapshot.devices.filter((d) => d.deviceId !== snapshot.selfDeviceId);

  return {
    ...snapshot,
    otherDevices,
    isRemoteActive,
    targetState,
    extrapolatedPositionSec,
    isPending: snapshot.pendingCommand !== null,
    selectTarget: remoteControl.selectTarget,
    send: remoteControl.send.bind(remoteControl),
    setDeviceSheetOpen: remoteControl.setDeviceSheetOpen,
    dismissToast: remoteControl.dismissToast,
    showToast: remoteControl.showToast.bind(remoteControl),
  };
}
