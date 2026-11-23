import {type ChildProcess, execFile, spawn} from 'child_process';
import crypto from 'crypto';
import {EventEmitter} from 'events';
import fs from 'fs';
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
  const env: NodeJS.ProcessEnv = {...process.env, PYTHONUNBUFFERED: '1'};
  if (forcePythonModule) {
    return {cmd: 'python3', prefixArgs: ['-u', '-m', 'yt_dlp'], env};
  }
  const ytdlpPath = getYtdlpPath();
  // Execute the configured yt-dlp binary/script directly with PYTHONUNBUFFERED=1 so
  // virtualenv shebangs, zipapps, and standalone binaries all use their intended runtime
  // while keeping stdout/stderr completely unbuffered.
  return {cmd: ytdlpPath, prefixArgs: [], env};
}

async function execYtdlp(
  args: string[],
  options: {timeout?: number; maxBuffer?: number} = {}
): Promise<{stdout: string; stderr: string}> {
  const primary = resolveYtdlpInvocation(false);
  try {
    return await execFileAsync(primary.cmd, [...primary.prefixArgs, ...args], {
      timeout: options.timeout ?? 30000,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      env: primary.env,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' && primary.cmd !== 'python3') {
      const fallback = resolveYtdlpInvocation(true);
      return await execFileAsync(fallback.cmd, [...fallback.prefixArgs, ...args], {
        timeout: options.timeout ?? 30000,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
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
    try {
      if (!ytProc.killed) ytProc.kill('SIGTERM');
    } catch {
      // ignore
    }
    try {
      if (!ffProc.killed) ffProc.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (tempCookiePath) {
      try {
        fs.unlinkSync(tempCookiePath);
      } catch {
        // ignore
      }
    }
  };
  ytProc.on('error', cleanup);
  ffProc.on('exit', cleanup);
  ffProc.on('error', cleanup);
  return {stream: ffProc.stdout, cleanup};
}

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const YT_STREAM_CACHE_TTL_MS = 30 * 60 * 1000;
const YT_STREAM_CACHE_MAX_ENTRIES = 500;
const YT_THUMB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const YT_THUMB_CACHE_MAX_ENTRIES = 1000;
const YT_VISITOR_DATA_TTL_MS = 30 * 60 * 1000; // Refresh session visitor_data every 30 min
const TRACK_VIDEO_MAP_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const TRACK_VIDEO_CACHE_MAX_ENTRIES = 2000;

const ALLOWED_YT_MEDIA_HOST_SUFFIXES = [
  '.googlevideo.com',
  '.youtube.com',
  '.ytimg.com',
  '.googleusercontent.com',
];

export interface ResolvedYouTubeAudioStream {
  url: string;
  headers: Record<string, string>;
  strategy: 'fast-path' | 'tv-fallback' | 'fallback' | 'fallback-cookies';
  thumbnailUrl: string;
  contentType: string;
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

const ytStreamUrlCache = new Map<
  string,
  ResolvedYouTubeAudioStream & {expiresAt: number}
>();
const ytStreamInFlight = new Map<string, Promise<ResolvedYouTubeAudioStream>>();
const ytThumbnailCache = new Map<string, {url: string; expiresAt: number}>();
let ytVisitorDataCache: {value: string; expiresAt: number} | null = null;
let ytVisitorDataInFlight: Promise<string | null> | null = null;

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

function cacheYouTubeThumbnailUrl(videoId: string, rawUrl: string): void {
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

export function isYouTubeStreamCached(videoId: string): boolean {
  const entry = ytStreamUrlCache.get(videoId);
  return Boolean(entry && entry.expiresAt > Date.now());
}

async function getSessionVisitorData(): Promise<string | null> {
  const now = Date.now();
  if (ytVisitorDataCache && ytVisitorDataCache.expiresAt > now) {
    return ytVisitorDataCache.value;
  }
  if (ytVisitorDataInFlight) {
    return ytVisitorDataInFlight;
  }

  ytVisitorDataInFlight = (async (): Promise<string | null> => {
    try {
      const resp = await fetch('https://www.youtube.com/sw.js_data', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      const text = (await resp.text()).replace(/^\)\]\}'\s*/, '');
      const parsed = JSON.parse(text) as unknown;
      const candidate =
        Array.isArray(parsed) &&
        Array.isArray(parsed[0]) &&
        Array.isArray(parsed[0][2]) &&
        Array.isArray(parsed[0][2][0]) &&
        Array.isArray(parsed[0][2][0][0]) &&
        typeof parsed[0][2][0][0][13] === 'string'
          ? parsed[0][2][0][0][13].trim()
          : '';
      if (candidate && /^[A-Za-z0-9_%-]{10,120}$/.test(candidate)) {
        ytVisitorDataCache = {
          value: candidate,
          expiresAt: Date.now() + YT_VISITOR_DATA_TTL_MS,
        };
        return candidate;
      }
      return null;
    } catch {
      return null;
    } finally {
      ytVisitorDataInFlight = null;
    }
  })();

  return ytVisitorDataInFlight;
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
  abr?: unknown;
  tbr?: unknown;
  http_headers?: unknown;
}

function pickDirectAudioFormat(
  data: Record<string, unknown> & {
    url?: unknown;
    vcodec?: unknown;
    acodec?: unknown;
    protocol?: unknown;
    ext?: unknown;
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

async function probeAudioStreamUrl(
  streamUrl: string,
  streamHeaders: Record<string, string>
): Promise<{ok: boolean; status: number; contentType: string}> {
  try {
    const headers: Record<string, string> = {
      ...streamHeaders,
      Range: 'bytes=0-1',
    };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) {
      headers.Accept = '*/*';
    }
    const resp = await fetch(streamUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    const finalUrl = resp.url || streamUrl;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    try {
      await resp.body?.cancel();
    } catch {
      // ignore
    }
    if (!isAllowedYouTubeMediaUrl(finalUrl)) {
      return {ok: false, status: resp.status, contentType: ct};
    }
    if (resp.status !== 200 && resp.status !== 206) {
      return {ok: false, status: resp.status, contentType: ct};
    }
    if (
      ct.includes('text/html') ||
      ct.includes('mpegurl') ||
      ct.includes('dash+xml') ||
      ct.includes('application/json')
    ) {
      return {ok: false, status: 415, contentType: ct};
    }
    return {ok: true, status: resp.status, contentType: ct};
  } catch {
    return {ok: false, status: 0, contentType: ''};
  }
}

export async function resolveYouTubeAudioStreamUrl(
  videoId: string,
  options: {forceRefresh?: boolean; skipFastPath?: boolean} = {}
): Promise<ResolvedYouTubeAudioStream & {fromCache: boolean}> {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new Error('Invalid YouTube video ID');
  }

  const now = Date.now();
  if (!options.forceRefresh && !options.skipFastPath) {
    const cached = ytStreamUrlCache.get(videoId);
    if (cached && cached.expiresAt > now) {
      return {
        url: cached.url,
        headers: {...cached.headers},
        strategy: cached.strategy,
        thumbnailUrl: cached.thumbnailUrl,
        contentType: cached.contentType,
        fromCache: true,
      };
    }
    if (cached) {
      ytStreamUrlCache.delete(videoId);
    }

    const existingPromise = ytStreamInFlight.get(videoId);
    if (existingPromise) {
      const resolved = await existingPromise;
      return {...resolved, headers: {...resolved.headers}, fromCache: false};
    }
  }

  const DIRECT_AUDIO_FORMAT_EXPR =
    'bestaudio[ext=m4a][vcodec=none][protocol=https]/bestaudio[acodec!=none][vcodec=none][protocol=https]/bestaudio[ext=m4a][vcodec=none]/bestaudio[acodec!=none][vcodec=none]';

  const runExtractionAttempt = async (
    extractorArgs: string | null,
    cookiePath: string | null,
    strategy: ResolvedYouTubeAudioStream['strategy'],
    timeoutMs: number
  ): Promise<ResolvedYouTubeAudioStream> => {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '--js-runtimes',
      'node',
      '--force-ipv4',
      '-f',
      DIRECT_AUDIO_FORMAT_EXPR,
    ];
    if (extractorArgs) {
      args.push('--extractor-args', extractorArgs);
    }
    if (getSetting('ytdlp_remote_components', 'true') === 'true') {
      args.push('--remote-components', 'ejs:github');
    }
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }
    args.push('--', `https://www.youtube.com/watch?v=${videoId}`);

    const {stdout} = await execYtdlp(args, {
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
    });

    const trimmed = stdout.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) {
      throw new Error('Could not parse YouTube stream metadata JSON');
    }
    const data = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown> & {
      url?: unknown;
      vcodec?: unknown;
      acodec?: unknown;
      protocol?: unknown;
      ext?: unknown;
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
    const headers = sanitizeStreamHeaders(primaryFormat.http_headers ?? data.http_headers);

    // Live Range probe guarantees Node's fetch() can stream this URL without a 403/502
    const probe = await probeAudioStreamUrl(directUrl, headers);
    if (!probe.ok) {
      throw new Error(`Upstream probe rejected (${probe.status || 'network-error'})`);
    }

    return {
      url: directUrl,
      headers,
      strategy,
      thumbnailUrl: extractedThumb || getCachedYouTubeThumbnailUrl(videoId) || '',
      contentType: probe.contentType || guessAudioContentType(primaryFormat.ext),
    };
  };

  const resolvePromise = (async (): Promise<ResolvedYouTubeAudioStream> => {
    let tempCookiePath: string | null = null;
    try {
      const configuredClient = getSetting('ytdlp_player_client', '').trim();
      const strategies: Array<{
        strategy: ResolvedYouTubeAudioStream['strategy'];
        extractorArgs: string | null;
        useCookies: boolean;
        timeoutMs: number;
      }> = [];

      if (!options.skipFastPath) {
        // Attempt 1 (Fast Path): android_vr + cached 30m visitor_data with player_skip=webpage,configs
        // to avoid downloading full watch-page HTML on every stream lookup.
        const visitorData = await getSessionVisitorData();
        const fastArgs = visitorData
          ? `youtube:player_client=android_vr;visitor_data=${visitorData};player_skip=webpage,configs`
          : 'youtube:player_client=android_vr;player_skip=webpage,configs';
        strategies.push({
          strategy: 'fast-path',
          extractorArgs: fastArgs,
          useCookies: false,
          timeoutMs: 12000,
        });
      }

      // Attempt 2: tv + android_vr (tv client bypasses web PO-token 403s reliably)
      const tvClients =
        configuredClient && configuredClient !== 'android_vr'
          ? `${configuredClient},tv,android_vr`
          : 'tv,android_vr';
      strategies.push({
        strategy: 'tv-fallback',
        extractorArgs: `youtube:player_client=${tvClients}`,
        useCookies: false,
        timeoutMs: 16000,
      });

      // Attempt 3: mobile/default multi-client anonymous fallback
      strategies.push({
        strategy: 'fallback',
        extractorArgs: 'youtube:player_client=ios,mweb,default',
        useCookies: false,
        timeoutMs: 18000,
      });

      // Attempt 4: cookies.txt fallback when configured
      if (hasConfiguredCookies()) {
        strategies.push({
          strategy: 'fallback-cookies',
          extractorArgs: 'youtube:player_client=tv,default,mweb',
          useCookies: true,
          timeoutMs: 20000,
        });
      }

      let resolved: ResolvedYouTubeAudioStream | null = null;
      let lastError: unknown = null;

      for (const step of strategies) {
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
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[yt-stream-resolve] ${videoId} ${step.strategy} failed:`, msg.slice(0, 220));
        }
      }

      if (!resolved) {
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

  if (!options.forceRefresh && !options.skipFastPath) {
    ytStreamInFlight.set(videoId, resolvePromise);
  }

  try {
    const resolved = await resolvePromise;
    return {...resolved, headers: {...resolved.headers}, fromCache: false};
  } finally {
    if (ytStreamInFlight.get(videoId) === resolvePromise) {
      ytStreamInFlight.delete(videoId);
    }
  }
}

/**
 * Live audio pipe fallback using yt-dlp directly when all direct googlevideo URLs
 * are rejected (e.g. SABR/HLS-only or strict IP-bound streams).
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
    '--js-runtimes',
    'node',
    '--force-ipv4',
    '--extractor-args',
    'youtube:player_client=tv,android_vr,default',
  ];
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

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (!proc.killed) proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (tempCookiePath && fs.existsSync(tempCookiePath)) {
      try {
        fs.unlinkSync(tempCookiePath);
      } catch {
        // ignore
      }
    }
  };

  proc.on('exit', cleanup);
  proc.on('error', cleanup);

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
        if (isValidYouTubeVideoId(vid) && !isYouTubeStreamCached(vid)) {
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
      if (isYouTubeStreamCached(vid)) continue;
      dedupKey = `vid:${vid}`;
    } else if (title) {
      const existingVid = getCachedTrackVideoId(artist, title);
      if (existingVid && isYouTubeStreamCached(existingVid)) continue;
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


