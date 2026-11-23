import {useSyncExternalStore} from 'react';

let currentTimeSec = 0;
const listeners = new Set<() => void>();

export function getTime(): number {
  return currentTimeSec;
}

export function setTime(next: number): void {
  const normalized = Number.isFinite(next) ? Math.max(0, next) : 0;
  if (normalized === currentTimeSec) return;
  currentTimeSec = normalized;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const playbackClock = {
  getTime,
  setTime,
  subscribe,
};

export function usePlaybackTime(): number {
  return useSyncExternalStore(subscribe, getTime, getTime);
}
