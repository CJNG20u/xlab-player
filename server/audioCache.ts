import crypto from 'crypto';
import {EventEmitter} from 'events';
import type express from 'express';
import fs from 'fs';
import path from 'path';
import {AUDIO_CACHE_DIR} from './db.ts';
import {
  getCachedTrackVideoId,
  getCachedYouTubeAudioStream,
  inspectYouTubeStreamUrlParams,
  invalidateYouTubeAudioStreamCache,
  isAllowedYouTubeMediaUrl,
  isDirectProxyCircuitOpen,
  isValidYouTubeVideoId,
  isVideoDirectProxyNegative,
  isYouTubeStreamCached,
  markVideoDirectProxyNegative,
  promoteInFlightAdGateToPlayback,
  recordStrategy403Rejection,
  recordStrategyDirectSuccess,
  requestIpv4MediaStream,
  resolveTrackToVideoId,
  resolveYouTubeAudioStreamUrl,
  upstreamBackoffRemainingSec,
  type Ipv4MediaResponse,
  type PrefetchRequestItem,
  type ResolvedYouTubeAudioStream,
  type StreamResolvePriority,
} from './downloader.ts';

// ---------------------------------------------------------------------------
// Audio Disk Cache + Single-Flight Fill + 2-Resolve / 1-Download Prefetch Pool
// ---------------------------------------------------------------------------

const DEFAULT_AUDIO_CACHE_MB = 2048;
const MAX_AUDIO_CACHE_MB = 131072; // 128 GiB safety ceiling
const STALE_PART_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const FILL_UPSTREAM_TIMEOUT_MS = 15_000;
const FILL_IDLE_CHUNK_TIMEOUT_MS = 30_000;
const FILL_FIRST_BYTE_WAIT_MS = 55_000;
const STREAM_READ_CHUNK_BYTES = 64 * 1024;

const PREFETCH_RESOLVE_WORKERS = 2;
const PREFETCH_DOWNLOAD_WORKERS = 1;
const PREFETCH_QUEUE_MAX = 32;

export interface CachedAudioEntry {
  videoId: string;
  audioPath: string;
  metaPath: string;
  contentType: string;
  bytes: number;
  revision: string;
  strategy: string;
  client: string;
  formatId: string | null;
  createdAt: number;
}

interface AudioMetaFile {
  contentType: string;
  bytes: number;
  revision: string;
  strategy: string;
  client: string;
  formatId: string | null;
  createdAt: number;
}

interface ByteRange {
  start: number;
  end: number;
}

type ResolvedStreamWithCacheMeta = ResolvedYouTubeAudioStream & {
  fromCache?: boolean;
  cacheAgeMs?: number | null;
};

export function getAudioCacheLimitBytes(): number {
  const raw = process.env.AUDIO_CACHE_MB;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_AUDIO_CACHE_MB * 1024 * 1024;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  const clampedMb = Math.min(MAX_AUDIO_CACHE_MB, Math.floor(parsed));
  return clampedMb * 1024 * 1024;
}

export function isAudioCacheEnabled(): boolean {
  return getAudioCacheLimitBytes() > 0;
}

function resolveCachePaths(videoId: string): {
  audioPath: string;
  partPath: string;
  metaPath: string;
} | null {
  if (!isValidYouTubeVideoId(videoId)) return null;
  const baseDir = path.resolve(AUDIO_CACHE_DIR);
  const audioPath = path.resolve(baseDir, `${videoId}.audio`);
  const partPath = path.resolve(baseDir, `${videoId}.part`);
  const metaPath = path.resolve(baseDir, `${videoId}.meta.json`);
  const prefix = baseDir + path.sep;
  if (
    !audioPath.startsWith(prefix) ||
    !partPath.startsWith(prefix) ||
    !metaPath.startsWith(prefix)
  ) {
    return null;
  }
  return {audioPath, partPath, metaPath};
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

function atomicWriteJson(targetPath: string, payload: unknown): void {
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), {encoding: 'utf-8', mode: 0o600});
  fs.renameSync(tmpPath, targetPath);
}

function parseContentRangeTotal(contentRange: string | undefined): number | null {
  if (!contentRange) return null;
  const match = contentRange.match(/bytes\s+\d+-\d+\/(\d+)/i);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function parsePositiveIntHeader(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function headerFirst(raw: string | string[] | undefined): string {
  return Array.isArray(raw) ? raw[0] || '' : raw || '';
}

function parseSingleByteRange(rangeHeader: string, totalBytes: number): ByteRange | 'unsatisfiable' | null {
  const trimmed = rangeHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'unsatisfiable';

  if (!rawStart && rawEnd) {
    // Suffix range: bytes=-N
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, totalBytes - suffix);
    return {start, end: totalBytes - 1};
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0 || start >= totalBytes) {
    return 'unsatisfiable';
  }
  let end = rawEnd ? Number(rawEnd) : totalBytes - 1;
  if (!Number.isFinite(end) || end < start) {
    return 'unsatisfiable';
  }
  if (end >= totalBytes) {
    end = totalBytes - 1;
  }
  return {start, end};
}

/**
 * Pure lookup of a completed audio file on disk.
 * Intentionally does NOT touch mtime so lookups/prefetches never distort LRU order.
 */
export function getCachedAudio(videoId: string): CachedAudioEntry | null {
  if (!isAudioCacheEnabled()) return null;
  const paths = resolveCachePaths(videoId);
  if (!paths) return null;

  try {
    const stat = fs.statSync(paths.audioPath);
    if (!stat.isFile() || stat.size <= 0) return null;

    let meta: Partial<AudioMetaFile> = {};
    if (fs.existsSync(paths.metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(paths.metaPath, 'utf-8')) as Partial<AudioMetaFile>;
      } catch {
        meta = {};
      }
    }

    const bytes = stat.size;
    return {
      videoId,
      audioPath: paths.audioPath,
      metaPath: paths.metaPath,
      contentType:
        typeof meta.contentType === 'string' && meta.contentType.trim()
          ? meta.contentType.trim()
          : 'audio/mp4',
      bytes,
      revision:
        typeof meta.revision === 'string' && meta.revision.trim()
          ? meta.revision.trim()
          : `"${videoId}-${bytes}-${Math.floor(stat.mtimeMs)}"`,
      strategy: typeof meta.strategy === 'string' ? meta.strategy : 'disk',
      client: typeof meta.client === 'string' ? meta.client : 'disk',
      formatId: typeof meta.formatId === 'string' ? meta.formatId : null,
      createdAt:
        typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt)
          ? meta.createdAt
          : stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * Update mtime ONLY when a cached track is actually served to a listener (true LRU).
 */
export function markAudioServed(videoId: string): void {
  const paths = resolveCachePaths(videoId);
  if (!paths) return;
  const now = new Date();
  try {
    if (fs.existsSync(paths.audioPath)) {
      fs.utimesSync(paths.audioPath, now, now);
    }
    if (fs.existsSync(paths.metaPath)) {
      fs.utimesSync(paths.metaPath, now, now);
    }
  } catch {
    // non-fatal
  }
}

// Track active `.part` files currently being written so stale-part sweep never touches them
const activePartFiles = new Set<string>();
let enforcementScheduled = false;

/**
 * Sweep stale `.part` / `.tmp` files (> 1 hour old, not actively written) and evict
 * oldest-mtime `.audio` + `.meta.json` pairs until total cache size <= AUDIO_CACHE_MB.
 */
export function enforceAudioCacheLimit(): {
  totalBytes: number;
  evictedCount: number;
  stalePartsRemoved: number;
} {
  const limitBytes = getAudioCacheLimitBytes();
  const baseDir = path.resolve(AUDIO_CACHE_DIR);
  let totalBytes = 0;
  let evictedCount = 0;
  let stalePartsRemoved = 0;

  try {
    fs.mkdirSync(baseDir, {recursive: true});
    const entries = fs.readdirSync(baseDir);
    const now = Date.now();
    const audioFiles: Array<{
      videoId: string;
      audioPath: string;
      metaPath: string;
      size: number;
      mtimeMs: number;
    }> = [];

    for (const name of entries) {
      const fullPath = path.resolve(baseDir, name);
      if (!fullPath.startsWith(baseDir + path.sep)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      if (name.endsWith('.part') || name.endsWith('.tmp')) {
        if (!activePartFiles.has(fullPath) && now - stat.mtimeMs > STALE_PART_MAX_AGE_MS) {
          safeUnlink(fullPath);
          stalePartsRemoved += 1;
        }
        continue;
      }

      if (name.endsWith('.audio')) {
        const videoId = name.slice(0, -'.audio'.length);
        const metaPath = path.resolve(baseDir, `${videoId}.meta.json`);
        if (stat.size <= 0) {
          safeUnlink(fullPath);
          safeUnlink(metaPath);
          continue;
        }
        totalBytes += stat.size;
        audioFiles.push({
          videoId,
          audioPath: fullPath,
          metaPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }

    if (limitBytes > 0 && totalBytes > limitBytes) {
      audioFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const file of audioFiles) {
        if (totalBytes <= limitBytes) break;
        safeUnlink(file.audioPath);
        safeUnlink(file.metaPath);
        totalBytes = Math.max(0, totalBytes - file.size);
        evictedCount += 1;
      }
    }

    if (evictedCount > 0 || stalePartsRemoved > 0) {
      console.info(
        '[audio-cache]',
        JSON.stringify({
          event: 'cache_enforce',
          totalMb: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
          limitMb: Math.round(limitBytes / (1024 * 1024)),
          evictedCount,
          stalePartsRemoved,
        })
      );
    }
  } catch (err) {
    console.warn(
      '[audio-cache]',
      JSON.stringify({
        event: 'cache_enforce_error',
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }

  return {totalBytes, evictedCount, stalePartsRemoved};
}

function scheduleCacheEnforcement(): void {
  if (enforcementScheduled) return;
  enforcementScheduled = true;
  setTimeout(() => {
    enforcementScheduled = false;
    enforceAudioCacheLimit();
  }, 250).unref();
}

// ---------------------------------------------------------------------------
// Single-Flight Per-Track Fill + Priority Upstream Lane
// ---------------------------------------------------------------------------

interface FillState {
  videoId: string;
  priority: number; // 0 = interactive playback, 1 = background prefetch
  readers: number;
  partPath: string;
  audioPath: string;
  metaPath: string;
  contentType: string;
  totalBytes: number | null;
  downloadedBytes: number;
  revision: string;
  strategy: string;
  client: string;
  formatId: string | null;
  adGateWaitedMs: number;
  fromUrlCache: boolean;
  done: boolean;
  completedPath: string | null;
  error: Error | null;
  canceled: boolean;
  abortController: AbortController;
  emitter: EventEmitter;
  promise: Promise<CachedAudioEntry | null>;
}

const activeFills = new Map<string, FillState>();

// Priority upstream transfer lane: ensures one upstream transfer per active slot,
// and lets interactive playback (priority 0) preempt an unobserved prefetch (readers === 0).
interface LaneWaiter {
  priority: number;
  videoId: string;
  resolve: () => void;
}

let laneOwner: FillState | null = null;
const laneWaiters: LaneWaiter[] = [];

async function acquireUpstreamLane(fill: FillState): Promise<boolean> {
  if (fill.canceled) return false;
  if (!laneOwner) {
    laneOwner = fill;
    return true;
  }

  // Interactive playback preempts an unobserved background prefetch immediately
  if (fill.priority === 0 && laneOwner.priority > 0 && laneOwner.readers === 0 && laneOwner !== fill) {
    console.info(
      '[audio-cache]',
      JSON.stringify({
        event: 'prefetch_preempted',
        preemptedVideoId: laneOwner.videoId,
        byVideoId: fill.videoId,
      })
    );
    laneOwner.canceled = true;
    laneOwner.abortController.abort();
  }

  await new Promise<void>((resolve) => {
    const waiter: LaneWaiter = {priority: fill.priority, videoId: fill.videoId, resolve};
    laneWaiters.push(waiter);
    laneWaiters.sort((a, b) => a.priority - b.priority);
  });

  if (fill.canceled) {
    releaseUpstreamLane(fill);
    return false;
  }
  laneOwner = fill;
  return true;
}

function releaseUpstreamLane(fill: FillState): void {
  if (laneOwner === fill) {
    laneOwner = null;
    const next = laneWaiters.shift();
    if (next) {
      next.resolve();
    }
  }
}

function fillPriorityToResolvePriority(priority: number): StreamResolvePriority {
  return priority === 0 ? 'playback' : 'prefetch';
}

async function openFillUpstreamWithSingleRetry(
  videoId: string,
  initialResolved: ResolvedStreamWithCacheMeta,
  resolvePriority: StreamResolvePriority,
  signal: AbortSignal
): Promise<{upstream: Ipv4MediaResponse; resolved: ResolvedStreamWithCacheMeta}> {
  const openOnce = async (resolved: ResolvedStreamWithCacheMeta): Promise<Ipv4MediaResponse> => {
    const headers: Record<string, string> = {
      ...resolved.headers,
      Range: 'bytes=0-',
    };
    return requestIpv4MediaStream(resolved.url, {
      headers,
      timeoutMs: FILL_UPSTREAM_TIMEOUT_MS,
      signal,
    });
  };

  let resolved = initialResolved;
  let upstream = await openOnce(resolved);

  // On googlevideo 403/410, invalidate BOTH layers (memory + SQLite) and re-resolve ONCE
  // with the `default` client strategy (never android_vr), polling the new URL.
  if (upstream.statusCode === 403 || upstream.statusCode === 410) {
    const failedStatus = upstream.statusCode;
    const failedStrategy = resolved.strategy;
    const failedIpFamily = upstream.ipFamily;
    const failedServer = headerFirst(upstream.headers.server);
    const failedContentType = headerFirst(upstream.headers['content-type']);
    const failedUrlParams = inspectYouTubeStreamUrlParams(resolved.url);

    upstream.stream.resume();
    upstream.abort();
    invalidateYouTubeAudioStreamCache(videoId);

    if (failedStatus === 403) {
      console.warn(
        '[audio-cache]',
        JSON.stringify({
          event: 'fill_upstream_403',
          videoId,
          strategy: failedStrategy,
          fromCache: resolved.fromCache,
          cacheAgeMs: resolved.cacheAgeMs,
          status: failedStatus,
          ipFamily: failedIpFamily,
          serverHeader: failedServer,
          contentType: failedContentType,
          urlParams: failedUrlParams,
        })
      );
      recordStrategy403Rejection(
        failedStrategy,
        videoId,
        resolved.fromCache ? 'cache-fill-403-cached' : 'cache-fill-403-fresh'
      );
    }

    if (signal.aborted) {
      throw new Error('Cache fill aborted');
    }

    // Re-resolve ONCE with default strategy (not android_vr); ad-gate polling runs inside resolve
    resolved = await resolveYouTubeAudioStreamUrl(videoId, {
      forceRefresh: true,
      skipFastPath: true,
      defaultOnly: true,
      priority: resolvePriority,
    });
    if (signal.aborted) {
      throw new Error('Cache fill aborted');
    }
    upstream = await openOnce(resolved);
    if (upstream.statusCode === 403 || upstream.statusCode === 410) {
      const retryStatus = upstream.statusCode;
      upstream.stream.resume();
      upstream.abort();
      invalidateYouTubeAudioStreamCache(videoId);
      if (retryStatus === 403) {
        recordStrategy403Rejection(resolved.strategy, videoId, 'cache-fill-403-retry');
        markVideoDirectProxyNegative(videoId, `cache fill 403 retry (${resolved.strategy})`);
      }
      throw new Error(`Upstream returned HTTP ${retryStatus} on default re-resolve`);
    }
  }

  return {upstream, resolved};
}

function startOrAttachFill(
  videoId: string,
  options: {priority: number; preResolved?: ResolvedStreamWithCacheMeta | null}
): FillState | null {
  if (!isAudioCacheEnabled()) return null;
  const paths = resolveCachePaths(videoId);
  if (!paths) return null;

  const existing = activeFills.get(videoId);
  if (existing && !existing.done && !existing.canceled) {
    if (options.priority < existing.priority) {
      existing.priority = options.priority;
      if (options.priority === 0) {
        promoteInFlightAdGateToPlayback(videoId);
      }
    }
    return existing;
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const abortController = new AbortController();

  const fill: FillState = {
    videoId,
    priority: options.priority,
    readers: 0,
    partPath: paths.partPath,
    audioPath: paths.audioPath,
    metaPath: paths.metaPath,
    contentType: options.preResolved?.contentType || 'audio/mp4',
    totalBytes: options.preResolved?.contentLength ?? null,
    downloadedBytes: 0,
    revision: '',
    strategy: options.preResolved?.strategy || 'default',
    client: options.preResolved?.clientParam || 'unknown',
    formatId: options.preResolved?.formatId || null,
    adGateWaitedMs: options.preResolved?.adGateWaitedMs ?? 0,
    fromUrlCache: Boolean(options.preResolved?.fromCache),
    done: false,
    completedPath: null,
    error: null,
    canceled: false,
    abortController,
    emitter,
    promise: Promise.resolve(null),
  };

  activeFills.set(videoId, fill);

  fill.promise = (async (): Promise<CachedAudioEntry | null> => {
    let laneAcquired = false;
    let writeStream: fs.WriteStream | null = null;
    let upstream: Ipv4MediaResponse | null = null;
    const startedAt = Date.now();

    try {
      // Double-check if another fill just committed to disk
      const alreadyOnDisk = getCachedAudio(videoId);
      if (alreadyOnDisk) {
        fill.contentType = alreadyOnDisk.contentType;
        fill.totalBytes = alreadyOnDisk.bytes;
        fill.downloadedBytes = alreadyOnDisk.bytes;
        fill.revision = alreadyOnDisk.revision;
        fill.completedPath = alreadyOnDisk.audioPath;
        fill.done = true;
        fill.emitter.emit('done');
        return alreadyOnDisk;
      }

      const resolvedInitial =
        options.preResolved ||
        (await resolveYouTubeAudioStreamUrl(videoId, {
          skipFastPath: fill.priority > 0,
          priority: fillPriorityToResolvePriority(fill.priority),
        }));

      if (fill.canceled) {
        throw new Error('Cache fill canceled before upstream open');
      }

      fill.contentType = resolvedInitial.contentType || 'audio/mp4';
      fill.strategy = resolvedInitial.strategy;
      fill.client = resolvedInitial.clientParam || 'unknown';
      fill.formatId = resolvedInitial.formatId || null;
      fill.adGateWaitedMs = resolvedInitial.adGateWaitedMs ?? 0;
      fill.fromUrlCache = Boolean(resolvedInitial.fromCache);
      if (resolvedInitial.contentLength && resolvedInitial.contentLength > 0) {
        fill.totalBytes = resolvedInitial.contentLength;
      }

      laneAcquired = await acquireUpstreamLane(fill);
      if (!laneAcquired || fill.canceled) {
        throw new Error('Cache fill preempted');
      }

      // Check disk once more after waiting for upstream lane
      const diskAfterWait = getCachedAudio(videoId);
      if (diskAfterWait) {
        fill.contentType = diskAfterWait.contentType;
        fill.totalBytes = diskAfterWait.bytes;
        fill.downloadedBytes = diskAfterWait.bytes;
        fill.revision = diskAfterWait.revision;
        fill.completedPath = diskAfterWait.audioPath;
        fill.done = true;
        fill.emitter.emit('done');
        return diskAfterWait;
      }

      const opened = await openFillUpstreamWithSingleRetry(
        videoId,
        resolvedInitial,
        fillPriorityToResolvePriority(fill.priority),
        abortController.signal
      );
      upstream = opened.upstream;
      const finalResolved = opened.resolved;

      fill.strategy = finalResolved.strategy;
      fill.client = finalResolved.clientParam || 'unknown';
      fill.formatId = finalResolved.formatId || null;
      fill.adGateWaitedMs = finalResolved.adGateWaitedMs ?? 0;
      fill.fromUrlCache = Boolean(finalResolved.fromCache);

      if (upstream.finalUrl && !isAllowedYouTubeMediaUrl(upstream.finalUrl)) {
        throw new Error('Unexpected upstream media host');
      }

      if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
        throw new Error(`Upstream YouTube stream returned HTTP ${upstream.statusCode}`);
      }

      const respContentType = headerFirst(upstream.headers['content-type']);
      if (respContentType) {
        fill.contentType = respContentType;
      }

      const totalFromRange = parseContentRangeTotal(headerFirst(upstream.headers['content-range']));
      const totalFromLength = parsePositiveIntHeader(upstream.headers['content-length']);
      const expectedTotalBytes =
        totalFromRange ?? (upstream.statusCode === 200 ? totalFromLength : totalFromLength);
      if (expectedTotalBytes && expectedTotalBytes > 0) {
        fill.totalBytes = expectedTotalBytes;
      }

      fs.mkdirSync(path.dirname(fill.partPath), {recursive: true});
      safeUnlink(fill.partPath);
      activePartFiles.add(fill.partPath);

      writeStream = fs.createWriteStream(fill.partPath, {flags: 'w', mode: 0o600});
      const ws = writeStream;
      const upstreamStream = upstream.stream;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (settled) return;
            upstream?.abort();
            ws.destroy();
            finish(new Error('Upstream audio transfer stalled'));
          }, FILL_IDLE_CHUNK_TIMEOUT_MS);
          idleTimer.unref();
        };

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          abortController.signal.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve();
        };

        const onAbort = () => {
          upstream?.abort();
          ws.destroy();
          finish(new Error('Cache fill aborted'));
        };
        abortController.signal.addEventListener('abort', onAbort, {once: true});
        resetIdleTimer();

        ws.on('error', (err) => {
          upstream?.abort();
          finish(err);
        });

        upstreamStream.on('error', (err) => {
          ws.destroy();
          finish(err);
        });

        upstreamStream.on('data', (chunk: Buffer) => {
          if (settled || fill.canceled) return;
          resetIdleTimer();
          const ok = ws.write(chunk, (writeErr) => {
            if (writeErr) return;
            fill.downloadedBytes += chunk.length;
            fill.emitter.emit('progress');
          });
          if (!ok) {
            upstreamStream.pause();
            ws.once('drain', () => {
              if (!settled && !fill.canceled) {
                upstreamStream.resume();
              }
            });
          }
        });

        upstreamStream.once('end', () => {
          ws.end(() => {
            finish();
          });
        });

        upstreamStream.once('close', () => {
          if (!settled && !upstreamStream.readableEnded) {
            ws.destroy();
            finish(new Error('Upstream audio stream closed prematurely'));
          }
        });
      });

      writeStream = null;

      const partStat = fs.statSync(fill.partPath);
      const finalBytes = partStat.size;
      if (finalBytes <= 0) {
        throw new Error('Upstream audio transfer wrote 0 bytes');
      }
      if (expectedTotalBytes && finalBytes < expectedTotalBytes) {
        throw new Error(`Incomplete audio transfer (${finalBytes}/${expectedTotalBytes} bytes)`);
      }

      const revision = `"${videoId}-${finalBytes}-${Date.now()}"`;
      const meta: AudioMetaFile = {
        contentType: fill.contentType,
        bytes: finalBytes,
        revision,
        strategy: fill.strategy,
        client: fill.client,
        formatId: fill.formatId,
        createdAt: Date.now(),
      };

      // Atomic commit: write .meta.json via tmp+rename, then rename .part -> .audio
      atomicWriteJson(fill.metaPath, meta);
      fs.renameSync(fill.partPath, fill.audioPath);

      fill.totalBytes = finalBytes;
      fill.downloadedBytes = finalBytes;
      fill.revision = revision;
      fill.completedPath = fill.audioPath;
      fill.done = true;
      fill.emitter.emit('done');

      recordStrategyDirectSuccess(finalResolved.strategy, videoId);
      scheduleCacheEnforcement();

      console.info(
        '[audio-cache]',
        JSON.stringify({
          event: 'cache_fill_complete',
          videoId,
          priority: fill.priority === 0 ? 'playback' : 'prefetch',
          bytes: finalBytes,
          elapsedMs: Date.now() - startedAt,
          strategy: fill.strategy,
          client: fill.client,
          formatId: fill.formatId,
          fromUrlCache: fill.fromUrlCache,
          adGateWaitedMs: fill.adGateWaitedMs,
        })
      );

      return {
        videoId,
        audioPath: fill.audioPath,
        metaPath: fill.metaPath,
        contentType: fill.contentType,
        bytes: finalBytes,
        revision,
        strategy: fill.strategy,
        client: fill.client,
        formatId: fill.formatId,
        createdAt: meta.createdAt,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      fill.error = error;
      fill.done = true;
      if (writeStream) {
        try {
          writeStream.destroy();
        } catch {
          // ignore
        }
      }
      if (upstream) {
        try {
          upstream.abort();
        } catch {
          // ignore
        }
      }
      safeUnlink(fill.partPath);
      fill.emitter.emit('done');
      if (!fill.canceled) {
        console.warn(
          '[audio-cache]',
          JSON.stringify({
            event: 'cache_fill_failed',
            videoId,
            priority: fill.priority === 0 ? 'playback' : 'prefetch',
            elapsedMs: Date.now() - startedAt,
            error: error.message,
          })
        );
      }
      return null;
    } finally {
      activePartFiles.delete(fill.partPath);
      if (laneAcquired) {
        releaseUpstreamLane(fill);
      }
      if (activeFills.get(videoId) === fill) {
        activeFills.delete(videoId);
      }
    }
  })();

  return fill;
}

// ---------------------------------------------------------------------------
// HTTP Serving from Complete Disk File or Safely Growing `.part` File
// ---------------------------------------------------------------------------

function serveCompletedDiskFile(
  entry: CachedAudioEntry,
  req: express.Request,
  res: express.Response,
  isHead: boolean,
  sourceMode: 'disk-cache' | 'disk-fill-complete'
): void {
  markAudioServed(entry.videoId);

  const rawRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
  const parsedRange = rawRange ? parseSingleByteRange(rawRange, entry.bytes) : null;

  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Vary', 'Range');
  res.setHeader('ETag', entry.revision);
  res.setHeader('Cache-Control', 'private, max-age=1800');
  res.setHeader('X-Stream-Cache', 'disk');

  if (parsedRange === 'unsatisfiable') {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${entry.bytes}`);
    res.end();
    return;
  }

  const start = parsedRange ? parsedRange.start : 0;
  const end = parsedRange ? parsedRange.end : entry.bytes - 1;
  const chunkLen = end - start + 1;
  const statusCode = parsedRange ? 206 : 200;

  res.status(statusCode);
  if (parsedRange) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.bytes}`);
  }
  res.setHeader('Content-Length', String(chunkLen));

  if (isHead) {
    res.end();
    return;
  }

  console.info(
    '[yt-stream-served]',
    JSON.stringify({
      event: 'stream_served',
      videoId: entry.videoId,
      mode: sourceMode,
      strategy: entry.strategy,
      client: entry.client,
      formatId: entry.formatId,
      status: statusCode,
      bytes: chunkLen,
      totalBytes: entry.bytes,
      range: parsedRange ? `${start}-${end}` : 'full',
    })
  );

  const fileStream = fs.createReadStream(entry.audioPath, {start, end});
  const onClose = () => {
    fileStream.destroy();
  };
  fileStream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).end();
    } else if (!res.destroyed) {
      res.destroy();
    }
  });
  res.once('close', onClose);
  res.once('error', onClose);
  fileStream.pipe(res);
}

async function waitForFillReadable(
  fill: FillState,
  signal: AbortSignal,
  timeoutMs: number
): Promise<'complete' | 'progressive' | 'failed' | 'aborted'> {
  const isReady = (): 'complete' | 'progressive' | 'failed' | null => {
    if (fill.done) {
      return fill.completedPath ? 'complete' : 'failed';
    }
    if (fill.totalBytes !== null && fill.totalBytes > 0 && fill.downloadedBytes > 0) {
      return 'progressive';
    }
    return null;
  };

  const immediate = isReady();
  if (immediate) return immediate;
  if (signal.aborted) return 'aborted';

  return new Promise<'complete' | 'progressive' | 'failed' | 'aborted'>((resolve) => {
    let settled = false;
    const finish = (outcome: 'complete' | 'progressive' | 'failed' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fill.emitter.off('progress', check);
      fill.emitter.off('done', check);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const check = () => {
      const state = isReady();
      if (state) finish(state);
    };

    const onAbort = () => finish('aborted');

    const timer = setTimeout(() => {
      const state = isReady();
      finish(state || 'failed');
    }, timeoutMs);
    timer.unref();

    fill.emitter.on('progress', check);
    fill.emitter.on('done', check);
    signal.addEventListener('abort', onAbort, {once: true});
    check();
  });
}

async function waitForMoreBytes(fill: FillState, neededExclusiveOffset: number, signal: AbortSignal): Promise<void> {
  if (fill.downloadedBytes >= neededExclusiveOffset || fill.done || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      fill.emitter.off('progress', check);
      fill.emitter.off('done', check);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const check = () => {
      if (fill.downloadedBytes >= neededExclusiveOffset || fill.done) {
        finish();
      }
    };
    fill.emitter.on('progress', check);
    fill.emitter.on('done', check);
    signal.addEventListener('abort', finish, {once: true});
    check();
  });
}

async function writeChunkWithBackpressure(
  res: express.Response,
  chunk: Buffer,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted || res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  await new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
    signal.addEventListener('abort', done, {once: true});
  });
  return !signal.aborted && !res.destroyed && !res.writableEnded;
}

async function streamGrowingPartFile(
  fill: FillState,
  req: express.Request,
  res: express.Response,
  signal: AbortSignal
): Promise<void> {
  const totalBytes = fill.totalBytes!;
  const rawRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
  const parsedRange = rawRange ? parseSingleByteRange(rawRange, totalBytes) : null;

  res.setHeader('Content-Type', fill.contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Vary', 'Range');
  res.setHeader('Cache-Control', 'private, max-age=1800');
  res.setHeader('X-Stream-Cache', 'filling');

  if (parsedRange === 'unsatisfiable') {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalBytes}`);
    res.end();
    return;
  }

  const start = parsedRange ? parsedRange.start : 0;
  const end = parsedRange ? parsedRange.end : totalBytes - 1;
  const chunkLen = end - start + 1;
  const statusCode = parsedRange ? 206 : 200;

  res.status(statusCode);
  if (parsedRange) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalBytes}`);
  }
  res.setHeader('Content-Length', String(chunkLen));

  console.info(
    '[yt-stream-served]',
    JSON.stringify({
      event: 'stream_served',
      videoId: fill.videoId,
      mode: 'disk-filling',
      strategy: fill.strategy,
      client: fill.client,
      formatId: fill.formatId,
      fromUrlCache: fill.fromUrlCache,
      adGateWaitedMs: fill.adGateWaitedMs,
      status: statusCode,
      bytes: chunkLen,
      totalBytes,
      range: parsedRange ? `${start}-${end}` : 'full',
    })
  );

  const handleState: {fd: fs.promises.FileHandle | null; openedPath: string | null} = {
    fd: null,
    openedPath: null,
  };
  const buf = Buffer.allocUnsafe(STREAM_READ_CHUNK_BYTES);
  let cursor = start;

  const ensureOpenHandle = async (): Promise<fs.promises.FileHandle | null> => {
    const desiredPath = fill.completedPath || fill.partPath;
    if (handleState.fd && handleState.openedPath === desiredPath) {
      return handleState.fd;
    }
    if (handleState.fd) {
      try {
        await handleState.fd.close();
      } catch {
        // ignore
      }
      handleState.fd = null;
      handleState.openedPath = null;
    }
    try {
      handleState.fd = await fs.promises.open(desiredPath, 'r');
      handleState.openedPath = desiredPath;
      return handleState.fd;
    } catch {
      // If .part was just renamed to .audio, fall through to .audio
      if (desiredPath !== fill.audioPath && fs.existsSync(fill.audioPath)) {
        handleState.fd = await fs.promises.open(fill.audioPath, 'r');
        handleState.openedPath = fill.audioPath;
        return handleState.fd;
      }
      return null;
    }
  };

  try {
    while (cursor <= end && !signal.aborted && !res.destroyed && !res.writableEnded) {
      const availableEnd = fill.completedPath ? totalBytes : fill.downloadedBytes;
      if (cursor >= availableEnd) {
        if (fill.done) {
          if (fill.completedPath) {
            // Final flush from completed audio file
            const handle = await ensureOpenHandle();
            if (!handle) break;
            const remaining = end - cursor + 1;
            const toRead = Math.min(buf.length, remaining);
            const {bytesRead} = await handle.read(buf, 0, toRead, cursor);
            if (bytesRead <= 0) break;
            const ok = await writeChunkWithBackpressure(res, buf.subarray(0, bytesRead), signal);
            if (!ok) break;
            cursor += bytesRead;
            continue;
          }
          // Fill failed mid-stream
          break;
        }
        await waitForMoreBytes(fill, Math.min(cursor + 1, end + 1), signal);
        continue;
      }

      const handle = await ensureOpenHandle();
      if (!handle) {
        if (fill.done) break;
        await waitForMoreBytes(fill, cursor + 1, signal);
        continue;
      }

      const readableBytes = Math.min(buf.length, end - cursor + 1, availableEnd - cursor);
      if (readableBytes <= 0) {
        await waitForMoreBytes(fill, cursor + 1, signal);
        continue;
      }

      const {bytesRead} = await handle.read(buf, 0, readableBytes, cursor);
      if (bytesRead <= 0) {
        if (fill.done) break;
        await waitForMoreBytes(fill, cursor + 1, signal);
        continue;
      }

      const ok = await writeChunkWithBackpressure(res, buf.subarray(0, bytesRead), signal);
      if (!ok) break;
      cursor += bytesRead;
    }

    if (fill.completedPath) {
      markAudioServed(fill.videoId);
    }

    if (!res.writableEnded && !res.destroyed) {
      if (cursor > end) {
        res.end();
      } else {
        res.destroy();
      }
    }
  } finally {
    if (handleState.fd) {
      try {
        await handleState.fd.close();
      } catch {
        // ignore
      }
    }
  }
}

export type ServeDiskResult =
  | {outcome: 'served'}
  | {outcome: 'aborted'}
  | {outcome: 'fallback-pipe'; reason: string};

/**
 * Serve a track from completed disk cache, or start/join a single-flight `Range: bytes=0-`
 * disk fill and progressively serve exact `200`/`206` ranges without making extra upstream requests.
 */
export async function serveAudioFromDiskOrFill(
  videoId: string,
  req: express.Request,
  res: express.Response,
  isHead: boolean,
  abortSignal: AbortSignal
): Promise<ServeDiskResult> {
  // 1. Immediate disk hit (zero upstream traffic, true LRU touch)
  const cached = getCachedAudio(videoId);
  if (cached) {
    serveCompletedDiskFile(cached, req, res, isHead, 'disk-cache');
    return {outcome: 'served'};
  }

  if (!isAudioCacheEnabled()) {
    return {outcome: 'fallback-pipe', reason: 'audio disk cache disabled'};
  }

  if (isHead) {
    // For HEAD, never trigger a full file download; advertise metadata if a fill is already running
    const running = activeFills.get(videoId);
    if (running && running.totalBytes && running.totalBytes > 0) {
      res.status(200);
      res.setHeader('Content-Type', running.contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Vary', 'Range');
      res.setHeader('Cache-Control', 'private, max-age=1800');
      res.setHeader('Content-Length', String(running.totalBytes));
      res.setHeader('X-Stream-Cache', 'filling');
      res.end();
      return {outcome: 'served'};
    }
    return {outcome: 'fallback-pipe', reason: 'head cache miss'};
  }

  // 2. Start or join single-flight fill (priority 0 = interactive playback)
  const fill = startOrAttachFill(videoId, {priority: 0});
  if (!fill) {
    return {outcome: 'fallback-pipe', reason: 'invalid video id or disk cache disabled'};
  }

  fill.readers += 1;
  try {
    const readiness = await waitForFillReadable(fill, abortSignal, FILL_FIRST_BYTE_WAIT_MS);
    if (readiness === 'aborted' || abortSignal.aborted) {
      return {outcome: 'aborted'};
    }

    if (readiness === 'complete') {
      const completed = getCachedAudio(videoId);
      if (completed) {
        serveCompletedDiskFile(completed, req, res, false, 'disk-fill-complete');
        return {outcome: 'served'};
      }
      return {
        outcome: 'fallback-pipe',
        reason: fill.error?.message || 'disk cache file missing after fill',
      };
    }

    if (readiness === 'progressive' && fill.totalBytes && fill.totalBytes > 0) {
      await streamGrowingPartFile(fill, req, res, abortSignal);
      return {outcome: 'served'};
    }

    return {
      outcome: 'fallback-pipe',
      reason: fill.error?.message || 'cache fill did not produce streamable bytes in time',
    };
  } finally {
    fill.readers = Math.max(0, fill.readers - 1);
  }
}

// ---------------------------------------------------------------------------
// Background Prefetch Worker Pool: 2 Resolve Workers + 1 Download Worker
// ---------------------------------------------------------------------------

interface ResolveTask {
  videoId: string;
  download: boolean;
}

interface DownloadTask {
  videoId: string;
  resolved: ResolvedStreamWithCacheMeta;
}

const resolveQueue: ResolveTask[] = [];
const resolveQueuedIds = new Set<string>();
const resolveInFlightIds = new Set<string>();
let activeResolveWorkers = 0;

const downloadQueue: DownloadTask[] = [];
const downloadQueuedIds = new Set<string>();
const downloadInFlightIds = new Set<string>();
let activeDownloadWorkers = 0;

function enqueueDownloadTask(videoId: string, resolved: ResolvedStreamWithCacheMeta): boolean {
  if (!isAudioCacheEnabled()) return false;
  if (getCachedAudio(videoId)) return false;
  if (activeFills.has(videoId) || downloadQueuedIds.has(videoId) || downloadInFlightIds.has(videoId)) {
    return false;
  }
  if (downloadQueue.length >= PREFETCH_QUEUE_MAX) {
    return false;
  }
  downloadQueuedIds.add(videoId);
  downloadQueue.push({videoId, resolved});
  drainDownloadWorkers();
  return true;
}

function drainDownloadWorkers(): void {
  while (activeDownloadWorkers < PREFETCH_DOWNLOAD_WORKERS && downloadQueue.length > 0) {
    const task = downloadQueue.shift();
    if (!task) break;
    downloadQueuedIds.delete(task.videoId);

    if (
      !isAudioCacheEnabled() ||
      getCachedAudio(task.videoId) ||
      activeFills.has(task.videoId) ||
      isVideoDirectProxyNegative(task.videoId) ||
      isDirectProxyCircuitOpen() ||
      upstreamBackoffRemainingSec() > 0
    ) {
      continue;
    }

    activeDownloadWorkers += 1;
    downloadInFlightIds.add(task.videoId);

    void (async () => {
      try {
        const fill = startOrAttachFill(task.videoId, {
          priority: 1,
          preResolved: task.resolved,
        });
        if (fill) {
          await fill.promise;
        }
      } catch {
        // Prefetch download is strictly best-effort
      } finally {
        downloadInFlightIds.delete(task.videoId);
        activeDownloadWorkers -= 1;
        drainDownloadWorkers();
      }
    })();
  }
}

function drainResolveWorkers(): void {
  while (activeResolveWorkers < PREFETCH_RESOLVE_WORKERS && resolveQueue.length > 0) {
    const task = resolveQueue.shift();
    if (!task) break;
    resolveQueuedIds.delete(task.videoId);

    if (
      getCachedAudio(task.videoId) ||
      isVideoDirectProxyNegative(task.videoId) ||
      isDirectProxyCircuitOpen() ||
      upstreamBackoffRemainingSec() > 0
    ) {
      continue;
    }

    activeResolveWorkers += 1;
    resolveInFlightIds.add(task.videoId);

    void (async () => {
      try {
        // Prefetch NEVER uses the android_vr fast path (`skipFastPath: true`),
        // so the TV ad-gate polling window is cleared ahead of time and the verified URL
        // is saved in both memory + SQLite before the listener clicks Next.
        const cachedUrl = getCachedYouTubeAudioStream(task.videoId);
        const resolved =
          cachedUrl ||
          (await resolveYouTubeAudioStreamUrl(task.videoId, {
            skipFastPath: true,
            priority: 'prefetch',
          }));

        if (task.download && isAudioCacheEnabled() && !getCachedAudio(task.videoId)) {
          enqueueDownloadTask(task.videoId, resolved);
        }
      } catch {
        // Prefetch is strictly silent and best-effort
      } finally {
        resolveInFlightIds.delete(task.videoId);
        activeResolveWorkers -= 1;
        drainResolveWorkers();
      }
    })();
  }
}

export interface PrefetchEnqueueResult {
  queued: string[];
  skipped: string[];
  queueDepth: {
    resolve: number;
    download: number;
  };
}

/**
 * Non-blocking enqueue of up to 3 video IDs into the 2-resolve / 1-download worker pool.
 * Skips IDs that are invalid, already cached on disk, already queued/in-flight, or negative-cached.
 * Drops items when the bounded queue (max 32) is full.
 */
export function requestPrefetch(
  rawVideoIds: string[],
  options: {download?: boolean; maxItems?: number} = {}
): PrefetchEnqueueResult {
  const maxItems = Math.max(1, Math.min(10, options.maxItems ?? 3));
  const wantDownload = options.download !== false && isAudioCacheEnabled();
  const queued: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawVideoIds) {
    if (queued.length + skipped.length >= maxItems) break;
    const videoId = typeof raw === 'string' ? raw.trim() : '';
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);

    if (!isValidYouTubeVideoId(videoId)) {
      skipped.push(videoId);
      continue;
    }

    // Already on disk -> nothing to do
    if (getCachedAudio(videoId)) {
      skipped.push(videoId);
      continue;
    }

    // Already queued or actively running
    if (
      activeFills.has(videoId) ||
      resolveQueuedIds.has(videoId) ||
      resolveInFlightIds.has(videoId) ||
      downloadQueuedIds.has(videoId) ||
      downloadInFlightIds.has(videoId)
    ) {
      skipped.push(videoId);
      continue;
    }

    // Skip while negative-cached, circuit-open, or in upstream backoff
    if (
      isVideoDirectProxyNegative(videoId) ||
      isDirectProxyCircuitOpen() ||
      upstreamBackoffRemainingSec() > 0
    ) {
      skipped.push(videoId);
      continue;
    }

    // If URL is already warm and disk download is disabled, skip
    if (!wantDownload && isYouTubeStreamCached(videoId)) {
      skipped.push(videoId);
      continue;
    }

    // If URL is already warm and disk download IS wanted, go straight to download queue
    const cachedUrl = getCachedYouTubeAudioStream(videoId);
    if (cachedUrl && wantDownload) {
      if (enqueueDownloadTask(videoId, cachedUrl)) {
        queued.push(videoId);
      } else {
        skipped.push(videoId);
      }
      continue;
    }

    // Bounded queue: drop when full, never block
    if (resolveQueue.length >= PREFETCH_QUEUE_MAX) {
      skipped.push(videoId);
      continue;
    }

    resolveQueuedIds.add(videoId);
    resolveQueue.push({videoId, download: wantDownload});
    queued.push(videoId);
  }

  if (queued.length > 0) {
    drainResolveWorkers();
  }

  return {
    queued,
    skipped,
    queueDepth: {
      resolve: resolveQueue.length,
      download: downloadQueue.length,
    },
  };
}

/**
 * Metadata-aware prefetch wrapper for `/api/yt-stream/prefetch` (e.g. Discover / Catalog tracks
 * that may not yet have a YouTube `videoId`). Resolves metadata -> videoId in the background
 * and delegates directly into the unified 2-resolve / 1-download worker pool.
 */
const metadataMatchInFlight = new Set<string>();
const metadataMatchQueue: Array<{matchKey: string; artist: string; title: string; duration: number}> = [];
let metadataMatchWorkerActive = false;

function drainMetadataMatchQueue(): void {
  if (metadataMatchWorkerActive) return;
  metadataMatchWorkerActive = true;

  void (async () => {
    try {
      while (metadataMatchQueue.length > 0) {
        if (isDirectProxyCircuitOpen() || upstreamBackoffRemainingSec() > 0) {
          // Clear queued background matches while upstream is in cooldown/backoff
          while (metadataMatchQueue.length > 0) {
            const dropped = metadataMatchQueue.shift();
            if (dropped) metadataMatchInFlight.delete(dropped.matchKey);
          }
          break;
        }
        const task = metadataMatchQueue.shift();
        if (!task) break;
        try {
          const matched = await resolveTrackToVideoId({
            artist: task.artist,
            title: task.title,
            duration: task.duration,
            priority: 'prefetch',
          });
          if (isValidYouTubeVideoId(matched.videoId)) {
            requestPrefetch([matched.videoId], {download: true, maxItems: 1});
          }
        } catch {
          // Best-effort background metadata match
        } finally {
          metadataMatchInFlight.delete(task.matchKey);
        }
      }
    } finally {
      metadataMatchWorkerActive = false;
      if (metadataMatchQueue.length > 0 && !isDirectProxyCircuitOpen() && upstreamBackoffRemainingSec() === 0) {
        drainMetadataMatchQueue();
      }
    }
  })();
}

export function enqueueMetadataPrefetch(items: PrefetchRequestItem[]): number {
  if (isDirectProxyCircuitOpen() || upstreamBackoffRemainingSec() > 0) {
    return 0;
  }

  let accepted = 0;
  const directVideoIds: string[] = [];

  for (const raw of items.slice(0, 8)) {
    const vid = typeof raw.videoId === 'string' ? raw.videoId.trim() : '';
    const artist = typeof raw.artist === 'string' ? raw.artist.trim() : '';
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const duration = Number.isFinite(Number(raw.duration)) ? Math.max(0, Number(raw.duration)) : 0;

    if (isValidYouTubeVideoId(vid)) {
      directVideoIds.push(vid);
      continue;
    }
    if (!title) continue;

    const existingVid = getCachedTrackVideoId(artist, title);
    if (existingVid && isValidYouTubeVideoId(existingVid)) {
      directVideoIds.push(existingVid);
      continue;
    }

    const matchKey = `${artist.toLowerCase()}::${title.toLowerCase()}`;
    if (metadataMatchInFlight.has(matchKey) || metadataMatchInFlight.size >= PREFETCH_QUEUE_MAX) {
      continue;
    }
    metadataMatchInFlight.add(matchKey);
    metadataMatchQueue.push({matchKey, artist, title, duration});
    accepted += 1;
  }

  if (metadataMatchQueue.length > 0) {
    drainMetadataMatchQueue();
  }

  if (directVideoIds.length > 0) {
    const res = requestPrefetch(directVideoIds, {download: true, maxItems: 8});
    accepted += res.queued.length;
  }

  return accepted;
}
