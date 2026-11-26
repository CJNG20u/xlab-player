import {useId, useLayoutEffect, useRef} from 'react';

export const DEFAULT_APP_THEME_COLOR = '#121212';
export const THEME_BASE_COLORS = {
  'spotify-dark': '#121212',
  'apple-dark': '#000000',
  'apple-light': '#FFFFFF',
  'tidal-dark': '#000000',
} as const;

// Unified topmost hex at y=0 for Playlist Detail, Discover, and Settings headers so
// `<meta name="theme-color">`, `html/body` background, and the CSS top gradient
// match pixel-for-pixel behind `env(safe-area-inset-top)` with zero seam.
export const THEME_HEADER_TOP_COLORS = {
  'spotify-dark': '#1c2520',
  'apple-dark': '#141214',
  'apple-light': '#f3f3f7',
  'tidal-dark': '#000000',
} as const;

export function getThemeBaseColor(
  theme: 'spotify-dark' | 'apple-dark' | 'apple-light' | 'tidal-dark' | string | null | undefined
): string {
  if (theme === 'apple-dark') return THEME_BASE_COLORS['apple-dark'];
  if (theme === 'apple-light') return THEME_BASE_COLORS['apple-light'];
  if (theme === 'tidal-dark') return THEME_BASE_COLORS['tidal-dark'];
  return THEME_BASE_COLORS['spotify-dark'];
}

export function getMobileTabBarColor(
  theme: 'spotify-dark' | 'apple-dark' | 'apple-light' | 'tidal-dark' | string | null | undefined
): string {
  return theme === 'apple-light' ? '#ffffff' : '#000000';
}

export function getUnifiedPageHeaderTopHex(
  theme: 'spotify-dark' | 'apple-dark' | 'apple-light' | 'tidal-dark' | string | null | undefined
): string {
  if (theme === 'apple-dark') return THEME_HEADER_TOP_COLORS['apple-dark'];
  if (theme === 'apple-light') return THEME_HEADER_TOP_COLORS['apple-light'];
  if (theme === 'tidal-dark') return THEME_HEADER_TOP_COLORS['tidal-dark'];
  return THEME_HEADER_TOP_COLORS['spotify-dark'];
}

export function getUnifiedPageHeaderGradient(
  theme: 'spotify-dark' | 'apple-dark' | 'apple-light' | 'tidal-dark' | string | null | undefined
): string {
  const topHex = getUnifiedPageHeaderTopHex(theme);
  const baseHex = getThemeBaseColor(theme);
  return `linear-gradient(180deg, ${topHex} 0%, ${baseHex} 240px, ${baseHex} 100%)`;
}

export function isUnifiedHeaderPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/library' ||
    pathname === '/library/artists' ||
    pathname === '/library/albums' ||
    pathname.startsWith('/playlists/') ||
    pathname === '/settings'
  );
}

export function getActiveDocumentBaseThemeColor(): string {
  if (typeof document === 'undefined') return DEFAULT_APP_THEME_COLOR;
  return getThemeBaseColor(document.documentElement.getAttribute('data-theme'));
}

const DEFAULT_NOW_PLAYING_ACCENT = '#1f3a2e';
const COLOR_SAMPLE_SIZE = 32;

// In-memory memoization cache keyed by albumId / cover key and trackId
// so repeated plays never re-run offscreen canvas pixel loops.
const dominantColorCache = new Map<string, string>();
const inFlightColorExtractions = new Map<string, Promise<string>>();

let sharedOffscreenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let sharedOffscreenCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

function getOffscreenSampleContext():
  | OffscreenCanvasRenderingContext2D
  | CanvasRenderingContext2D
  | null {
  if (sharedOffscreenCtx) return sharedOffscreenCtx;

  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      if (ctx) {
        sharedOffscreenCanvas = canvas;
        sharedOffscreenCtx = ctx;
        return ctx;
      }
    } catch {
      // Fall through to HTMLCanvasElement
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = COLOR_SAMPLE_SIZE;
    canvas.height = COLOR_SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (ctx) {
      sharedOffscreenCanvas = canvas;
      sharedOffscreenCtx = ctx;
      return ctx;
    }
  }

  return null;
}

/**
 * Normalizes a 3- or 6-digit hex color string into lowercase `#rrggbb`.
 * Returns the fallback if the input is invalid.
 */
export function normalizeHexColor(
  input: string | null | undefined,
  fallback = DEFAULT_APP_THEME_COLOR
): string {
  if (!input) return fallback;
  const trimmed = input.trim();
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const fullMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (fullMatch) {
    return `#${fullMatch[1]}`.toLowerCase();
  }
  return fallback;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/**
 * Computes a stable album-level cache key for memoizing extracted artwork colors.
 */
export function getAlbumColorCacheKey(track: {
  id: number | string;
  album?: string | null;
  artist?: string | null;
  cover_file?: string | null;
  coverUrl?: string | null;
}): string {
  if (track.cover_file) {
    return `cover:${track.cover_file}`;
  }
  if (track.coverUrl) {
    return `ext-cover:${track.coverUrl}`;
  }
  const album = (track.album || '').trim().toLowerCase();
  const artist = (track.artist || '').trim().toLowerCase();
  if (album) {
    return `album:${artist}::${album}`;
  }
  return `track:${track.id}`;
}

/**
 * Synchronously looks up a previously sampled dominant hex color from memory.
 */
export function getCachedDominantColor(
  albumKey: string | null | undefined,
  trackId?: number | string | null
): string | null {
  if (albumKey) {
    const byAlbum = dominantColorCache.get(albumKey);
    if (byAlbum) return byAlbum;
  }
  if (trackId !== null && trackId !== undefined) {
    const byTrack = dominantColorCache.get(`track:${trackId}`);
    if (byTrack) return byTrack;
  }
  return null;
}

function storeCachedDominantColor(
  hexColor: string,
  albumKey: string | null | undefined,
  trackId?: number | string | null
): void {
  if (albumKey) {
    dominantColorCache.set(albumKey, hexColor);
  }
  if (trackId !== null && trackId !== undefined) {
    dominantColorCache.set(`track:${trackId}`, hexColor);
  }
}

function sampleDominantHexFromImageElement(
  img: HTMLImageElement,
  fallbackHex: string
): string {
  const ctx = getOffscreenSampleContext();
  if (!ctx || !sharedOffscreenCanvas) return fallbackHex;

  try {
    ctx.clearRect(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
    ctx.drawImage(img, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
    const {data} = ctx.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);

    let weightedR = 0;
    let weightedG = 0;
    let weightedB = 0;
    let totalWeight = 0;

    let fallbackR = 0;
    let fallbackG = 0;
    let fallbackB = 0;
    let opaqueCount = 0;

    // 32x32 = 1,024 pixels total — single-pass weighted vibrant average
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      fallbackR += r;
      fallbackG += g;
      fallbackB += b;
      opaqueCount++;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = (max + min) / 510; // 0..1
      if (lum < 0.07 || lum > 0.92) continue;

      const sat = max === 0 ? 0 : (max - min) / max;
      const midToneBoost = 1 - Math.abs(lum - 0.45);
      const weight = (0.2 + sat * 2.4) * Math.max(0.25, midToneBoost);

      weightedR += r * weight;
      weightedG += g * weight;
      weightedB += b * weight;
      totalWeight += weight;
    }

    let finalR: number;
    let finalG: number;
    let finalB: number;

    if (totalWeight > 0) {
      finalR = weightedR / totalWeight;
      finalG = weightedG / totalWeight;
      finalB = weightedB / totalWeight;
    } else if (opaqueCount > 0) {
      finalR = fallbackR / opaqueCount;
      finalG = fallbackG / opaqueCount;
      finalB = fallbackB / opaqueCount;
    } else {
      return fallbackHex;
    }

    // Cap excessive luminance so white status bar icons & typography stay legible
    const luminance = (0.299 * finalR + 0.587 * finalG + 0.114 * finalB) / 255;
    if (luminance > 0.62) {
      const scale = 0.62 / luminance;
      finalR *= scale;
      finalG *= scale;
      finalB *= scale;
    }

    return rgbToHex(finalR, finalG, finalB);
  } catch {
    return fallbackHex;
  }
}

/**
 * Extracts the dominant color from album artwork using a reusable 32x32 offscreen canvas
 * and memoizes the resulting hex color in memory by albumId/cover key and trackId.
 */
export function extractDominantColorFromImage(
  imageUrl: string | null | undefined,
  albumKey: string,
  trackId?: number | string | null,
  fallbackColor?: string | null
): Promise<string> {
  const fallbackHex = normalizeHexColor(fallbackColor, DEFAULT_NOW_PLAYING_ACCENT);

  const cached = getCachedDominantColor(albumKey, trackId);
  if (cached) {
    storeCachedDominantColor(cached, albumKey, trackId);
    return Promise.resolve(cached);
  }

  if (!imageUrl || typeof Image === 'undefined') {
    storeCachedDominantColor(fallbackHex, albumKey, trackId);
    return Promise.resolve(fallbackHex);
  }

  const existingPromise = inFlightColorExtractions.get(albumKey);
  if (existingPromise) {
    return existingPromise.then((hex) => {
      storeCachedDominantColor(hex, albumKey, trackId);
      return hex;
    });
  }

  const extraction = new Promise<string>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';

    img.onload = () => {
      const hex = sampleDominantHexFromImageElement(img, fallbackHex);
      storeCachedDominantColor(hex, albumKey, trackId);
      resolve(hex);
    };

    img.onerror = () => {
      storeCachedDominantColor(fallbackHex, albumKey, trackId);
      resolve(fallbackHex);
    };

    img.src = imageUrl;
  }).finally(() => {
    inFlightColorExtractions.delete(albumKey);
  });

  inFlightColorExtractions.set(albumKey, extraction);
  return extraction;
}

/**
 * Computes the exact darkened top gradient hex color used at the top edge of
 * dark-mode Now Playing / Home views so the mobile status bar blends seamlessly
 * while keeping white status bar clock/battery icons legible.
 */
export function computeNowPlayingTopHex(dominantColor: string | null | undefined): string {
  const hex = normalizeHexColor(dominantColor, DEFAULT_NOW_PLAYING_ACCENT);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  // Apply the same subtle 18% darkening tint to match the top of the Now Playing gradient
  const factor = 0.82;
  return rgbToHex(r * factor, g * factor, b * factor);
}

/**
 * Computes a soft, airy pastel tint from the dominant album color for Apple Music Light
 * headers and Now Playing backdrops so dark text and status bar icons remain highly legible.
 */
export function computeLightTintedTopHex(
  dominantColor: string | null | undefined,
  tintStrength = 0.24
): string {
  const hex = normalizeHexColor(dominantColor, '#fa243c');
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const clamped = Math.max(0.08, Math.min(0.4, tintStrength));
  const mix = (channel: number) => 255 * (1 - clamped) + channel * clamped;
  return rgbToHex(mix(r), mix(g), mix(b));
}

/**
 * Dynamically updates `<meta name="theme-color">` to match the active mobile tab bar color
 * (#000000 on dark themes, #ffffff on apple-light) and keeps html/body background aligned
 * with the active theme base color.
 */
export function setDocumentThemeColor(hexColor: string, rootBgColor?: string): void {
  if (typeof document === 'undefined') return;
  const baseBg = normalizeHexColor(
    rootBgColor ?? getActiveDocumentBaseThemeColor(),
    getActiveDocumentBaseThemeColor()
  );
  const normalizedMeta = normalizeHexColor(hexColor, '#000000');

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', normalizedMeta);
  document.documentElement.style.backgroundColor = baseBg;
  if (document.body) {
    document.body.style.backgroundColor = baseBg;
  }
}

interface StatusBarClaim {
  id: string;
  hex: string;
}

const statusBarClaims: StatusBarClaim[] = [];

/**
 * Returns the active theme's tab bar color for `<meta name="theme-color">`.
 */
export function getWinningStatusBarColor(theme?: string | null): string {
  const activeTheme =
    theme !== undefined
      ? theme
      : typeof document !== 'undefined'
        ? document.documentElement.getAttribute('data-theme')
        : null;
  return getMobileTabBarColor(activeTheme);
}

/**
 * Re-applies `<meta name="theme-color">` (tab bar color) and root base background color.
 * Call after `data-theme` changes so Android navigation bar and root colors update immediately.
 */
export function syncStatusBarColor(theme?: string | null): void {
  const activeTheme =
    theme !== undefined
      ? theme
      : typeof document !== 'undefined'
        ? document.documentElement.getAttribute('data-theme')
        : null;
  setDocumentThemeColor(getMobileTabBarColor(activeTheme), getThemeBaseColor(activeTheme));
}

/**
 * Registers or updates a status-bar color claim in the module-level stack and returns
 * a release function. Updating an existing claim preserves its stack position so a
 * parent update (e.g. theme switch) never overrides a more-recently mounted child claim.
 */
export function claimStatusBarColor(id: string, hex: string): () => void {
  const normalized = normalizeHexColor(hex, getActiveDocumentBaseThemeColor());
  const existingIdx = statusBarClaims.findIndex((claim) => claim.id === id);
  if (existingIdx >= 0) {
    statusBarClaims[existingIdx].hex = normalized;
  } else {
    statusBarClaims.push({id, hex: normalized});
  }
  syncStatusBarColor();

  return () => {
    const idx = statusBarClaims.findIndex((claim) => claim.id === id);
    if (idx >= 0) {
      statusBarClaims.splice(idx, 1);
      syncStatusBarColor();
    }
  };
}

/**
 * React hook that claims the mobile status-bar color in a layout effect,
 * updates the claim in-place when `hex` changes, and releases it on cleanup
 * or when `enabled` becomes false. Safe under StrictMode double effects.
 */
export function useStatusBarColor(hex: string | null, enabled = true): void {
  const id = useId();
  const releaseRef = useRef<(() => void) | null>(null);
  const hexRef = useRef<string | null>(hex);
  hexRef.current = hex;

  useLayoutEffect(() => {
    if (!enabled) {
      releaseRef.current?.();
      releaseRef.current = null;
      return;
    }
    if (hexRef.current) {
      releaseRef.current = claimStatusBarColor(id, hexRef.current);
    }
    return () => {
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [id, enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (hex) {
      releaseRef.current = claimStatusBarColor(id, hex);
    } else {
      releaseRef.current?.();
      releaseRef.current = null;
    }
  }, [id, hex, enabled]);
}
