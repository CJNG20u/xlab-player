import {useEffect, useRef} from 'react';
import {useAuth} from '../context/AuthContext';
import {usePlayer} from '../context/PlayerContext';
import {useOnlineStatus} from './useOnlineStatus';
import {
  apiFetch,
  getYouTubeThumbProxyUrl,
  isValidYouTubeVideoId,
} from '../lib/api';
import {
  buildTransferQueueSlice,
  remoteControl,
  serializeTrackForRemote,
  type RemoteCommandEvent,
  type RemoteTrackState,
} from '../lib/remoteControl';
import type {RepeatMode, Track} from '../types';

const STATE_DEBOUNCE_MS = 250;
const PLAYING_HEARTBEAT_MS = 5_000;

async function hydrateRemoteTrack(raw: RemoteTrackState): Promise<Track | null> {
  const videoId =
    raw.videoId && isValidYouTubeVideoId(raw.videoId)
      ? raw.videoId
      : typeof raw.id === 'string' && raw.id.startsWith('yt-') && isValidYouTubeVideoId(raw.id.slice(3))
        ? raw.id.slice(3)
        : null;

  if (!raw.isYouTubeStream && !videoId && typeof raw.id === 'number' && raw.id > 0) {
    try {
      const res = await apiFetch<{track: Track}>(`/api/tracks/${raw.id}`);
      if (res.track) return res.track;
    } catch {
      // Fall back to lightweight track object if detail fetch fails
    }
    return {
      id: raw.id,
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

  if (videoId) {
    return {
      id: `yt-${videoId}`,
      rel_path: '',
      title: raw.title || 'Untitled',
      artist: raw.artist || 'Unknown Artist',
      album: raw.album || 'Online Stream',
      track_number: null,
      year: null,
      duration: raw.duration || 0,
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
    };
  }

  return null;
}

/**
 * Connects this device to the multi-device SSE hub, executes incoming remote commands
 * against PlayerContext actions, and publishes local playback state (250ms debounce + 5s while playing).
 */
export function useRemoteHost(): void {
  const {user, isOfflineMode} = useAuth();
  const isOnline = useOnlineStatus();
  const offline = !isOnline || isOfflineMode;

  const {
    currentTrack,
    queue,
    currentIndex,
    isPlaying,
    currentTime,
    volume,
    isMuted,
    shuffle,
    repeat,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    remoteHostApi,
  } = usePlayer();

  // Keep latest PlayerContext state & actions in a ref so command/publish timers never use stale closures
  const latestRef = useRef({
    currentTrack,
    queue,
    currentIndex,
    isPlaying,
    currentTime,
    volume,
    isMuted,
    shuffle,
    repeat,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    remoteHostApi,
  });
  latestRef.current = {
    currentTrack,
    queue,
    currentIndex,
    isPlaying,
    currentTime,
    volume,
    isMuted,
    shuffle,
    repeat,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    remoteHostApi,
  };

  const publishNow = () => {
    const s = latestRef.current;
    void remoteControl.publishState({
      track: s.currentTrack ? serializeTrackForRemote(s.currentTrack) : null,
      positionSec: Number.isFinite(s.currentTime) ? Math.max(0, s.currentTime) : 0,
      isPlaying: s.isPlaying,
      volume: s.volume,
      muted: s.isMuted,
      shuffle: s.shuffle,
      repeat: s.repeat,
      queueLength: s.queue.length,
      measuredAtMs: Date.now(),
    });
  };
  const publishNowRef = useRef(publishNow);
  publishNowRef.current = publishNow;

  // 1. Connect / disconnect SSE session with authenticated user
  useEffect(() => {
    if (!user || offline) {
      remoteControl.disconnect();
      return;
    }
    remoteControl.connect(user.id);
    const unsubHello = remoteControl.onHello(() => {
      publishNowRef.current();
    });
    return () => {
      unsubHello();
      remoteControl.disconnect();
    };
  }, [user, offline]);

  // 2. Execute incoming remote commands against PlayerContext actions & ack
  useEffect(() => {
    if (!user || offline) return;

    const handleCommand = async (event: RemoteCommandEvent) => {
      const api = latestRef.current;
      const {cmd, args, commandId, fromDeviceName} = event;

      try {
        switch (cmd) {
          case 'play': {
            const result = await api.remoteHostApi.playLocal();
            if (result === 'applied') {
              await remoteControl.ackCommand(commandId, 'applied');
            } else if (result === 'no_track') {
              await remoteControl.ackCommand(commandId, 'rejected', 'no_track');
            } else {
              remoteControl.showToast(
                `Tap to start playback requested from ${fromDeviceName}`,
                'resume_local',
                8000
              );
              await remoteControl.ackCommand(commandId, 'rejected', 'needs_gesture');
            }
            break;
          }

          case 'pause': {
            api.remoteHostApi.pauseLocal();
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'toggle': {
            if (api.isPlaying) {
              api.remoteHostApi.pauseLocal();
              await remoteControl.ackCommand(commandId, 'applied');
            } else {
              const result = await api.remoteHostApi.playLocal();
              if (result === 'applied') {
                await remoteControl.ackCommand(commandId, 'applied');
              } else if (result === 'no_track') {
                await remoteControl.ackCommand(commandId, 'rejected', 'no_track');
              } else {
                remoteControl.showToast(
                  `Tap to start playback requested from ${fromDeviceName}`,
                  'resume_local',
                  8000
                );
                await remoteControl.ackCommand(commandId, 'rejected', 'needs_gesture');
              }
            }
            break;
          }

          case 'next': {
            api.nextTrack();
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'prev': {
            api.prevTrack();
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'seek': {
            const pos = Number(args.positionSec);
            if (!Number.isFinite(pos) || pos < 0) {
              await remoteControl.ackCommand(commandId, 'rejected', 'invalid_position');
              return;
            }
            api.seek(pos);
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'setVolume': {
            const vol = Number(args.volume);
            if (!Number.isFinite(vol) || vol < 0 || vol > 1) {
              await remoteControl.ackCommand(commandId, 'rejected', 'invalid_volume');
              return;
            }
            api.setVolume(vol);
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'mute': {
            if (typeof args.muted === 'boolean') {
              api.remoteHostApi.setMuted(args.muted);
            } else {
              api.toggleMute();
            }
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'shuffle': {
            if (typeof args.shuffle === 'boolean') {
              api.remoteHostApi.setShuffle(args.shuffle);
            } else {
              api.toggleShuffle();
            }
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'repeat': {
            const mode = args.repeat as RepeatMode | undefined;
            if (mode === 'off' || mode === 'all' || mode === 'one') {
              api.remoteHostApi.setRepeat(mode);
            } else {
              api.cycleRepeat();
            }
            await remoteControl.ackCommand(commandId, 'applied');
            break;
          }

          case 'playTrack': {
            const rawTrack = args.track as RemoteTrackState | undefined;
            if (!rawTrack) {
              await remoteControl.ackCommand(commandId, 'rejected', 'invalid_track');
              return;
            }
            const hydrated = await hydrateRemoteTrack(rawTrack);
            if (!hydrated) {
              await remoteControl.ackCommand(commandId, 'rejected', 'unresolvable_track');
              return;
            }
            const result = await api.remoteHostApi.applyTransfer({
              queue: [hydrated],
              index: 0,
              positionSec: 0,
              isPlaying: true,
            });
            if (result === 'applied') {
              await remoteControl.ackCommand(commandId, 'applied');
            } else {
              remoteControl.showToast(
                `Tap to start playback requested from ${fromDeviceName}`,
                'resume_local',
                8000
              );
              await remoteControl.ackCommand(commandId, 'rejected', 'needs_gesture');
            }
            break;
          }

          case 'transfer': {
            // Pull transfer requested by another device ("Play here"): pause here and push our queue back
            if (args.direction === 'pull' && typeof args.toDeviceId === 'string') {
              const slice = buildTransferQueueSlice(
                api.queue,
                api.currentIndex,
                api.currentTrack
              );
              if (!slice) {
                await remoteControl.ackCommand(commandId, 'rejected', 'no_track');
                return;
              }
              const pos = Number.isFinite(api.currentTime) ? Math.max(0, api.currentTime) : 0;
              api.remoteHostApi.pauseLocal();
              await remoteControl.ackCommand(commandId, 'applied');
              void remoteControl.send(
                'transfer',
                {
                  track: slice.track,
                  queue: slice.queue,
                  index: slice.index,
                  positionSec: pos,
                  isPlaying: true,
                },
                args.toDeviceId
              );
              break;
            }

            const rawQueue = Array.isArray(args.queue)
              ? (args.queue as RemoteTrackState[])
              : args.track
                ? [args.track as RemoteTrackState]
                : [];
            if (rawQueue.length === 0) {
              await remoteControl.ackCommand(commandId, 'rejected', 'empty_transfer');
              return;
            }

            const rawIndex = Math.max(
              0,
              Math.min(rawQueue.length - 1, Math.floor(Number(args.index ?? 0)))
            );
            const hydratedList: Track[] = [];
            let adjustedIndex = 0;

            for (let i = 0; i < rawQueue.length; i += 1) {
              const item = await hydrateRemoteTrack(rawQueue[i]);
              if (item) {
                if (i === rawIndex) adjustedIndex = hydratedList.length;
                hydratedList.push(item);
              }
            }

            if (hydratedList.length === 0) {
              await remoteControl.ackCommand(commandId, 'rejected', 'unresolvable_transfer');
              return;
            }

            const positionSec = Number.isFinite(Number(args.positionSec))
              ? Math.max(0, Number(args.positionSec))
              : 0;
            const shouldPlay = Boolean(args.isPlaying);

            const result = await api.remoteHostApi.applyTransfer({
              queue: hydratedList,
              index: adjustedIndex,
              positionSec,
              isPlaying: shouldPlay,
            });
            if (result === 'applied') {
              await remoteControl.ackCommand(commandId, 'applied');
            } else {
              remoteControl.showToast(
                `Tap to start playback requested from ${fromDeviceName}`,
                'resume_local',
                8000
              );
              await remoteControl.ackCommand(commandId, 'rejected', 'needs_gesture');
            }
            break;
          }
        }
      } catch {
        await remoteControl.ackCommand(commandId, 'rejected', 'execution_error');
      } finally {
        // Publish updated state shortly after applying any remote command
        setTimeout(() => publishNowRef.current(), 80);
      }
    };

    return remoteControl.onCommand((event) => {
      void handleCommand(event);
    });
  }, [user, offline]);

  // 3. Debounced (250ms) state publication on playback changes (and on seek jumps)
  const prevPublishedPosRef = useRef<{trackId: string | null; pos: number; at: number}>({
    trackId: null,
    pos: 0,
    at: 0,
  });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTrackId = currentTrack ? String(currentTrack.id) : null;
  const queueLength = queue.length;

  useEffect(() => {
    if (!user || offline) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      prevPublishedPosRef.current = {
        trackId: currentTrackId,
        pos: latestRef.current.currentTime,
        at: Date.now(),
      };
      publishNowRef.current();
    }, STATE_DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [
    user,
    offline,
    currentTrackId,
    isPlaying,
    volume,
    isMuted,
    shuffle,
    repeat,
    queueLength,
  ]);

  // Detect manual seek jumps on currentTime and publish (debounced 250ms)
  useEffect(() => {
    if (!user || offline || !currentTrackId) return;
    const prev = prevPublishedPosRef.current;
    const now = Date.now();
    const elapsedSec = prev.at > 0 ? (now - prev.at) / 1000 : 0;
    const expected = prev.trackId === currentTrackId && isPlaying ? prev.pos + elapsedSec : prev.pos;
    if (Math.abs(currentTime - expected) > 2.2) {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        prevPublishedPosRef.current = {
          trackId: currentTrackId,
          pos: latestRef.current.currentTime,
          at: Date.now(),
        };
        publishNowRef.current();
      }, STATE_DEBOUNCE_MS);
    }
  }, [user, offline, currentTrackId, currentTime, isPlaying]);

  // 4. Periodic 5s state publish while playing
  useEffect(() => {
    if (!user || offline || !isPlaying) return;
    const intervalId = window.setInterval(() => {
      prevPublishedPosRef.current = {
        trackId: latestRef.current.currentTrack ? String(latestRef.current.currentTrack.id) : null,
        pos: latestRef.current.currentTime,
        at: Date.now(),
      };
      publishNowRef.current();
    }, PLAYING_HEARTBEAT_MS);
    return () => window.clearInterval(intervalId);
  }, [user, offline, isPlaying]);
}
