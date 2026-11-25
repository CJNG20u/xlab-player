import React, {createContext, useCallback, useContext, useMemo, useState} from 'react';

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'xlabplayer.desktopSidebarCollapsed';

export function readStoredSidebarCollapsed(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Ignore storage quota or private-mode access errors
  }
}

interface DesktopLayoutContextValue {
  desktopLyricsVisible: boolean;
  setDesktopLyricsVisible: (visible: boolean) => void;
  toggleDesktopLyrics: () => void;
  browsePaneCollapsed: boolean;
  setBrowsePaneCollapsed: (collapsed: boolean) => void;
  toggleBrowsePane: () => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  focusQueueTick: number;
  requestFocusQueue: () => void;
}

const DesktopLayoutContext = createContext<DesktopLayoutContextValue | null>(null);

export const DesktopLayoutProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [desktopLyricsVisible, setDesktopLyricsVisible] = useState(true);
  const [browsePaneCollapsed, setBrowsePaneCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(readStoredSidebarCollapsed);
  const [focusQueueTick, setFocusQueueTick] = useState(0);

  const toggleDesktopLyrics = useCallback(() => {
    setDesktopLyricsVisible((prev) => !prev);
  }, []);

  const toggleBrowsePane = useCallback(() => {
    setBrowsePaneCollapsed((prev) => !prev);
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    writeStoredSidebarCollapsed(collapsed);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsedState((prev) => {
      const next = !prev;
      writeStoredSidebarCollapsed(next);
      return next;
    });
  }, []);

  const requestFocusQueue = useCallback(() => {
    setFocusQueueTick((n) => n + 1);
  }, []);

  const value = useMemo<DesktopLayoutContextValue>(
    () => ({
      desktopLyricsVisible,
      setDesktopLyricsVisible,
      toggleDesktopLyrics,
      browsePaneCollapsed,
      setBrowsePaneCollapsed,
      toggleBrowsePane,
      sidebarCollapsed,
      setSidebarCollapsed,
      toggleSidebar,
      focusQueueTick,
      requestFocusQueue,
    }),
    [
      browsePaneCollapsed,
      desktopLyricsVisible,
      focusQueueTick,
      requestFocusQueue,
      setSidebarCollapsed,
      sidebarCollapsed,
      toggleBrowsePane,
      toggleDesktopLyrics,
      toggleSidebar,
    ]
  );

  return <DesktopLayoutContext.Provider value={value}>{children}</DesktopLayoutContext.Provider>;
};

export function useDesktopLayout(): DesktopLayoutContextValue {
  const ctx = useContext(DesktopLayoutContext);
  if (!ctx) {
    throw new Error('useDesktopLayout must be used inside DesktopLayoutProvider');
  }
  return ctx;
}
