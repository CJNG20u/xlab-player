import React, {createContext, useCallback, useContext, useMemo, useState} from 'react';

interface DesktopLayoutContextValue {
  desktopLyricsVisible: boolean;
  setDesktopLyricsVisible: (visible: boolean) => void;
  toggleDesktopLyrics: () => void;
  browsePaneCollapsed: boolean;
  setBrowsePaneCollapsed: (collapsed: boolean) => void;
  toggleBrowsePane: () => void;
  focusQueueTick: number;
  requestFocusQueue: () => void;
}

const DesktopLayoutContext = createContext<DesktopLayoutContextValue | null>(null);

export const DesktopLayoutProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [desktopLyricsVisible, setDesktopLyricsVisible] = useState(true);
  const [browsePaneCollapsed, setBrowsePaneCollapsed] = useState(false);
  const [focusQueueTick, setFocusQueueTick] = useState(0);

  const toggleDesktopLyrics = useCallback(() => {
    setDesktopLyricsVisible((prev) => !prev);
  }, []);

  const toggleBrowsePane = useCallback(() => {
    setBrowsePaneCollapsed((prev) => !prev);
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
      focusQueueTick,
      requestFocusQueue,
    }),
    [
      browsePaneCollapsed,
      desktopLyricsVisible,
      focusQueueTick,
      requestFocusQueue,
      toggleBrowsePane,
      toggleDesktopLyrics,
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
