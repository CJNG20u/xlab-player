import {useEffect, useState} from 'react';

export type LayoutMode = 'desktop' | 'mobile';

export const DESKTOP_LAYOUT_MEDIA_QUERY =
  '(min-width: 1600px), ((min-width: 1024px) and ((hover: hover) or (any-hover: hover) or (any-pointer: fine)))';

export function getLayoutMode(): LayoutMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'mobile';
  }
  return window.matchMedia(DESKTOP_LAYOUT_MEDIA_QUERY).matches ? 'desktop' : 'mobile';
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(getLayoutMode);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mql = window.matchMedia(DESKTOP_LAYOUT_MEDIA_QUERY);
    const syncMode = () => {
      const next: LayoutMode = mql.matches ? 'desktop' : 'mobile';
      setMode((prev) => (prev === next ? prev : next));
    };

    syncMode();

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', syncMode);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(syncMode);
    }
    window.addEventListener('resize', syncMode);
    window.addEventListener('orientationchange', syncMode);

    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', syncMode);
      } else if (typeof mql.removeListener === 'function') {
        mql.removeListener(syncMode);
      }
      window.removeEventListener('resize', syncMode);
      window.removeEventListener('orientationchange', syncMode);
    };
  }, []);

  return mode;
}
