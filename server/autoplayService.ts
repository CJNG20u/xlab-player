import {requestPrefetch} from './audioCache.ts';
import {
  AUTOPLAY_CONTEXT_MAX,
  AUTOPLAY_GRAPH_ANCHORS,
  buildDiscoveryPool,
  buildLocalPool,
  canonicalSongIdentity,
  cleanArtistName,
  planAutoplayQueue,
  scoreRelatedPool,
  type AutoplayCandidate,
  type AutoplayIntent,
  type DiscoveryTrackInput,
  type LibraryTrackInput,
  type RelatedAnchorInput,
} from './autoplay.ts';
import {getCatalogRelatedArtistsWithTopTracks} from './catalog.ts';
import {db} from './db.ts';
import {getListeningProfileForUser} from './listeningProfile.ts';
import {
  getCachedTrackVideoId,
  isValidYouTubeVideoId,
  resolveTrackToVideoId,
} from './downloader.ts';
import {getRelatedVideos} from './related.ts';

// ---------------------------------------------------------------------------
// Autoplay & Radio Orchestrator (15 s deadline + prefetch handoff)
// Adapted from Soundsible (MIT, (c) 2026 Arzuparreta) — shared/music_candidates.py
// ---------------------------------------------------------------------------

export const AUTOPLAY_OVERALL_DEADLINE_MS = 15_000;
const DISCOVERY_RESOLVE_MAX_TRACKS = 5;

export interface AutoplayContextTrackInput {
  videoId?: string;
  trackId?: number | string | null;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
}

export interface AutoplayPlanServiceInput {
  userId: number;
  seed: AutoplayContextTrackInput;
  context: AutoplayContextTrackInput[];
  exclude: string[];
  intent: AutoplayIntent;
  limit: number;
  entropy?: string | null;
}

export interface AutoplayPlanServiceResult {
  items: AutoplayCandidate[];
  poolCounts: {
    related: number;
    discovery: number;
    local: number;
  };
  degraded: boolean;
}

const getLibraryTrackByIdStmt = db.prepare(
  `SELECT id, rel_path, title, artist, album, track_number, year, duration,
          format, bitrate, size_bytes, cover_file, dominant_color, added_at
   FROM tracks
   WHERE id = ?`
);

const getAllLibraryTracksStmt = db.prepare(
  `SELECT id, rel_path, title, artist, album, track_number, year, duration,
          format, bitrate, size_bytes, cover_file, dominant_color, added_at
   FROM tracks`
);

const getLikedTrackIdsStmt = db.prepare(
  'SELECT track_id FROM liked_tracks WHERE user_id = ?'
);

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{timedOut: false; value: T} | {timedOut: true}> {
  const safeMs = Math.max(1, Math.floor(timeoutMs));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({timedOut: true});
    }, safeMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({timedOut: false, value});
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function enrichTrackInputFromDb(item: AutoplayContextTrackInput): AutoplayContextTrackInput {
  const numericTrackId =
    typeof item.trackId === 'number' && Number.isInteger(item.trackId) && item.trackId > 0
      ? item.trackId
      : typeof item.trackId === 'string' && /^\d+$/.test(item.trackId.trim())
        ? Number(item.trackId.trim())
        : null;

  let title = (item.title || '').trim();
  let artist = (item.artist || '').trim();
  let duration =
    typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0
      ? item.duration
      : 0;
  let videoId = (item.videoId || '').trim();

  if (numericTrackId !== null && (!title || !artist)) {
    const row = getLibraryTrackByIdStmt.get(numericTrackId) as LibraryTrackInput | undefined;
    if (row) {
      if (!title) title = row.title;
      if (!artist) artist = row.artist;
      if (!duration) duration = row.duration;
    }
  }

  if (!videoId && title) {
    const cachedVid = getCachedTrackVideoId(artist, title);
    if (cachedVid && isValidYouTubeVideoId(cachedVid)) {
      videoId = cachedVid;
    }
  }

  return {
    videoId: isValidYouTubeVideoId(videoId) ? videoId : undefined,
    trackId: numericTrackId ?? item.trackId ?? null,
    title,
    artist,
    album: (item.album || '').trim(),
    duration,
  };
}

/**
 * Normalize and deduplicate context tracks (oldest -> newest, capped at 5) with seed as newest.
 * Adapted from Soundsible (MIT, (c) 2026 Arzuparreta) — planner_context in music_candidates.py
 */
function buildEffectiveContext(
  seed: AutoplayContextTrackInput,
  rawContext: AutoplayContextTrackInput[]
): AutoplayContextTrackInput[] {
  const combined = [...rawContext.slice(-AUTOPLAY_CONTEXT_MAX), seed].map(enrichTrackInputFromDb);
  const deduped: AutoplayContextTrackInput[] = [];
  const seen = new Set<string>();

  for (const item of combined) {
    const identity =
      item.videoId ||
      (item.trackId !== null && item.trackId !== undefined && String(item.trackId).trim()
        ? `track:${String(item.trackId).trim()}`
        : canonicalSongIdentity(item.artist, item.title));
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(item);
  }

  return deduped.slice(-AUTOPLAY_CONTEXT_MAX);
}

export async function planAutoplayForUser(
  input: AutoplayPlanServiceInput
): Promise<AutoplayPlanServiceResult> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + AUTOPLAY_OVERALL_DEADLINE_MS;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());

  const context = buildEffectiveContext(input.seed, input.context);
  const newestItem = context[context.length - 1] ?? enrichTrackInputFromDb(input.seed);
  let degraded = false;

  // 1. If the newest/seed track has no videoId yet (e.g. local library song or Deezer track
  //    not yet in track_video_map), resolve its YouTube videoId first within a tight sub-budget
  //    so the RD Mix anchor graph can run.
  if (!newestItem.videoId && newestItem.title && remainingMs() > 1500) {
    try {
      const res = await withDeadline(
        resolveTrackToVideoId({
          artist: newestItem.artist || '',
          title: newestItem.title,
          duration: newestItem.duration,
        }),
        Math.min(5_000, remainingMs())
      );
      if (res.timedOut) {
        degraded = true;
      } else if (isValidYouTubeVideoId(res.value.videoId)) {
        newestItem.videoId = res.value.videoId;
      }
    } catch {
      degraded = true;
    }
  }

  // 2. Load local library + liked tracks once (fast in-process SQLite read)
  const libraryTracks = getAllLibraryTracksStmt.all() as LibraryTrackInput[];
  const likedRows = getLikedTrackIdsStmt.all(input.userId) as Array<{track_id: number}>;
  const likedTrackIds = new Set<number>(likedRows.map((r) => r.track_id));

  const ownedCanonicalIds = new Set<string>();
  const ownedVideoIds = new Set<string>();
  for (const t of libraryTracks) {
    const cid = canonicalSongIdentity(t.artist, t.title);
    if (cid) ownedCanonicalIds.add(cid);
    const cachedVid = getCachedTrackVideoId(t.artist, t.title);
    if (cachedVid && isValidYouTubeVideoId(cachedVid)) {
      t.videoId = cachedVid;
      ownedVideoIds.add(cachedVid);
    }
  }

  // 3. Kick off Related anchors (up to last 4 context tracks with videoId) and Deezer
  //    related-artist neighborhood in parallel under the 15s overall deadline.
  const anchorCandidates = context.slice(-AUTOPLAY_GRAPH_ANCHORS);
  const anchorEntries: Array<{videoId: string; title?: string; artist?: string}> = [];
  const seenAnchors = new Set<string>();
  for (const item of anchorCandidates) {
    if (!item.videoId || !isValidYouTubeVideoId(item.videoId) || seenAnchors.has(item.videoId)) {
      continue;
    }
    seenAnchors.add(item.videoId);
    anchorEntries.push({
      videoId: item.videoId,
      title: item.title,
      artist: item.artist,
    });
  }

  const seedArtistName = cleanArtistName(
    newestItem.artist ||
      context
        .slice()
        .reverse()
        .find((c) => Boolean(cleanArtistName(c.artist)))?.artist ||
      ''
  );

  // Track partial results as each anchor finishes so if the 15s deadline expires we return
  // whatever is already ready instead of throwing everything away.
  const relatedBySeed = new Map<string, Awaited<ReturnType<typeof getRelatedVideos>>>();
  let relatedSettledCount = 0;

  const relatedPromise = Promise.all(
    anchorEntries.map(async (anchor) => {
      try {
        const rows = await getRelatedVideos(anchor.videoId, 25, {
          seedTitle: anchor.title,
          seedArtist: anchor.artist,
        });
        relatedBySeed.set(anchor.videoId, rows);
        if (rows.length === 0) {
          degraded = true;
        }
      } catch {
        degraded = true;
      } finally {
        relatedSettledCount += 1;
      }
    })
  );

  let relatedArtistNames: string[] = [];
  const discoveryCandidatesRaw: DiscoveryTrackInput[] = [];

  const catalogAndDiscoveryPromise = (async () => {
    if (!seedArtistName) return;
    try {
      const neighborhood = await getCatalogRelatedArtistsWithTopTracks(seedArtistName, {
        trackTitleHint: newestItem.title,
        artistLimit: 6,
      });
      relatedArtistNames = neighborhood.relatedArtists.map((a) => a.name);

      // Filter out tracks already owned in local library before resolving to YouTube IDs
      const unownedTopTracks = neighborhood.topTracks.filter((t) => {
        const cid = canonicalSongIdentity(t.artist, t.title);
        if (cid && ownedCanonicalIds.has(cid)) return false;
        if (t.videoId && ownedVideoIds.has(t.videoId)) return false;
        return true;
      });

      let resolvedUncachedCount = 0;
      const toResolve: typeof unownedTopTracks = [];

      for (const track of unownedTopTracks) {
        if (track.videoId && isValidYouTubeVideoId(track.videoId)) {
          discoveryCandidatesRaw.push({
            videoId: track.videoId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            coverUrl: track.coverUrl,
            deezerTrackId: track.deezerTrackId,
            deezerAlbumId: track.albumId || undefined,
            deezerArtistId: track.artistId || undefined,
            score: 0.62,
          });
        } else if (resolvedUncachedCount < DISCOVERY_RESOLVE_MAX_TRACKS) {
          resolvedUncachedCount += 1;
          toResolve.push(track);
        }
      }

      // Resolve uncached Deezer top tracks in parallel while budget remains
      if (toResolve.length > 0 && remainingMs() > 1500) {
        await Promise.all(
          toResolve.map(async (track) => {
            if (remainingMs() <= 500) {
              degraded = true;
              return;
            }
            try {
              const matched = await resolveTrackToVideoId({
                artist: track.artist,
                title: track.title,
                duration: track.duration,
              });
              if (isValidYouTubeVideoId(matched.videoId) && !ownedVideoIds.has(matched.videoId)) {
                discoveryCandidatesRaw.push({
                  videoId: matched.videoId,
                  title: track.title,
                  artist: track.artist,
                  album: track.album,
                  duration: track.duration || matched.matchedDuration,
                  coverUrl: track.coverUrl,
                  deezerTrackId: track.deezerTrackId,
                  deezerAlbumId: track.albumId || undefined,
                  deezerArtistId: track.artistId || undefined,
                  score: 0.62,
                });
              }
            } catch {
              // Individual discovery resolution miss is non-fatal
            }
          })
        );
      }
    } catch {
      degraded = true;
    }
  })();

  // Wait for both related anchors and catalog/discovery within the 15s overall deadline.
  const budgetLeft = remainingMs();
  if (budgetLeft > 0) {
    const raced = await withDeadline(
      Promise.all([relatedPromise, catalogAndDiscoveryPromise]),
      budgetLeft
    );
    if (raced.timedOut) {
      degraded = true;
    }
  } else {
    degraded = true;
  }

  if (anchorEntries.length > 0 && relatedSettledCount < anchorEntries.length) {
    degraded = true;
  }

  // 4. Assemble and score the 3 pools via pure server/autoplay.ts functions
  const scoredAnchors: RelatedAnchorInput[] = anchorEntries.map((a) => ({
    seedVideoId: a.videoId,
    rows: relatedBySeed.get(a.videoId) || [],
  }));

  const relatedPool = scoreRelatedPool(scoredAnchors, {
    contextLength: context.length,
  });

  const contextArtists = context
    .map((c) => (c.artist || '').trim())
    .filter(Boolean);

  const localPool = buildLocalPool(libraryTracks, {
    contextArtists,
    relatedArtists: relatedArtistNames,
    likedTrackIds,
  });

  const discoveryPool = buildDiscoveryPool(discoveryCandidatesRaw, {
    ownedCanonicalIds,
    ownedVideoIds,
  });

  // Also exclude seed + context items automatically in addition to caller-supplied exclude list
  const combinedExclude = new Set<string>(input.exclude);
  for (const item of context) {
    if (item.videoId) {
      combinedExclude.add(item.videoId);
      combinedExclude.add(`yt-${item.videoId}`);
      combinedExclude.add(`music:youtube:${item.videoId}`);
    }
    if (item.trackId !== null && item.trackId !== undefined && String(item.trackId).trim()) {
      const tid = String(item.trackId).trim();
      combinedExclude.add(tid);
      combinedExclude.add(`music:track:${tid}`);
    }
    const cid = canonicalSongIdentity(item.artist, item.title);
    if (cid) combinedExclude.add(cid);
  }

  // 5. Run the pure queue planner (with gentle per-user listening profile signals)
  const listeningProfile = getListeningProfileForUser(input.userId);
  const items = planAutoplayQueue(
    {
      related: relatedPool,
      discovery: discoveryPool,
      local: localPool,
    },
    {
      intent: input.intent,
      limit: input.limit,
      exclude: combinedExclude,
      contextArtists,
      entropy: input.entropy ?? null,
      listeningProfile,
    }
  );

  // 6. Prefetch the first 2 returned online items with the existing prefetch queue
  const prefetchVideoIds: string[] = [];
  for (const item of items) {
    if (prefetchVideoIds.length >= 2) break;
    if (item.isYouTubeStream && item.videoId && isValidYouTubeVideoId(item.videoId)) {
      prefetchVideoIds.push(item.videoId);
    }
  }
  if (prefetchVideoIds.length > 0) {
    requestPrefetch(prefetchVideoIds, {download: true, maxItems: 2});
  }

  const poolCounts = {
    related: relatedPool.length,
    discovery: discoveryPool.length,
    local: localPool.length,
  };

  console.info(
    '[autoplay]',
    JSON.stringify({
      event: 'autoplay_plan',
      intent: input.intent,
      poolCounts,
      selected: items.length,
      degraded,
      ms: Date.now() - startedAt,
    })
  );

  return {
    items,
    poolCounts,
    degraded,
  };
}
