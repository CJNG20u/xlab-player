import {useEffect, useRef} from 'react';

export interface DesktopKeyboardShortcutsOptions {
  enabled: boolean;
  hasTrack: boolean;
  getCurrentTime: () => number;
  duration: number;
  volume: number;
  isMuted: boolean;
  onTogglePlay: () => void;
  onSeek: (positionSec: number) => void;
  onPrevTrack: () => void;
  onNextTrack: () => void;
  onSetVolume: (volume: number) => void;
  onToggleMute: () => void;
  onToggleLyrics: () => void;
  onFocusQueue: () => void;
  onToggleSidebar?: () => void;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
]);

export interface ShortcutKeyEventLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
}

function isTypingElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as Partial<HTMLElement & HTMLInputElement>;
  if (typeof HTMLElement !== 'undefined' && !(target instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  if (typeof el.closest === 'function') {
    return Boolean(
      el.closest('[contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]')
    );
  }
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

function isRangeInput(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  if (typeof HTMLInputElement !== 'undefined' && !(target instanceof HTMLInputElement)) return false;
  const el = target as Partial<HTMLInputElement>;
  return (
    typeof el.tagName === 'string' &&
    el.tagName.toUpperCase() === 'INPUT' &&
    (el.type || '').toLowerCase() === 'range'
  );
}

const SEEK_STEP_SECONDS = 5;
const VOLUME_STEP = 0.05;

export function processDesktopShortcutKeyDown(
  e: ShortcutKeyEventLike,
  options: DesktopKeyboardShortcutsOptions
): boolean {
  if (!options.enabled) return false;
  if (e.defaultPrevented) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isTypingElement(e.target)) return false;
  if (
    isRangeInput(e.target) &&
    (e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown')
  ) {
    return false;
  }

  const {
    hasTrack,
    getCurrentTime,
    duration,
    volume,
    isMuted,
    onTogglePlay,
    onSeek,
    onPrevTrack,
    onNextTrack,
    onSetVolume,
    onToggleMute,
    onToggleLyrics,
    onFocusQueue,
    onToggleSidebar,
  } = options;

  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  if (e.code === 'Space' || key === ' ') {
    if (!hasTrack) return false;
    e.preventDefault();
    onTogglePlay();
    return true;
  }

  if (key === 'ArrowLeft') {
    if (!hasTrack) return false;
    e.preventDefault();
    if (e.shiftKey) {
      onPrevTrack();
    } else {
      const nextPos = Math.max(0, getCurrentTime() - SEEK_STEP_SECONDS);
      onSeek(nextPos);
    }
    return true;
  }

  if (key === 'ArrowRight') {
    if (!hasTrack) return false;
    e.preventDefault();
    if (e.shiftKey) {
      onNextTrack();
    } else {
      const current = getCurrentTime();
      const maxPos = duration > 0 ? duration : current + SEEK_STEP_SECONDS;
      const nextPos = Math.min(maxPos, current + SEEK_STEP_SECONDS);
      onSeek(nextPos);
    }
    return true;
  }

  if (key === 'ArrowUp') {
    e.preventDefault();
    const base = isMuted ? 0 : volume;
    const nextVol = Math.min(1, Math.round((base + VOLUME_STEP) * 100) / 100);
    onSetVolume(nextVol);
    return true;
  }

  if (key === 'ArrowDown') {
    e.preventDefault();
    const base = isMuted ? 0 : volume;
    const nextVol = Math.max(0, Math.round((base - VOLUME_STEP) * 100) / 100);
    onSetVolume(nextVol);
    return true;
  }

  if (lower === 'm' && !e.shiftKey) {
    e.preventDefault();
    onToggleMute();
    return true;
  }

  if (lower === 'l' && !e.shiftKey) {
    e.preventDefault();
    onToggleLyrics();
    return true;
  }

  if (lower === 'q' && !e.shiftKey) {
    e.preventDefault();
    onFocusQueue();
    return true;
  }

  if (key === '[' && onToggleSidebar) {
    e.preventDefault();
    onToggleSidebar();
    return true;
  }

  return false;
}

export function useDesktopKeyboardShortcuts(options: DesktopKeyboardShortcutsOptions): void {
  const latestRef = useRef(options);
  latestRef.current = options;

  useEffect(() => {
    if (!options.enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      processDesktopShortcutKeyDown(e, latestRef.current);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [options.enabled]);
}
