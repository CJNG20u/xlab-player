import 'dotenv/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {Readable} from 'stream';
import type {ReadableStream as NodeReadableStream} from 'stream/web';
import {type AuthRequest, requireAuth} from './server/auth.ts';
import {
  invalidateYouTubeAudioStreamCache,
  isAllowedYouTubeMediaUrl,
  isValidYouTubeVideoId,
  resolveYouTubeAudioStreamUrl,
} from './server/downloader.ts';
import {adminRouter} from './server/routes/adminRoutes.ts';
import {authRouter} from './server/routes/authRoutes.ts';
import {downloadRouter} from './server/routes/downloadRoutes.ts';
import {libraryRouter} from './server/routes/libraryRoutes.ts';

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
  app.use('/api/download', downloadRouter);
  app.use('/api/admin', adminRouter);

  // Authenticated YouTube audio stream proxy with 30-min URL cache and HTTP Range forwarding
  const handleYouTubeStream = async (
    req: AuthRequest,
    res: express.Response,
    isHead: boolean
  ): Promise<void> => {
    const videoId = String(req.params.videoId || '').trim();
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
    res.on('close', onClientClose);

    const rawRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
    const safeRange = /^bytes=\d*-\d*(,\s*\d*-\d*)*$/i.test(rawRange) ? rawRange : '';

    const fetchUpstream = async (streamUrl: string): Promise<globalThis.Response> => {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: '*/*',
      };
      if (safeRange) {
        headers.Range = safeRange;
      }
      return fetch(streamUrl, {
        method: isHead ? 'HEAD' : 'GET',
        headers,
        signal: abortController.signal,
        redirect: 'follow',
      });
    };

    try {
      let resolved = await resolveYouTubeAudioStreamUrl(videoId);
      let upstream = await fetchUpstream(resolved.url);

      // If a cached signed YouTube URL expired early, refresh once transparently
      if (resolved.fromCache && (upstream.status === 403 || upstream.status === 410)) {
        try {
          await upstream.body?.cancel();
        } catch {
          // ignore
        }
        invalidateYouTubeAudioStreamCache(videoId);
        resolved = await resolveYouTubeAudioStreamUrl(videoId, {forceRefresh: true});
        upstream = await fetchUpstream(resolved.url);
      }

      // Re-verify final upstream host after any redirects
      if (upstream.url && !isAllowedYouTubeMediaUrl(upstream.url)) {
        try {
          await upstream.body?.cancel();
        } catch {
          // ignore
        }
        res.status(502).json({error: 'Unexpected upstream media host'});
        return;
      }

      if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) {
        try {
          await upstream.body?.cancel();
        } catch {
          // ignore
        }
        res.status(upstream.status === 404 ? 404 : 502).json({
          error: `Upstream YouTube stream returned HTTP ${upstream.status}`,
        });
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'audio/mp4';
      const contentRange = upstream.headers.get('content-range');
      const contentLength = upstream.headers.get('content-length');
      const acceptRanges = upstream.headers.get('accept-ranges') || 'bytes';

      res.status(upstream.status);
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

      if (isHead || !upstream.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>);
      nodeStream.on('error', () => {
        if (!res.headersSent) {
          res.status(502).end();
        } else if (!res.destroyed) {
          res.destroy();
        }
      });
      res.on('close', () => {
        if (!nodeStream.destroyed) {
          nodeStream.destroy();
        }
      });
      nodeStream.pipe(res);
    } catch (err) {
      if (abortController.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to stream YouTube audio';
      if (!res.headersSent) {
        res.status(502).json({error: msg});
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };

  app.get('/api/yt-stream/:videoId', requireAuth, (req: AuthRequest, res) => {
    void handleYouTubeStream(req, res, false);
  });

  app.head('/api/yt-stream/:videoId', requireAuth, (req: AuthRequest, res) => {
    void handleYouTubeStream(req, res, true);
  });

  // Same-origin thumbnail proxy for CORS-safe dominant color extraction on YouTube streams
  app.get('/api/yt-thumb/:videoId', requireAuth, async (req: AuthRequest, res) => {
    const videoId = String(req.params.videoId || '').trim();
    if (!isValidYouTubeVideoId(videoId)) {
      res.status(400).end();
      return;
    }

    try {
      const thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      const upstream = await fetch(thumbUrl, {
        headers: {Accept: 'image/*'},
        redirect: 'follow',
      });
      if (!upstream.ok || !upstream.body) {
        res.status(404).end();
        return;
      }
      if (upstream.url && !isAllowedYouTubeMediaUrl(upstream.url)) {
        await upstream.body.cancel().catch(() => {});
        res.status(502).end();
        return;
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(200).send(buf);
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
