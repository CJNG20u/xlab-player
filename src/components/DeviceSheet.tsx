import {
  ArrowRightLeft,
  Check,
  Laptop,
  Loader2,
  MonitorSpeaker,
  Play,
  Send,
  Smartphone,
  Tablet,
  WifiOff,
  X,
} from 'lucide-react';
import React, {useState} from 'react';
import {usePlayer} from '../context/PlayerContext';
import {useBackClose} from '../lib/backStack';
import {playbackClock} from '../lib/playbackClock';
import {
  buildTransferQueueSlice,
  useRemoteControl,
  type RemoteDeviceInfo,
} from '../lib/remoteControl';

interface DeviceSheetProps {
  open: boolean;
  onClose: () => void;
}

function PlatformIcon({platform, className}: {platform: string; className?: string}) {
  if (platform === 'mobile') return <Smartphone className={className} />;
  if (platform === 'tablet') return <Tablet className={className} />;
  return <Laptop className={className} />;
}

export const DeviceSheet: React.FC<DeviceSheetProps> = ({open, onClose}) => {
  const {
    currentTrack,
    queue,
    currentIndex,
    isPlaying,
    remoteHostApi,
  } = usePlayer();

  const {
    selfDeviceId,
    selfDeviceName,
    selfPlatform,
    connected,
    otherDevices,
    targetDeviceId,
    targetDevice,
    targetState,
    isRemoteActive,
    isPending,
    selectTarget,
    send,
    showToast,
  } = useRemoteControl();

  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);

  useBackClose(open, onClose);

  if (!open) return null;

  const handleSendToDevice = async (device: RemoteDeviceInfo) => {
    const slice = buildTransferQueueSlice(queue, currentIndex, currentTrack);
    if (!slice) {
      showToast('Play a track first to send it');
      return;
    }
    setBusyDeviceId(device.deviceId);
    try {
      const ack = await send(
        'transfer',
        {
          track: slice.track,
          queue: slice.queue,
          index: slice.index,
          positionSec: Number.isFinite(playbackClock.getTime())
            ? Math.max(0, playbackClock.getTime())
            : 0,
          isPlaying,
        },
        device.deviceId
      );
      if (ack.status === 'applied' || ack.reason === 'needs_gesture') {
        remoteHostApi.pauseLocal();
        selectTarget(device.deviceId);
        if (ack.status === 'applied') {
          showToast(`Sent playback to ${device.name}`);
        }
        onClose();
      }
    } finally {
      setBusyDeviceId(null);
    }
  };

  const handlePlayHere = async () => {
    if (!targetDeviceId || !targetDevice) {
      selectTarget(null);
      onClose();
      return;
    }
    // Synchronously unlock local <audio> inside the user click gesture so the incoming transfer plays right away
    remoteHostApi.unlockAudio();
    setBusyDeviceId(targetDeviceId);
    try {
      const ack = await send(
        'transfer',
        {direction: 'pull', toDeviceId: selfDeviceId},
        targetDeviceId
      );
      selectTarget(null);
      if (ack.status === 'applied') {
        showToast(`Playing on ${selfDeviceName}`);
      }
      onClose();
    } finally {
      setBusyDeviceId(null);
    }
  };

  const localNowPlayingLine = currentTrack
    ? `${currentTrack.title} · ${currentTrack.artist}`
    : 'Not playing';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      data-no-swipe="true"
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Devices"
        className="relative z-10 flex w-full sm:max-w-md max-h-[82dvh] flex-col rounded-t-2xl sm:rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden pb-safe"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5 min-w-0">
            <MonitorSpeaker className="w-5 h-5 text-[var(--accent)] shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-base font-bold text-[var(--text-primary)]">
                Devices
              </h2>
              <p className="text-[11px] text-[var(--text-secondary)] truncate">
                {isRemoteActive && targetDevice
                  ? `Controlling ${targetDevice.name}`
                  : `Controlling ${selfDeviceName}`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Close devices"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {!connected && (
            <div className="flex items-center gap-2.5 rounded-lg bg-[var(--warn-bg)] border border-[var(--warn-border)] px-3.5 py-2.5 text-xs text-[var(--warn-text)]">
              <WifiOff className="w-4 h-4 shrink-0" />
              <span>Reconnecting to device sync...</span>
            </div>
          )}

          {/* Bring playback back banner when controlling a remote device */}
          {isRemoteActive && targetDevice && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)] px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-xs font-bold text-[var(--accent)] truncate">
                  Controlling {targetDevice.name}
                </p>
                <p className="text-[11px] text-[var(--text-secondary)] truncate">
                  {targetState?.track
                    ? `${targetState.track.title} · ${targetState.track.artist}`
                    : 'Connected'}
                </p>
              </div>
              <button
                type="button"
                disabled={busyDeviceId !== null || isPending}
                onClick={() => void handlePlayHere()}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-xs font-bold text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-50 transition-opacity shrink-0"
              >
                {busyDeviceId === targetDevice.deviceId ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                )}
                Play here
              </button>
            </div>
          )}

          {/* This device */}
          <div className="space-y-1.5">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              This device
            </p>
            <button
              type="button"
              onClick={() => {
                selectTarget(null);
                onClose();
              }}
              className={`w-full flex items-center gap-3 rounded-xl px-3.5 py-3 text-left border transition-colors ${
                !isRemoteActive
                  ? 'bg-[var(--accent-soft)] border-[var(--accent)]'
                  : 'bg-[var(--bg-elevated)] border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-primary)] text-[var(--accent)]">
                <PlatformIcon platform={selfPlatform} className="w-5 h-5" />
                <span
                  className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-[var(--bg-secondary)]"
                  title="Online"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                    {selfDeviceName}
                  </p>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    This device
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] truncate">
                  {localNowPlayingLine}
                </p>
              </div>
              {!isRemoteActive && (
                <Check className="w-4 h-4 text-[var(--accent)] shrink-0 stroke-[2.5]" />
              )}
            </button>
          </div>

          {/* Other devices */}
          <div className="space-y-2">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Other devices
            </p>
            {otherDevices.length === 0 ? (
              <div className="rounded-xl bg-[var(--bg-primary)] border border-[var(--border-subtle)] px-4 py-6 text-center space-y-1">
                <p className="text-sm font-medium text-[var(--text-secondary)]">
                  No other devices found
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Open xlabplayer on another phone, tablet, or browser signed into the same account.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {otherDevices.map((device) => {
                  const selected = isRemoteActive && targetDeviceId === device.deviceId;
                  const nowPlaying = device.state?.track
                    ? `${device.state.track.title} · ${device.state.track.artist}`
                    : device.online
                      ? 'Idle'
                      : 'Offline';
                  const canSendHere = device.online && Boolean(currentTrack);
                  const isBusy = busyDeviceId === device.deviceId;

                  return (
                    <div
                      key={device.deviceId}
                      className={`rounded-xl border transition-colors ${
                        selected
                          ? 'bg-[var(--accent-soft)] border-[var(--accent)]'
                          : 'bg-[var(--bg-elevated)] border-[var(--border-subtle)]'
                      } ${!device.online ? 'opacity-60' : ''}`}
                    >
                      <button
                        type="button"
                        disabled={!device.online}
                        onClick={() => {
                          selectTarget(device.deviceId);
                          onClose();
                        }}
                        className="w-full flex items-center gap-3 px-3.5 py-3 text-left disabled:cursor-not-allowed"
                      >
                        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-primary)] text-[var(--text-primary)]">
                          <PlatformIcon platform={device.platform} className="w-5 h-5" />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--bg-secondary)] ${
                              device.online ? 'bg-emerald-400' : 'bg-[var(--text-muted)]'
                            }`}
                            title={device.online ? 'Online' : 'Offline'}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                              {device.name}
                            </p>
                            {device.state?.isPlaying && device.online && (
                              <Play className="w-3 h-3 text-[var(--accent)] fill-current shrink-0" />
                            )}
                          </div>
                          <p className="text-xs text-[var(--text-secondary)] truncate">
                            {nowPlaying}
                          </p>
                        </div>
                        {selected && (
                          <Check className="w-4 h-4 text-[var(--accent)] shrink-0 stroke-[2.5]" />
                        )}
                      </button>

                      {canSendHere && (
                        <div className="px-3.5 pb-3 pt-1 flex items-center justify-end border-t border-[var(--border-subtle)]">
                          <button
                            type="button"
                            disabled={busyDeviceId !== null || isPending}
                            onClick={() => void handleSendToDevice(device)}
                            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-primary)] border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50 transition-colors"
                          >
                            {isBusy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Send className="w-3.5 h-3.5" />
                            )}
                            <span className="truncate max-w-[200px]">Send to {device.name}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
