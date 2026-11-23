import {
  getCoverUrl,
  getStoredToken,
  getTrackCoverUrl,
  getYouTubeThumbProxyUrl,
  getYouTubeVideoId,
} from './api';
import type {Track} from '../types';
import {getOfflineCoverBlobUrl} from '../utils/offlineStore';

const MAX_ARTWORK_CACHE_ENTRIES = 60;
const CANVAS_SIZE_LARGE = 512;
const CANVAS_SIZE_SMALL = 256;
const CANVAS_JPEG_QUALITY = 0.9;

type TrackWithExtraArtworkFields = Track & {
  thumbnail?: string | null;
  albumCover?: string | null;
  thumbnail_url?: string | null;
};

// In-memory LRU cache of resolved 512x512 & 256x256 JPEG data-URI artwork entries
const resolvedCanvasArtworkCache = new Map<string, MediaImage[]>();
const inFlightArtworkResolutions = new Map<string, Promise<MediaImage[] | null>>();

function setCachedArtwork(key: string, artwork: MediaImage[]): void {
  if (resolvedCanvasArtworkCache.has(key)) {
    resolvedCanvasArtworkCache.delete(key);
  }
  resolvedCanvasArtworkCache.set(key, artwork);
  if (resolvedCanvasArtworkCache.size > MAX_ARTWORK_CACHE_ENTRIES) {
    const oldestKey = resolvedCanvasArtworkCache.keys().next().value;
    if (oldestKey) {
      resolvedCanvasArtworkCache.delete(oldestKey);
    }
  }
}

function getOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'https://localhost';
}

function isLocalApiPath(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr, getOrigin());
    return parsed.origin === getOrigin() && parsed.pathname.startsWith('/api/');
  } catch {
    return urlStr.startsWith('/api/');
  }
}

function toAbsoluteUrl(urlStr: string, includeAuthToken: boolean): string | null {
  const trimmed = urlStr.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed, getOrigin());
    if (includeAuthToken && parsed.origin === getOrigin() && parsed.pathname.startsWith('/api/')) {
      const token = getStoredToken();
      if (token && !parsed.searchParams.has('token')) {
        parsed.searchParams.set('token', token);
      }
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function inferImageMimeType(urlStr: string): string {
  if (urlStr.startsWith('data:')) {
    const match = /^data:([^;,]+)/i.exec(urlStr);
    if (match?.[1]) return match[1].toLowerCase();
  }
  const cleanPath = urlStr.split(/[?#]/)[0].toLowerCase();
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function extractRawArtworkCandidates(track: Track): {
  coverFile: string | null;
  directHttpsUrls: string[];
  localApiUrls: string[];
  dataOrBlobUrls: string[];
  youtubeVideoId: string | null;
} {
  const ext = track as TrackWithExtraArtworkFields;
  const coverFile = track.cover_file ? track.cover_file.trim() : null;
  const youtubeVideoId = getYouTubeVideoId(track);

  const rawUrls: string[] = [];
  const primary = getTrackCoverUrl(track);
  if (primary) rawUrls.push(primary);
  if (ext.coverUrl) rawUrls.push(ext.coverUrl);
  if (ext.thumbnail) rawUrls.push(ext.thumbnail);
  if (ext.albumCover) rawUrls.push(ext.albumCover);
  if (ext.thumbnail_url) rawUrls.push(ext.thumbnail_url);
  if (coverFile) {
    const fileUrl = getCoverUrl(coverFile);
    if (fileUrl) rawUrls.push(fileUrl);
  }

  const directHttpsUrls: string[] = [];
  const localApiUrls: string[] = [];
  const dataOrBlobUrls: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawUrls) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        dataOrBlobUrls.push(trimmed);
      }
      continue;
    }

    if (isLocalApiPath(trimmed)) {
      const absWithToken = toAbsoluteUrl(trimmed, true);
      if (absWithToken && !seen.has(absWithToken)) {
        seen.add(absWithToken);
        localApiUrls.push(absWithToken);
      }
      continue;
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const abs = toAbsoluteUrl(trimmed, false);
      if (abs && !seen.has(abs)) {
        seen.add(abs);
        directHttpsUrls.push(abs);
      }
      continue;
    }

    // Relative non-API path
    const abs = toAbsoluteUrl(trimmed, false);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      directHttpsUrls.push(abs);
    }
  }

  // Ensure YouTube streams always have direct high-res public HTTPS i.ytimg.com fallbacks
  // (plus the CORS-safe same-origin /api/yt-thumb proxy for canvas baking)
  if (youtubeVideoId) {
    const ytPublicHigh = `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`;
    const ytPublicMax = `https://i.ytimg.com/vi/${youtubeVideoId}/maxresdefault.jpg`;
    if (!seen.has(ytPublicMax)) {
      seen.add(ytPublicMax);
      directHttpsUrls.push(ytPublicMax);
    }
    if (!seen.has(ytPublicHigh)) {
      seen.add(ytPublicHigh);
      directHttpsUrls.push(ytPublicHigh);
    }
    const ytProxy = toAbsoluteUrl(getYouTubeThumbProxyUrl(youtubeVideoId), true);
    if (ytProxy && !seen.has(ytProxy)) {
      seen.add(ytProxy);
      localApiUrls.push(ytProxy);
    }
  }

  return {coverFile, directHttpsUrls, localApiUrls, dataOrBlobUrls, youtubeVideoId};
}

export function getTrackArtworkCacheKey(track: Track): string {
  const ext = track as TrackWithExtraArtworkFields;
  return [
    track.id,
    track.cover_file || '',
    ext.coverUrl || '',
    ext.thumbnail || '',
    ext.albumCover || '',
    ext.thumbnail_url || '',
  ].join('|');
}

export function trackHasRealArtwork(track: Track): boolean {
  const c = extractRawArtworkCandidates(track);
  return Boolean(
    c.coverFile ||
      c.directHttpsUrls.length > 0 ||
      c.localApiUrls.length > 0 ||
      c.dataOrBlobUrls.length > 0 ||
      c.youtubeVideoId
  );
}

export function getDefaultAppIconArtwork(): MediaImage[] {
  const origin = getOrigin();
  return [
    {src: new URL('/icon-512.png', origin).href, sizes: '512x512', type: 'image/png'},
    {src: new URL('/icon-192.png', origin).href, sizes: '192x192', type: 'image/png'},
  ];
}

export function getCachedCanvasArtwork(track: Track): MediaImage[] | null {
  return resolvedCanvasArtworkCache.get(getTrackArtworkCacheKey(track)) ?? null;
}

/**
 * Returns the best synchronous `MediaImage[]` immediately available for a track:
 * 1. Previously rendered 512x512 & 256x256 JPEG canvas data URIs (offline/mTLS-proof)
 * 2. Public HTTPS artwork URL (Deezer cover_xl/cover_big or i.ytimg.com) or
 *    full absolute local API URL with auth token (`window.location.origin + /api/covers/...?token=...`)
 * 3. Default app icon ONLY when the track truly has no artwork metadata at all.
 */
export function getImmediateTrackMediaArtwork(track: Track): MediaImage[] {
  const cached = getCachedCanvasArtwork(track);
  if (cached && cached.length > 0) {
    return cached;
  }

  const {directHttpsUrls, localApiUrls, dataOrBlobUrls} = extractRawArtworkCandidates(track);

  // Build ordered unique URL candidates:
  // - Embedded data URIs first (if already data:)
  // - For Discover / YouTube tracks: public HTTPS artwork URLs directly (cover_xl / cover_big / i.ytimg.com)
  // - For local library tracks: full absolute authenticated `/api/covers/...` URL
  const preferredUrl =
    dataOrBlobUrls.find((u) => u.startsWith('data:')) ||
    (track.isYouTubeStream ? directHttpsUrls[0] || localApiUrls[0] : localApiUrls[0] || directHttpsUrls[0]) ||
    dataOrBlobUrls[0];

  if (preferredUrl) {
    const mimeType = inferImageMimeType(preferredUrl);
    const entries: MediaImage[] = [
      {src: preferredUrl, sizes: '512x512', type: mimeType},
      {src: preferredUrl, sizes: '256x256', type: mimeType},
    ];

    // If a Discover/YouTube track had a secondary public HTTPS fallback (e.g. hqdefault behind maxresdefault),
    // include it as an additional entry so Android has a fallback without reverting to the app logo.
    const secondaryPublic = directHttpsUrls.find((u) => u !== preferredUrl);
    if (secondaryPublic) {
      entries.push({
        src: secondaryPublic,
        sizes: '512x512',
        type: inferImageMimeType(secondaryPublic),
      });
    }

    return entries;
  }

  return getDefaultAppIconArtwork();
}

function loadImageElement(src: string, useAnonymousCors: boolean): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };

    const timer = window.setTimeout(() => finish(null), 6000);
    if (useAnonymousCors) {
      img.crossOrigin = 'anonymous';
    }
    img.decoding = 'async';
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        finish(img);
      } else {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = src;
  });
}

function renderImageToSquareJpegDataUrl(img: HTMLImageElement, targetSize: number): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    if (srcW <= 0 || srcH <= 0) return null;

    // Center-crop ("object-fit: cover") so 16:9 YouTube thumbnails become crisp square album art
    const side = Math.min(srcW, srcH);
    const sx = Math.floor((srcW - side) / 2);
    const sy = Math.floor((srcH - side) / 2);

    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, targetSize, targetSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);

    const dataUrl = canvas.toDataURL('image/jpeg', CANVAS_JPEG_QUALITY);
    if (!dataUrl || !dataUrl.startsWith('data:image/jpeg')) return null;
    return dataUrl;
  } catch {
    // Tainted canvas (missing CORS headers) or unsupported canvas environment
    return null;
  }
}

async function fetchLocalApiImageAsBlobUrl(url: string): Promise<string | null> {
  try {
    const headers = new Headers();
    const token = getStoredToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size === 0) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

async function renderSourceToCanvasArtwork(
  src: string,
  options: {isLocalApi?: boolean; isBlobOrData?: boolean}
): Promise<MediaImage[] | null> {
  let tempBlobUrl: string | null = null;
  try {
    let loadUrl = src;
    let useCors = !options.isBlobOrData;

    if (options.isLocalApi) {
      tempBlobUrl = await fetchLocalApiImageAsBlobUrl(src);
      if (!tempBlobUrl) return null;
      loadUrl = tempBlobUrl;
      useCors = false;
    }

    const img = await loadImageElement(loadUrl, useCors);
    if (!img) return null;

    const dataUrl512 = renderImageToSquareJpegDataUrl(img, CANVAS_SIZE_LARGE);
    if (!dataUrl512) return null;
    const dataUrl256 = renderImageToSquareJpegDataUrl(img, CANVAS_SIZE_SMALL);

    const artwork: MediaImage[] = [
      {src: dataUrl512, sizes: '512x512', type: 'image/jpeg'},
    ];
    if (dataUrl256) {
      artwork.push({src: dataUrl256, sizes: '256x256', type: 'image/jpeg'});
    }
    return artwork;
  } finally {
    if (tempBlobUrl) {
      try {
        URL.revokeObjectURL(tempBlobUrl);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Asynchronously resolves and bakes the track's album art into crisp `512x512` and `256x256`
 * `data:image/jpeg` canvas data URIs so Android lock-screen & notification media widgets render
 * the real album cover reliably even offline (IndexedDB cached tracks) or behind mTLS/auth proxies.
 *
 * Returns `null` if the track has no artwork or canvas baking could not access pixel data
 * (in which case callers keep the immediate accessible HTTPS/token URLs without overwriting
 * with the default app icon).
 */
export function resolveGuaranteedMediaArtwork(track: Track): Promise<MediaImage[] | null> {
  if (!trackHasRealArtwork(track)) {
    return Promise.resolve(null);
  }

  const cacheKey = getTrackArtworkCacheKey(track);
  const cached = resolvedCanvasArtworkCache.get(cacheKey);
  if (cached && cached.length > 0) {
    return Promise.resolve(cached);
  }

  const existing = inFlightArtworkResolutions.get(cacheKey);
  if (existing) {
    return existing;
  }

  const job = (async (): Promise<MediaImage[] | null> => {
    const {coverFile, directHttpsUrls, localApiUrls, dataOrBlobUrls} =
      extractRawArtworkCandidates(track);

    // 1. Offline IndexedDB cached cover blob (works 100% offline & zero network overhead!)
    if (coverFile) {
      const offlineBlobUrl = await getOfflineCoverBlobUrl(coverFile);
      if (offlineBlobUrl) {
        const rendered = await renderSourceToCanvasArtwork(offlineBlobUrl, {isBlobOrData: true});
        if (rendered) {
          setCachedArtwork(cacheKey, rendered);
          return rendered;
        }
      }
    }

    // 2. Existing data:/blob: URLs on the track object
    for (const url of dataOrBlobUrls) {
      const rendered = await renderSourceToCanvasArtwork(url, {isBlobOrData: true});
      if (rendered) {
        setCachedArtwork(cacheKey, rendered);
        return rendered;
      }
    }

    // 3. For Discover/YouTube tracks, try direct public HTTPS artwork first (e.g. Deezer cover_xl)
    //    so we preserve the crisp square album cover instead of falling back to a 16:9 YouTube thumbnail.
    if (track.isYouTubeStream) {
      for (const url of directHttpsUrls) {
        const rendered = await renderSourceToCanvasArtwork(url, {isLocalApi: false});
        if (rendered) {
          setCachedArtwork(cacheKey, rendered);
          return rendered;
        }
      }
    }

    // 4. Same-origin API endpoints (`/api/covers/...`, `/api/tracks/:id/cover`, `/api/yt-thumb/:videoId`)
    //    fetched with credentials & Bearer token so mTLS/auth proxies work seamlessly.
    for (const url of localApiUrls) {
      const rendered = await renderSourceToCanvasArtwork(url, {isLocalApi: true});
      if (rendered) {
        setCachedArtwork(cacheKey, rendered);
        return rendered;
      }
    }

    // 5. Public HTTPS URLs for non-YouTube tracks (if any external coverUrl exists)
    if (!track.isYouTubeStream) {
      for (const url of directHttpsUrls) {
        const rendered = await renderSourceToCanvasArtwork(url, {isLocalApi: false});
        if (rendered) {
          setCachedArtwork(cacheKey, rendered);
          return rendered;
        }
      }
    }

    return null;
  })().finally(() => {
    inFlightArtworkResolutions.delete(cacheKey);
  });

  inFlightArtworkResolutions.set(cacheKey, job);
  return job;
}
