import 'dotenv/config';
import cookieParser from 'cookie-parser';
import dns from 'dns';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {type AuthRequest, requireAuth} from './server/auth.ts';
import {
  enforceAudioCacheLimit,
  enqueueMetadataPrefetch,
  getCachedAudio,
  isAudioCacheEnabled,
  requestPrefetch,
  serveAudioFromDiskOrFill,
} from './server/audioCache.ts';
import {
  cacheYouTubeThumbnailUrl,
  DirectProxyCircuitOpenError,
  getCachedYouTubeAudioStream,
  getCachedYouTubeThumbnailUrl,
  getDirectProxyCircuitCooldownRemainingMs,
  getPipeStartupTimeoutMs,
  getVideoDirectProxyNegativeInfo,
  inspectYouTubeStreamUrlParams,
  invalidateYouTubeAudioStreamCache,
  isAllowedYouTubeMediaUrl,
  isDirectProxyCircuitOpen,
  isValidYouTubeVideoId,
  isVideoDirectProxyNegative,
  markVideoDirectProxyNegative,
  recordStrategy403Rejection,
  recordStrategyDirectSuccess,
  requestIpv4MediaStream,
  resolveTrackToVideoId,
  resolveYouTubeAudioStreamUrl,
  spawnDirectYouTubeAudioStream,
  upstreamBackoffRemainingSec,
  type Ipv4MediaResponse,
  type PrefetchRequestItem,
} from './server/downloader.ts';
import {adminRouter} from './server/routes/adminRoutes.ts';
import {authRouter} from './server/routes/authRoutes.ts';
import {discoverRouter, downloadRouter} from './server/routes/downloadRoutes.ts';
import {libraryRouter} from './server/routes/libraryRoutes.ts';

dns.setDefaultResultOrder('ipv4first');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const PUBLIC_PWA_ASSETS: Record<
  string,
  {fileName: string; contentType: string; cacheControl: string}
> = {
  '/apple-touch-icon.png': {
    fileName: 'apple-touch-icon.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
  },
  '/apple-touch-icon-precomposed.png': {
    fileName: 'apple-touch-icon.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
  },
  '/icon-192.png': {
    fileName: 'icon-192.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
  },
  '/icon-512.png': {
    fileName: 'icon-512.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
  },
  '/icon-96.png': {
    fileName: 'icon-96.png',
    contentType: 'image/png',
    cacheControl: 'public, max-age=86400',
  },
  '/icon.svg': {
    fileName: 'icon.svg',
    contentType: 'image/svg+xml; charset=utf-8',
    cacheControl: 'public, max-age=86400',
  },
  '/manifest.webmanifest': {
    fileName: 'manifest.webmanifest',
    contentType: 'application/manifest+json; charset=utf-8',
    cacheControl: 'public, max-age=86400',
  },
  '/manifest.json': {
    fileName: 'manifest.webmanifest',
    contentType: 'application/manifest+json; charset=utf-8',
    cacheControl: 'public, max-age=86400',
  },
  '/sw.js': {
    fileName: 'sw.js',
    contentType: 'application/javascript; charset=utf-8',
    cacheControl: 'public, max-age=86400',
  },
};

function resolvePublicPwaAssetPath(fileName: string): string | null {
  const cwd = process.cwd();
  const candidates = IS_PROD
    ? [path.resolve(cwd, 'dist', fileName), path.resolve(cwd, 'public', fileName)]
    : [
        path.resolve(cwd, 'public', fileName),
        path.resolve(cwd, 'dev-dist', fileName),
        path.resolve(cwd, 'dist', fileName),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  // Sweep stale .part files (> 1h) and enforce AUDIO_CACHE_MB budget on boot
  enforceAudioCacheLimit();

  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json({limit: '10mb'}));
  app.use(express.urlencoded({extended: true}));

  // Public unauthenticated PWA assets (served before any auth middleware or SPA fallback)
  app.get(Object.keys(PUBLIC_PWA_ASSETS), (req, res, next) => {
    const asset = PUBLIC_PWA_ASSETS[req.path];
    if (!asset) {
      next();
      return;
    }
    const absPath = resolvePublicPwaAssetPath(asset.fileName);
    if (!absPath) {
      next();
      return;
    }
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Cache-Control', asset.cacheControl);
    res.sendFile(absPath);
  });

  // API routes
  app.use('/api/auth', authRouter);
  app.use('/api', libraryRouter);
  app.use('/api', discoverRouter);
  app.use('/api/download', downloadRouter);
  app.use('/api/admin', adminRouter);

  // Authenticated YouTube audio stream proxy with 30-min cache, in-flight deduplication,
  // adaptive 403 circuit breaker, strict timeouts, and full lifecycle cleanup.
  const UPSTREAM_FETCH_TIMEOUT_MS = 8_000;

  const streamYouTubeVideoById = async (
    videoId: string,
    req: AuthRequest,
    res: express.Response,
    isHead: boolean
  ): Promise<void> => {
    if (!isValidYouTubeVideoId(videoId)) {
      res.status(400).json({error: 'Invalid YouTube video ID'});
      return;
    }

    const abortController = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        abortController.abort();
      }
    };
    res.once('close', onClientClose);
    res.once('error', onClientClose);
    req.once('aborted', onClientClose);

    const detachClientListeners = () => {
      res.off('close', onClientClose);
      res.off('error', onClientClose);
      req.off('aborted', onClientClose);
    };

    const sendHeadHeaders = (opts: {
      contentType: string;
      acceptRanges: string;
      contentLength?: number | string | null;
      cacheControl: string;
    }) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.status(200);
      res.setHeader('Content-Type', opts.contentType);
      res.setHeader('Accept-Ranges', opts.acceptRanges);
      res.setHeader('Vary', 'Range');
      res.setHeader('Cache-Control', opts.cacheControl);
      if (opts.contentLength !== undefined && opts.contentLength !== null && opts.contentLength !== '') {
        res.setHeader('Content-Length', String(opts.contentLength));
      }
      res.end();
    };

    // Safe HEAD probe handling: serve immediately from disk cache, active fill, URL cache,
    // or circuit/backoff metadata without spawning duplicate subprocesses or fallback pipes.
    if (isHead) {
      try {
        if (isAudioCacheEnabled()) {
          const headDisk = await serveAudioFromDiskOrFill(
            videoId,
            req,
            res,
            true,
            abortController.signal
          );
          if (headDisk.outcome === 'served' || headDisk.outcome === 'aborted') {
            return;
          }
        }

        const cached = getCachedYouTubeAudioStream(videoId);
        if (cached) {
          sendHeadHeaders({
            contentType: cached.contentType || 'audio/mp4',
            acceptRanges: 'bytes',
            contentLength: cached.contentLength,
            cacheControl: 'private, max-age=1800',
          });
          return;
        }

        if (
          isVideoDirectProxyNegative(videoId) ||
          isDirectProxyCircuitOpen() ||
          upstreamBackoffRemainingSec() > 0
        ) {
          sendHeadHeaders({
            contentType: 'audio/mp4',
            acceptRanges: 'none',
            cacheControl: 'no-store',
          });
          return;
        }

        try {
          const resolved = await resolveYouTubeAudioStreamUrl(videoId);
          if (abortController.signal.aborted) return;
          sendHeadHeaders({
            contentType: resolved.contentType || 'audio/mp4',
            acceptRanges: 'bytes',
            contentLength: resolved.contentLength,
            cacheControl: 'private, max-age=1800',
          });
        } catch {
          if (abortController.signal.aborted) return;
          // Never spawn a fallback child process for a HEAD probe; advertise streamable audio
          // so the subsequent GET request immediately hands off to the fallback pipe if needed.
          sendHeadHeaders({
            contentType: 'audio/mp4',
            acceptRanges: 'none',
            cacheControl: 'no-store',
          });
        }
      } finally {
        detachClientListeners();
      }
      return;
    }

    const rawRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
    const safeRange = /^bytes=\d*-\d*(,\s*\d*-\d*)*$/i.test(rawRange) ? rawRange : '';

    const fetchUpstream = async (
      streamUrl: string,
      streamHeaders: Record<string, string>
    ): Promise<Ipv4MediaResponse> => {
      // Send only the selected format's own http_headers plus the client's Range header
      const headers: Record<string, string> = {...streamHeaders};
      if (safeRange) {
        headers.Range = safeRange;
      }

      return requestIpv4MediaStream(streamUrl, {
        headers,
        timeoutMs: UPSTREAM_FETCH_TIMEOUT_MS,
        signal: abortController.signal,
      });
    };

    const pipeDirectFallback = (fallbackReason: string): boolean => {
      if (res.headersSent || res.writableEnded || res.destroyed || abortController.signal.aborted) {
        return false;
      }
      const pipeStartupTimeoutMs = getPipeStartupTimeoutMs();
      const pipeStartedAt = Date.now();
      console.warn(
        `[yt-stream] ${videoId} using direct yt-dlp audio pipe fallback (${fallbackReason}; startupTimeoutMs=${pipeStartupTimeoutMs})`
      );

      let spawned: ReturnType<typeof spawnDirectYouTubeAudioStream>;
      try {
        spawned = spawnDirectYouTubeAudioStream(videoId);
      } catch (spawnErr) {
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        console.error(
          '[yt-stream]',
          JSON.stringify({
            event: 'direct_pipe_spawn_error',
            videoId,
            fallbackReason,
            error: msg,
          })
        );
        detachClientListeners();
        if (!res.headersSent && !res.destroyed) {
          res.status(502).json({error: 'Audio stream fallback failed to start'});
        } else if (!res.destroyed) {
          res.destroy();
        }
        return true;
      }

      const {stream, cleanup, getStderr} = spawned;
      let started = false;
      let finished = false;

      const teardown = () => {
        if (finished) return;
        finished = true;
        clearTimeout(startupTimer);
        res.off('close', onPipeAbort);
        res.off('error', onPipeAbort);
        req.off('aborted', onPipeAbort);
        detachClientListeners();
        cleanup();
      };

      const onPipeAbort = () => {
        teardown();
      };

      const startupTimer = setTimeout(() => {
        if (started || finished) return;
        const elapsedMs = Date.now() - pipeStartedAt;
        const stderr = getStderr();
        console.error(
          '[yt-stream]',
          JSON.stringify({
            event: 'direct_pipe_startup_timeout',
            videoId,
            timeoutMs: pipeStartupTimeoutMs,
            elapsedMs,
            fallbackReason,
            stderr: stderr ? stderr.slice(0, 400) : null,
          })
        );
        teardown();
        if (!res.headersSent && !res.destroyed) {
          res.status(502).json({error: 'Audio stream fallback timed out before starting'});
        } else if (!res.destroyed) {
          res.destroy();
        }
      }, pipeStartupTimeoutMs);
      startupTimer.unref();

      res.once('close', onPipeAbort);
      res.once('error', onPipeAbort);
      req.once('aborted', onPipeAbort);

      stream.on('data', (chunk: Buffer) => {
        if (finished || res.writableEnded || res.destroyed) {
          teardown();
          return;
        }
        if (!started) {
          started = true;
          clearTimeout(startupTimer);
          console.info(
            '[yt-stream-served]',
            JSON.stringify({
              event: 'stream_served',
              videoId,
              mode: 'pipe',
              strategy: 'pipe-fallback',
              client: 'yt-dlp-pipe(tv,android_vr,default)',
              startupMs: Date.now() - pipeStartedAt,
              fallbackReason,
            })
          );
          res.status(200);
          res.setHeader('Content-Type', 'audio/mp4');
          res.setHeader('Accept-Ranges', 'none');
          res.setHeader('Cache-Control', 'no-store');
        }
        if (!res.write(chunk)) {
          stream.pause();
          res.once('drain', () => {
            if (!finished && !res.destroyed && !res.writableEnded) {
              stream.resume();
            }
          });
        }
      });

      stream.on('end', () => {
        const wasStarted = started;
        const wasFinished = finished;
        const detail = getStderr() || fallbackReason;
        teardown();
        if (wasFinished) return;
        if (!wasStarted) {
          console.error(
            '[yt-stream]',
            JSON.stringify({
              event: 'direct_pipe_empty',
              videoId,
              elapsedMs: Date.now() - pipeStartedAt,
              fallbackReason,
              stderr: detail.slice(0, 400),
            })
          );
          if (!res.headersSent && !res.destroyed) {
            res.status(502).json({error: 'Audio stream fallback ended before starting'});
          }
          return;
        }
        if (!res.writableEnded) {
          res.end();
        }
      });

      stream.on('error', (pipeErr) => {
        const wasStarted = started;
        const wasFinished = finished;
        const stderr = getStderr();
        teardown();
        if (wasFinished) return;
        console.error(
          '[yt-stream]',
          JSON.stringify({
            event: 'direct_pipe_error',
            videoId,
            started: wasStarted,
            elapsedMs: Date.now() - pipeStartedAt,
            error: pipeErr.message,
            stderr: stderr ? stderr.slice(0, 400) : null,
          })
        );
        if (!res.headersSent && !res.destroyed) {
          res.status(502).json({error: 'Failed to stream YouTube audio'});
        } else if (!res.destroyed) {
          res.destroy();
        }
      });

      stream.once('close', () => {
        if (finished) return;
        const wasStarted = started;
        const detail = getStderr() || fallbackReason;
        teardown();
        if (!wasStarted) {
          console.error(
            '[yt-stream]',
            JSON.stringify({
              event: 'direct_pipe_closed_early',
              videoId,
              elapsedMs: Date.now() - pipeStartedAt,
              fallbackReason,
              stderr: detail.slice(0, 400),
            })
          );
          if (!res.headersSent && !res.destroyed) {
            res.status(502).json({error: 'Audio stream fallback closed before starting'});
          }
          return;
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      });

      return true;
    };

    try {
      // 1. Always serve completed disk-cached audio immediately (zero upstream traffic,
      // even if upstream backoff or negative cache is active).
      if (getCachedAudio(videoId)) {
        await serveAudioFromDiskOrFill(videoId, req, res, false, abortController.signal);
        detachClientListeners();
        return;
      }

      // 2. Fast per-video handoff: if this videoId recently 403d on direct proxy, skip yt-dlp JSON
      // resolution and stream directly through the pipe fallback.
      const videoNegInfo = getVideoDirectProxyNegativeInfo(videoId);
      if (videoNegInfo) {
        const remainingSec = Math.ceil(videoNegInfo.remainingMs / 1000);
        if (pipeDirectFallback(`per-video 403 negative cache (${remainingSec}s left)`)) {
          return;
        }
        detachClientListeners();
        return;
      }

      // 3. Short-circuit straight to the fallback pipe while every active strategy's circuit is open
      // or during a short post-exhaustion global upstream backoff pause.
      if (isDirectProxyCircuitOpen()) {
        const remainingSec = Math.ceil(getDirectProxyCircuitCooldownRemainingMs() / 1000);
        if (pipeDirectFallback(`403 circuit breaker open (${remainingSec}s cooldown left)`)) {
          return;
        }
        detachClientListeners();
        return;
      }

      const backoffRemaining = upstreamBackoffRemainingSec();
      if (backoffRemaining > 0) {
        if (pipeDirectFallback(`upstream backoff active (${backoffRemaining}s left)`)) {
          return;
        }
        detachClientListeners();
        return;
      }

      // 4. Primary disk-backed single-flight fill + progressive Range serving (when AUDIO_CACHE_MB > 0)
      if (isAudioCacheEnabled()) {
        const diskResult = await serveAudioFromDiskOrFill(
          videoId,
          req,
          res,
          false,
          abortController.signal
        );
        if (diskResult.outcome === 'served' || diskResult.outcome === 'aborted') {
          detachClientListeners();
          if (diskResult.outcome === 'aborted' && !res.writableEnded) {
            res.end();
          }
          return;
        }
        if (pipeDirectFallback(diskResult.reason)) {
          return;
        }
        detachClientListeners();
        return;
      }

      // 5. Direct proxy path when disk caching is explicitly disabled (AUDIO_CACHE_MB=0)
      let resolved: Awaited<ReturnType<typeof resolveYouTubeAudioStreamUrl>>;
      try {
        resolved = await resolveYouTubeAudioStreamUrl(videoId);
      } catch (resolveErr) {
        if (abortController.signal.aborted) {
          detachClientListeners();
          if (!res.writableEnded) res.end();
          return;
        }
        const reason =
          resolveErr instanceof DirectProxyCircuitOpenError
            ? resolveErr.message
            : resolveErr instanceof Error
              ? resolveErr.message
              : String(resolveErr);
        if (pipeDirectFallback(reason)) {
          return;
        }
        throw resolveErr;
      }

      let upstream: Ipv4MediaResponse;
      try {
        upstream = await fetchUpstream(resolved.url, resolved.headers);
      } catch (fetchErr) {
        if (abortController.signal.aborted) {
          detachClientListeners();
          if (!res.writableEnded) res.end();
          return;
        }
        const reason = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (pipeDirectFallback(`upstream connect failed: ${reason}`)) {
          return;
        }
        throw fetchErr;
      }

      const headerStr = (h: string | string[] | undefined): string =>
        Array.isArray(h) ? h[0] || '' : h || '';

      // On googlevideo 403/410, invalidate BOTH URL cache layers (memory + SQLite) and re-resolve
      // ONCE with the `default` strategy (never android_vr), polling the new URL.
      if (upstream.statusCode === 403 || upstream.statusCode === 410) {
        const failedStatus = upstream.statusCode;
        const failedStrategy = resolved.strategy;
        const failedUsedFormatHeaders = Boolean(resolved.usedFormatHeaders);
        const failedUrlParams = inspectYouTubeStreamUrlParams(resolved.url);
        const failedServer = headerStr(upstream.headers.server);
        const failedContentType = headerStr(upstream.headers['content-type']);
        const failedIpFamily = upstream.ipFamily;
        upstream.stream.resume();
        upstream.abort();
        invalidateYouTubeAudioStreamCache(videoId);

        if (failedStatus === 403) {
          console.warn(
            '[yt-stream-proxy]',
            JSON.stringify({
              event: 'proxy_403',
              videoId,
              strategy: failedStrategy,
              fromCache: resolved.fromCache,
              cacheAgeMs: resolved.cacheAgeMs,
              status: failedStatus,
              ipFamily: failedIpFamily,
              serverHeader: failedServer,
              contentType: failedContentType,
              usedFormatHeaders: failedUsedFormatHeaders,
              urlParams: failedUrlParams,
              sentHeaderKeys: Object.keys(resolved.headers),
            })
          );
          recordStrategy403Rejection(
            failedStrategy,
            videoId,
            resolved.fromCache ? 'proxy-403-cached' : 'proxy-403-fresh'
          );
        }

        if (isDirectProxyCircuitOpen()) {
          if (pipeDirectFallback(`all strategies in 403 cooldown after ${failedStrategy}`)) {
            return;
          }
          detachClientListeners();
          return;
        }

        try {
          resolved = await resolveYouTubeAudioStreamUrl(videoId, {
            forceRefresh: true,
            skipFastPath: true,
            defaultOnly: true,
          });
          upstream = await fetchUpstream(resolved.url, resolved.headers);
          if (upstream.statusCode === 403) {
            console.warn(
              '[yt-stream-proxy]',
              JSON.stringify({
                event: 'proxy_403_retry',
                videoId,
                strategy: resolved.strategy,
                status: upstream.statusCode,
                ipFamily: upstream.ipFamily,
                serverHeader: headerStr(upstream.headers.server),
                contentType: headerStr(upstream.headers['content-type']),
                usedFormatHeaders: Boolean(resolved.usedFormatHeaders),
                urlParams: inspectYouTubeStreamUrlParams(resolved.url),
              })
            );
            recordStrategy403Rejection(resolved.strategy, videoId, 'proxy-403-retry');
            markVideoDirectProxyNegative(videoId, `proxy 403 retry on ${resolved.strategy}`);
          }
        } catch (retryErr) {
          if (abortController.signal.aborted) {
            detachClientListeners();
            if (!res.writableEnded) res.end();
            return;
          }
          if (failedStatus === 403) {
            markVideoDirectProxyNegative(videoId, `proxy 403 on ${failedStrategy}`);
          }
          const reason = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (pipeDirectFallback(reason)) {
            return;
          }
          throw retryErr;
        }
      }

      // Re-verify final upstream host after any redirects
      if (upstream.finalUrl && !isAllowedYouTubeMediaUrl(upstream.finalUrl)) {
        upstream.stream.resume();
        upstream.abort();
        detachClientListeners();
        console.error('[yt-stream]', videoId, 'unexpected-upstream-host');
        res.status(502).json({error: 'Unexpected upstream media host'});
        return;
      }

      const isOkStatus = upstream.statusCode >= 200 && upstream.statusCode < 300;
      if (!isOkStatus && upstream.statusCode !== 206 && upstream.statusCode !== 416) {
        const failedStatus = upstream.statusCode;
        upstream.stream.resume();
        upstream.abort();
        if (failedStatus === 403) {
          markVideoDirectProxyNegative(videoId, `upstream proxy HTTP 403 (${resolved.strategy})`);
        }
        if (failedStatus !== 404 && pipeDirectFallback(`upstream HTTP ${failedStatus}`)) {
          return;
        }
        detachClientListeners();
        console.error('[yt-stream]', videoId, failedStatus);
        res.status(failedStatus === 404 ? 404 : 502).json({
          error: `Upstream YouTube stream returned HTTP ${failedStatus}`,
        });
        return;
      }

      if (upstream.statusCode === 200 || upstream.statusCode === 206) {
        recordStrategyDirectSuccess(resolved.strategy, videoId);
        console.info(
          '[yt-stream-served]',
          JSON.stringify({
            event: 'stream_served',
            videoId,
            mode: 'direct',
            strategy: resolved.strategy,
            client: resolved.clientParam || 'unknown',
            formatId: resolved.formatId || null,
            fromCache: resolved.fromCache,
            status: upstream.statusCode,
            adGateWaitedMs: resolved.adGateWaitedMs ?? 0,
          })
        );
      }

      const contentType =
        headerStr(upstream.headers['content-type']) || resolved.contentType || 'audio/mp4';
      const contentRange = headerStr(upstream.headers['content-range']);
      const contentLength = headerStr(upstream.headers['content-length']);
      const acceptRanges = headerStr(upstream.headers['accept-ranges']) || 'bytes';

      res.status(upstream.statusCode);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', acceptRanges);
      res.setHeader('Vary', 'Range');
      res.setHeader('Cache-Control', 'private, max-age=1800');
      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
      }
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      const nodeStream = upstream.stream;
      const destroyNodeStream = () => {
        detachClientListeners();
        upstream.abort();
      };

      nodeStream.on('error', () => {
        detachClientListeners();
        if (!res.headersSent) {
          res.status(502).end();
        } else if (!res.destroyed) {
          res.destroy();
        }
      });
      nodeStream.once('end', detachClientListeners);
      res.once('close', destroyNodeStream);
      res.once('error', destroyNodeStream);
      nodeStream.pipe(res);
    } catch (err) {
      detachClientListeners();
      if (abortController.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to stream YouTube audio';
      console.error('[yt-stream]', videoId, msg);
      if (!res.headersSent) {
        res.status(502).json({error: msg});
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };

  // Per-user sliding-window rate limiter for POST /api/prefetch (60 req/min)
  const PREFETCH_RATE_LIMIT_MAX = 60;
  const PREFETCH_RATE_LIMIT_WINDOW_MS = 60_000;
  const prefetchRateBuckets = new Map<string, number[]>();

  function checkPrefetchRateLimit(key: string): {allowed: boolean; retryAfterSec: number} {
    const now = Date.now();
    const cutoff = now - PREFETCH_RATE_LIMIT_WINDOW_MS;
    const prev = prefetchRateBuckets.get(key) || [];
    const active = prev.filter((ts) => ts > cutoff);
    if (active.length >= PREFETCH_RATE_LIMIT_MAX) {
      const oldest = active[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + PREFETCH_RATE_LIMIT_WINDOW_MS - now) / 1000));
      prefetchRateBuckets.set(key, active);
      return {allowed: false, retryAfterSec};
    }
    active.push(now);
    prefetchRateBuckets.set(key, active);
    if (prefetchRateBuckets.size > 1000) {
      for (const [bucketKey, timestamps] of prefetchRateBuckets.entries()) {
        if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
          prefetchRateBuckets.delete(bucketKey);
        }
      }
    }
    return {allowed: true, retryAfterSec: 0};
  }

  // Dedicated prefetch endpoint: accepts { videoIds: string[] } (max 3), rate-limited to 60/min.
  // Runs in background 2-resolve / 1-download workers without android_vr so ad gates clear ahead of play.
  // Adapted from Soundsible (MIT, (c) 2026 Arzuparreta) — shared/api/routes/playback.py
  app.post('/api/prefetch', requireAuth, (req: AuthRequest, res) => {
    const rateKey = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip || 'unknown'}`;
    const rate = checkPrefetchRateLimit(rateKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      res.status(429).json({error: 'Too many prefetch requests'});
      return;
    }

    const rawVideoIds = req.body?.videoIds;
    if (!Array.isArray(rawVideoIds)) {
      res.status(400).json({error: 'videoIds must be an array of YouTube video IDs'});
      return;
    }

    const validIds: string[] = [];
    for (const raw of rawVideoIds) {
      if (validIds.length >= 3) break;
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (isValidYouTubeVideoId(trimmed) && !validIds.includes(trimmed)) {
        validIds.push(trimmed);
      }
    }

    const download = req.body?.download !== false;
    const result = requestPrefetch(validIds, {download, maxItems: 3});
    res.status(202).json({ok: true, ...result});
  });

  // Non-blocking background stream prefetch endpoint (supports metadata items + videoIds)
  app.post('/api/yt-stream/prefetch', requireAuth, (req: AuthRequest, res) => {
    const rateKey = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip || 'unknown'}`;
    const rate = checkPrefetchRateLimit(rateKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      res.status(429).json({error: 'Too many prefetch requests'});
      return;
    }

    const rawItems = Array.isArray(req.body?.items)
      ? req.body.items
      : req.body && typeof req.body === 'object'
        ? [req.body]
        : [];
    const items: PrefetchRequestItem[] = [];
    for (const raw of rawItems.slice(0, 5)) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      items.push({
        videoId: typeof rec.videoId === 'string' ? rec.videoId.trim() : undefined,
        artist: typeof rec.artist === 'string' ? rec.artist.trim().slice(0, 120) : undefined,
        title: typeof rec.title === 'string' ? rec.title.trim().slice(0, 160) : undefined,
        duration:
          rec.duration !== undefined && Number.isFinite(Number(rec.duration))
            ? Math.max(0, Number(rec.duration))
            : undefined,
      });
    }
    const accepted = enqueueMetadataPrefetch(items);
    res.status(202).json({ok: true, accepted});
  });

  // Resolve structured track metadata (artist, title, duration) -> cached YouTube videoId
  app.post('/api/yt-stream/resolve', requireAuth, async (req: AuthRequest, res) => {
    const artist = typeof req.body?.artist === 'string' ? req.body.artist.trim().slice(0, 120) : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 160) : '';
    const duration = Number.isFinite(Number(req.body?.duration))
      ? Math.max(0, Number(req.body.duration))
      : 0;
    if (!title) {
      res.status(400).json({error: 'Track title is required'});
      return;
    }
    try {
      const matched = await resolveTrackToVideoId({artist, title, duration});
      res.json({
        ...matched,
        url: `https://www.youtube.com/watch?v=${matched.videoId}`,
        streamUrl: `/api/yt-stream/${encodeURIComponent(matched.videoId)}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to match audio stream';
      res.status(502).json({error: msg});
    }
  });

  // Stream directly by track metadata (artist, title, duration) so <audio src> stays synchronous on first click
  const handleYouTubeMatchStream = async (
    req: AuthRequest,
    res: express.Response,
    isHead: boolean
  ): Promise<void> => {
    const artist = String(req.query.artist || '').trim().slice(0, 120);
    const title = String(req.query.title || '').trim().slice(0, 160);
    const duration = Number.isFinite(Number(req.query.duration))
      ? Math.max(0, Number(req.query.duration))
      : 0;
    if (!title) {
      res.status(400).json({error: 'Track title query parameter is required'});
      return;
    }
    try {
      const matched = await resolveTrackToVideoId({artist, title, duration});
      res.setHeader('X-Resolved-Video-Id', matched.videoId);
      await streamYouTubeVideoById(matched.videoId, req, res, isHead);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to resolve matching audio stream';
      console.error('[yt-stream-match]', artist, '-', title, msg);
      if (!res.headersSent) {
        res.status(502).json({error: msg});
      }
    }
  };

  app.get('/api/yt-stream/match', requireAuth, (req: AuthRequest, res) => {
    void handleYouTubeMatchStream(req, res, false);
  });

  app.head('/api/yt-stream/match', requireAuth, (req: AuthRequest, res) => {
    void handleYouTubeMatchStream(req, res, true);
  });

  app.get('/api/yt-stream/:videoId', requireAuth, (req: AuthRequest, res) => {
    void streamYouTubeVideoById(String(req.params.videoId || '').trim(), req, res, false);
  });

  app.head('/api/yt-stream/:videoId', requireAuth, (req: AuthRequest, res) => {
    void streamYouTubeVideoById(String(req.params.videoId || '').trim(), req, res, true);
  });

  // Same-origin thumbnail proxy for CORS-safe dominant color extraction & crisp artwork on YouTube streams
  app.get('/api/yt-thumb/:videoId', requireAuth, async (req: AuthRequest, res) => {
    const videoId = String(req.params.videoId || '').trim();
    if (!isValidYouTubeVideoId(videoId)) {
      res.status(400).end();
      return;
    }

    // Prefer cached working artwork URL first, then high-res 16:9 YouTube CDN variants
    const cachedThumb = getCachedYouTubeThumbnailUrl(videoId);
    const candidateSet = new Set<string>();
    if (cachedThumb && isAllowedYouTubeMediaUrl(cachedThumb)) {
      candidateSet.add(cachedThumb);
    }
    candidateSet.add(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
    candidateSet.add(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
    candidateSet.add(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);

    try {
      for (const thumbUrl of candidateSet) {
        if (res.destroyed || res.writableEnded) return;
        let upstream: globalThis.Response;
        try {
          upstream = await fetch(thumbUrl, {
            headers: {Accept: 'image/*'},
            redirect: 'follow',
            signal: AbortSignal.timeout(4000),
          });
        } catch {
          continue;
        }
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel().catch(() => {});
          continue;
        }
        const finalThumbUrl = upstream.url || thumbUrl;
        if (!isAllowedYouTubeMediaUrl(finalThumbUrl)) {
          await upstream.body.cancel().catch(() => {});
          res.status(502).end();
          return;
        }
        cacheYouTubeThumbnailUrl(videoId, finalThumbUrl);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (!res.headersSent && !res.destroyed) {
          res.status(200).send(buf);
        }
        return;
      }
      if (!res.headersSent) res.status(404).end();
    } catch {
      if (!res.headersSent) res.status(502).end();
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ok: true, app: 'xlabplayer'});
  });

  if (!IS_PROD) {
    const disableHmr = process.env.DISABLE_HMR === 'true';

    // When HMR is disabled (e.g. AI Studio preview), Vite 8 still injects /@vite/client
    // which attempts to open a WebSocket to port 24678. Serve a clean WebSocket-free
    // shim implementing Vite's client exports (updateStyle, removeStyle, createHotContext, etc.).
    if (disableHmr) {
      app.get('/@vite/client', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(`
const sheetsMap = new Map();
export class ErrorOverlay extends HTMLElement {}
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== '.' && url[0] !== '/') return url;
  const pathname = url.replace(/[?#].*$/, '');
  const { search, hash } = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (search ? '&' + search.slice(1) : '') + (hash || '');
}
`);
      });
    }

    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: disableHmr ? false : {server: httpServer},
        hmr: disableHmr ? false : {server: httpServer},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      express.static(distDir, {
        maxAge: '1y',
        setHeaders(res, filePath) {
          if (
            filePath.endsWith('index.html') ||
            filePath.endsWith('sw.js') ||
            filePath.endsWith('manifest.webmanifest')
          ) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`xlabplayer server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start xlabplayer server:', err);
  process.exit(1);
});
