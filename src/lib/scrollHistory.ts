import {useEffect, useLayoutEffect, useRef} from 'react';
import {useLocation, useNavigationType} from 'react-router-dom';
import {useMainScroll} from '../context/MainScrollContext';

const STORAGE_KEY = 'xlabplayer-scroll-history-v1';
const MAX_ENTRIES = 200;
const SCROLL_SAVE_THROTTLE_MS = 100;
const RESTORE_RETRY_TIMEOUT_MS = 1000;

interface PersistedScrollData {
  byKey: Array<[string, number]>;
  byPath: Array<[string, number]>;
}

interface PendingRestore {
  locationKey: string;
  targetTop: number;
}

const byKey = new Map<string, number>();
const byPath = new Map<string, number>();

let pendingRestore: PendingRestore | null = null;
let hydrated = false;

function disableBrowserScrollRestoration(): void {
  if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
    try {
      window.history.scrollRestoration = 'manual';
    } catch {
      // ignore read-only environments
    }
  }
}

function hydrateFromSessionStorage(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  disableBrowserScrollRestoration();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PersistedScrollData>;
    if (Array.isArray(parsed.byKey)) {
      for (const [k, v] of parsed.byKey) {
        if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          byKey.set(k, v);
        }
      }
    }
    if (Array.isArray(parsed.byPath)) {
      for (const [k, v] of parsed.byPath) {
        if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          byPath.set(k, v);
        }
      }
    }
  } catch {
    // ignore storage errors
  }
}

function persistToSessionStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedScrollData = {
      byKey: Array.from(byKey.entries()).slice(-MAX_ENTRIES),
      byPath: Array.from(byPath.entries()).slice(-MAX_ENTRIES),
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage errors
  }
}

function setBounded(map: Map<string, number>, key: string, value: number): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function getFullPath(pathname: string, search: string): string {
  return `${pathname}${search || ''}`;
}

export function saveScrollPosition(
  locationKey: string,
  pathname: string,
  search: string,
  scrollTop: number
): void {
  hydrateFromSessionStorage();
  const clamped = Math.max(0, Math.round(scrollTop));
  if (locationKey) {
    setBounded(byKey, locationKey, clamped);
  }
  const fullPath = getFullPath(pathname, search);
  setBounded(byPath, fullPath, clamped);
  persistToSessionStorage();
}

export function getSavedScrollByKey(locationKey: string): number | undefined {
  hydrateFromSessionStorage();
  return byKey.get(locationKey);
}

export function getSavedScrollByPath(pathname: string, search = ''): number | undefined {
  hydrateFromSessionStorage();
  const fullPath = getFullPath(pathname, search);
  const exact = byPath.get(fullPath);
  if (exact !== undefined) return exact;
  return byPath.get(pathname);
}

function isTabReturnState(state: unknown): boolean {
  return Boolean(
    state &&
      typeof state === 'object' &&
      'tabReturn' in state &&
      (state as {tabReturn?: unknown}).tabReturn === true
  );
}

// Initialize immediately on module load in browser
hydrateFromSessionStorage();

/**
 * Mounted once inside AppShell (within MainScrollProvider).
 * Tracks <main>.scrollTop via a throttled scroll listener and location transitions,
 * and prepares pending scroll restoration targets for POP and tab-return navigations.
 */
export function useMainScrollRestoration(): void {
  const {element: mainElement, getElement: getMainElement} = useMainScroll();
  const location = useLocation();
  const navigationType = useNavigationType();

  const activeRouteRef = useRef<{key: string; pathname: string; search: string} | null>(null);

  // Throttled scroll listener + pagehide persistence
  useEffect(() => {
    if (!mainElement) return;
    disableBrowserScrollRestoration();

    let throttleTimer: number | null = null;
    let lastSavedAt = 0;

    const recordCurrentScroll = () => {
      const active = activeRouteRef.current;
      if (!active) return;
      // Do not overwrite a pending restore target before the page finishes restoring
      if (pendingRestore && pendingRestore.locationKey === active.key) return;
      saveScrollPosition(active.key, active.pathname, active.search, mainElement.scrollTop);
      lastSavedAt = Date.now();
    };

    const handleScroll = () => {
      const now = Date.now();
      const elapsed = now - lastSavedAt;
      if (elapsed >= SCROLL_SAVE_THROTTLE_MS) {
        if (throttleTimer !== null) {
          window.clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        recordCurrentScroll();
      } else if (throttleTimer === null) {
        throttleTimer = window.setTimeout(() => {
          throttleTimer = null;
          recordCurrentScroll();
        }, SCROLL_SAVE_THROTTLE_MS - elapsed);
      }
    };

    const handlePageHide = () => {
      recordCurrentScroll();
    };

    mainElement.addEventListener('scroll', handleScroll, {passive: true});
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      if (throttleTimer !== null) {
        window.clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      mainElement.removeEventListener('scroll', handleScroll);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [mainElement]);

  // Save outgoing route's scroll position and compute incoming restoration target
  useLayoutEffect(() => {
    hydrateFromSessionStorage();
    const el = getMainElement();
    const prev = activeRouteRef.current;

    // Ignore redundant effects when route identity has not changed (e.g., overlay back-stack pop)
    if (
      prev &&
      prev.key === location.key &&
      prev.pathname === location.pathname &&
      prev.search === location.search
    ) {
      return;
    }

    if (prev && el && (!pendingRestore || pendingRestore.locationKey !== prev.key)) {
      saveScrollPosition(prev.key, prev.pathname, prev.search, el.scrollTop);
    }

    activeRouteRef.current = {
      key: location.key,
      pathname: location.pathname,
      search: location.search,
    };

    const tabReturn = isTabReturnState(location.state);
    let targetTop: number | undefined;

    if (navigationType === 'POP') {
      targetTop = getSavedScrollByKey(location.key);
    } else if (tabReturn) {
      targetTop = getSavedScrollByPath(location.pathname, location.search);
    } else {
      targetTop = 0;
    }

    if (targetTop !== undefined && targetTop > 0) {
      pendingRestore = {
        locationKey: location.key,
        targetTop,
      };
    } else {
      pendingRestore = null;
      if (el) {
        el.scrollTop = 0;
      }
    }
  }, [getMainElement, location.key, location.pathname, location.search, location.state, navigationType]);
}

/**
 * Called by pages with their data-loaded flag (`ready`).
 * Once `ready` is true and a scroll restoration is pending for the current location,
 * restores `<main>.scrollTop` in a layout effect, retrying up to ~1s via rAF if the
 * rendered content height (including virtualized lists) is still too short.
 */
export function useScrollReady(ready: boolean): void {
  const {element: mainElement, getElement: getMainElement} = useMainScroll();
  const location = useLocation();

  useLayoutEffect(() => {
    if (!ready) return;
    const el = mainElement ?? getMainElement();
    if (!el) return;

    const pending = pendingRestore;
    if (!pending || pending.locationKey !== location.key) return;

    const targetTop = pending.targetTop;
    const startedAt = performance.now();
    let rafId: number | null = null;
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pendingRestore && pendingRestore.locationKey === location.key) {
        pendingRestore = null;
      }
    };

    const handleUserInput = () => {
      cancel();
    };

    el.addEventListener('wheel', handleUserInput, {passive: true, once: true});
    el.addEventListener('touchstart', handleUserInput, {passive: true, once: true});
    el.addEventListener('pointerdown', handleUserInput, {passive: true, once: true});

    const cleanupListeners = () => {
      el.removeEventListener('wheel', handleUserInput);
      el.removeEventListener('touchstart', handleUserInput);
      el.removeEventListener('pointerdown', handleUserInput);
    };

    const attemptRestore = () => {
      if (cancelled) {
        cleanupListeners();
        return;
      }
      if (!pendingRestore || pendingRestore.locationKey !== location.key) {
        cleanupListeners();
        return;
      }

      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScrollTop >= targetTop) {
        el.scrollTop = targetTop;
        pendingRestore = null;
        cleanupListeners();
        return;
      }

      // Apply best-effort position so far while content/virtualizer finishes sizing
      if (maxScrollTop > 0 && el.scrollTop < maxScrollTop) {
        el.scrollTop = maxScrollTop;
      }

      if (performance.now() - startedAt >= RESTORE_RETRY_TIMEOUT_MS) {
        pendingRestore = null;
        cleanupListeners();
        return;
      }

      rafId = window.requestAnimationFrame(attemptRestore);
    };

    attemptRestore();

    return () => {
      cancelled = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      cleanupListeners();
    };
  }, [ready, mainElement, getMainElement, location.key]);
}
