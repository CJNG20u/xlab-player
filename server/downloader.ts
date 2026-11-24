import {type ChildProcess, execFile, spawn} from 'child_process';
import crypto from 'crypto';
import dns from 'dns';
import {EventEmitter} from 'events';
import fs from 'fs';
import type {IncomingHttpHeaders, IncomingMessage} from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import {promisify} from 'util';
import {
  COOKIES_FILE,
  db,
  getCachedStreamUrlRow,
  getFfmpegPath,
  getMusicDir,
  getSetting,
  getYtdlpPath,
  invalidateCachedStreamUrlRow,
  pruneExpiredStreamUrlCache,
  setCachedStreamUrlRow,
  setSetting,
  YTDLP_CACHE_DIR,
} from './db.ts';
import {computeFileSha256, indexSingleFile} from './scanner.ts';

const execFileAsync = promisify(execFile);

export type DownloadQuality = 'standard' | 'high' | 'ultra';
export type SearchSource = 'youtube' | 'ytmusic';

export interface DownloadJobRow {
  id: number;
  user_id: number | null;
  url: string;
  title: string;
  artist: string;
  album: string;
  format: string;
  quality?: DownloadQuality;
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'error';
  progress: number;
  stage: string;
  track_id: number | null;
  error_log: string;
  thumbnail_url: string;
  created_at: string;
  updated_at: string;
}

export interface MetadataPreviewItem {
  id: string;
  url: string;
  title: string;
  artist: string;
  channel: string;
  album: string;
  duration: number;
  thumbnail_url: string;
  source?: SearchSource;
  duplicateTrack: {id: number; title: string; artist: string; album: string} | null;
}

export const downloadEvents = new EventEmitter();
downloadEvents.setMaxListeners(50);

let isProcessingQueue = false;
const activeDownloadJobs = new Map<number, {child: ChildProcess | null; canceled: boolean}>();

const RECOVERABLE_COOKIE_ERROR_PATTERNS = [
  'requested format is not available',
  'sign in to confirm',
  'confirm your age',
  'age-restricted',
  'age restricted',
  'http error 403',
  '403: forbidden',
  'login required',
  'cookies',
  'not a bot',
  'private video',
];

export function isRecoverableCookieError(errMessage: string): boolean {
  const lower = (errMessage || '').toLowerCase();
  return RECOVERABLE_COOKIE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function hasConfiguredCookies(): boolean {
  try {
    return fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 0;
  } catch {
    return false;
  }
}

export function normalizeDownloadQuality(_raw?: unknown): DownloadQuality {
  return 'ultra';
}

interface YtdlpInvocation {
  cmd: string;
  prefixArgs: string[];
  env: NodeJS.ProcessEnv;
}

function resolveYtdlpInvocation(forcePythonModule = false): YtdlpInvocation {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    XDG_CACHE_HOME: YTDLP_CACHE_DIR,
  };
  if (forcePythonModule) {
    return {cmd: 'python3', prefixArgs: ['-u', '-m', 'yt_dlp'], env};
  }
  const ytdlpPath = getYtdlpPath();
  // Execute the configured yt-dlp binary/script directly with PYTHONUNBUFFERED=1 so
  // virtualenv shebangs, zipapps, and standalone binaries all use their intended runtime
  // while keeping stdout/stderr completely unbuffered and persisting player caches.
  return {cmd: ytdlpPath, prefixArgs: [], env};
}

export async function execYtdlp(
  args: string[],
  options: {timeout?: number; maxBuffer?: number} = {}
): Promise<{stdout: string; stderr: string}> {
  const primary = resolveYtdlpInvocation(false);
  const execOpts = {
    timeout: options.timeout ?? 30000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    killSignal: 'SIGKILL' as const,
  };
  try {
    return await execFileAsync(primary.cmd, [...primary.prefixArgs, ...args], {
      ...execOpts,
      env: primary.env,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' && primary.cmd !== 'python3') {
      const fallback = resolveYtdlpInvocation(true);
      return await execFileAsync(fallback.cmd, [...fallback.prefixArgs, ...args], {
        ...execOpts,
        env: fallback.env,
      });
    }
    throw err;
  }
}

export function sanitizeNasSegment(name: string, fallback: string): string {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  return cleaned.slice(0, 120) || fallback;
}

export async function checkBinariesStatus(): Promise<{
  ytdlp: {installed: boolean; version: string | null; path: string};
  ffmpeg: {installed: boolean; version: string | null; path: string};
  cookies: {exists: boolean; status: string; testedAt: string; updatedAt: string | null};
}> {
  const ytdlpPath = getYtdlpPath();
  const ffmpegPath = getFfmpegPath();

  let ytdlpInstalled = false;
  let ytdlpVersion: string | null = null;
  try {
    const {stdout} = await execFileAsync(ytdlpPath, ['--version'], {timeout: 5000});
    ytdlpInstalled = true;
    ytdlpVersion = stdout.trim();
  } catch {
    ytdlpInstalled = false;
  }

  let ffmpegInstalled = false;
  let ffmpegVersion: string | null = null;
  try {
    const {stdout} = await execFileAsync(ffmpegPath, ['-version'], {timeout: 5000});
    ffmpegInstalled = true;
    const firstLine = stdout.split('\n')[0] || '';
    const match = firstLine.match(/ffmpeg version ([^\s]+)/i);
    ffmpegVersion = match ? match[1] : firstLine.trim().slice(0, 48);
  } catch {
    ffmpegInstalled = false;
  }

  let cookiesExists = false;
  let cookiesUpdatedAt: string | null = null;
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const stat = fs.statSync(COOKIES_FILE);
      if (stat.size > 0) {
        cookiesExists = true;
        cookiesUpdatedAt = stat.mtime.toISOString();
      }
    }
  } catch {
    cookiesExists = false;
  }

  return {
    ytdlp: {installed: ytdlpInstalled, version: ytdlpVersion, path: ytdlpPath},
    ffmpeg: {installed: ffmpegInstalled, version: ffmpegVersion, path: ffmpegPath},
    cookies: {
      exists: cookiesExists,
      status: cookiesExists ? getSetting('cookies_status', 'untested') : 'missing',
      testedAt: getSetting('cookies_tested_at', ''),
      updatedAt: cookiesUpdatedAt,
    },
  };
}

export function createTempCookiesCopy(): string | null {
  if (!fs.existsSync(COOKIES_FILE)) return null;
  const stat = fs.statSync(COOKIES_FILE);
  if (stat.size === 0) return null;
  const tmpPath = path.join(
    os.tmpdir(),
    `xlabplayer-cookies-${crypto.randomBytes(8).toString('hex')}.txt`
  );
  fs.copyFileSync(COOKIES_FILE, tmpPath);
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore on non-POSIX filesystems
  }
  return tmpPath;
}

function buildResilienceArgs(
  tempCookiePath: string | null,
  options: {includeSleep?: boolean; includePlayerClient?: boolean; forceIpv4?: boolean} = {}
): string[] {
  const includeSleep = options.includeSleep ?? true;
  const includePlayerClient = options.includePlayerClient ?? true;
  const forceIpv4 = options.forceIpv4 ?? false;
  const args: string[] = ['--js-runtimes', 'node'];
  if (tempCookiePath) {
    args.push('--cookies', tempCookiePath);
  }
  if (getSetting('ytdlp_remote_components', 'true') === 'true') {
    args.push('--remote-components', 'ejs:github');
  }
  if (includePlayerClient) {
    const playerClient = getSetting('ytdlp_player_client', 'web,mweb,android_vr').trim();
    if (playerClient) {
      args.push('--extractor-args', `youtube:player_client=${playerClient}`);
    }
  }
  if (includeSleep) {
    const sleepMin = Number(getSetting('ytdlp_sleep_interval', '2'));
    const sleepMax = Number(getSetting('ytdlp_max_sleep_interval', '5'));
    if (!Number.isNaN(sleepMin) && sleepMin > 0) {
      args.push('--sleep-interval', String(sleepMin));
    }
    if (!Number.isNaN(sleepMax) && sleepMax >= sleepMin && sleepMax > 0) {
      args.push('--max-sleep-interval', String(sleepMax));
    }
  }
  if (forceIpv4 || getSetting('ytdlp_force_ipv4', 'true') === 'true') {
    args.push('--force-ipv4');
  }
  const extra = getSetting('ytdlp_extra_flags', '').trim();
  if (extra) {
    const tokens = extra.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    for (const tok of tokens) {
      args.push(tok.replace(/^"|"$/g, ''));
    }
  }
  return args;
}

function findDuplicateInLibrary(artist: string, title: string) {
  const normArtist = (artist || '').trim().toLowerCase();
  const normTitle = (title || '').trim().toLowerCase();
  if (!normTitle) return null;

  const exact = db
    .prepare(
      'SELECT id, title, artist, album FROM tracks WHERE lower(title) = ? AND lower(artist) = ? LIMIT 1'
    )
    .get(normTitle, normArtist) as
    | {id: number; title: string; artist: string; album: string}
    | undefined;
  if (exact) return exact;

  const titleMatch = db
    .prepare('SELECT id, title, artist, album FROM tracks WHERE lower(title) = ? LIMIT 1')
    .get(normTitle) as {id: number; title: string; artist: string; album: string} | undefined;
  return titleMatch || null;
}

export function extractThumbnailUrl(entry: Record<string, unknown>): string {
  if (typeof entry.thumbnail === 'string' && entry.thumbnail.trim()) {
    return entry.thumbnail.trim();
  }
  if (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
    const valid = entry.thumbnails
      .filter(
        (t): t is {url: string; width?: number} =>
          Boolean(t && typeof (t as {url?: unknown}).url === 'string' && (t as {url: string}).url.trim())
      )
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    if (valid.length > 0) {
      return valid[0].url.trim();
    }
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (YOUTUBE_VIDEO_ID_RE.test(id)) {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  return '';
}

function normalizeMetadataEntry(
  entry: Record<string, unknown>,
  fallbackUrl: string,
  fallbackAlbum: string
): MetadataPreviewItem {
  const rawTitle = String(entry.track || entry.title || 'Untitled Track').trim();
  const channel = String(
    entry.channel || entry.uploader || entry.creator || entry.artist || 'Unknown Channel'
  )
    .replace(/\s*-\s*Topic$/i, '')
    .trim();

  let artist = String(
    entry.artist || entry.creator || entry.uploader || entry.channel || 'Unknown Artist'
  )
    .replace(/\s*-\s*Topic$/i, '')
    .trim();
  let title = rawTitle;

  // Parse "Artist - Title" (or en/em dash) pattern when explicit artist tag isn't present
  if (!entry.artist) {
    const sepMatch = rawTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (sepMatch && sepMatch[1].trim() && sepMatch[2].trim()) {
      artist = sepMatch[1].trim();
      title = sepMatch[2].trim();
    }
  }

  const album = String(entry.album || fallbackAlbum || 'Singles').trim();
  const thumb = extractThumbnailUrl(entry);

  const entryUrl = String(
    entry.webpage_url ||
      entry.original_url ||
      (typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url)
        ? entry.url
        : entry.id
          ? `https://www.youtube.com/watch?v=${entry.id}`
          : fallbackUrl)
  );

  return {
    id: String(entry.id || crypto.randomBytes(6).toString('hex')),
    url: entryUrl,
    title,
    artist,
    channel,
    album,
    duration: Number(entry.duration) || 0,
    thumbnail_url: thumb,
    duplicateTrack: findDuplicateInLibrary(artist, title),
  };
}

export function extractYouTubeVideoIdFromUrl(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (YOUTUBE_VIDEO_ID_RE.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const v = parsed.searchParams.get('v');
    if (v && YOUTUBE_VIDEO_ID_RE.test(v)) return v;
    if (parsed.hostname === 'youtu.be') {
      const seg = parsed.pathname.replace(/^\//, '').split('/')[0];
      if (seg && YOUTUBE_VIDEO_ID_RE.test(seg)) return seg;
    }
    const shortsMatch = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(parsed.pathname);
    if (shortsMatch) return shortsMatch[1];
  } catch {
    // ignore
  }
  return null;
}

function parseFlatEntriesFromJson(stdout: string): {
  isPlaylist: boolean;
  playlistTitle: string | null;
  entries: Array<Record<string, unknown>>;
} {
  const trimmed = stdout.trim();
  const entries: Array<Record<string, unknown>> = [];
  let isPlaylist = false;
  let playlistTitle: string | null = null;

  // Handle both --dump-single-json and newline-delimited --dump-json outputs
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    try {
      const data = JSON.parse(trimmed.slice(firstBrace)) as Record<string, unknown>;
      if (data._type === 'playlist' && Array.isArray(data.entries)) {
        isPlaylist = true;
        playlistTitle = typeof data.title === 'string' ? data.title : null;
        for (const sub of data.entries) {
          if (sub && typeof sub === 'object') {
            entries.push(sub as Record<string, unknown>);
          }
        }
        return {isPlaylist, playlistTitle, entries};
      }
      entries.push(data);
      return {isPlaylist: false, playlistTitle: null, entries};
    } catch {
      // Fall through to NDJSON line parser
    }
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(clean) as Record<string, unknown>;
      if (parsed._type === 'playlist' && Array.isArray(parsed.entries)) {
        isPlaylist = true;
        if (!playlistTitle && typeof parsed.title === 'string') playlistTitle = parsed.title;
        for (const sub of parsed.entries) {
          if (sub && typeof sub === 'object') {
            entries.push(sub as Record<string, unknown>);
          }
        }
      } else {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed line
    }
  }

  return {isPlaylist, playlistTitle, entries};
}

export async function peekTrackMetadata(urlOrVideoId: string): Promise<{
  videoId: string | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
  thumbnail_url: string;
}> {
  const trimmed = (urlOrVideoId || '').trim();
  const videoId = extractYouTubeVideoIdFromUrl(trimmed);
  const targetUrl = videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : /^https?:\/\//i.test(trimmed)
      ? trimmed
      : '';
  if (!targetUrl) {
    throw new Error('Invalid URL or YouTube video ID for metadata peek');
  }

  const runPeek = async (cookiePath: string | null): Promise<Record<string, unknown>> => {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '--js-runtimes',
      'node',
      '--force-ipv4',
    ];
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }
    if (getSetting('ytdlp_remote_components', 'true') === 'true') {
      args.push('--remote-components', 'ejs:github');
    }
    args.push('--', targetUrl);

    const {stdout} = await execYtdlp(args, {
      timeout: 25000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const jsonStart = stdout.indexOf('{');
    if (jsonStart === -1) {
      throw new Error('Empty metadata peek response');
    }
    return JSON.parse(stdout.slice(jsonStart)) as Record<string, unknown>;
  };

  let data: Record<string, unknown>;
  // Anonymous-first metadata peek; retry with cookies.txt only on auth/age/403 errors
  try {
    data = await runPeek(null);
  } catch (anonErr) {
    const msg = anonErr instanceof Error ? anonErr.message : String(anonErr);
    if (!isRecoverableCookieError(msg) || !hasConfiguredCookies()) {
      throw anonErr;
    }
    const tempCookiePath = createTempCookiesCopy();
    try {
      data = await runPeek(tempCookiePath);
    } finally {
      if (tempCookiePath && fs.existsSync(tempCookiePath)) {
        try {
          fs.unlinkSync(tempCookiePath);
        } catch {
          // ignore
        }
      }
    }
  }

  const normalized = normalizeMetadataEntry(data, targetUrl, 'Singles');
  const resolvedId =
    (typeof data.id === 'string' && YOUTUBE_VIDEO_ID_RE.test(data.id.trim())
      ? data.id.trim()
      : videoId) || null;
  if (resolvedId && normalized.thumbnail_url) {
    cacheYouTubeThumbnailUrl(resolvedId, normalized.thumbnail_url);
  }

  return {
    videoId: resolvedId,
    title: normalized.title,
    artist: normalized.artist,
    album: normalized.album,
    duration: normalized.duration,
    thumbnail_url: normalized.thumbnail_url,
  };
}

export async function fetchMetadataPreview(
  input: string,
  options: {source?: SearchSource; limit?: number} = {}
): Promise<{
  mode: 'search' | 'single' | 'playlist';
  isSearch: boolean;
  isPlaylist: boolean;
  playlistTitle: string | null;
  source?: SearchSource;
  items: MetadataPreviewItem[];
}> {
  const ytdlpPath = getYtdlpPath();
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Please enter a YouTube URL or search query');
  }

  const isUrl = /^https?:\/\//i.test(trimmed);
  const requestedSource: SearchSource = options.source === 'ytmusic' ? 'ytmusic' : 'youtube';
  const searchLimit = Math.min(Math.max(Number(options.limit) || 25, 1), 30);

  const runFlatSearch = async (target: string, extraArgs: string[] = []) => {
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--quiet',
      '--no-warnings',
      '--no-playlist',
      '--js-runtimes',
      'node',
      '--force-ipv4',
      ...extraArgs,
    ];
    if (getSetting('ytdlp_remote_components', 'true') === 'true') {
      args.push('--remote-components', 'ejs:github');
    }
    args.push('--', target);
    const {stdout} = await execYtdlp(args, {
      timeout: 35000,
      maxBuffer: 15 * 1024 * 1024,
    });
    return parseFlatEntriesFromJson(stdout);
  };

  try {
    if (!isUrl) {
      let resolvedSource: SearchSource = requestedSource;
      let rawEntries: Array<Record<string, unknown>> = [];

      if (requestedSource === 'ytmusic') {
        const ytMusicUrl = `https://music.youtube.com/search?q=${encodeURIComponent(trimmed)}#songs`;
        try {
          const parsed = await runFlatSearch(ytMusicUrl, ['--playlist-end', String(searchLimit)]);
          rawEntries = parsed.entries.filter((e) => {
            const id = typeof e.id === 'string' ? e.id.trim() : '';
            return Boolean(id && YOUTUBE_VIDEO_ID_RE.test(id));
          });
        } catch {
          rawEntries = [];
        }
        // Seamless fallback to standard ytsearch if YT Music flat search yields no playable songs
        if (rawEntries.length === 0) {
          resolvedSource = 'youtube';
          const parsed = await runFlatSearch(`ytsearch${searchLimit}:${trimmed}`);
          rawEntries = parsed.entries;
        }
      } else {
        const parsed = await runFlatSearch(`ytsearch${searchLimit}:${trimmed}`);
        rawEntries = parsed.entries;
      }

      const items = rawEntries
        .filter((e) => {
          const id = typeof e?.id === 'string' ? e.id.trim() : '';
          return Boolean(e && id && YOUTUBE_VIDEO_ID_RE.test(id));
        })
        .slice(0, searchLimit)
        .map((entry) => {
          const normalized = normalizeMetadataEntry(entry, trimmed, 'Singles');
          if (YOUTUBE_VIDEO_ID_RE.test(normalized.id) && normalized.thumbnail_url) {
            cacheYouTubeThumbnailUrl(normalized.id, normalized.thumbnail_url);
          }
          return {...normalized, source: resolvedSource};
        });

      return {
        mode: 'search',
        isSearch: true,
        isPlaylist: false,
        playlistTitle: null,
        source: resolvedSource,
        items,
      };
    }

    // Direct URL (single video or playlist) — anonymous first, cookies retry only if needed
    const runDirectUrlInspect = async (cookiePath: string | null) => {
      const args = [
        '--dump-single-json',
        '--flat-playlist',
        '--quiet',
        '--no-warnings',
        '--js-runtimes',
        'node',
        '--force-ipv4',
      ];
      if (cookiePath) {
        args.push('--cookies', cookiePath);
      }
      if (getSetting('ytdlp_remote_components', 'true') === 'true') {
        args.push('--remote-components', 'ejs:github');
      }
      args.push('--', trimmed);

      const {stdout} = await execYtdlp(args, {
        timeout: 45000,
        maxBuffer: 15 * 1024 * 1024,
      });
      return parseFlatEntriesFromJson(stdout);
    };

    let parsed: {
      isPlaylist: boolean;
      playlistTitle: string | null;
      entries: Array<Record<string, unknown>>;
    };
    try {
      parsed = await runDirectUrlInspect(null);
    } catch (anonErr) {
      const msg = anonErr instanceof Error ? anonErr.message : String(anonErr);
      if (!isRecoverableCookieError(msg) || !hasConfiguredCookies()) {
        throw anonErr;
      }
      const tempCookiePath = createTempCookiesCopy();
      try {
        parsed = await runDirectUrlInspect(tempCookiePath);
      } finally {
        if (tempCookiePath && fs.existsSync(tempCookiePath)) {
          try {
            fs.unlinkSync(tempCookiePath);
          } catch {
            // ignore
          }
        }
      }
    }

    const fallbackAlbum = parsed.isPlaylist && parsed.playlistTitle ? parsed.playlistTitle : 'Singles';
    const isYouTubeUrl = /(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(
      (() => {
        try {
          return new URL(trimmed).hostname;
        } catch {
          return '';
        }
      })()
    );
    const items = parsed.entries
      .filter((e) => {
        if (!e || !(e.title || e.id)) return false;
        if (!isYouTubeUrl) return true;
        const id = typeof e.id === 'string' ? e.id.trim() : '';
        return Boolean(id && YOUTUBE_VIDEO_ID_RE.test(id));
      })
      .slice(0, 50)
      .map((entry) => {
        const normalized = normalizeMetadataEntry(entry, trimmed, fallbackAlbum);
        if (YOUTUBE_VIDEO_ID_RE.test(normalized.id) && normalized.thumbnail_url) {
          cacheYouTubeThumbnailUrl(normalized.id, normalized.thumbnail_url);
        }
        return normalized;
      });

    return {
      mode: parsed.isPlaylist ? 'playlist' : 'single',
      isSearch: false,
      isPlaylist: parsed.isPlaylist,
      playlistTitle: parsed.playlistTitle,
      items,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      throw new Error(
        `yt-dlp binary ("${ytdlpPath}") is not installed on this server.`
      );
    }
    throw new Error(`Failed to fetch metadata: ${msg.slice(0, 320)}`);
  }
}

export const YOUTUBE_PLAYLIST_ID_RE = /^[\w-]{10,64}$/;
const YOUTUBE_PLAYLIST_CACHE_TTL_MS = 10 * 60 * 1000;
const YOUTUBE_PLAYLIST_SEARCH_CACHE_MAX = 200;
const YOUTUBE_PLAYLIST_DETAIL_CACHE_MAX = 100;
const YOUTUBE_PLAYLIST_MAX_TRACKS = 200;
const YOUTUBE_UNAVAILABLE_TITLE_RE = /^\[?(?:private|deleted|unavailable)\s+video\]?$/i;
const YOUTUBE_UNAVAILABLE_AVAILABILITIES = new Set([
  'private',
  'needs_auth',
  'subscriber_only',
  'premium_only',
  'unavailable',
]);

export interface YouTubePlaylistSearchItem {
  playlistId: string;
  title: string;
  channel: string;
  videoCount: number | null;
  thumbnail: string;
}

export interface YouTubePlaylistTrackItem {
  videoId: string;
  title: string;
  artist: string;
  channel: string;
  duration: number;
  thumbnail: string;
}

export interface YouTubePlaylistDetail {
  playlistId: string;
  title: string;
  channel: string;
  thumbnail: string;
  tracks: YouTubePlaylistTrackItem[];
}

interface TtlCacheEntry<T> {
  value: T;
  expiresAt: number;
}

const youtubePlaylistSearchCache = new Map<string, TtlCacheEntry<YouTubePlaylistSearchItem[]>>();
const youtubePlaylistSearchInFlight = new Map<string, Promise<YouTubePlaylistSearchItem[]>>();
const youtubePlaylistDetailCache = new Map<string, TtlCacheEntry<YouTubePlaylistDetail>>();
const youtubePlaylistDetailInFlight = new Map<string, Promise<YouTubePlaylistDetail>>();

export function isValidYouTubePlaylistId(id: string | null | undefined): boolean {
  return Boolean(id && YOUTUBE_PLAYLIST_ID_RE.test(id.trim()));
}

function setBoundedTtlCache<T>(
  cache: Map<string, TtlCacheEntry<T>>,
  key: string,
  value: T,
  maxEntries: number
): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, {value, expiresAt: Date.now() + YOUTUBE_PLAYLIST_CACHE_TTL_MS});
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function sanitizeHttpThumbnailUrl(url: string): string {
  const trimmed = (url || '').trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}

function extractPlaylistIdFromEntry(entry: Record<string, unknown>): string | null {
  const rawUrl =
    (typeof entry.url === 'string' && entry.url.trim()) ||
    (typeof entry.webpage_url === 'string' && entry.webpage_url.trim()) ||
    '';

  let urlListParam: string | null = null;
  let isWatchWithoutList = false;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl, 'https://www.youtube.com');
      const listParam = parsed.searchParams.get('list')?.trim() || '';
      if (listParam && YOUTUBE_PLAYLIST_ID_RE.test(listParam)) {
        urlListParam = listParam;
      } else if (parsed.pathname.startsWith('/watch') && !listParam) {
        isWatchWithoutList = true;
      }
    } catch {
      // Ignore unparseable URL and fall back to entry.id
    }
  }

  if (urlListParam) return urlListParam;
  if (isWatchWithoutList) return null;

  const rawId = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (rawId && YOUTUBE_PLAYLIST_ID_RE.test(rawId)) {
    // Reject bare 11-char single video entries that lack playlist markers
    if (YOUTUBE_VIDEO_ID_RE.test(rawId) && entry._type === 'video') {
      return null;
    }
    return rawId;
  }

  return null;
}

function parseFlatJsonDocument(stdout: string): {
  root: Record<string, unknown> | null;
  entries: Array<Record<string, unknown>>;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return {root: null, entries: []};

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (Array.isArray(parsed.entries)) {
        const entries = parsed.entries.filter(
          (e): e is Record<string, unknown> => Boolean(e && typeof e === 'object')
        );
        return {root: parsed, entries};
      }
      return {root: parsed, entries: [parsed]};
    } catch {
      // Fall back to existing NDJSON parser
    }
  }

  const fallback = parseFlatEntriesFromJson(trimmed);
  return {
    root: fallback.playlistTitle ? {title: fallback.playlistTitle} : null,
    entries: fallback.entries,
  };
}

async function runFlatYtdlpJson(
  targetUrl: string,
  options: {
    timeoutMs: number;
    playlistEnd: number;
    priority: StreamResolvePriority;
  }
): Promise<{root: Record<string, unknown> | null; entries: Array<Record<string, unknown>>}> {
  const execute = async (cookiePath: string | null) => {
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--quiet',
      '--no-warnings',
      '--playlist-end',
      String(options.playlistEnd),
      ...buildResilienceArgs(cookiePath, {
        includeSleep: false,
        includePlayerClient: false,
        forceIpv4: true,
      }),
      '--',
      targetUrl,
    ];
    const {stdout} = await execYtdlp(args, {
      timeout: options.timeoutMs,
      maxBuffer: 15 * 1024 * 1024,
    });
    return parseFlatJsonDocument(stdout);
  };

  return withYtdlpResolveSlot(async () => {
    try {
      return await execute(null);
    } catch (anonErr) {
      const msg = anonErr instanceof Error ? anonErr.message : String(anonErr);
      if (!isRecoverableCookieError(msg) || !hasConfiguredCookies()) {
        throw anonErr;
      }
      const tempCookiePath = createTempCookiesCopy();
      try {
        return await execute(tempCookiePath);
      } finally {
        if (tempCookiePath && fs.existsSync(tempCookiePath)) {
          try {
            fs.unlinkSync(tempCookiePath);
          } catch {
            // ignore cleanup failure
          }
        }
      }
    }
  }, options.priority);
}

export async function searchYoutubePlaylists(
  query: string,
  limit = 8
): Promise<YouTubePlaylistSearchItem[]> {
  const cleaned = (query || '').trim().slice(0, 120);
  if (!cleaned) return [];

  const safeLimit = Math.min(Math.max(Math.floor(Number(limit) || 8), 1), 20);
  const cacheKey = `${cleaned.toLowerCase()}::${safeLimit}`;
  const now = Date.now();

  const cached = youtubePlaylistSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const existingInFlight = youtubePlaylistSearchInFlight.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const runPromise = (async (): Promise<YouTubePlaylistSearchItem[]> => {
    try {
      const targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
        cleaned
      )}&sp=EgIQAw%3D%3D`;
      const {entries} = await runFlatYtdlpJson(targetUrl, {
        timeoutMs: 6500,
        playlistEnd: Math.max(safeLimit * 2, 16),
        priority: 'prefetch',
      });

      const seen = new Set<string>();
      const results: YouTubePlaylistSearchItem[] = [];

      for (const entry of entries) {
        if (results.length >= safeLimit) break;
        const playlistId = extractPlaylistIdFromEntry(entry);
        if (!playlistId || seen.has(playlistId)) continue;

        const title = String(entry.title || entry.playlist_title || '').trim();
        if (!title || YOUTUBE_UNAVAILABLE_TITLE_RE.test(title)) continue;

        const channel = String(
          entry.channel || entry.uploader || entry.playlist_uploader || ''
        )
          .replace(/\s*-\s*Topic$/i, '')
          .trim();

        const rawCount =
          entry.playlist_count ?? entry.n_entries ?? entry.entry_count ?? entry.video_count;
        const videoCount =
          typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0
            ? Math.floor(rawCount)
            : null;

        const thumbnail = sanitizeHttpThumbnailUrl(extractThumbnailUrl(entry));

        seen.add(playlistId);
        results.push({
          playlistId,
          title,
          channel,
          videoCount,
          thumbnail,
        });
      }

      setBoundedTtlCache(
        youtubePlaylistSearchCache,
        cacheKey,
        results,
        YOUTUBE_PLAYLIST_SEARCH_CACHE_MAX
      );
      return results;
    } catch {
      return [];
    } finally {
      youtubePlaylistSearchInFlight.delete(cacheKey);
    }
  })();

  youtubePlaylistSearchInFlight.set(cacheKey, runPromise);
  return runPromise;
}

export async function getYoutubePlaylistDetail(
  playlistId: string,
  options: {forceRefresh?: boolean} = {}
): Promise<YouTubePlaylistDetail> {
  const cleanId = (playlistId || '').trim();
  if (!isValidYouTubePlaylistId(cleanId)) {
    throw new Error('Invalid YouTube playlist ID');
  }

  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = youtubePlaylistDetailCache.get(cleanId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const existingInFlight = youtubePlaylistDetailInFlight.get(cleanId);
    if (existingInFlight) {
      return existingInFlight;
    }
  }

  const runPromise = (async (): Promise<YouTubePlaylistDetail> => {
    try {
      const targetUrl = `https://www.youtube.com/playlist?list=${cleanId}`;
      const {root, entries} = await runFlatYtdlpJson(targetUrl, {
        timeoutMs: 25000,
        playlistEnd: YOUTUBE_PLAYLIST_MAX_TRACKS + 20,
        priority: 'playback',
      });

      const tracks: YouTubePlaylistTrackItem[] = [];
      const seenVideoIds = new Set<string>();

      for (const entry of entries) {
        if (tracks.length >= YOUTUBE_PLAYLIST_MAX_TRACKS) break;
        const videoId = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!videoId || !YOUTUBE_VIDEO_ID_RE.test(videoId) || seenVideoIds.has(videoId)) {
          continue;
        }

        const availability =
          typeof entry.availability === 'string' ? entry.availability.trim().toLowerCase() : '';
        if (availability && YOUTUBE_UNAVAILABLE_AVAILABILITIES.has(availability)) {
          continue;
        }

        const rawTitle = String(entry.track || entry.title || '').trim();
        if (!rawTitle || YOUTUBE_UNAVAILABLE_TITLE_RE.test(rawTitle)) {
          continue;
        }

        const channel = String(
          entry.channel || entry.uploader || entry.playlist_uploader || ''
        )
          .replace(/\s*-\s*Topic$/i, '')
          .trim();

        const artist =
          String(entry.artist || entry.creator || entry.uploader || entry.channel || '')
            .replace(/\s*-\s*Topic$/i, '')
            .trim() ||
          channel ||
          'YouTube';

        const duration =
          typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0
            ? Math.round(entry.duration)
            : 0;

        const thumbnail =
          sanitizeHttpThumbnailUrl(extractThumbnailUrl(entry)) ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        if (thumbnail) {
          cacheYouTubeThumbnailUrl(videoId, thumbnail);
        }

        seenVideoIds.add(videoId);
        tracks.push({
          videoId,
          title: rawTitle,
          artist,
          channel,
          duration,
          thumbnail,
        });
      }

      const title =
        String(root?.title || root?.playlist_title || '').trim() || 'YouTube Playlist';
      const channel = String(
        root?.channel || root?.uploader || root?.playlist_uploader || ''
      )
        .replace(/\s*-\s*Topic$/i, '')
        .trim();
      const thumbnail =
        (root ? sanitizeHttpThumbnailUrl(extractThumbnailUrl(root)) : '') ||
        tracks[0]?.thumbnail ||
        '';

      const detail: YouTubePlaylistDetail = {
        playlistId: cleanId,
        title,
        channel,
        thumbnail,
        tracks,
      };

      setBoundedTtlCache(
        youtubePlaylistDetailCache,
        cleanId,
        detail,
        YOUTUBE_PLAYLIST_DETAIL_CACHE_MAX
      );
      return detail;
    } finally {
      youtubePlaylistDetailInFlight.delete(cleanId);
    }
  })();

  youtubePlaylistDetailInFlight.set(cleanId, runPromise);
  return runPromise;
}

export function getDownloadJobs(): DownloadJobRow[] {
  return db
    .prepare('SELECT * FROM download_jobs ORDER BY id DESC LIMIT 50')
    .all() as DownloadJobRow[];
}

function updateJob(id: number, fields: Partial<DownloadJobRow>): DownloadJobRow {
  const keys = Object.keys(fields) as Array<keyof DownloadJobRow>;
  if (keys.length > 0) {
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE download_jobs SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({
      ...fields,
      id,
    });
  }
  const updated = db
    .prepare('SELECT * FROM download_jobs WHERE id = ?')
    .get(id) as DownloadJobRow | undefined;
  if (updated) {
    downloadEvents.emit('job', updated);
    return updated;
  }
  return {
    id,
    user_id: null,
    url: '',
    title: '',
    artist: '',
    album: '',
    format: 'm4a',
    quality: 'ultra',
    status: 'error',
    progress: 0,
    stage: 'Canceled',
    track_id: null,
    error_log: '',
    thumbnail_url: '',
    created_at: '',
    updated_at: '',
  };
}

export function cancelDownloadJob(id: number): void {
  const active = activeDownloadJobs.get(id);
  if (active) {
    active.canceled = true;
    if (active.child && !active.child.killed) {
      try {
        active.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      const proc = active.child;
      setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 2500);
    }
  }
}

export function enqueueDownloadJob(params: {
  userId: number;
  url: string;
  title: string;
  artist: string;
  album: string;
  format?: string;
  quality?: DownloadQuality;
  thumbnailUrl?: string;
}): DownloadJobRow {
  const requestedFormat = String(params.format || '').trim().toLowerCase();
  const storedFormat =
    requestedFormat === 'opus'
      ? 'opus'
      : requestedFormat === 'mp3'
        ? 'mp3'
        : 'm4a';

  const result = db
    .prepare(
      `INSERT INTO download_jobs (user_id, url, title, artist, album, format, quality, status, progress, stage, thumbnail_url)
       VALUES (?, ?, ?, ?, ?, ?, 'ultra', 'queued', 0, 'Queued', ?)`
    )
    .run(
      params.userId,
      params.url,
      params.title,
      params.artist,
      params.album,
      storedFormat,
      params.thumbnailUrl || ''
    );
  const job = db
    .prepare('SELECT * FROM download_jobs WHERE id = ?')
    .get(result.lastInsertRowid) as DownloadJobRow;
  downloadEvents.emit('job', job);
  void processDownloadQueue();
  return job;
}

async function processDownloadQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (true) {
      const nextJob = db
        .prepare("SELECT * FROM download_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
        .get() as DownloadJobRow | undefined;
      if (!nextJob) break;
      await executeDownloadJob(nextJob);
    }
  } finally {
    isProcessingQueue = false;
  }
}

const IMAGE_FILE_RE = /\.(jpg|jpeg|png|webp)$/i;
const ALLOWED_FINAL_AUDIO_EXTS = new Set(['opus', 'm4a', 'mp3', 'ogg', 'webm', 'flac', 'wav', 'aac']);

function findUuidDownloadedAudio(tmpWorkDir: string, jobUuid: string): string | null {
  const files = fs.readdirSync(tmpWorkDir);
  const match = files.find(
    (f) =>
      f.startsWith(`${jobUuid}.`) &&
      !IMAGE_FILE_RE.test(f) &&
      !f.endsWith('.part') &&
      !f.endsWith('.ytdl') &&
      !f.endsWith('.json') &&
      !f.endsWith('.tmp')
  );
  return match ? path.join(tmpWorkDir, match) : null;
}

function findUuidDownloadedThumb(tmpWorkDir: string, jobUuid: string): string | null {
  const files = fs.readdirSync(tmpWorkDir);
  const match = files.find((f) => f.startsWith(`${jobUuid}.`) && IMAGE_FILE_RE.test(f));
  return match ? path.join(tmpWorkDir, match) : null;
}

function cleanUuidTempAudioFiles(tmpWorkDir: string, jobUuid: string): void {
  try {
    for (const f of fs.readdirSync(tmpWorkDir)) {
      if (f.startsWith(`${jobUuid}.`) && !IMAGE_FILE_RE.test(f)) {
        try {
          fs.unlinkSync(path.join(tmpWorkDir, f));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

function spawnYtdlpStage(
  jobId: number,
  stageLabel: string,
  args: string[],
  progressFloor: number,
  progressCeiling: number
): Promise<void> {
  const state = activeDownloadJobs.get(jobId);
  if (state?.canceled) {
    return Promise.reject(new Error('Download canceled'));
  }

  const runSpawn = (forcePythonModule: boolean): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const invocation = resolveYtdlpInvocation(forcePythonModule);
      const child = spawn(invocation.cmd, [...invocation.prefixArgs, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: invocation.env,
      });

      const currentState = activeDownloadJobs.get(jobId);
      if (currentState) {
        currentState.child = child;
        if (currentState.canceled) {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
      }

      let stderrBuf = '';
      let sawEnoent = false;

      child.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
          if (match) {
            const rawPct = parseFloat(match[1]);
            const span = progressCeiling - progressFloor;
            const pct = Math.min(progressCeiling, Math.round(progressFloor + (rawPct / 100) * span));
            updateJob(jobId, {progress: pct, stage: stageLabel});
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      child.on('error', (err) => {
        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === 'ENOENT' && !forcePythonModule && invocation.cmd !== 'python3') {
          sawEnoent = true;
          runSpawn(true).then(resolve, reject);
          return;
        }
        reject(new Error(`Could not launch yt-dlp: ${err.message}`));
      });

      child.on('close', (code) => {
        if (sawEnoent) return;
        const latestState = activeDownloadJobs.get(jobId);
        if (latestState && latestState.child === child) {
          latestState.child = null;
        }
        if (latestState?.canceled) {
          reject(new Error('Download canceled'));
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(stderrBuf.trim() || `yt-dlp exited with code ${code}`));
      });
    });

  return runSpawn(false);
}

function needsMetadataRecovery(title: string, artist: string): boolean {
  const t = (title || '').trim().toLowerCase();
  const a = (artist || '').trim().toLowerCase();
  if (!t || t === 'untitled' || t === 'untitled track' || /^https?:\/\//i.test(t)) return true;
  if (!a || a === 'unknown artist' || a === 'youtube' || a === 'unknown channel') return true;
  return false;
}

async function fetchFallbackCoverFile(
  tmpWorkDir: string,
  jobUuid: string,
  videoId: string | null,
  fallbackUrl: string
): Promise<string | null> {
  const candidates: string[] = [];
  if (videoId) {
    const cached = getCachedYouTubeThumbnailUrl(videoId);
    if (cached) candidates.push(cached);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
  }
  if (fallbackUrl && isAllowedYouTubeMediaUrl(fallbackUrl)) {
    candidates.push(fallbackUrl);
  }

  for (const url of candidates) {
    if (!isAllowedYouTubeMediaUrl(url)) continue;
    try {
      const resp = await fetch(url, {
        headers: {Accept: 'image/*'},
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        continue;
      }
      if (resp.url && !isAllowedYouTubeMediaUrl(resp.url)) {
        await resp.body?.cancel().catch(() => {});
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 512) continue;
      const outPath = path.join(tmpWorkDir, `${jobUuid}-fallback-cover.jpg`);
      fs.writeFileSync(outPath, buf);
      return outPath;
    } catch {
      // Try next thumbnail candidate
    }
  }
  return null;
}

async function remuxDownloadedAudioLossless(params: {
  ffmpegPath: string;
  downloadedPath: string;
  tmpWorkDir: string;
  filePrefix: string;
  title: string;
  artist: string;
  album: string;
  coverPath: string | null;
}): Promise<{outputPath: string; ext: string}> {
  const {ffmpegPath, downloadedPath, tmpWorkDir, filePrefix, title, artist, album, coverPath} =
    params;
  const rawExt = path.extname(downloadedPath).replace('.', '').toLowerCase();

  let targetExts: string[];
  if (rawExt === 'm4a' || rawExt === 'mp4') {
    targetExts = ['m4a'];
  } else if (rawExt === 'webm') {
    targetExts = ['webm'];
  } else if (ALLOWED_FINAL_AUDIO_EXTS.has(rawExt)) {
    targetExts = [rawExt];
  } else {
    // Video fallback container (e.g. mkv, mov, ts, flv): remux audio-only without re-encoding
    targetExts = ['m4a', 'webm', 'ogg'];
  }

  for (const ext of targetExts) {
    const outPath = path.join(tmpWorkDir, `${filePrefix}-final.${ext}`);
    const supportsAttachedCover = Boolean(coverPath && (ext === 'm4a' || ext === 'mp3'));

    if (supportsAttachedCover && coverPath) {
      try {
        const ffArgs: string[] = [
          '-y',
          '-i',
          downloadedPath,
          '-i',
          coverPath,
          '-map',
          '0:a:0',
          '-map',
          '1:v:0',
          '-c:a',
          'copy',
          '-c:v',
          'mjpeg',
          ...(ext === 'mp3' ? ['-id3v2_version', '3'] : []),
          '-disposition:v:0',
          'attached_pic',
          '-metadata',
          `title=${title}`,
          '-metadata',
          `artist=${artist}`,
          '-metadata',
          `album=${album}`,
          ...(ext === 'm4a' ? ['-movflags', '+faststart'] : []),
          outPath,
        ];
        await execFileAsync(ffmpegPath, ffArgs, {timeout: 60_000});
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          return {outputPath: outPath, ext};
        }
      } catch {
        // Fall through to audio-only stream copy without embedded cover
      }
    }

    try {
      const strippedPath = path.join(tmpWorkDir, `${filePrefix}-audio.${ext}`);
      const ffArgs: string[] = [
        '-y',
        '-i',
        downloadedPath,
        '-vn',
        '-c:a',
        'copy',
        '-metadata',
        `title=${title}`,
        '-metadata',
        `artist=${artist}`,
        '-metadata',
        `album=${album}`,
        ...(ext === 'm4a' ? ['-movflags', '+faststart'] : []),
        strippedPath,
      ];
      await execFileAsync(ffmpegPath, ffArgs, {timeout: 60_000});
      if (fs.existsSync(strippedPath) && fs.statSync(strippedPath).size > 0) {
        return {outputPath: strippedPath, ext};
      }
    } catch {
      // Try next container if codec is incompatible with this container
    }
  }

  const fallbackExt = ALLOWED_FINAL_AUDIO_EXTS.has(rawExt) ? rawExt : 'm4a';
  return {outputPath: downloadedPath, ext: fallbackExt};
}

async function executeDownloadJob(job: DownloadJobRow): Promise<void> {
  const ffmpegPath = getFfmpegPath();
  const cropCover = getSetting('ytdlp_crop_cover', 'true') === 'true';
  const musicDir = path.resolve(getMusicDir());

  const jobUuid = crypto.randomUUID();
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlab-dl-'));
  let tempCookiePath: string | null = null;

  activeDownloadJobs.set(job.id, {child: null, canceled: false});

  try {
    let resolvedTitle = job.title;
    let resolvedArtist = job.artist;
    let resolvedAlbum = job.album || 'Singles';
    let resolvedThumbUrl = job.thumbnail_url || '';

    // Recover clean track title & artist via anonymous-first metadata peek when tags are missing/noisy
    if (needsMetadataRecovery(resolvedTitle, resolvedArtist)) {
      updateJob(job.id, {status: 'downloading', progress: 2, stage: 'Peeking Metadata', error_log: ''});
      try {
        const peeked = await peekTrackMetadata(job.url);
        if (peeked.title) resolvedTitle = peeked.title;
        if (peeked.artist) resolvedArtist = peeked.artist;
        if (peeked.album && (!resolvedAlbum || resolvedAlbum === 'Singles')) {
          resolvedAlbum = peeked.album;
        }
        if (peeked.thumbnail_url && !resolvedThumbUrl) {
          resolvedThumbUrl = peeked.thumbnail_url;
        }
        updateJob(job.id, {
          title: resolvedTitle,
          artist: resolvedArtist,
          album: resolvedAlbum,
          thumbnail_url: resolvedThumbUrl,
        });
      } catch {
        // Proceed with user-provided metadata if peek fails
      }
    }

    const outTemplate = path.join(tmpWorkDir, `${jobUuid}.%(ext)s`);

    const buildNativeArgs = (cookiePath: string | null): string[] => {
      const args = [
        '--newline',
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes',
        'node',
        '--force-ipv4',
        '-f',
        YDL_FORMAT_AUDIO_DOWNLOAD,
        '--write-thumbnail',
        '--convert-thumbnails',
        'jpg',
        '--ffmpeg-location',
        ffmpegPath,
      ];
      if (getSetting('ytdlp_remote_components', 'true') === 'true') {
        args.push('--remote-components', 'ejs:github');
      }
      if (cookiePath) {
        args.push('--cookies', cookiePath);
      }
      args.push('-o', outTemplate, '--', job.url);
      return args;
    };

    const buildStage3ExtractionArgs = (cookiePath: string | null): string[] => {
      // Fallback: download best audio (or worst with audio) keeping original codec with zero re-encoding
      const args = [
        '--newline',
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes',
        'node',
        '--force-ipv4',
        '-f',
        YDL_FORMAT_AUDIO_DOWNLOAD,
        '--write-thumbnail',
        '--convert-thumbnails',
        'jpg',
        '--ffmpeg-location',
        ffmpegPath,
      ];
      if (getSetting('ytdlp_remote_components', 'true') === 'true') {
        args.push('--remote-components', 'ejs:github');
      }
      if (cookiePath) {
        args.push('--cookies', cookiePath);
      }
      args.push('-o', outTemplate, '--', job.url);
      return args;
    };

    let downloadedAudioPath: string | null = null;
    let lastStageError = '';

    // STAGE 1: Anonymous native best audio-only stream (convert_to=None, zero re-encoding)
    updateJob(job.id, {status: 'downloading', progress: 4, stage: 'Downloading Native Audio', error_log: ''});
    try {
      await spawnYtdlpStage(job.id, 'Downloading Native Audio', buildNativeArgs(null), 5, 68);
      downloadedAudioPath = findUuidDownloadedAudio(tmpWorkDir, jobUuid);
    } catch (stage1Err) {
      lastStageError = stage1Err instanceof Error ? stage1Err.message : String(stage1Err);
      if (activeDownloadJobs.get(job.id)?.canceled) throw stage1Err;
      cleanUuidTempAudioFiles(tmpWorkDir, jobUuid);
    }

    // STAGE 2: Retry native audio-only with cookies.txt on recoverable auth/403/format errors
    if (!downloadedAudioPath && hasConfiguredCookies() && isRecoverableCookieError(lastStageError)) {
      tempCookiePath = createTempCookiesCopy();
      updateJob(job.id, {status: 'downloading', progress: 8, stage: 'Retrying with Cookies'});
      try {
        await spawnYtdlpStage(
          job.id,
          'Retrying with Cookies',
          buildNativeArgs(tempCookiePath),
          10,
          70
        );
        downloadedAudioPath = findUuidDownloadedAudio(tmpWorkDir, jobUuid);
      } catch (stage2Err) {
        lastStageError = stage2Err instanceof Error ? stage2Err.message : String(stage2Err);
        if (activeDownloadJobs.get(job.id)?.canceled) throw stage2Err;
        cleanUuidTempAudioFiles(tmpWorkDir, jobUuid);
      }
    }

    // STAGE 3: Fallback native audio download (keeping original codec, zero re-encoding)
    if (!downloadedAudioPath) {
      if (!tempCookiePath && hasConfiguredCookies()) {
        tempCookiePath = createTempCookiesCopy();
      }
      updateJob(job.id, {
        status: 'downloading',
        progress: 12,
        stage: 'Fallback Native Audio',
      });
      try {
        await spawnYtdlpStage(
          job.id,
          'Fallback Native Audio',
          buildStage3ExtractionArgs(tempCookiePath),
          14,
          74
        );
        downloadedAudioPath = findUuidDownloadedAudio(tmpWorkDir, jobUuid);
      } catch (stage3Err) {
        lastStageError = stage3Err instanceof Error ? stage3Err.message : String(stage3Err);
        if (activeDownloadJobs.get(job.id)?.canceled) throw stage3Err;
      }
    }

    if (!downloadedAudioPath || !fs.existsSync(downloadedAudioPath)) {
      throw new Error(lastStageError || 'Downloaded audio file not found after yt-dlp finished');
    }

    // Resolve & crop 1:1 square cover art
    const videoId = extractYouTubeVideoIdFromUrl(job.url);
    let coverPath =
      findUuidDownloadedThumb(tmpWorkDir, jobUuid) ||
      (await fetchFallbackCoverFile(tmpWorkDir, jobUuid, videoId, resolvedThumbUrl));

    if (coverPath && cropCover) {
      updateJob(job.id, {status: 'processing', progress: 78, stage: 'Cropping 1:1 Cover'});
      const croppedCover = path.join(tmpWorkDir, `${jobUuid}-cover-square.jpg`);
      try {
        await execFileAsync(
          ffmpegPath,
          [
            '-y',
            '-i',
            coverPath,
            '-vf',
            "crop='min(iw,ih)':'min(iw,ih)'",
            '-q:v',
            '2',
            croppedCover,
          ],
          {timeout: 30000}
        );
        if (fs.existsSync(croppedCover)) {
          coverPath = croppedCover;
        }
      } catch {
        // Proceed with uncropped cover if ffmpeg crop fails
      }
    }

    // FFmpeg audio-only remux preserving original codec (`-vn -c:a copy`, zero re-encoding) + tags
    updateJob(job.id, {status: 'processing', progress: 86, stage: 'Finalizing Audio & Tags'});

    const remuxedResult = await remuxDownloadedAudioLossless({
      ffmpegPath,
      downloadedPath: downloadedAudioPath,
      tmpWorkDir,
      filePrefix: jobUuid,
      title: resolvedTitle,
      artist: resolvedArtist,
      album: resolvedAlbum,
      coverPath,
    });
    const finalizedTempPath = remuxedResult.outputPath;
    const finalExt = remuxedResult.ext;

    // Content-hash deduplication: SHA-256 -> deterministic `tracks/<file_hash>.<ext>`
    updateJob(job.id, {status: 'processing', progress: 93, stage: 'Hashing & Deduplicating'});
    const fileHash = await computeFileSha256(finalizedTempPath);
    if (!/^[a-f0-9]{64}$/.test(fileHash)) {
      throw new Error('Failed to compute valid SHA-256 content hash');
    }

    // Check if an identical audio stream is already stored in the library
    const existingByHash = db
      .prepare('SELECT id, rel_path FROM tracks WHERE file_hash = ? LIMIT 1')
      .get(fileHash) as {id: number; rel_path: string} | undefined;

    if (existingByHash) {
      const existingAbs = path.resolve(musicDir, existingByHash.rel_path);
      if (
        existingAbs.startsWith(musicDir + path.sep) &&
        fs.existsSync(existingAbs) &&
        fs.statSync(existingAbs).isFile()
      ) {
        // Refresh metadata/cover if needed without writing a duplicate file on disk
        await indexSingleFile(existingAbs, musicDir, {
          fileHash,
          title: resolvedTitle,
          artist: resolvedArtist,
          album: resolvedAlbum,
          coverFilePath: coverPath,
        });
        updateJob(job.id, {
          status: 'completed',
          progress: 100,
          stage: 'Deduplicated (Already in Library)',
          format: finalExt,
          track_id: existingByHash.id,
        });
        return;
      }
    }

    const tracksDir = path.join(musicDir, 'tracks');
    fs.mkdirSync(tracksDir, {recursive: true});
    const finalAudioPath = path.resolve(tracksDir, `${fileHash}.${finalExt}`);
    if (!finalAudioPath.startsWith(musicDir + path.sep)) {
      throw new Error('Destination path escaped configured music directory');
    }

    // Write atomically only if this content-hash file is not already on disk
    if (!fs.existsSync(finalAudioPath)) {
      const stagedPath = path.join(tracksDir, `.${fileHash}.${jobUuid}.part`);
      try {
        fs.copyFileSync(finalizedTempPath, stagedPath);
        fs.renameSync(stagedPath, finalAudioPath);
      } finally {
        if (fs.existsSync(stagedPath)) {
          try {
            fs.unlinkSync(stagedPath);
          } catch {
            // ignore
          }
        }
      }
    }

    // Index duration, bitrate, codec/format, cover art, and file_hash into SQLite
    updateJob(job.id, {status: 'processing', progress: 97, stage: 'Indexing Track'});
    const indexed = await indexSingleFile(finalAudioPath, musicDir, {
      fileHash,
      title: resolvedTitle,
      artist: resolvedArtist,
      album: resolvedAlbum,
      coverFilePath: coverPath,
    });

    updateJob(job.id, {
      status: 'completed',
      progress: 100,
      stage: 'Indexed',
      format: finalExt,
      track_id: indexed.id,
    });
  } catch (err) {
    const wasCanceled = activeDownloadJobs.get(job.id)?.canceled;
    if (!wasCanceled) {
      const msg = err instanceof Error ? err.message : String(err);
      updateJob(job.id, {
        status: 'error',
        stage: 'Failed',
        error_log: msg.slice(0, 2000),
      });
    }
  } finally {
    activeDownloadJobs.delete(job.id);
    if (tempCookiePath && fs.existsSync(tempCookiePath)) {
      try {
        fs.unlinkSync(tempCookiePath);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(tmpWorkDir, {recursive: true, force: true});
    } catch {
      // ignore
    }
  }
}

const ALLOWED_CATALOG_COVER_SUFFIXES = ['.dzcdn.net', '.deezer.com'];

function isAllowedCoverImageUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (isAllowedYouTubeMediaUrl(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return ALLOWED_CATALOG_COVER_SUFFIXES.some(
      (suffix) => host === suffix.slice(1) || host.endsWith(suffix)
    );
  } catch {
    return false;
  }
}

async function downloadCoverImageToTemp(
  tmpWorkDir: string,
  dlUuid: string,
  coverUrl: string | undefined,
  videoId: string
): Promise<string | null> {
  const candidates: string[] = [];
  if (coverUrl && isAllowedCoverImageUrl(coverUrl)) {
    candidates.push(coverUrl.trim());
  }
  const cachedYtThumb = getCachedYouTubeThumbnailUrl(videoId);
  if (cachedYtThumb && isAllowedCoverImageUrl(cachedYtThumb)) {
    candidates.push(cachedYtThumb);
  }
  candidates.push(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
  candidates.push(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);

  for (const url of candidates) {
    if (!isAllowedCoverImageUrl(url)) continue;
    try {
      const resp = await fetch(url, {
        headers: {Accept: 'image/*'},
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        continue;
      }
      if (resp.url && !isAllowedCoverImageUrl(resp.url)) {
        await resp.body?.cancel().catch(() => {});
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 256 || buf.length > 10 * 1024 * 1024) continue;
      const outPath = path.join(tmpWorkDir, `${dlUuid}-cover.jpg`);
      fs.writeFileSync(outPath, buf);
      return outPath;
    } catch {
      // Try next cover candidate
    }
  }
  return null;
}

export interface DirectNasDownloadInput {
  userId: number;
  videoId?: string;
  url?: string;
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  duration?: number;
}

export interface DirectNasDownloadResult {
  track: Record<string, unknown> & {id: number; rel_path: string; filePath: string; liked: boolean};
  filePath: string;
  alreadyExists: boolean;
}

const inFlightNasDownloads = new Map<string, Promise<DirectNasDownloadResult>>();

function loadCanonicalTrackRow(
  trackId: number,
  userId: number,
  filePath: string
): Record<string, unknown> & {id: number; rel_path: string; filePath: string; liked: boolean} {
  const row = db
    .prepare(
      `SELECT t.*, CASE WHEN lt.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked
       FROM tracks t
       LEFT JOIN liked_tracks lt ON lt.track_id = t.id AND lt.user_id = ?
       WHERE t.id = ?`
    )
    .get(userId, trackId) as (Record<string, unknown> & {id: number; rel_path: string}) | undefined;
  if (!row) {
    throw new Error('Downloaded track could not be retrieved from library database');
  }
  return {
    ...row,
    liked: Boolean(row.liked),
    filePath,
  };
}

export function findLibraryTrackByVideoId(
  videoId: string
): {id: number; rel_path: string; absPath: string} | null {
  const cleanId = (videoId || '').trim();
  if (!isValidYouTubeVideoId(cleanId)) return null;

  const row = db
    .prepare('SELECT id, rel_path FROM tracks WHERE youtube_video_id = ? LIMIT 1')
    .get(cleanId) as {id: number; rel_path: string} | undefined;
  if (!row || !row.rel_path) return null;

  const musicDir = path.resolve(getMusicDir());
  const absPath = path.resolve(musicDir, row.rel_path);
  if (!absPath.startsWith(musicDir + path.sep)) return null;
  try {
    const st = fs.statSync(absPath);
    if (st.isFile() && st.size > 0) {
      return {id: row.id, rel_path: row.rel_path, absPath};
    }
  } catch {
    // File missing on disk — allow re-download
  }
  return null;
}

export async function downloadTrackToNas(
  input: DirectNasDownloadInput
): Promise<DirectNasDownloadResult> {
  const rawVideoId = (input.videoId || '').trim();
  const rawUrl = (input.url || '').trim();
  let resolvedTitle = (input.title || '').trim().slice(0, 200);
  let resolvedArtist = (input.artist || '').trim().slice(0, 160);
  let resolvedAlbum = (input.album || '').trim().slice(0, 200);
  const rawCoverUrl = (input.coverUrl || '').trim();
  const duration = Number.isFinite(Number(input.duration)) ? Math.max(0, Number(input.duration)) : 0;

  let videoId = isValidYouTubeVideoId(rawVideoId)
    ? rawVideoId
    : rawUrl
      ? extractYouTubeVideoIdFromUrl(rawUrl) || ''
      : '';

  if (!videoId) {
    if (!resolvedTitle) {
      throw new Error('A videoId or track title is required to download audio');
    }
    const matched = await resolveTrackToVideoId({
      artist: resolvedArtist,
      title: resolvedTitle,
      duration,
    });
    videoId = matched.videoId;
  }

  if (!isValidYouTubeVideoId(videoId)) {
    throw new Error('Could not resolve a valid YouTube video ID');
  }

  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Recover clean tags when caller omitted artist/title
  if (needsMetadataRecovery(resolvedTitle, resolvedArtist)) {
    try {
      const peeked = await peekTrackMetadata(targetUrl);
      if (!resolvedTitle && peeked.title) resolvedTitle = peeked.title;
      if ((!resolvedArtist || needsMetadataRecovery('ok', resolvedArtist)) && peeked.artist) {
        resolvedArtist = peeked.artist;
      }
      if (!resolvedAlbum && peeked.album) resolvedAlbum = peeked.album;
    } catch {
      // Proceed with provided metadata
    }
  }

  if (!resolvedTitle) resolvedTitle = videoId;
  if (!resolvedArtist) resolvedArtist = 'Unknown Artist';
  if (!resolvedAlbum || resolvedAlbum === 'Online Stream' || resolvedAlbum === 'YouTube Stream') {
    resolvedAlbum = 'Singles';
  }

  const musicDir = path.resolve(getMusicDir());
  const downloadsDir = path.resolve(musicDir, 'Downloads');
  if (!downloadsDir.startsWith(musicDir + path.sep)) {
    throw new Error('Downloads directory escaped configured music root');
  }
  fs.mkdirSync(downloadsDir, {recursive: true});

  const safeArtist = sanitizeNasSegment(resolvedArtist, 'Unknown Artist');
  const safeTitle = sanitizeNasSegment(resolvedTitle, 'Untitled');
  const baseFileName = `${safeArtist} - ${safeTitle}`;
  const dedupeKey = `vid:${videoId}`;
  const existingFlight = inFlightNasDownloads.get(dedupeKey);
  if (existingFlight) {
    return existingFlight;
  }

  const workPromise = (async (): Promise<DirectNasDownloadResult> => {
    // Fast-path 1: already indexed in library for this YouTube videoId
    const existingByVideo = findLibraryTrackByVideoId(videoId);
    if (existingByVideo) {
      const track = loadCanonicalTrackRow(existingByVideo.id, input.userId, existingByVideo.absPath);
      return {track, filePath: existingByVideo.absPath, alreadyExists: true};
    }

    // Fast-path 2: already saved on disk in <music_dir>/Downloads under any supported audio extension
    for (const ext of ALLOWED_FINAL_AUDIO_EXTS) {
      const candidatePath = path.resolve(downloadsDir, `${baseFileName}.${ext}`);
      if (!candidatePath.startsWith(downloadsDir + path.sep)) continue;
      if (fs.existsSync(candidatePath)) {
        const st = fs.statSync(candidatePath);
        if (st.isFile() && st.size > 0) {
          const indexed = await indexSingleFile(candidatePath, musicDir, {
            title: resolvedTitle,
            artist: resolvedArtist,
            album: resolvedAlbum,
          });
          db.prepare(
            "UPDATE tracks SET youtube_video_id = ? WHERE id = ? AND (youtube_video_id IS NULL OR youtube_video_id = '')"
          ).run(videoId, indexed.id);
          const track = loadCanonicalTrackRow(indexed.id, input.userId, candidatePath);
          return {track, filePath: candidatePath, alreadyExists: true};
        }
      }
    }

    const ffmpegPath = getFfmpegPath();
    const cropCover = getSetting('ytdlp_crop_cover', 'true') === 'true';
    const dlUuid = crypto.randomUUID();
    const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlab-nas-dl-'));
    let tempCookiePath: string | null = null;

    try {
      const outTemplate = path.join(tmpWorkDir, `${dlUuid}.%(ext)s`);

      const buildYtdlpArgs = (cookiePath: string | null): string[] => {
        const args = [
          '--no-playlist',
          '--no-warnings',
          '--js-runtimes',
          'node',
          '--force-ipv4',
          '-f',
          YDL_FORMAT_AUDIO_DOWNLOAD,
          '--add-metadata',
          '--ffmpeg-location',
          ffmpegPath,
        ];
        if (getSetting('ytdlp_remote_components', 'true') === 'true') {
          args.push('--remote-components', 'ejs:github');
        }
        if (cookiePath) {
          args.push('--cookies', cookiePath);
        }
        args.push('-o', outTemplate, '--', targetUrl);
        return args;
      };

      try {
        await execYtdlp(buildYtdlpArgs(null), {timeout: 180_000});
      } catch (anonErr) {
        const msg = anonErr instanceof Error ? anonErr.message : String(anonErr);
        if (!isRecoverableCookieError(msg) || !hasConfiguredCookies()) {
          throw anonErr;
        }
        cleanUuidTempAudioFiles(tmpWorkDir, dlUuid);
        tempCookiePath = createTempCookiesCopy();
        await execYtdlp(buildYtdlpArgs(tempCookiePath), {timeout: 180_000});
      }

      const downloadedPath = findUuidDownloadedAudio(tmpWorkDir, dlUuid);
      if (!downloadedPath || !fs.existsSync(downloadedPath)) {
        throw new Error('yt-dlp finished without producing an audio file');
      }

      // Fetch clean square cover art (preferring high-res Deezer coverUrl if provided)
      let coverPath = await downloadCoverImageToTemp(tmpWorkDir, dlUuid, rawCoverUrl, videoId);
      if (coverPath && cropCover) {
        const croppedCover = path.join(tmpWorkDir, `${dlUuid}-cover-sq.jpg`);
        try {
          await execFileAsync(
            ffmpegPath,
            [
              '-y',
              '-i',
              coverPath,
              '-vf',
              "crop='min(iw,ih)':'min(iw,ih)'",
              '-q:v',
              '2',
              croppedCover,
            ],
            {timeout: 25_000}
          );
          if (fs.existsSync(croppedCover) && fs.statSync(croppedCover).size > 0) {
            coverPath = croppedCover;
          }
        } catch {
          // Keep original cover if crop fails
        }
      }

      // Keep original codec with zero re-encoding; remux video fallbacks to audio-only via `-vn -c:a copy`
      const remuxed = await remuxDownloadedAudioLossless({
        ffmpegPath,
        downloadedPath,
        tmpWorkDir,
        filePrefix: dlUuid,
        title: resolvedTitle,
        artist: resolvedArtist,
        album: resolvedAlbum,
        coverPath,
      });

      const finalAudioPath = path.resolve(downloadsDir, `${baseFileName}.${remuxed.ext}`);
      if (!finalAudioPath.startsWith(downloadsDir + path.sep)) {
        throw new Error('Destination file path escaped Downloads directory');
      }

      // Atomically save into <music_dir>/Downloads/<Sanitized Artist> - <Sanitized Title>.<ext>
      const stagedPath = path.join(downloadsDir, `.${dlUuid}.part`);
      try {
        fs.copyFileSync(remuxed.outputPath, stagedPath);
        fs.renameSync(stagedPath, finalAudioPath);
      } finally {
        if (fs.existsSync(stagedPath)) {
          try {
            fs.unlinkSync(stagedPath);
          } catch {
            // ignore
          }
        }
      }

      const fileHash = await computeFileSha256(finalAudioPath);
      const indexed = await indexSingleFile(finalAudioPath, musicDir, {
        fileHash,
        title: resolvedTitle,
        artist: resolvedArtist,
        album: resolvedAlbum,
        coverFilePath: coverPath,
      });

      db.prepare(
        "UPDATE tracks SET youtube_video_id = ? WHERE id = ? AND (youtube_video_id IS NULL OR youtube_video_id = '')"
      ).run(videoId, indexed.id);

      const track = loadCanonicalTrackRow(indexed.id, input.userId, finalAudioPath);
      return {track, filePath: finalAudioPath, alreadyExists: false};
    } finally {
      if (tempCookiePath && fs.existsSync(tempCookiePath)) {
        try {
          fs.unlinkSync(tempCookiePath);
        } catch {
          // ignore
        }
      }
      try {
        fs.rmSync(tmpWorkDir, {recursive: true, force: true});
      } catch {
        // ignore
      }
    }
  })();

  inFlightNasDownloads.set(dedupeKey, workPromise);
  try {
    return await workPromise;
  } finally {
    if (inFlightNasDownloads.get(dedupeKey) === workPromise) {
      inFlightNasDownloads.delete(dedupeKey);
    }
  }
}

export async function testCookiesFile(): Promise<{
  ok: boolean;
  status: 'active' | 'expired' | 'missing' | 'unavailable';
  message: string;
}> {
  if (!fs.existsSync(COOKIES_FILE) || fs.statSync(COOKIES_FILE).size === 0) {
    setSetting('cookies_status', 'missing');
    return {ok: false, status: 'missing', message: 'No cookies.txt file uploaded yet.'};
  }

  const ytdlpPath = getYtdlpPath();
  const tempCookiePath = createTempCookiesCopy();
  try {
    const args = [
      '--simulate',
      '--no-warnings',
      '--skip-download',
      ...buildResilienceArgs(tempCookiePath),
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    ];
    await execFileAsync(ytdlpPath, args, {timeout: 25000});
    setSetting('cookies_status', 'active');
    setSetting('cookies_tested_at', new Date().toISOString());
    return {
      ok: true,
      status: 'active',
      message: 'Cookies validated successfully with yt-dlp.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return {
        ok: false,
        status: 'unavailable',
        message: `Cannot test cookies because "${ytdlpPath}" is not installed on this host.`,
      };
    }
    setSetting('cookies_status', 'expired');
    setSetting('cookies_tested_at', new Date().toISOString());
    return {
      ok: false,
      status: 'expired',
      message: `Cookies test failed: ${msg.slice(0, 260)}`,
    };
  } finally {
    if (tempCookiePath && fs.existsSync(tempCookiePath)) {
      try {
        fs.unlinkSync(tempCookiePath);
      } catch {
        // ignore
      }
    }
  }
}

export async function updateYtdlpBinary(): Promise<{
  ok: boolean;
  output: string;
  version: string | null;
}> {
  const ytdlpPath = getYtdlpPath();
  try {
    const {stdout, stderr} = await execFileAsync(ytdlpPath, ['-U'], {timeout: 60000});
    const status = await checkBinariesStatus();
    return {
      ok: true,
      output: `${stdout}\n${stderr}`.trim(),
      version: status.ytdlp.version,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      output: msg.includes('ENOENT')
        ? `yt-dlp binary ("${ytdlpPath}") is not installed on this host.`
        : msg,
      version: null,
    };
  }
}


export function spawnAudioPreviewStream(videoUrl: string) {
  const ytdlpPath = getYtdlpPath();
  const ffmpegPath = getFfmpegPath();
  const tempCookiePath = createTempCookiesCopy();
  const ytArgs = [
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    ...buildResilienceArgs(tempCookiePath, {includeSleep: false}),
    '-o',
    '-',
    videoUrl,
  ];
  const ytProc = spawn(ytdlpPath, ytArgs, {stdio: ['ignore', 'pipe', 'pipe']});
  const ffProc = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-acodec',
      'libmp3lame',
      '-b:a',
      '128k',
      '-f',
      'mp3',
      'pipe:1',
    ],
    {stdio: ['pipe', 'pipe', 'pipe']}
  );
  ytProc.stdout.pipe(ffProc.stdin);
  ytProc.stderr.on('data', (d) => console.error('[preview-ytdlp]', d.toString().trim()));
  ffProc.stderr.on('data', (d) => console.error('[preview-ffmpeg]', d.toString().trim()));
  ffProc.stdin.on('error', () => {});
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    const terminate = (child: ChildProcess) => {
      try {
        if (child.exitCode === null && child.signalCode === null && !child.killed) {
          child.kill('SIGTERM');
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
            }
          }, 1500);
          timer.unref();
          child.once('exit', () => clearTimeout(timer));
        }
      } catch {
        // ignore
      }
    };
    terminate(ytProc);
    terminate(ffProc);
    if (tempCookiePath) {
      try {
        if (fs.existsSync(tempCookiePath)) fs.unlinkSync(tempCookiePath);
      } catch {
        // ignore
      }
    }
  };
  ytProc.on('error', cleanup);
  ffProc.on('exit', cleanup);
  ffProc.on('close', cleanup);
  ffProc.on('error', cleanup);
  return {stream: ffProc.stdout, cleanup};
}

export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_STREAM_MEMO_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory memo TTL
const YT_STREAM_NEGATIVE_TTL_MS = 20 * 1000; // 20 seconds negative memo TTL
const YT_STREAM_CACHE_MAX_ENTRIES = 512;
const YT_STREAM_EXPIRY_SAFETY_MARGIN_SEC = 60;
const YT_THUMB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const YT_THUMB_CACHE_MAX_ENTRIES = 1000;
const TRACK_VIDEO_MAP_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const TRACK_VIDEO_CACHE_MAX_ENTRIES = 2000;

// Download-tier selector (library & playlist downloads ONLY): uncapped best audio,
// keeping the original codec and remuxing video fallbacks to audio-only without re-encoding.
export const YDL_FORMAT_AUDIO_DOWNLOAD =
  'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]';

// Preview-tier selector: prefers low-overhead AAC 128k / Opus 160k streams first,
// with trailing fallbacks so high-bitrate or progressive-only videos still resolve.
export const YDL_FORMAT_AUDIO_PREVIEW =
  'bestaudio[ext=m4a][abr<=130]/bestaudio[ext=webm][abr<=170]/' +
  'worstaudio[ext=m4a]/worstaudio[ext=webm]/worst[acodec!=none]/' +
  'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/worst[acodec!=none]';

// Realistic configurable timeouts (Node EJS challenge solving on a small VPS can take 10-30s)
const DEFAULT_RESOLVE_PRIMARY_TIMEOUT_MS = 35_000;
const DEFAULT_RESOLVE_FALLBACK_TIMEOUT_MS = 30_000;
const YT_PROBE_TIMEOUT_MS = 8_000;

// Sliding-window per-strategy 403 circuit breaker defaults
const DEFAULT_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_CIRCUIT_MIN_FAILURES = 5;
const DEFAULT_CIRCUIT_MIN_DISTINCT_VIDEOS = 3;

// Per-video direct-proxy 403 negative cache (fast handoff to yt-dlp pipe fallback)
const DEFAULT_VIDEO_NEG_CACHE_TTL_MS = 15 * 60 * 1000;
const AD_GATE_NEG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min TTL when ad-gate polling window exhausts
const VIDEO_NEG_CACHE_MAX_ENTRIES = 500;

// TV ad-gate polling defaults (single-URL poll; no re-resolve on exhaustion)
const DEFAULT_AD_GATE_POLL_MS = 500;
const DEFAULT_AD_GATE_MAX_WAIT_MS = 12_000;
const DEFAULT_AD_GATE_MAX_WAIT_PREFETCH_MS = 25_000;
const AD_GATE_HISTOGRAM_WINDOW_SIZE = 200;
const AD_GATE_HISTOGRAM_LOG_EVERY = 50;

// Short global upstream backoff — opened ONLY when the ad-gate polling window is exhausted
const DEFAULT_UPSTREAM_BACKOFF_SEC = 30;

// Direct yt-dlp pipe fallback startup timeout (covers pipe's own resolve + yt-dlp ad sleep)
const DEFAULT_PIPE_STARTUP_TIMEOUT_MS = 30_000;

// Cached YouTube visitor_data from sw.js_data (1 h TTL, 60 s cooldown on rejection/error)
const VISITOR_DATA_URL = 'https://www.youtube.com/sw.js_data';
const VISITOR_DATA_TTL_MS = 60 * 60 * 1000; // 1 hour
const VISITOR_DATA_COOLDOWN_MS = 60 * 1000; // 60 seconds

const LEGACY_SEEDED_PLAYER_CLIENT = 'web,mweb,android_vr';

const ALLOWED_YT_MEDIA_HOST_SUFFIXES = [
  '.googlevideo.com',
  '.youtube.com',
  '.ytimg.com',
  '.googleusercontent.com',
];

export type StreamResolvePriority = 'playback' | 'prefetch';

export type YouTubeStreamStrategy =
  | 'visionos'
  | 'android-vr-fast'
  | 'default'
  | 'tv-android-vr'
  | 'custom-client'
  | 'po-token-mobile'
  | 'default-cookies'
  | 'tv-cookies';

export interface ResolvedYouTubeAudioStream {
  url: string;
  headers: Record<string, string>;
  strategy: YouTubeStreamStrategy;
  thumbnailUrl: string;
  contentType: string;
  contentLength: number | null;
  duration: number | null;
  clientParam?: string | null;
  formatId?: string;
  adGateWaitedMs?: number;
  usedFormatHeaders?: boolean;
  egress?: string;
  resolvedAtSec?: number;
  expiresAtSec?: number | null;
}

export class DirectProxyCircuitOpenError extends Error {
  readonly cooldownRemainingMs: number;

  constructor(cooldownRemainingMs: number) {
    super(
      `All direct upstream HTTP proxy strategies are in cooldown (${Math.ceil(cooldownRemainingMs / 1000)}s remaining)`
    );
    this.name = 'DirectProxyCircuitOpenError';
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

interface ExecFileError extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function parseClampedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function getResolvePrimaryTimeoutMs(): number {
  const envVal = process.env.YTDLP_RESOLVE_PRIMARY_TIMEOUT_MS?.trim();
  if (envVal) return parseClampedInt(envVal, DEFAULT_RESOLVE_PRIMARY_TIMEOUT_MS, 10_000, 90_000);
  return parseClampedInt(
    getSetting('ytdlp_resolve_timeout_ms', String(DEFAULT_RESOLVE_PRIMARY_TIMEOUT_MS)),
    DEFAULT_RESOLVE_PRIMARY_TIMEOUT_MS,
    10_000,
    90_000
  );
}

function getResolveFallbackTimeoutMs(): number {
  const envVal = process.env.YTDLP_RESOLVE_FALLBACK_TIMEOUT_MS?.trim();
  if (envVal) return parseClampedInt(envVal, DEFAULT_RESOLVE_FALLBACK_TIMEOUT_MS, 10_000, 90_000);
  return parseClampedInt(
    getSetting('ytdlp_resolve_fallback_timeout_ms', String(DEFAULT_RESOLVE_FALLBACK_TIMEOUT_MS)),
    DEFAULT_RESOLVE_FALLBACK_TIMEOUT_MS,
    10_000,
    90_000
  );
}

function getCircuitWindowMs(): number {
  return parseClampedInt(
    process.env.YTDLP_CIRCUIT_WINDOW_MS?.trim(),
    DEFAULT_CIRCUIT_WINDOW_MS,
    60_000,
    60 * 60 * 1000
  );
}

function getCircuitCooldownMs(): number {
  return parseClampedInt(
    process.env.YTDLP_CIRCUIT_COOLDOWN_MS?.trim(),
    DEFAULT_CIRCUIT_COOLDOWN_MS,
    60_000,
    60 * 60 * 1000
  );
}

function getCircuitMinFailures(): number {
  return parseClampedInt(
    process.env.YTDLP_CIRCUIT_MIN_FAILURES?.trim(),
    DEFAULT_CIRCUIT_MIN_FAILURES,
    2,
    50
  );
}

function getCircuitMinDistinctVideos(): number {
  return parseClampedInt(
    process.env.YTDLP_CIRCUIT_MIN_DISTINCT_VIDEOS?.trim(),
    DEFAULT_CIRCUIT_MIN_DISTINCT_VIDEOS,
    2,
    20
  );
}

function getVideoNegCacheTtlMs(): number {
  return parseClampedInt(
    process.env.YTDLP_VIDEO_NEG_CACHE_TTL_MS?.trim(),
    DEFAULT_VIDEO_NEG_CACHE_TTL_MS,
    60_000,
    60 * 60 * 1000
  );
}

function getMaxConcurrentResolves(): number {
  return parseClampedInt(process.env.YTDLP_MAX_CONCURRENT_RESOLVES?.trim(), 2, 1, 6);
}

function getAdGatePollMs(): number {
  return parseClampedInt(
    process.env.YT_AD_GATE_POLL_MS?.trim(),
    DEFAULT_AD_GATE_POLL_MS,
    200,
    5_000
  );
}

function getAdGateMaxWaitMs(): number {
  return parseClampedInt(
    process.env.YT_AD_GATE_MAX_WAIT_MS?.trim(),
    DEFAULT_AD_GATE_MAX_WAIT_MS,
    1_000,
    60_000
  );
}

function getAdGateMaxWaitPrefetchMs(): number {
  return parseClampedInt(
    process.env.YT_AD_GATE_MAX_WAIT_PREFETCH_MS?.trim(),
    DEFAULT_AD_GATE_MAX_WAIT_PREFETCH_MS,
    1_000,
    120_000
  );
}

export function getPipeStartupTimeoutMs(): number {
  return parseClampedInt(
    process.env.YT_PIPE_STARTUP_TIMEOUT_MS?.trim(),
    DEFAULT_PIPE_STARTUP_TIMEOUT_MS,
    5_000,
    120_000
  );
}

export function getUpstreamBackoffSec(): number {
  return parseClampedInt(
    process.env.YT_UPSTREAM_BACKOFF_SEC?.trim(),
    DEFAULT_UPSTREAM_BACKOFF_SEC,
    5,
    300
  );
}

export function isPreferVisionosEnabled(): boolean {
  const raw = process.env.YT_PREFER_VISIONOS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function isFastPathDisabledByEnv(): boolean {
  const raw = process.env.YT_DISABLE_FAST_PATH?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

const FAST_PATH_BOT_FAILURE_THRESHOLD = 3;
const FAST_PATH_AUTO_DISABLE_MS = 30 * 60 * 1000; // 30 minutes
const FAST_PATH_BOT_CHECK_RE = /sign in to confirm you(?:'|’)?re not a bot/i;

let fastPathConsecutiveBotFailures = 0;
let fastPathAutoDisabledUntilMs = 0;

function isAndroidVrFastPathDisabled(now = Date.now()): boolean {
  if (isFastPathDisabledByEnv()) {
    return true;
  }
  if (fastPathAutoDisabledUntilMs > 0) {
    if (now < fastPathAutoDisabledUntilMs) {
      return true;
    }
    fastPathAutoDisabledUntilMs = 0;
    fastPathConsecutiveBotFailures = 0;
    console.info(
      '[yt-stream-resolve] android-vr-fast auto-disable expired after 30m; re-enabling fast path for retry'
    );
  }
  return false;
}

function recordAndroidVrFastPathSuccess(): void {
  fastPathConsecutiveBotFailures = 0;
  fastPathAutoDisabledUntilMs = 0;
}

function recordAndroidVrFastPathFailure(detail: string): void {
  if (FAST_PATH_BOT_CHECK_RE.test(detail)) {
    fastPathConsecutiveBotFailures += 1;
    if (
      fastPathConsecutiveBotFailures >= FAST_PATH_BOT_FAILURE_THRESHOLD &&
      fastPathAutoDisabledUntilMs === 0
    ) {
      fastPathAutoDisabledUntilMs = Date.now() + FAST_PATH_AUTO_DISABLE_MS;
      console.warn(
        `[yt-stream-resolve] android-vr-fast rejected with bot check ${fastPathConsecutiveBotFailures} times in a row; auto-disabling fast path for 30 minutes`
      );
    }
  } else {
    fastPathConsecutiveBotFailures = 0;
  }
}

function isDebugCompareEnabled(): boolean {
  const raw = process.env.YT_DEBUG_COMPARE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

// Short global upstream backoff — opened ONLY after the ad-gate polling window is exhausted,
// never on a first-probe 403.
let upstreamBlockedUntilMs = 0;

export function upstreamBackoffRemainingSec(): number {
  const remainingMs = upstreamBlockedUntilMs - Date.now();
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export function openUpstreamBackoff(videoId: string, statusCode: number, reason: string): number {
  const backoffSec = getUpstreamBackoffSec();
  const target = Date.now() + backoffSec * 1000;
  if (target > upstreamBlockedUntilMs) {
    upstreamBlockedUntilMs = target;
  }
  const remainingSec = upstreamBackoffRemainingSec();
  console.warn(
    '[yt-stream-backoff]',
    JSON.stringify({
      event: 'upstream_backoff_opened',
      videoId,
      status: statusCode,
      reason,
      pauseSec: remainingSec,
    })
  );
  return remainingSec;
}

export function clearUpstreamBackoff(): void {
  if (upstreamBlockedUntilMs > 0) {
    upstreamBlockedUntilMs = 0;
  }
}

// Rolling in-memory histogram of ad-gate clear times (last 200 cleared gates; logs every 50)
const adGateClearedWaitsMs: number[] = [];
let adGateClearedTotalCount = 0;

function computeNearestRankPercentile(sortedAsc: number[], percentile: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedAsc.length) - 1)
  );
  return sortedAsc[idx];
}

function recordAdGateClearedWait(waitedMs: number): void {
  const safeMs = Number.isFinite(waitedMs) && waitedMs >= 0 ? Math.round(waitedMs) : 0;
  adGateClearedWaitsMs.push(safeMs);
  if (adGateClearedWaitsMs.length > AD_GATE_HISTOGRAM_WINDOW_SIZE) {
    adGateClearedWaitsMs.shift();
  }
  adGateClearedTotalCount += 1;

  if (adGateClearedTotalCount % AD_GATE_HISTOGRAM_LOG_EVERY === 0) {
    const sorted = [...adGateClearedWaitsMs].sort((a, b) => a - b);
    console.info(
      '[yt-stream-ad-gate-stats]',
      JSON.stringify({
        event: 'ad_gate_clear_histogram',
        totalCleared: adGateClearedTotalCount,
        windowSize: sorted.length,
        p50Ms: computeNearestRankPercentile(sorted, 50),
        p90Ms: computeNearestRankPercentile(sorted, 90),
        maxMs: sorted[sorted.length - 1] ?? 0,
        minMs: sorted[0] ?? 0,
        currentMaxWaitMs: getAdGateMaxWaitMs(),
        currentPollMs: getAdGatePollMs(),
      })
    );
  }
}

/**
 * Optional opt-in PO token provider URL (e.g. http://bgutil-provider:4416).
 * Reads POT_PROVIDER_URL (preferred) or legacy YTDLP_POT_PROVIDER_URL.
 * Validated strictly so it cannot inject extra extractor arguments.
 */
export function getPoTokenProviderBaseUrl(): string | null {
  const raw =
    process.env.POT_PROVIDER_URL?.trim() || process.env.YTDLP_POT_PROVIDER_URL?.trim() || '';
  if (!raw || /[\s;\r\n'"`]/.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname) return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function hasPoTokenProvider(): boolean {
  return getPoTokenProviderBaseUrl() !== null;
}

function appendPoTokenExtractorArgs(args: string[]): void {
  const baseUrl = getPoTokenProviderBaseUrl();
  if (baseUrl) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${baseUrl}`);
  }
}

function getCustomConfiguredPlayerClient(): string | null {
  const raw = getSetting('ytdlp_player_client', '').trim();
  if (!raw) return null;
  // Ignore the legacy seeded 'web,mweb,android_vr' default unless a PO token provider is configured
  if (raw.toLowerCase() === LEGACY_SEEDED_PLAYER_CLIENT && !hasPoTokenProvider()) {
    return null;
  }
  if (!/^[a-z0-9_,+-]+$/i.test(raw)) return null;
  return raw;
}

// Priority-aware semaphore capping concurrent yt-dlp resolver child processes on small VPS hosts.
// Reserves 1 slot for interactive playback when maxSlots >= 2 and lets playback jump ahead of prefetch.
interface ResolveSlotWaiter {
  priority: StreamResolvePriority;
  videoId?: string;
  wake: () => void;
}

let activeResolveSlots = 0;
const resolveWaitQueue: ResolveSlotWaiter[] = [];

function canAcquireResolveSlot(priority: StreamResolvePriority): boolean {
  const maxSlots = getMaxConcurrentResolves();
  if (priority === 'playback') {
    return activeResolveSlots < maxSlots;
  }
  if (resolveWaitQueue.some((w) => w.priority === 'playback')) {
    return false;
  }
  const prefetchCap = maxSlots >= 2 ? maxSlots - 1 : 1;
  return activeResolveSlots < prefetchCap;
}

export function hasAvailablePrefetchResolveSlot(): boolean {
  return canAcquireResolveSlot('prefetch');
}

export function isResolverQueueBusy(): boolean {
  return activeResolveSlots > 0 || resolveWaitQueue.length > 0;
}

function drainResolveWaitQueue(): void {
  while (resolveWaitQueue.length > 0) {
    const playbackIdx = resolveWaitQueue.findIndex((w) => w.priority === 'playback');
    if (playbackIdx !== -1 && canAcquireResolveSlot('playback')) {
      const [waiter] = resolveWaitQueue.splice(playbackIdx, 1);
      activeResolveSlots += 1;
      waiter.wake();
      continue;
    }
    const prefetchIdx = resolveWaitQueue.findIndex((w) => w.priority === 'prefetch');
    if (prefetchIdx !== -1 && canAcquireResolveSlot('prefetch')) {
      const [waiter] = resolveWaitQueue.splice(prefetchIdx, 1);
      activeResolveSlots += 1;
      waiter.wake();
      continue;
    }
    break;
  }
}

export async function withYtdlpResolveSlot<T>(
  fn: () => Promise<T>,
  priority: StreamResolvePriority = 'playback',
  videoId?: string
): Promise<T> {
  if (canAcquireResolveSlot(priority)) {
    activeResolveSlots += 1;
  } else {
    await new Promise<void>((wake) => {
      resolveWaitQueue.push({priority, videoId, wake});
    });
  }
  try {
    return await fn();
  } finally {
    activeResolveSlots -= 1;
    drainResolveWaitQueue();
  }
}

// Shared mutable per-videoId control object so promoting a prefetch to playback caps the active
// ad-gate poll window in place without restarting the probe.
interface ActiveAdGateControl {
  priority: StreamResolvePriority;
  promotedAtMs: number | null;
}

const activeAdGateControls = new Map<string, ActiveAdGateControl>();

export function promoteInFlightAdGateToPlayback(videoId: string): void {
  if (!isValidYouTubeVideoId(videoId)) return;
  const control = activeAdGateControls.get(videoId);
  if (control && control.priority !== 'playback') {
    control.priority = 'playback';
    control.promotedAtMs = Date.now();
  }
  let promotedWaiter = false;
  for (const waiter of resolveWaitQueue) {
    if (waiter.videoId === videoId && waiter.priority !== 'playback') {
      waiter.priority = 'playback';
      promotedWaiter = true;
    }
  }
  if (promotedWaiter) {
    drainResolveWaitQueue();
  }
}

// Sliding-window per-strategy circuit breaker state.
// A strategy's circuit opens ONLY when, within the sliding window:
//   - windowSuccesses === 0 (any recent success keeps the strategy healthy), AND
//   - windowFailures >= minFailures (default 5), AND
//   - distinctFailedVideos >= minDistinctVideos (default 3).
interface StrategyCircuitState {
  successes: number[];
  failures: Array<{ts: number; videoId: string}>;
  openUntil: number;
}

const strategyCircuits = new Map<YouTubeStreamStrategy, StrategyCircuitState>();

function pruneStrategyWindow(state: StrategyCircuitState, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  if (state.successes.length > 0) {
    state.successes = state.successes.filter((ts) => ts >= cutoff).slice(-200);
  }
  if (state.failures.length > 0) {
    state.failures = state.failures.filter((f) => f.ts >= cutoff).slice(-200);
  }
}

function getActiveStrategiesForCircuit(): YouTubeStreamStrategy[] {
  const list: YouTubeStreamStrategy[] = [];
  if (isPreferVisionosEnabled()) {
    list.push('visionos');
  }
  list.push('default', 'tv-android-vr');
  if (getCustomConfiguredPlayerClient()) {
    list.push('custom-client');
  }
  if (hasPoTokenProvider()) {
    list.push('po-token-mobile');
  }
  if (hasConfiguredCookies()) {
    list.push('default-cookies', 'tv-cookies');
  }
  return list;
}

export function isStrategyCircuitOpen(strategy: YouTubeStreamStrategy): boolean {
  const state = strategyCircuits.get(strategy);
  if (!state || state.openUntil === 0) return false;
  const now = Date.now();
  if (now < state.openUntil) {
    return true;
  }
  // Cooldown expired — close circuit and reset failure window for clean probation
  state.openUntil = 0;
  state.failures = [];
  pruneStrategyWindow(state, now, getCircuitWindowMs());
  console.info(
    '[yt-stream-circuit]',
    JSON.stringify({
      event: 'circuit_closed',
      reason: 'cooldown_expired',
      strategy,
      cooldownMs: getCircuitCooldownMs(),
    })
  );
  return false;
}

export function getStrategyCircuitCooldownRemainingMs(strategy: YouTubeStreamStrategy): number {
  if (!isStrategyCircuitOpen(strategy)) return 0;
  const state = strategyCircuits.get(strategy);
  return state ? Math.max(0, state.openUntil - Date.now()) : 0;
}

export function recordStrategy403Rejection(
  strategy: YouTubeStreamStrategy,
  videoId: string,
  context?: string
): boolean {
  const now = Date.now();
  const windowMs = getCircuitWindowMs();
  const cooldownMs = getCircuitCooldownMs();
  const minFailures = getCircuitMinFailures();
  const minDistinctVideos = getCircuitMinDistinctVideos();

  let state = strategyCircuits.get(strategy);
  if (!state) {
    state = {successes: [], failures: [], openUntil: 0};
    strategyCircuits.set(strategy, state);
  }
  if (state.openUntil > now) {
    return true;
  }

  pruneStrategyWindow(state, now, windowMs);
  state.failures.push({ts: now, videoId: videoId || 'unknown'});

  const windowSuccesses = state.successes.length;
  const windowFailures = state.failures.length;
  const distinctFailedVideos = new Set(state.failures.map((f) => f.videoId)).size;

  if (
    windowSuccesses === 0 &&
    windowFailures >= minFailures &&
    distinctFailedVideos >= minDistinctVideos
  ) {
    state.openUntil = now + cooldownMs;
    console.warn(
      '[yt-stream-circuit]',
      JSON.stringify({
        event: 'circuit_opened',
        strategy,
        context: context || '403',
        windowSuccesses,
        windowFailures,
        distinctFailedVideos,
        windowMs,
        cooldownMs,
      })
    );
    return true;
  }
  return false;
}

export function recordStrategyDirectSuccess(
  strategy: YouTubeStreamStrategy,
  videoId?: string
): void {
  const now = Date.now();
  const windowMs = getCircuitWindowMs();
  let state = strategyCircuits.get(strategy);
  if (!state) {
    state = {successes: [], failures: [], openUntil: 0};
    strategyCircuits.set(strategy, state);
  }
  const wasOpen = state.openUntil > 0;
  pruneStrategyWindow(state, now, windowMs);
  state.successes.push(now);
  state.openUntil = 0;

  if (videoId && isValidYouTubeVideoId(videoId)) {
    clearVideoDirectProxyNegative(videoId);
  }

  if (wasOpen) {
    console.info(
      '[yt-stream-circuit]',
      JSON.stringify({
        event: 'circuit_closed',
        reason: 'direct_success',
        strategy,
        videoId: videoId || null,
        windowSuccesses: state.successes.length,
        windowFailures: state.failures.length,
      })
    );
  }
}

export function isDirectProxyCircuitOpen(): boolean {
  const active = getActiveStrategiesForCircuit();
  return active.length > 0 && active.every((s) => isStrategyCircuitOpen(s));
}

export function getDirectProxyCircuitCooldownRemainingMs(): number {
  const active = getActiveStrategiesForCircuit();
  if (active.length === 0) return 0;
  let minRemaining = Infinity;
  for (const s of active) {
    const rem = getStrategyCircuitCooldownRemainingMs(s);
    if (rem === 0) return 0;
    if (rem < minRemaining) minRemaining = rem;
  }
  return Number.isFinite(minRemaining) ? minRemaining : 0;
}

// Per-video negative cache: remembers videos whose direct googlevideo URL 403d so
// subsequent plays/seeks hand off immediately to the yt-dlp pipe fallback for 15m.
const videoDirectNegativeCache = new Map<string, {reason: string; expiresAt: number}>();

export function markVideoDirectProxyNegative(
  videoId: string,
  reason: string,
  ttlMsOverride?: number
): void {
  if (!isValidYouTubeVideoId(videoId)) return;
  const now = Date.now();
  const ttlMs =
    typeof ttlMsOverride === 'number' && Number.isFinite(ttlMsOverride) && ttlMsOverride > 0
      ? Math.round(ttlMsOverride)
      : getVideoNegCacheTtlMs();
  if (videoDirectNegativeCache.size >= VIDEO_NEG_CACHE_MAX_ENTRIES) {
    for (const [k, v] of videoDirectNegativeCache.entries()) {
      if (v.expiresAt <= now) videoDirectNegativeCache.delete(k);
    }
    if (videoDirectNegativeCache.size >= VIDEO_NEG_CACHE_MAX_ENTRIES) {
      const oldestKey = videoDirectNegativeCache.keys().next().value;
      if (oldestKey) videoDirectNegativeCache.delete(oldestKey);
    }
  }
  videoDirectNegativeCache.set(videoId, {reason, expiresAt: now + ttlMs});
  console.info(
    '[yt-stream-negcache]',
    JSON.stringify({
      event: 'video_marked_pipe_only',
      videoId,
      reason,
      ttlMs,
    })
  );
}

export function clearVideoDirectProxyNegative(videoId: string): void {
  videoDirectNegativeCache.delete(videoId);
}

export function getVideoDirectProxyNegativeInfo(
  videoId: string
): {reason: string; remainingMs: number} | null {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const entry = videoDirectNegativeCache.get(videoId);
  if (!entry) return null;
  const remainingMs = entry.expiresAt - Date.now();
  if (remainingMs <= 0) {
    videoDirectNegativeCache.delete(videoId);
    return null;
  }
  return {reason: entry.reason, remainingMs};
}

export function isVideoDirectProxyNegative(videoId: string): boolean {
  return getVideoDirectProxyNegativeInfo(videoId) !== null;
}

const HOP_BY_HOP_AND_EXCLUDED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'range',
  'accept-encoding',
]);

function sanitizeStreamHeaders(raw: unknown): Record<string, string> {
  const cleaned: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return cleaned;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey || !trimmedValue) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmedKey)) continue;
    if (/[\r\n]/.test(trimmedValue)) continue;
    if (HOP_BY_HOP_AND_EXCLUDED_HEADERS.has(trimmedKey.toLowerCase())) continue;
    cleaned[trimmedKey] = trimmedValue;
  }
  return cleaned;
}

/**
 * Use ONLY the selected format's own `http_headers` when present.
 * Fall back to top-level `data.http_headers` ONLY when the selected format has none.
 * Never merge generic top-level browser headers (e.g. Chrome UA / Sec-Fetch-Mode)
 * into a format that already provides client-specific headers.
 */
function selectFormatStreamHeaders(
  data: {http_headers?: unknown; format_id?: unknown; formats?: RawYtdlpFormat[]},
  primaryFormat: RawYtdlpFormat
): {headers: Record<string, string>; usedFormatHeaders: boolean} {
  // If primaryFormat is the top-level data object itself, check whether formats[]
  // holds a more specific format entry for the same format_id.
  let formatRawHeaders = primaryFormat.http_headers;
  if (primaryFormat === (data as unknown as RawYtdlpFormat) && Array.isArray(data.formats)) {
    const targetId = String(data.format_id ?? '').trim();
    if (targetId) {
      const matchedFmt = data.formats.find(
        (f) => String(f?.format_id ?? '').trim() === targetId && f?.http_headers
      );
      if (matchedFmt?.http_headers) {
        formatRawHeaders = matchedFmt.http_headers;
      }
    }
  }

  const formatHeaders = sanitizeStreamHeaders(formatRawHeaders);
  if (Object.keys(formatHeaders).length > 0) {
    return {headers: formatHeaders, usedFormatHeaders: true};
  }
  return {
    headers: sanitizeStreamHeaders(data.http_headers),
    usedFormatHeaders: false,
  };
}

export interface SafeStreamUrlInspection {
  client: string | null;
  hasIp: boolean;
  ipFamilyParam: 'IPv4' | 'IPv6' | 'other' | null;
  hasPot: boolean;
  expire: number | null;
  expiresInSec: number | null;
  hasSig: boolean;
  hasLsig: boolean;
  queryKeys: string[];
}

/**
 * Inspects query parameter metadata of a googlevideo URL WITHOUT logging or returning
 * full URLs, signature values, PO token values, or raw IP addresses.
 */
export function inspectYouTubeStreamUrlParams(rawUrl: string): SafeStreamUrlInspection {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) {
    return {
      client: null,
      hasIp: false,
      ipFamilyParam: null,
      hasPot: false,
      expire: null,
      expiresInSec: null,
      hasSig: false,
      hasLsig: false,
      queryKeys: [],
    };
  }
  const hashIndex = rawUrl.indexOf('#', queryIndex);
  const rawQuery = hashIndex === -1 ? rawUrl.slice(queryIndex + 1) : rawUrl.slice(queryIndex + 1, hashIndex);

  const keySet = new Set<string>();
  let client: string | null = null;
  let hasIp = false;
  let ipFamilyParam: 'IPv4' | 'IPv6' | 'other' | null = null;
  let hasPot = false;
  let expire: number | null = null;
  let hasSig = false;
  let hasLsig = false;

  for (const part of rawQuery.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const rawKey = eqIdx === -1 ? part : part.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? '' : part.slice(eqIdx + 1);
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    keySet.add(key);

    if (key === 'c' && rawVal) {
      try {
        client = decodeURIComponent(rawVal).slice(0, 64);
      } catch {
        client = rawVal.slice(0, 64);
      }
    } else if (key === 'ip' && rawVal) {
      hasIp = true;
      let decodedIp = rawVal;
      try {
        decodedIp = decodeURIComponent(rawVal);
      } catch {
        // keep raw
      }
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(decodedIp)) {
        ipFamilyParam = 'IPv4';
      } else if (decodedIp.includes(':')) {
        ipFamilyParam = 'IPv6';
      } else {
        ipFamilyParam = 'other';
      }
    } else if (key === 'pot' && rawVal) {
      hasPot = true;
    } else if (key === 'expire' && rawVal) {
      const n = Number(rawVal);
      if (Number.isFinite(n) && n > 0) expire = Math.round(n);
    } else if ((key === 'sig' || key === 'signature' || key === 's') && rawVal) {
      hasSig = true;
    } else if (key === 'lsig' && rawVal) {
      hasLsig = true;
    }
  }

  const expiresInSec = expire !== null ? Math.round(expire - Date.now() / 1000) : null;
  return {
    client,
    hasIp,
    ipFamilyParam,
    hasPot,
    expire,
    expiresInSec,
    hasSig,
    hasLsig,
    queryKeys: Array.from(keySet).sort(),
  };
}

function classifyClientFamily(
  clientParam: string | null | undefined,
  strategy: YouTubeStreamStrategy
): string {
  if (strategy === 'visionos') return 'visionos';
  if (strategy === 'android-vr-fast') return 'android-vr-fast';
  const c = (clientParam || '').trim().toUpperCase();
  if (c) {
    if (c.includes('VISIONOS')) return 'visionos';
    if (c.startsWith('TV') || c === 'ANDROID_VR') return 'tv-vr';
    if (c.startsWith('WEB')) return 'web';
    if (c.startsWith('MWEB')) return 'mweb';
    if (c.startsWith('IOS')) return 'ios';
    if (c.startsWith('ANDROID')) return 'android';
    return c.toLowerCase();
  }
  if (strategy === 'tv-android-vr' || strategy === 'tv-cookies') return 'tv-vr';
  if (strategy === 'po-token-mobile') return 'mobile-pot';
  return strategy;
}

function summarizeHeadersForLog(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cookie' || lower === 'authorization' || lower === 'proxy-authorization') {
      out[key] = '[REDACTED]';
    } else {
      out[key] = val.length > 160 ? `${val.slice(0, 160)}...` : val;
    }
  }
  return out;
}

function sanitizeStderrForLog(
  rawStderr: unknown,
  tempCookiePath: string | null,
  maxChars = 2000
): string {
  let text =
    typeof rawStderr === 'string'
      ? rawStderr
      : Buffer.isBuffer(rawStderr)
        ? rawStderr.toString('utf-8')
        : '';
  if (tempCookiePath) {
    text = text.split(tempCookiePath).join('<temp-cookies>');
  }
  if (COOKIES_FILE) {
    text = text.split(COOKIES_FILE).join('<cookies-file>');
  }
  text = text.replace(/(cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
  text = text.replace(/https?:\/\/[^\s"'<>]*googlevideo\.com[^\s"'<>]*/gi, '<googlevideo-url>');
  text = text.replace(/([?&](?:sig|signature|lsig|pot|s)=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  return text.trim().slice(0, maxChars);
}

/**
 * Extracts `{hostname, port, rawPath}` directly from an allowlisted HTTPS URL string
 * WITHOUT re-serializing the query string through WHATWG `URL` / `URLSearchParams`.
 * This guarantees byte-for-byte fidelity of signed googlevideo URLs.
 */
function extractRawHttpsTarget(rawUrl: string): {
  hostname: string;
  port: number | undefined;
  rawPath: string;
} {
  const match = rawUrl.match(/^https:\/\/([^/:?#]+)(?::(\d+))?(\/[^#]*)?(?:#.*)?$/);
  if (!match || !match[1]) {
    throw new Error('Malformed upstream HTTPS media URL');
  }
  const hostname = match[1];
  const port = match[2] ? Number(match[2]) : undefined;
  const rawPath = match[3] && match[3].length > 0 ? match[3] : '/';
  return {hostname, port, rawPath};
}

// Strict IPv4-only HTTPS Agent so Node's probe & proxy always match yt-dlp --force-ipv4
// (avoids undici Happy Eyeballs connecting over IPv6 to an IPv4-signed googlevideo URL).
const ipv4Lookup: https.RequestOptions['lookup'] = (hostname, options, callback) => {
  if (typeof options === 'object' && options?.all) {
    dns.lookup(
      hostname,
      {family: 4, all: true},
      callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
    );
    return;
  }
  dns.lookup(
    hostname,
    {family: 4, all: false},
    callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void
  );
};

const ipv4HttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  family: 4,
  lookup: ipv4Lookup,
});

export interface Ipv4MediaResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  finalUrl: string;
  ipFamily: string;
  redirected: boolean;
  stream: IncomingMessage;
  abort: () => void;
}

export async function requestIpv4MediaStream(
  rawUrl: string,
  options: {
    headers: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    maxRedirects?: number;
  }
): Promise<Ipv4MediaResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  let currentUrl = rawUrl;
  let redirected = false;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Strictly validate scheme, hostname allowlist, no credentials, no IP literals on every hop
    if (!isAllowedYouTubeMediaUrl(currentUrl)) {
      throw new Error('Unexpected upstream media host');
    }
    if (options.signal?.aborted) {
      throw new Error('Request aborted');
    }

    // Preserve the exact raw query string verbatim (zero URL/URLSearchParams re-encoding)
    const {hostname, port, rawPath} = extractRawHttpsTarget(currentUrl);
    const response = await new Promise<Ipv4MediaResponse>((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let activeRes: IncomingMessage | null = null;

      const onAbort = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (activeRes && !activeRes.destroyed) {
          activeRes.destroy();
        }
        if (!req.destroyed) {
          req.destroy(new Error('Request aborted'));
        }
        if (!settled) {
          settled = true;
          reject(new Error('Request aborted'));
        }
      };

      const req = https.request(
        {
          hostname,
          port,
          path: rawPath,
          method: 'GET',
          headers: options.headers,
          agent: ipv4HttpsAgent,
          family: 4,
          lookup: ipv4Lookup,
        },
        (res) => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          activeRes = res;
          const ipFamily = res.socket?.remoteFamily || 'IPv4';
          const statusCode = res.statusCode ?? 0;

          const detachSignal = () => {
            options.signal?.removeEventListener('abort', onAbort);
          };
          res.once('end', detachSignal);
          res.once('close', detachSignal);
          res.once('error', detachSignal);

          if (!settled) {
            settled = true;
            resolve({
              statusCode,
              headers: res.headers,
              finalUrl: currentUrl,
              ipFamily,
              redirected,
              stream: res,
              abort: () => {
                detachSignal();
                if (!res.destroyed) res.destroy();
                if (!req.destroyed) req.destroy();
              },
            });
          }
        }
      );

      connectTimer = setTimeout(() => {
        const timeoutErr = new Error(`Upstream IPv4 request timed out after ${options.timeoutMs}ms`);
        req.destroy(timeoutErr);
        if (!settled) {
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          reject(timeoutErr);
        }
      }, options.timeoutMs);
      connectTimer.unref();

      req.on('error', (err) => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        options.signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, {once: true});
      }

      req.end();
    });

    const isRedirect =
      response.statusCode === 301 ||
      response.statusCode === 302 ||
      response.statusCode === 303 ||
      response.statusCode === 307 ||
      response.statusCode === 308;
    const location = typeof response.headers.location === 'string' ? response.headers.location.trim() : '';

    if (isRedirect && location) {
      response.stream.resume();
      response.abort();
      if (hop >= maxRedirects) {
        throw new Error('Too many upstream redirects');
      }
      redirected = true;
      // Preserve absolute https:// Location verbatim without re-encoding query parameters
      currentUrl = /^https:\/\//i.test(location)
        ? location
        : new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error('Too many upstream redirects');
}

// ---------------------------------------------------------------------------
// YouTube visitor_data Cache (sw.js_data, 1 h TTL, 60 s rejection cooldown)
// ---------------------------------------------------------------------------

interface VisitorDataCacheState {
  value: string | null;
  validUntilMs: number;
  retryAtMs: number;
  refreshing: boolean;
}

const visitorDataState: VisitorDataCacheState = {
  value: null,
  validUntilMs: 0,
  retryAtMs: 0,
  refreshing: false,
};

function parseVisitorDataPayload(payload: string): string | null {
  let body = payload.trimStart();
  if (body.startsWith(")]}'")) {
    const nlIdx = body.indexOf('\n');
    body = nlIdx === -1 ? '' : body.slice(nlIdx + 1);
  }
  try {
    const parsed: unknown = JSON.parse(body);
    const walk = (node: unknown): string | null => {
      if (
        typeof node === 'string' &&
        node.length > 20 &&
        node.length <= 160 &&
        /^(?:Cg|Ch|Cs)[A-Za-z0-9_%-]+$/.test(node)
      ) {
        return node;
      }
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = walk(child);
          if (found) return found;
        }
      }
      return null;
    };
    const found = walk(parsed);
    if (found) return found;
  } catch {
    // Fallback to regex scan below
  }
  const match = payload.match(/"(C[a-zA-Z0-9_%-]{20,140})"/);
  return match?.[1] ?? null;
}

function fetchVisitorDataOverIpv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.request(
      VISITOR_DATA_URL,
      {
        method: 'GET',
        agent: ipv4HttpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: '*/*',
        },
        timeout: 5_000,
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        const MAX_BODY_BYTES = 256 * 1024;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total <= MAX_BODY_BYTES) {
            chunks.push(chunk);
          } else {
            res.destroy();
          }
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve(parseVisitorDataPayload(text));
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Returns a cached YouTube visitor_data token (1 h TTL).
 * Non-blocking when a renewal is already in flight so concurrent resolvers never queue.
 */
export async function getVisitorData(): Promise<string | null> {
  if (isFastPathDisabledByEnv()) {
    return null;
  }
  const now = Date.now();
  if (now < visitorDataState.retryAtMs) {
    return null;
  }
  if (visitorDataState.value && now < visitorDataState.validUntilMs) {
    return visitorDataState.value;
  }
  if (visitorDataState.refreshing) {
    return null;
  }
  visitorDataState.refreshing = true;
  try {
    const fetched = await fetchVisitorDataOverIpv4();
    const finished = Date.now();
    if (fetched) {
      visitorDataState.value = fetched;
      visitorDataState.validUntilMs = finished + VISITOR_DATA_TTL_MS;
      visitorDataState.retryAtMs = 0;
      return fetched;
    }
    visitorDataState.value = null;
    visitorDataState.validUntilMs = 0;
    visitorDataState.retryAtMs = finished + VISITOR_DATA_COOLDOWN_MS;
    return null;
  } finally {
    visitorDataState.refreshing = false;
  }
}

export function rejectVisitorData(value: string): void {
  if (!value || visitorDataState.refreshing) return;
  if (visitorDataState.value === value) {
    visitorDataState.value = null;
    visitorDataState.validUntilMs = 0;
    visitorDataState.retryAtMs = Date.now() + VISITOR_DATA_COOLDOWN_MS;
  }
}

// ---------------------------------------------------------------------------
// Three-Layer Resolved Stream URL Cache (5m/20s Single-Flight Memo + SQLite)
// ---------------------------------------------------------------------------

export function getCurrentStreamEgress(): string {
  return 'direct';
}

function getStreamMemoKey(videoId: string): string {
  const egress = getCurrentStreamEgress();
  return egress === 'direct' ? videoId : `${videoId}:${egress}`;
}

const ytStreamUrlCache = new Map<
  string,
  ResolvedYouTubeAudioStream & {resolvedAt: number; expiresAt: number}
>();
const ytStreamNegativeMemo = new Map<string, {reason: string; expiresAt: number}>();
const inFlightResolutions = new Map<string, Promise<ResolvedYouTubeAudioStream>>();
const ytThumbnailCache = new Map<string, {url: string; expiresAt: number}>();

export function isValidYouTubeVideoId(videoId: string): boolean {
  return YOUTUBE_VIDEO_ID_RE.test(videoId);
}

export function isAllowedYouTubeMediaUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  // Reject raw IPv4 / IPv6 literals to prevent loopback or private network SSRF
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return false;
  }
  return (
    host === 'googlevideo.com' ||
    ALLOWED_YT_MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

export function cacheYouTubeThumbnailUrl(videoId: string, rawUrl: string): void {
  if (!isValidYouTubeVideoId(videoId) || !isAllowedYouTubeMediaUrl(rawUrl)) return;
  const now = Date.now();
  if (ytThumbnailCache.size >= YT_THUMB_CACHE_MAX_ENTRIES) {
    for (const [k, entry] of ytThumbnailCache.entries()) {
      if (entry.expiresAt <= now) ytThumbnailCache.delete(k);
    }
    if (ytThumbnailCache.size >= YT_THUMB_CACHE_MAX_ENTRIES) {
      const oldestKey = ytThumbnailCache.keys().next().value;
      if (oldestKey) ytThumbnailCache.delete(oldestKey);
    }
  }
  ytThumbnailCache.set(videoId, {url: rawUrl, expiresAt: now + YT_THUMB_CACHE_TTL_MS});
}

export function getCachedYouTubeThumbnailUrl(videoId: string): string | null {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const entry = ytThumbnailCache.get(videoId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    ytThumbnailCache.delete(videoId);
    return null;
  }
  return entry.url;
}

function pruneExpiredYtStreamCache(now: number): void {
  for (const [key, entry] of ytStreamUrlCache.entries()) {
    if (entry.expiresAt <= now) {
      ytStreamUrlCache.delete(key);
    }
  }
  if (ytStreamUrlCache.size > YT_STREAM_CACHE_MAX_ENTRIES) {
    const excess = ytStreamUrlCache.size - YT_STREAM_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of ytStreamUrlCache.keys()) {
      ytStreamUrlCache.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
  for (const [key, entry] of ytStreamNegativeMemo.entries()) {
    if (entry.expiresAt <= now) {
      ytStreamNegativeMemo.delete(key);
    }
  }
  if (ytStreamNegativeMemo.size > YT_STREAM_CACHE_MAX_ENTRIES) {
    const excess = ytStreamNegativeMemo.size - YT_STREAM_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of ytStreamNegativeMemo.keys()) {
      ytStreamNegativeMemo.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

function computeMemoExpiresAtMs(expiresAtSec: number | null | undefined, nowMs: number): number {
  const maxMemoMs = nowMs + YT_STREAM_MEMO_TTL_MS;
  if (typeof expiresAtSec === 'number' && Number.isFinite(expiresAtSec) && expiresAtSec > 0) {
    const boundedMs = (expiresAtSec - YT_STREAM_EXPIRY_SAFETY_MARGIN_SEC) * 1000;
    if (boundedMs <= nowMs) return nowMs + 1_000;
    return Math.min(maxMemoMs, boundedMs);
  }
  return maxMemoMs;
}

function storeStreamInMemoryMemo(
  videoId: string,
  stream: ResolvedYouTubeAudioStream,
  resolvedAtMs: number
): void {
  const key = getStreamMemoKey(videoId);
  pruneExpiredYtStreamCache(resolvedAtMs);
  ytStreamNegativeMemo.delete(key);
  ytStreamUrlCache.set(key, {
    ...stream,
    headers: {...stream.headers},
    resolvedAt: resolvedAtMs,
    expiresAt: computeMemoExpiresAtMs(stream.expiresAtSec, resolvedAtMs),
  });
}

function getDurableCachedStream(
  videoId: string
): (ResolvedYouTubeAudioStream & {cacheAgeMs: number}) | null {
  try {
    const egress = getCurrentStreamEgress();
    const row = getCachedStreamUrlRow(videoId, egress, YT_STREAM_EXPIRY_SAFETY_MARGIN_SEC);
    if (!row || !isAllowedYouTubeMediaUrl(row.url)) return null;
    let parsedHeaders: Record<string, string> = {};
    if (row.headers_json) {
      try {
        const raw = JSON.parse(row.headers_json);
        parsedHeaders = sanitizeStreamHeaders(raw);
      } catch {
        parsedHeaders = {};
      }
    }
    const resolvedAtMs = Math.round(row.resolved_at * 1000);
    const stream: ResolvedYouTubeAudioStream = {
      url: row.url,
      headers: parsedHeaders,
      strategy: (row.strategy as YouTubeStreamStrategy) || 'default',
      thumbnailUrl: getCachedYouTubeThumbnailUrl(videoId) || '',
      contentType: row.content_type || 'audio/mp4',
      contentLength: row.content_length ?? null,
      duration: row.duration ?? null,
      clientParam: row.client_param ?? inspectYouTubeStreamUrlParams(row.url).client,
      formatId: row.format_id ?? undefined,
      adGateWaitedMs: 0,
      usedFormatHeaders: Boolean(row.used_format_headers),
      egress: row.egress,
      resolvedAtSec: row.resolved_at,
      expiresAtSec: row.expires_at,
    };
    return {
      ...stream,
      cacheAgeMs: Math.max(0, Date.now() - resolvedAtMs),
    };
  } catch {
    // Durable cache read must never break playback
    return null;
  }
}

function putDurableCachedStream(videoId: string, stream: ResolvedYouTubeAudioStream): void {
  // Persist to SQLite only when the signed URL carries a valid future `expire` timestamp.
  if (
    typeof stream.expiresAtSec !== 'number' ||
    !Number.isFinite(stream.expiresAtSec) ||
    stream.expiresAtSec <= Date.now() / 1000 + YT_STREAM_EXPIRY_SAFETY_MARGIN_SEC
  ) {
    return;
  }
  try {
    setCachedStreamUrlRow({
      videoId,
      url: stream.url,
      egress: stream.egress || getCurrentStreamEgress(),
      resolvedAtSec: stream.resolvedAtSec ?? Date.now() / 1000,
      expiresAtSec: stream.expiresAtSec,
      headers: stream.headers,
      strategy: stream.strategy,
      contentType: stream.contentType || 'audio/mp4',
      contentLength: stream.contentLength ?? null,
      duration: stream.duration ?? null,
      clientParam: stream.clientParam ?? null,
      formatId: stream.formatId ?? null,
      usedFormatHeaders: Boolean(stream.usedFormatHeaders),
    });
    if (Math.random() < 0.05) {
      pruneExpiredStreamUrlCache();
    }
  } catch {
    // Durable cache write must never break playback
  }
}

export function invalidateYouTubeAudioStreamCache(videoId: string): void {
  const key = getStreamMemoKey(videoId);
  ytStreamUrlCache.delete(key);
  ytStreamNegativeMemo.delete(key);
  try {
    invalidateCachedStreamUrlRow(videoId);
  } catch {
    // ignore
  }
}

export function getCachedYouTubeAudioStream(
  videoId: string
): (ResolvedYouTubeAudioStream & {cacheAgeMs: number}) | null {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const key = getStreamMemoKey(videoId);
  const now = Date.now();
  const entry = ytStreamUrlCache.get(key);
  if (entry) {
    if (entry.expiresAt > now) {
      return {
        url: entry.url,
        headers: {...entry.headers},
        strategy: entry.strategy,
        thumbnailUrl: entry.thumbnailUrl,
        contentType: entry.contentType,
        contentLength: entry.contentLength,
        duration: entry.duration,
        clientParam: entry.clientParam,
        formatId: entry.formatId,
        adGateWaitedMs: entry.adGateWaitedMs ?? 0,
        usedFormatHeaders: entry.usedFormatHeaders,
        egress: entry.egress,
        resolvedAtSec: entry.resolvedAtSec,
        expiresAtSec: entry.expiresAtSec,
        cacheAgeMs: Math.max(0, now - entry.resolvedAt),
      };
    }
    ytStreamUrlCache.delete(key);
  }

  // Layer 2: durable SQLite stream_url_cache (survives restarts until signed URL `expire`)
  const durable = getDurableCachedStream(videoId);
  if (durable) {
    storeStreamInMemoryMemo(
      videoId,
      durable,
      durable.resolvedAtSec ? Math.round(durable.resolvedAtSec * 1000) : now
    );
    return durable;
  }
  return null;
}

export function isYouTubeStreamCached(videoId: string): boolean {
  return getCachedYouTubeAudioStream(videoId) !== null;
}

function isMuxedVideoFormat(vcodec: unknown): boolean {
  if (typeof vcodec !== 'string') return false;
  const norm = vcodec.trim().toLowerCase();
  return norm.length > 0 && norm !== 'none';
}

function isManifestFormat(protocol: unknown, url: string): boolean {
  const proto = typeof protocol === 'string' ? protocol.trim().toLowerCase() : '';
  if (proto.includes('m3u8') || proto.includes('dash') || proto.includes('ism')) {
    return true;
  }
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.m3u8') || pathname.endsWith('.mpd')) return true;
  } catch {
    // ignore
  }
  return false;
}

function guessAudioContentType(ext: unknown): string {
  const normalized = typeof ext === 'string' ? ext.trim().toLowerCase() : '';
  if (normalized === 'webm') return 'audio/webm';
  if (normalized === 'opus' || normalized === 'ogg') return 'audio/ogg';
  if (normalized === 'mp3') return 'audio/mpeg';
  if (normalized === 'aac') return 'audio/aac';
  return 'audio/mp4';
}

interface RawYtdlpFormat {
  url?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  protocol?: unknown;
  ext?: unknown;
  format_id?: unknown;
  abr?: unknown;
  tbr?: unknown;
  filesize?: unknown;
  filesize_approx?: unknown;
  http_headers?: unknown;
}

function pickDirectAudioFormat(
  data: Record<string, unknown> & {
    url?: unknown;
    vcodec?: unknown;
    acodec?: unknown;
    protocol?: unknown;
    ext?: unknown;
    format_id?: unknown;
    filesize?: unknown;
    filesize_approx?: unknown;
    http_headers?: unknown;
    requested_formats?: RawYtdlpFormat[];
    formats?: RawYtdlpFormat[];
  },
  options: {requireAudioOnly?: boolean} = {}
): RawYtdlpFormat | null {
  const isUsableFormat = (fmt: RawYtdlpFormat | null | undefined, allowMuxed: boolean): boolean => {
    if (!fmt || typeof fmt.url !== 'string') return false;
    const u = fmt.url.trim();
    if (!u || !isAllowedYouTubeMediaUrl(u)) return false;
    if (!allowMuxed && isMuxedVideoFormat(fmt.vcodec)) return false;
    if (isManifestFormat(fmt.protocol, u)) return false;
    if (typeof fmt.acodec === 'string' && fmt.acodec.trim().toLowerCase() === 'none') return false;
    return true;
  };

  if (isUsableFormat(data, false)) {
    return data;
  }

  if (Array.isArray(data.requested_formats)) {
    const match = data.requested_formats.find((f) => isUsableFormat(f, false));
    if (match) return match;
  }

  if (Array.isArray(data.formats)) {
    const candidates = data.formats.filter((f) => isUsableFormat(f, false));
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const aM4a = String(a.ext || '').toLowerCase() === 'm4a' ? 1 : 0;
        const bM4a = String(b.ext || '').toLowerCase() === 'm4a' ? 1 : 0;
        if (aM4a !== bM4a) return bM4a - aM4a;
        const aBitrate = Number(a.abr || a.tbr || 0);
        const bBitrate = Number(b.abr || b.tbr || 0);
        return bBitrate - aBitrate;
      });
      return candidates[0];
    }
  }

  // Allow progressive fallback only when YDL_FORMAT_AUDIO_PREVIEW fell back to worst[acodec!=none]
  // and caller did not mandate strict audio-only (e.g. android-vr-fast rejects muxed formats).
  if (!options.requireAudioOnly && isUsableFormat(data, true)) {
    return data;
  }

  return null;
}

const GENERIC_BROWSER_COMPARE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
  'Sec-Fetch-Mode': 'navigate',
};

export interface DebugProbeCaseResult {
  label: string;
  rangeHeader: string;
  status: number;
  ipFamily: string;
  elapsedMs: number;
  serverHeader: string;
  contentType: string;
  contentRange: string;
  contentLength: string;
  redirected: boolean;
  sentHeaders: Record<string, string>;
  error?: string;
}

export interface YouTubeDebugCompareResult {
  videoId: string;
  formatId: string;
  ext: string;
  protocol: string;
  potProviderConfigured: boolean;
  usedFormatHeaders: boolean;
  urlParams: SafeStreamUrlInspection;
  formatHttpHeaders: Record<string, string>;
  topLevelHttpHeaders: Record<string, string>;
  probeHeadersSent: Record<string, string>;
  probes: {
    a_formatHeadersRange0to1: DebugProbeCaseResult;
    b_formatHeadersRange10MB: DebugProbeCaseResult;
    c_genericHeadersRange0to1: DebugProbeCaseResult;
  };
}

async function runSingleDebugProbe(
  rawUrl: string,
  baseHeaders: Record<string, string>,
  rangeHeader: string,
  label: string
): Promise<DebugProbeCaseResult> {
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    ...baseHeaders,
    Range: rangeHeader,
  };
  try {
    const resp = await requestIpv4MediaStream(rawUrl, {
      headers,
      timeoutMs: YT_PROBE_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;
    const h = (val: string | string[] | undefined): string =>
      Array.isArray(val) ? val.join(', ') : val || '';
    const result: DebugProbeCaseResult = {
      label,
      rangeHeader,
      status: resp.statusCode,
      ipFamily: resp.ipFamily,
      elapsedMs,
      serverHeader: h(resp.headers.server),
      contentType: h(resp.headers['content-type']),
      contentRange: h(resp.headers['content-range']),
      contentLength: h(resp.headers['content-length']),
      redirected: resp.redirected,
      sentHeaders: summarizeHeadersForLog(headers),
    };
    resp.stream.resume();
    resp.abort();
    return result;
  } catch (err) {
    return {
      label,
      rangeHeader,
      status: 0,
      ipFamily: 'IPv4',
      elapsedMs: Date.now() - startedAt,
      serverHeader: '',
      contentType: '',
      contentRange: '',
      contentLength: '',
      redirected: false,
      sentHeaders: summarizeHeadersForLog(headers),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeThreeWayProbeCompare(params: {
  videoId: string;
  formatId: string;
  ext: string;
  protocol: string;
  rawUrl: string;
  formatHeaders: Record<string, string>;
  topLevelHeaders: Record<string, string>;
  usedFormatHeaders: boolean;
}): Promise<YouTubeDebugCompareResult> {
  const urlParams = inspectYouTubeStreamUrlParams(params.rawUrl);
  const a = await runSingleDebugProbe(
    params.rawUrl,
    params.formatHeaders,
    'bytes=0-1',
    '(a) format http_headers + Range: bytes=0-1'
  );
  const b = await runSingleDebugProbe(
    params.rawUrl,
    params.formatHeaders,
    'bytes=0-10485759',
    '(b) format http_headers + Range: bytes=0-10485759'
  );
  const c = await runSingleDebugProbe(
    params.rawUrl,
    GENERIC_BROWSER_COMPARE_HEADERS,
    'bytes=0-1',
    '(c) generic Chrome headers + Range: bytes=0-1'
  );

  const report: YouTubeDebugCompareResult = {
    videoId: params.videoId,
    formatId: params.formatId,
    ext: params.ext,
    protocol: params.protocol,
    potProviderConfigured: hasPoTokenProvider(),
    usedFormatHeaders: params.usedFormatHeaders,
    urlParams,
    formatHttpHeaders: summarizeHeadersForLog(params.formatHeaders),
    topLevelHttpHeaders: summarizeHeadersForLog(params.topLevelHeaders),
    probeHeadersSent: summarizeHeadersForLog({...params.formatHeaders, Range: 'bytes=0-1'}),
    probes: {
      a_formatHeadersRange0to1: a,
      b_formatHeadersRange10MB: b,
      c_genericHeadersRange0to1: c,
    },
  };

  console.info('[yt-debug-compare]', JSON.stringify(report));
  return report;
}

const recentAutoDebugCompare = new Map<string, number>();

/**
 * On-demand diagnostic comparison for a videoId (runs `yt-dlp --dump-single-json -f 140/...`
 * and probes the exact unmodified googlevideo URL 3 ways over IPv4 without logging URLs/secrets).
 */
export async function runYouTubeDebugCompare(videoId: string): Promise<YouTubeDebugCompareResult> {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new Error('Invalid YouTube video ID');
  }
  const args = [
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--cache-dir',
    YTDLP_CACHE_DIR,
    '--js-runtimes',
    'node',
    '--force-ipv4',
    '-f',
    '140/bestaudio[ext=m4a][vcodec=none][protocol=https]/bestaudio[acodec!=none][vcodec=none]',
  ];
  appendPoTokenExtractorArgs(args);
  if (getSetting('ytdlp_remote_components', 'true') === 'true') {
    args.push('--remote-components', 'ejs:github');
  }
  args.push('--', `https://www.youtube.com/watch?v=${videoId}`);

  const result = await withYtdlpResolveSlot(() =>
    execYtdlp(args, {
      timeout: getResolvePrimaryTimeoutMs(),
      maxBuffer: 12 * 1024 * 1024,
    })
  );
  const trimmed = result.stdout.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('Could not parse yt-dlp JSON output');
  }
  const data = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown> & {
    url?: unknown;
    vcodec?: unknown;
    acodec?: unknown;
    protocol?: unknown;
    ext?: unknown;
    format_id?: unknown;
    http_headers?: unknown;
    requested_formats?: RawYtdlpFormat[];
    formats?: RawYtdlpFormat[];
  };

  const primaryFormat = pickDirectAudioFormat(data);
  if (!primaryFormat || typeof primaryFormat.url !== 'string') {
    throw new Error('No direct HTTPS audio format returned by yt-dlp');
  }

  const directUrl = primaryFormat.url.trim();
  const {headers: selectedHeaders, usedFormatHeaders} = selectFormatStreamHeaders(
    data,
    primaryFormat
  );
  const topLevelHeaders = sanitizeStreamHeaders(data.http_headers);

  return executeThreeWayProbeCompare({
    videoId,
    formatId: String(primaryFormat.format_id ?? data.format_id ?? 'unknown'),
    ext: String(primaryFormat.ext ?? data.ext ?? 'unknown'),
    protocol: String(primaryFormat.protocol ?? data.protocol ?? 'unknown'),
    rawUrl: directUrl,
    formatHeaders: selectedHeaders,
    topLevelHeaders,
    usedFormatHeaders,
  });
}

class UpstreamProbeRejectedError extends Error {
  readonly status: number;
  readonly clientParam: string | null;
  readonly clientFamily: string;
  readonly usedFormatHeaders: boolean;
  readonly hasPotParam: boolean;
  readonly adGateExhausted: boolean;
  readonly waitedMs: number;

  constructor(
    message: string,
    info: {
      status: number;
      clientParam: string | null;
      clientFamily: string;
      usedFormatHeaders: boolean;
      hasPotParam: boolean;
      adGateExhausted?: boolean;
      waitedMs?: number;
    }
  ) {
    super(message);
    this.name = 'UpstreamProbeRejectedError';
    this.status = info.status;
    this.clientParam = info.clientParam;
    this.clientFamily = info.clientFamily;
    this.usedFormatHeaders = info.usedFormatHeaders;
    this.hasPotParam = info.hasPotParam;
    this.adGateExhausted = Boolean(info.adGateExhausted);
    this.waitedMs = info.waitedMs ?? 0;
  }
}

function isTvClientForAdGate(
  strategy: YouTubeStreamStrategy,
  clientParam: string | null | undefined,
  extractorArgs?: string | null
): boolean {
  const c = (clientParam || '').trim().toUpperCase();
  if (c) {
    return c.startsWith('TV');
  }
  if (strategy === 'tv-android-vr' || strategy === 'tv-cookies') {
    return true;
  }
  if (strategy === 'custom-client' && extractorArgs) {
    return /(?:^|[,=])tv[a-z0-9_-]*(?:$|,)/i.test(extractorArgs);
  }
  return false;
}

function isRejectedProbeContentType(ct: string): boolean {
  return (
    ct.includes('text/html') ||
    ct.includes('mpegurl') ||
    ct.includes('dash+xml') ||
    ct.includes('application/json')
  );
}

function sleepDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Sanitizes a yt-dlp argv array for diagnostic logs:
 * preserves exact flags and extractor args while never logging full URLs,
 * signatures, PO tokens, or cookie file paths/contents.
 */
function sanitizeYtdlpArgsForLog(args: string[]): string[] {
  const out: string[] = [];
  let redactNext: 'cookie' | 'extractor' | null = null;
  for (const arg of args) {
    if (redactNext === 'cookie') {
      out.push('<cookies-file>');
      redactNext = null;
      continue;
    }
    if (redactNext === 'extractor') {
      const cleaned = arg
        .replace(/(base_url=)[^\s;]+/gi, '$1<configured>')
        .replace(/(po_token=)[^\s;]+/gi, '$1[REDACTED]')
        .replace(/(visitor_data=)[^\s;]+/gi, '$1[REDACTED]');
      out.push(cleaned);
      redactNext = null;
      continue;
    }
    if (arg === '--cookies') {
      out.push(arg);
      redactNext = 'cookie';
      continue;
    }
    if (arg === '--extractor-args') {
      out.push(arg);
      redactNext = 'extractor';
      continue;
    }
    if (/^https?:\/\//i.test(arg)) {
      out.push('<video-url>');
      continue;
    }
    out.push(arg);
  }
  return out;
}

interface SingleIpv4ProbeOutcome {
  statusCode: number;
  ipFamily: string;
  allowedHost: boolean;
  contentType: string;
  contentTypeHeader: string;
  serverHeader: string;
  parsedLength: number | null;
}

async function executeSingleIpv4RangeProbe(
  streamUrl: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<SingleIpv4ProbeOutcome> {
  const resp = await requestIpv4MediaStream(streamUrl, {
    headers,
    timeoutMs,
  });
  const ctHeader = Array.isArray(resp.headers['content-type'])
    ? resp.headers['content-type'][0] || ''
    : resp.headers['content-type'] || '';
  const ct = ctHeader.toLowerCase();
  const serverHeader = Array.isArray(resp.headers.server)
    ? resp.headers.server.join(', ')
    : resp.headers.server || '';
  const contentRange = Array.isArray(resp.headers['content-range'])
    ? resp.headers['content-range'][0] || ''
    : resp.headers['content-range'] || '';
  const rawContentLength = Array.isArray(resp.headers['content-length'])
    ? resp.headers['content-length'][0] || ''
    : resp.headers['content-length'] || '';

  let parsedLength: number | null = null;
  const rangeTotalMatch = contentRange.match(/\/(\d+)$/);
  if (rangeTotalMatch?.[1]) {
    const n = Number(rangeTotalMatch[1]);
    if (Number.isFinite(n) && n > 0) parsedLength = n;
  } else if (resp.statusCode === 200 && rawContentLength) {
    const n = Number(rawContentLength);
    if (Number.isFinite(n) && n > 0) parsedLength = n;
  }

  resp.stream.resume();
  resp.abort();

  return {
    statusCode: resp.statusCode,
    ipFamily: resp.ipFamily,
    allowedHost: isAllowedYouTubeMediaUrl(resp.finalUrl),
    contentType: ct,
    contentTypeHeader: ctHeader,
    serverHeader,
    parsedLength,
  };
}

async function probeAudioStreamUrl(params: {
  videoId: string;
  priority: StreamResolvePriority;
  strategy: YouTubeStreamStrategy;
  extractorArgs: string | null;
  ytdlpArgsForLog: string[];
  fromCache: boolean;
  cacheAgeMs: number | null;
  resolvedAtMs: number;
  otherResolvesInFlightAtResolve: number;
  firstProbeOnly?: boolean;
  formatId: string;
  ext: string;
  protocol: string;
  streamUrl: string;
  streamHeaders: Record<string, string>;
  topLevelHeaders: Record<string, string>;
  usedFormatHeaders: boolean;
  adGateControl?: ActiveAdGateControl;
}): Promise<{
  ok: boolean;
  status: number;
  contentType: string;
  contentLength: number | null;
  ipFamily: string;
  urlParams: SafeStreamUrlInspection;
  poTokenSuspected: boolean;
  adGateCleared: boolean;
  adGateExhausted: boolean;
  waitedMs: number;
}> {
  const startedAt = Date.now();
  const urlParams = inspectYouTubeStreamUrlParams(params.streamUrl);
  const headers: Record<string, string> = {
    ...params.streamHeaders,
    Range: 'bytes=0-1',
  };

  const maybeRunAutoDebugCompare = async () => {
    if (!isDebugCompareEnabled()) return;
    const now = Date.now();
    const lastRun = recentAutoDebugCompare.get(params.videoId) || 0;
    if (now - lastRun > 5 * 60 * 1000) {
      recentAutoDebugCompare.set(params.videoId, now);
      if (recentAutoDebugCompare.size > 100) {
        const oldest = recentAutoDebugCompare.keys().next().value;
        if (oldest) recentAutoDebugCompare.delete(oldest);
      }
      await executeThreeWayProbeCompare({
        videoId: params.videoId,
        formatId: params.formatId,
        ext: params.ext,
        protocol: params.protocol,
        rawUrl: params.streamUrl,
        formatHeaders: params.streamHeaders,
        topLevelHeaders: params.topLevelHeaders,
        usedFormatHeaders: params.usedFormatHeaders,
      });
    }
  };

  try {
    const first = await executeSingleIpv4RangeProbe(
      params.streamUrl,
      headers,
      YT_PROBE_TIMEOUT_MS
    );
    const firstElapsedMs = Date.now() - startedAt;

    if (!first.allowedHost) {
      return {
        ok: false,
        status: first.statusCode,
        contentType: first.contentType,
        contentLength: null,
        ipFamily: first.ipFamily,
        urlParams,
        poTokenSuspected: false,
        adGateCleared: false,
        adGateExhausted: false,
        waitedMs: 0,
      };
    }

    if (first.statusCode === 403) {
      const shouldPollAdGate =
        !params.firstProbeOnly &&
        isTvClientForAdGate(params.strategy, urlParams.client, params.extractorArgs);

      // Single-URL polling retry for TV clients:
      // re-probe the EXACT same URL with the format's own http_headers until 200/206 or maxWaitMs.
      // Never open the strategy-level circuit on first-probe 403s inside the polling window.
      if (shouldPollAdGate) {
        const pollMs = getAdGatePollMs();
        const pollStartMs = Date.now();
        const ownsControl = !params.adGateControl && !activeAdGateControls.has(params.videoId);
        const control: ActiveAdGateControl =
          params.adGateControl ||
          activeAdGateControls.get(params.videoId) || {
            priority: params.priority,
            promotedAtMs: null,
          };
        if (ownsControl) {
          activeAdGateControls.set(params.videoId, control);
        }

        const getEffectiveGateBudget = (): {
          priority: StreamResolvePriority;
          maxWaitMs: number;
          deadlineMs: number;
        } => {
          const playbackMaxWaitMs = getAdGateMaxWaitMs();
          const prefetchMaxWaitMs = getAdGateMaxWaitPrefetchMs();
          if (control.priority === 'prefetch') {
            return {
              priority: 'prefetch',
              maxWaitMs: prefetchMaxWaitMs,
              deadlineMs: pollStartMs + prefetchMaxWaitMs,
            };
          }
          const baseMs =
            control.promotedAtMs !== null ? Math.max(pollStartMs, control.promotedAtMs) : pollStartMs;
          const deadlineMs =
            control.promotedAtMs !== null
              ? Math.min(pollStartMs + prefetchMaxWaitMs, baseMs + playbackMaxWaitMs)
              : pollStartMs + playbackMaxWaitMs;
          return {
            priority: 'playback',
            maxWaitMs: playbackMaxWaitMs,
            deadlineMs,
          };
        };

        let pollAttempts = 0;
        let lastOutcome = first;
        const initialBudget = getEffectiveGateBudget();

        console.info(
          '[yt-stream-probe]',
          JSON.stringify({
            event: 'ad_gate_poll_start',
            videoId: params.videoId,
            priority: initialBudget.priority,
            strategy: params.strategy,
            formatId: params.formatId,
            client: urlParams.client,
            pollMs,
            maxWaitMs: initialBudget.maxWaitMs,
            firstProbeElapsedMs: firstElapsedMs,
          })
        );

        try {
          while (true) {
            const budgetBeforeSleep = getEffectiveGateBudget();
            const remainingMs = budgetBeforeSleep.deadlineMs - Date.now();
            if (remainingMs <= 0) {
              break;
            }

            await sleepDelay(Math.min(pollMs, remainingMs));
            pollAttempts += 1;

            const budgetAfterSleep = getEffectiveGateBudget();
            const remainingAfterSleepMs = budgetAfterSleep.deadlineMs - Date.now();
            const attemptTimeoutMs = Math.min(
              YT_PROBE_TIMEOUT_MS,
              Math.max(2_000, remainingAfterSleepMs + 2_000)
            );

            let attempt: SingleIpv4ProbeOutcome;
            try {
              attempt = await executeSingleIpv4RangeProbe(
                params.streamUrl,
                headers,
                attemptTimeoutMs
              );
            } catch (pollErr) {
              const waitedMs = Date.now() - pollStartMs;
              console.warn(
                '[yt-stream-probe]',
                JSON.stringify({
                  event: 'probe_network_error',
                  videoId: params.videoId,
                  priority: control.priority,
                  strategy: params.strategy,
                  formatId: params.formatId,
                  ipFamily: 'IPv4',
                  waitedMs,
                  attempts: pollAttempts,
                  adGatePolling: true,
                  usedFormatHeaders: params.usedFormatHeaders,
                  urlParams,
                  error: pollErr instanceof Error ? pollErr.message : String(pollErr),
                })
              );
              return {
                ok: false,
                status: 0,
                contentType: '',
                contentLength: null,
                ipFamily: 'IPv4',
                urlParams,
                poTokenSuspected: false,
                adGateCleared: false,
                adGateExhausted: false,
                waitedMs,
              };
            }

            lastOutcome = attempt;

            if (!attempt.allowedHost) {
              return {
                ok: false,
                status: attempt.statusCode,
                contentType: attempt.contentType,
                contentLength: null,
                ipFamily: attempt.ipFamily,
                urlParams,
                poTokenSuspected: false,
                adGateCleared: false,
                adGateExhausted: false,
                waitedMs: Date.now() - pollStartMs,
              };
            }

            if (attempt.statusCode === 200 || attempt.statusCode === 206) {
              if (isRejectedProbeContentType(attempt.contentType)) {
                return {
                  ok: false,
                  status: 415,
                  contentType: attempt.contentType,
                  contentLength: null,
                  ipFamily: attempt.ipFamily,
                  urlParams,
                  poTokenSuspected: false,
                  adGateCleared: false,
                  adGateExhausted: false,
                  waitedMs: Date.now() - pollStartMs,
                };
              }

              const waitedMs = Date.now() - pollStartMs;
              const clearedBudget = getEffectiveGateBudget();
              recordStrategyDirectSuccess(params.strategy, params.videoId);
              clearUpstreamBackoff();
              console.info(
                '[yt-stream-probe]',
                JSON.stringify({
                  event: 'ad_gate_cleared',
                  videoId: params.videoId,
                  priority: clearedBudget.priority,
                  maxWaitMs: clearedBudget.maxWaitMs,
                  waitedMs,
                  attempts: pollAttempts,
                  strategy: params.strategy,
                  formatId: params.formatId,
                  client: urlParams.client,
                  hasPot: urlParams.hasPot,
                  usedFormatHeaders: params.usedFormatHeaders,
                  status: attempt.statusCode,
                  ipFamily: attempt.ipFamily,
                  contentType: attempt.contentTypeHeader,
                  contentLength: attempt.parsedLength,
                })
              );
              recordAdGateClearedWait(waitedMs);
              return {
                ok: true,
                status: attempt.statusCode,
                contentType: attempt.contentType,
                contentLength: attempt.parsedLength,
                ipFamily: attempt.ipFamily,
                urlParams,
                poTokenSuspected: false,
                adGateCleared: true,
                adGateExhausted: false,
                waitedMs,
              };
            }

            // Do not continue polling on any non-403 HTTP error
            if (attempt.statusCode !== 403) {
              const waitedMs = Date.now() - pollStartMs;
              console.warn(
                '[yt-stream-probe]',
                JSON.stringify({
                  event: 'probe_rejected',
                  videoId: params.videoId,
                  priority: control.priority,
                  strategy: params.strategy,
                  formatId: params.formatId,
                  status: attempt.statusCode,
                  ipFamily: attempt.ipFamily,
                  waitedMs,
                  attempts: pollAttempts,
                  adGatePolling: true,
                  serverHeader: attempt.serverHeader,
                  contentType: attempt.contentTypeHeader,
                  usedFormatHeaders: params.usedFormatHeaders,
                  urlParams,
                })
              );
              return {
                ok: false,
                status: attempt.statusCode,
                contentType: attempt.contentType,
                contentLength: null,
                ipFamily: attempt.ipFamily,
                urlParams,
                poTokenSuspected: false,
                adGateCleared: false,
                adGateExhausted: false,
                waitedMs,
              };
            }
          }

          // Entire ad-gate polling window passed with 403s: emit diagnostics without full URLs/secrets,
          // and open the short global upstream backoff ONLY for interactive playback (never prefetch).
          const waitedMs = Date.now() - pollStartMs;
          const finalBudget = getEffectiveGateBudget();
          const backoffOpened = finalBudget.priority === 'playback';
          const otherResolvesInFlight = Math.max(0, inFlightResolutions.size - 1);

          console.warn(
            '[yt-stream-probe]',
            JSON.stringify({
              event: 'ad_gate_exhausted',
              videoId: params.videoId,
              priority: finalBudget.priority,
              waitedMs,
              attempts: pollAttempts,
              pollMs,
              maxWaitMs: finalBudget.maxWaitMs,
              backoffOpened,
              strategy: params.strategy,
              formatId: params.formatId,
              client: urlParams.client,
              fromCache: params.fromCache,
              cacheAgeMs: params.cacheAgeMs,
              urlAgeMs: Date.now() - params.resolvedAtMs,
              extractorArgs: params.extractorArgs || 'default',
              ytdlpArgs: params.ytdlpArgsForLog,
              otherResolvesInFlightAtResolve: params.otherResolvesInFlightAtResolve,
              otherResolvesInFlight,
              activeResolveSlots,
              status: 403,
              ipFamily: lastOutcome.ipFamily,
              serverHeader: lastOutcome.serverHeader,
              contentType: lastOutcome.contentTypeHeader,
              usedFormatHeaders: params.usedFormatHeaders,
              urlParams,
              sentHeaders: summarizeHeadersForLog(headers),
              attribution: backoffOpened
                ? '403 persisted through polling window; handing off to pipe + 5m negative cache'
                : '403 persisted through prefetch polling window; negative-cached video without opening global backoff',
            })
          );

          if (backoffOpened) {
            openUpstreamBackoff(params.videoId, 403, 'ad_gate_exhausted');
          }
          await maybeRunAutoDebugCompare();

          return {
            ok: false,
            status: 403,
            contentType: lastOutcome.contentType,
            contentLength: null,
            ipFamily: lastOutcome.ipFamily,
            urlParams,
            poTokenSuspected: false,
            adGateCleared: false,
            adGateExhausted: true,
            waitedMs,
          };
        } finally {
          if (ownsControl && activeAdGateControls.get(params.videoId) === control) {
            activeAdGateControls.delete(params.videoId);
          }
        }
      }

      // Non-TV or first-probe-only strategy (e.g., visionos): do NOT poll; fail fast and update circuit
      const poTokenSuspected =
        !params.firstProbeOnly &&
        first.ipFamily === 'IPv4' &&
        params.usedFormatHeaders &&
        !urlParams.hasPot &&
        !hasPoTokenProvider();
      const attribution = params.firstProbeOnly
        ? 'first-probe-only strategy returned 403; continuing with default strategy'
        : poTokenSuspected
          ? '403 with format http_headers and missing pot= param — likely requires PO token'
          : '403 with unknown cause';

      console.warn(
        '[yt-stream-probe]',
        JSON.stringify({
          event: 'probe_403',
          videoId: params.videoId,
          strategy: params.strategy,
          formatId: params.formatId,
          client: urlParams.client,
          status: first.statusCode,
          ipFamily: first.ipFamily,
          elapsedMs: firstElapsedMs,
          waitedMs: 0,
          firstProbeOnly: Boolean(params.firstProbeOnly),
          serverHeader: first.serverHeader,
          contentType: first.contentTypeHeader,
          usedFormatHeaders: params.usedFormatHeaders,
          urlParams,
          sentHeaders: summarizeHeadersForLog(headers),
          poTokenSuspected,
          attribution,
        })
      );

      recordStrategy403Rejection(params.strategy, params.videoId, 'probe-403-ipv4');
      await maybeRunAutoDebugCompare();

      return {
        ok: false,
        status: 403,
        contentType: first.contentType,
        contentLength: null,
        ipFamily: first.ipFamily,
        urlParams,
        poTokenSuspected,
        adGateCleared: false,
        adGateExhausted: false,
        waitedMs: 0,
      };
    }

    if (first.statusCode !== 200 && first.statusCode !== 206) {
      console.warn(
        '[yt-stream-probe]',
        JSON.stringify({
          event: 'probe_rejected',
          videoId: params.videoId,
          strategy: params.strategy,
          formatId: params.formatId,
          client: urlParams.client,
          status: first.statusCode,
          ipFamily: first.ipFamily,
          elapsedMs: firstElapsedMs,
          waitedMs: 0,
          serverHeader: first.serverHeader,
          contentType: first.contentTypeHeader,
          usedFormatHeaders: params.usedFormatHeaders,
          urlParams,
          sentHeaders: summarizeHeadersForLog(headers),
        })
      );
      return {
        ok: false,
        status: first.statusCode,
        contentType: first.contentType,
        contentLength: null,
        ipFamily: first.ipFamily,
        urlParams,
        poTokenSuspected: false,
        adGateCleared: false,
        adGateExhausted: false,
        waitedMs: 0,
      };
    }

    if (isRejectedProbeContentType(first.contentType)) {
      return {
        ok: false,
        status: 415,
        contentType: first.contentType,
        contentLength: null,
        ipFamily: first.ipFamily,
        urlParams,
        poTokenSuspected: false,
        adGateCleared: false,
        adGateExhausted: false,
        waitedMs: 0,
      };
    }

    recordStrategyDirectSuccess(params.strategy, params.videoId);
    clearUpstreamBackoff();
    console.info(
      '[yt-stream-probe]',
      JSON.stringify({
        event: 'probe_ok',
        videoId: params.videoId,
        strategy: params.strategy,
        formatId: params.formatId,
        client: urlParams.client,
        hasPot: urlParams.hasPot,
        usedFormatHeaders: params.usedFormatHeaders,
        status: first.statusCode,
        ipFamily: first.ipFamily,
        elapsedMs: firstElapsedMs,
        waitedMs: 0,
        contentType: first.contentTypeHeader,
        contentLength: first.parsedLength,
      })
    );
    return {
      ok: true,
      status: first.statusCode,
      contentType: first.contentType,
      contentLength: first.parsedLength,
      ipFamily: first.ipFamily,
      urlParams,
      poTokenSuspected: false,
      adGateCleared: false,
      adGateExhausted: false,
      waitedMs: 0,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.warn(
      '[yt-stream-probe]',
      JSON.stringify({
        event: 'probe_network_error',
        videoId: params.videoId,
        strategy: params.strategy,
        formatId: params.formatId,
        ipFamily: 'IPv4',
        elapsedMs,
        waitedMs: 0,
        usedFormatHeaders: params.usedFormatHeaders,
        urlParams,
        sentHeaders: summarizeHeadersForLog(headers),
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return {
      ok: false,
      status: 0,
      contentType: '',
      contentLength: null,
      ipFamily: 'IPv4',
      urlParams,
      poTokenSuspected: false,
      adGateCleared: false,
      adGateExhausted: false,
      waitedMs: 0,
    };
  }
}

export async function resolveYouTubeAudioStreamUrl(
  videoId: string,
  options: {
    forceRefresh?: boolean;
    skipStrategies?: YouTubeStreamStrategy[];
    skipFastPath?: boolean;
    defaultOnly?: boolean;
    priority?: StreamResolvePriority;
  } = {}
): Promise<ResolvedYouTubeAudioStream & {fromCache: boolean; cacheAgeMs: number | null}> {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new Error('Invalid YouTube video ID');
  }

  const priority: StreamResolvePriority = options.priority ?? 'playback';
  const skipSet = new Set<YouTubeStreamStrategy>(options.skipStrategies || []);
  const memoKey = getStreamMemoKey(videoId);

  // Short-circuit immediately only if every active direct strategy is in cooldown
  if (isDirectProxyCircuitOpen()) {
    throw new DirectProxyCircuitOpenError(getDirectProxyCircuitCooldownRemainingMs());
  }

  // Layer 1 & Layer 2 cache lookup (in-memory 5m memo -> durable SQLite stream_url_cache)
  if (!options.forceRefresh && skipSet.size === 0 && !options.defaultOnly) {
    const cached = getCachedYouTubeAudioStream(videoId);
    if (cached && !isStrategyCircuitOpen(cached.strategy)) {
      return {...cached, fromCache: true, cacheAgeMs: cached.cacheAgeMs};
    }
    // Check short 20s negative memo so dead/unresolvable videos aren't hammered on rapid retries
    const negEntry = ytStreamNegativeMemo.get(memoKey);
    if (negEntry) {
      if (negEntry.expiresAt > Date.now()) {
        throw new Error(negEntry.reason);
      }
      ytStreamNegativeMemo.delete(memoKey);
    }
  }

  // Single-flight deduplication per (videoId, egress).
  // If interactive playback attaches to an in-flight prefetch, promote its active ad-gate
  // control and slot waiter to playback in place rather than restarting the probe.
  const existingPromise = inFlightResolutions.get(memoKey);
  if (existingPromise) {
    if (priority === 'playback') {
      promoteInFlightAdGateToPlayback(videoId);
    }
    const resolved = await existingPromise;
    return {...resolved, headers: {...resolved.headers}, fromCache: false, cacheAgeMs: null};
  }

  const adGateControl: ActiveAdGateControl = {
    priority,
    promotedAtMs: null,
  };
  activeAdGateControls.set(videoId, adGateControl);

  const runExtractionAttempt = async (
    extractorArgs: string | null,
    cookiePath: string | null,
    strategy: YouTubeStreamStrategy,
    timeoutMs: number,
    attemptOpts: {firstProbeOnly?: boolean; requireAudioOnly?: boolean} = {}
  ): Promise<ResolvedYouTubeAudioStream> => {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--cache-dir',
      YTDLP_CACHE_DIR,
      '--js-runtimes',
      'node',
      '--force-ipv4',
      '-f',
      YDL_FORMAT_AUDIO_PREVIEW,
    ];
    if (extractorArgs) {
      args.push('--extractor-args', extractorArgs);
    }
    appendPoTokenExtractorArgs(args);
    if (getSetting('ytdlp_remote_components', 'true') === 'true') {
      args.push('--remote-components', 'ejs:github');
    }
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }
    args.push('--', `https://www.youtube.com/watch?v=${videoId}`);

    const sanitizedArgs = sanitizeYtdlpArgsForLog(args);
    const startedAt = Date.now();
    let stdout = '';
    let otherResolvesInFlightAtResolve = 0;
    try {
      const result = await withYtdlpResolveSlot(
        () => {
          otherResolvesInFlightAtResolve = Math.max(0, inFlightResolutions.size - 1);
          return execYtdlp(args, {
            timeout: timeoutMs,
            maxBuffer: 12 * 1024 * 1024,
          });
        },
        adGateControl.priority,
        videoId
      );
      stdout = result.stdout;
    } catch (rawErr) {
      const execErr = rawErr as ExecFileError;
      const elapsedMs = Date.now() - startedAt;
      const killed = Boolean(execErr.killed);
      const signal = execErr.signal ?? null;
      const code = execErr.code ?? null;
      const isTimeout = killed || signal === 'SIGKILL' || signal === 'SIGTERM';
      const stderrText = sanitizeStderrForLog(execErr.stderr, cookiePath, 2000);
      console.error(
        '[yt-stream-resolve]',
        JSON.stringify({
          event: 'ytdlp_exec_failed',
          videoId,
          strategy,
          extractorArgs: extractorArgs ? sanitizeYtdlpArgsForLog(['--extractor-args', extractorArgs])[1] : 'default',
          potProviderConfigured: hasPoTokenProvider(),
          useCookies: Boolean(cookiePath),
          timeoutMs,
          elapsedMs,
          failureKind: isTimeout ? 'timeout' : typeof code === 'number' ? 'non-zero-exit' : 'spawn-error',
          code,
          killed,
          signal,
          stderr: stderrText || execErr.message.slice(0, 500),
        })
      );
      const err = new Error(
        isTimeout
          ? `yt-dlp ${strategy} timed out after ${elapsedMs}ms (limit ${timeoutMs}ms)`
          : `yt-dlp ${strategy} exited (${String(code ?? signal ?? 'error')}): ${(stderrText || execErr.message).slice(0, 260)}`
      ) as Error & {fullStderr?: string};
      err.fullStderr = stderrText || execErr.message;
      throw err;
    }

    const trimmed = stdout.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) {
      console.error(
        '[yt-stream-resolve]',
        JSON.stringify({
          event: 'ytdlp_parse_failed',
          videoId,
          strategy,
          extractorArgs: extractorArgs ? sanitizeYtdlpArgsForLog(['--extractor-args', extractorArgs])[1] : 'default',
          elapsedMs: Date.now() - startedAt,
          failureKind: 'parse-error',
          stdoutPreview: trimmed.slice(0, 400),
        })
      );
      throw new Error('Could not parse YouTube stream metadata JSON');
    }
    const data = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown> & {
      url?: unknown;
      vcodec?: unknown;
      acodec?: unknown;
      protocol?: unknown;
      ext?: unknown;
      format_id?: unknown;
      duration?: unknown;
      filesize?: unknown;
      filesize_approx?: unknown;
      http_headers?: unknown;
      requested_formats?: RawYtdlpFormat[];
      formats?: RawYtdlpFormat[];
    };

    // Capture & cache thumbnail URL during stream extraction so cover art survives stream expiry
    const extractedThumb = extractThumbnailUrl(data);
    if (extractedThumb) {
      cacheYouTubeThumbnailUrl(videoId, extractedThumb);
    }

    const primaryFormat = pickDirectAudioFormat(data, {
      requireAudioOnly: attemptOpts.requireAudioOnly,
    });
    if (!primaryFormat || typeof primaryFormat.url !== 'string') {
      throw new Error('No direct HTTPS audio format returned by yt-dlp');
    }

    const directUrl = primaryFormat.url.trim();
    const {headers, usedFormatHeaders} = selectFormatStreamHeaders(data, primaryFormat);
    const topLevelHeaders = sanitizeStreamHeaders(data.http_headers);
    const formatId = String(primaryFormat.format_id ?? data.format_id ?? 'unknown');
    const formatExt = String(primaryFormat.ext ?? data.ext ?? 'unknown');
    const formatProtocol = String(primaryFormat.protocol ?? data.protocol ?? 'unknown');

    const resolvedAtMs = Date.now();
    const safeExtractorArgsForLog = extractorArgs
      ? sanitizeYtdlpArgsForLog(['--extractor-args', extractorArgs])[1]
      : null;

    // Live IPv4 Range probe guarantees Node can stream this exact URL with the format's http_headers
    // and clears any TV-client ad gate BEFORE the URL is persisted to memory or SQLite.
    const probe = await probeAudioStreamUrl({
      videoId,
      priority: adGateControl.priority,
      strategy,
      extractorArgs: safeExtractorArgsForLog,
      ytdlpArgsForLog: sanitizedArgs,
      fromCache: false,
      cacheAgeMs: null,
      resolvedAtMs,
      otherResolvesInFlightAtResolve,
      firstProbeOnly: attemptOpts.firstProbeOnly,
      formatId,
      ext: formatExt,
      protocol: formatProtocol,
      streamUrl: directUrl,
      streamHeaders: headers,
      topLevelHeaders,
      usedFormatHeaders,
      adGateControl,
    });
    if (!probe.ok) {
      const clientFamily = classifyClientFamily(probe.urlParams.client, strategy);
      const poHint = probe.adGateExhausted
        ? ` (403 persisted through polling window; waited ${probe.waitedMs}ms)`
        : probe.poTokenSuspected
          ? ' (format http_headers + missing pot= param — likely requires PO token)'
          : probe.status === 403
            ? ' (403 with unknown cause)'
            : '';
      throw new UpstreamProbeRejectedError(
        `Upstream probe rejected (${probe.status || 'network-error'})${poHint}`,
        {
          status: probe.status,
          clientParam: probe.urlParams.client,
          clientFamily,
          usedFormatHeaders,
          hasPotParam: probe.urlParams.hasPot,
          adGateExhausted: probe.adGateExhausted,
          waitedMs: probe.waitedMs,
        }
      );
    }

    const rawSize = Number(primaryFormat.filesize || primaryFormat.filesize_approx || data.filesize || 0);
    const contentLength =
      probe.contentLength ?? (Number.isFinite(rawSize) && rawSize > 0 ? Math.round(rawSize) : null);
    const rawDuration = Number(data.duration || 0);
    const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : null;
    const resolvedAtSec = Date.now() / 1000;
    const expiresAtSec =
      probe.urlParams.expire && probe.urlParams.expire > resolvedAtSec
        ? probe.urlParams.expire
        : null;

    return {
      url: directUrl,
      headers,
      strategy,
      thumbnailUrl: extractedThumb || getCachedYouTubeThumbnailUrl(videoId) || '',
      contentType: probe.contentType || guessAudioContentType(primaryFormat.ext),
      contentLength,
      duration,
      clientParam: probe.urlParams.client,
      formatId,
      adGateWaitedMs: probe.waitedMs,
      usedFormatHeaders,
      egress: getCurrentStreamEgress(),
      resolvedAtSec,
      expiresAtSec,
    };
  };

  const resolvePromise = (async (): Promise<ResolvedYouTubeAudioStream> => {
    let tempCookiePath: string | null = null;
    try {
      const primaryTimeoutMs = getResolvePrimaryTimeoutMs();
      const fallbackTimeoutMs = getResolveFallbackTimeoutMs();
      const customClient = getCustomConfiguredPlayerClient();

      const strategies: Array<{
        strategy: YouTubeStreamStrategy;
        extractorArgs: string | null;
        useCookies: boolean;
        timeoutMs: number;
        targetFamily: string;
        firstProbeOnly?: boolean;
        requireAudioOnly?: boolean;
        visitorToken?: string | null;
      }> = [];

      if (options.defaultOnly) {
        // Explicit default-only re-resolve after CDN 403/410 (never android_vr)
        strategies.push({
          strategy: 'default',
          extractorArgs: null,
          useCookies: false,
          timeoutMs: primaryTimeoutMs,
          targetFamily: 'default',
        });
        if (hasConfiguredCookies()) {
          strategies.push({
            strategy: 'default-cookies',
            extractorArgs: null,
            useCookies: true,
            timeoutMs: fallbackTimeoutMs,
            targetFamily: 'default',
          });
        }
      } else {
        // 0. Opt-in visionOS first strategy (behind YT_PREFER_VISIONOS=1, default off):
        // accepted ONLY if it returns a URL and first probe is 200/206.
        if (isPreferVisionosEnabled()) {
          strategies.push({
            strategy: 'visionos',
            extractorArgs: 'youtube:player_client=visionos',
            useCookies: false,
            timeoutMs: primaryTimeoutMs,
            targetFamily: 'visionos',
            firstProbeOnly: true,
          });
        }

        // 1. Optional android_vr + cached visitor_data fast path (interactive playback only;
        // skipped by prefetch, CDN 403/410 retries, YT_DISABLE_FAST_PATH=1, or 30m bot-check auto-disable).
        if (!options.skipFastPath && !isAndroidVrFastPathDisabled()) {
          const visitor = await getVisitorData();
          if (visitor) {
            strategies.push({
              strategy: 'android-vr-fast',
              extractorArgs: `youtube:player_client=android_vr;player_skip=webpage,configs;visitor_data=${visitor}`,
              useCookies: false,
              timeoutMs: primaryTimeoutMs,
              targetFamily: 'android-vr-fast',
              firstProbeOnly: true,
              requireAudioOnly: true,
              visitorToken: visitor,
            });
          }
        }

        // 2. yt-dlp's own default clients (with full 12s TV ad-gate polling)
        strategies.push({
          strategy: 'default',
          extractorArgs: null,
          useCookies: false,
          timeoutMs: primaryTimeoutMs,
          targetFamily: 'default',
        });

        // 3. tv + android_vr fallback (excluded when skipFastPath is set, e.g. prefetch/retry)
        if (!options.skipFastPath) {
          strategies.push({
            strategy: 'tv-android-vr',
            extractorArgs: 'youtube:player_client=tv,android_vr',
            useCookies: false,
            timeoutMs: fallbackTimeoutMs,
            targetFamily: 'tv-vr',
          });
        }

        // 4. Explicit non-legacy admin custom client override, if set
        if (customClient) {
          strategies.push({
            strategy: 'custom-client',
            extractorArgs: `youtube:player_client=${customClient}`,
            useCookies: false,
            timeoutMs: fallbackTimeoutMs,
            targetFamily: `custom:${customClient.toLowerCase()}`,
          });
        }

        // 5. Demote mweb/ios strictly behind an active PO token provider
        if (hasPoTokenProvider()) {
          strategies.push({
            strategy: 'po-token-mobile',
            extractorArgs: 'youtube:player_client=mweb,ios,default',
            useCookies: false,
            timeoutMs: fallbackTimeoutMs,
            targetFamily: 'mobile-pot',
          });
        }

        // 6. Cookies variants only when cookies.txt is configured
        if (hasConfiguredCookies()) {
          strategies.push({
            strategy: 'default-cookies',
            extractorArgs: null,
            useCookies: true,
            timeoutMs: fallbackTimeoutMs,
            targetFamily: 'default',
          });
          if (!options.skipFastPath) {
            strategies.push({
              strategy: 'tv-cookies',
              extractorArgs: 'youtube:player_client=tv,android_vr',
              useCookies: true,
              timeoutMs: fallbackTimeoutMs,
              targetFamily: 'tv-vr',
            });
          }
        }
      }

      let resolved: ResolvedYouTubeAudioStream | null = null;
      let lastError: unknown = null;
      let attemptedCount = 0;
      let saw403 = false;
      let adGateExhausted = false;
      const failed403FamiliesNoCookies = new Set<string>();
      const failed403FamiliesCookies = new Set<string>();

      for (const step of strategies) {
        if (skipSet.has(step.strategy)) {
          continue;
        }
        const failedFamilies = step.useCookies
          ? failed403FamiliesCookies
          : failed403FamiliesNoCookies;
        if (failedFamilies.has(step.targetFamily)) {
          console.info(
            `[yt-stream-resolve] ${videoId} skipping strategy "${step.strategy}" (same client family "${step.targetFamily}" already returned 403)`
          );
          continue;
        }
        if (isStrategyCircuitOpen(step.strategy)) {
          console.info(
            `[yt-stream-resolve] ${videoId} skipping strategy "${step.strategy}" (circuit open, ${Math.ceil(getStrategyCircuitCooldownRemainingMs(step.strategy) / 1000)}s left)`
          );
          continue;
        }
        attemptedCount += 1;
        let cookieArg: string | null = null;
        if (step.useCookies) {
          tempCookiePath = tempCookiePath || createTempCookiesCopy();
          cookieArg = tempCookiePath;
        }
        try {
          resolved = await runExtractionAttempt(
            step.extractorArgs,
            cookieArg,
            step.strategy,
            step.timeoutMs,
            {
              firstProbeOnly: step.firstProbeOnly,
              requireAudioOnly: step.requireAudioOnly,
            }
          );
          if (step.strategy === 'android-vr-fast') {
            recordAndroidVrFastPathSuccess();
          }
          break;
        } catch (err) {
          lastError = err;
          if (step.strategy === 'visionos') {
            const msg = err instanceof Error ? err.message : String(err);
            console.info(
              `[yt-stream-resolve] ${videoId} visionos did not pass first probe (${msg}); continuing with default strategy`
            );
            continue;
          }
          if (step.strategy === 'android-vr-fast') {
            if (step.visitorToken) {
              rejectVisitorData(step.visitorToken);
            }
            const msg = err instanceof Error ? err.message : String(err);
            const fullDetail =
              err && typeof err === 'object' && 'fullStderr' in err && typeof (err as {fullStderr?: unknown}).fullStderr === 'string'
                ? (err as {fullStderr: string}).fullStderr
                : msg;
            recordAndroidVrFastPathFailure(fullDetail);
            console.info(
              `[yt-stream-resolve] ${videoId} android-vr-fast rejected (${msg}); dropped visitor_data for 60s and continuing with default strategy`
            );
            continue;
          }
          if (err instanceof UpstreamProbeRejectedError && err.status === 403) {
            saw403 = true;
            failedFamilies.add(err.clientFamily);
            failedFamilies.add(step.targetFamily);
            if (err.adGateExhausted) {
              // Single-URL polling window exhausted: go straight to pipe fallback + 5-min negative cache
              adGateExhausted = true;
              console.warn(
                `[yt-stream-resolve] ${videoId} ${step.strategy} ad-gate polling exhausted (${err.waitedMs}ms); handing off to pipe fallback`
              );
              break;
            }
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[yt-stream-resolve] ${videoId} ${step.strategy} failed: ${msg}`);
        }
      }

      if (!resolved) {
        const failReason =
          lastError instanceof Error
            ? lastError.message
            : 'Could not resolve a playable YouTube audio-only stream';
        if (saw403) {
          markVideoDirectProxyNegative(
            videoId,
            failReason,
            adGateExhausted && adGateControl.priority === 'playback'
              ? AD_GATE_NEG_CACHE_TTL_MS
              : undefined
          );
        }
        if (attemptedCount === 0 && isDirectProxyCircuitOpen()) {
          throw new DirectProxyCircuitOpenError(getDirectProxyCircuitCooldownRemainingMs());
        }
        // Short 20s negative memo so rapid duplicate retries don't immediately re-spawn yt-dlp
        pruneExpiredYtStreamCache(Date.now());
        ytStreamNegativeMemo.set(memoKey, {
          reason: failReason,
          expiresAt: Date.now() + YT_STREAM_NEGATIVE_TTL_MS,
        });
        throw lastError instanceof Error ? lastError : new Error(failReason);
      }

      // Only store in Layer 1 (5m memo) and Layer 2 (SQLite stream_url_cache) AFTER probe returned 200/206
      const resolvedAtMs = Date.now();
      storeStreamInMemoryMemo(videoId, resolved, resolvedAtMs);
      putDurableCachedStream(videoId, resolved);
      return resolved;
    } finally {
      if (tempCookiePath && fs.existsSync(tempCookiePath)) {
        try {
          fs.unlinkSync(tempCookiePath);
        } catch {
          // ignore
        }
      }
    }
  })();

  inFlightResolutions.set(memoKey, resolvePromise);

  try {
    const resolved = await resolvePromise;
    return {...resolved, headers: {...resolved.headers}, fromCache: false, cacheAgeMs: null};
  } finally {
    if (inFlightResolutions.get(memoKey) === resolvePromise) {
      inFlightResolutions.delete(memoKey);
    }
    if (activeAdGateControls.get(videoId) === adGateControl) {
      activeAdGateControls.delete(videoId);
    }
  }
}

/**
 * Live audio pipe fallback using yt-dlp directly when all direct googlevideo URLs
 * are rejected (e.g. SABR/HLS-only or strict IP-bound streams) or during 403 circuit cooldown.
 */
export function spawnDirectYouTubeAudioStream(videoId: string): {
  stream: NodeJS.ReadableStream;
  cleanup: () => void;
  getStderr: () => string;
} {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new Error('Invalid YouTube video ID');
  }
  const invocation = resolveYtdlpInvocation(false);
  const tempCookiePath = createTempCookiesCopy();
  const args = [
    ...invocation.prefixArgs,
    '-f',
    'bestaudio[ext=m4a]/bestaudio[vcodec=none]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '--cache-dir',
    YTDLP_CACHE_DIR,
    '--js-runtimes',
    'node',
    '--force-ipv4',
    '--extractor-args',
    'youtube:player_client=tv,android_vr,default',
  ];
  appendPoTokenExtractorArgs(args);
  if (getSetting('ytdlp_remote_components', 'true') === 'true') {
    args.push('--remote-components', 'ejs:github');
  }
  if (tempCookiePath) {
    args.push('--cookies', tempCookiePath);
  }
  args.push('-o', '-', '--', `https://www.youtube.com/watch?v=${videoId}`);

  const proc = spawn(invocation.cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: invocation.env,
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf-8')).slice(-1200);
  });

  const removeTempCookies = () => {
    if (!tempCookiePath) return;
    try {
      if (fs.existsSync(tempCookiePath)) {
        fs.unlinkSync(tempCookiePath);
      }
    } catch {
      // ignore
    }
  };

  let cleaned = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (cleaned) {
      removeTempCookies();
      return;
    }
    cleaned = true;

    try {
      if (!proc.stdout.destroyed) proc.stdout.destroy();
    } catch {
      // ignore
    }
    try {
      if (!proc.stderr.destroyed) proc.stderr.destroy();
    } catch {
      // ignore
    }

    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
        removeTempCookies();
      }, 1500);
      forceKillTimer.unref();
    }

    removeTempCookies();
  };

  const onProcDone = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    removeTempCookies();
  };

  proc.once('exit', onProcDone);
  proc.once('close', onProcDone);
  proc.once('error', (spawnErr) => {
    if (!proc.stdout.destroyed) {
      proc.stdout.destroy(spawnErr);
    }
    cleanup();
  });

  return {
    stream: proc.stdout,
    cleanup,
    getStderr: () => sanitizeStderrForLog(stderrBuf, tempCookiePath, 1200),
  };
}

// ---------------------------------------------------------------------------
// Metadata-to-YouTube Matching & Persistent SQLite Cache + Background Prefetch
// ---------------------------------------------------------------------------

const trackVideoMapCache = new Map<
  string,
  {videoId: string; matchedTitle: string; matchedDuration: number; updatedAt: number}
>();
const trackVideoMatchInFlight = new Map<
  string,
  Promise<{videoId: string; matchedTitle: string; matchedDuration: number; fromCache: boolean}>
>();

const getTrackVideoMapStmt = db.prepare(
  'SELECT video_id, matched_title, matched_duration, updated_at FROM track_video_map WHERE match_key = ?'
);
const upsertTrackVideoMapStmt = db.prepare(
  `INSERT INTO track_video_map (match_key, artist, title, duration, video_id, matched_title, matched_duration, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(match_key) DO UPDATE SET
     artist = excluded.artist,
     title = excluded.title,
     duration = excluded.duration,
     video_id = excluded.video_id,
     matched_title = excluded.matched_title,
     matched_duration = excluded.matched_duration,
     updated_at = excluded.updated_at`
);

const deleteTrackVideoMapStmt = db.prepare('DELETE FROM track_video_map WHERE match_key = ?');
const getRejectedVideoIdsStmt = db.prepare(
  'SELECT videoId FROM track_video_rejects WHERE trackKey = ?'
);
const getAudioFactsForVideosStmt = db.prepare(
  'SELECT videoId, lufs, durationSec, lowRunPct, status, reason FROM video_audio_facts WHERE videoId = ?'
);

export interface MatchedVideoOrigin {
  trackKey: string;
  artist: string;
  title: string;
  requestedDuration: number;
  recordedAt: number;
}

// Tracks videos chosen by artist+title matching in this process (including score < 0.40 matches
// that are intentionally not stored in track_video_map). Never populated for explicit videoId opens.
const recentMatchedVideoOrigins = new Map<string, MatchedVideoOrigin[]>();
const MAX_RECENT_MATCH_ORIGINS = 1000;

function recordMatchedVideoOrigin(origin: Omit<MatchedVideoOrigin, 'recordedAt'>, videoId: string): void {
  if (!isValidYouTubeVideoId(videoId)) return;
  const list = recentMatchedVideoOrigins.get(videoId) || [];
  const filtered = list.filter((item) => item.trackKey !== origin.trackKey);
  filtered.push({...origin, recordedAt: Date.now()});
  recentMatchedVideoOrigins.set(videoId, filtered.slice(-8));
  if (recentMatchedVideoOrigins.size > MAX_RECENT_MATCH_ORIGINS) {
    const firstKey = recentMatchedVideoOrigins.keys().next().value;
    if (firstKey) recentMatchedVideoOrigins.delete(firstKey);
  }
}

export function getMatchedVideoOrigins(videoId: string): MatchedVideoOrigin[] {
  if (!isValidYouTubeVideoId(videoId)) return [];
  const byKey = new Map<string, MatchedVideoOrigin>();
  try {
    const rows = db
      .prepare('SELECT match_key, artist, title, duration, updated_at FROM track_video_map WHERE video_id = ?')
      .all(videoId) as Array<{
      match_key: string;
      artist: string;
      title: string;
      duration: number;
      updated_at: number;
    }>;
    for (const row of rows) {
      byKey.set(row.match_key, {
        trackKey: row.match_key,
        artist: row.artist,
        title: row.title,
        requestedDuration: row.duration || 0,
        recordedAt: row.updated_at || Date.now(),
      });
    }
  } catch {
    // ignore DB errors
  }
  const recent = recentMatchedVideoOrigins.get(videoId) || [];
  for (const item of recent) {
    if (!byKey.has(item.trackKey)) {
      byKey.set(item.trackKey, item);
    }
  }
  return Array.from(byKey.values());
}

export function deleteTrackVideoMapEntry(matchKey: string): void {
  if (!matchKey) return;
  trackVideoMapCache.delete(matchKey);
  try {
    deleteTrackVideoMapStmt.run(matchKey);
  } catch {
    // non-fatal
  }
}

export function upsertTrackVideoMapEntry(entry: {
  matchKey: string;
  artist: string;
  title: string;
  duration: number;
  videoId: string;
  matchedTitle: string;
  matchedDuration: number;
}): void {
  if (!entry.matchKey || !isValidYouTubeVideoId(entry.videoId)) return;
  const updatedAt = Date.now();
  pruneTrackVideoMapMemory(updatedAt);
  trackVideoMapCache.set(entry.matchKey, {
    videoId: entry.videoId,
    matchedTitle: entry.matchedTitle,
    matchedDuration: entry.matchedDuration,
    updatedAt,
  });
  try {
    upsertTrackVideoMapStmt.run(
      entry.matchKey,
      entry.artist,
      entry.title,
      entry.duration,
      entry.videoId,
      entry.matchedTitle,
      entry.matchedDuration,
      updatedAt
    );
  } catch {
    // non-fatal
  }
}

export function getInFlightTrackVideoMatch(
  artist: string,
  title: string
): Promise<{videoId: string; matchedTitle: string; matchedDuration: number; fromCache: boolean}> | null {
  const key = buildTrackMatchKey(
    sanitizeMatchSearchFragment(artist || ''),
    sanitizeMatchSearchFragment(title || '')
  );
  if (!key || key === '::') return null;
  return trackVideoMatchInFlight.get(key) ?? null;
}

const SCORE_FILLER_WORDS = new Set([
  'official',
  'video',
  'audio',
  'lyrics',
  'hd',
  'hq',
  'ft',
  'feat',
]);

const WRONG_VERSION_MARKERS = [
  'live',
  'cover',
  'karaoke',
  'instrumental',
  'remix',
  'acoustic',
  'unplugged',
  'sped up',
  'slowed',
  'nightcore',
  '8d',
  'reverb',
  'tribute',
  'medley',
  'mashup',
  'parody',
  'backing track',
] as const;

const LYRIC_REUPLOAD_MARKERS = [
  'lyrics',
  'lyric video',
  'letra',
  'letras',
  'sub espanol',
  'subtitulado',
  'traducida',
] as const;

function stripAccentsAndLower(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function toWordBoundaryText(raw: string): string {
  return stripAccentsAndLower(raw)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasWholeWordMarker(rawText: string, marker: string): boolean {
  const haystack = toWordBoundaryText(rawText);
  const needle = toWordBoundaryText(marker);
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

export function normalizeScoreText(raw: string): string {
  const stripped = stripAccentsAndLower(raw)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped
    .split(' ')
    .filter((tok) => tok.length > 0 && !SCORE_FILLER_WORDS.has(tok))
    .join(' ');
}

function normalizeMatchTokenText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[\[(](?:feat\.?|ft\.?|with)\s+[^)\]]+[\])]/gi, ' ')
    .replace(/\b(?:feat\.?|ft\.?)\s+.+$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildTrackMatchKey(artist: string, title: string): string {
  const a = normalizeMatchTokenText(artist);
  const t = normalizeMatchTokenText(title);
  return `${a}::${t}`;
}

function sanitizeMatchSearchFragment(raw: string): string {
  return raw
    .replace(/[\r\n\t\0]/g, ' ')
    .replace(/["'`$\\;<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function pruneTrackVideoMapMemory(now: number): void {
  if (trackVideoMapCache.size <= TRACK_VIDEO_CACHE_MAX_ENTRIES) return;
  for (const [k, v] of trackVideoMapCache.entries()) {
    if (now - v.updatedAt > TRACK_VIDEO_MAP_TTL_MS) {
      trackVideoMapCache.delete(k);
    }
  }
  if (trackVideoMapCache.size > TRACK_VIDEO_CACHE_MAX_ENTRIES) {
    const excess = trackVideoMapCache.size - TRACK_VIDEO_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const k of trackVideoMapCache.keys()) {
      trackVideoMapCache.delete(k);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

function getRejectedVideoIdSet(trackKey: string): Set<string> {
  const out = new Set<string>();
  if (!trackKey || trackKey === '::') return out;
  try {
    const rows = getRejectedVideoIdsStmt.all(trackKey) as Array<{videoId: string}>;
    for (const r of rows) {
      if (r.videoId && isValidYouTubeVideoId(r.videoId)) {
        out.add(r.videoId);
      }
    }
  } catch {
    // ignore DB errors
  }
  return out;
}

export function getCachedTrackVideoId(artist: string, title: string): string | null {
  const key = buildTrackMatchKey(artist, title);
  if (!key || key === '::') return null;
  const rejected = getRejectedVideoIdSet(key);
  const now = Date.now();
  const mem = trackVideoMapCache.get(key);
  if (
    mem &&
    now - mem.updatedAt <= TRACK_VIDEO_MAP_TTL_MS &&
    isValidYouTubeVideoId(mem.videoId) &&
    !rejected.has(mem.videoId)
  ) {
    return mem.videoId;
  }
  if (mem && rejected.has(mem.videoId)) {
    trackVideoMapCache.delete(key);
  }
  try {
    const row = getTrackVideoMapStmt.get(key) as
      | {video_id: string; matched_title: string; matched_duration: number; updated_at: number}
      | undefined;
    if (
      row &&
      now - row.updated_at <= TRACK_VIDEO_MAP_TTL_MS &&
      isValidYouTubeVideoId(row.video_id) &&
      !rejected.has(row.video_id)
    ) {
      pruneTrackVideoMapMemory(now);
      trackVideoMapCache.set(key, {
        videoId: row.video_id,
        matchedTitle: row.matched_title,
        matchedDuration: row.matched_duration,
        updatedAt: row.updated_at,
      });
      return row.video_id;
    }
  } catch {
    // ignore DB errors
  }
  return null;
}

function computeTokenOverlapRatio(targetNorm: string, candidateNorm: string): number {
  if (!targetNorm || !candidateNorm) return 0;
  const targetTokens = Array.from(new Set(targetNorm.split(' ').filter(Boolean)));
  if (targetTokens.length === 0) return 0;
  const candSet = new Set(candidateNorm.split(' ').filter(Boolean));
  let matched = 0;
  for (const tok of targetTokens) {
    if (candSet.has(tok)) matched += 1;
  }
  return matched / targetTokens.length;
}

export interface ScoredVideoCandidate {
  videoId: string;
  entry: Record<string, unknown>;
  score: number;
  roundedScore: number;
  sourcePreferenceTier: number;
  titleScore: number;
  artistScore: number;
  durationScore: number;
}

export function scoreVideoCandidateDetailed(
  entry: Record<string, unknown>,
  targetArtist: string,
  targetTitle: string,
  targetDuration: number
): Omit<ScoredVideoCandidate, 'videoId' | 'entry'> {
  const rawTitle = String(entry.title || '').trim();
  const rawChannel = String(entry.channel || entry.uploader || entry.creator || '').trim();
  const candDuration = Number(entry.duration) || 0;

  // 1. Title similarity up to 0.45 (exact 0.45, contains 0.35, else token overlap * 0.35)
  const normTargetTitle = normalizeScoreText(targetTitle);
  const normCandTitle = normalizeScoreText(rawTitle);
  let titleScore = 0;
  if (normTargetTitle && normCandTitle) {
    if (normCandTitle === normTargetTitle) {
      titleScore = 0.45;
    } else if (
      normCandTitle.includes(normTargetTitle) ||
      normTargetTitle.includes(normCandTitle)
    ) {
      titleScore = 0.35;
    } else {
      titleScore = computeTokenOverlapRatio(normTargetTitle, normCandTitle) * 0.35;
    }
  }

  // 2. Artist compared to CHANNEL name ONLY (not title), up to 0.30 (exact 0.30, contains 0.22, else overlap * 0.22)
  const normTargetArtist = normalizeScoreText(targetArtist);
  const channelWithoutTopic = rawChannel.replace(/\s*-\s*topic$/i, '').trim();
  const normCandChannel = normalizeScoreText(channelWithoutTopic);
  let artistScore = 0;
  if (normTargetArtist && normCandChannel) {
    const compactTarget = normTargetArtist.replace(/\s+/g, '');
    const compactChannel = normCandChannel.replace(/\s+/g, '');
    if (normCandChannel === normTargetArtist) {
      artistScore = 0.30;
    } else if (
      normCandChannel.includes(normTargetArtist) ||
      normTargetArtist.includes(normCandChannel) ||
      (compactTarget.length >= 3 &&
        (compactChannel === `${compactTarget}vevo` || compactChannel.includes(compactTarget)))
    ) {
      artistScore = 0.22;
    } else {
      artistScore = computeTokenOverlapRatio(normTargetArtist, normCandChannel) * 0.22;
    }
  }

  // 3. Duration difference up to 0.25 (<=2s 0.25, <=5s 0.18, <=15s 0.08, >30s -0.10)
  let durationScore = 0;
  if (targetDuration > 0 && candDuration > 0) {
    const diff = Math.abs(candDuration - targetDuration);
    if (diff <= 2) durationScore = 0.25;
    else if (diff <= 5) durationScore = 0.18;
    else if (diff <= 15) durationScore = 0.08;
    else if (diff > 30) durationScore = -0.10;
  }

  // 4. Wrong-version penalty 0.20, WHOLE-WORD matching only, both directions
  let versionPenalty = 0;
  for (const marker of WRONG_VERSION_MARKERS) {
    const reqHas = hasWholeWordMarker(targetTitle, marker);
    const candHas = hasWholeWordMarker(rawTitle, marker);
    if (reqHas !== candHas) {
      versionPenalty += 0.20;
    }
  }

  // 5. Source preference
  let sourcePrefBonus = 0;
  const isTopicChannel = /\s*-\s*topic$/i.test(rawChannel);
  const isVevoOrOfficialChannel = /vevo|official/i.test(rawChannel);
  const isPreferredChannel = isTopicChannel || isVevoOrOfficialChannel;
  if (isPreferredChannel) {
    sourcePrefBonus += 0.15;
  }

  const hasOfficialAudio = hasWholeWordMarker(rawTitle, 'official audio');
  const hasOfficialVideo =
    !hasOfficialAudio &&
    (hasWholeWordMarker(rawTitle, 'official video') ||
      hasWholeWordMarker(rawTitle, 'official music video'));

  if (hasOfficialAudio) {
    sourcePrefBonus += 0.15;
  } else if (hasOfficialVideo) {
    sourcePrefBonus += 0.08;
  }

  const hasLyricReuploadMarker = LYRIC_REUPLOAD_MARKERS.some(
    (marker) => hasWholeWordMarker(rawTitle, marker) && !hasWholeWordMarker(targetTitle, marker)
  );
  if (hasLyricReuploadMarker) {
    sourcePrefBonus -= 0.15;
  }

  const rawScore = titleScore + artistScore + durationScore - versionPenalty + sourcePrefBonus;
  const score = Math.max(0, Math.min(1, rawScore));
  const roundedScore = Math.round(score * 10) / 10;

  let sourcePreferenceTier = 0;
  if (hasLyricReuploadMarker) {
    sourcePreferenceTier = -1;
  } else if (isTopicChannel || (isVevoOrOfficialChannel && hasOfficialAudio)) {
    sourcePreferenceTier = 4;
  } else if (isVevoOrOfficialChannel) {
    sourcePreferenceTier = 3;
  } else if (artistScore >= 0.22 || hasOfficialAudio) {
    sourcePreferenceTier = 2;
  } else if (hasOfficialVideo) {
    sourcePreferenceTier = 1;
  }

  return {
    score,
    roundedScore,
    sourcePreferenceTier,
    titleScore,
    artistScore,
    durationScore,
  };
}

export function scoreVideoCandidate(
  entry: Record<string, unknown>,
  targetArtist: string,
  targetTitle: string,
  targetDuration: number
): number {
  return scoreVideoCandidateDetailed(entry, targetArtist, targetTitle, targetDuration).score;
}

export function rankVideoCandidates(
  entries: Array<Record<string, unknown>>,
  targetArtist: string,
  targetTitle: string,
  targetDuration: number,
  excludedVideoIds?: Set<string>
): ScoredVideoCandidate[] {
  const scored: ScoredVideoCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const vid = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!isValidYouTubeVideoId(vid) || seen.has(vid)) continue;
    seen.add(vid);
    if (excludedVideoIds && excludedVideoIds.has(vid)) continue;
    const detail = scoreVideoCandidateDetailed(entry, targetArtist, targetTitle, targetDuration);
    scored.push({
      videoId: vid,
      entry,
      ...detail,
    });
  }

  scored.sort((a, b) => {
    const roundDiff = Math.round(b.score * 10) - Math.round(a.score * 10);
    if (roundDiff !== 0) return roundDiff;
    const prefDiff = b.sourcePreferenceTier - a.sourcePreferenceTier;
    if (prefDiff !== 0) return prefDiff;
    return b.score - a.score;
  });

  return scored.slice(0, 5);
}

const TRACK_VIDEO_CACHE_MIN_SCORE = 0.40;

export async function resolveTrackToVideoId(input: {
  artist: string;
  title: string;
  duration?: number;
  forceRefresh?: boolean;
  priority?: StreamResolvePriority;
}): Promise<{videoId: string; matchedTitle: string; matchedDuration: number; fromCache: boolean}> {
  const artist = sanitizeMatchSearchFragment(input.artist || '');
  const title = sanitizeMatchSearchFragment(input.title || '');
  const targetDuration = Number.isFinite(Number(input.duration))
    ? Math.max(0, Math.round(Number(input.duration)))
    : 0;
  const priority: StreamResolvePriority = input.priority ?? 'playback';

  if (!title) {
    throw new Error('Track title is required to resolve audio stream');
  }

  const key = buildTrackMatchKey(artist, title);

  if (!input.forceRefresh) {
    const cachedVid = getCachedTrackVideoId(artist, title);
    if (cachedVid) {
      const mem = trackVideoMapCache.get(key);
      recordMatchedVideoOrigin(
        {trackKey: key, artist, title, requestedDuration: targetDuration},
        cachedVid
      );
      return {
        videoId: cachedVid,
        matchedTitle: mem?.matchedTitle || title,
        matchedDuration: mem?.matchedDuration || targetDuration,
        fromCache: true,
      };
    }

    const existing = trackVideoMatchInFlight.get(key);
    if (existing) {
      return existing;
    }
  }

  if (priority === 'prefetch' && (isDirectProxyCircuitOpen() || upstreamBackoffRemainingSec() > 0)) {
    throw new Error('Upstream YouTube resolver is temporarily backing off');
  }

  const searchPromise = (async () => {
    const searchQuery = artist ? `${title} ${artist}` : title;
    const entries = await withYtdlpResolveSlot(
      () => runFlatYtSearch(`ytsearch8:${searchQuery}`, null),
      priority
    );

    const rejectedIds = getRejectedVideoIdSet(key);
    let ranked = rankVideoCandidates(entries, artist, title, targetDuration, rejectedIds);

    // If all candidates were rejected (e.g. track already hit 2 BAD rejects and search had no other matches),
    // fall back to picking the better of the rejected candidates (preferring non-silent / lower lowRunPct / higher score).
    if (ranked.length === 0 && rejectedIds.size > 0) {
      const fallbackCandidates = rankVideoCandidates(entries, artist, title, targetDuration);
      if (fallbackCandidates.length > 0) {
        fallbackCandidates.sort((a, b) => {
          const fa = getAudioFactsForVideosStmt.get(a.videoId) as
            | {lufs: number | null; lowRunPct: number; reason: string}
            | undefined;
          const fb = getAudioFactsForVideosStmt.get(b.videoId) as
            | {lufs: number | null; lowRunPct: number; reason: string}
            | undefined;
          const aSilent = fa?.reason === 'silent' ? 1 : 0;
          const bSilent = fb?.reason === 'silent' ? 1 : 0;
          if (aSilent !== bSilent) return aSilent - bSilent;
          const aLow = typeof fa?.lowRunPct === 'number' ? fa.lowRunPct : 0;
          const bLow = typeof fb?.lowRunPct === 'number' ? fb.lowRunPct : 0;
          if (Math.abs(aLow - bLow) > 1) return aLow - bLow;
          return b.score - a.score;
        });
        ranked = fallbackCandidates;
      }
    }

    const chosen = ranked[0];
    const runnerUp = ranked[1] ?? null;

    if (!chosen) {
      throw new Error(`No matching YouTube audio found for "${artist ? `${artist} - ` : ''}${title}"`);
    }

    const bestVideoId = chosen.videoId;
    const bestEntry = chosen.entry;
    const matchedTitle = String(bestEntry.title || title).trim();
    const matchedDuration = Math.max(0, Math.round(Number(bestEntry.duration) || 0));
    const thumb = extractThumbnailUrl(bestEntry);
    if (thumb) {
      cacheYouTubeThumbnailUrl(bestVideoId, thumb);
    }

    const shouldCache = chosen.score >= TRACK_VIDEO_CACHE_MIN_SCORE;
    console.info(
      '[yt-match-resolve]',
      JSON.stringify({
        artist,
        title,
        videoId: bestVideoId,
        score: Number(chosen.score.toFixed(3)),
        runnerUpScore: runnerUp ? Number(runnerUp.score.toFixed(3)) : null,
        cached: shouldCache,
      })
    );

    recordMatchedVideoOrigin(
      {trackKey: key, artist, title, requestedDuration: targetDuration},
      bestVideoId
    );

    if (shouldCache) {
      upsertTrackVideoMapEntry({
        matchKey: key,
        artist,
        title,
        duration: targetDuration,
        videoId: bestVideoId,
        matchedTitle,
        matchedDuration,
      });
    }

    return {
      videoId: bestVideoId,
      matchedTitle,
      matchedDuration,
      fromCache: false,
    };
  })();

  if (!input.forceRefresh) {
    trackVideoMatchInFlight.set(key, searchPromise);
  }
  try {
    return await searchPromise;
  } finally {
    if (trackVideoMatchInFlight.get(key) === searchPromise) {
      trackVideoMatchInFlight.delete(key);
    }
  }
}

export interface PrefetchRequestItem {
  videoId?: string;
  artist?: string;
  title?: string;
  duration?: number;
}

// ---------------------------------------------------------------------------
// Personalized Discover Feed (SQLite seed artists + fast yt-dlp flat search)
// ---------------------------------------------------------------------------

export interface DiscoverNewReleaseItem {
  videoId: string;
  url: string;
  title: string;
  artist: string;
  releaseLabel: string;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  isNew: boolean;
  seedArtist: string | null;
}

export interface DiscoverArtistItem {
  id: string;
  name: string;
  subtitle: string;
  seedArtist: string | null;
  videoId: string;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
}

export interface DiscoverAlbumItem {
  videoId: string;
  url: string;
  title: string;
  artist: string;
  subtitle: string;
  duration: number;
  thumbnailUrl: string;
  fallbackThumbnailUrl: string;
  seedArtist: string | null;
}

export interface DiscoverFeedResponse {
  seeds: string[];
  basedOnLibrary: boolean;
  cached: boolean;
  generatedAt: string;
  newReleases: DiscoverNewReleaseItem[];
  artistsToDiscover: DiscoverArtistItem[];
  albumsForYou: DiscoverAlbumItem[];
}

const DISCOVER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DISCOVER_CACHE_MAX_ENTRIES = 50;

const discoverFeedCache = new Map<
  string,
  {data: Omit<DiscoverFeedResponse, 'cached'>; expiresAt: number}
>();
const discoverInFlight = new Map<string, Promise<Omit<DiscoverFeedResponse, 'cached'>>>();

const IGNORED_ARTIST_NAMES = new Set([
  '',
  'unknown',
  'unknown artist',
  'unknown channel',
  'various',
  'various artists',
  'va',
  'v.a.',
  'youtube',
  'none',
  'n/a',
  'null',
  'soundtrack',
  'original soundtrack',
  'ost',
  'compilation',
  'music',
  'official',
  'topic',
  'audio',
  'tracks',
  'playlist',
  'mix',
]);

const GENERIC_CHANNEL_PATTERN =
  /\b(records|recordings|music|vevo|radio|playlist|playlists|mix|mixes|lyrics|lyric|vibes|hits|tv|hd|channel|official\s*audio|sounds|nation|club|sessions|archive|fm|beats|lo-?fi|compilation|top\s*\d+|best\s*of|trending|charts)\b/i;

function sanitizeDiscoverSearchTerm(raw: string): string {
  return raw
    .replace(/[\r\n\t\0]/g, ' ')
    .replace(/^[-]+/, '')
    .replace(/["'`$\\;<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function normalizeArtistKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanArtistLabel(raw: string): string {
  return raw
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s*\(Official\)$/i, '')
    .replace(/\s+Official$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTrackTitle(rawTitle: string, artist: string): string {
  let title = rawTitle
    .replace(/\s*[\[(](?:official\s+)?(?:music\s+)?(?:video|audio|lyric\s+video|lyrics|visualizer|hd|4k|hq)[\])]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (artist) {
    const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRe = new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i');
    const stripped = title.replace(prefixRe, '').trim();
    if (stripped.length >= 2) {
      title = stripped;
    }
  }
  return title || rawTitle.trim() || 'Untitled';
}

function formatReleaseLabel(entry: Record<string, unknown>, fallback: string): string {
  const uploadDate = typeof entry.upload_date === 'string' ? entry.upload_date.trim() : '';
  if (/^\d{8}$/.test(uploadDate)) {
    const year = uploadDate.slice(0, 4);
    const monthIdx = Number(uploadDate.slice(4, 6)) - 1;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (monthIdx >= 0 && monthIdx < 12) {
      return `Single · ${months[monthIdx]} ${year}`;
    }
    return `Single · ${year}`;
  }
  const releaseYear = Number(entry.release_year);
  if (Number.isFinite(releaseYear) && releaseYear >= 1950 && releaseYear <= 2100) {
    return `Single · ${releaseYear}`;
  }
  return fallback;
}

function sanitizeHttpsThumbUrl(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // ignore
  }
  return '';
}

function isValidCandidateArtist(name: string): boolean {
  const cleaned = cleanArtistLabel(name);
  if (cleaned.length < 2 || cleaned.length > 42) return false;
  const lower = cleaned.toLowerCase();
  if (IGNORED_ARTIST_NAMES.has(lower)) return false;
  if (/^https?:\/\//i.test(cleaned)) return false;
  return true;
}

export function pickDiscoverSeedArtists(userId: number, maxSeeds = 3): string[] {
  const scores = new Map<string, {display: string; score: number}>();

  const addScore = (rawArtist: string | null | undefined, weight: number) => {
    if (!rawArtist) return;
    // Split multi-artist tags lightly to keep the primary artist crisp
    const primary = rawArtist.split(/\s*(?:,|&|feat\.?|ft\.?|x|\/|;)\s*/i)[0]?.trim() || rawArtist.trim();
    const cleaned = cleanArtistLabel(primary);
    if (!isValidCandidateArtist(cleaned)) return;
    const sanitized = sanitizeDiscoverSearchTerm(cleaned);
    if (!sanitized) return;
    const key = normalizeArtistKey(sanitized);
    if (!key) return;
    const existing = scores.get(key);
    if (existing) {
      existing.score += weight;
    } else {
      scores.set(key, {display: sanitized, score: weight});
    }
  };

  // 1. User's liked tracks (strongest personal signal)
  const likedRows = db
    .prepare(
      `SELECT t.artist, COUNT(*) as cnt
       FROM liked_tracks lt
       JOIN tracks t ON t.id = lt.track_id
       WHERE lt.user_id = ?
       GROUP BY t.artist
       ORDER BY MAX(lt.liked_at) DESC, cnt DESC
       LIMIT 20`
    )
    .all(userId) as Array<{artist: string; cnt: number}>;
  for (const row of likedRows) {
    addScore(row.artist, 5 * Math.min(row.cnt, 6));
  }

  // 2. User's playlist tracks
  const playlistRows = db
    .prepare(
      `SELECT t.artist, COUNT(*) as cnt
       FROM playlist_tracks pt
       JOIN playlists p ON p.id = pt.playlist_id
       JOIN tracks t ON t.id = pt.track_id
       WHERE p.user_id = ?
       GROUP BY t.artist
       ORDER BY MAX(pt.added_at) DESC, cnt DESC
       LIMIT 20`
    )
    .all(userId) as Array<{artist: string; cnt: number}>;
  for (const row of playlistRows) {
    addScore(row.artist, 3 * Math.min(row.cnt, 6));
  }

  // 3. User's recent download history
  const downloadRows = db
    .prepare(
      `SELECT artist, COUNT(*) as cnt
       FROM download_jobs
       WHERE user_id = ? AND status = 'completed' AND TRIM(artist) != ''
       GROUP BY artist
       ORDER BY MAX(created_at) DESC
       LIMIT 15`
    )
    .all(userId) as Array<{artist: string; cnt: number}>;
  for (const row of downloadRows) {
    addScore(row.artist, 2.5 * Math.min(row.cnt, 5));
  }

  // 4. Local library tracks (most populated & recently added artists)
  const libraryRows = db
    .prepare(
      `SELECT artist, COUNT(*) as cnt
       FROM tracks
       WHERE TRIM(artist) != ''
       GROUP BY artist
       ORDER BY cnt DESC, MAX(added_at) DESC
       LIMIT 30`
    )
    .all() as Array<{artist: string; cnt: number}>;
  for (const row of libraryRows) {
    addScore(row.artist, Math.min(row.cnt, 10));
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSeeds)
    .map((entry) => entry.display);
}

async function runFlatYtSearch(
  searchSpec: string,
  tempCookiePath: string | null
): Promise<Array<Record<string, unknown>>> {
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--quiet',
    '--no-warnings',
    '--no-playlist',
    '--js-runtimes',
    'node',
    '--force-ipv4',
  ];
  if (tempCookiePath) {
    args.push('--cookies', tempCookiePath);
  }
  if (getSetting('ytdlp_remote_components', 'true') === 'true') {
    args.push('--remote-components', 'ejs:github');
  }
  args.push('--', searchSpec);

  const {stdout} = await execYtdlp(args, {
    timeout: 25000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) return [];

  const parsed = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
  if (Array.isArray(parsed.entries)) {
    return parsed.entries.filter(
      (e): e is Record<string, unknown> => Boolean(e && typeof e === 'object')
    );
  }
  return [parsed];
}

function interleaveBuckets<T>(buckets: T[][], limit: number): T[] {
  const out: T[] = [];
  let idx = 0;
  while (out.length < limit) {
    let added = false;
    for (const bucket of buckets) {
      if (idx < bucket.length && out.length < limit) {
        out.push(bucket[idx]);
        added = true;
      }
    }
    if (!added) break;
    idx += 1;
  }
  return out;
}

function pruneDiscoverCache(now: number): void {
  for (const [key, entry] of discoverFeedCache.entries()) {
    if (entry.expiresAt <= now) {
      discoverFeedCache.delete(key);
    }
  }
  if (discoverFeedCache.size > DISCOVER_CACHE_MAX_ENTRIES) {
    const excess = discoverFeedCache.size - DISCOVER_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of discoverFeedCache.keys()) {
      discoverFeedCache.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < tasks.length) {
      const current = nextIdx++;
      try {
        const value = await tasks[current]();
        results[current] = {status: 'fulfilled', value};
      } catch (reason) {
        results[current] = {status: 'rejected', reason};
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, tasks.length)}, () => worker()));
  return results;
}

export async function getDiscoverFeed(
  userId: number,
  options: {forceRefresh?: boolean} = {}
): Promise<DiscoverFeedResponse> {
  const seeds = pickDiscoverSeedArtists(userId, 3);
  const basedOnLibrary = seeds.length > 0;
  const cacheKey = basedOnLibrary
    ? seeds
        .map((s) => normalizeArtistKey(s))
        .sort()
        .join('|')
    : '__trending__';

  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = discoverFeedCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return {...cached.data, cached: true};
    }
    if (cached) {
      discoverFeedCache.delete(cacheKey);
    }
    const existing = discoverInFlight.get(cacheKey);
    if (existing) {
      const data = await existing;
      return {...data, cached: false};
    }
  }

  const buildPromise = (async (): Promise<Omit<DiscoverFeedResponse, 'cached'>> => {
    const tempCookiePath = createTempCookiesCopy();
    try {
      const seedKeys = new Set(seeds.map((s) => normalizeArtistKey(s)));
      const effectiveSeeds = basedOnLibrary ? seeds : [''];

      type TaskKind = 'new' | 'artists' | 'albums';
      const taskSpecs: Array<{kind: TaskKind; seed: string; query: string}> = [];

      if (basedOnLibrary) {
        for (const seed of effectiveSeeds) {
          const safeSeed = sanitizeDiscoverSearchTerm(seed);
          if (!safeSeed) continue;
          taskSpecs.push({
            kind: 'new',
            seed,
            query: `ytsearch6:${safeSeed} new single official audio`,
          });
          taskSpecs.push({
            kind: 'artists',
            seed,
            query: `ytsearch10:songs like ${safeSeed} official audio`,
          });
          taskSpecs.push({
            kind: 'albums',
            seed,
            query: `ytsearch6:${safeSeed} full album EP mix`,
          });
        }
      } else {
        taskSpecs.push({
          kind: 'new',
          seed: '',
          query: 'ytsearch12:new music releases official audio 2026',
        });
        taskSpecs.push({
          kind: 'artists',
          seed: '',
          query: 'ytsearch12:trending music artists official audio',
        });
        taskSpecs.push({
          kind: 'albums',
          seed: '',
          query: 'ytsearch10:best new full album music mix',
        });
      }

      const settled = await runWithConcurrency(
        taskSpecs.map((spec) => () => runFlatYtSearch(spec.query, tempCookiePath)),
        4
      );

      // Detect missing yt-dlp binary cleanly
      let enoentError = false;
      let anySuccess = false;
      for (const res of settled) {
        if (res.status === 'fulfilled') {
          anySuccess = true;
        } else {
          const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
          if (msg.includes('ENOENT')) enoentError = true;
        }
      }
      if (!anySuccess && enoentError) {
        throw new Error(
          `yt-dlp binary ("${getYtdlpPath()}") is not installed on this server.`
        );
      }

      const newReleaseBuckets: DiscoverNewReleaseItem[][] = [];
      const artistBuckets: DiscoverArtistItem[][] = [];
      const albumBuckets: DiscoverAlbumItem[][] = [];

      settled.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const spec = taskSpecs[i];
        const entries = result.value;

        if (spec.kind === 'new') {
          const bucket: DiscoverNewReleaseItem[] = [];
          for (const entry of entries) {
            const videoId = typeof entry.id === 'string' ? entry.id.trim() : '';
            if (!isValidYouTubeVideoId(videoId)) continue;
            const duration = Number(entry.duration) || 0;
            // Filter out ultra-short clips (<45s) or multi-hour streams (>15m) when duration is known
            if (duration > 0 && (duration < 45 || duration > 900)) continue;

            const normalized = normalizeMetadataEntry(
              entry,
              `https://www.youtube.com/watch?v=${videoId}`,
              'New Release'
            );
            const artist = cleanArtistLabel(normalized.artist || spec.seed || normalized.channel || 'Artist');
            const title = cleanTrackTitle(normalized.title, artist);
            bucket.push({
              videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              title,
              artist,
              releaseLabel: formatReleaseLabel(entry, spec.seed ? 'New single' : 'New release'),
              duration,
              thumbnailUrl: `/api/yt-thumb/${videoId}`,
              fallbackThumbnailUrl: sanitizeHttpsThumbUrl(normalized.thumbnail_url),
              isNew: true,
              seedArtist: spec.seed || null,
            });
          }
          newReleaseBuckets.push(bucket);
        } else if (spec.kind === 'artists') {
          const bucket: DiscoverArtistItem[] = [];
          for (const entry of entries) {
            const videoId = typeof entry.id === 'string' ? entry.id.trim() : '';
            if (!isValidYouTubeVideoId(videoId)) continue;
            const rawTitle = String(entry.title || '').trim();
            const rawChannel = cleanArtistLabel(
              String(entry.channel || entry.uploader || entry.creator || '')
            );

            // Prefer parsed "Artist - Song" if channel looks like a generic music/playlist channel
            let candidateName = rawChannel;
            const sepMatch = rawTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
            if (
              (!candidateName || GENERIC_CHANNEL_PATTERN.test(candidateName)) &&
              sepMatch &&
              sepMatch[1]
            ) {
              candidateName = cleanArtistLabel(sepMatch[1]);
            }

            // Strip featured artists so avatar cards show a crisp solo/primary artist name
            candidateName = cleanArtistLabel(
              candidateName.split(/\s*(?:feat\.?|ft\.?|&|,|\|)\s*/i)[0] || candidateName
            );

            if (!isValidCandidateArtist(candidateName)) continue;
            if (GENERIC_CHANNEL_PATTERN.test(candidateName)) continue;

            const candidateKey = normalizeArtistKey(candidateName);
            if (!candidateKey) continue;
            // Exclude seed artists themselves so the shelf recommends genuinely new artists
            let matchesSeed = false;
            for (const sk of seedKeys) {
              if (candidateKey === sk || candidateKey.includes(sk) || sk.includes(candidateKey)) {
                matchesSeed = true;
                break;
              }
            }
            if (matchesSeed) continue;

            bucket.push({
              id: `${candidateKey.replace(/\s+/g, '-')}-${videoId}`,
              name: candidateName,
              subtitle: spec.seed ? `Similar to ${spec.seed}` : 'Trending artist',
              seedArtist: spec.seed || null,
              videoId,
              thumbnailUrl: `/api/yt-thumb/${videoId}`,
              fallbackThumbnailUrl: sanitizeHttpsThumbUrl(extractThumbnailUrl(entry)),
            });
          }
          artistBuckets.push(bucket);
        } else if (spec.kind === 'albums') {
          const bucket: DiscoverAlbumItem[] = [];
          for (const entry of entries) {
            const videoId = typeof entry.id === 'string' ? entry.id.trim() : '';
            if (!isValidYouTubeVideoId(videoId)) continue;
            const duration = Number(entry.duration) || 0;
            const normalized = normalizeMetadataEntry(
              entry,
              `https://www.youtube.com/watch?v=${videoId}`,
              'Album'
            );
            const artist = cleanArtistLabel(normalized.artist || spec.seed || normalized.channel || 'Artist');
            const title = cleanTrackTitle(normalized.title, artist);
            bucket.push({
              videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              title,
              artist,
              subtitle: spec.seed ? `Similar to ${spec.seed}` : 'Recommended album',
              duration,
              thumbnailUrl: `/api/yt-thumb/${videoId}`,
              fallbackThumbnailUrl: sanitizeHttpsThumbUrl(normalized.thumbnail_url),
              seedArtist: spec.seed || null,
            });
          }
          albumBuckets.push(bucket);
        }
      });

      // Deduplicate & interleave each shelf
      const seenNewIds = new Set<string>();
      const seenNewTitles = new Set<string>();
      const newReleases = interleaveBuckets(newReleaseBuckets, 24)
        .filter((item) => {
          const titleKey = `${normalizeArtistKey(item.artist)}::${normalizeArtistKey(item.title)}`;
          if (seenNewIds.has(item.videoId) || seenNewTitles.has(titleKey)) return false;
          seenNewIds.add(item.videoId);
          seenNewTitles.add(titleKey);
          return true;
        })
        .slice(0, 12);

      const seenArtists = new Set<string>();
      const artistsToDiscover = interleaveBuckets(artistBuckets, 24)
        .filter((item) => {
          const key = normalizeArtistKey(item.name);
          if (!key || seenArtists.has(key)) return false;
          seenArtists.add(key);
          return true;
        })
        .slice(0, 12);

      const seenAlbumIds = new Set<string>();
      const albumsForYou = interleaveBuckets(albumBuckets, 24)
        .filter((item) => {
          if (seenAlbumIds.has(item.videoId) || seenNewIds.has(item.videoId)) return false;
          seenAlbumIds.add(item.videoId);
          return true;
        })
        .slice(0, 12);

      const payload: Omit<DiscoverFeedResponse, 'cached'> = {
        seeds,
        basedOnLibrary,
        generatedAt: new Date().toISOString(),
        newReleases,
        artistsToDiscover,
        albumsForYou,
      };

      const completedAt = Date.now();
      pruneDiscoverCache(completedAt);
      discoverFeedCache.set(cacheKey, {
        data: payload,
        expiresAt: completedAt + DISCOVER_CACHE_TTL_MS,
      });

      return payload;
    } finally {
      if (tempCookiePath && fs.existsSync(tempCookiePath)) {
        try {
          fs.unlinkSync(tempCookiePath);
        } catch {
          // ignore
        }
      }
    }
  })();

  if (!options.forceRefresh) {
    discoverInFlight.set(cacheKey, buildPromise);
  }

  try {
    const data = await buildPromise;
    return {...data, cached: false};
  } finally {
    if (discoverInFlight.get(cacheKey) === buildPromise) {
      discoverInFlight.delete(cacheKey);
    }
  }
}


