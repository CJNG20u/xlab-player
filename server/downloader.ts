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
  getFfmpegPath,
  getMusicDir,
  getSetting,
  getYtdlpPath,
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

function isRecoverableCookieError(errMessage: string): boolean {
  const lower = (errMessage || '').toLowerCase();
  return RECOVERABLE_COOKIE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

function hasConfiguredCookies(): boolean {
  try {
    return fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 0;
  } catch {
    return false;
  }
}

export function normalizeDownloadQuality(raw?: unknown): DownloadQuality {
  const val = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (val === 'standard' || val === 'high' || val === 'ultra') return val;
  const settingVal = getSetting('ytdlp_download_quality', 'ultra').trim().toLowerCase();
  if (settingVal === 'standard' || settingVal === 'high' || settingVal === 'ultra') {
    return settingVal;
  }
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

async function execYtdlp(
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

function createTempCookiesCopy(): string | null {
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

function extractThumbnailUrl(entry: Record<string, unknown>): string {
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
  if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
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
    const shortsMatch = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/.exec(parsed.pathname);
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
        .filter((e) => e && (e.title || e.id))
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
    const items = parsed.entries
      .filter((e) => e && (e.title || e.id))
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
  const quality = normalizeDownloadQuality(params.quality);
  const requestedFormat = String(params.format || '').trim().toLowerCase();
  const storedFormat =
    quality === 'standard' || quality === 'high'
      ? 'mp3'
      : requestedFormat === 'opus'
        ? 'opus'
        : requestedFormat === 'mp3'
          ? 'mp3'
          : 'm4a';

  const result = db
    .prepare(
      `INSERT INTO download_jobs (user_id, url, title, artist, album, format, quality, status, progress, stage, thumbnail_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'Queued', ?)`
    )
    .run(
      params.userId,
      params.url,
      params.title,
      params.artist,
      params.album,
      storedFormat,
      quality,
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

async function executeDownloadJob(job: DownloadJobRow): Promise<void> {
  const ffmpegPath = getFfmpegPath();
  const cropCover = getSetting('ytdlp_crop_cover', 'true') === 'true';
  const musicDir = path.resolve(getMusicDir());
  const quality = normalizeDownloadQuality(job.quality);

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
    const nativeFormatSelector =
      job.format === 'opus'
        ? 'bestaudio[vcodec=none][ext=opus]/bestaudio[vcodec=none][acodec*=opus]/bestaudio[vcodec=none][ext=m4a]/bestaudio[vcodec=none]'
        : 'bestaudio[vcodec=none][ext=m4a]/bestaudio[vcodec=none][acodec*=opus]/bestaudio[vcodec=none][ext=opus]/bestaudio[vcodec=none]';

    const buildNativeArgs = (cookiePath: string | null): string[] => {
      const args = [
        '--newline',
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes',
        'node',
        '--force-ipv4',
        '-f',
        nativeFormatSelector,
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
      const args = [
        '--newline',
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes',
        'node',
        '--force-ipv4',
        '--extract-audio',
      ];
      if (quality === 'standard') {
        args.push('--audio-format', 'mp3', '--audio-quality', '128K');
      } else if (quality === 'high') {
        args.push('--audio-format', 'mp3', '--audio-quality', '320K');
      } else {
        // Ultra (default): best native codec with bitrate 0 (zero transcoding loss)
        args.push('--audio-format', 'best', '--audio-quality', '0');
      }
      args.push(
        '--write-thumbnail',
        '--convert-thumbnails',
        'jpg',
        '--ffmpeg-location',
        ffmpegPath
      );
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

    // STAGE 3: Fallback extraction (`-x --audio-format <codec>`) with configured quality profile
    if (!downloadedAudioPath) {
      if (!tempCookiePath && hasConfiguredCookies()) {
        tempCookiePath = createTempCookiesCopy();
      }
      updateJob(job.id, {
        status: 'downloading',
        progress: 12,
        stage: `Fallback Extraction (${quality})`,
      });
      try {
        await spawnYtdlpStage(
          job.id,
          `Fallback Extraction (${quality})`,
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

    // FFmpeg audio-only stream sanitization (`-vn -c:a copy` for ultra/native, MP3 128k/320k for standard/high) + tags
    updateJob(job.id, {status: 'processing', progress: 86, stage: 'Finalizing Audio & Tags'});

    const rawExt = path.extname(downloadedAudioPath).replace('.', '').toLowerCase();
    let finalExt = ALLOWED_FINAL_AUDIO_EXTS.has(rawExt) ? rawExt : 'm4a';
    let finalizedTempPath = downloadedAudioPath;

    if (quality === 'standard' || quality === 'high') {
      const targetBitrate = quality === 'standard' ? '128k' : '320k';
      const mp3Out = path.join(tmpWorkDir, `${jobUuid}-final.mp3`);
      const ffArgs: string[] = ['-y', '-i', downloadedAudioPath];
      if (coverPath) {
        ffArgs.push(
          '-i',
          coverPath,
          '-map',
          '0:a:0',
          '-map',
          '1:v:0',
          '-c:a',
          rawExt === 'mp3' ? 'copy' : 'libmp3lame',
          ...(rawExt === 'mp3' ? [] : ['-b:a', targetBitrate]),
          '-c:v',
          'mjpeg',
          '-id3v2_version',
          '3',
          '-disposition:v:0',
          'attached_pic'
        );
      } else {
        ffArgs.push(
          '-vn',
          '-c:a',
          rawExt === 'mp3' ? 'copy' : 'libmp3lame',
          ...(rawExt === 'mp3' ? [] : ['-b:a', targetBitrate])
        );
      }
      ffArgs.push(
        '-metadata',
        `title=${resolvedTitle}`,
        '-metadata',
        `artist=${resolvedArtist}`,
        '-metadata',
        `album=${resolvedAlbum}`,
        mp3Out
      );
      await execFileAsync(ffmpegPath, ffArgs, {timeout: 90000});
      if (fs.existsSync(mp3Out)) {
        finalizedTempPath = mp3Out;
        finalExt = 'mp3';
      }
    } else {
      // Ultra (default): zero transcoding loss — strip accidental video streams via `-vn -c:a copy`
      // If YouTube delivered native Opus inside .webm, cleanly remux into .opus via stream copy
      const remuxExt = rawExt === 'webm' ? 'opus' : finalExt;
      const remuxOut = path.join(tmpWorkDir, `${jobUuid}-final.${remuxExt}`);
      let remuxed = false;

      try {
        const ffArgs: string[] = ['-y', '-i', downloadedAudioPath];
        if (coverPath && (remuxExt === 'm4a' || remuxExt === 'mp3')) {
          ffArgs.push(
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
            ...(remuxExt === 'mp3' ? ['-id3v2_version', '3'] : []),
            '-disposition:v:0',
            'attached_pic'
          );
        } else {
          ffArgs.push('-vn', '-c:a', 'copy');
        }
        ffArgs.push(
          '-metadata',
          `title=${resolvedTitle}`,
          '-metadata',
          `artist=${resolvedArtist}`,
          '-metadata',
          `album=${resolvedAlbum}`,
          remuxOut
        );
        await execFileAsync(ffmpegPath, ffArgs, {timeout: 45000});
        if (fs.existsSync(remuxOut) && fs.statSync(remuxOut).size > 0) {
          finalizedTempPath = remuxOut;
          finalExt = remuxExt;
          remuxed = true;
        }
      } catch {
        remuxed = false;
      }

      // If .webm -> .opus copy failed (e.g. non-Opus codec inside webm), strip video keeping original container
      if (!remuxed) {
        const safeOut = path.join(tmpWorkDir, `${jobUuid}-stripped.${finalExt}`);
        try {
          await execFileAsync(
            ffmpegPath,
            [
              '-y',
              '-i',
              downloadedAudioPath,
              '-vn',
              '-c:a',
              'copy',
              '-metadata',
              `title=${resolvedTitle}`,
              '-metadata',
              `artist=${resolvedArtist}`,
              '-metadata',
              `album=${resolvedAlbum}`,
              safeOut,
            ],
            {timeout: 45000}
          );
          if (fs.existsSync(safeOut) && fs.statSync(safeOut).size > 0) {
            finalizedTempPath = safeOut;
          }
        } catch {
          // Keep original downloaded audio if stream copy fails
        }
      }
    }

    if (!ALLOWED_FINAL_AUDIO_EXTS.has(finalExt)) {
      finalExt = 'm4a';
    }

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

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const YT_STREAM_CACHE_TTL_MS = 30 * 60 * 1000;
const YT_STREAM_CACHE_MAX_ENTRIES = 500;
const YT_THUMB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const YT_THUMB_CACHE_MAX_ENTRIES = 1000;
const TRACK_VIDEO_MAP_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const TRACK_VIDEO_CACHE_MAX_ENTRIES = 2000;

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

// TV / ad-skippable gate polling defaults (measured gate clears in <3s)
const DEFAULT_AD_GATE_POLL_MS = 1_000;
const DEFAULT_AD_GATE_MAX_WAIT_MS = 8_000;

const LEGACY_SEEDED_PLAYER_CLIENT = 'web,mweb,android_vr';

const ALLOWED_YT_MEDIA_HOST_SUFFIXES = [
  '.googlevideo.com',
  '.youtube.com',
  '.ytimg.com',
  '.googleusercontent.com',
];

export type YouTubeStreamStrategy =
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
  usedFormatHeaders?: boolean;
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
    30_000
  );
}

function isDebugCompareEnabled(): boolean {
  const raw = process.env.YT_DEBUG_COMPARE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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

// FIFO semaphore capping concurrent yt-dlp resolver child processes on small VPS hosts
let activeResolveSlots = 0;
const resolveWaitQueue: Array<() => void> = [];

async function withYtdlpResolveSlot<T>(fn: () => Promise<T>): Promise<T> {
  const maxSlots = getMaxConcurrentResolves();
  if (activeResolveSlots >= maxSlots) {
    await new Promise<void>((resolve) => {
      resolveWaitQueue.push(resolve);
    });
  }
  activeResolveSlots += 1;
  try {
    return await fn();
  } finally {
    activeResolveSlots -= 1;
    const next = resolveWaitQueue.shift();
    if (next) next();
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
  const list: YouTubeStreamStrategy[] = ['default', 'tv-android-vr'];
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
  const c = (clientParam || '').trim().toUpperCase();
  if (c) {
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

const ytStreamUrlCache = new Map<
  string,
  ResolvedYouTubeAudioStream & {expiresAt: number}
>();
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
}

export function invalidateYouTubeAudioStreamCache(videoId: string): void {
  ytStreamUrlCache.delete(videoId);
}

export function getCachedYouTubeAudioStream(videoId: string): ResolvedYouTubeAudioStream | null {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const entry = ytStreamUrlCache.get(videoId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    ytStreamUrlCache.delete(videoId);
    return null;
  }
  return {
    url: entry.url,
    headers: {...entry.headers},
    strategy: entry.strategy,
    thumbnailUrl: entry.thumbnailUrl,
    contentType: entry.contentType,
    contentLength: entry.contentLength,
    duration: entry.duration,
    clientParam: entry.clientParam,
    usedFormatHeaders: entry.usedFormatHeaders,
  };
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
  }
): RawYtdlpFormat | null {
  const isUsableDirectAudio = (fmt: RawYtdlpFormat | null | undefined): boolean => {
    if (!fmt || typeof fmt.url !== 'string') return false;
    const u = fmt.url.trim();
    if (!u || !isAllowedYouTubeMediaUrl(u)) return false;
    if (isMuxedVideoFormat(fmt.vcodec)) return false;
    if (isManifestFormat(fmt.protocol, u)) return false;
    if (typeof fmt.acodec === 'string' && fmt.acodec.trim().toLowerCase() === 'none') return false;
    return true;
  };

  if (isUsableDirectAudio(data)) {
    return data;
  }

  if (Array.isArray(data.requested_formats)) {
    const match = data.requested_formats.find((f) => isUsableDirectAudio(f));
    if (match) return match;
  }

  if (Array.isArray(data.formats)) {
    const candidates = data.formats.filter((f) => isUsableDirectAudio(f));
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
  strategy: YouTubeStreamStrategy;
  extractorArgs: string | null;
  adSkippableDetected: boolean;
  formatId: string;
  ext: string;
  protocol: string;
  streamUrl: string;
  streamHeaders: Record<string, string>;
  topLevelHeaders: Record<string, string>;
  usedFormatHeaders: boolean;
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
      const isTvClient = isTvClientForAdGate(
        params.strategy,
        urlParams.client,
        params.extractorArgs
      );
      const shouldPollAdGate = isTvClient || params.adSkippableDetected;

      // Short polling retry for TV clients (or yt-dlp stderr containing "ad skippable"):
      // re-probe the EXACT same URL with the format's own http_headers until 200/206 or maxWaitMs.
      // Never open the strategy-level circuit on first-probe 403s inside the polling window.
      if (shouldPollAdGate) {
        const pollMs = getAdGatePollMs();
        const maxWaitMs = getAdGateMaxWaitMs();
        const pollStartMs = Date.now();
        let pollAttempts = 0;
        let lastOutcome = first;

        console.info(
          '[yt-stream-probe]',
          JSON.stringify({
            event: 'ad_gate_poll_start',
            videoId: params.videoId,
            strategy: params.strategy,
            formatId: params.formatId,
            client: urlParams.client,
            adSkippableStderr: params.adSkippableDetected,
            pollMs,
            maxWaitMs,
            firstProbeElapsedMs: firstElapsedMs,
          })
        );

        while (true) {
          const elapsedWaitMs = Date.now() - pollStartMs;
          const remainingMs = maxWaitMs - elapsedWaitMs;
          if (remainingMs <= 0) {
            break;
          }

          await sleepDelay(Math.min(pollMs, remainingMs));
          pollAttempts += 1;

          const remainingAfterSleepMs = maxWaitMs - (Date.now() - pollStartMs);
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
            recordStrategyDirectSuccess(params.strategy, params.videoId);
            console.info(
              '[yt-stream-probe]',
              JSON.stringify({
                event: 'ad_gate_cleared',
                videoId: params.videoId,
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

        // Entire ad-gate window passed with 403s: log observed waitedMs, do NOT open strategy circuit
        // for confirmed ad-skippable videos, and signal immediate pipe fallback + 5-min negative cache.
        const waitedMs = Date.now() - pollStartMs;
        const poTokenSuspected =
          lastOutcome.ipFamily === 'IPv4' &&
          params.usedFormatHeaders &&
          !urlParams.hasPot &&
          !hasPoTokenProvider() &&
          !params.adSkippableDetected;

        console.warn(
          '[yt-stream-probe]',
          JSON.stringify({
            event: 'ad_gate_exhausted',
            videoId: params.videoId,
            waitedMs,
            attempts: pollAttempts,
            pollMs,
            maxWaitMs,
            strategy: params.strategy,
            formatId: params.formatId,
            client: urlParams.client,
            adSkippableStderr: params.adSkippableDetected,
            status: 403,
            ipFamily: lastOutcome.ipFamily,
            serverHeader: lastOutcome.serverHeader,
            contentType: lastOutcome.contentTypeHeader,
            usedFormatHeaders: params.usedFormatHeaders,
            urlParams,
            sentHeaders: summarizeHeadersForLog(headers),
            poTokenSuspected,
          })
        );

        await maybeRunAutoDebugCompare();

        return {
          ok: false,
          status: 403,
          contentType: lastOutcome.contentType,
          contentLength: null,
          ipFamily: lastOutcome.ipFamily,
          urlParams,
          poTokenSuspected,
          adGateCleared: false,
          adGateExhausted: true,
          waitedMs,
        };
      }

      // Non-TV strategy (and no "ad skippable" stderr): do NOT poll; fail fast and update circuit
      const poTokenSuspected =
        first.ipFamily === 'IPv4' &&
        params.usedFormatHeaders &&
        !urlParams.hasPot &&
        !hasPoTokenProvider();
      const attribution = poTokenSuspected
        ? '403 with format http_headers and missing pot= param — likely requires PO token'
        : '403 with unknown cause';

      console.warn(
        '[yt-stream-probe]',
        JSON.stringify({
          event: 'probe_403',
          videoId: params.videoId,
          strategy: params.strategy,
          formatId: params.formatId,
          status: first.statusCode,
          ipFamily: first.ipFamily,
          elapsedMs: firstElapsedMs,
          waitedMs: 0,
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
  options: {forceRefresh?: boolean; skipStrategies?: YouTubeStreamStrategy[]} = {}
): Promise<ResolvedYouTubeAudioStream & {fromCache: boolean}> {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new Error('Invalid YouTube video ID');
  }

  const skipSet = new Set<YouTubeStreamStrategy>(options.skipStrategies || []);

  // Short-circuit immediately only if every active direct strategy is in cooldown
  if (isDirectProxyCircuitOpen()) {
    throw new DirectProxyCircuitOpenError(getDirectProxyCircuitCooldownRemainingMs());
  }

  if (!options.forceRefresh && skipSet.size === 0) {
    const cached = getCachedYouTubeAudioStream(videoId);
    if (cached && !isStrategyCircuitOpen(cached.strategy)) {
      return {...cached, fromCache: true};
    }
  }

  // Deduplicate concurrent requests (e.g. HEAD + GET or concurrent range probes) per videoId
  const existingPromise = inFlightResolutions.get(videoId);
  if (existingPromise) {
    const resolved = await existingPromise;
    return {...resolved, headers: {...resolved.headers}, fromCache: false};
  }

  const DIRECT_AUDIO_FORMAT_EXPR =
    'bestaudio[ext=m4a][vcodec=none][protocol=https]/bestaudio[acodec!=none][vcodec=none][protocol=https]/bestaudio[ext=m4a][vcodec=none]/bestaudio[acodec!=none][vcodec=none]';

  const runExtractionAttempt = async (
    extractorArgs: string | null,
    cookiePath: string | null,
    strategy: YouTubeStreamStrategy,
    timeoutMs: number
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
      DIRECT_AUDIO_FORMAT_EXPR,
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

    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    try {
      const result = await withYtdlpResolveSlot(() =>
        execYtdlp(args, {
          timeout: timeoutMs,
          maxBuffer: 12 * 1024 * 1024,
        })
      );
      stdout = result.stdout;
      stderr = result.stderr || '';
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
          extractorArgs: extractorArgs || 'default',
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
      throw new Error(
        isTimeout
          ? `yt-dlp ${strategy} timed out after ${elapsedMs}ms (limit ${timeoutMs}ms)`
          : `yt-dlp ${strategy} exited (${String(code ?? signal ?? 'error')}): ${(stderrText || execErr.message).slice(0, 260)}`
      );
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
          extractorArgs: extractorArgs || 'default',
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

    const primaryFormat = pickDirectAudioFormat(data);
    if (!primaryFormat || typeof primaryFormat.url !== 'string') {
      throw new Error('No direct HTTPS audio-only format returned by yt-dlp');
    }

    const directUrl = primaryFormat.url.trim();
    const {headers, usedFormatHeaders} = selectFormatStreamHeaders(data, primaryFormat);
    const topLevelHeaders = sanitizeStreamHeaders(data.http_headers);
    const formatId = String(primaryFormat.format_id ?? data.format_id ?? 'unknown');
    const formatExt = String(primaryFormat.ext ?? data.ext ?? 'unknown');
    const formatProtocol = String(primaryFormat.protocol ?? data.protocol ?? 'unknown');

    const adSkippableDetected = /ad\s+skippable/i.test(stderr);

    // Live IPv4 Range probe guarantees Node can stream this exact URL with the format's http_headers
    const probe = await probeAudioStreamUrl({
      videoId,
      strategy,
      extractorArgs,
      adSkippableDetected,
      formatId,
      ext: formatExt,
      protocol: formatProtocol,
      streamUrl: directUrl,
      streamHeaders: headers,
      topLevelHeaders,
      usedFormatHeaders,
    });
    if (!probe.ok) {
      const clientFamily = classifyClientFamily(probe.urlParams.client, strategy);
      const poHint = probe.adGateExhausted
        ? ` (ad-gate 403 persisted for ${probe.waitedMs}ms)`
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

    return {
      url: directUrl,
      headers,
      strategy,
      thumbnailUrl: extractedThumb || getCachedYouTubeThumbnailUrl(videoId) || '',
      contentType: probe.contentType || guessAudioContentType(primaryFormat.ext),
      contentLength,
      duration,
      clientParam: probe.urlParams.client,
      usedFormatHeaders,
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
      }> = [
        // 1. Prefer yt-dlp's own default clients first (no forced player_client or player_skip)
        {
          strategy: 'default',
          extractorArgs: null,
          useCookies: false,
          timeoutMs: primaryTimeoutMs,
          targetFamily: 'default',
        },
        // 2. tv + android_vr fallback (distinct client family from web default; no ios/mweb PO-token clients)
        {
          strategy: 'tv-android-vr',
          extractorArgs: 'youtube:player_client=tv,android_vr',
          useCookies: false,
          timeoutMs: fallbackTimeoutMs,
          targetFamily: 'tv-vr',
        },
      ];

      // 3. Explicit non-legacy admin custom client override, if set
      if (customClient) {
        strategies.push({
          strategy: 'custom-client',
          extractorArgs: `youtube:player_client=${customClient}`,
          useCookies: false,
          timeoutMs: fallbackTimeoutMs,
          targetFamily: `custom:${customClient.toLowerCase()}`,
        });
      }

      // 4. Demote mweb/ios strictly behind an active PO token provider
      if (hasPoTokenProvider()) {
        strategies.push({
          strategy: 'po-token-mobile',
          extractorArgs: 'youtube:player_client=mweb,ios,default',
          useCookies: false,
          timeoutMs: fallbackTimeoutMs,
          targetFamily: 'mobile-pot',
        });
      }

      // 5. Cookies variants only when cookies.txt is configured
      if (hasConfiguredCookies()) {
        strategies.push(
          {
            strategy: 'default-cookies',
            extractorArgs: null,
            useCookies: true,
            timeoutMs: fallbackTimeoutMs,
            targetFamily: 'default',
          },
          {
            strategy: 'tv-cookies',
            extractorArgs: 'youtube:player_client=tv,android_vr',
            useCookies: true,
            timeoutMs: fallbackTimeoutMs,
            targetFamily: 'tv-vr',
          }
        );
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
        try {
          let cookieArg: string | null = null;
          if (step.useCookies) {
            tempCookiePath = tempCookiePath || createTempCookiesCopy();
            cookieArg = tempCookiePath;
          }
          resolved = await runExtractionAttempt(
            step.extractorArgs,
            cookieArg,
            step.strategy,
            step.timeoutMs
          );
          break;
        } catch (err) {
          lastError = err;
          if (err instanceof UpstreamProbeRejectedError && err.status === 403) {
            saw403 = true;
            failedFamilies.add(err.clientFamily);
            failedFamilies.add(step.targetFamily);
            if (err.adGateExhausted) {
              adGateExhausted = true;
              const msg = err.message;
              console.warn(`[yt-stream-resolve] ${videoId} ${step.strategy} failed: ${msg}`);
              // Whole ad-gate polling window passed with 403s: hand off straight to pipe fallback
              break;
            }
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[yt-stream-resolve] ${videoId} ${step.strategy} failed: ${msg}`);
        }
      }

      if (!resolved) {
        if (saw403) {
          const reason =
            lastError instanceof Error ? lastError.message : 'Direct upstream probe returned 403';
          markVideoDirectProxyNegative(
            videoId,
            reason,
            adGateExhausted ? AD_GATE_NEG_CACHE_TTL_MS : undefined
          );
        }
        if (attemptedCount === 0 && isDirectProxyCircuitOpen()) {
          throw new DirectProxyCircuitOpenError(getDirectProxyCircuitCooldownRemainingMs());
        }
        throw lastError instanceof Error
          ? lastError
          : new Error('Could not resolve a playable YouTube audio-only stream');
      }

      const resolvedAt = Date.now();
      pruneExpiredYtStreamCache(resolvedAt);
      ytStreamUrlCache.set(videoId, {
        ...resolved,
        expiresAt: resolvedAt + YT_STREAM_CACHE_TTL_MS,
      });
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

  inFlightResolutions.set(videoId, resolvePromise);

  try {
    const resolved = await resolvePromise;
    return {...resolved, headers: {...resolved.headers}, fromCache: false};
  } finally {
    if (inFlightResolutions.get(videoId) === resolvePromise) {
      inFlightResolutions.delete(videoId);
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
  proc.once('error', cleanup);

  return {
    stream: proc.stdout,
    cleanup,
    getStderr: () => stderrBuf.trim(),
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

function buildTrackMatchKey(artist: string, title: string): string {
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

export function getCachedTrackVideoId(artist: string, title: string): string | null {
  const key = buildTrackMatchKey(artist, title);
  if (!key || key === '::') return null;
  const now = Date.now();
  const mem = trackVideoMapCache.get(key);
  if (mem && now - mem.updatedAt <= TRACK_VIDEO_MAP_TTL_MS && isValidYouTubeVideoId(mem.videoId)) {
    return mem.videoId;
  }
  try {
    const row = getTrackVideoMapStmt.get(key) as
      | {video_id: string; matched_title: string; matched_duration: number; updated_at: number}
      | undefined;
    if (
      row &&
      now - row.updated_at <= TRACK_VIDEO_MAP_TTL_MS &&
      isValidYouTubeVideoId(row.video_id)
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

function scoreVideoCandidate(
  entry: Record<string, unknown>,
  targetArtist: string,
  targetTitle: string,
  targetDuration: number
): number {
  const rawTitle = String(entry.title || '').trim();
  const rawChannel = String(entry.channel || entry.uploader || entry.creator || '').trim();
  const candDuration = Number(entry.duration) || 0;

  let score = 0;

  // 1. Duration accuracy (strongest signal against full albums, 1-hour loops, or 15s shorts)
  if (targetDuration > 0 && candDuration > 0) {
    const diff = Math.abs(candDuration - targetDuration);
    if (diff <= 4) score += 50;
    else if (diff <= 10) score += 38;
    else if (diff <= 20) score += 22;
    else if (diff <= 40) score += 5;
    else if (diff > 90) score -= 55;
    else score -= 20;
  } else if (candDuration > 0 && (candDuration < 30 || candDuration > 900)) {
    score -= 30;
  }

  // 2. Title & artist token overlap
  const targetTitleTokens = normalizeMatchTokenText(targetTitle).split(' ').filter(Boolean);
  const targetArtistTokens = normalizeMatchTokenText(targetArtist).split(' ').filter(Boolean);
  const candCombined = normalizeMatchTokenText(`${rawTitle} ${rawChannel}`);

  if (targetTitleTokens.length > 0) {
    const matchedTitleTokens = targetTitleTokens.filter((tok) => candCombined.includes(tok)).length;
    score += Math.round((matchedTitleTokens / targetTitleTokens.length) * 30);
  }
  if (targetArtistTokens.length > 0) {
    const matchedArtistTokens = targetArtistTokens.filter((tok) => candCombined.includes(tok)).length;
    score += Math.round((matchedArtistTokens / targetArtistTokens.length) * 20);
  }

  // 3. Prefer official audio / Topic uploads; penalize covers, karaoke, slowed/reverb, live unless requested
  const lowerTitle = rawTitle.toLowerCase();
  const lowerTarget = targetTitle.toLowerCase();
  if (/-\s*topic$/i.test(rawChannel)) score += 16;
  if (/\b(?:official\s+audio|audio)\b/i.test(lowerTitle)) score += 10;
  if (/\b(?:official\s+music\s+video|official\s+video)\b/i.test(lowerTitle)) score += 4;

  const undesiredModifiers = [
    'karaoke',
    'instrumental',
    'slowed',
    'reverb',
    'nightcore',
    '8d audio',
    'sped up',
    'cover',
    'reaction',
    'tutorial',
    'piano version',
    'live',
    'remix',
  ];
  for (const mod of undesiredModifiers) {
    if (lowerTitle.includes(mod) && !lowerTarget.includes(mod)) {
      score -= 32;
    }
  }

  return score;
}

export async function resolveTrackToVideoId(input: {
  artist: string;
  title: string;
  duration?: number;
  forceRefresh?: boolean;
}): Promise<{videoId: string; matchedTitle: string; matchedDuration: number; fromCache: boolean}> {
  const artist = sanitizeMatchSearchFragment(input.artist || '');
  const title = sanitizeMatchSearchFragment(input.title || '');
  const targetDuration = Number.isFinite(Number(input.duration))
    ? Math.max(0, Math.round(Number(input.duration)))
    : 0;

  if (!title) {
    throw new Error('Track title is required to resolve audio stream');
  }

  const key = buildTrackMatchKey(artist, title);
  const now = Date.now();

  if (!input.forceRefresh) {
    const cachedVid = getCachedTrackVideoId(artist, title);
    if (cachedVid) {
      const mem = trackVideoMapCache.get(key);
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

  const searchPromise = (async () => {
    const searchQuery = artist ? `${artist} - ${title} audio` : `${title} audio`;
    const entries = await runFlatYtSearch(`ytsearch6:${searchQuery}`, null);

    let bestEntry: Record<string, unknown> | null = null;
    let bestVideoId = '';
    let bestScore = -Infinity;

    for (const entry of entries) {
      const vid = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!isValidYouTubeVideoId(vid)) continue;
      const score = scoreVideoCandidate(entry, artist, title, targetDuration);
      if (score > bestScore) {
        bestScore = score;
        bestVideoId = vid;
        bestEntry = entry;
      }
    }

    if (!bestVideoId || !bestEntry) {
      throw new Error(`No matching YouTube audio found for "${artist ? `${artist} - ` : ''}${title}"`);
    }

    const matchedTitle = String(bestEntry.title || title).trim();
    const matchedDuration = Math.max(0, Math.round(Number(bestEntry.duration) || 0));
    const thumb = extractThumbnailUrl(bestEntry);
    if (thumb) {
      cacheYouTubeThumbnailUrl(bestVideoId, thumb);
    }

    const updatedAt = Date.now();
    pruneTrackVideoMapMemory(updatedAt);
    trackVideoMapCache.set(key, {
      videoId: bestVideoId,
      matchedTitle,
      matchedDuration,
      updatedAt,
    });
    try {
      upsertTrackVideoMapStmt.run(
        key,
        artist,
        title,
        targetDuration,
        bestVideoId,
        matchedTitle,
        matchedDuration,
        updatedAt
      );
    } catch {
      // non-fatal
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

const MAX_PREFETCH_CONCURRENCY = 2;
const MAX_PREFETCH_QUEUE_SIZE = 24;
const prefetchQueue: Array<{dedupKey: string; item: PrefetchRequestItem}> = [];
const prefetchQueuedKeys = new Set<string>();
let activePrefetchWorkers = 0;

function drainPrefetchQueue(): void {
  while (activePrefetchWorkers < MAX_PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const task = prefetchQueue.shift();
    if (!task) break;
    activePrefetchWorkers += 1;

    void (async () => {
      try {
        let vid = task.item.videoId?.trim() || '';
        if (!isValidYouTubeVideoId(vid)) {
          if (!task.item.title?.trim()) return;
          const matched = await resolveTrackToVideoId({
            artist: task.item.artist || '',
            title: task.item.title,
            duration: task.item.duration,
          });
          vid = matched.videoId;
        }
        if (
          isValidYouTubeVideoId(vid) &&
          !isYouTubeStreamCached(vid) &&
          !isVideoDirectProxyNegative(vid) &&
          !isDirectProxyCircuitOpen()
        ) {
          await resolveYouTubeAudioStreamUrl(vid);
        }
      } catch {
        // Prefetch is strictly best-effort and silent
      } finally {
        prefetchQueuedKeys.delete(task.dedupKey);
        activePrefetchWorkers -= 1;
        drainPrefetchQueue();
      }
    })();
  }
}

export function enqueueYouTubePrefetch(items: PrefetchRequestItem[]): number {
  let accepted = 0;
  for (const raw of items.slice(0, 5)) {
    const vid = typeof raw.videoId === 'string' ? raw.videoId.trim() : '';
    const artist = typeof raw.artist === 'string' ? raw.artist.trim() : '';
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const duration = Number.isFinite(Number(raw.duration)) ? Math.max(0, Number(raw.duration)) : 0;

    let dedupKey = '';
    if (isValidYouTubeVideoId(vid)) {
      if (isYouTubeStreamCached(vid) || isVideoDirectProxyNegative(vid)) continue;
      dedupKey = `vid:${vid}`;
    } else if (title) {
      const existingVid = getCachedTrackVideoId(artist, title);
      if (existingVid && (isYouTubeStreamCached(existingVid) || isVideoDirectProxyNegative(existingVid))) {
        continue;
      }
      dedupKey = existingVid ? `vid:${existingVid}` : `meta:${buildTrackMatchKey(artist, title)}`;
    } else {
      continue;
    }

    if (prefetchQueuedKeys.has(dedupKey)) continue;
    if (prefetchQueue.length >= MAX_PREFETCH_QUEUE_SIZE) {
      // Drop oldest queued prefetch in favor of newer user-visible tracks
      const evicted = prefetchQueue.shift();
      if (evicted) prefetchQueuedKeys.delete(evicted.dedupKey);
    }

    prefetchQueuedKeys.add(dedupKey);
    prefetchQueue.push({
      dedupKey,
      item: {
        videoId: isValidYouTubeVideoId(vid) ? vid : undefined,
        artist,
        title,
        duration,
      },
    });
    accepted += 1;
  }

  if (accepted > 0) {
    drainPrefetchQueue();
  }
  return accepted;
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


