import {execFile, spawn} from 'child_process';
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
import {indexSingleFile} from './scanner.ts';

const execFileAsync = promisify(execFile);

export interface DownloadJobRow {
  id: number;
  user_id: number | null;
  url: string;
  title: string;
  artist: string;
  album: string;
  format: string;
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
  duplicateTrack: {id: number; title: string; artist: string; album: string} | null;
}

export const downloadEvents = new EventEmitter();
downloadEvents.setMaxListeners(50);

let isProcessingQueue = false;

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

export async function fetchMetadataPreview(input: string): Promise<{
  mode: 'search' | 'single' | 'playlist';
  isSearch: boolean;
  isPlaylist: boolean;
  playlistTitle: string | null;
  items: MetadataPreviewItem[];
}> {
  const ytdlpPath = getYtdlpPath();
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Please enter a YouTube URL or search query');
  }

  const isUrl = /^https?:\/\//i.test(trimmed);
  const tempCookiePath = createTempCookiesCopy();

  try {
    if (!isUrl) {
      // Plain-text song/artist search -> yt-dlp --dump-json --flat-playlist "ytsearch25:<query>"
      const args = [
        '--dump-json',
        '--flat-playlist',
        '--no-warnings',
        ...buildResilienceArgs(tempCookiePath, {includeSleep: false}),
        `ytsearch25:${trimmed}`,
      ];

      const {stdout} = await execFileAsync(ytdlpPath, args, {
        timeout: 45000,
        maxBuffer: 15 * 1024 * 1024,
      });

      const rawEntries: Array<Record<string, unknown>> = [];
      for (const line of stdout.split(/\r?\n/)) {
        const clean = line.trim();
        if (!clean.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(clean) as Record<string, unknown>;
          if (parsed._type === 'playlist' && Array.isArray(parsed.entries)) {
            for (const sub of parsed.entries) {
              if (sub && typeof sub === 'object') {
                rawEntries.push(sub as Record<string, unknown>);
              }
            }
          } else {
            rawEntries.push(parsed);
          }
        } catch {
          // Skip malformed output lines
        }
      }

      const items = rawEntries
        .filter((e) => e && (e.title || e.id))
        .slice(0, 25)
        .map((entry) => normalizeMetadataEntry(entry, trimmed, 'Singles'));

      return {
        mode: 'search',
        isSearch: true,
        isPlaylist: false,
        playlistTitle: null,
        items,
      };
    }

    // Direct URL (single video or playlist)
    const args = [
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      ...buildResilienceArgs(tempCookiePath, {includeSleep: false}),
      trimmed,
    ];

    const {stdout} = await execFileAsync(ytdlpPath, args, {
      timeout: 45000,
      maxBuffer: 15 * 1024 * 1024,
    });

    const data = JSON.parse(stdout) as Record<string, unknown>;
    const isPlaylist = Boolean(data._type === 'playlist' && Array.isArray(data.entries));
    const playlistTitle = isPlaylist ? String(data.title || 'Playlist') : null;
    const rawEntries: Array<Record<string, unknown>> = isPlaylist
      ? (data.entries as Array<Record<string, unknown>>)
      : [data];

    const fallbackAlbum = isPlaylist && playlistTitle ? playlistTitle : 'Singles';

    const items = rawEntries
      .filter((e) => e && (e.title || e.id))
      .slice(0, 50)
      .map((entry) => normalizeMetadataEntry(entry, trimmed, fallbackAlbum));

    return {
      mode: isPlaylist ? 'playlist' : 'single',
      isSearch: false,
      isPlaylist,
      playlistTitle,
      items,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      throw new Error(
        `yt-dlp binary ("${ytdlpPath}") is not installed on this server. Install yt-dlp in your Proxmox LXC container or use Upload Local Audio Files below.`
      );
    }
    throw new Error(`Failed to fetch metadata: ${msg.slice(0, 320)}`);
  } finally {
    if (tempCookiePath && fs.existsSync(tempCookiePath)) {
      try {
        fs.unlinkSync(tempCookiePath);
      } catch {
        // Ignore cleanup failure
      }
    }
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
    .get(id) as DownloadJobRow;
  downloadEvents.emit('job', updated);
  return updated;
}

export function enqueueDownloadJob(params: {
  userId: number;
  url: string;
  title: string;
  artist: string;
  album: string;
  format: 'm4a' | 'opus';
  thumbnailUrl?: string;
}): DownloadJobRow {
  const result = db
    .prepare(
      `INSERT INTO download_jobs (user_id, url, title, artist, album, format, status, progress, stage, thumbnail_url)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 'Queued', ?)`
    )
    .run(
      params.userId,
      params.url,
      params.title,
      params.artist,
      params.album,
      params.format,
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

async function executeDownloadJob(job: DownloadJobRow): Promise<void> {
  const ytdlpPath = getYtdlpPath();
  const ffmpegPath = getFfmpegPath();
  const cropCover = getSetting('ytdlp_crop_cover', 'true') === 'true';
  const musicDir = getMusicDir();

  const safeArtist = sanitizeNasSegment(job.artist, 'Unknown Artist');
  const safeAlbum = sanitizeNasSegment(job.album, 'Singles');
  const safeTitle = sanitizeNasSegment(job.title, `Track_${job.id}`);
  const audioExt = job.format === 'opus' ? 'opus' : 'm4a';

  const destFolder = path.join(musicDir, safeArtist, safeAlbum);
  const finalAudioPath = path.join(destFolder, `${safeTitle}.${audioExt}`);

  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlab-dl-'));
  const tempCookiePath = createTempCookiesCopy();

  try {
    fs.mkdirSync(destFolder, {recursive: true});
    updateJob(job.id, {status: 'downloading', progress: 2, stage: 'Downloading', error_log: ''});

    const outTemplate = path.join(tmpWorkDir, 'audio.%(ext)s');
    const args = [
      '--newline',
      '--no-playlist',
      '--windows-filenames',
      '--extract-audio',
      '--audio-format',
      audioExt,
      '--audio-quality',
      '0',
      '--write-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '--ffmpeg-location',
      ffmpegPath,
      ...buildResilienceArgs(tempCookiePath),
      '-o',
      outTemplate,
      job.url,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(ytdlpPath, args, {stdio: ['ignore', 'pipe', 'pipe']});
      let stderrBuf = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
          if (match) {
            const pct = Math.min(75, Math.round(parseFloat(match[1]) * 0.75));
            updateJob(job.id, {progress: pct, stage: 'Downloading'});
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      child.on('error', (err) => {
        reject(new Error(`Could not launch ${ytdlpPath}: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderrBuf.trim() || `yt-dlp exited with code ${code}`));
      });
    });

    // Find downloaded audio file and thumbnail in tmpWorkDir
    const tmpFiles = fs.readdirSync(tmpWorkDir);
    const downloadedAudio = tmpFiles.find((f) => f.startsWith('audio.') && !f.endsWith('.jpg') && !f.endsWith('.webp') && !f.endsWith('.png'));
    if (!downloadedAudio) {
      throw new Error('Downloaded audio file not found after yt-dlp finished');
    }
    const downloadedAudioPath = path.join(tmpWorkDir, downloadedAudio);
    const thumbFile = tmpFiles.find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    let coverPath: string | null = thumbFile ? path.join(tmpWorkDir, thumbFile) : null;

    // Stage 2: Crop 1:1 square cover art with FFmpeg
    if (coverPath && cropCover) {
      updateJob(job.id, {status: 'processing', progress: 82, stage: 'Cropping 1:1 Cover'});
      const croppedCover = path.join(tmpWorkDir, 'cover_square.jpg');
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

    // Stage 3: Embed tags & cover art and write cleanly to NAS destination
    updateJob(job.id, {status: 'processing', progress: 90, stage: 'Embedding Tags'});

    let ffmpegEmbedded = false;
    try {
      const ffArgs: string[] = ['-y', '-i', downloadedAudioPath];
      if (coverPath && audioExt === 'm4a') {
        ffArgs.push(
          '-i',
          coverPath,
          '-map',
          '0:a',
          '-map',
          '1:v',
          '-c:a',
          'copy',
          '-c:v',
          'mjpeg',
          '-disposition:v:0',
          'attached_pic'
        );
      } else {
        ffArgs.push('-c', 'copy');
      }
      ffArgs.push(
        '-metadata',
        `title=${job.title}`,
        '-metadata',
        `artist=${job.artist}`,
        '-metadata',
        `album=${job.album}`,
        finalAudioPath
      );
      await execFileAsync(ffmpegPath, ffArgs, {timeout: 45000});
      ffmpegEmbedded = fs.existsSync(finalAudioPath);
    } catch {
      ffmpegEmbedded = false;
    }

    if (!ffmpegEmbedded) {
      fs.copyFileSync(downloadedAudioPath, finalAudioPath);
    }

    // Stage 4: Index into SQLite library
    const indexed = await indexSingleFile(finalAudioPath, musicDir);
    updateJob(job.id, {
      status: 'completed',
      progress: 100,
      stage: 'Indexed',
      track_id: indexed.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateJob(job.id, {
      status: 'error',
      stage: 'Failed',
      error_log: msg.slice(0, 2000),
    });
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
const ALLOWED_YT_MEDIA_HOST_SUFFIXES = [
  '.googlevideo.com',
  '.youtube.com',
  '.ytimg.com',
  '.googleusercontent.com',
];

export interface ResolvedYouTubeAudioStream {
  url: string;
  headers: Record<string, string>;
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
  {url: string; headers: Record<string, string>; expiresAt: number}
>();
const ytStreamInFlight = new Map<string, Promise<ResolvedYouTubeAudioStream>>();

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

export async function resolveYouTubeAudioStreamUrl(
  videoId: string,
  options: {forceRefresh?: boolean} = {}
): Promise<{url: string; headers: Record<string, string>; fromCache: boolean}> {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new Error('Invalid YouTube video ID');
  }

  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = ytStreamUrlCache.get(videoId);
    if (cached && cached.expiresAt > now) {
      return {url: cached.url, headers: {...cached.headers}, fromCache: true};
    }
    if (cached) {
      ytStreamUrlCache.delete(videoId);
    }

    const existingPromise = ytStreamInFlight.get(videoId);
    if (existingPromise) {
      const resolved = await existingPromise;
      return {url: resolved.url, headers: {...resolved.headers}, fromCache: false};
    }
  }

  const resolvePromise = (async (): Promise<ResolvedYouTubeAudioStream> => {
    const ytdlpPath = getYtdlpPath();
    const tempCookiePath = createTempCookiesCopy();
    try {
      const configuredPlayerClient = getSetting('ytdlp_player_client', '').trim();
      const hasCustomOverride =
        configuredPlayerClient.length > 0 && configuredPlayerClient !== 'web,mweb,android_vr';
      const rawStreamPlayerClient = hasCustomOverride ? configuredPlayerClient : 'tv,android_vr';
      const streamPlayerClient = /^[A-Za-z0-9_,+-]+$/.test(rawStreamPlayerClient)
        ? rawStreamPlayerClient
        : 'tv,android_vr';

      const args = [
        ...buildResilienceArgs(tempCookiePath, {
          includeSleep: false,
          includePlayerClient: false,
          forceIpv4: true,
        }),
        '--extractor-args',
        `youtube:player_client=${streamPlayerClient}`,
        '-f',
        'bestaudio[ext=m4a]/bestaudio',
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        '--',
        `https://www.youtube.com/watch?v=${videoId}`,
      ];

      const {stdout} = await execFileAsync(ytdlpPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const trimmed = stdout.trim();
      const jsonStart = trimmed.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('Could not parse YouTube stream metadata JSON');
      }
      const data = JSON.parse(trimmed.slice(jsonStart)) as {
        url?: unknown;
        http_headers?: unknown;
        requested_formats?: Array<{url?: unknown; http_headers?: unknown}>;
      };

      const primaryFormat =
        typeof data.url === 'string' && data.url.trim()
          ? data
          : Array.isArray(data.requested_formats) && data.requested_formats.length > 0
            ? data.requested_formats[0]
            : null;

      const directUrl =
        primaryFormat && typeof primaryFormat.url === 'string' ? primaryFormat.url.trim() : '';

      if (!directUrl || !isAllowedYouTubeMediaUrl(directUrl)) {
        throw new Error('Could not resolve a valid YouTube audio stream URL');
      }

      const headers = sanitizeStreamHeaders(primaryFormat?.http_headers ?? data.http_headers);

      const resolvedAt = Date.now();
      pruneExpiredYtStreamCache(resolvedAt);
      ytStreamUrlCache.set(videoId, {
        url: directUrl,
        headers,
        expiresAt: resolvedAt + YT_STREAM_CACHE_TTL_MS,
      });
      return {url: directUrl, headers};
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
    ytStreamInFlight.set(videoId, resolvePromise);
  }

  try {
    const resolved = await resolvePromise;
    return {url: resolved.url, headers: {...resolved.headers}, fromCache: false};
  } finally {
    if (ytStreamInFlight.get(videoId) === resolvePromise) {
      ytStreamInFlight.delete(videoId);
    }
  }
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
  const ytdlpPath = getYtdlpPath();
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
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

  const {stdout} = await execFileAsync(ytdlpPath, args, {
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


