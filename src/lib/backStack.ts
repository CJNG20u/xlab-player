// Adapted from Soundsible's tab memory / scroll history / back stack (MIT, (c) 2026 Arzuparreta)
import {useEffect, useRef} from 'react';

interface BackStackEntry {
  id: string;
  onClose: () => void;
}

const backStack: BackStackEntry[] = [];
const pendingRemovals = new Set<string>();
let nextOverlaySeq = 0;
let expectedUiBackPops = 0;
let listenersAttached = false;

function getCurrentOverlayId(): string | null {
  if (typeof window === 'undefined') return null;
  const state = window.history.state;
  if (state && typeof state === 'object' && 'overlay' in state) {
    const val = (state as {overlay?: unknown}).overlay;
    return typeof val === 'string' ? val : null;
  }
  return null;
}

function pushOverlayHistoryEntry(id: string): void {
  if (typeof window === 'undefined') return;
  if (getCurrentOverlayId() === id) return;
  const currentState =
    window.history.state && typeof window.history.state === 'object'
      ? (window.history.state as Record<string, unknown>)
      : {};
  window.history.pushState({...currentState, overlay: id}, '', window.location.href);
}

function handlePopState(): void {
  if (expectedUiBackPops > 0) {
    expectedUiBackPops -= 1;
    return;
  }

  if (backStack.length === 0) return;

  const top = backStack[backStack.length - 1];
  // If history state still points to this exact overlay entry, nothing to pop
  if (getCurrentOverlayId() === top.id) return;

  backStack.pop();
  pendingRemovals.delete(top.id);
  top.onClose();
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  if (backStack.length === 0) return;
  const top = backStack[backStack.length - 1];
  top.onClose();
}

function ensureGlobalListeners(): void {
  if (listenersAttached || typeof window === 'undefined') return;
  listenersAttached = true;
  window.addEventListener('popstate', handlePopState);
  window.addEventListener('keydown', handleKeyDown);
}

function removeEntryFromStack(id: string): boolean {
  const idx = backStack.findIndex((entry) => entry.id === id);
  if (idx === -1) return false;
  backStack.splice(idx, 1);
  return true;
}

/**
 * Registers an open overlay (drawer or modal) on the global back stack so that
 * browser/Android PWA back closes the topmost overlay first before navigating.
 *
 * Safe under React StrictMode double effects via id deduplication and
 * microtask-deferred cleanup.
 */
export function useBackClose(open: boolean, onClose: () => void): void {
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    idRef.current = `xlab-overlay-${++nextOverlaySeq}`;
  }

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    ensureGlobalListeners();

    const id = idRef.current!;
    // Cancel any StrictMode-triggered pending removal for this id
    pendingRemovals.delete(id);

    const existing = backStack.find((entry) => entry.id === id);
    if (existing) {
      existing.onClose = () => onCloseRef.current();
    } else {
      pushOverlayHistoryEntry(id);
      backStack.push({
        id,
        onClose: () => onCloseRef.current(),
      });
    }

    return () => {
      pendingRemovals.add(id);
      queueMicrotask(() => {
        // Re-opened synchronously (e.g., React StrictMode double effect): keep stack & history intact
        if (!pendingRemovals.has(id)) return;
        pendingRemovals.delete(id);

        const wasOnStack = removeEntryFromStack(id);
        if (wasOnStack && getCurrentOverlayId() === id) {
          expectedUiBackPops += 1;
          window.history.back();
        }
      });
    };
  }, [open]);
}
