import type {LrcLine} from '../types';

const TOKEN_STORAGE_KEY = 'xlabplayer_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage quota / private browsing errors
  }
}

export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = {error: text};
    }
  }

  if (!res.ok) {
    const message =
      typeof json.error === 'string'
        ? json.error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return json as T;
}

export function getStreamUrl(trackId: number): string {
  const token = getStoredToken();
  return token
    ? `/api/stream/${trackId}?token=${encodeURIComponent(token)}`
    : `/api/stream/${trackId}`;
}

export function getCoverUrl(coverFile: string | null | undefined): string | null {
  if (!coverFile) return null;
  return `/api/covers/${encodeURIComponent(coverFile)}`;
}

export function getSSEUrl(path: string): string {
  const token = getStoredToken();
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
}

export function parseLrc(raw: string): {isSynced: boolean; lines: LrcLine[]} {
  const rawLines = raw.split(/\r?\n/);
  const parsed: LrcLine[] = [];
  let syncedCount = 0;
  const timeRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip LRC metadata tags like [ar:...], [ti:...], [al:...]
    if (/^\[(ar|ti|al|by|offset|re|ve):/i.test(trimmed)) continue;

    const matches = Array.from(trimmed.matchAll(timeRe));
    if (matches.length > 0) {
      syncedCount++;
      const text = trimmed.replace(timeRe, '').trim();
      for (const m of matches) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
        parsed.push({time: min * 60 + sec + frac, text: text || '♪'});
      }
    } else {
      parsed.push({time: null, text: trimmed});
    }
  }

  if (syncedCount > 0) {
    parsed.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    return {isSynced: true, lines: parsed};
  }
  return {isSynced: false, lines: parsed};
}
