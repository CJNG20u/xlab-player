import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  getThemeBaseColor,
  getUnifiedPageHeaderTopHex,
  isUnifiedHeaderPath,
  setDocumentThemeColor,
} from '../lib/themeColor';

export type AppTheme = 'spotify-dark' | 'apple-dark' | 'apple-light' | 'tidal-dark';

export interface ThemeOption {
  id: AppTheme;
  name: string;
  description: string;
  themeColor: string;
  isLight: boolean;
  preview: {
    bg: string;
    card: string;
    elevated: string;
    text: string;
    muted: string;
    accent: string;
    navBg: string;
    border: string;
  };
}

export const THEME_STORAGE_KEY = 'xlabplayer-theme';

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'spotify-dark',
    name: 'Spotify Dark',
    description: 'Charcoal surfaces with emerald green accents',
    themeColor: '#121212',
    isLight: false,
    preview: {
      bg: '#121212',
      card: '#181818',
      elevated: '#282828',
      text: '#FFFFFF',
      muted: '#B3B3B3',
      accent: '#1DB954',
      navBg: 'rgba(18, 18, 18, 0.94)',
      border: 'rgba(255, 255, 255, 0.1)',
    },
  },
  {
    id: 'apple-dark',
    name: 'Apple Music Dark',
    description: 'True black OLED canvas with crimson & frosted glass',
    themeColor: '#000000',
    isLight: false,
    preview: {
      bg: '#000000',
      card: '#1C1C1E',
      elevated: '#2C2C2E',
      text: '#FFFFFF',
      muted: '#98989F',
      accent: '#FA243C',
      navBg: 'rgba(28, 28, 30, 0.82)',
      border: 'rgba(255, 255, 255, 0.12)',
    },
  },
  {
    id: 'apple-light',
    name: 'Apple Music Light',
    description: 'Pure white canvas with soft gray cards & crimson accents',
    themeColor: '#FFFFFF',
    isLight: true,
    preview: {
      bg: '#FFFFFF',
      card: '#F2F2F7',
      elevated: '#E5E5EA',
      text: '#1C1C1E',
      muted: '#6E6E73',
      accent: '#FA243C',
      navBg: 'rgba(255, 255, 255, 0.88)',
      border: 'rgba(0, 0, 0, 0.08)',
    },
  },
  {
    id: 'tidal-dark',
    name: 'Tidal Dark',
    description: 'Pure black OLED canvas with electric cyan accents & hi-fi badges',
    themeColor: '#000000',
    isLight: false,
    preview: {
      bg: '#000000',
      card: '#111111',
      elevated: '#161618',
      text: '#FFFFFF',
      muted: '#9A9AA0',
      accent: '#00FFFF',
      navBg: 'rgba(10, 10, 12, 0.94)',
      border: 'rgba(255, 255, 255, 0.08)',
    },
  },
];

function isValidTheme(value: string | null): value is AppTheme {
  return (
    value === 'spotify-dark' ||
    value === 'apple-dark' ||
    value === 'apple-light' ||
    value === 'tidal-dark'
  );
}

function readStoredTheme(): AppTheme {
  if (typeof window === 'undefined') return 'spotify-dark';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isValidTheme(stored)) return stored;
  } catch {
    // ignore storage errors
  }
  return 'spotify-dark';
}

function getInitialRouteThemeColor(theme: AppTheme): string {
  if (typeof window !== 'undefined' && isUnifiedHeaderPath(window.location.pathname)) {
    return getUnifiedPageHeaderTopHex(theme);
  }
  return getThemeBaseColor(theme);
}

let themeTransitionTimer: number | null = null;

function applyThemeToDocument(theme: AppTheme, animate = false): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  if (animate) {
    if (themeTransitionTimer !== null) {
      window.clearTimeout(themeTransitionTimer);
      themeTransitionTimer = null;
    }
    root.setAttribute('data-theme-transition', '');
    void root.offsetHeight;
  }

  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', theme !== 'apple-light');

  const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColorMeta) {
    const bgPrimary = window.getComputedStyle(root).getPropertyValue('--bg-primary').trim();
    if (bgPrimary) {
      themeColorMeta.setAttribute('content', bgPrimary);
    }
  }

  const statusBarMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="apple-mobile-web-app-status-bar-style"]'
  );
  if (statusBarMeta) {
    statusBarMeta.setAttribute('content', 'black-translucent');
  }

  if (animate) {
    themeTransitionTimer = window.setTimeout(() => {
      root.removeAttribute('data-theme-transition');
      themeTransitionTimer = null;
    }, 300);
  }
}

interface ThemeContextValue {
  theme: AppTheme;
  setTheme: (next: AppTheme) => void;
  isLight: boolean;
  isAppleStyle: boolean;
  isTidal: boolean;
  baseThemeColor: string;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [theme, setThemeState] = useState<AppTheme>(() => readStoredTheme());
  const themeRef = useRef<AppTheme>(theme);
  themeRef.current = theme;
  const hasAppliedInitialRef = useRef(false);

  const setTheme = useCallback((next: AppTheme) => {
    if (themeRef.current === next) return;
    themeRef.current = next;
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
    applyThemeToDocument(next, true);
    setDocumentThemeColor(getInitialRouteThemeColor(next));
  }, []);

  useLayoutEffect(() => {
    if (!hasAppliedInitialRef.current) {
      hasAppliedInitialRef.current = true;
      applyThemeToDocument(theme, false);
      setDocumentThemeColor(getInitialRouteThemeColor(theme));
    }
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      isLight: theme === 'apple-light',
      isAppleStyle: theme === 'apple-dark' || theme === 'apple-light',
      isTidal: theme === 'tidal-dark',
      baseThemeColor: getThemeBaseColor(theme),
    }),
    [theme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
