// Adapted from Soundsible's tab memory / scroll history / back stack (MIT, (c) 2026 Arzuparreta)
import type {Location, NavigateFunction} from 'react-router-dom';

export type PrimaryTabRoot = '/' | '/playlists' | '/discover' | '/settings';

const tabMemory = new Map<PrimaryTabRoot, string>();

/**
 * Maps a pathname to its primary navigation tab group, or null for non-tab routes
 * such as /now-playing so they never overwrite any tab's remembered location.
 */
export function getTabGroup(pathname: string): PrimaryTabRoot | null {
  if (pathname === '/') return '/';
  if (pathname === '/playlists' || pathname.startsWith('/playlists/')) return '/playlists';
  if (pathname === '/discover' || pathname.startsWith('/discover/')) return '/discover';
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return '/settings';
  return null;
}

/**
 * Remembers the last visited location (pathname + search) for the owning tab group.
 * Session-only (in-memory Map, no storage).
 */
export function rememberTabLocation(pathname: string, search = ''): void {
  const group = getTabGroup(pathname);
  if (!group) return;
  tabMemory.set(group, `${pathname}${search}`);
}

export function getRememberedTabLocation(href: string): string {
  const group = getTabGroup(href);
  if (!group) return href;
  return tabMemory.get(group) ?? group;
}

/**
 * Smoothly scrolls the AppShell <main> container (and window fallback) to the top.
 */
export function scrollMainToTop(scrollElement?: HTMLElement | null): void {
  const target =
    scrollElement ?? (typeof document !== 'undefined' ? document.querySelector('main') : null);
  if (target) {
    target.scrollTo({top: 0, behavior: 'smooth'});
  }
  if (typeof window !== 'undefined' && window.scrollY > 0) {
    window.scrollTo({top: 0, behavior: 'smooth'});
  }
}

/**
 * Handles tapping a primary navigation destination (bottom nav or sidebar):
 * - Inactive tab: navigate to the tab's remembered location (or its root) with { state: { tabReturn: true } }.
 * - Active tab deeper than its root (e.g., /playlists/42 or /?artist=...): navigate to the tab root.
 * - Active tab already at its root: smoothly scroll <main> to the top.
 */
export function openPrimaryDestination(
  navigate: NavigateFunction,
  href: string,
  selected: boolean,
  currentLocation: Pick<Location, 'pathname' | 'search'>,
  scrollElement?: HTMLElement | null
): void {
  const currentFull = `${currentLocation.pathname}${currentLocation.search || ''}`;

  if (selected) {
    if (currentFull !== href) {
      navigate(href);
    } else {
      scrollMainToTop(scrollElement);
    }
    return;
  }

  const remembered = getRememberedTabLocation(href);
  navigate(remembered, {state: {tabReturn: true}});
}
